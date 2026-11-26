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
  DEPOSIT_STATUS,
  ApiError,
  ldc,
  parseLdc,
  PAYOUT_STATUS,
  REQUEST_STATUS,
  timeAgo,
  timeUntil,
  type AdminCode,
  type AdminDeposit,
  type DepositStatus,
  type AdminPayout,
  type AdminProduct,
  type AdminProductRequest,
  type AdminUser,
  type Mode,
  type PayoutStats,
  type Report,
  type Settings,
} from '@/lib/api'

const errMsg = (e: unknown, d: string) => (e instanceof ApiError ? e.message : d)

const sentToast = (r: { sent: number; failed: number; waiting: number }) => {
  if (r.sent && !r.failed && !r.waiting) toast(`已立即发出 ${r.sent} 笔`)
  else
    toast(
      `发出 ${r.sent} 笔${r.failed ? `，失败 ${r.failed} 笔（看 LDC 奖励里的原因）` : ''}${
        r.waiting ? `，${r.waiting} 笔超过全站 24 小时上限暂缓` : ''
      }`,
    )
}

export function AdminPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [openReports, setOpenReports] = useState(0)
  const [pendingRequests, setPendingRequests] = useState(0)
  useEffect(() => {
    api.admin
      .reports('open')
      .then((r) => setOpenReports(r.reports.length))
      .catch(() => {})
    api.admin
      .productRequests('pending')
      .then((r) => setPendingRequests(r.requests.length))
      .catch(() => {})
  }, [version])

  return (
    <Tabs defaultValue={openReports ? 'reports' : 'products'} key={openReports ? 'r' : 'p'} className="gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">管理员</h1>
        <p className="text-sm text-muted-foreground">管理产品和产品申请、查看所有人分享的码、处理无效反馈、设置 LDC 奖励。</p>
      </div>
      <TabsList className="flex-wrap">
        <TabsTrigger value="reports">
          无效反馈
          {openReports ? <Badge variant="destructive">{openReports}</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="products">
          产品
          {pendingRequests ? <Badge variant="secondary">{pendingRequests}</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="codes">邀请码</TabsTrigger>
        <TabsTrigger value="users">用户</TabsTrigger>
        <TabsTrigger value="ldc">LDC 奖励</TabsTrigger>
        <TabsTrigger value="relay">接力押金</TabsTrigger>
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
        <UsersPanel version={version} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="ldc">
        <LdcPanel version={version} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="relay">
        <RelayPanel version={version} onChanged={onChanged} />
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
                    <span className="text-xs text-muted-foreground">
                      {r.self_return ? '自己退还 · ' : ''}
                      {timeAgo(r.created_at)}
                    </span>
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
  relay: boolean
  /** 产品自己的押金 LDC，留空 = 全站押金 */
  deposit: string
  /** 最低领取信任等级，留空 = 全站 */
  min_trust: string
  /** 分档押金：信任等级达到 level，押金改成 amount LDC（0 = 免押金） */
  tiers: { level: string; amount: string }[]
  locked: boolean
  /** 通过某条产品申请时才有 */
  request_id?: string
  admin_note?: string
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
  relay: false,
  deposit: '',
  min_trust: '',
  tiers: [],
  locked: false,
}

function ProductsPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [products, setProducts] = useState<AdminProduct[] | null>(null)
  const [form, setForm] = useState<ProductForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [reqStatus, setReqStatus] = useState<'pending' | 'all'>('pending')
  const [requests, setRequests] = useState<AdminProductRequest[] | null>(null)
  const [rejecting, setRejecting] = useState<AdminProductRequest | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  useEffect(() => {
    api.admin
      .products()
      .then((r) => setProducts(r.products))
      .catch(() => setProducts([]))
  }, [version])

  useEffect(() => {
    api.admin
      .productRequests(reqStatus)
      .then((r) => setRequests(r.requests))
      .catch(() => setRequests([]))
  }, [version, reqStatus])

  const approve = (r: AdminProductRequest) =>
    setForm({
      ...EMPTY_FORM,
      name: r.name,
      mode: r.mode,
      max_uses: String(r.max_uses ?? 30),
      description: r.description ?? '',
      request_id: r.id,
      admin_note: '',
    })

  const reject = async () => {
    if (!rejecting) return
    try {
      await api.admin.rejectRequest(rejecting.id, rejectNote)
      toast(`已拒绝 ${rejecting.name} 的申请`)
      setRejecting(null)
      setRejectNote('')
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '操作失败'))
    }
  }

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
      relay: !!p.relay_required,
      deposit: p.deposit_cents === null ? '' : ldc(p.deposit_cents),
      min_trust: p.min_trust_level === null ? '' : String(p.min_trust_level),
      tiers: p.deposit_tiers.map((t) => ({ level: String(t.level), amount: ldc(t.cents) })),
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
    const deposit = form.deposit.trim() === '' ? null : parseLdc(form.deposit)
    if (form.deposit.trim() && !deposit) return toast.error('押金要大于 0，最多两位小数')
    const minTrust = form.min_trust.trim() === '' ? null : Number(form.min_trust)
    if (minTrust !== null && (!Number.isInteger(minTrust) || minTrust < 0 || minTrust > 4)) {
      return toast.error('最低等级要是 0 到 4')
    }
    const tiers = form.tiers.map((t) => ({ level: Number(t.level), cents: parseLdc(t.amount) }))
    if (tiers.some((t) => !Number.isInteger(t.level) || t.level < 0 || t.level > 4 || t.cents === null)) {
      return toast.error('分档押金：等级要是 0 到 4，押金不小于 0')
    }
    if (new Set(tiers.map((t) => t.level)).size !== tiers.length) return toast.error('分档押金的等级不能重复')
    const body = {
      name: form.name,
      mode: form.mode,
      max_uses: form.mode === 'multi' ? Number(form.max_uses) : undefined,
      max_codes_per_user: form.mode === 'single' && form.max_codes_per_user.trim() ? Number(form.max_codes_per_user) : null,
      code_pattern: form.code_pattern.trim() || null,
      description: form.description.trim() || null,
      share_reward_cents: share,
      claim_reward_cents: claim,
      relay_required: form.relay,
      deposit_cents: deposit,
      min_trust_level: minTrust,
      deposit_tiers: tiers as { level: number; cents: number }[],
    }
    setBusy(true)
    try {
      if (form.request_id) {
        const r = await api.admin.approveRequest(form.request_id, { ...body, admin_note: form.admin_note?.trim() || null })
        toast(r.reactivated ? `已通过，${form.name} 重新上架（沿用原来的设置）` : `已通过，${form.name} 已上架`)
      } else if (form.key) await api.admin.updateProduct(form.key, body)
      else await api.admin.createProduct(body)
      if (!form.request_id) toast(form.key ? '已保存' : `已添加 ${form.name}`)
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

  const requestsCard = (
    <Card>
      <CardHeader>
        <CardTitle>产品申请</CardTitle>
        <CardDescription>普通用户申请的新产品。通过时可以改名字、模式和奖励，通过后产品直接上架。</CardDescription>
        <CardAction>
          <Filter
            value={reqStatus}
            options={[
              ['pending', '待审核'],
              ['all', '全部'],
            ]}
            onChange={setReqStatus}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {requests === null ? (
          <Skeleton className="h-20" />
        ) : requests.length === 0 ? (
          <Empty text={reqStatus === 'pending' ? '没有待审核的申请。' : '还没有人申请过。'} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>产品</TableHead>
                <TableHead>申请人</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72 whitespace-normal">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.mode === 'multi' ? `多人可用码${r.max_uses ? ` · 每码 ${r.max_uses} 人` : ''}` : '一次性码'}
                      {r.existing_product && !r.existing_active ? ' · 有同名的已下架产品' : ''}
                    </div>
                    {r.description ? <div className="text-sm text-muted-foreground">{r.description}</div> : null}
                    {r.admin_note ? <div className="text-sm">备注：{r.admin_note}</div> : null}
                  </TableCell>
                  <TableCell>
                    <UserCell name={r.username} avatar={r.avatar_url} />
                    <span className="text-xs text-muted-foreground">{timeAgo(r.created_at)}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={r.status === 'approved' ? 'default' : r.status === 'rejected' ? 'destructive' : 'outline'}
                    >
                      {REQUEST_STATUS[r.status]}
                    </Badge>
                    {r.resolved_by_username ? (
                      <div className="text-xs text-muted-foreground">{r.resolved_by_username}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.status === 'pending' ? (
                      <>
                        <Button size="sm" onClick={() => approve(r)}>
                          通过
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>
                          拒绝
                        </Button>
                      </>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝 {rejecting?.name} 的申请</DialogTitle>
            <DialogDescription>申请人会在「我的 → 我的申请」里看到理由。拒绝后别人还可以再申请这个产品。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reject-note">理由（可选）</Label>
            <Textarea
              id="reject-note"
              maxLength={200}
              placeholder="比如：这个产品没有邀请机制 / 已经有同类产品"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={reject}>
              拒绝
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )

  return (
    <div className="flex flex-col gap-6">
      {requestsCard}
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
                        {p.relay_required ? (
                          <Badge variant="outline">
                            接力{p.deposit_cents !== null ? ` · 押金 ${ldc(p.deposit_cents)}` : ''}
                            {p.deposit_tiers.length ? ` · ${p.deposit_tiers.length} 档` : ''}
                          </Badge>
                        ) : null}
                        {p.min_trust_level !== null ? <Badge variant="outline">≥{p.min_trust_level} 级</Badge> : null}
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
              <DialogTitle>{form?.request_id ? '通过申请，上架产品' : form?.key ? `编辑 ${form.name}` : '新建产品'}</DialogTitle>
              <DialogDescription>
                {form?.request_id
                  ? '已经按申请填好了，核对后可以修改。保存后产品直接上架。'
                  : '选好这个产品的邀请码是怎么用的，系统会按模式分发。'}
              </DialogDescription>
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
                <div className="flex flex-col gap-2">
                  <Label>接力</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant={form.relay ? 'outline' : 'default'} onClick={() => set({ relay: false })}>
                      不需要
                    </Button>
                    <Button type="button" variant={form.relay ? 'default' : 'outline'} onClick={() => set({ relay: true })}>
                      需要接力
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    需要接力时，领码前先付押金；领到的人放回自己的码、被别人领走后押金退回。总开关在「接力押金」里。
                  </p>
                </div>
                {form.relay ? (
                  <div className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="p-deposit">这个产品的押金 LDC</Label>
                      <Input
                        id="p-deposit"
                        inputMode="decimal"
                        placeholder="留空用全站押金"
                        value={form.deposit}
                        onChange={(e) => set({ deposit: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label>分档押金（可选）</Label>
                      <p className="text-xs text-muted-foreground">
                        信任等级达到某一档，押金改成这一档的金额；填 0 就是免押金。等级高的档优先。
                      </p>
                      {form.tiers.map((t, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            aria-label="信任等级"
                            type="number"
                            min={0}
                            max={4}
                            className="w-20"
                            value={t.level}
                            onChange={(e) =>
                              set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, level: e.target.value } : x)) })
                            }
                          />
                          <span className="text-sm whitespace-nowrap text-muted-foreground">级及以上，押金</span>
                          <Input
                            aria-label="押金 LDC"
                            inputMode="decimal"
                            className="w-24"
                            value={t.amount}
                            onChange={(e) =>
                              set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })
                            }
                          />
                          <span className="text-sm text-muted-foreground">LDC</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => set({ tiers: form.tiers.filter((_, j) => j !== i) })}
                          >
                            删除
                          </Button>
                        </div>
                      ))}
                      {form.tiers.length < 5 ? (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => set({ tiers: [...form.tiers, { level: '3', amount: '0' }] })}
                          >
                            <Plus />
                            加一档
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="p-trust">最低领取等级（可选）</Label>
                  <Input
                    id="p-trust"
                    type="number"
                    min={0}
                    max={4}
                    placeholder="留空用全站设置"
                    value={form.min_trust}
                    onChange={(e) => set({ min_trust: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">LinuxDO 信任等级 0 到 4，低于这个等级的人看得到这个产品但领不了。</p>
                </div>
                {form.request_id ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="p-note">给申请人的备注（可选）</Label>
                    <Input
                      id="p-note"
                      maxLength={200}
                      placeholder="比如：已上架，改成了每码 30 人"
                      value={form.admin_note ?? ''}
                      onChange={(e) => set({ admin_note: e.target.value })}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button onClick={save} disabled={busy || !form?.name.trim()}>
                {busy ? '保存中…' : form?.request_id ? '通过并上架' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
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

function UsersPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [paying, setPaying] = useState<AdminUser | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.admin
      .users()
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]))
  }, [version])

  const payNow = async () => {
    if (!paying) return
    setBusy(true)
    try {
      sentToast(await api.admin.sendUserNow(paying.id))
      setPaying(null)
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '没发出去'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>已注册用户</CardTitle>
        <CardDescription>
          按最近登录排序。分享 = 还在的码，送出 / 领到 = 领取次数。「立即发放」会跳过观察期，马上把这个人待发的奖励发出去。
        </CardDescription>
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
                <TableHead>奖励（已发 / 待发）</TableHead>
                <TableHead>最近登录</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <UserCell name={u.username} avatar={u.avatar_url} />
                      {u.is_admin ? <Badge>管理员</Badge> : null}
                      {u.is_test ? <Badge variant="outline">测试账号</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{u.trust_level}</TableCell>
                  <TableCell className="tabular-nums">{u.codes}</TableCell>
                  <TableCell className="tabular-nums">{u.given}</TableCell>
                  <TableCell className="tabular-nums">{u.received}</TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {ldc(u.sent_cents)} / {ldc(u.unpaid_cents)}
                    {u.held_cents ? <div className="text-xs text-muted-foreground">另有 {ldc(u.held_cents)} 被扣下</div> : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(u.last_login_at)}</TableCell>
                  <TableCell className="text-right">
                    {u.unpaid_cents > 0 ? (
                      <Button size="sm" variant="outline" onClick={() => setPaying(u)}>
                        立即发放
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!paying} onOpenChange={(o) => !o && setPaying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>立即给 {paying?.username} 发放奖励？</DialogTitle>
            <DialogDescription>
              会跳过观察期，马上从你的 LDC 商户账户发出 {ldc(paying?.unpaid_cents)} LDC（他所有待发和发送失败的奖励）。
              有人反馈无效、被扣下的不会发；全站 24 小时上限照样算。发出后收不回。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)}>
              取消
            </Button>
            <Button onClick={payNow} disabled={busy}>
              {busy ? '发放中…' : `立即发放 ${ldc(paying?.unpaid_cents)} LDC`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  const payNow = async (p: AdminPayout) => {
    try {
      sentToast(await api.admin.sendPayoutNow(p.id))
      loadPayouts()
    } catch (e) {
      toast.error(errMsg(e, '没发出去'))
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
                      {p.status === 'pending' || p.status === 'failed' ? (
                        <Button size="sm" variant="outline" onClick={() => payNow(p)}>
                          立即发
                        </Button>
                      ) : null}
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

// ---------- 接力押金 ----------

function RelayPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [amount, setAmount] = useState('')
  const [premium, setPremium] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'all' | DepositStatus>('all')
  const [deposits, setDeposits] = useState<AdminDeposit[] | null>(null)
  const [confirm, setConfirm] = useState<{ d: AdminDeposit; kind: 'refund' | 'forfeit' } | null>(null)

  useEffect(() => {
    api.admin
      .settings()
      .then((r) => {
        setSettings(r.settings)
        setConfigured(r.ldc_configured)
        setAmount(ldc(r.settings.relay_deposit_cents))
        setPremium(ldc(r.settings.queue_premium_cents))
      })
      .catch(() => setConfigured(false))
  }, [version])

  const load = useCallback(() => {
    api.admin
      .deposits(status)
      .then((r) => setDeposits(r.deposits))
      .catch(() => setDeposits([]))
  }, [status])

  useEffect(() => {
    setDeposits(null)
    load()
  }, [load, version])

  const save = async (enabled?: boolean) => {
    const cents = parseLdc(amount)
    if (!cents) return toast.error('押金要是大于 0 的数字，最多两位小数')
    const extra = parseLdc(premium)
    if (!extra) return toast.error('排队加价要是大于 0 的数字，最多两位小数')
    setBusy(true)
    try {
      const r = await api.admin.saveSettings({
        relay_enabled: enabled ?? settings?.relay_enabled ?? false,
        relay_deposit_cents: cents,
        queue_premium_cents: extra,
      })
      setSettings(r.settings)
      setAmount(ldc(r.settings.relay_deposit_cents))
      setPremium(ldc(r.settings.queue_premium_cents))
      toast(enabled === undefined ? '已保存' : enabled ? '接力已开启' : '接力已关闭')
      onChanged()
    } catch (e) {
      toast.error(errMsg(e, '没保存成功'))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    try {
      const r = await api.admin.runRefunds()
      toast(`退回 ${r.refunded} 笔，失败 ${r.failed} 笔`)
      load()
    } catch (e) {
      toast.error(errMsg(e, '没退成'))
    }
  }

  const doConfirm = async () => {
    if (!confirm) return
    const { d, kind } = confirm
    try {
      if (kind === 'refund') await api.admin.refundDeposit(d.id)
      else await api.admin.forfeitDeposit(d.id)
      toast(kind === 'refund' ? `已退回 ${d.username} 的押金` : `已没收 ${d.username} 的押金`)
      setConfirm(null)
      load()
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
            押金通过 LINUX DO Credit 收款和退款，要先设置商户凭证（和 LDC 奖励用的是同一套），并在商户应用里把回调地址设成本站的
            /api/ldc/notify。
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>接力设置</CardTitle>
          <CardDescription>
            开启后，标了「需要接力」的产品领码前要先付押金。领到的人把自己的同产品邀请码放回分享，被别人领走、过了观察期（和 LDC
            奖励同一个观察期）没人反馈无效，押金自动原路退回。
          </CardDescription>
          <CardAction>
            {settings ? (
              <Button
                size="sm"
                variant={settings.relay_enabled ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => save(!settings.relay_enabled)}
              >
                {settings.relay_enabled ? '关闭接力' : '开启接力'}
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          {!settings ? (
            <Skeleton className="h-20" />
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
                <Badge variant={settings.relay_enabled ? 'default' : 'secondary'}>
                  {settings.relay_enabled ? '已开启' : '已关闭'}
                </Badge>
              </div>
              <div className="grid max-w-xl gap-4 sm:grid-cols-2">
                <Field
                  id="r-amount"
                  label="默认押金（LDC）"
                  hint="产品没单独设押金时用这个；产品里还可以按信任等级分档减免"
                  value={amount}
                  onChange={setAmount}
                />
                <Field
                  id="r-premium"
                  label="排队加价（LDC）"
                  hint="没码时排队要比正常押金多付这么多；接力完成后和押金一起退"
                  value={premium}
                  onChange={setPremium}
                />
              </div>
              <div>
                <Button type="submit" disabled={busy}>
                  保存
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>押金记录</CardTitle>
          <CardDescription>系统每 10 分钟自动退一次到期的押金。没收只在确认有人恶意不接力时用。</CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" onClick={run}>
              立即退到期的
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Filter
            value={status}
            onChange={setStatus}
            options={[
              ['all', '全部'],
              ['paid', '已付未用'],
              ['used', '等放回'],
              ['refund_due', '待退回'],
              ['refund_failed', '退回失败'],
              ['refunded', '已退回'],
            ]}
          />
          {deposits === null ? (
            <Skeleton className="h-32" />
          ) : deposits.length === 0 ? (
            <Empty text="没有记录。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>产品</TableHead>
                  <TableHead>押金</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deposits.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <UserCell name={d.username} avatar={d.avatar_url} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        {d.product}
                        {d.queued ? <Badge variant="outline">排队</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">付于 {timeAgo(d.paid_at ?? d.created_at)}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{ldc(d.amount_cents)} LDC</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      <Badge
                        variant={
                          d.status === 'refund_failed' || d.status === 'forfeited'
                            ? 'destructive'
                            : d.status === 'refunded'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {d.status === 'used' && d.relayed
                          ? '已放回码，等人领走'
                          : d.status === 'refund_due' && d.refund_due_at
                            ? `${timeUntil(d.refund_due_at)}退回`
                            : DEPOSIT_STATUS[d.status]}
                      </Badge>
                      {d.error ? <div className="mt-1 text-xs text-muted-foreground">{d.error}</div> : null}
                      {d.trade_no ? <div className="mt-1 text-xs text-muted-foreground">LDC 单号 {d.trade_no}</div> : null}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {['paid', 'used', 'refund_due', 'refund_failed'].includes(d.status) ? (
                        <Button size="sm" variant="outline" onClick={() => setConfirm({ d, kind: 'refund' })}>
                          退回
                        </Button>
                      ) : null}
                      {d.status === 'used' || d.status === 'refund_failed' ? (
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ d, kind: 'forfeit' })}>
                          没收
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

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'refund' ? '退回' : '没收'} {confirm?.d.username} 的押金？
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'refund'
                ? `马上通过 LINUX DO Credit 把 ${ldc(confirm?.d.amount_cents)} LDC 原路退给 ${confirm?.d.username}，退了收不回来。`
                : `这笔 ${ldc(confirm?.d.amount_cents)} LDC 押金不再退回，用户在「我的 → 押金」里会看到已没收。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button variant={confirm?.kind === 'forfeit' ? 'destructive' : 'default'} onClick={doConfirm}>
              {confirm?.kind === 'refund' ? '退回' : '没收'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
