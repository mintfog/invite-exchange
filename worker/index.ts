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

function fail(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 429, error: string, message: string) {
  return c.json({ error, message }, status)
}

// ---------- 设置 ----------

type Settings = {
  ldc_enabled: boolean
  share_reward_cents: number
  claim_reward_cents: number
  daily_cap_cents: number
  hold_hours: number
}

const SETTING_DEFAULTS: Settings = {
  ldc_enabled: false,
  share_reward_cents: 0,
  claim_reward_cents: 0,
  daily_cap_cents: 0,
  hold_hours: 24,
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
            p.share_reward_cents, p.claim_reward_cents,
            p.code_pattern IS NOT NULL AS has_pattern,
            (SELECT COUNT(*) FROM codes c WHERE c.product_key = p.key AND c.status = 'available') AS available_codes,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM claims x WHERE x.product_key = p.key) AS claimed,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available' AND c.sharer_id = ?1) AS mine_available,
            (SELECT COUNT(*) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn' AND c.sharer_id = ?1) AS mine_codes,
            EXISTS (SELECT 1 FROM claims x WHERE x.product_key = p.key AND x.user_id = ?1) AS i_claimed,
            (SELECT MAX(c.created_at) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS last_shared_at
       FROM products p
      WHERE p.active = 1
      ORDER BY available > 0 DESC, last_shared_at DESC NULLS LAST, p.name
      LIMIT 200`,
  )
    .bind(user?.id ?? -1)
    .all<{ share_reward_cents: number | null; claim_reward_cents: number | null }>()
  const settings = await getSettings(c.env.DB)
  const on = settings.ldc_enabled && ldcConfigured(c.env)
  const products = results.map((p) => ({
    ...p,
    share_reward_cents: on ? (p.share_reward_cents ?? settings.share_reward_cents) : 0,
    claim_reward_cents: on ? (p.claim_reward_cents ?? settings.claim_reward_cents) : 0,
  }))
  const totals = await c.env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c JOIN products p ON p.key = c.product_key
              WHERE c.status = 'available' AND p.active = 1) AS available,
            (SELECT COUNT(*) FROM claims) AS claimed,
            (SELECT COUNT(DISTINCT sharer_id) FROM codes WHERE status <> 'withdrawn') AS sharers,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE status = 'sent') AS rewarded_cents`,
  ).first()
  return c.json({ products, totals })
})

// ---------- 分享 ----------

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

  const res = await c.env.DB.batch(
    codes.map((code) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO codes (id, sharer_id, product_key, code, note, status, created_at, max_uses)
         VALUES (?, ?, ?, ?, ?, 'available', ?, ?)`,
      ).bind(crypto.randomUUID(), user.id, product.key, code, note, t, uses),
    ),
  )
  const added = res.reduce((a, r) => a + (r.meta.changes ?? 0), 0)
  return c.json({ added, duplicates: codes.length - added, product_key: product.key })
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
export async function runPayouts(env: Env, limit = 25) {
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
      WHERE y.status = 'pending' AND y.due_at <= ?
      ORDER BY y.due_at
      LIMIT ?`,
  )
    .bind(t, limit)
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

app.post('/claim', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const minTrust = num(c.env.MIN_TRUST_LEVEL, 1)
  if (user.trust_level < minTrust) {
    return fail(c, 403, 'trust_level', `LinuxDO 信任等级达到 ${minTrust} 级才能领码`)
  }
  const body = await c.req.json<{ product_key?: string }>().catch(() => null)
  const key = body?.product_key ?? ''
  if (!key) return fail(c, 400, 'bad_product', '缺少产品')

  const t = now()
  const maxClaims = num(c.env.MAX_CLAIMS_PER_DAY, 5)

  // 一条语句完成：挑码 → 确认我没领过这个产品 → 确认没超每日上限 → 记一次领取。
  // 挑码时优先给被领得最少的分享者，同样少的随机挑，让每个分享者都能轮到。
  // 码用满时由触发器在同一条语句里标记为 claimed，D1 串行执行写操作，不会超发。
  const row = await c.env.DB.prepare(
    `INSERT INTO claims (id, code_id, product_key, sharer_id, user_id, code, claimed_at)
     SELECT ?1, c.id, c.product_key, c.sharer_id, ?2, c.code, ?3
       FROM codes c JOIN products p ON p.key = c.product_key
      WHERE c.product_key = ?4 AND c.status = 'available' AND c.sharer_id <> ?2 AND p.active = 1
        AND ${REMAINING} > 0
        AND NOT EXISTS (SELECT 1 FROM claims y WHERE y.user_id = ?2 AND y.product_key = ?4 AND y.void_at IS NULL)
        AND (SELECT COUNT(*) FROM claims z WHERE z.user_id = ?2 AND z.claimed_at > ?5) < ?6
      ORDER BY (SELECT COUNT(*) FROM claims s WHERE s.sharer_id = c.sharer_id AND s.product_key = c.product_key),
               random()
      LIMIT 1
     RETURNING id, code_id, code, claimed_at`,
  )
    .bind(crypto.randomUUID(), user.id, t, key, t - DAY, maxClaims)
    .first<{ id: string; code_id: string; code: string; claimed_at: number }>()

  if (row) {
    await recordRewards(c.env.DB, row.id, t)
    const info = await c.env.DB.prepare(
      `SELECT c.note, p.name AS product, p.mode, u.username AS sharer_username
         FROM codes c JOIN products p ON p.key = c.product_key JOIN users u ON u.id = c.sharer_id
        WHERE c.id = ?`,
    )
      .bind(row.code_id)
      .first<{ note: string | null; product: string; mode: Mode; sharer_username: string }>()
    return c.json({
      claim: { id: row.id, code: row.code, claimed_at: row.claimed_at, ...info },
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
            r.status AS report_status
       FROM claims x
       JOIN products p ON p.key = x.product_key
       JOIN codes c ON c.id = x.code_id
       JOIN users u ON u.id = x.sharer_id
       LEFT JOIN reports r ON r.claim_id = x.id
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
            p.active, p.created_at, p.share_reward_cents, p.claim_reward_cents,
            (SELECT COUNT(*) FROM codes c WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS codes,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM codes c
              WHERE c.product_key = p.key AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM claims x WHERE x.product_key = p.key) AS claimed,
            (SELECT COUNT(DISTINCT c.sharer_id) FROM codes c
              WHERE c.product_key = p.key AND c.status <> 'withdrawn') AS sharers
       FROM products p
      ORDER BY p.active DESC, p.created_at DESC`,
  ).all()
  return c.json({ products: results })
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
        share_reward_cents, claim_reward_cents, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
            description = ?, share_reward_cents = ?, claim_reward_cents = ?, active = ?, updated_at = ?
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
    `SELECT r.id, r.code_id, r.claim_id, r.reason, r.status, r.created_at, r.resolved_at,
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
    await db.batch([
      db
        .prepare(
          `UPDATE claims SET void_at = ?1
            WHERE void_at IS NULL
              AND id IN (SELECT claim_id FROM reports WHERE code_id = ?2 AND status = 'open')`,
        )
        .bind(t, report.code_id),
      db
        .prepare(
          "UPDATE reports SET status = 'confirmed', resolved_at = ?, resolved_by = ? WHERE code_id = ? AND status = 'open'",
        )
        .bind(t, by, report.code_id),
      db
        .prepare(
          "UPDATE codes SET status = 'withdrawn', code = NULL, invalid_at = ? WHERE id = ? AND status <> 'withdrawn'",
        )
        .bind(t, report.code_id),
      db
        .prepare(
          "UPDATE payouts SET status = 'canceled', updated_at = ? WHERE code_id = ? AND status IN ('pending', 'held', 'failed')",
        )
        .bind(t, report.code_id),
    ])
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
  const entries: [string, string][] = [
    ['ldc_enabled', next.ldc_enabled ? '1' : '0'],
    ['share_reward_cents', String(next.share_reward_cents)],
    ['claim_reward_cents', String(next.claim_reward_cents)],
    ['daily_cap_cents', String(next.daily_cap_cents)],
    ['hold_hours', String(next.hold_hours)],
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
            (SELECT COUNT(*) FROM claims x WHERE x.user_id = u.id) AS received
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
    await runPayouts(env)
  },
} satisfies ExportedHandler<Env>
