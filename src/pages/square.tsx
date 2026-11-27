import { useEffect, useMemo, useState } from 'react'
import { BellRing, Coins, Gift, Heart, Link2, Repeat, Search, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RequestProductDialog } from '@/components/request-product-dialog'
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
import { Skeleton } from '@/components/ui/skeleton'

import { CopyButton } from '@/components/copy-button'
import { ReportDialog } from '@/components/report-dialog'
import { ChainDialog } from '@/components/chain-dialog'
import { prepareQueueAlerts } from '@/lib/queue-alerts'
import {
  api,
  ApiError,
  ldc,
  loginUrl,
  timeAgo,
  type Limits,
  type NewClaim,
  type Product,
  type Totals,
  type User,
} from '@/lib/api'

type Props = {
  user: User | null
  limits: Limits | null
  version: number
  onChanged: () => void
  onGoShare: () => void
}

export function SquarePage({ user, limits, version, onChanged, onGoShare }: Props) {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [query, setQuery] = useState('')
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claim, setClaim] = useState<NewClaim | null>(null)
  const [thanked, setThanked] = useState(false)
  const [reporting, setReporting] = useState<NewClaim | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [depositFor, setDepositFor] = useState<Product | null>(null)
  const [queueFor, setQueueFor] = useState<Product | null>(null)
  const [chainFor, setChainFor] = useState<Product | null>(null)
  const [paying, setPaying] = useState(false)

  useEffect(() => {
    api
      .products()
      .then((r) => {
        setProducts(r.products)
        setTotals(r.totals)
      })
      .catch(() => setProducts([]))
  }, [version])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q))
  }, [products, query])

  const lowTrust = !!user && !!limits && user.trust_level < limits.minTrustLevel
  const tooLow = (p: Product) => !!user && user.trust_level < p.min_trust_level

  const doClaim = async (p: Product) => {
    setClaiming(p.key)
    try {
      const r = await api.claim(p.key)
      setThanked(false)
      setClaim(r.claim)
      onChanged()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'deposit_required') {
        setDepositFor(p)
        onChanged()
        return
      }
      toast.error(e instanceof ApiError ? e.message : '领取失败')
      if (e instanceof ApiError && e.code === 'empty') onChanged()
    } finally {
      setClaiming(null)
    }
  }

  // 跳到 LINUX DO Credit 付押金，付完会回到广场
  const doPay = async () => {
    if (!depositFor) return
    setPaying(true)
    try {
      const r = await api.payDeposit(depositFor.key)
      window.location.href = r.url
    } catch (e) {
      setPaying(false)
      if (e instanceof ApiError && e.code === 'has_deposit') {
        setDepositFor(null)
        onChanged()
      }
      toast.error(e instanceof ApiError ? e.message : '没打开付款页面')
    }
  }

  // 排队：先请求通知权限（必须在点击里），再跳去付排队押金
  const doQueue = async () => {
    if (!queueFor) return
    prepareQueueAlerts()
    setPaying(true)
    try {
      const r = await api.payDeposit(queueFor.key, true)
      window.location.href = r.url
    } catch (e) {
      setPaying(false)
      if (e instanceof ApiError && ['has_deposit', 'not_empty'].includes(e.code)) {
        setQueueFor(null)
        onChanged()
      }
      toast.error(e instanceof ApiError ? e.message : '没打开付款页面')
    }
  }

  const doThank = async () => {
    if (!claim) return
    try {
      await api.thank(claim.id)
      setThanked(true)
      toast('已向分享者送出感谢')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没送出去')
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">有多的邀请码，就留给需要的人</h1>
        <p className="text-sm text-muted-foreground">
          用 LinuxDO 账号登录，每个产品领一个，系统随机轮流发给你，让每个分享者都能被用到。码池里的码对所有人隐藏，只有领取人和分享者能看到。
        </p>
      </section>

      <section className={`grid gap-3 ${totals?.rewarded_cents ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
        <Stat label="池中可领" value={totals?.available} />
        <Stat label="已送出" value={totals?.claimed} />
        <Stat label="分享者" value={totals?.sharers} />
        {totals?.rewarded_cents ? <Stat label="已奖励 LDC" value={ldc(totals.rewarded_cents)} /> : null}
      </section>

      {lowTrust ? (
        <Alert>
          <AlertTitle>你的 LinuxDO 信任等级还不够领大部分产品</AlertTitle>
          <AlertDescription>
            你现在是 {user?.trust_level} 级，大部分产品需要 {limits?.minTrustLevel} 级，每个产品的要求写在卡片上。可以先分享自己多余的码。
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索产品，比如 Muse"
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={onGoShare}>
            <Gift />
            分享邀请码
          </Button>
        </div>

        {products === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{query ? '没有找到这个产品' : '广场还没有产品'}</CardTitle>
              <CardDescription>
                {user
                  ? '想分享的产品还没有？可以申请一个，管理员通过后就会出现在这里。'
                  : '登录后可以申请新产品，管理员通过后就会出现在这里。'}
              </CardDescription>
            </CardHeader>
            {user ? (
              <CardFooter>
                <Button variant="outline" onClick={() => setRequesting(true)}>
                  申请新产品
                </Button>
              </CardFooter>
            ) : null}
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <Card
                key={p.key}
                className={p.deposit_base_cents !== null ? 'cursor-pointer transition-colors hover:border-foreground/30' : undefined}
                onClick={p.deposit_base_cents !== null ? () => setChainFor(p) : undefined}
              >
                <CardHeader>
                  <CardTitle className="truncate">{p.name}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {p.description ||
                      (p.last_shared_at ? `最近分享于 ${timeAgo(p.last_shared_at)}` : '还没有人分享，来当第一个')}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={p.available > 0 ? 'default' : 'secondary'}>
                      {p.available > 0 ? (p.mode === 'multi' ? `剩 ${p.available} 次` : `可领 ${p.available}`) : '已领完'}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {p.mode === 'multi' ? `每人一个码 · 每码 ${p.max_uses} 人可用` : '一次性码'}
                    </Badge>
                    {p.min_trust_level > 0 ? (
                      <Badge variant={tooLow(p) ? 'destructive' : 'outline'}>需 {p.min_trust_level} 级</Badge>
                    ) : null}
                    {p.mode === 'multi' && p.available_codes > 0 ? (
                      <span>{p.available_codes} 位分享者轮流发</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1">
                      <Heart className="size-4" />
                      已送出 {p.claimed}
                    </span>
                    {p.mine_available > 0 ? (
                      <span>其中 {p.mine_available} {p.mode === 'multi' ? '次' : '个'}是你的</span>
                    ) : null}
                  </div>
                  <RewardLine product={p} />
                  <RelayLine product={p} />
                  {p.deposit_base_cents !== null ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-foreground">
                      <Button
                        variant="link"
                        className="h-auto gap-1 p-0 text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          setChainFor(p)
                        }}
                      >
                        <Link2 className="size-4" />
                        当前 {p.relay_chains} 条接力链，点开看
                      </Button>
                      {p.queue_count > 0 ? (
                        <span className="flex items-center gap-1">
                          <Users className="size-4" />
                          {p.queue_count} 人在排队{p.my_queue_pos ? `，你排第 ${p.my_queue_pos} 位` : ''}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {p.deposit_base_cents !== null && p.available - p.mine_available <= 0 && !p.my_queue_pos ? (
                    <span className="text-foreground">
                      {p.waiting_relays > 0
                        ? `已有 ${p.waiting_relays} 人付了押金领走码、还没放回自己的码，可以稍后再来看看，或者排队等码`
                        : '码暂时领完了，等有人放回码后再来看看，或者排队等码'}
                    </span>
                  ) : null}
                </CardContent>
                <CardFooter onClick={(e) => e.stopPropagation()}>
                  <ClaimButton
                    product={p}
                    user={user}
                    lowTrust={tooLow(p)}
                    loading={claiming === p.key}
                    onClaim={() => doClaim(p)}
                    onDeposit={() => setDepositFor(p)}
                    onQueue={() => setQueueFor(p)}
                  />
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Dialog open={!!claim} onOpenChange={(o) => !o && setClaim(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>领到了 {claim?.product} 的邀请码</DialogTitle>
            <DialogDescription>
              {claim?.mode === 'multi'
                ? `这是 ${claim?.sharer_username} 的邀请码，可以多人使用。`
                : '这个码现在只属于你，已从广场移除。'}
              随时可以在「我的 → 我领到的」里找回。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={claim?.code ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
            <CopyButton value={claim?.code ?? ''} />
          </div>
          {claim?.note ? <p className="text-sm text-muted-foreground">分享者留言：{claim.note}</p> : null}
          {claim?.deposit_cents ? (
            <Alert>
              <Repeat />
              <AlertTitle>记得接力，押金才能退回</AlertTitle>
              <AlertDescription>
                <p>
                  注册好以后，把你自己的 {claim.product} 邀请码放进分享。它被别人领走、过了观察期没人反馈无效，
                  {ldc(claim.deposit_cents)} LDC 押金会原路退回。
                </p>
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => {
                    setClaim(null)
                    onGoShare()
                  }}
                >
                  去放回我的码
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setReporting(claim)
                setClaim(null)
              }}
            >
              码用不了？
            </Button>
            <Button variant="outline" onClick={doThank} disabled={thanked}>
              <Heart />
              {thanked ? '已感谢' : '感谢分享者'}
            </Button>
            <Button onClick={() => setClaim(null)}>好的</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReportDialog
        claimId={reporting?.id ?? null}
        product={reporting?.product}
        returnable
        onClose={() => setReporting(null)}
        onDone={onChanged}
      />
      <Dialog open={!!depositFor} onOpenChange={(o) => !o && !paying && setDepositFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>领 {depositFor?.name} 要先付押金</DialogTitle>
            <DialogDescription>
              这是接力产品：领码前通过 LINUX DO Credit 付 {ldc(depositFor?.deposit_cents)} LDC 押金。
            </DialogDescription>
          </DialogHeader>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>付好押金后回到这里，点「领一个」。</li>
            <li>用领到的码注册后，把你自己的 {depositFor?.name} 邀请码放进分享。</li>
            <li>你的码被别人领走、过了观察期没人反馈无效，押金原路退回。</li>
          </ol>
          <p className="text-sm text-muted-foreground">
            没领到码，或领到的码被确认无效，可以在「我的 → 押金」里自己退回。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositFor(null)} disabled={paying}>
              先不领
            </Button>
            <Button onClick={doPay} disabled={paying}>
              {paying ? '正在打开付款页…' : `去付 ${ldc(depositFor?.deposit_cents)} LDC`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!queueFor} onOpenChange={(o) => !o && !paying && setQueueFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>排队等 {queueFor?.name} 的码</DialogTitle>
            <DialogDescription>
              现在池子里没有码。付 {ldc(queueFor?.queue_deposit_cents)} LDC 排队押金（正常押金{' '}
              {ldc(queueFor?.deposit_cents)} 加排队{' '}
              {ldc((queueFor?.queue_deposit_cents ?? 0) - (queueFor?.deposit_cents ?? 0))} LDC），有人放回码时按排队顺序自动发给你。
            </DialogDescription>
          </DialogHeader>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>有人排队时，每放回 3 个码，2 个留给现领的人，1 个按付款先后发给排队的人。码放回 10 分钟没人现领，也直接发给排队的人。</li>
            <li>排到时网页会响铃、弹出系统通知，码会出现在「我的 → 我领到的」。网页开着才能听到提醒，允许通知会更稳。</li>
            <li>用码注册后放回你自己的码，它被别人领走、过了观察期，排队押金全部原路退回。</li>
          </ol>
          <p className="text-sm text-muted-foreground">
            还没排到时，可以在「我的 → 押金」里取消排队，押金全部退回。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQueueFor(null)} disabled={paying}>
              先不排
            </Button>
            <Button onClick={doQueue} disabled={paying}>
              <BellRing />
              {paying ? '正在打开付款页…' : `付 ${ldc(queueFor?.queue_deposit_cents)} LDC 排队`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChainDialog product={chainFor} onClose={() => setChainFor(null)} />
      <RequestProductDialog open={requesting} initialName={query.trim()} onClose={() => setRequesting(false)} />
    </div>
  )
}

function RewardLine({ product: p }: { product: Product }) {
  if (!p.share_reward_cents && !p.claim_reward_cents) return null
  const parts = []
  if (p.share_reward_cents) parts.push(`码首次被领 +${ldc(p.share_reward_cents)}`)
  if (p.claim_reward_cents) parts.push(`每被领一次 +${ldc(p.claim_reward_cents)}`)
  return (
    <span className="flex items-center gap-1 text-foreground">
      <Coins className="size-4" />
      分享奖励 LDC：{parts.join('，')}
    </span>
  )
}

function RelayLine({ product: p }: { product: Product }) {
  if (p.deposit_base_cents === null) return null
  const tiers = p.deposit_tiers
    .map((t) => `${t.level} 级${t.cents ? ` ${ldc(t.cents)}` : '免押金'}`)
    .join('，')
  const mine = p.my_queue_pos
    ? '你的排队押金已付，排到会自动发给你；有码时也可以直接领'
    : p.has_deposit
    ? '你的押金已付，可以领了'
    : p.deposit_cents === null
      ? '你的等级够了，免押金'
      : `你领要付 ${ldc(p.deposit_cents)} LDC，放回你的码被领走后退回`
  return (
    <span className="flex items-start gap-1 text-foreground">
      <Repeat className="mt-0.5 size-4 shrink-0" />
      <span>
        接力产品：押金 {ldc(p.deposit_base_cents)} LDC{tiers ? `（${tiers}）` : ''}。{mine}
      </span>
    </span>
  )
}

function Stat({ label, value }: { label: string; value: number | string | null | undefined }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value ?? 0}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function ClaimButton({
  product,
  user,
  lowTrust,
  loading,
  onClaim,
  onDeposit,
  onQueue,
}: {
  product: Product
  user: User | null
  lowTrust: boolean
  loading: boolean
  onClaim: () => void
  onDeposit: () => void
  onQueue: () => void
}) {
  if (!user) {
    return (
      <Button asChild variant="outline" className="w-full">
        <a href={loginUrl}>登录后领取</a>
      </Button>
    )
  }
  if (product.i_claimed) {
    return (
      <Button variant="secondary" className="w-full" disabled>
        你已领过
      </Button>
    )
  }
  const othersAvailable = product.available - product.mine_available
  if (othersAvailable <= 0 && product.my_queue_pos) {
    return (
      <Button variant="secondary" className="w-full" disabled>
        排队中：第 {product.my_queue_pos} 位
      </Button>
    )
  }
  if (
    othersAvailable <= 0 &&
    product.available <= 0 &&
    product.queue_deposit_cents !== null &&
    !lowTrust &&
    !product.has_deposit
  ) {
    return (
      <Button variant="outline" className="w-full" onClick={onQueue}>
        <BellRing />
        付 {ldc(product.queue_deposit_cents)} LDC 排队
      </Button>
    )
  }
  if (othersAvailable <= 0) {
    return (
      <Button variant="secondary" className="w-full" disabled>
        {product.available > 0 ? '只剩你自己的码' : product.deposit_base_cents !== null ? '暂无可领，稍后再试' : '暂无可领'}
      </Button>
    )
  }
  if (lowTrust) {
    return (
      <Button variant="secondary" className="w-full" disabled>
        需要 {product.min_trust_level} 级才能领
      </Button>
    )
  }
  if (product.deposit_cents && !product.has_deposit) {
    return (
      <Button className="w-full" onClick={onDeposit} disabled={lowTrust}>
        付 {ldc(product.deposit_cents)} LDC 押金后领取
      </Button>
    )
  }
  return (
    <Button className="w-full" onClick={onClaim} disabled={loading || lowTrust}>
      {loading ? '领取中…' : '领一个'}
    </Button>
  )
}
