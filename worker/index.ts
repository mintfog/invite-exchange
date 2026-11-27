import { DurableObject } from 'cloudflare:workers'
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
}

type User = {
  id: number
  linuxdo_id: number
  username: string
  name: string | null
  avatar_url: string | null
  trust_level: number
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

function isSecure(c: Context<AppEnv>) {
  return new URL(c.req.url).protocol === 'https:'
}

function fail(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 429, error: string, message: string) {
  return c.json({ error, message }, status)
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
      .first<User>()
    if (row) c.set('user', row)
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
    limits: {
      minTrustLevel: num(c.env.MIN_TRUST_LEVEL, 1),
      maxClaimsPerDay: num(c.env.MAX_CLAIMS_PER_DAY, 5),
      maxSharesPerDay: num(c.env.MAX_SHARES_PER_DAY, 30),
    },
  })
})

// ---------- 广场 ----------

app.get('/products', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT p.key, p.name,
            SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END) AS available,
            SUM(CASE WHEN c.status = 'claimed'   THEN 1 ELSE 0 END) AS claimed,
            SUM(CASE WHEN c.status = 'available' AND c.sharer_id = ?1 THEN 1 ELSE 0 END) AS mine_available,
            MAX(CASE WHEN c.claimed_by = ?1 THEN 1 ELSE 0 END) AS i_claimed,
            MAX(c.created_at) AS last_shared_at
       FROM products p JOIN codes c ON c.product_key = p.key AND c.status <> 'withdrawn'
      GROUP BY p.key
      ORDER BY available > 0 DESC, last_shared_at DESC
      LIMIT 200`,
  )
    .bind(user?.id ?? -1)
    .all()
  const totals = await c.env.DB.prepare(
    `SELECT SUM(status = 'available') AS available, SUM(status = 'claimed') AS claimed,
            COUNT(DISTINCT sharer_id) AS sharers
       FROM codes WHERE status <> 'withdrawn'`,
  ).first()
  return c.json({ products: results, totals })
})

// ---------- 分享 ----------

app.post('/codes', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const body = await c.req.json<{ product?: string; codes?: string; note?: string }>().catch(() => null)
  const product = (body?.product ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  const note = (body?.note ?? '').trim().slice(0, LIMITS.note) || null
  const codes = [
    ...new Set(
      (body?.codes ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  if (!product || product.length > LIMITS.productName) {
    return fail(c, 400, 'bad_product', `产品名需要 1 到 ${LIMITS.productName} 个字`)
  }
  if (codes.length === 0) return fail(c, 400, 'no_codes', '至少填一个邀请码')
  if (codes.length > LIMITS.codesPerPost) {
    return fail(c, 400, 'too_many', `一次最多 ${LIMITS.codesPerPost} 个`)
  }
  if (codes.some((x) => x.length > LIMITS.code)) {
    return fail(c, 400, 'code_too_long', `单个邀请码不超过 ${LIMITS.code} 个字符`)
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

  const key = productKey(product)
  const stmts = [
    c.env.DB.prepare('INSERT OR IGNORE INTO products (key, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(
      key,
      product,
      user.id,
      t,
    ),
    ...codes.map((code) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO codes (id, sharer_id, product_key, code, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'available', ?)`,
      ).bind(crypto.randomUUID(), user.id, key, code, note, t),
    ),
  ]
  const res = await c.env.DB.batch(stmts)
  const added = res.slice(1).reduce((a, r) => a + (r.meta.changes ?? 0), 0)
  return c.json({ added, duplicates: codes.length - added, product_key: key })
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
  if (!r.meta.changes) return fail(c, 409, 'not_withdrawable', '这个码已被领走或不存在')
  return c.json({ ok: true })
})

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

  // D1 对写操作串行执行，这一条 UPDATE 内部同时完成：
  //   挑一个可用的码 → 确认还没人领 → 确认我没领过这个产品 → 确认没超每日上限 → 标记为我领走
  // 两个人同时点，只有一个人能拿到同一个码。
  const row = await c.env.DB.prepare(
    `UPDATE codes
        SET status = 'claimed', claimed_by = ?1, claimed_at = ?2
      WHERE id = (SELECT id FROM codes
                   WHERE product_key = ?3 AND status = 'available' AND sharer_id <> ?1
                   ORDER BY created_at ASC, random()
                   LIMIT 1)
        AND status = 'available'
        AND NOT EXISTS (SELECT 1 FROM codes WHERE claimed_by = ?1 AND product_key = ?3)
        AND (SELECT COUNT(*) FROM codes WHERE claimed_by = ?1 AND claimed_at > ?4) < ?5
      RETURNING id, code, note, claimed_at`,
  )
    .bind(user.id, t, key, t - DAY, maxClaims)
    .first<{ id: string; code: string; note: string | null; claimed_at: number }>()

  if (row) {
    const p = await c.env.DB.prepare('SELECT name FROM products WHERE key = ?').bind(key).first<{ name: string }>()
    return c.json({ claim: { ...row, product: p?.name ?? key } })
  }

  // 没领到：查清原因告诉用户
  const already = await c.env.DB.prepare('SELECT 1 FROM codes WHERE claimed_by = ? AND product_key = ?')
    .bind(user.id, key)
    .first()
  if (already) return fail(c, 409, 'already_claimed', '这个产品你已经领过一个了')
  const today = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE claimed_by = ? AND claimed_at > ?')
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
    'UPDATE codes SET thanked_at = ? WHERE id = ? AND claimed_by = ? AND thanked_at IS NULL',
  )
    .bind(now(), c.req.param('id'), user.id)
    .run()
  if (!r.meta.changes) return fail(c, 409, 'not_thankable', '已经感谢过了')
  return c.json({ ok: true })
})

// ---------- 我的 ----------

app.get('/my/shared', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, p.name AS product, c.code, c.note, c.status, c.created_at, c.claimed_at, c.thanked_at,
            u.username AS claimer_username, u.avatar_url AS claimer_avatar
       FROM codes c
       JOIN products p ON p.key = c.product_key
       LEFT JOIN users u ON u.id = c.claimed_by
      WHERE c.sharer_id = ? AND c.status <> 'withdrawn'
      ORDER BY c.created_at DESC
      LIMIT 500`,
  )
    .bind(user.id)
    .all()
  const summary = await c.env.DB.prepare(
    `SELECT SUM(status = 'available') AS available, SUM(status = 'claimed') AS claimed,
            SUM(thanked_at IS NOT NULL) AS thanks
       FROM codes WHERE sharer_id = ? AND status <> 'withdrawn'`,
  )
    .bind(user.id)
    .first()
  return c.json({ codes: results, summary })
})

app.get('/my/claimed', async (c) => {
  const user = requireUser(c)
  if (!user) return fail(c, 401, 'login_required', '请先登录')
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, p.name AS product, c.code, c.note, c.claimed_at, c.thanked_at,
            u.username AS sharer_username, u.avatar_url AS sharer_avatar
       FROM codes c
       JOIN products p ON p.key = c.product_key
       JOIN users u ON u.id = c.sharer_id
      WHERE c.claimed_by = ?
      ORDER BY c.claimed_at DESC
      LIMIT 500`,
  )
    .bind(user.id)
    .all()
  return c.json({ claims: results })
})

app.notFound((c) => c.json({ error: 'not_found', message: '没有这个接口' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'server_error', message: '服务器出错了，稍后再试' }, 500)
})

export class RelayDatabase extends DurableObject<Env> {}

export default {
  fetch: app.fetch,
  // 每天清理过期会话
  async scheduled(_e: ScheduledController, env: Env) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run()
  },
} satisfies ExportedHandler<Env>
