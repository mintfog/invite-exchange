import { useEffect, useState } from 'react'
import { Coins, Heart } from 'lucide-react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { CopyButton } from '@/components/copy-button'
import { ReportDialog } from '@/components/report-dialog'
import { RequestProductDialog } from '@/components/request-product-dialog'
import {
  api,
  ApiError,
  DEPOSIT_STATUS,
  ldc,
  loginUrl,
  PAYOUT_STATUS,
  REQUEST_STATUS,
  timeAgo,
  timeUntil,
  type Claim,
  type Claimer,
  type Deposit,
  type MyPayout,
  type ProductRequest,
  type SharedCode,
  type SharedSummary,
  type User,
} from '@/lib/api'

type Props = { user: User | null; version: number; onChanged: () => void }

export function MinePage({ user, version, onChanged }: Props) {
  const [shared, setShared] = useState<SharedCode[] | null>(null)
  const [claimers, setClaimers] = useState<Claimer[]>([])
  const [summary, setSummary] = useState<SharedSummary | null>(null)
  const [payouts, setPayouts] = useState<MyPayout[]>([])
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [editing, setEditing] = useState<SharedCode | null>(null)
  const [remaining, setRemaining] = useState('')
  const [reporting, setReporting] = useState<Claim | null>(null)
  const [requests, setRequests] = useState<ProductRequest[] | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [reqVersion, setReqVersion] = useState(0)
  const [deposits, setDeposits] = useState<Deposit[]>([])
  const [refunding, setRefunding] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    api
      .myShared()
      .then((r) => {
        setShared(r.codes)
        setClaimers(r.claimers)
        setSummary(r.summary)
        setPayouts(r.payouts)
      })
      .catch(() => setShared([]))
    api
      .myClaimed()
      .then((r) => setClaims(r.claims))
      .catch(() => setClaims([]))
    api
      .myDeposits()
      .then((r) => setDeposits(r.deposits))
      .catch(() => setDeposits([]))
  }, [user, version])

  useEffect(() => {
    if (!user) return
    api
      .myRequests()
      .then((r) => setRequests(r.requests))
      .catch(() => setRequests([]))
  }, [user, version, reqVersion])

  if (!user) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>登录后查看</CardTitle>
          <CardDescription>这里会列出你分享的码被谁用了、还剩几次，以及你领到的码。</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <a href={loginUrl}>用 LINUX DO 登录</a>
          </Button>
        </CardFooter>
      </Card>
    )
  }

  const withdraw = async (id: string) => {
    try {
      await api.withdraw(id)
      toast('已撤回，码内容已删除')
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '撤回失败')
    }
  }

  const thank = async (id: string) => {
    try {
      await api.thank(id)
      toast('已向分享者送出感谢')
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没送出去')
    }
  }

  const openEdit = (c: SharedCode) => {
    setEditing(c)
    setRemaining(String(Math.max(0, c.max_uses - c.used)))
  }

  const saveRemaining = async () => {
    if (!editing) return
    try {
      await api.setRemaining(editing.id, Number(remaining))
      toast('剩余次数已更新')
      setEditing(null)
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没改成')
    }
  }

  const cancelRequest = async (id: string) => {
    try {
      await api.cancelRequest(id)
      toast('已撤回申请')
      setReqVersion((v) => v + 1)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '撤回失败')
    }
  }

  const refund = async (id: string) => {
    setRefunding(id)
    try {
      await api.refundDeposit(id)
      toast('押金已原路退回')
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没退成')
    } finally {
      setRefunding(null)
    }
  }

  const idleDeposits = deposits.filter((d) => d.status === 'paid').length

  const pendingRequests = requests?.filter((r) => r.status === 'pending').length ?? 0

  const byCode = (id: string) => claimers.filter((x) => x.code_id === id)
  const hasRewards = payouts.length > 0 || !!summary?.rewarded_cents

  return (
    <Tabs defaultValue="shared" className="gap-6">
      <TabsList>
        <TabsTrigger value="shared">我分享的</TabsTrigger>
        <TabsTrigger value="claimed">我领到的</TabsTrigger>
        <TabsTrigger value="requests">
          我的申请
          {pendingRequests ? <Badge variant="secondary">{pendingRequests}</Badge> : null}
        </TabsTrigger>
        {deposits.length ? (
          <TabsTrigger value="deposits">
            押金
            {idleDeposits ? <Badge variant="secondary">{idleDeposits}</Badge> : null}
          </TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="shared" className="flex flex-col gap-6">
        <div className={`grid gap-3 ${hasRewards ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
          <Stat label="还能被领（次）" value={summary?.available} />
          <Stat label="已被领取" value={summary?.claimed} />
          <Stat label="收到感谢" value={summary?.thanks} icon={<Heart className="size-3.5" />} />
          {hasRewards ? (
            <Stat label="LDC 已到账" value={ldc(summary?.rewarded_cents)} icon={<Coins className="size-3.5" />} />
          ) : null}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>分享记录</CardTitle>
            <CardDescription>能看到每个码还剩几次、被谁用了。对方点了感谢，名字旁会亮起红心。</CardDescription>
          </CardHeader>
          <CardContent>
            {shared === null ? (
              <Skeleton className="h-32" />
            ) : shared.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有分享过邀请码。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>产品</TableHead>
                    <TableHead>邀请码</TableHead>
                    <TableHead>剩余</TableHead>
                    <TableHead>用的人</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shared.map((c) => {
                    const left = Math.max(0, c.max_uses - c.used)
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-1">
                            {c.product}
                            {c.reports_open ? <Badge variant="destructive">有人反馈无效</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-40 truncate font-mono text-xs">{c.code}</TableCell>
                        <TableCell>
                          {c.mode === 'multi' ? (
                            <Badge variant={left > 0 ? 'outline' : 'secondary'}>
                              {left > 0 ? `剩 ${left} 次` : '已用完'} · 已用 {c.used}
                            </Badge>
                          ) : c.status === 'claimed' ? (
                            <Badge variant="secondary">已领走</Badge>
                          ) : (
                            <Badge variant="outline">在池中</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <People list={byCode(c.id)} />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {c.mode === 'multi' ? (
                            <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                              改次数
                            </Button>
                          ) : null}
                          {c.status === 'available' ? (
                            <Button variant="ghost" size="sm" onClick={() => withdraw(c.id)}>
                              撤回
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {hasRewards ? (
          <Card>
            <CardHeader>
              <CardTitle>LDC 奖励</CardTitle>
              <CardDescription>
                领取后先过观察期，没人反馈无效就自动打到你的 LINUX DO Credit 账户。
                {summary?.pending_cents ? ` 还有 ${ldc(summary.pending_cents)} LDC 等待发放。` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>产品</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>金额</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.product}</TableCell>
                      <TableCell>{p.kind === 'share' ? '贡献奖励' : '领取奖励'}</TableCell>
                      <TableCell className="tabular-nums">{ldc(p.amount_cents)} LDC</TableCell>
                      <TableCell>
                        <Badge variant={p.status === 'sent' ? 'default' : 'outline'}>
                          {p.status === 'pending' ? `${timeUntil(p.due_at)}发放` : PAYOUT_STATUS[p.status]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </TabsContent>

      <TabsContent value="claimed">
        <Card>
          <CardHeader>
            <CardTitle>我领到的</CardTitle>
            <CardDescription>这些码只有你和分享者看得到。用上了别忘了说声谢谢；用不了可以反馈。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col">
            {claims === null ? (
              <Skeleton className="h-32" />
            ) : claims.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有领过邀请码。</p>
            ) : (
              claims.map((c, i) => (
                <div key={c.id}>
                  {i > 0 ? <Separator /> : null}
                  <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.product}</span>
                        <span className="text-xs text-muted-foreground">
                          来自 {c.sharer_username} · {timeAgo(c.claimed_at)}
                        </span>
                        <ReportBadge claim={c} />
                      </div>
                      <code className="truncate rounded-md bg-muted px-2 py-1 font-mono text-sm">{c.code}</code>
                      {c.note ? <span className="text-xs text-muted-foreground">留言：{c.note}</span> : null}
                      {c.void_at ? (
                        <span className="text-xs text-muted-foreground">
                          {c.self_returned ? '你已退还这个码' : '这个码已确认无效'}，可以去广场再领一个。
                        </span>
                      ) : null}
                      <DepositNote claim={c} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <CopyButton value={c.code} label="复制" />
                      <Button variant="outline" size="sm" disabled={!!c.thanked_at} onClick={() => thank(c.id)}>
                        <Heart className={c.thanked_at ? 'fill-foreground' : undefined} />
                        {c.thanked_at ? '已感谢' : '感谢'}
                      </Button>
                      {!c.void_at && (!c.report_status || (c.report_status === 'open' && returnable(c))) ? (
                        <Button variant="ghost" size="sm" onClick={() => setReporting(c)}>
                          {c.report_status ? '退还' : '用不了'}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="requests">
        <Card>
          <CardHeader>
            <CardTitle>我的申请</CardTitle>
            <CardDescription>广场上没有的产品可以申请，管理员通过后就会上架。同时最多 3 个申请在等审核。</CardDescription>
            <CardAction>
              <Button size="sm" onClick={() => setRequesting(true)}>
                申请新产品
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col">
            {requests === null ? (
              <Skeleton className="h-24" />
            ) : requests.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有申请过新产品。</p>
            ) : (
              requests.map((r, i) => (
                <div key={r.id}>
                  {i > 0 ? <Separator /> : null}
                  <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <Badge
                          variant={
                            r.status === 'approved' ? 'default' : r.status === 'rejected' ? 'destructive' : 'outline'
                          }
                        >
                          {REQUEST_STATUS[r.status]}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {r.mode === 'multi' ? `多人可用码${r.max_uses ? ` · 每码 ${r.max_uses} 人` : ''}` : '一次性码'} ·{' '}
                          {timeAgo(r.created_at)}
                        </span>
                      </div>
                      {r.description ? <span className="text-sm text-muted-foreground">{r.description}</span> : null}
                      {r.admin_note ? <span className="text-sm">管理员：{r.admin_note}</span> : null}
                      {r.status === 'approved' ? (
                        <span className="text-xs text-muted-foreground">已经上架，可以去分享了。</span>
                      ) : null}
                    </div>
                    {r.status === 'pending' ? (
                      <Button variant="ghost" size="sm" onClick={() => cancelRequest(r.id)}>
                        撤回
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {deposits.length ? (
        <TabsContent value="deposits">
          <Card>
            <CardHeader>
              <CardTitle>接力押金</CardTitle>
              <CardDescription>
                领接力产品前付的押金和排队押金。领到后把你自己的同产品邀请码放进分享。满 5 小时无人领，或被领走且过了观察期没人反馈无效，押金自动原路退回。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>产品</TableHead>
                    <TableHead>押金</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deposits.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {d.product}
                          {d.queued ? <Badge variant="outline">排队</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">{ldc(d.amount_cents)} LDC</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <Badge
                            variant={
                              d.status === 'refunded'
                                ? 'secondary'
                                : d.status === 'refund_failed' || d.status === 'forfeited'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {d.status === 'used' && d.relayed
                              ? '已放回码，等人领走'
                              : d.status === 'paid' && d.queued
                                ? '排队中'
                                : DEPOSIT_STATUS[d.status]}
                          </Badge>
                          {d.status === 'refund_due' && d.refund_due_at ? (
                            <span className="text-xs text-muted-foreground">预计 {timeUntil(d.refund_due_at)}退回</span>
                          ) : null}
                          {d.status === 'refund_failed' && d.error ? (
                            <span className="text-xs text-muted-foreground">{d.error}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {d.status === 'paid' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={refunding === d.id}
                            onClick={() => refund(d.id)}
                          >
                            {refunding === d.id ? '退回中…' : d.queued ? '取消排队并退回' : '退回押金'}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      ) : null}

      <RequestProductDialog
        open={requesting}
        onClose={() => setRequesting(false)}
        onDone={() => setReqVersion((v) => v + 1)}
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>改 {editing?.product} 的剩余次数</DialogTitle>
            <DialogDescription>
              比如你在别处用掉了几次，可以在这里扣掉。已经有 {editing?.used ?? 0} 人通过这里用了，
              最多还能填 {editing ? Math.max(0, editing.product_max_uses - editing.used) : 0} 次。填 0 就不再发出。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="remaining">还能用几次</Label>
            <Input
              id="remaining"
              type="number"
              inputMode="numeric"
              min={0}
              max={editing ? Math.max(0, editing.product_max_uses - editing.used) : 0}
              value={remaining}
              onChange={(e) => setRemaining(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={saveRemaining} disabled={remaining.trim() === ''}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReportDialog
        claimId={reporting?.id ?? null}
        product={reporting?.product}
        returnable={reporting ? returnable(reporting) : false}
        onlyReturn={reporting?.report_status === 'open'}
        onClose={() => setReporting(null)}
        onDone={onChanged}
      />
    </Tabs>
  )
}

function DepositNote({ claim: c }: { claim: Claim }) {
  if (!c.deposit_status || !c.deposit_cents) return null
  const amount = `${ldc(c.deposit_cents)} LDC 押金`
  const text =
    c.deposit_status === 'used'
      ? c.relayed
        ? `已放回你的 ${c.product} 码，满 5 小时无人领或通过领取观察期后退 ${amount}`
        : `还没放回你自己的 ${c.product} 码，请去「分享」放回，之后按接力规则退 ${amount}`
      : c.deposit_status === 'refund_due'
        ? `${amount}${c.refund_due_at ? ` ${timeUntil(c.refund_due_at)}` : ''}退回`
        : `${amount}：${DEPOSIT_STATUS[c.deposit_status]}`
  return <span className="text-xs text-foreground">{text}</span>
}

// 领到 24 小时内可以自己退还
const returnable = (c: Claim) =>
  !c.void_at && c.report_status !== 'dismissed' && c.claimed_at > Date.now() - 24 * 60 * 60 * 1000

function ReportBadge({ claim }: { claim: Claim }) {
  if (claim.self_returned && claim.void_at) return <Badge variant="destructive">已退还</Badge>
  if (claim.void_at || claim.report_status === 'confirmed') return <Badge variant="destructive">已确认无效</Badge>
  if (claim.report_status === 'open') return <Badge variant="outline">已反馈，等待处理</Badge>
  if (claim.report_status === 'dismissed') return <Badge variant="secondary">反馈未通过</Badge>
  return null
}

function People({ list }: { list: Claimer[] }) {
  if (list.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  const shown = list.slice(0, 4)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((x) => (
        <div key={x.id} className="flex items-center gap-1" title={`${x.username} · ${timeAgo(x.claimed_at)}`}>
          <Avatar className="size-6">
            {x.avatar_url ? <AvatarImage src={x.avatar_url} /> : null}
            <AvatarFallback className="text-xs">{x.username.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-sm">{x.username}</span>
          {x.thanked_at ? <Heart className="size-3.5 fill-foreground" aria-label="已感谢" /> : null}
        </div>
      ))}
      {list.length > shown.length ? (
        <span className="text-xs text-muted-foreground">等 {list.length} 人</span>
      ) : null}
    </div>
  )
}

function Stat({ label, value, icon }: { label: string; value: number | string | null | undefined; icon?: React.ReactNode }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-1">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value ?? 0}</CardTitle>
      </CardHeader>
    </Card>
  )
}
