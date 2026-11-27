import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

export interface Env {
  DB: D1Database
  LINUXDO_CLIENT_ID: string
  LINUXDO_CLIENT_SECRET: string
  LINUXDO_BASE?: string
  MIN_TRUST_LEVEL?: string
  MAX_CLAIMS_PER_DAY?: string
  MAX_SHARES_PER_DAY?: string
  /** 只在本地 .dev.vars 里设成 "1"：开放 /api/auth/dev-login，方便不连 LinuxDO 也能测试 */
  DEV_LOGIN?: string
  /** 管理员的 LinuxDO 用户名，逗号分隔，不分大小写 */
  ADMIN_USERNAMES?: string
  /** LINUX DO Credit 商户凭证（wrangler secret put），没设就不发 LDC */
  LDC_CLIENT_ID?: string
  LDC_CLIENT_SECRET?: string
  LDC_BASE?: string
  /** 测试账号的登录密码（wrangler secret put），不设就没有测试账号入口 */
  TEST_LOGIN_SECRET?: string
}

type User = {
  id: number
  linuxdo_id: number
  username: string
  name: string | null
  avatar_url: string | null
  trust_level: number
  is_admin: boolean
}

type AppEnv = { Bindings: Env; Variables: { user: User | null } }

const SESSION_COOKIE = 'sid'
const STATE_COOKIE = 'oauth_state'
const SESSION_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

const LIMITS = {
  productName: 40,
  code: 200,
  note: 200,
  codesPerPost: 20,
  description: 200,
  pattern: 200,
  maxUses: 1000,
  reason: 200,
  /** 每人同时最多几条待审核的产品申请 */
  pendingRequests: 3,
  adminNote: 200,
  /** 单笔奖励上限：10000 LDC（单位：分） */
  rewardCents: 1_000_000,
}

const app = new Hono<AppEnv>().basePath('/api')

// ---------- 小工具 ----------

const now = () => Date.now()
const num = (v: string | undefined, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function productKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

// 测试账号：只有一个普通用户，永远不是管理员。linuxdo_id 用负数，真实 LinuxDO 账号不会撞上。
// 用户名用中文，LinuxDO 不允许中文用户名。
const TEST_ACCOUNT = { id: -2, username: '测试用户' } as const

function isAdmin(env: Env, username: string, linuxdoId?: number) {
  // 负数 id 都是测试账号，一律不是管理员
  if (linuxdoId !== undefined && linuxdoId < 0) return false
  const list = (env.ADMIN_USERNAMES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.includes(username.toLowerCase())
}

function isSecure(c: Context<AppEnv>) {
  return new URL(c.req.url).protocol === 'https:'
}

function fail(c: Context<AppEnv>, status: 400 | 401 | 402 | 403 | 404 | 409 | 429, error: string, message: string) {
  return c.json({ error, message }, status)
}

// ---------- 设置 ----------

type Settings = {
  ldc_enabled: boolean
  share_reward_cents: number
  claim_reward_cents: number
  daily_cap_cents: number
  hold_hours: number
  relay_enabled: boolean
  relay_deposit_cents: number
  queue_premium_cents: number
}

const SETTING_DEFAULTS: Settings = {
  ldc_enabled: false,
  share_reward_cents: 0,
  claim_reward_cents: 0,
  daily_cap_cents: 0,
  hold_hours: 24,
  relay_enabled: false,
  relay_deposit_cents: 500,
  queue_premium_cents: 20000,
}

async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const m = new Map(results.map((r) => [r.key, r.value]))
  const int = (k: keyof Settings) => {
    const n = Number(m.get(k))
    return Number.isInteger(n) && n >= 0 ? n : (SETTING_DEFAULTS[k] as number)
  }
  return {
    ldc_enabled: m.get('ldc_enabled') === '1',
    share_reward_cents: int('share_reward_cents'),
    claim_reward_cents: int('claim_reward_cents'),
    daily_cap_cents: int('daily_cap_cents'),
    hold_hours: int('hold_hours'),
    relay_enabled: m.get('relay_enabled') === '1',
    relay_deposit_cents: int('relay_deposit_cents') || SETTING_DEFAULTS.relay_deposit_cents,
    queue_premium_cents: int('queue_premium_cents') || SETTING_DEFAULTS.queue_premium_cents,
  }
}

function ldcConfigured(env: Env) {
  return Boolean(env.LDC_CLIENT_ID && env.LDC_CLIENT_SECRET)
}

// ---------- 会话 ----------

app.use('*', async (c, next) => {
  c.set('user', null)
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
      .bind(await sha256(token), now())
      .first<Omit<User, 'is_admin'>>()
    if (row) c.set('user', { ...row, is_admin: isAdmin(c.env, row.username, row.linuxdo_id) })
  }
  await next()
})

// 写操作只接受同源请求（Cookie 是 SameSite=Lax，这里再加一道）
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin')
    if (!origin || origin !== new URL(c.req.url).origin) {
      return fail(c, 403, 'bad_origin', '请求来源不对')
    }
  }
  await next()
})

function requireUser(c: Context<AppEnv>) {
  return c.get('user')
}

async function createSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken()
  const t = now()
  await c.env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256(token), userId, t, t + SESSION_DAYS * DAY)
    .run()
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  })
}

async function upsertUser(
  db: D1Database,
  u: { id: number; username: string; name?: string | null; avatar_url?: string | null; trust_level: number },
) {
  const t = now()
  const row = await db
    .prepare(
      `INSERT INTO users (linuxdo_id, username, name, avatar_url, trust_level, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(linuxdo_id) DO UPDATE SET
         username = excluded.username, name = excluded.name, avatar_url = excluded.avatar_url,
         trust_level = excluded.trust_level, last_login_at = excluded.last_login_at
       RETURNING id`,
    )
    .bind(u.id, u.username, u.name ?? null, u.avatar_url ?? null, u.trust_level, t)
    .first<{ id: number }>()
  return row!.id
}

// ---------- LinuxDO OAuth ----------

function redirectUri(c: Context<AppEnv>) {
  return new URL('/api/auth/callback', c.req.url).toString()
}

app.get('/auth/login', (c) => {
  const state = randomToken(16)
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/api/auth',
    maxAge: 600,
  })
  const base = c.env.LINUXDO_BASE || 'https://connect.linux.do'
  const url = new URL('/oauth2/authorize', base)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', c.env.LINUXDO_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(c))
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

type LinuxDoUser = {
  id: number
  username: string
  name?: string | null
  avatar_template?: string | null
  avatar_url?: string | null
  trust_level?: number
  active?: boolean
  silenced?: boolean
}

function avatarFrom(u: LinuxDoUser) {
  if (u.avatar_url) return u.avatar_url
  if (u.avatar_template) {
    const p = u.avatar_template.replace('{size}', '96')
    return p.startsWith('http') ? p : `https://linux.do${p}`
  }
  return null
}

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const expected = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/api/auth' })
  if (!code || !state || !expected || state !== expected) {
    return c.redirect('/?login_error=state')
  }

  const base = c.env.LINUXDO_BASE || 'https://connect.linux.do'
  const tokenRes = await fetch(new URL('/oauth2/token', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: 'Basic ' + btoa(`${c.env.LINUXDO_CLIENT_ID}:${c.env.LINUXDO_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(c) }),
  })
  if (!tokenRes.ok) return c.redirect('/?login_error=token')
  const tok = (await tokenRes.json()) as { access_token?: string }
  if (!tok.access_token) return c.redirect('/?login_error=token')

  const userRes = await fetch(new URL('/api/user', base), {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' },
  })
  if (!userRes.ok) return c.redirect('/?login_error=user')
  const lu = (await userRes.json()) as LinuxDoUser
  if (!lu.id || !lu.username) return c.redirect('/?login_error=user')
  if (lu.active === false || lu.silenced === true) return c.redirect('/?login_error=blocked')

  const id = await upsertUser(c.env.DB, {
    id: lu.id,
    username: lu.username,
    name: lu.name,
    avatar_url: avatarFrom(lu),
    trust_level: lu.trust_level ?? 0,
  })
  await createSession(c, id)
  return c.redirect('/')
})

// 仅本地测试：.dev.vars 里 DEV_LOGIN=1 时可用，线上没有这个变量就是 404
app.get('/auth/dev-login', async (c) => {
  if (c.env.DEV_LOGIN !== '1') return c.notFound()
  const username = (c.req.query('u') || 'tester').slice(0, 20)
  const trust = num(c.req.query('tl'), 2)
  const fakeId = 900000 + [...username].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 99999, 7)
  const id = await upsertUser(c.env.DB, { id: fakeId, username, name: username, avatar_url: null, trust_level: trust })
  await createSession(c, id)
  return c.redirect(c.req.query('to') || '/')
})

// 测试账号登录：密码是 Worker 机密 TEST_LOGIN_SECRET，没设就是 404
app.post('/auth/test-login', async (c) => {
  const secret = c.env.TEST_LOGIN_SECRET
  if (!secret) return c.notFound()
  const body = await c.req.json<{ password?: string }>().catch(() => null)
  const given = typeof body?.password === 'string' ? body.password : ''
  // 比较哈希，不按字符逐个比较原文
  if ((await sha256(given)) !== (await sha256(secret))) {
    await new Promise((r) => setTimeout(r, 500))
    return fail(c, 403, 'bad_password', '测试账号密码不对')
  }
  const acct = TEST_ACCOUNT
  const id = await upsertUser(c.env.DB, {
    id: acct.id,
    username: acct.username,
    name: acct.username,
    avatar_url: null,
    trust_level: 2,
  })
  await createSession(c, id)
  return c.json({ ok: true })
})

app.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

app.get('/me', (c) => {
  const u = c.get('user')
  return c.json({
    user: u,
    test_login: Boolean(c.env.TEST_LOGIN_SECRET),
    limits: {
      minTrustLevel: num(c.env.MIN_TRUST_LEVEL, 1),
      maxClaimsPerDay: num(c.env.MAX_CLAIMS_PER_DAY, 5),
      maxSharesPerDay: num(c.env.MAX_SHARES_PER_DAY, 30),
    },
  })
})

// ---------- 产品 ----------

type Mode = 'single' | 'multi'

type ProductRow = {
  key: string
  name: string
  mode: Mode
  max_uses: number
  max_codes_per_user: number | null
  code_pattern: string | null
  description: string | null
  active: number
  share_reward_cents: number | null
  claim_reward_cents: number | null
  relay_required: number
  /** 这个产品自己的押金（分）；null = 用全站押金 */
  deposit_cents: number | null
  /** 这个产品的最低领取信任等级；null = 用全站的 MIN_TRUST_LEVEL */
  min_trust_level: number | null
  /** 分档押金 JSON：[{"level":3,"cents":0}]，信任等级达到 level 时押金改成 cents */
  deposit_tiers: string | null
}

type DepositTier = { level: number; cents: number }

// 分档押金：每档是「信任等级达到 level，押金改成 cents（0 = 免押金）」。返回 undefined 表示格式不对。
function parseTiers(v: unknown): DepositTier[] | undefined {
  if (v === null || v === undefined || v === '') return []
  let arr = v
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(arr) || arr.length > 5) return undefined
  const out: DepositTier[] = []
  for (const t of arr) {
    const level = intIn((t as DepositTier)?.level, 0, 4)
    const cents = intIn((t as DepositTier)?.cents, 0, LIMITS.rewardCents)
    if (level === null || cents === null || out.some((x) => x.level === level)) return undefined
    out.push({ level, cents })
  }
  return out.sort((a, b) => a.level - b.level)
}

type ProductRules = Pick<ProductRow, 'relay_required' | 'deposit_cents' | 'min_trust_level' | 'deposit_tiers'>

// 一个产品对某个信任等级的人的规则：最低等级、押金（null = 不用押金）
function rulesFor(p: ProductRules, s: Settings, env: Env, trustLevel: number | null) {
  const minTrust = p.min_trust_level ?? num(env.MIN_TRUST_LEVEL, 1)
  const tiers = parseTiers(p.deposit_tiers) ?? []
  if (!s.relay_enabled || !p.relay_required) return { minTrust, base: null, tiers, deposit: null }
  const base = p.deposit_cents ?? s.relay_deposit_cents
  let deposit = base
  if (trustLevel !== null) {
    for (const t of tiers) if (trustLevel >= t.level) deposit = t.cents
  }
  return { minTrust, base, tiers, deposit: deposit > 0 ? deposit : null }
}

async function productRules(env: Env, key: string, trustLevel: number) {
  const p = await env.DB.prepare(
    'SELECT relay_required, deposit_cents, min_trust_level, deposit_tiers FROM products WHERE key = ?',
  )
    .bind(key)
    .first<ProductRules>()
  const s = await getSettings(env.DB)
  if (!p) return { minTrust: num(env.MIN_TRUST_LEVEL, 1), base: null, tiers: [], deposit: null }
  return rulesFor(p, s, env, trustLevel)
}

function intIn(v: unknown, min: number, max: number) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null
}

function compilePattern(p: string | null) {
  if (!p) return null
  try {
    return new RegExp(`^(?:${p})$`)
  } catch {
    return undefined
  }
}

type ProductInput = {
  name?: unknown
  mode?: unknown
  max_uses?: unknown
  max_codes_per_user?: unknown
  code_pattern?: unknown
  description?: unknown
  active?: unknown
  share_reward_cents?: unknown
  claim_reward_cents?: unknown
  relay_required?: unknown
  deposit_cents?: unknown
  min_trust_level?: unknown
  deposit_tiers?: unknown
  /** 只在通过产品申请时用：给申请人的备注 */
  admin_note?: unknown
}

// 校验管理员填的产品设置。返回错误信息，或者规范化后的值。
function checkProduct(b: ProductInput):
  | { error: string; message: string }
  | { value: Omit<ProductRow, 'key' | 'active'> } {
  const name = typeof b.name === 'string' ? b.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > LIMITS.productName) {
    return { error: 'bad_name', message: `产品名需要 1 到 ${LIMITS.productName} 个字` }
  }
  const mode = b.mode === 'multi' ? 'multi' : b.mode === 'single' || b.mode === undefined ? 'single' : null
  if (!mode) return { error: 'bad_mode', message: '模式只能是一次性码或多人可用码' }

  let maxUses = 1
  let perUser: number | null = 1
  if (mode === 'multi') {
    const n = intIn(b.max_uses, 1, LIMITS.maxUses)
    if (n === null) return { error: 'bad_max_uses', message: `每个码可用次数需要 1 到 ${LIMITS.maxUses}` }
    maxUses = n
  } else if (b.max_codes_per_user === null || b.max_codes_per_user === undefined || b.max_codes_per_user === '') {
    perUser = null
  } else {
    const n = intIn(b.max_codes_per_user, 1, LIMITS.maxUses)
    if (n === null) return { error: 'bad_per_user', message: `每人最多几个码需要 1 到 ${LIMITS.maxUses}，或者留空表示不限` }
    perUser = n
  }

  const pattern = typeof b.code_pattern === 'string' && b.code_pattern.trim() ? b.code_pattern.trim() : null
  if (pattern && (pattern.length > LIMITS.pattern || compilePattern(pattern) === undefined)) {
    return { error: 'bad_pattern', message: '邀请码格式不是有效的正则表达式' }
  }
  const description =
    typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, LIMITS.description) : null

  // 奖励金额（分）：留空 = 跟随全站设置
  const reward = (v: unknown) =>
    v === null || v === undefined || v === '' ? null : intIn(v, 0, LIMITS.rewardCents) ?? undefined
  const share = reward(b.share_reward_cents)
  const claim = reward(b.claim_reward_cents)
  if (share === undefined || claim === undefined) {
    return { error: 'bad_reward', message: '奖励金额需要 0 到 10000 LDC，最多两位小数，或者留空跟随全站设置' }
  }
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  const deposit = empty(b.deposit_cents) ? null : intIn(b.deposit_cents, 1, LIMITS.rewardCents)
  if (deposit === null && !empty(b.deposit_cents)) {
    return { error: 'bad_deposit', message: '押金需要大于 0、最多两位小数，或者留空跟随全站押金' }
  }
  const minTrust = empty(b.min_trust_level) ? null : intIn(b.min_trust_level, 0, 4)
  if (minTrust === null && !empty(b.min_trust_level)) {
    return { error: 'bad_trust_level', message: '最低等级需要是 0 到 4，或者留空跟随全站设置' }
  }
  const tiers = parseTiers(b.deposit_tiers)
  if (!tiers) return { error: 'bad_tiers', message: '分档押金最多 5 档，每档等级 0 到 4 不能重复，押金不小于 0' }

  return {
    value: {
      name,
      mode,
      max_uses: maxUses,
      max_codes_per_user: perUser,
      code_pattern: pattern,
      description,
      share_reward_cents: share,
      claim_reward_cents: claim,
      relay_required: b.relay_required === true || b.relay_required === 1 || b.relay_required === '1' ? 1 : 0,
      deposit_cents: deposit,
      min_trust_level: minTrust,
      deposit_tiers: tiers.length ? JSON.stringify(tiers) : null,
    },
  }
}

// 每个码还剩几次：只算还在池子里的码
const REMAINING = `(c.max_uses - (SELECT COUNT(*) FROM claims x WHERE x.code_id = c.id))`

// ---------- 广场 ----------

app.get('/products', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT p.key, p.name, p.mode, p.max_uses, p.max_codes_per_user, p.description,
            p.share_reward_cents, p.claim_reward_cents, p.relay_required,
            p.deposit_cents AS own_deposit_cents, p.min_trust_level AS own_min_trust, p.deposit_tiers,
            (SELECT COUNT(*) FROM relay_deposits d
              WHERE d.product_key = p.key AND d.status = 'used' AND d.relay_code_id IS NULL) AS waiting_relays,
            EXISTS (SELECT 1 FROM relay_deposits d
                     WHERE d.user_id = ?1 AND d.product_key = p.key AND d.status = 'paid') AS has_deposit,
            (SELECT COUNT(*) FROM relay_deposits q
              WHERE q.product_key = p.key AND q.queued = 1 AND q.status = 'paid') AS queue_count,
            (SELECT 1 + (SELECT COUNT(*) FROM relay_deposits q
                          WHERE q.product_key = p.key AND q.queued = 1 AND q.status = 'paid'
                            AND (q.paid_at < m.paid_at OR (q.paid_at = m.paid_at AND q.id < m.id)))
               FROM relay_deposits m
              WHERE m.user_id = ?1 AND m.product_key = p.key AND m.queued = 1 AND m.status = 'paid'
              ORDER BY m.paid_at LIMIT 1) AS my_queue_pos,
            p.code_pattern IS NOT NULL AS has_pattern,
            (SELECT COUNT(*) FROM codes c WHERE c.product_key = p.key AND c.status = 'available') AS available_codes,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM claims x WHERE x.product_key = p.key) AS claimed,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available' AND c.sharer_id = ?1) AS mine_available,
            (SELECT COUNT(*) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn' AND c.sharer_id = ?1) AS mine_codes,
            EXISTS (SELECT 1 FROM claims x WHERE x.product_key = p.key AND x.user_id = ?1 AND x.void_at IS NULL) AS i_claimed,
            (SELECT MAX(c.created_at) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS last_shared_at
       FROM products p
      WHERE p.active = 1
      ORDER BY available > 0 DESC, last_shared_at DESC NULLS LAST, p.name
      LIMIT 200`,
  )
    .bind(user?.id ?? -1)
    .all<{
      share_reward_cents: number | null
      claim_reward_cents: number | null
      relay_required: number
      own_deposit_cents: number | null
      own_min_trust: number | null
      deposit_tiers: string | null
      available_codes: number
      waiting_relays: number
    }>()
  const settings = await getSettings(c.env.DB)
  const on = settings.ldc_enabled && ldcConfigured(c.env)
  const products = results.map(({ relay_required, own_deposit_cents, own_min_trust, deposit_tiers, ...p }) => {
    const r = rulesFor(
      { relay_required, deposit_cents: own_deposit_cents, min_trust_level: own_min_trust, deposit_tiers },
      settings,
      c.env,
      user?.trust_level ?? null,
    )
    const relay = r.base !== null
    return {
      ...p,
      // 接力链：池子里能领的码 + 已被领走、还没放回下一个码的。每条链同一时间只有一个码在流转。
      relay_chains: relay ? Number(p.available_codes) + Number(p.waiting_relays) : 0,
      // 排队押金 = 正常押金 + 排队加价
      queue_deposit_cents: relay ? (user ? (r.deposit ?? 0) : r.base!) + settings.queue_premium_cents : null,
      share_reward_cents: on ? (p.share_reward_cents ?? settings.share_reward_cents) : 0,
      claim_reward_cents: on ? (p.claim_reward_cents ?? settings.claim_reward_cents) : 0,
      min_trust_level: r.minTrust,
      // 接力产品：标准押金（分）和分档；不需要接力是 null / []
      deposit_base_cents: r.base,
      deposit_tiers: r.base === null ? [] : r.tiers,
      // 这个人领要付的押金：null = 不用付（不是接力产品，或等级够了免押金）
      deposit_cents: user ? r.deposit : r.base,
    }
  })
  const totals = await c.env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c JOIN products p ON p.key = c.product_key
              WHERE c.status = 'available' AND p.active = 1) AS available,
            (SELECT COUNT(*) FROM claims) AS claimed,
            (SELECT COUNT(DISTINCT sharer_id) FROM codes WHERE status <> 'withdrawn') AS sharers,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE status = 'sent') AS rewarded_cents`,
  ).first()
  return c.json({ products, totals })
})

// ---------- 接力链图 ----------

type ChainNode = { avatar: string | null; me: boolean }

// 接力产品正在运作的链：从最早分享的人开始，经过每个「领了码 → 放回自己的码」的人，
// 一直到现在：码在池子里等人领（pool），或在某人手里、TA 还没放回自己的码（waiting）。
// 只给头像（走本站匿名地址），不给名字。
app.get('/products/:key/chains', async (c) => {
  const user = c.get('user')
  const key = c.req.param('key')
  const db = c.env.DB
  const product = await db.prepare('SELECT name FROM products WHERE key = ? AND active = 1').bind(key).first()
  if (!product) return fail(c, 404, 'no_product', '这个产品不存在或已下架')
  const [{ results: codes }, { results: claims }, { results: deps }] = await Promise.all([
    db
      .prepare(
        `SELECT c.id, c.sharer_id, c.status, ${REMAINING} AS remaining, c.created_at
           FROM codes c WHERE c.product_key = ? ORDER BY c.created_at`,
      )
      .bind(key)
      .all<{ id: string; sharer_id: number; status: string; remaining: number; created_at: number }>(),
    db
      .prepare('SELECT id, code_id, user_id FROM claims WHERE product_key = ? AND void_at IS NULL ORDER BY claimed_at')
      .bind(key)
      .all<{ id: string; code_id: string; user_id: number }>(),
    db
      .prepare(
        "SELECT claim_id, relay_code_id, status FROM relay_deposits WHERE product_key = ? AND claim_id IS NOT NULL",
      )
      .bind(key)
      .all<{ claim_id: string; relay_code_id: string | null; status: string }>(),
  ])
  const codeById = new Map(codes.map((x) => [x.id, x]))
  const claimsByCode = new Map<string, typeof claims>()
  for (const x of claims) claimsByCode.set(x.code_id, [...(claimsByCode.get(x.code_id) ?? []), x])
  const depByClaim = new Map(deps.map((d) => [d.claim_id, d]))
  const relayed = new Set(deps.map((d) => d.relay_code_id).filter(Boolean))

  const paths: { users: number[]; state: 'pool' | 'waiting'; since: number }[] = []
  const seen = new Set<string>()
  const walk = (codeId: string, users: number[], since: number) => {
    const code = codeById.get(codeId)
    if (!code || seen.has(codeId) || paths.length >= 200) return
    seen.add(codeId)
    if (code.status === 'available' && code.remaining > 0) paths.push({ users, state: 'pool', since: code.created_at })
    for (const x of claimsByCode.get(codeId) ?? []) {
      const d = depByClaim.get(x.id)
      const next = [...users, x.user_id]
      if (d?.relay_code_id) walk(d.relay_code_id, next, since)
      else if (d?.status === 'used') paths.push({ users: next, state: 'waiting', since })
    }
  }
  for (const code of codes) {
    if (!relayed.has(code.id)) walk(code.id, [code.sharer_id], code.created_at)
  }

  // 头像只走本站匿名地址：第一次用到时给用户生成一个随机编号
  const ids = [...new Set(paths.flatMap((p) => p.users))]
  const avatars = new Map<number, string | null>()
  if (ids.length) {
    await db
      .prepare(
        "UPDATE users SET avatar_key = lower(hex(randomblob(12))) WHERE avatar_key IS NULL AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(ids))
      .run()
    const { results } = await db
      .prepare('SELECT id, avatar_key, avatar_url IS NOT NULL AS has FROM users WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ id: number; avatar_key: string; has: number }>()
    for (const r of results) avatars.set(r.id, r.has ? `/api/avatars/${r.avatar_key}` : null)
  }
  const MAX_NODES = 12
  const chains = paths.map((p) => {
    const shown = p.users.slice(-MAX_NODES)
    return {
      state: p.state,
      length: p.users.length,
      earlier: p.users.length - shown.length,
      nodes: shown.map((id): ChainNode => ({ avatar: avatars.get(id) ?? null, me: id === user?.id })),
    }
  })
  chains.sort((a, b) => b.length - a.length)
  return c.json({ chains, relays: deps.filter((d) => d.relay_code_id).length })
})

// 匿名头像：/api/avatars/{随机编号}，地址里不带 LinuxDO 用户名
app.get('/avatars/:key', async (c) => {
  const row = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE avatar_key = ?')
    .bind(c.req.param('key'))
    .first<{ avatar_url: string | null }>()
  if (!row?.avatar_url || !/^https:\/\//.test(row.avatar_url)) return c.body(null, 404)
  try {
    const r = await fetch(row.avatar_url, { cf: { cacheEverything: true, cacheTtl: 86400 } })
    const type = r.headers.get('content-type') ?? ''
    if (!r.ok || !type.startsWith('image/')) return c.body(null, 404)
    return new Response(r.body, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
    })
  } catch {
    return c.body(null, 404)
  }
})

// ---------- 分享 ----------

// ---------- 重复码校验 ----------

// 规范化后再比：去掉所有空白、全角转半角、转小写，「AB C1」和「abc1」算同一个码
function normalizeCode(code: string) {
  return code.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

async function codeHash(code: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeCode(code)))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 旧数据还没有指纹：补上（码已被撤回或作废的旧记录，原文已经清掉了，靠领取记录里的码来比）
async function backfillCodeHashes(env: Env, limit = 200) {
  const { results } = await env.DB.prepare(
    'SELECT id, code FROM codes WHERE code_hash IS NULL AND code IS NOT NULL LIMIT ?',
  )
    .bind(limit)
    .all<{ id: string; code: string }>()
  if (!results.length) return 0
  const stmts = []
  for (const r of results) {
    stmts.push(env.DB.prepare('UPDATE codes SET code_hash = ? WHERE id = ?').bind(await codeHash(r.code), r.id))
  }
  await env.DB.batch(stmts)
  return results.length
}

// 找出不能分享的码：
//   - 这个产品下被领过（包括领了又退还的）、或被确认无效的码
// 已经在池子里的同一个码（大小写、空格不同也算）算重复跳过。
// 分享过、没人领过、已撤回的码可以重新放回。
async function findBlockedCodes(db: D1Database, productKey: string, codes: string[], hashes: string[]) {
  const { results } = await db
    .prepare(
      `SELECT c.code_hash, c.sharer_id, c.status, c.invalid_at IS NOT NULL AS invalid,
              EXISTS (SELECT 1 FROM claims x WHERE x.code_id = c.id) AS claimed
         FROM codes c
        WHERE c.product_key = ?1 AND c.code_hash IN (SELECT value FROM json_each(?2))`,
    )
    .bind(productKey, JSON.stringify(hashes))
    .all<{ code_hash: string; sharer_id: number; status: string; invalid: number; claimed: number }>()
  const skip = new Set<string>()
  for (const r of results) {
    const code = codes[hashes.indexOf(r.code_hash)]
    if (r.claimed || r.invalid) {
      return { block: { reason: 'used_code', message: `「${code}」已经被领过或被确认用不了，不能再分享` }, skip }
    }
    if (r.status !== 'withdrawn') skip.add(r.code_hash) // 已经在池子里了（自己或别人放的），算重复跳过
  }
  // 旧记录：码原文清掉了但领取记录里还留着，也要比
  const norms = codes.map(normalizeCode)
  const { results: old } = await db
    .prepare(
      `SELECT x.code FROM claims x
        WHERE x.product_key = ?1 AND x.code IS NOT NULL
          AND lower(replace(replace(replace(replace(x.code, ' ', ''), char(9), ''), char(10), ''), char(13), ''))
              IN (SELECT value FROM json_each(?2))`,
    )
    .bind(productKey, JSON.stringify(norms))
    .all<{ code: string }>()
  if (old.length) {
    const i = norms.indexOf(normalizeCode(old[0].code))
    return { block: { reason: 'used_code', message: `「${codes[i >= 0 ? i : 0]}」已经被领过，不能再分享` }, skip }
  }
  return { block: null, skip }
}

app.post('/codes', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req
    .json<{ product_key?: string; codes?: string; note?: string; uses?: unknown }>()
    .catch(() => null)
  const product = await c.env.DB.prepare('SELECT * FROM products WHERE key = ? AND active = 1')
    .bind(body?.product_key ?? '')
    .first<ProductRow>()
  if (!product) return fail(c, 404, 'no_product', '请选择一个广场上已有的产品')

  const note = (body?.note ?? '').trim().slice(0, LIMITS.note) || null
  const codes = [
    ...new Set(
      (body?.codes ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  if (codes.length === 0) return fail(c, 400, 'no_codes', '至少填一个邀请码')
  if (codes.length > LIMITS.codesPerPost) {
    return fail(c, 400, 'too_many', `一次最多 ${LIMITS.codesPerPost} 个`)
  }
  if (codes.some((x) => x.length > LIMITS.code)) {
    return fail(c, 400, 'code_too_long', `单个邀请码不超过 ${LIMITS.code} 个字符`)
  }
  const re = compilePattern(product.code_pattern)
  if (re) {
    const bad = codes.filter((x) => !re.test(x))
    if (bad.length) {
      return fail(c, 400, 'bad_format', `有 ${bad.length} 个码不像 ${product.name} 的邀请码，比如「${bad[0]}」`)
    }
  }

  const mine = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM codes WHERE sharer_id = ? AND product_key = ? AND status <> 'withdrawn'",
  )
    .bind(user.id, product.key)
    .first<{ n: number }>()
  const have = mine?.n ?? 0

  let uses = 1
  if (product.mode === 'multi') {
    if (codes.length > 1) return fail(c, 400, 'one_code', `${product.name} 每人只有一个邀请码，一次只能放一个`)
    if (have > 0) {
      return fail(c, 409, 'has_code', `你已经分享过 ${product.name} 的码了，可以在「我的」里改剩余次数`)
    }
    const n = body?.uses === undefined || body?.uses === '' ? product.max_uses : intIn(body.uses, 1, product.max_uses)
    if (n === null) return fail(c, 400, 'bad_uses', `剩余可用次数需要 1 到 ${product.max_uses}`)
    uses = n
  } else if (product.max_codes_per_user !== null && have + codes.length > product.max_codes_per_user) {
    const left = Math.max(0, product.max_codes_per_user - have)
    return fail(
      c,
      409,
      'code_limit',
      `${product.name} 每人最多分享 ${product.max_codes_per_user} 个码，你还能放 ${left} 个`,
    )
  }

  const t = now()
  const maxShares = num(c.env.MAX_SHARES_PER_DAY, 30)
  const recent = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM codes WHERE sharer_id = ? AND created_at > ?',
  )
    .bind(user.id, t - DAY)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) + codes.length > maxShares) {
    return fail(c, 429, 'share_limit', `24 小时内最多分享 ${maxShares} 个码`)
  }

  // 重复码校验：领过的、被确认无效的、别人正在分享的码都不能再放进来（大小写、空格不同也算同一个）
  await backfillCodeHashes(c.env)
  const hashes = await Promise.all(codes.map((x) => codeHash(x)))
  for (let i = 0; i < codes.length; i++) {
    const j = hashes.indexOf(hashes[i])
    if (j !== i) return fail(c, 400, 'duplicate_in_batch', `「${codes[j]}」和「${codes[i]}」是同一个码`)
  }
  const check = await findBlockedCodes(c.env.DB, product.key, codes, hashes)
  if (check.block) return fail(c, 409, check.block.reason, check.block.message)

  const ids = codes.map(() => crypto.randomUUID())
  const fresh = codes.map((_, i) => i).filter((i) => !check.skip.has(hashes[i]))
  const res = !fresh.length ? [] : await c.env.DB.batch(
    fresh.map((i) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO codes (id, sharer_id, product_key, code, note, status, created_at, max_uses, code_hash)
         VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
      ).bind(ids[i], user.id, product.key, codes[i], note, t, uses, hashes[i]),
    ),
  )
  const added = res.reduce((a, r) => a + (r.meta.changes ?? 0), 0)
  // 放回了自己的码：这个产品已用来领码的押金记下这个码，等它被别人领走后退押金
  const firstNew = fresh.map((i) => ids[i]).find((_, k) => res[k].meta.changes)
  let relayed = 0
  if (firstNew) {
    const r = await c.env.DB.prepare(
      `UPDATE relay_deposits SET relay_code_id = ?, updated_at = ?
        WHERE user_id = ? AND product_key = ? AND status = 'used' AND relay_code_id IS NULL`,
    )
      .bind(firstNew, t, user.id, product.key)
      .run()
    relayed = r.meta.changes ?? 0
  }
  if (added) await serveQueue(c.env, product.key, waitUntilOf(c))
  return c.json({ added, duplicates: codes.length - added, product_key: product.key, relayed })
})

app.delete('/codes/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const r = await c.env.DB.prepare(
    `UPDATE codes SET status = 'withdrawn', code = NULL
      WHERE id = ? AND sharer_id = ? AND status = 'available'`,
  )
    .bind(c.req.param('id'), user.id)
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_withdrawable', '这个码已被用完或不存在')
  // 用来接力、还没人领的码撤回了：押金要等重新放回码
  await c.env.DB.prepare(
    "UPDATE relay_deposits SET relay_code_id = NULL, updated_at = ? WHERE relay_code_id = ? AND status = 'used'",
  )
    .bind(now(), c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// 多人可用码：分享者改剩余次数（比如在别处用掉了几次）
app.patch('/codes/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req.json<{ remaining?: unknown }>().catch(() => null)
  const row = await c.env.DB.prepare(
    `SELECT c.id, p.mode, p.max_uses AS product_max,
            (SELECT COUNT(*) FROM claims x WHERE x.code_id = c.id) AS used
       FROM codes c JOIN products p ON p.key = c.product_key
      WHERE c.id = ? AND c.sharer_id = ? AND c.status <> 'withdrawn'`,
  )
    .bind(c.req.param('id'), user.id)
    .first<{ id: string; mode: Mode; product_max: number; used: number }>()
  if (!row) return fail(c, 404, 'not_found', '没有这个码')
  if (row.mode !== 'multi') return fail(c, 400, 'not_multi', '一次性码没有剩余次数可改')
  const cap = Math.max(0, row.product_max - row.used)
  const remaining = intIn(body?.remaining, 0, cap)
  if (remaining === null) return fail(c, 400, 'bad_uses', `剩余次数需要 0 到 ${cap}`)

  const r = await c.env.DB.prepare(
    `UPDATE codes
        SET max_uses = ?1, status = CASE WHEN ?2 > 0 THEN 'available' ELSE 'claimed' END
      WHERE id = ?3 AND status <> 'withdrawn'
        AND (SELECT COUNT(*) FROM claims x WHERE x.code_id = codes.id) = ?4`,
  )
    .bind(row.used + remaining, remaining, row.id, row.used)
    .run()
  if (!r.meta.changes) return fail(c, 409, 'changed', '刚好有人领了这个码，请刷新后再改')
  if (remaining > 0) {
    const k = await c.env.DB.prepare('SELECT product_key FROM codes WHERE id = ?').bind(row.id).first<{ product_key: string }>()
    if (k) await serveQueue(c.env, k.product_key, waitUntilOf(c))
  }
  return c.json({ ok: true, remaining })
})

// ---------- LDC 奖励 ----------

// 领取成功后记下要发给分享者的奖励（还不发，等观察期过了由定时任务发）
async function recordRewards(db: D1Database, claimId: string, t: number) {
  const s = await getSettings(db)
  if (!s.ldc_enabled) return
  const due = t + s.hold_hours * 3600 * 1000
  // 贡献奖励每个码只记一次（id 相同时 INSERT OR IGNORE 跳过），领取奖励每次领取一笔
  const insert = (kind: 'share' | 'claim', id: string, amount: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO payouts
           (id, kind, code_id, claim_id, product_key, sharer_id, amount_cents, status, due_at, created_at, updated_at)
         SELECT ?1, ?2, x.code_id, x.id, x.product_key, x.sharer_id, ${amount},
                CASE WHEN EXISTS (SELECT 1 FROM reports r WHERE r.code_id = x.code_id AND r.status = 'open')
                     THEN 'held' ELSE 'pending' END,
                ?3, ?4, ?4
           FROM claims x JOIN products p ON p.key = x.product_key JOIN users u ON u.id = x.sharer_id
          WHERE x.id = ?5 AND ${amount} > 0 AND u.linuxdo_id > 0`,
      )
      .bind(id, kind, due, t, claimId)
  const code = await db.prepare('SELECT code_id FROM claims WHERE id = ?').bind(claimId).first<{ code_id: string }>()
  if (!code) return
  await db.batch([
    insert('share', `share-${code.code_id}`, `COALESCE(p.share_reward_cents, ${s.share_reward_cents})`),
    insert('claim', `claim-${claimId}`, `COALESCE(p.claim_reward_cents, ${s.claim_reward_cents})`),
  ])
}

type PayoutJob = {
  id: string
  kind: 'share' | 'claim'
  amount_cents: number
  linuxdo_id: number
  username: string
  product: string
}

const cents = (n: number) => (n / 100).toFixed(2)

// 把到期的奖励发出去。每笔先原子地改成 sending，再调 LDC；全站 24 小时上限也在这条 UPDATE 里检查。
// only：只发这几笔（管理员「立即发放」用），不看其他到期的
export async function runPayouts(env: Env, limit = 25, only?: string[]) {
  const s = await getSettings(env.DB)
  const out = { configured: ldcConfigured(env), enabled: s.ldc_enabled, sent: 0, failed: 0, waiting: 0 }
  if (!out.configured || !s.ldc_enabled) return out
  const t = now()

  // 上次发到一半中断的：放回 pending。用同一个 out_trade_no 重发，已经到账的会被 LDC 拒绝，不会重复。
  await env.DB.prepare(
    "UPDATE payouts SET status = 'pending', updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2",
  )
    .bind(t, t - 10 * 60 * 1000)
    .run()

  const { results } = await env.DB.prepare(
    `SELECT y.id, y.kind, y.amount_cents, u.linuxdo_id, u.username, p.name AS product
       FROM payouts y JOIN users u ON u.id = y.sharer_id JOIN products p ON p.key = y.product_key
      WHERE y.status = 'pending' AND y.due_at <= ?1
        AND (?3 IS NULL OR y.id IN (SELECT value FROM json_each(?3)))
      ORDER BY y.due_at
      LIMIT ?2`,
  )
    .bind(t, limit, only ? JSON.stringify(only) : null)
    .all<PayoutJob>()

  const base = env.LDC_BASE || 'https://credit.linux.do'
  const auth = 'Basic ' + btoa(`${env.LDC_CLIENT_ID}:${env.LDC_CLIENT_SECRET}`)
  for (const job of results) {
    const lock = await env.DB.prepare(
      `UPDATE payouts SET status = 'sending', attempts = attempts + 1, updated_at = ?1
        WHERE id = ?2 AND status = 'pending'
          AND (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts
                WHERE (status = 'sent' AND sent_at > ?3) OR status = 'sending') + amount_cents <= ?4`,
    )
      .bind(t, job.id, t - DAY, s.daily_cap_cents)
      .run()
    if (!lock.meta.changes) {
      out.waiting++
      continue
    }
    let tradeNo: string | null = null
    let error: string | null = null
    try {
      const res = await fetch(new URL('/lpay/distribute', base), {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          user_id: job.linuxdo_id,
          username: job.username,
          amount: Number(cents(job.amount_cents)),
          out_trade_no: job.id,
          remark: `${job.kind === 'share' ? '分享' : '有人领取了'} ${job.product} 邀请码的奖励`.slice(0, 100),
        }),
      })
      const data = (await res.json().catch(() => null)) as
        | { error_msg?: string; data?: { trade_no?: string | number } }
        | null
      if (res.ok && data?.data?.trade_no !== undefined && !data.error_msg) tradeNo = String(data.data.trade_no)
      else error = (data?.error_msg || `LDC 返回 ${res.status}`).slice(0, 300)
    } catch (e) {
      error = `连不上 LDC：${String(e).slice(0, 200)}`
    }
    const done = now()
    if (tradeNo) {
      out.sent++
      await env.DB.prepare(
        "UPDATE payouts SET status = 'sent', trade_no = ?, error = NULL, sent_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(tradeNo, done, done, job.id)
        .run()
    } else {
      out.failed++
      await env.DB.prepare("UPDATE payouts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(error, done, job.id)
        .run()
    }
  }
  return out
}

// ---------- 领取（原子操作） ----------

// ---------- 接力押金 ----------

async function md5Hex(s: string) {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// LINUX DO Credit（易支付兼容）签名：去掉空值和 sign / sign_type，按键名排序拼成 k=v&k=v，末尾接密钥，取 MD5
async function epaySign(params: Record<string, string>, secret: string) {
  const s = Object.keys(params)
    .filter((k) => params[k] !== '' && k !== 'sign' && k !== 'sign_type')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return md5Hex(s + secret)
}

const epayBase = (env: Env) => `${(env.LDC_BASE || 'https://credit.linux.do').replace(/\/+$/, '')}/epay`

type DepositRow = {
  id: string
  queued: number
  user_id: number
  product_key: string
  amount_cents: number
  status: string
  trade_no: string | null
  claim_id: string | null
  relay_code_id: string | null
}

// 把一笔押金原路退回。from 是允许的当前状态，先改成 refunding 再调 LDC，防止重复退。
async function refundDeposit(env: Env, id: string, from: string[]) {
  const t = now()
  const lock = await env.DB.prepare(
    `UPDATE relay_deposits SET status = 'refunding', attempts = attempts + 1, updated_at = ?1
      WHERE id = ?2 AND status IN (SELECT value FROM json_each(?3)) AND trade_no IS NOT NULL`,
  )
    .bind(t, id, JSON.stringify(from))
    .run()
  if (!lock.meta.changes) return { ok: false as const, error: '这笔押金现在不能退' }
  const d = await env.DB.prepare('SELECT * FROM relay_deposits WHERE id = ?').bind(id).first<DepositRow>()
  let error: string | null = null
  try {
    const res = await fetch(`${epayBase(env)}/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        act: 'refund',
        pid: env.LDC_CLIENT_ID!,
        key: env.LDC_CLIENT_SECRET!,
        trade_no: d!.trade_no!,
        money: cents(d!.amount_cents),
      }),
    })
    const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
    if (data?.code !== 1) error = (data?.msg || `LDC 返回 ${res.status}`).slice(0, 300)
  } catch (e) {
    error = `连不上 LDC：${String(e).slice(0, 200)}`
  }
  const done = now()
  if (error) {
    await env.DB.prepare("UPDATE relay_deposits SET status = 'refund_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(error, done, id)
      .run()
    return { ok: false as const, error }
  }
  await env.DB.prepare(
    "UPDATE relay_deposits SET status = 'refunded', error = NULL, refunded_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(done, done, id)
    .run()
  return { ok: true as const }
}

// 定时退押金：放回的码被别人领了、观察期过了、这个码没有待处理的无效反馈
export async function runRefunds(env: Env, limit = 25) {
  const out = { refunded: 0, failed: 0 }
  if (!ldcConfigured(env)) return out
  const { results } = await env.DB.prepare(
    `SELECT d.id FROM relay_deposits d
      WHERE d.status = 'refund_due' AND d.refund_due_at <= ?
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.code_id = d.relay_code_id AND r.status = 'open')
      ORDER BY d.refund_due_at LIMIT ?`,
  )
    .bind(now(), limit)
    .all<{ id: string }>()
  for (const { id } of results) {
    const r = await refundDeposit(env, id, ['refund_due'])
    if (r.ok) out.refunded++
    else out.failed++
  }
  return out
}

// 付押金：生成 LINUX DO Credit 付款链接，浏览器跳过去付，付完 LDC 回调 /api/ldc/notify
app.post('/products/:key/deposit', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const key = c.req.param('key')
  const queue = Boolean((await c.req.json<{ queue?: unknown }>().catch(() => null))?.queue)
  const product = await c.env.DB.prepare('SELECT name FROM products WHERE key = ? AND active = 1')
    .bind(key)
    .first<{ name: string }>()
  if (!product) return fail(c, 404, 'no_product', '这个产品不存在或已下架')
  const rules = await productRules(c.env, key, user.trust_level)
  if (user.trust_level < rules.minTrust) {
    return fail(c, 403, 'trust_level', `LinuxDO 信任等级达到 ${rules.minTrust} 级才能领 ${product.name}`)
  }
  if (queue && rules.base === null) return fail(c, 409, 'no_queue', `${product.name} 不用接力，没有排队`)
  const premium = queue ? (await getSettings(c.env.DB)).queue_premium_cents : 0
  // 排队押金 = 你领这个产品的正常押金 + 排队加价，放回码被别人领走后一起退
  const amount = (rules.deposit ?? 0) + premium
  if (!amount) return fail(c, 409, 'no_deposit_needed', `你领 ${product.name} 不用押金`)
  if (!ldcConfigured(c.env)) return fail(c, 409, 'ldc_not_configured', '站点还没接上 LINUX DO Credit，暂时付不了押金')
  const db = c.env.DB
  if (await db.prepare('SELECT 1 FROM claims WHERE user_id = ? AND product_key = ? AND void_at IS NULL').bind(user.id, key).first()) {
    return fail(c, 409, 'already_claimed', '这个产品你已经领过一个了')
  }
  if (
    await db
      .prepare("SELECT 1 FROM relay_deposits WHERE user_id = ? AND product_key = ? AND status = 'paid'")
      .bind(user.id, key)
      .first()
  ) {
    return fail(
      c,
      409,
      'has_deposit',
      queue ? '你已经付过这个产品的押金了，有码时直接领就行；想排队可以先在「我的」里退回押金' : '押金已经付过了，直接领取就行',
    )
  }
  const pool = await db
    .prepare(
      `SELECT 1 FROM codes c WHERE c.product_key = ? AND c.status = 'available' AND c.sharer_id <> ? AND ${REMAINING} > 0 LIMIT 1`,
    )
    .bind(key, user.id)
    .first()
  if (queue && pool) return fail(c, 409, 'not_empty', '现在有码可以领，不用排队，直接领就行')
  if (!queue && !pool) return fail(c, 409, 'empty', '现在没有可领的码，先别付押金')

  const t = now()
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM relay_deposits WHERE user_id = ? AND status = 'pending' AND created_at > ?")
    .bind(user.id, t - DAY)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= 10) return fail(c, 429, 'too_many_orders', '24 小时内开了太多没付的押金单，晚点再试')
  const id = `dep-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO relay_deposits (id, user_id, product_key, amount_cents, status, queued, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, user.id, key, amount, queue ? 1 : 0, t, t)
    .run()
  const origin = new URL(c.req.url).origin
  const params: Record<string, string> = {
    pid: c.env.LDC_CLIENT_ID!,
    type: 'epay',
    name: `${product.name} 邀请码${queue ? '排队' : '接力'}押金`.slice(0, 60),
    money: cents(amount),
    out_trade_no: id,
    notify_url: `${origin}/api/ldc/notify`,
    return_url: `${origin}/#square`,
    sign_type: 'MD5',
  }
  params.sign = await epaySign(params, c.env.LDC_CLIENT_SECRET!)
  return c.json({
    url: `${epayBase(c.env)}/pay/submit.php?${new URLSearchParams(params)}`,
    id,
    amount_cents: amount,
    queued: queue,
  })
})

// LINUX DO Credit 付款成功的异步通知（GET）。验签、核对商户号和金额后记为已付。必须回纯文本 success。
app.get('/ldc/notify', async (c) => {
  const q = Object.fromEntries(new URL(c.req.url).searchParams)
  const bad = (why: string) => {
    console.warn('ldc notify rejected:', why, q.out_trade_no)
    return c.text('fail', 400)
  }
  if (!ldcConfigured(c.env)) return bad('not configured')
  const want = await epaySign(q, c.env.LDC_CLIENT_SECRET!)
  if ((q.sign ?? '').toLowerCase() !== want) return bad('sign')
  if (q.pid !== c.env.LDC_CLIENT_ID) return bad('pid')
  if (q.trade_status !== 'TRADE_SUCCESS') return bad('status')
  const d = await c.env.DB.prepare('SELECT * FROM relay_deposits WHERE id = ?')
    .bind(q.out_trade_no ?? '')
    .first<DepositRow>()
  if (!d) return bad('order')
  if (q.money !== cents(d.amount_cents)) return bad('money')
  const t = now()
  await c.env.DB.prepare(
    "UPDATE relay_deposits SET status = 'paid', trade_no = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(q.trade_no ?? null, t, t, d.id)
    .run()
  // 排队押金付好了：如果刚好有码、又轮到排队，马上发
  if (d.queued) await serveQueue(c.env, d.product_key, waitUntilOf(c))
  return c.text('success')
})

app.get('/my/deposits', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.product_key, p.name AS product, d.amount_cents, d.status, d.claim_id, d.queued,
            d.relay_code_id IS NOT NULL AS relayed, d.refund_due_at, d.error, d.created_at, d.paid_at, d.refunded_at
       FROM relay_deposits d JOIN products p ON p.key = d.product_key
      WHERE d.user_id = ? AND d.status <> 'pending'
      ORDER BY d.created_at DESC LIMIT 200`,
  )
    .bind(user.id)
    .all()
  return c.json({ deposits: results })
})

// 预约排队：我在排的队（顺便看看有没有轮到我），和最近排到的码。网页开着时每隔一会儿查一次。
app.get('/my/queue', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const db = c.env.DB
  const mine = await db
    .prepare("SELECT DISTINCT product_key FROM relay_deposits WHERE user_id = ? AND queued = 1 AND status = 'paid'")
    .bind(user.id)
    .all<{ product_key: string }>()
  for (const r of mine.results) await serveQueue(c.env, r.product_key, waitUntilOf(c))
  const { results: waiting } = await db
    .prepare(
      `SELECT d.id, d.product_key, p.name AS product, d.amount_cents, d.paid_at,
              1 + (SELECT COUNT(*) FROM relay_deposits q
                    WHERE q.product_key = d.product_key AND q.queued = 1 AND q.status = 'paid'
                      AND (q.paid_at < d.paid_at OR (q.paid_at = d.paid_at AND q.id < d.id))) AS position
         FROM relay_deposits d JOIN products p ON p.key = d.product_key
        WHERE d.user_id = ? AND d.queued = 1 AND d.status = 'paid'
        ORDER BY d.paid_at`,
    )
    .bind(user.id)
    .all()
  const { results: served } = await db
    .prepare(
      `SELECT d.id, x.id AS claim_id, p.name AS product, x.code, x.claimed_at
         FROM relay_deposits d JOIN claims x ON x.id = d.claim_id JOIN products p ON p.key = d.product_key
        WHERE d.user_id = ? AND d.queued = 1 AND x.void_at IS NULL AND x.claimed_at > ?
        ORDER BY x.claimed_at DESC LIMIT 20`,
    )
    .bind(user.id, now() - 7 * DAY)
    .all()
  return c.json({ waiting, served })
})

// 押金付了但没用上（没领到码、领到的码被确认无效），可以自己退回
app.post('/deposits/:id/refund', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const d = await c.env.DB.prepare('SELECT id, status FROM relay_deposits WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<{ id: string; status: string }>()
  if (!d) return fail(c, 404, 'not_found', '没有这笔押金')
  if (d.status !== 'paid') return fail(c, 409, 'not_refundable', '这笔押金已经用来领码了，要等你放回的码被别人领走才退')
  if (!ldcConfigured(c.env)) return fail(c, 409, 'ldc_not_configured', '站点还没接上 LINUX DO Credit')
  const r = await refundDeposit(c.env, d.id, ['paid'])
  if (!r.ok) return fail(c, 409, 'refund_failed', `退款没成功：${r.error}`)
  return c.json({ ok: true })
})

// ---------- 发码（现领和排队共用） ----------

type Granted = { id: string; code_id: string; code: string; claimed_at: number }
type WaitUntil = ((p: Promise<unknown>) => void) | undefined

function waitUntilOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): WaitUntil {
  try {
    const ctx = c.executionCtx
    return (p) => ctx.waitUntil(p)
  } catch {
    return undefined // 没有执行上下文（比如测试里）就等定时任务
  }
}

// 给一个人发一个码，并处理奖励和接力押金。maxClaims = null 表示不受每日上限限制（排队的人）。
async function grantCode(
  env: Env,
  userId: number,
  key: string,
  depositId: string | null,
  maxClaims: number | null,
  waitUntil: WaitUntil,
): Promise<Granted | null> {
  const t = now()
  // 一条语句完成：挑码 → 确认我没领过这个产品 → 确认没超每日上限 → 记一次领取。
  // 挑码时优先给被领得最少的分享者，同样少的随机挑，让每个分享者都能轮到。
  // 码用满时由触发器在同一条语句里标记为 claimed，D1 串行执行写操作，不会超发。
  const row = await env.DB.prepare(
    `INSERT INTO claims (id, code_id, product_key, sharer_id, user_id, code, claimed_at)
     SELECT ?1, c.id, c.product_key, c.sharer_id, ?2, c.code, ?3
       FROM codes c JOIN products p ON p.key = c.product_key
      WHERE c.product_key = ?4 AND c.status = 'available' AND c.sharer_id <> ?2 AND p.active = 1
        AND ${REMAINING} > 0
        AND NOT EXISTS (SELECT 1 FROM claims y WHERE y.user_id = ?2 AND y.product_key = ?4 AND y.void_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM claims v WHERE v.user_id = ?2 AND v.code_id = c.id)
        AND (SELECT COUNT(*) FROM claims z WHERE z.user_id = ?2 AND z.claimed_at > ?5) < ?6
      ORDER BY (SELECT COUNT(*) FROM claims s WHERE s.sharer_id = c.sharer_id AND s.product_key = c.product_key),
               random()
      LIMIT 1
     RETURNING id, code_id, code, claimed_at`,
  )
    .bind(crypto.randomUUID(), userId, t, key, t - DAY, maxClaims ?? 1_000_000_000)
    .first<Granted>()
  if (!row) return null

  await recordRewards(env.DB, row.id, t)
  if (depositId) {
    // 押金绑到这次领取；如果手上已经有这个产品还在池子里的码，直接算放回了
    const own = await env.DB.prepare(
      `SELECT c.id FROM codes c WHERE c.sharer_id = ? AND c.product_key = ? AND c.status = 'available'
          AND NOT EXISTS (SELECT 1 FROM relay_deposits d WHERE d.relay_code_id = c.id) LIMIT 1`,
    )
      .bind(userId, key)
      .first<{ id: string }>()
    await env.DB.prepare(
      "UPDATE relay_deposits SET status = 'used', claim_id = ?, relay_code_id = ?, updated_at = ? WHERE id = ? AND status = 'paid'",
    )
      .bind(row.id, own?.id ?? null, t, depositId)
      .run()
  }
  // 领到的是别人用来接力的码：那个人的押金在观察期后退回
  const s = await getSettings(env.DB)
  await env.DB.prepare(
    `UPDATE relay_deposits SET status = 'refund_due', refund_due_at = ?, updated_at = ?
      WHERE relay_code_id = ? AND status = 'used'`,
  )
    .bind(t + s.hold_hours * 60 * 60 * 1000, t, row.code_id)
    .run()
  // 接力链：A 分享 → B 领了 A 的码 → B 放回自己的码 → 现在被领走。
  // 说明 B 用 A 的码注册成功了，A 的押金不用再等观察期，马上退。
  const proven = await env.DB.prepare(
    `UPDATE relay_deposits SET refund_due_at = ?1, updated_at = ?1
      WHERE status = 'refund_due' AND refund_due_at > ?1
        AND relay_code_id IN (
          SELECT x.code_id FROM claims x JOIN codes k ON k.id = ?2
           WHERE x.user_id = k.sharer_id AND x.product_key = k.product_key AND x.void_at IS NULL)`,
  )
    .bind(t, row.code_id)
    .run()
  if (proven.meta.changes && waitUntil) waitUntil(runRefunds(env))
  return row
}

// 有码没人现领多久后，就算没轮到也发给排队的人
const QUEUE_STALE_MS = 10 * 60 * 1000

// 预约排队：有人排队时，每 3 个码里 2 个留给现领、1 个发给排队的人（按付款先后）。
// 码放进池子后 10 分钟都没人现领，也直接发给排队的人。
export async function serveQueue(env: Env, key: string, waitUntil?: WaitUntil) {
  let served = 0
  for (let round = 0; round < 20; round++) {
    const { results: queue } = await env.DB.prepare(
      `SELECT id, user_id FROM relay_deposits
        WHERE product_key = ? AND queued = 1 AND status = 'paid'
        ORDER BY paid_at, id LIMIT 5`,
    )
      .bind(key)
      .all<{ id: string; user_id: number }>()
    if (queue.length === 0) {
      if (served) await env.DB.prepare('UPDATE products SET queue_slot = 0 WHERE key = ?').bind(key).run()
      break
    }
    const p = await env.DB.prepare(
      `SELECT p.queue_slot,
              MAX(COALESCE((SELECT MAX(x.claimed_at) FROM claims x WHERE x.product_key = p.key), 0),
                  COALESCE((SELECT MIN(c.created_at) FROM codes c
                             WHERE c.product_key = p.key AND c.status = 'available' AND ${REMAINING} > 0), 0)) AS since
         FROM products p WHERE p.key = ? AND p.active = 1`,
    )
      .bind(key)
      .first<{ queue_slot: number; since: number }>()
    if (!p) break
    const turn = p.queue_slot % 3 === 2 || p.since < now() - QUEUE_STALE_MS
    if (!turn) break
    let granted = false
    for (const q of queue) {
      // 排队期间已经领到这个产品了：退出排队，押金留着可以自己退
      const had = await env.DB.prepare(
        'SELECT 1 FROM claims WHERE user_id = ? AND product_key = ? AND void_at IS NULL',
      )
        .bind(q.user_id, key)
        .first()
      if (had) {
        await env.DB.prepare('UPDATE relay_deposits SET queued = 0, updated_at = ? WHERE id = ?').bind(now(), q.id).run()
        granted = true // 队伍变了，重新看一轮
        break
      }
      if (await grantCode(env, q.user_id, key, q.id, null, waitUntil)) {
        await env.DB.prepare('UPDATE products SET queue_slot = 0 WHERE key = ?').bind(key).run()
        served++
        granted = true
        break
      }
    }
    if (!granted) break // 池子里没有能发给排队的人的码
  }
  return served
}

// 定时任务：每个有人排队的产品看一遍
export async function serveAllQueues(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT product_key FROM relay_deposits WHERE queued = 1 AND status = 'paid'",
  ).all<{ product_key: string }>()
  let served = 0
  for (const r of results) served += await serveQueue(env, r.product_key)
  return served
}

app.post('/claim', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req.json<{ product_key?: string }>().catch(() => null)
  const key = body?.product_key ?? ''
  if (!key) return fail(c, 400, 'bad_product', '缺少产品')
  const rules = await productRules(c.env, key, user.trust_level)
  if (user.trust_level < rules.minTrust) {
    return fail(c, 403, 'trust_level', `LinuxDO 信任等级达到 ${rules.minTrust} 级才能领这个产品`)
  }

  const t = now()
  const maxClaims = num(c.env.MAX_CLAIMS_PER_DAY, 5)

  // 要接力的产品：先付押金
  const depositCents = rules.deposit
  let deposit: { id: string } | null = null
  if (depositCents) {
    const claimed = await c.env.DB.prepare(
      'SELECT 1 FROM claims WHERE user_id = ? AND product_key = ? AND void_at IS NULL',
    )
      .bind(user.id, key)
      .first()
    if (claimed) return fail(c, 409, 'already_claimed', '这个产品你已经领过一个了')
    deposit = await c.env.DB.prepare(
      "SELECT id FROM relay_deposits WHERE user_id = ? AND product_key = ? AND status = 'paid' ORDER BY queued, paid_at LIMIT 1",
    )
      .bind(user.id, key)
      .first<{ id: string }>()
    if (!deposit) {
      return fail(c, 402, 'deposit_required', `领这个产品要先付 ${cents(depositCents)} LDC 押金，放回你自己的码并被别人领走后退回`)
    }
  }

  // 有人排队时先看是不是轮到排队的人（每 3 个码 1 个给排队）
  await serveQueue(c.env, key, waitUntilOf(c))
  const row = await grantCode(c.env, user.id, key, deposit?.id ?? null, maxClaims, waitUntilOf(c))
  if (row) {
    // 现领成功：有人在排队就记一轮，轮到排队时把下一个码发给排队的人
    await c.env.DB.prepare(
      `UPDATE products SET queue_slot = queue_slot + 1
        WHERE key = ? AND EXISTS (SELECT 1 FROM relay_deposits q WHERE q.product_key = products.key AND q.queued = 1 AND q.status = 'paid')`,
    )
      .bind(key)
      .run()
    await serveQueue(c.env, key, waitUntilOf(c))
    const info = await c.env.DB.prepare(
      `SELECT c.note, p.name AS product, p.mode, u.username AS sharer_username
         FROM codes c JOIN products p ON p.key = c.product_key JOIN users u ON u.id = c.sharer_id
        WHERE c.id = ?`,
    )
      .bind(row.code_id)
      .first<{ note: string | null; product: string; mode: Mode; sharer_username: string }>()
    return c.json({
      claim: {
        id: row.id,
        code: row.code,
        claimed_at: row.claimed_at,
        ...info,
        deposit_cents: deposit ? depositCents : null,
      },
    })
  }

  // 没领到：查清原因告诉用户
  const product = await c.env.DB.prepare('SELECT 1 FROM products WHERE key = ? AND active = 1').bind(key).first()
  if (!product) return fail(c, 404, 'no_product', '这个产品不存在或已下架')
  const already = await c.env.DB.prepare(
    'SELECT 1 FROM claims WHERE user_id = ? AND product_key = ? AND void_at IS NULL',
  )
    .bind(user.id, key)
    .first()
  if (already) return fail(c, 409, 'already_claimed', '这个产品你已经领过一个了')
  const today = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM claims WHERE user_id = ? AND claimed_at > ?')
    .bind(user.id, t - DAY)
    .first<{ n: number }>()
  if ((today?.n ?? 0) >= maxClaims) {
    return fail(c, 429, 'claim_limit', `24 小时内最多领 ${maxClaims} 个`)
  }
  const onlyMine = await c.env.DB.prepare(
    "SELECT 1 FROM codes WHERE product_key = ? AND status = 'available' AND sharer_id = ?",
  )
    .bind(key, user.id)
    .first()
  if (onlyMine) return fail(c, 409, 'only_own', '池子里只剩你自己分享的码')
  return fail(c, 409, 'empty', '这个产品的码刚被领完了')
})

app.post('/claims/:id/thanks', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const r = await c.env.DB.prepare(
    'UPDATE claims SET thanked_at = ? WHERE id = ? AND user_id = ? AND thanked_at IS NULL',
  )
    .bind(now(), c.req.param('id'), user.id)
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_thankable', '已经感谢过了')
  return c.json({ ok: true })
})

// 领取人反馈码用不了：先扣下这个码还没发的奖励，等管理员处理
app.post('/claims/:id/report', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req.json<{ reason?: string }>().catch(() => null)
  const reason = (body?.reason ?? '').trim().slice(0, LIMITS.reason) || null
  const claim = await c.env.DB.prepare('SELECT * FROM claims WHERE id = ? AND user_id = ? AND void_at IS NULL')
    .bind(c.req.param('id'), user.id)
    .first<{ id: string; code_id: string; product_key: string; sharer_id: number }>()
  if (!claim) return fail(c, 404, 'not_found', '没有这条领取记录')
  const t = now()
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO reports (id, claim_id, code_id, product_key, reporter_id, sharer_id, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(crypto.randomUUID(), claim.id, claim.code_id, claim.product_key, user.id, claim.sharer_id, reason, t)
    .run()
  if (!r.meta.changes) return fail(c, 409, 'already_reported', '这个码你已经反馈过了')
  await c.env.DB.prepare(
    "UPDATE payouts SET status = 'held', updated_at = ? WHERE code_id = ? AND status IN ('pending', 'failed')",
  )
    .bind(t, claim.code_id)
    .run()
  return c.json({ ok: true })
})

// 确认一个码无效（管理员确认，或领取人自己退还的一次性码）：
// 领到它的人押金回到「已付」、领取作废；拿它接力的人要重新放回；码作废，没发的奖励取消。
function invalidateCode(db: D1Database, codeId: string, t: number, by: number | null) {
  return [
    db
      .prepare(
        `UPDATE relay_deposits SET status = 'paid', claim_id = NULL, relay_code_id = NULL, updated_at = ?1
          WHERE status = 'used'
            AND claim_id IN (SELECT claim_id FROM reports WHERE code_id = ?2 AND status = 'open')`,
      )
      .bind(t, codeId),
    db
      .prepare(
        `UPDATE relay_deposits SET status = 'used', relay_code_id = NULL, refund_due_at = NULL, updated_at = ?
          WHERE relay_code_id = ? AND status IN ('used', 'refund_due')`,
      )
      .bind(t, codeId),
    db
      .prepare(
        `UPDATE claims SET void_at = ?1
          WHERE void_at IS NULL
            AND id IN (SELECT claim_id FROM reports WHERE code_id = ?2 AND status = 'open')`,
      )
      .bind(t, codeId),
    db
      .prepare(
        "UPDATE reports SET status = 'confirmed', resolved_at = ?, resolved_by = ? WHERE code_id = ? AND status = 'open'",
      )
      .bind(t, by, codeId),
    db
      .prepare(
        "UPDATE codes SET status = 'withdrawn', code = NULL, invalid_at = ? WHERE id = ? AND status <> 'withdrawn'",
      )
      .bind(t, codeId),
    db
      .prepare(
        "UPDATE payouts SET status = 'canceled', updated_at = ? WHERE code_id = ? AND status IN ('pending', 'held', 'failed')",
      )
      .bind(t, codeId),
  ]
}

// 领到的码用不了，领取人可以自己退还：领到后 24 小时内，30 天内最多 3 次。
const RETURN_WINDOW_MS = 24 * 60 * 60 * 1000
const RETURNS_PER_30_DAYS = 3

app.post('/claims/:id/return', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req.json<{ reason?: string }>().catch(() => null)
  const reason = (body?.reason ?? '').trim().slice(0, LIMITS.reason) || null
  const db = c.env.DB
  const claim = await db
    .prepare(
      `SELECT x.id, x.code_id, x.product_key, x.sharer_id, x.claimed_at, p.mode
         FROM claims x JOIN products p ON p.key = x.product_key
        WHERE x.id = ? AND x.user_id = ? AND x.void_at IS NULL`,
    )
    .bind(c.req.param('id'), user.id)
    .first<{ id: string; code_id: string; product_key: string; sharer_id: number; claimed_at: number; mode: Mode }>()
  if (!claim) return fail(c, 404, 'not_found', '没有这条领取记录，或已经退还过了')
  const t = now()
  if (claim.claimed_at < t - RETURN_WINDOW_MS) {
    return fail(c, 409, 'return_expired', '领到超过 24 小时了，不能自己退还；可以点「码用不了？」反馈给管理员')
  }
  const prior = await db
    .prepare('SELECT status FROM reports WHERE claim_id = ?')
    .bind(claim.id)
    .first<{ status: string }>()
  if (prior && prior.status !== 'open') {
    return fail(c, 409, 'already_reviewed', '管理员已经处理过这个码的反馈，不能再退还')
  }
  const used = await db
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND self_return = 1 AND created_at > ?')
    .bind(user.id, t - 30 * DAY)
    .first<{ n: number }>()
  if ((used?.n ?? 0) >= RETURNS_PER_30_DAYS) {
    return fail(c, 429, 'return_limit', `30 天内最多自己退还 ${RETURNS_PER_30_DAYS} 次，这次请点「码用不了？」反馈给管理员`)
  }
  if (prior) {
    await db
      .prepare('UPDATE reports SET self_return = 1, created_at = ?, reason = COALESCE(?, reason) WHERE claim_id = ?')
      .bind(t, reason, claim.id)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO reports (id, claim_id, code_id, product_key, reporter_id, sharer_id, reason, status, created_at, self_return)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 1)`,
      )
      .bind(crypto.randomUUID(), claim.id, claim.code_id, claim.product_key, user.id, claim.sharer_id, reason, t)
      .run()
  }
  if (claim.mode === 'single') {
    // 一次性码：直接作废，不会再发给别人
    await db.batch(invalidateCode(db, claim.code_id, t, null))
  } else {
    // 多人可用码：只作废我这次领取，码本身留给管理员判断；码上没发的奖励先扣下
    await db.batch([
      db
        .prepare(
          "UPDATE relay_deposits SET status = 'paid', claim_id = NULL, relay_code_id = NULL, updated_at = ? WHERE claim_id = ? AND status = 'used'",
        )
        .bind(t, claim.id),
      db.prepare('UPDATE claims SET void_at = ? WHERE id = ? AND void_at IS NULL').bind(t, claim.id),
      db
        .prepare("UPDATE payouts SET status = 'held', updated_at = ? WHERE code_id = ? AND status IN ('pending', 'failed')")
        .bind(t, claim.code_id),
    ])
  }
  return c.json({ ok: true, invalidated: claim.mode === 'single' })
})

// ---------- 申请新产品 ----------

const REQUEST_COLUMNS = `r.id, r.name, r.product_key, r.mode, r.max_uses, r.description, r.status, r.admin_note,
            r.created_at, r.resolved_at`

app.post('/product-requests', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req
    .json<{ name?: unknown; mode?: unknown; max_uses?: unknown; description?: unknown }>()
    .catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > LIMITS.productName) {
    return fail(c, 400, 'bad_name', `产品名需要 1 到 ${LIMITS.productName} 个字`)
  }
  const mode = body?.mode === 'multi' ? 'multi' : 'single'
  let maxUses: number | null = null
  if (mode === 'multi' && body?.max_uses !== undefined && body?.max_uses !== null && body?.max_uses !== '') {
    maxUses = intIn(body.max_uses, 1, LIMITS.maxUses)
    if (maxUses === null) return fail(c, 400, 'bad_max_uses', `每个码可用次数需要 1 到 ${LIMITS.maxUses}`)
  }
  const description =
    typeof body?.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, LIMITS.description)
      : null
  const key = productKey(name)

  const existing = await c.env.DB.prepare('SELECT name, active FROM products WHERE key = ?')
    .bind(key)
    .first<{ name: string; active: number }>()
  if (existing?.active) return fail(c, 409, 'exists', `广场上已经有 ${existing.name} 了，直接去分享吧`)

  const mine = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM product_requests WHERE user_id = ? AND status = 'pending'",
  )
    .bind(user.id)
    .first<{ n: number }>()
  if ((mine?.n ?? 0) >= LIMITS.pendingRequests) {
    return fail(c, 429, 'too_many_requests', `你已经有 ${LIMITS.pendingRequests} 个申请在等审核，等管理员处理后再申请`)
  }

  const id = crypto.randomUUID()
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO product_requests (id, user_id, name, product_key, mode, max_uses, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, user.id, name, key, mode, maxUses, description, now())
    .run()
  if (!r.meta.changes) return fail(c, 409, 'already_requested', `已经有人申请了 ${name}，正在等管理员审核`)
  return c.json({ id })
})

app.get('/my/product-requests', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results } = await c.env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM product_requests r WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(user.id)
    .all()
  return c.json({ requests: results })
})

app.delete('/product-requests/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const r = await c.env.DB.prepare(
    "UPDATE product_requests SET status = 'canceled', resolved_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
  )
    .bind(now(), c.req.param('id'), user.id)
    .run()
  if (!r.meta.changes) return fail(c, 404, 'not_found', '没有这条待审核的申请')
  return c.json({ ok: true })
})

// ---------- 我的 ----------

const CODE_COLUMNS = `c.id, c.product_key, p.name AS product, p.mode, c.code, c.note, c.status, c.created_at,
            c.max_uses, p.max_uses AS product_max_uses,
            (SELECT COUNT(*) FROM claims x WHERE x.code_id = c.id) AS used,
            (SELECT COUNT(*) FROM claims x WHERE x.code_id = c.id AND x.thanked_at IS NOT NULL) AS thanks,
            (SELECT COUNT(*) FROM reports r WHERE r.code_id = c.id AND r.status = 'open') AS reports_open`

app.get('/my/shared', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results: codes } = await c.env.DB.prepare(
    `SELECT ${CODE_COLUMNS}
       FROM codes c JOIN products p ON p.key = c.product_key
      WHERE c.sharer_id = ? AND c.status <> 'withdrawn'
      ORDER BY c.created_at DESC
      LIMIT 500`,
  )
    .bind(user.id)
    .all()
  const { results: claimers } = await c.env.DB.prepare(
    `SELECT x.id, x.code_id, x.claimed_at, x.thanked_at, u.username, u.avatar_url
       FROM claims x JOIN users u ON u.id = x.user_id
      WHERE x.sharer_id = ?
      ORDER BY x.claimed_at DESC
      LIMIT 2000`,
  )
    .bind(user.id)
    .all()
  const summary = await c.env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.sharer_id = ?1 AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM claims WHERE sharer_id = ?1) AS claimed,
            (SELECT COUNT(*) FROM claims WHERE sharer_id = ?1 AND thanked_at IS NOT NULL) AS thanks,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE sharer_id = ?1 AND status = 'sent') AS rewarded_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts
              WHERE sharer_id = ?1 AND status IN ('pending', 'held', 'sending', 'failed')) AS pending_cents`,
  )
    .bind(user.id)
    .first()
  const { results: payouts } = await c.env.DB.prepare(
    `SELECT y.id, y.kind, y.code_id, p.name AS product, y.amount_cents, y.status, y.due_at, y.created_at, y.sent_at
       FROM payouts y JOIN products p ON p.key = y.product_key
      WHERE y.sharer_id = ?
      ORDER BY y.created_at DESC
      LIMIT 200`,
  )
    .bind(user.id)
    .all()
  return c.json({ codes, claimers, summary, payouts })
})

app.get('/my/claimed', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results } = await c.env.DB.prepare(
    `SELECT x.id, x.product_key, p.name AS product, p.mode, x.code, c.note, x.claimed_at, x.thanked_at, x.void_at,
            u.username AS sharer_username, u.avatar_url AS sharer_avatar,
            r.status AS report_status, r.self_return AS self_returned,
            d.id AS deposit_id, d.status AS deposit_status, d.amount_cents AS deposit_cents,
            d.relay_code_id IS NOT NULL AS relayed, d.refund_due_at
       FROM claims x
       JOIN products p ON p.key = x.product_key
       JOIN codes c ON c.id = x.code_id
       JOIN users u ON u.id = x.sharer_id
       LEFT JOIN reports r ON r.claim_id = x.id
       LEFT JOIN relay_deposits d ON d.claim_id = x.id
      WHERE x.user_id = ?
      ORDER BY x.claimed_at DESC
      LIMIT 500`,
  )
    .bind(user.id)
    .all()
  return c.json({ claims: results })
})

// ---------- 管理员 ----------

const admin = new Hono<AppEnv>()

admin.use('*', async (c, next) => {
  const u = c.get('user')
  if (!u) return fail(c, 401, 'login_required', '请先登录')
  if (!u.is_admin) return fail(c, 403, 'not_admin', '只有管理员能用')
  await next()
})

admin.get('/products', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.key, p.name, p.mode, p.max_uses, p.max_codes_per_user, p.code_pattern, p.description,
            p.active, p.created_at, p.share_reward_cents, p.claim_reward_cents, p.relay_required,
            p.deposit_cents, p.min_trust_level, p.deposit_tiers,
            (SELECT COUNT(*) FROM codes c WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS codes,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM claims x WHERE x.product_key = p.key) AS claimed,
            (SELECT COUNT(DISTINCT c.sharer_id) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS sharers
       FROM products p
      ORDER BY p.active DESC, p.created_at DESC`,
  ).all<{ deposit_tiers: string | null }>()
  return c.json({ products: results.map((p) => ({ ...p, deposit_tiers: parseTiers(p.deposit_tiers) ?? [] })) })
})

admin.post('/products', async (c) => {
  const body = await c.req.json<ProductInput>().catch(() => ({}) as ProductInput)
  const checked = checkProduct(body)
  if ('error' in checked) return fail(c, 400, checked.error, checked.message)
  const v = checked.value
  const key = productKey(v.name)
  const t = now()
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO products
       (key, name, created_by, created_at, updated_at, mode, max_uses, max_codes_per_user, code_pattern, description,
        share_reward_cents, claim_reward_cents, relay_required, deposit_cents, min_trust_level, deposit_tiers, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      key,
      v.name,
      c.get('user')!.id,
      t,
      t,
      v.mode,
      v.max_uses,
      v.max_codes_per_user,
      v.code_pattern,
      v.description,
      v.share_reward_cents,
      v.claim_reward_cents,
      v.relay_required,
      v.deposit_cents,
      v.min_trust_level,
      v.deposit_tiers,
    )
    .run()
  if (!r.meta.changes) return fail(c, 409, 'exists', `已经有 ${v.name} 这个产品了`)
  return c.json({ key })
})

admin.patch('/products/:key', async (c) => {
  const key = c.req.param('key')
  const cur = await c.env.DB.prepare('SELECT * FROM products WHERE key = ?').bind(key).first<ProductRow>()
  if (!cur) return fail(c, 404, 'no_product', '没有这个产品')
  const body = await c.req.json<ProductInput>().catch(() => ({}) as ProductInput)
  const merged: ProductInput = { ...cur, ...body }
  const checked = checkProduct(merged)
  if ('error' in checked) return fail(c, 400, checked.error, checked.message)
  const v = checked.value
  if (v.mode !== cur.mode) {
    const used = await c.env.DB.prepare(
      "SELECT 1 FROM codes WHERE product_key = ? AND status <> 'withdrawn' LIMIT 1",
    )
      .bind(key)
      .first()
    if (used) return fail(c, 409, 'mode_locked', '这个产品已经有人分享了码，不能再改模式')
  }
  const active = body.active === undefined ? cur.active : body.active ? 1 : 0
  await c.env.DB.prepare(
    `UPDATE products SET name = ?, mode = ?, max_uses = ?, max_codes_per_user = ?, code_pattern = ?,
            description = ?, share_reward_cents = ?, claim_reward_cents = ?, relay_required = ?, deposit_cents = ?,
            min_trust_level = ?, deposit_tiers = ?, active = ?, updated_at = ?
      WHERE key = ?`,
  )
    .bind(
      v.name,
      v.mode,
      v.max_uses,
      v.max_codes_per_user,
      v.code_pattern,
      v.description,
      v.share_reward_cents,
      v.claim_reward_cents,
      v.relay_required,
      v.deposit_cents,
      v.min_trust_level,
      v.deposit_tiers,
      active,
      now(),
      key,
    )
    .run()
  return c.json({ ok: true })
})

admin.get('/codes', async (c) => {
  const product = c.req.query('product') ?? ''
  const q = (c.req.query('q') ?? '').trim()
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%` : ''
  const { results } = await c.env.DB.prepare(
    `SELECT ${CODE_COLUMNS}, u.username AS sharer_username, u.avatar_url AS sharer_avatar
       FROM codes c JOIN products p ON p.key = c.product_key JOIN users u ON u.id = c.sharer_id
      WHERE c.status <> 'withdrawn'
        AND (?1 = '' OR c.product_key = ?1)
        AND (?2 = '' OR u.username LIKE ?2 ESCAPE '\\' OR c.code LIKE ?2 ESCAPE '\\')
      ORDER BY c.created_at DESC
      LIMIT 500`,
  )
    .bind(product, like)
    .all()
  return c.json({ codes: results })
})

// 管理员撤下一个码：没发的奖励一起取消
admin.delete('/codes/:id', async (c) => {
  const id = c.req.param('id')
  const t = now()
  const [r] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE codes SET status = 'withdrawn', code = NULL WHERE id = ? AND status <> 'withdrawn'").bind(id),
    c.env.DB.prepare(
      "UPDATE payouts SET status = 'canceled', updated_at = ? WHERE code_id = ? AND status IN ('pending', 'held', 'failed')",
    ).bind(t, id),
  ])
  if (!r.meta.changes) return fail(c, 404, 'not_found', '没有这个码')
  return c.json({ ok: true })
})

// ----- 无效反馈 -----

admin.get('/reports', async (c) => {
  const status = c.req.query('status') ?? 'open'
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.code_id, r.claim_id, r.reason, r.status, r.self_return, r.created_at, r.resolved_at,
            p.name AS product, p.mode, x.code, c.status AS code_status,
            ru.username AS reporter_username, ru.avatar_url AS reporter_avatar,
            su.username AS sharer_username, su.avatar_url AS sharer_avatar,
            (SELECT COUNT(*) FROM claims y WHERE y.code_id = r.code_id) AS used,
            (SELECT COUNT(*) FROM reports z WHERE z.code_id = r.code_id) AS reports_on_code,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts w
              WHERE w.code_id = r.code_id AND w.status = 'held') AS held_cents
       FROM reports r
       JOIN products p ON p.key = r.product_key
       JOIN claims x ON x.id = r.claim_id
       JOIN codes c ON c.id = r.code_id
       JOIN users ru ON ru.id = r.reporter_id
       JOIN users su ON su.id = r.sharer_id
      WHERE ?1 = 'all' OR r.status = ?1
      ORDER BY r.created_at DESC
      LIMIT 500`,
  )
    .bind(status)
    .all()
  return c.json({ reports: results })
})

// confirm：码确实不能用 → 撤下这个码、取消它没发的奖励、作废反馈人的领取（他们可以再领一个）
// dismiss：码没问题 → 关闭反馈，没有别的待处理反馈时恢复发奖励
admin.post('/reports/:id/resolve', async (c) => {
  const body = await c.req.json<{ action?: string }>().catch(() => null)
  const action = body?.action
  if (action !== 'confirm' && action !== 'dismiss') return fail(c, 400, 'bad_action', '只能确认无效或驳回')
  const report = await c.env.DB.prepare("SELECT id, code_id FROM reports WHERE id = ? AND status = 'open'")
    .bind(c.req.param('id'))
    .first<{ id: string; code_id: string }>()
  if (!report) return fail(c, 404, 'not_found', '这条反馈不存在或已处理')
  const t = now()
  const by = c.get('user')!.id
  const db = c.env.DB
  if (action === 'confirm') {
    await db.batch(invalidateCode(db, report.code_id, t, by))
  } else {
    await db.batch([
      db
        .prepare("UPDATE reports SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?")
        .bind(t, by, report.id),
      db
        .prepare(
          `UPDATE payouts SET status = 'pending', updated_at = ?1
            WHERE code_id = ?2 AND status = 'held'
              AND NOT EXISTS (SELECT 1 FROM reports WHERE code_id = ?2 AND status = 'open')`,
        )
        .bind(t, report.code_id),
    ])
  }
  return c.json({ ok: true })
})

// ----- LDC 设置和发放记录 -----

async function payoutStats(env: Env) {
  const t = now()
  return env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE status = 'sent' AND sent_at > ?1) AS sent_24h_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE status = 'sent') AS sent_total_cents,
            (SELECT COUNT(*) FROM payouts WHERE status = 'pending') AS pending,
            (SELECT COUNT(*) FROM payouts WHERE status = 'held') AS held,
            (SELECT COUNT(*) FROM payouts WHERE status = 'failed') AS failed`,
  )
    .bind(t - DAY)
    .first()
}

admin.get('/settings', async (c) => {
  return c.json({
    settings: await getSettings(c.env.DB),
    ldc_configured: ldcConfigured(c.env),
    stats: await payoutStats(c.env),
  })
})

admin.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return fail(c, 400, 'bad_body', '请求格式不对')
  const cur = await getSettings(c.env.DB)
  const next = { ...cur }
  if (body.ldc_enabled !== undefined) next.ldc_enabled = Boolean(body.ldc_enabled)
  for (const k of ['share_reward_cents', 'claim_reward_cents', 'daily_cap_cents'] as const) {
    if (body[k] === undefined) continue
    const n = intIn(body[k], 0, k === 'daily_cap_cents' ? 100 * LIMITS.rewardCents : LIMITS.rewardCents)
    if (n === null) return fail(c, 400, 'bad_amount', '金额不对：不能是负数，最多两位小数')
    next[k] = n
  }
  if (body.hold_hours !== undefined) {
    const n = intIn(body.hold_hours, 0, 24 * 30)
    if (n === null) return fail(c, 400, 'bad_hold', '观察期需要 0 到 720 小时')
    next.hold_hours = n
  }
  if (body.relay_enabled !== undefined) next.relay_enabled = Boolean(body.relay_enabled)
  if (body.relay_deposit_cents !== undefined) {
    const n = intIn(body.relay_deposit_cents, 1, LIMITS.rewardCents)
    if (n === null) return fail(c, 400, 'bad_relay_deposit', '押金需要大于 0，最多两位小数')
    next.relay_deposit_cents = n
  }
  if (body.queue_premium_cents !== undefined) {
    const n = intIn(body.queue_premium_cents, 1, LIMITS.rewardCents)
    if (n === null) return fail(c, 400, 'bad_queue_premium', '排队加价需要大于 0，最多两位小数')
    next.queue_premium_cents = n
  }
  const entries: [string, string][] = [
    ['ldc_enabled', next.ldc_enabled ? '1' : '0'],
    ['share_reward_cents', String(next.share_reward_cents)],
    ['claim_reward_cents', String(next.claim_reward_cents)],
    ['daily_cap_cents', String(next.daily_cap_cents)],
    ['hold_hours', String(next.hold_hours)],
    ['relay_enabled', next.relay_enabled ? '1' : '0'],
    ['relay_deposit_cents', String(next.relay_deposit_cents)],
    ['queue_premium_cents', String(next.queue_premium_cents)],
  ]
  await c.env.DB.batch(
    entries.map(([k, v]) =>
      c.env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).bind(k, v),
    ),
  )
  return c.json({ settings: next })
})

admin.get('/payouts', async (c) => {
  const status = c.req.query('status') ?? 'all'
  const { results } = await c.env.DB.prepare(
    `SELECT y.id, y.kind, y.code_id, y.amount_cents, y.status, y.due_at, y.trade_no, y.error, y.attempts,
            y.created_at, y.sent_at, p.name AS product, u.username AS sharer_username, u.avatar_url AS sharer_avatar
       FROM payouts y JOIN products p ON p.key = y.product_key JOIN users u ON u.id = y.sharer_id
      WHERE ?1 = 'all' OR y.status = ?1
      ORDER BY y.created_at DESC
      LIMIT 500`,
  )
    .bind(status)
    .all()
  return c.json({ payouts: results, stats: await payoutStats(c.env) })
})

// 立刻处理到期的奖励（定时任务每 10 分钟也会跑一次）
admin.post('/payouts/run', async (c) => {
  return c.json(await runPayouts(c.env))
})

// 立即发放：跳过观察期，马上发。有人反馈无效（held）的不发；全站 24 小时上限照样算。
async function sendNow(c: Context<AppEnv>, ids: string[]) {
  const s = await getSettings(c.env.DB)
  if (!ldcConfigured(c.env)) return fail(c, 409, 'ldc_not_configured', '还没设置 LDC 商户凭证，发不了')
  if (!s.ldc_enabled) return fail(c, 409, 'ldc_disabled', 'LDC 奖励没开启，先在设置里打开')
  if (ids.length === 0) return fail(c, 404, 'nothing_to_send', '没有可以立即发放的奖励')
  const t = now()
  await c.env.DB.prepare(
    `UPDATE payouts SET status = 'pending', due_at = ?1, updated_at = ?1
      WHERE id IN (SELECT value FROM json_each(?2)) AND status IN ('pending', 'failed')`,
  )
    .bind(t, JSON.stringify(ids))
    .run()
  const r = await runPayouts(c.env, ids.length, ids)
  return c.json(r)
}

admin.post('/payouts/:id/send-now', async (c) => {
  const row = await c.env.DB.prepare("SELECT id, status FROM payouts WHERE id = ?")
    .bind(c.req.param('id'))
    .first<{ id: string; status: string }>()
  if (!row) return fail(c, 404, 'not_found', '没有这笔奖励')
  if (row.status === 'held') return fail(c, 409, 'held', '这个码有人反馈无效，先处理反馈再发')
  if (row.status !== 'pending' && row.status !== 'failed') return fail(c, 409, 'not_sendable', '已经发出或已取消')
  return sendNow(c, [row.id])
})

admin.post('/users/:id/send-now', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM payouts WHERE sharer_id = ? AND status IN ('pending', 'failed') ORDER BY created_at LIMIT 100",
  )
    .bind(Number(c.req.param('id')))
    .all<{ id: string }>()
  return sendNow(
    c,
    results.map((r) => r.id),
  )
})

admin.post('/payouts/:id/retry', async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE payouts SET status = 'pending', due_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'failed'",
  )
    .bind(now(), c.req.param('id'))
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_retryable', '只有发送失败的可以重试')
  return c.json({ ok: true })
})

admin.post('/payouts/:id/cancel', async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE payouts SET status = 'canceled', updated_at = ? WHERE id = ? AND status IN ('pending', 'held', 'failed')",
  )
    .bind(now(), c.req.param('id'))
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_cancelable', '已经发出或已取消的不能取消')
  return c.json({ ok: true })
})

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM codes c WHERE c.sharer_id = u.id AND c.status <> 'withdrawn') AS codes,
            (SELECT COUNT(*) FROM claims x WHERE x.sharer_id = u.id) AS given,
            (SELECT COUNT(*) FROM claims x WHERE x.user_id = u.id) AS received,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts y
              WHERE y.sharer_id = u.id AND y.status IN ('pending', 'failed')) AS unpaid_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts y
              WHERE y.sharer_id = u.id AND y.status = 'held') AS held_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts y
              WHERE y.sharer_id = u.id AND y.status = 'sent') AS sent_cents
       FROM users u
      ORDER BY u.last_login_at DESC
      LIMIT 1000`,
  ).all<{ username: string; linuxdo_id: number }>()
  return c.json({
    users: results.map((u) => ({
      ...u,
      is_admin: isAdmin(c.env, u.username, u.linuxdo_id),
      is_test: u.linuxdo_id < 0,
    })),
  })
})

type RequestRow = {
  id: string
  user_id: number
  name: string
  product_key: string
  mode: 'single' | 'multi'
  max_uses: number | null
  description: string | null
  status: string
}

admin.get('/product-requests', async (c) => {
  const status = c.req.query('status') ?? 'pending'
  const { results } = await c.env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS}, u.username, u.avatar_url, ru.username AS resolved_by_username,
            (SELECT name FROM products p WHERE p.key = r.product_key) AS existing_product,
            (SELECT active FROM products p WHERE p.key = r.product_key) AS existing_active
       FROM product_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users ru ON ru.id = r.resolved_by
      WHERE ?1 = 'all' OR r.status = ?1
      ORDER BY r.created_at DESC
      LIMIT 500`,
  )
    .bind(status)
    .all()
  return c.json({ requests: results })
})

// 通过：用管理员填的产品设置（没填的用申请里的）建产品；产品已存在但下架了就重新上架
admin.post('/product-requests/:id/approve', async (c) => {
  const req = await c.env.DB.prepare("SELECT * FROM product_requests WHERE id = ? AND status = 'pending'")
    .bind(c.req.param('id'))
    .first<RequestRow>()
  if (!req) return fail(c, 404, 'not_found', '没有这条待审核的申请')
  const body = await c.req.json<ProductInput>().catch(() => ({}) as ProductInput)
  const input: ProductInput = {
    name: req.name,
    mode: req.mode,
    max_uses: req.max_uses ?? (req.mode === 'multi' ? 30 : undefined),
    description: req.description,
    ...body,
  }
  const checked = checkProduct(input)
  if ('error' in checked) return fail(c, 400, checked.error, checked.message)
  const v = checked.value
  const key = productKey(v.name)
  const t = now()
  const adminId = c.get('user')!.id

  const existing = await c.env.DB.prepare('SELECT active FROM products WHERE key = ?').bind(key).first<{ active: number }>()
  if (existing?.active) {
    return fail(c, 409, 'exists', `已经有 ${v.name} 这个产品了，可以拒绝这条申请并说明`)
  }
  const createOrReactivate = existing
    ? c.env.DB.prepare('UPDATE products SET active = 1, updated_at = ? WHERE key = ?').bind(t, key)
    : c.env.DB.prepare(
        `INSERT INTO products
           (key, name, created_by, created_at, updated_at, mode, max_uses, max_codes_per_user, code_pattern, description,
            share_reward_cents, claim_reward_cents, relay_required, deposit_cents, min_trust_level, deposit_tiers, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        key,
        v.name,
        adminId,
        t,
        t,
        v.mode,
        v.max_uses,
        v.max_codes_per_user,
        v.code_pattern,
        v.description,
        v.share_reward_cents,
        v.claim_reward_cents,
        v.relay_required,
        v.deposit_cents,
        v.min_trust_level,
        v.deposit_tiers,
      )
  const note = typeof body.admin_note === 'string' ? body.admin_note.trim().slice(0, LIMITS.adminNote) || null : null
  await c.env.DB.batch([
    createOrReactivate,
    c.env.DB.prepare(
      `UPDATE product_requests SET status = 'approved', product_key = ?, admin_note = ?, resolved_at = ?, resolved_by = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(key, note, t, adminId, req.id),
  ])
  return c.json({ key, reactivated: Boolean(existing) })
})

admin.post('/product-requests/:id/reject', async (c) => {
  const body = await c.req.json<{ note?: unknown }>().catch(() => null)
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, LIMITS.adminNote) || null : null
  const r = await c.env.DB.prepare(
    `UPDATE product_requests SET status = 'rejected', admin_note = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'pending'`,
  )
    .bind(note, now(), c.get('user')!.id, c.req.param('id'))
    .run()
  if (!r.meta.changes) return fail(c, 404, 'not_found', '没有这条待审核的申请')
  return c.json({ ok: true })
})

admin.get('/deposits', async (c) => {
  const status = c.req.query('status') ?? 'all'
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.amount_cents, d.status, d.trade_no, d.claim_id, d.queued, d.relay_code_id IS NOT NULL AS relayed,
            d.refund_due_at, d.error, d.attempts, d.created_at, d.paid_at, d.refunded_at,
            p.name AS product, u.username, u.avatar_url,
            (SELECT COUNT(*) FROM claims y WHERE y.code_id = d.relay_code_id) AS relay_claims
       FROM relay_deposits d JOIN products p ON p.key = d.product_key JOIN users u ON u.id = d.user_id
      WHERE d.status <> 'pending' AND (?1 = 'all' OR d.status = ?1)
      ORDER BY d.created_at DESC LIMIT 500`,
  )
    .bind(status)
    .all()
  return c.json({ deposits: results })
})

admin.post('/deposits/:id/refund', async (c) => {
  if (!ldcConfigured(c.env)) return fail(c, 409, 'ldc_not_configured', '还没设置 LDC 商户凭证')
  const r = await refundDeposit(c.env, c.req.param('id'), ['paid', 'used', 'refund_due', 'refund_failed'])
  if (!r.ok) return fail(c, 409, 'refund_failed', `退款没成功：${r.error}`)
  return c.json({ ok: true })
})

admin.post('/deposits/run', async (c) => {
  return c.json(await runRefunds(c.env))
})

admin.post('/deposits/:id/forfeit', async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE relay_deposits SET status = 'forfeited', updated_at = ? WHERE id = ? AND status IN ('used', 'refund_failed')",
  )
    .bind(now(), c.req.param('id'))
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_forfeitable', '只有已用来领码、还没退的押金能没收')
  return c.json({ ok: true })
})

app.route('/admin', admin)

app.notFound((c) => c.json({ error: 'not_found', message: '没有这个接口' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'server_error', message: '服务器出错了，稍后再试' }, 500)
})

export default {
  fetch: app.fetch,
  // 每 10 分钟：发到期的 LDC 奖励；每天一次：清理过期会话
  async scheduled(e: ScheduledController, env: Env) {
    if (e.cron === '0 19 * * *') {
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run()
    }
    await backfillCodeHashes(env, 500)
    await serveAllQueues(env)
    await runPayouts(env)
    await runRefunds(env)
  },
} satisfies ExportedHandler<Env>
