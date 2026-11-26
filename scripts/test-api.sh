#!/usr/bin/env bash
# 接口测试：起一个本地 wrangler dev（测试配置 + 独立数据目录），跑 test/api.test.mjs，结束后关掉。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8799}
DATA=.wrangler-test
rm -rf "$DATA"

npx wrangler d1 migrations apply invite-exchange --local -c test/wrangler.test.jsonc --persist-to "$DATA" >/dev/null

npx wrangler dev -c test/wrangler.test.jsonc --persist-to "$DATA" --port "$PORT" \
  --var LINUXDO_BASE:http://127.0.0.1:8800 >"$DATA/dev.log" 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/me"; then break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then cat "$DATA/dev.log"; exit 1; fi
  sleep 1
done

BASE="http://127.0.0.1:$PORT" node test/api.test.mjs
