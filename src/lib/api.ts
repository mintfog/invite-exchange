export type User = {
  id: number
  linuxdo_id: number
  username: string
  name: string | null
  avatar_url: string | null
  trust_level: number
}

export type Limits = { minTrustLevel: number; maxClaimsPerDay: number; maxSharesPerDay: number }

export type Product = {
  key: string
  name: string
  available: number
  claimed: number
  mine_available: number
  i_claimed: number
  last_shared_at: number
}

export type Totals = { available: number | null; claimed: number | null; sharers: number | null }

export type SharedCode = {
  id: string
  product: string
  code: string
  note: string | null
  status: 'available' | 'claimed'
  created_at: number
  claimed_at: number | null
  thanked_at: number | null
  claimer_username: string | null
  claimer_avatar: string | null
}

export type SharedSummary = { available: number | null; claimed: number | null; thanks: number | null }

export type Claim = {
  id: string
  product: string
  code: string
  note: string | null
  claimed_at: number
  thanked_at: number | null
  sharer_username: string
  sharer_avatar: string | null
}

export type NewClaim = { id: string; code: string; note: string | null; claimed_at: number; product: string }

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

export const api = {
  me: () => request<{ user: User | null; limits: Limits }>('/me'),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  products: () => request<{ products: Product[]; totals: Totals }>('/products'),
  share: (body: { product: string; codes: string; note: string }) =>
    request<{ added: number; duplicates: number; product_key: string }>('/codes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  withdraw: (id: string) => request<{ ok: true }>(`/codes/${id}`, { method: 'DELETE' }),
  claim: (product_key: string) =>
    request<{ claim: NewClaim }>('/claim', { method: 'POST', body: JSON.stringify({ product_key }) }),
  thank: (id: string) => request<{ ok: true }>(`/claims/${id}/thanks`, { method: 'POST' }),
  myShared: () => request<{ codes: SharedCode[]; summary: SharedSummary }>('/my/shared'),
  myClaimed: () => request<{ claims: Claim[] }>('/my/claimed'),
}

export const loginUrl = '/api/auth/login'

export function timeAgo(ms: number) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ms).toLocaleDateString('zh-CN')
}
