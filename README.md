# 邀请码交换

分享多余的产品邀请码（Muse、ChatterFly、小豆……），用 LinuxDO 账号登录后每个产品领一个。码被领走立刻从广场消失，只有领取人和分享者能看到；分享者能看到是谁领走、有没有点感谢。

- 前端：React + Vite + shadcn/ui 官方组件（黑白灰 neutral 主题）
- 后端：Cloudflare Worker（Hono），和前端在同一个 Worker 里，`/api/*` 走接口，其他走静态页面
- 数据库：Cloudflare D1
- 登录：LinuxDO Connect OAuth2

## 规则（默认值，可在 `wrangler.jsonc` 的 `vars` 里改）

| 规则 | 默认 |
| --- | --- |
| 领码需要的 LinuxDO 信任等级 | 1 级（`MIN_TRUST_LEVEL`，0 = 不限制） |
| 每人每个产品 | 只能领 1 个 |
| 每人 24 小时最多领 | 5 个（`MAX_CLAIMS_PER_DAY`） |
| 每人 24 小时最多分享 | 30 个（`MAX_SHARES_PER_DAY`），一次最多 20 个 |
| 自己分享的码 | 自己领不到 |
| 被禁言或未激活的 LinuxDO 账号 | 不能登录 |

领取是一条 D1 `UPDATE … RETURNING` 语句完成的，挑码、确认没人领、确认没超限、标记领走在同一步里，所以两个人同时点也不会拿到同一个码（`test/api.test.mjs` 里有 20 人抢 5 个码的测试）。

## shadcn/ui 组件

`src/components/ui/` 里的组件全部由 shadcn 官方命令行安装，代码里只 import，不手写。
`npm run build` / `npm run dev` 会先跑 `scripts/ensure-ui.mjs`：缺哪个组件就执行 `npx shadcn add …` 装哪个（需要能访问 ui.shadcn.com）。
第一次装好后建议把 `src/components/ui/` 提交进仓库，之后构建就不用再联网。

## 部署到 Cloudflare

### 1. 在 LinuxDO 建 OAuth 应用

到 https://connect.linux.do 新建应用：

- 回调地址：`https://你的域名/api/auth/callback`
  （还没绑域名就先用 `https://invite-exchange.<你的子域>.workers.dev/api/auth/callback`，之后再改）
- 记下 Client ID 和 Client Secret

### 2. 建 D1 数据库

```bash
npm install
npx wrangler login
npx wrangler d1 create invite-exchange
```

把输出里的 `database_id` 填进 `wrangler.jsonc` 的 `REPLACE_WITH_YOUR_D1_DATABASE_ID`，然后建表：

```bash
npm run db:migrate:remote
```

### 3. 设置机密

```bash
npx wrangler secret put LINUXDO_CLIENT_ID
npx wrangler secret put LINUXDO_CLIENT_SECRET
```

### 4. 部署

**自动部署（已配好）**：推到 `main` 分支后，GitHub Actions（`.github/workflows/deploy.yml`）会依次跑类型检查、构建、接口测试，全部通过才迁移远端 D1 并 `wrangler deploy`。PR 只跑测试、不部署。也可以在仓库 Actions 页手动触发。

第一次用之前，要给仓库加一个密钥 `CLOUDFLARE_API_TOKEN`：

1. Cloudflare 控制台 → My Profile → API Tokens → Create Token，选模板 **Edit Cloudflare Workers**。
2. 在权限里再加一行 **Account → D1 → Edit**；Account Resources 只选你自己的账号，Zone Resources 选 `fshark.cloud`。
3. 生成后复制令牌，在 Mac 终端运行下面这条，按提示粘贴：

```bash
gh secret set CLOUDFLARE_API_TOKEN -R WilliamWang1721/invite-exchange
```

**手动部署**：`npm run deploy`（先构建再 `wrangler deploy`）。

### 5. 绑定自己的域名（国内访问建议做）

`*.workers.dev` 在国内经常打不开。在 Worker 的 Settings → Domains & Routes 加一个自定义域名，然后把 LinuxDO 应用里的回调地址改成这个域名。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填 LinuxDO 的 id/secret，或者只留 DEV_LOGIN=1
npm run db:migrate:local
npm run dev
```

`DEV_LOGIN=1` 时可以打开 `http://localhost:5173/api/auth/dev-login?u=alice` 直接以 alice 登录，方便测试。线上不要设这个变量。

## 接口测试

```bash
npm test   # 自动起本地 wrangler dev、跑 test/api.test.mjs，跑完关掉
```

覆盖：LinuxDO OAuth 全流程（用本地假服务）、分享去重、码对外隐藏、原子领取和并发、感谢、撤回、各项限额。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/login` | 跳转 LinuxDO 授权 |
| GET | `/api/auth/callback` | LinuxDO 回调 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/me` | 当前用户和限额 |
| GET | `/api/products` | 广场：每个产品可领数量、已送出数量 |
| POST | `/api/codes` | 分享 `{product, codes(一行一个), note}` |
| DELETE | `/api/codes/:id` | 撤回自己还在池里的码（码内容会清空） |
| POST | `/api/claim` | 领一个 `{product_key}` |
| POST | `/api/claims/:id/thanks` | 感谢分享者 |
| GET | `/api/my/shared` | 我分享的（含领取人、是否感谢） |
| GET | `/api/my/claimed` | 我领到的 |
