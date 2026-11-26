import { useEffect, useMemo, useState } from 'react'
import { Gift, Heart, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Skeleton } from '@/components/ui/skeleton'

import { CopyButton } from '@/components/copy-button'
import { api, ApiError, loginUrl, timeAgo, type Limits, type NewClaim, type Product, type Totals, type User } from '@/lib/api'

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

  const doClaim = async (p: Product) => {
    setClaiming(p.key)
    try {
      const r = await api.claim(p.key)
      setThanked(false)
      setClaim(r.claim)
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '领取失败')
      if (e instanceof ApiError && e.code === 'empty') onChanged()
    } finally {
      setClaiming(null)
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
          用 LinuxDO 账号登录，每个产品领一个。码被领走后立刻销毁，不再给别人看；分享者会看到是谁领走、有没有道谢。
        </p>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <Stat label="池中可领" value={totals?.available} />
        <Stat label="已送出" value={totals?.claimed} />
        <Stat label="分享者" value={totals?.sharers} />
      </section>

      {lowTrust ? (
        <Alert>
          <AlertTitle>你的 LinuxDO 信任等级还不够领码</AlertTitle>
          <AlertDescription>
            需要达到 {limits?.minTrustLevel} 级，你现在是 {user?.trust_level} 级。可以先分享自己多余的码。
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
              <CardTitle>{query ? '没有找到这个产品' : '广场还是空的'}</CardTitle>
              <CardDescription>有多余的邀请码？分享出来，第一个产品就由你创建。</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button onClick={onGoShare}>分享邀请码</Button>
            </CardFooter>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <Card key={p.key}>
                <CardHeader>
                  <CardTitle className="truncate">{p.name}</CardTitle>
                  <CardDescription>最近分享于 {timeAgo(p.last_shared_at)}</CardDescription>
                  <CardAction>
                    <Badge variant={p.available > 0 ? 'default' : 'secondary'}>
                      {p.available > 0 ? `可领 ${p.available}` : '已领完'}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Heart className="size-4" />
                    已送出 {p.claimed}
                  </span>
                  {p.mine_available > 0 ? <span>其中 {p.mine_available} 个是你分享的</span> : null}
                </CardContent>
                <CardFooter>
                  <ClaimButton
                    product={p}
                    user={user}
                    lowTrust={lowTrust}
                    loading={claiming === p.key}
                    onClaim={() => doClaim(p)}
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
              这个码现在只属于你，已从广场移除。随时可以在「我的 → 我领到的」里找回。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={claim?.code ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
            <CopyButton value={claim?.code ?? ''} />
          </div>
          {claim?.note ? <p className="text-sm text-muted-foreground">分享者留言：{claim.note}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={doThank} disabled={thanked}>
              <Heart />
              {thanked ? '已感谢' : '感谢分享者'}
            </Button>
            <Button onClick={() => setClaim(null)}>好的</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
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
}: {
  product: Product
  user: User | null
  lowTrust: boolean
  loading: boolean
  onClaim: () => void
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
  if (othersAvailable <= 0) {
    return (
      <Button variant="secondary" className="w-full" disabled>
        {product.available > 0 ? '只剩你自己的码' : '暂无可领'}
      </Button>
    )
  }
  return (
    <Button className="w-full" onClick={onClaim} disabled={loading || lowTrust}>
      {loading ? '领取中…' : '领一个'}
    </Button>
  )
}
