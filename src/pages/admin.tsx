import { useCallback, useEffect, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import {
  api,
  ApiError,
  ldc,
  parseLdc,
  PAYOUT_STATUS,
  timeAgo,
  timeUntil,
  type AdminCode,
  type AdminPayout,
  type AdminProduct,
  type AdminUser,
  type Mode,
  type PayoutStats,
  type Report,
  type Settings,
} from '@/lib/api'

const errMsg = (e: unknown, d: string) => (e instanceof ApiError ? e.message : d)

export function AdminPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [openReports, setOpenReports] = useState(0)
  useEffect(() => {
    api.admin
      .reports('open')
      .then((r) => setOpenReports(r.reports.length))
      .catch(() => {})
  }, [version])

  return (
    <Tabs defaultValue={openReports ? 'reports' : 'products'} key={openReports ? 'r' : 'p'} className="gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">管理员</h1>
        <p className="text-sm text-muted-foreground">管理产品、查看所有人分享的码、处理无效反馈、设置 LDC 奖励。</p>
      </div>
      <TabsList className="flex-wrap">
        <TabsTrigger value="reports">
          无效反馈
          {openReports ? <Badge variant="destructive">{openReports}</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="products">产品</TabsTrigger>
        <TabsTrigger value="codes">邀请码</TabsTrigger>
        <TabsTrigger value="users">用户</TabsTrigger>
        <TabsTrigger value="ldc">LDC 奖励</TabsTrigger>
      </TabsList>
      <TabsContent value="reports">
        <ReportsPanel version={version} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="products">
        <ProductsPanel version={version} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="codes">
        <CodesPanel version={version} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="users">
        <UsersPanel version={version} />
      </TabsContent>
      <TabsContent value="ldc">
        <LdcPanel version={version} onChanged={onChanged} />
      </TabsContent>
    </Tabs>
  )
}

function UserCell({ name, avatar }: { name: string; avatar: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-6">
        {avatar ? <AvatarImage src={avatar} /> : null}
        <AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="text-sm">{name}</span>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

function Filter<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <Button key={v} size="sm" variant={v === value ? 'default' : 'outline'} onClick={() => onChange(v)}>
          {label}
        </Button>
      ))}
    </div>
  )
}

// ---------- 无效反馈 ----------

function ReportsPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [status, setStatus] = useState<'open' | 'all'>('open')
  const [reports, setReports] = useState<Report[] | null>(null)

  useEffect(() => {
    setReports(null)
    api.admin
      .reports(status)
      .then((r) => setReports(r.reports))
      .catch(() => setReports([]))
  }, [status, version])

  const resolve = async (r: Report, action: 'confirm' | 'dismiss') => {
    try {
      await api.admin.resolveReport(r.id, action)
      toast(action === 'confirm' ? '已确认无效：码已撤下，奖励已取消' : '已驳回，扣下的奖励恢复发放')
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '处理失败'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>无效反馈</CardTitle>
        <CardDescription>
          领取人说码用不了时会出现在这里，这个码还没发的 LDC 会先扣下。确认无效会撤下这个码、取消它的奖励，反馈人可以再领一个；码没问题就驳回，奖励照常发。
        </CardDescription>
        <CardAction>
          <Filter value={status} onChange={setStatus} options={[['open', '待处理'], ['all', '全部']]} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {reports === null ? (
          <Skeleton className="h-32" />
        ) : reports.length === 0 ? (
          <Empty text={status === 'open' ? '没有待处理的反馈。' : '还没有人反馈过。'} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>产品 / 码</TableHead>
                <TableHead>反馈人</TableHead>
                <TableHead>分享者</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>情况</TableHead>
                <TableHead className="text-right">处理</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{r.product}</span>
                      <code className="max-w-40 truncate font-mono text-xs">{r.code}</code>
                    </div>
                  </TableCell>
                  <TableCell>
                    <UserCell name={r.reporter_username} avatar={r.reporter_avatar} />
                    <span className="text-xs text-muted-foreground">{timeAgo(r.created_at)}</span>
                  </TableCell>
                  <TableCell>
                    <UserCell name={r.sharer_username} avatar={r.sharer_avatar} />
                  </TableCell>
                  <TableCell className="max-w-48 text-sm whitespace-normal">{r.reason || '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div>已被用 {r.used} 次</div>
                    <div>共 {r.reports_on_code} 条反馈</div>
                    {r.held_cents ? <div>暂扣 {ldc(r.held_cents)} LDC</div> : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.status === 'open' ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => resolve(r, 'dismiss')}>
                          码没问题
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => resolve(r, 'confirm')}>
                          确认无效
                        </Button>
                      </div>
                    ) : (
                      <Badge variant={r.status === 'confirmed' ? 'destructive' : 'secondary'}>
                        {r.status === 'confirmed' ? '已确认无效' : '已驳回'}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 产品 ----------

type ProductForm = {
  key: string | null
  name: string
  mode: Mode
  max_uses: string
  max_codes_per_user: string
  code_pattern: string
  description: string
  share_reward: string
  claim_reward: string
  locked: boolean
}

const EMPTY_FORM: ProductForm = {
  key: null,
  name: '',
  mode: 'single',
  max_uses: '30',
  max_codes_per_user: '',
  code_pattern: '',
  description: '',
  share_reward: '',
  claim_reward: '',
  locked: false,
}

function ProductsPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [products, setProducts] = useState<AdminProduct[] | null>(null)
  const [form, setForm] = useState<ProductForm | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.admin
      .products()
      .then((r) => setProducts(r.products))
      .catch(() => setProducts([]))
  }, [version])

  const edit = (p: AdminProduct) =>
    setForm({
      key: p.key,
      name: p.name,
      mode: p.mode,
      max_uses: String(p.max_uses),
      max_codes_per_user: p.max_codes_per_user === null ? '' : String(p.max_codes_per_user),
      code_pattern: p.code_pattern ?? '',
      description: p.description ?? '',
      share_reward: p.share_reward_cents === null ? '' : ldc(p.share_reward_cents),
      claim_reward: p.claim_reward_cents === null ? '' : ldc(p.claim_reward_cents),
      locked: p.codes > 0,
    })

  const set = (patch: Partial<ProductForm>) => setForm((f) => (f ? { ...f, ...patch } : f))

  const save = async () => {
    if (!form) return
    const reward = (s: string) => (s.trim() === '' ? null : parseLdc(s))
    const share = reward(form.share_reward)
    const claim = reward(form.claim_reward)
    if (share === undefined || (form.share_reward.trim() && share === null)) return toast.error('贡献奖励金额不对')
    if (form.claim_reward.trim() && claim === null) return toast.error('领取奖励金额不对')
    const body = {
      name: form.name,
      mode: form.mode,
      max_uses: form.mode === 'multi' ? Number(form.max_uses) : undefined,
      max_codes_per_user: form.mode === 'single' && form.max_codes_per_user.trim() ? Number(form.max_codes_per_user) : null,
      code_pattern: form.code_pattern.trim() || null,
      description: form.description.trim() || null,
      share_reward_cents: share,
      claim_reward_cents: claim,
    }
    setBusy(true)
    try {
      if (form.key) await api.admin.updateProduct(form.key, body)
      else await api.admin.createProduct(body)
      toast(form.key ? '已保存' : `已添加 ${form.name}`)
      setForm(null)
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '没保存成功'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: AdminProduct) => {
    try {
      await api.admin.updateProduct(p.key, { active: !p.active })
      toast(p.active ? `${p.name} 已下架` : `${p.name} 已上架`)
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '操作失败'))
    }
  }

  const rewardText = (c: number | null) => (c === null ? '跟随全站' : `${ldc(c)} LDC`)

  return (
    <Card>
      <CardHeader>
        <CardTitle>产品</CardTitle>
        <CardDescription>广场上的产品只能在这里添加。用户分享时只能从这些产品里选。</CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })}>
            <Plus />
            新建产品
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {products === null ? (
          <Skeleton className="h-32" />
        ) : products.length === 0 ? (
          <Empty text="还没有产品，点右上角新建。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>产品</TableHead>
                <TableHead>模式</TableHead>
                <TableHead>码 / 剩余 / 已领</TableHead>
                <TableHead>奖励（贡献 / 领取）</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.key}>
                  <TableCell>
                    <div className="flex items-center gap-2 font-medium">
                      {p.name}
                      {p.active ? null : <Badge variant="secondary">已下架</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground">{p.sharers} 位分享者</span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.mode === 'multi'
                      ? `多人可用 · 每码 ${p.max_uses} 次`
                      : `一次性 · ${p.max_codes_per_user === null ? '每人不限' : `每人 ${p.max_codes_per_user} 个`}`}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {p.codes} / {p.available} / {p.claimed}
                  </TableCell>
                  <TableCell className="text-sm">
                    {rewardText(p.share_reward_cents)} / {rewardText(p.claim_reward_cents)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => edit(p)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(p)}>
                      {p.active ? '下架' : '上架'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90svh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form?.key ? `编辑 ${form.name}` : '新建产品'}</DialogTitle>
            <DialogDescription>选好这个产品的邀请码是怎么用的，系统会按模式分发。</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-name">名字</Label>
                <Input id="p-name" value={form.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="flex flex-col gap-2">
                <Label>模式</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={form.mode === 'single' ? 'default' : 'outline'}
                    disabled={form.locked}
                    onClick={() => set({ mode: 'single' })}
                  >
                    一次性码
                  </Button>
                  <Button
                    type="button"
                    variant={form.mode === 'multi' ? 'default' : 'outline'}
                    disabled={form.locked}
                    onClick={() => set({ mode: 'multi' })}
                  >
                    多人可用码
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {form.mode === 'single'
                    ? '每个码只发给一个人，一个人可以分享好几个（比如 ChatterFly 每人 3 个）。'
                    : '每人只有一个码，可以给很多人用，系统显示剩余次数并轮流发（比如 Muse 一个码 30 人）。'}
                  {form.locked ? ' 已经有人分享了码，模式不能再改。' : ''}
                </p>
              </div>
              {form.mode === 'multi' ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="p-uses">每个码最多几人用</Label>
                  <Input
                    id="p-uses"
                    type="number"
                    min={1}
                    max={1000}
                    value={form.max_uses}
                    onChange={(e) => set({ max_uses: e.target.value })}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="p-per">每人最多分享几个码</Label>
                  <Input
                    id="p-per"
                    type="number"
                    min={1}
                    placeholder="留空表示不限"
                    value={form.max_codes_per_user}
                    onChange={(e) => set({ max_codes_per_user: e.target.value })}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-pattern">邀请码格式（可选，正则）</Label>
                <Input
                  id="p-pattern"
                  className="font-mono"
                  placeholder="比如 CF-[A-Z0-9]{8}，不符合的码放不进来"
                  value={form.code_pattern}
                  onChange={(e) => set({ code_pattern: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-desc">说明（可选）</Label>
                <Textarea
                  id="p-desc"
                  maxLength={200}
                  placeholder="显示在广场卡片上，比如：注册后填邀请码，双方都加 TOKEN"
                  value={form.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="p-share">贡献奖励 LDC</Label>
                  <Input
                    id="p-share"
                    inputMode="decimal"
                    placeholder="留空跟随全站"
                    value={form.share_reward}
                    onChange={(e) => set({ share_reward: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="p-claim">领取奖励 LDC</Label>
                  <Input
                    id="p-claim"
                    inputMode="decimal"
                    placeholder="留空跟随全站"
                    value={form.claim_reward}
                    onChange={(e) => set({ claim_reward: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button onClick={save} disabled={busy || !form?.name.trim()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ---------- 邀请码 ----------

function CodesPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [product, setProduct] = useState('')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [codes, setCodes] = useState<AdminCode[] | null>(null)

  useEffect(() => {
    api.admin
      .products()
      .then((r) => setProducts(r.products))
      .catch(() => {})
  }, [version])

  useEffect(() => {
    setCodes(null)
    api.admin
      .codes(product, query)
      .then((r) => setCodes(r.codes))
      .catch(() => setCodes([]))
  }, [product, query, version])

  const remove = async (c: AdminCode) => {
    try {
      await api.admin.removeCode(c.id)
      toast('已撤下这个码，没发的奖励一起取消')
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '撤下失败'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>所有人分享的邀请码</CardTitle>
        <CardDescription>可以按产品筛选，按用户名或码搜索。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Filter
          value={product}
          onChange={setProduct}
          options={[['', '全部'], ...products.map((p) => [p.key, p.name] as [string, string])]}
        />
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(q)
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="用户名或邀请码，回车搜索" className="pl-9" />
        </form>
        {codes === null ? (
          <Skeleton className="h-32" />
        ) : codes.length === 0 ? (
          <Empty text="没有找到码。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>产品</TableHead>
                <TableHead>邀请码</TableHead>
                <TableHead>分享者</TableHead>
                <TableHead>使用</TableHead>
                <TableHead>分享时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1">
                      {c.product}
                      {c.reports_open ? <Badge variant="destructive">{c.reports_open} 条反馈</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    <UserCell name={c.sharer_username} avatar={c.sharer_avatar} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'available' ? 'outline' : 'secondary'}>
                      {c.mode === 'multi'
                        ? `已用 ${c.used} / 共 ${c.max_uses}`
                        : c.status === 'available'
                          ? '在池中'
                          : '已领走'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(c.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                      撤下
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 用户 ----------

function UsersPanel({ version }: { version: number }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  useEffect(() => {
    api.admin
      .users()
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]))
  }, [version])

  return (
    <Card>
      <CardHeader>
        <CardTitle>已注册用户</CardTitle>
        <CardDescription>按最近登录排序。分享 = 还在的码，送出 / 领到 = 领取次数。</CardDescription>
      </CardHeader>
      <CardContent>
        {users === null ? (
          <Skeleton className="h-32" />
        ) : users.length === 0 ? (
          <Empty text="还没有用户。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>信任等级</TableHead>
                <TableHead>分享</TableHead>
                <TableHead>送出</TableHead>
                <TableHead>领到</TableHead>
                <TableHead>最近登录</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <UserCell name={u.username} avatar={u.avatar_url} />
                      {u.is_admin ? <Badge>管理员</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{u.trust_level}</TableCell>
                  <TableCell className="tabular-nums">{u.codes}</TableCell>
                  <TableCell className="tabular-nums">{u.given}</TableCell>
                  <TableCell className="tabular-nums">{u.received}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(u.last_login_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- LDC ----------

type SettingsForm = { enabled: boolean; share: string; claim: string; cap: string; hold: string }

function LdcPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [stats, setStats] = useState<PayoutStats | null>(null)
  const [status, setStatus] = useState<'all' | 'pending' | 'held' | 'failed' | 'sent'>('all')
  const [payouts, setPayouts] = useState<AdminPayout[] | null>(null)
  const [busy, setBusy] = useState(false)

  const fromSettings = (s: Settings): SettingsForm => ({
    enabled: s.ldc_enabled,
    share: ldc(s.share_reward_cents),
    claim: ldc(s.claim_reward_cents),
    cap: ldc(s.daily_cap_cents),
    hold: String(s.hold_hours),
  })

  useEffect(() => {
    api.admin
      .settings()
      .then((r) => {
        setConfigured(r.ldc_configured)
        setForm(fromSettings(r.settings))
        setStats(r.stats)
      })
      .catch(() => setConfigured(false))
  }, [version])

  const loadPayouts = useCallback(() => {
    api.admin
      .payouts(status)
      .then((r) => {
        setPayouts(r.payouts)
        setStats(r.stats)
      })
      .catch(() => setPayouts([]))
  }, [status])

  useEffect(() => {
    setPayouts(null)
    loadPayouts()
  }, [loadPayouts, version])

  const save = async (patch?: Partial<SettingsForm>) => {
    if (!form) return
    const f = { ...form, ...patch }
    const share = parseLdc(f.share)
    const claim = parseLdc(f.claim)
    const cap = parseLdc(f.cap)
    const hold = Number(f.hold)
    if (share === null || claim === null || cap === null) return toast.error('金额要是不小于 0 的数字，最多两位小数')
    if (!Number.isInteger(hold) || hold < 0 || hold > 720) return toast.error('观察期要是 0 到 720 的整数小时')
    setBusy(true)
    try {
      const r = await api.admin.saveSettings({
        ldc_enabled: f.enabled,
        share_reward_cents: share,
        claim_reward_cents: claim,
        daily_cap_cents: cap,
        hold_hours: hold,
      })
      setForm(fromSettings(r.settings))
      toast(patch?.enabled === undefined ? '设置已保存' : f.enabled ? 'LDC 奖励已开启' : 'LDC 奖励已关闭')
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '没保存成功'))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    try {
      const r = await api.admin.runPayouts()
      if (!r.configured) toast.error('还没设置 LDC 商户凭证')
      else if (!r.enabled) toast.error('LDC 奖励没开启')
      else toast(`发出 ${r.sent} 笔，失败 ${r.failed} 笔${r.waiting ? `，${r.waiting} 笔超过每日上限暂缓` : ''}`)
      loadPayouts()
    } catch (e) {
      toast.error(errMsg(e, '发放失败'))
    }
  }

  const act = async (p: AdminPayout, kind: 'retry' | 'cancel') => {
    try {
      if (kind === 'retry') await api.admin.retryPayout(p.id)
      else await api.admin.cancelPayout(p.id)
      toast(kind === 'retry' ? '已放回待发，下次发放时会再试' : '已取消这笔奖励')
      loadPayouts()
    } catch (e) {
      toast.error(errMsg(e, '操作失败'))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {configured === false ? (
        <Alert>
          <AlertTitle>还没接上 LINUX DO Credit</AlertTitle>
          <AlertDescription>
            <p>在 LINUX DO Credit 创建商户应用后，在项目目录运行下面两条命令填入凭证，奖励才会真正发出：</p>
            <code className="mt-1 block rounded-md bg-muted px-2 py-1 font-mono text-xs">
              npx wrangler secret put LDC_CLIENT_ID
              <br />
              npx wrangler secret put LDC_CLIENT_SECRET
            </code>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>奖励设置</CardTitle>
          <CardDescription>
            LDC 从你的 LINUX DO Credit 商户账户打给分享者。领取后先过观察期，期间没人反馈无效才发；全站 24 小时发放总额不超过上限。
          </CardDescription>
          <CardAction>
            {form ? (
              <Button
                size="sm"
                variant={form.enabled ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => save({ enabled: !form.enabled })}
              >
                {form.enabled ? '关闭奖励' : '开启奖励'}
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          {!form ? (
            <Skeleton className="h-32" />
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <div className="flex items-center gap-2 text-sm">
                现在：
                <Badge variant={form.enabled ? 'default' : 'secondary'}>{form.enabled ? '已开启' : '已关闭'}</Badge>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="s-share"
                  label="贡献奖励（LDC）"
                  hint="每个分享的码第一次被领、过了观察期，给分享者发一次"
                  value={form.share}
                  onChange={(v) => setForm({ ...form, share: v })}
                />
                <Field
                  id="s-claim"
                  label="领取奖励（LDC）"
                  hint="码每被领取一次，给分享者发一次；0 = 不发"
                  value={form.claim}
                  onChange={(v) => setForm({ ...form, claim: v })}
                />
                <Field
                  id="s-cap"
                  label="全站 24 小时上限（LDC）"
                  hint="超过的先不发，第二天补发；0 = 暂停发放"
                  value={form.cap}
                  onChange={(v) => setForm({ ...form, cap: v })}
                />
                <Field
                  id="s-hold"
                  label="观察期（小时）"
                  hint="领取后等多久再发，给领取人反馈无效的时间"
                  value={form.hold}
                  onChange={(v) => setForm({ ...form, hold: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">单个产品可以在「产品 → 编辑」里设自己的金额。</p>
              <div>
                <Button type="submit" disabled={busy}>
                  保存设置
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>发放记录</CardTitle>
          <CardDescription>
            {stats
              ? `24 小时内已发 ${ldc(stats.sent_24h_cents)} LDC，累计 ${ldc(stats.sent_total_cents)} LDC。待发 ${stats.pending} 笔，暂扣 ${stats.held} 笔，失败 ${stats.failed} 笔。系统每 10 分钟自动发一次到期的奖励。`
              : '加载中…'}
          </CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" onClick={run}>
              立即发放到期的
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Filter
            value={status}
            onChange={setStatus}
            options={[
              ['all', '全部'],
              ['pending', '待发放'],
              ['held', '暂扣'],
              ['failed', '失败'],
              ['sent', '已到账'],
            ]}
          />
          {payouts === null ? (
            <Skeleton className="h-32" />
          ) : payouts.length === 0 ? (
            <Empty text="没有记录。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>分享者</TableHead>
                  <TableHead>产品 / 类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <UserCell name={p.sharer_username} avatar={p.sharer_avatar} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{p.product}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.kind === 'share' ? '贡献奖励' : '领取奖励'} · {timeAgo(p.created_at)}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{ldc(p.amount_cents)} LDC</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      <Badge variant={p.status === 'failed' ? 'destructive' : p.status === 'sent' ? 'default' : 'outline'}>
                        {p.status === 'pending' ? `${timeUntil(p.due_at)}发放` : PAYOUT_STATUS[p.status]}
                      </Badge>
                      {p.error ? <div className="mt-1 text-xs text-muted-foreground">{p.error}</div> : null}
                      {p.trade_no ? <div className="mt-1 text-xs text-muted-foreground">LDC 单号 {p.trade_no}</div> : null}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.status === 'failed' ? (
                        <Button size="sm" variant="ghost" onClick={() => act(p, 'retry')}>
                          重试
                        </Button>
                      ) : null}
                      {p.status === 'pending' || p.status === 'held' || p.status === 'failed' ? (
                        <Button size="sm" variant="ghost" onClick={() => act(p, 'cancel')}>
                          取消
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
