export type User = {
  id: number
  linuxdo_id: number
  username: string
  name: string | null
  avatar_url: string | null
  trust_level: number
  is_admin: boolean
}

export type Limits = { minTrustLevel: number; maxClaimsPerDay: number; maxSharesPerDay: number }

export type Mode = 'single' | 'multi'

export type Product = {
  key: string
  name: string
  mode: Mode
  max_uses: number
  max_codes_per_user: number | null
  description: string | null
  has_pattern: number
  share_reward_cents: number
  claim_reward_cents: number
  available_codes: number
  available: number
  claimed: number
  mine_available: number
  mine_codes: number
  i_claimed: number
  last_shared_at: number | null
}

export type Totals = {
  available: number | null
  claimed: number | null
  sharers: number | null
  rewarded_cents: number | null
}

export type SharedCode = {
  id: string
  product_key: string
  product: string
  mode: Mode
  code: string
  note: string | null
  status: 'available' | 'claimed'
  created_at: number
  max_uses: number
  product_max_uses: number
  used: number
  thanks: number
  reports_open: number
}

export type Claimer = {
  id: string
  code_id: string
  claimed_at: number
  thanked_at: number | null
  username: string
  avatar_url: string | null
}

export type SharedSummary = {
  available: number | null
  claimed: number | null
  thanks: number | null
  rewarded_cents: number | null
  pending_cents: number | null
}

export type PayoutStatus = 'pending' | 'held' | 'sending' | 'sent' | 'failed' | 'canceled'

export type MyPayout = {
  id: string
  kind: 'share' | 'claim'
  code_id: string
  product: string
  amount_cents: number
  status: PayoutStatus
  due_at: number
  created_at: number
  sent_at: number | null
}

export type Claim = {
  id: string
  product_key: string
  product: string
  mode: Mode
  code: string
  note: string | null
  claimed_at: number
  thanked_at: number | null
  void_at: number | null
  report_status: 'open' | 'confirmed' | 'dismissed' | null
  sharer_username: string
  sharer_avatar: string | null
}

export type NewClaim = {
  id: string
  code: string
  note: string | null
  claimed_at: number
  product: string
  mode: Mode
  sharer_username: string
}

// ----- 管理员 -----

export type AdminProduct = {
  key: string
  name: string
  mode: Mode
  max_uses: number
  max_codes_per_user: number | null
  code_pattern: string | null
  description: string | null
  active: number
  created_at: number
  share_reward_cents: number | null
  claim_reward_cents: number | null
  codes: number
  available: number
  claimed: number
  sharers: number
}

export type ProductInput = {
  name: string
  mode: Mode
  max_uses?: number
  max_codes_per_user?: number | null
  code_pattern?: string | null
  description?: string | null
  share_reward_cents?: number | null
  claim_reward_cents?: number | null
  active?: boolean
}

export type AdminCode = SharedCode & { sharer_username: string; sharer_avatar: string | null }

export type AdminUser = {
  id: number
  username: string
  name: string | null
  avatar_url: string | null
  trust_level: number
  created_at: number
  last_login_at: number
  codes: number
  given: number
  received: number
  is_admin: boolean
  is_test: boolean
}

export type Report = {
  id: string
  code_id: string
  claim_id: string
  reason: string | null
  status: 'open' | 'confirmed' | 'dismissed'
  created_at: number
  resolved_at: number | null
  product: string
  mode: Mode
  code: string
  code_status: string
  reporter_username: string
  reporter_avatar: string | null
  sharer_username: string
  sharer_avatar: string | null
  used: number
  reports_on_code: number
  held_cents: number
}

export type Settings = {
  ldc_enabled: boolean
  share_reward_cents: number
  claim_reward_cents: number
  daily_cap_cents: number
  hold_hours: number
}

export type PayoutStats = {
  sent_24h_cents: number
  sent_total_cents: number
  pending: number
  held: number
  failed: number
}

export type AdminPayout = {
  id: string
  kind: 'share' | 'claim'
  code_id: string
  amount_cents: number
  status: PayoutStatus
  due_at: number
  trade_no: string | null
  error: string | null
  attempts: number
  created_at: number
  sent_at: number | null
  product: string
  sharer_username: string
  sharer_avatar: string | null
}

export type RunResult = { configured: boolean; enabled: boolean; sent: number; failed: number; waiting: number }

export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'unknown', data.message ?? '请求失败，稍后再试')
  }
  return data as T
}

const post = <T>(path: string, body?: unknown, method = 'POST') =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  me: () => request<{ user: User | null; limits: Limits; test_login: boolean }>('/me'),
  testLogin: (password: string, account: 'admin' | 'user') =>
    post<{ ok: true }>('/auth/test-login', { password, account }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  products: () => request<{ products: Product[]; totals: Totals }>('/products'),
  share: (body: { product_key: string; codes: string; note: string; uses?: number }) =>
    post<{ added: number; duplicates: number; product_key: string }>('/codes', body),
  withdraw: (id: string) => post<{ ok: true }>(`/codes/${id}`, undefined, 'DELETE'),
  setRemaining: (id: string, remaining: number) =>
    post<{ ok: true; remaining: number }>(`/codes/${id}`, { remaining }, 'PATCH'),
  claim: (product_key: string) => post<{ claim: NewClaim }>('/claim', { product_key }),
  thank: (id: string) => post<{ ok: true }>(`/claims/${id}/thanks`),
  report: (id: string, reason: string) => post<{ ok: true }>(`/claims/${id}/report`, { reason }),
  myShared: () =>
    request<{ codes: SharedCode[]; claimers: Claimer[]; summary: SharedSummary; payouts: MyPayout[] }>('/my/shared'),
  myClaimed: () => request<{ claims: Claim[] }>('/my/claimed'),

  admin: {
    products: () => request<{ products: AdminProduct[] }>('/admin/products'),
    createProduct: (b: ProductInput) => post<{ key: string }>('/admin/products', b),
    updateProduct: (key: string, b: Partial<ProductInput>) =>
      post<{ ok: true }>(`/admin/products/${encodeURIComponent(key)}`, b, 'PATCH'),
    codes: (product = '', q = '') =>
      request<{ codes: AdminCode[] }>(
        `/admin/codes?product=${encodeURIComponent(product)}&q=${encodeURIComponent(q)}`,
      ),
    removeCode: (id: string) => post<{ ok: true }>(`/admin/codes/${id}`, undefined, 'DELETE'),
    users: () => request<{ users: AdminUser[] }>('/admin/users'),
    reports: (status = 'open') => request<{ reports: Report[] }>(`/admin/reports?status=${status}`),
    resolveReport: (id: string, action: 'confirm' | 'dismiss') =>
      post<{ ok: true }>(`/admin/reports/${id}/resolve`, { action }),
    settings: () => request<{ settings: Settings; ldc_configured: boolean; stats: PayoutStats }>('/admin/settings'),
    saveSettings: (s: Partial<Settings>) => post<{ settings: Settings }>('/admin/settings', s, 'PUT'),
    payouts: (status = 'all') =>
      request<{ payouts: AdminPayout[]; stats: PayoutStats }>(`/admin/payouts?status=${status}`),
    runPayouts: () => post<RunResult>('/admin/payouts/run'),
    retryPayout: (id: string) => post<{ ok: true }>(`/admin/payouts/${id}/retry`),
    cancelPayout: (id: string) => post<{ ok: true }>(`/admin/payouts/${id}/cancel`),
  },
}

export const loginUrl = '/api/auth/login'

export function timeAgo(ms: number | null | undefined) {
  if (!ms) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 0) return timeUntil(ms)
  if (s < 60) return '刚刚'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

export function timeUntil(ms: number) {
  const s = Math.round((ms - Date.now()) / 1000)
  if (s <= 60) return '马上'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟后`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} 小时后`
  return `${Math.round(h / 24)} 天后`
}

/** 分 → 「1.5」这样的 LDC 数字 */
export function ldc(cents: number | null | undefined) {
  return String(Number(((cents ?? 0) / 100).toFixed(2)))
}

/** 「1.5」→ 150；不合法返回 null */
export function parseLdc(s: string) {
  const t = s.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

export const PAYOUT_STATUS: Record<PayoutStatus, string> = {
  pending: '待发放',
  held: '有反馈，暂扣',
  sending: '发送中',
  sent: '已到账',
  failed: '发送失败',
  canceled: '已取消',
}
