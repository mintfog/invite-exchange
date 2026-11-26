# 邀请码交换

分享多余的产品邀请码（Muse、ChatterFly、小豆……），用 LinuxDO 账号登录后每个产品领一个。码池里的码对所有人隐藏，只有领取人和分享者能看到；分享者能看到是谁用了、有没有点感谢。

- **产品由管理员添加**（`ADMIN_USERNAMES` 里的 LinuxDO 用户名），用户分享时只能选已有产品。
- **两种模式**：一次性码（如 ChatterFly，每个码只给一个人，每人可放几个）；多人可用码（如 Muse，每人一个码、最多 N 人用，显示剩余次数）。
- **随机轮流发**：领取时优先发给被领得最少的分享者，同样少的随机挑，每个分享者都能被用到。
- **LDC 奖励**：通过 LINUX DO Credit 从站长的商户账户给分享者发 LDC。贡献奖励（每个码首次被领）和领取奖励（每被领一次）可在管理页设置，单个产品可覆盖；领取后先过观察期，没人反馈无效才发；全站 24 小时有上限。
- **无效反馈**：领取人可以反馈码用不了，管理员确认后撤下码、取消奖励，反馈人可以再领一个。

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

领取是一条 D1 `INSERT … SELECT … RETURNING` 语句完成的，挑码、确认没领过、确认没超限、记一次领取在同一步里，码用满时由触发器标记，所以同时点也不会超发（`test/api.test.mjs` 里有 20 人抢 5 个码、20 人抢一个 5 次码的测试）。

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

# 可选：要发 LDC 奖励时，填 LINUX DO Credit 商户应用的 Client ID / Secret
npx wrangler secret put LDC_CLIENT_ID
npx wrangler secret put LDC_CLIENT_SECRET
```

没设 LDC 凭证时奖励功能不会发任何东西。设好后还要在网站「管理 → LDC 奖励」里点开启。定时任务每 10 分钟发一次到期的奖励，每笔用固定的订单号（`share-<码>` / `claim-<领取>`），重试不会重复到账。

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
| POST | `/api/codes` | 分享 `{product_key, codes(一行一个), note, uses?}` |
| DELETE | `/api/codes/:id` | 撤回自己还在池里的码（码内容会清空） |
| PATCH | `/api/codes/:id` | 多人码改剩余次数 `{remaining}` |
| POST | `/api/claim` | 领一个 `{product_key}` |
| POST | `/api/claims/:id/thanks` | 感谢分享者 |
| POST | `/api/claims/:id/report` | 反馈码无效 `{reason}` |
| GET | `/api/my/shared` | 我分享的（含用的人、剩余次数、LDC 奖励） |
| GET | `/api/my/claimed` | 我领到的 |
| * | `/api/admin/*` | 管理员：产品、所有码、用户、无效反馈、LDC 设置和发放记录 |
