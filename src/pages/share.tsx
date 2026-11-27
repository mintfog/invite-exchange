import { useEffect, useState, type FormEvent } from 'react'
import { Coins } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { RequestProductDialog } from '@/components/request-product-dialog'

import { api, ApiError, ldc, loginUrl, type Limits, type Product, type User } from '@/lib/api'

type Props = { user: User | null; limits: Limits | null; version: number; onShared: () => void }

export function SharePage({ user, limits, version, onShared }: Props) {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [key, setKey] = useState('')
  const [codes, setCodes] = useState('')
  const [uses, setUses] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    api
      .products()
      .then((r) => setProducts([...r.products].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))))
      .catch(() => setProducts([]))
  }, [version])

  const product = products?.find((p) => p.key === key) ?? null
  const multi = product?.mode === 'multi'
  const lines = multi ? (codes.trim() ? [codes.trim()] : []) : codes.split('\n').map((s) => s.trim()).filter(Boolean)
  const left =
    product && product.max_codes_per_user !== null ? Math.max(0, product.max_codes_per_user - product.mine_codes) : null
  const blocked = !!product && ((multi && product.mine_codes > 0) || left === 0)

  if (!user) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>登录后才能分享</CardTitle>
          <CardDescription>用 LinuxDO 账号登录，分享出去的码谁领走了、有没有道谢，你都能看到。</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <a href={loginUrl}>用 LINUX DO 登录</a>
          </Button>
        </CardFooter>
      </Card>
    )
  }

  const pick = (k: string) => {
    setKey(k)
    setCodes('')
    setUses('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!product) return
    setBusy(true)
    try {
      const r = await api.share({
        product_key: product.key,
        codes: multi ? codes.trim() : codes,
        note,
        uses: multi && uses.trim() ? Number(uses) : undefined,
      })
      if (r.added === 0) {
        toast.error('这些码已经在池子里了')
      } else {
        toast(`已放入 ${r.added} 个码${r.duplicates ? `，${r.duplicates} 个重复已跳过` : ''}`, {
          description: r.relayed ? '已记为接力：这个码被别人领走后，你的押金会自动退回' : undefined,
        })
        setCodes('')
        setUses('')
        setNote('')
        onShared()
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '分享失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>分享邀请码</CardTitle>
        <CardDescription>
          码会藏起来，别人只能看到产品名和剩余数量。系统会随机轮流把大家的码发给新用户，每个分享者都能被用到。
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Label>选择产品</Label>
            {products === null ? (
              <Skeleton className="h-10" />
            ) : products.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有产品。可以申请一个，管理员通过后就能在这里选。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {products.map((p) => (
                  <Button
                    key={p.key}
                    type="button"
                    size="sm"
                    variant={p.key === key ? 'default' : 'outline'}
                    onClick={() => pick(p.key)}
                  >
                    {p.name}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              没有你要的产品？
              <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => setRequesting(true)}>
                申请新产品
              </Button>
            </div>
          </div>

          {product ? (
            <>
              <Alert>
                <AlertTitle className="flex flex-wrap items-center gap-2">
                  {product.name}
                  <Badge variant="outline">
                    {multi ? `每人一个码 · 每码最多 ${product.max_uses} 人用` : '一次性码'}
                  </Badge>
                </AlertTitle>
                <AlertDescription>
                  {product.description ? <p>{product.description}</p> : null}
                  <p>
                    {multi
                      ? '每人只能放一个码。填上还能用几次，每被领一次自动减一，你也可以随时在「我的」里改。'
                      : left !== null
                        ? `每个码只发给一个人。每人最多放 ${product.max_codes_per_user} 个，你还能放 ${left} 个。`
                        : '每个码只发给一个人，可以一次放多个。'}
                  </p>
                  {product.share_reward_cents || product.claim_reward_cents ? (
                    <p className="flex items-center gap-1 text-foreground">
                      <Coins className="size-4" />
                      {[
                        product.share_reward_cents ? `码首次被领、没人反馈无效，奖励 ${ldc(product.share_reward_cents)} LDC` : '',
                        product.claim_reward_cents ? `每被领一次再奖励 ${ldc(product.claim_reward_cents)} LDC` : '',
                      ]
                        .filter(Boolean)
                        .join('；')}
                    </p>
                  ) : null}
                </AlertDescription>
              </Alert>

              {blocked ? (
                <p className="text-sm text-muted-foreground">
                  {multi
                    ? `你已经分享过 ${product.name} 的码了，可以在「我的」里改剩余次数。`
                    : `你在 ${product.name} 的名额已经用完，撤回旧码后可以再放。`}
                </p>
              ) : multi ? (
                <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="code">你的邀请码</Label>
                    <Input
                      id="code"
                      value={codes}
                      onChange={(e) => setCodes(e.target.value)}
                      placeholder="邀请码或邀请链接"
                      className="font-mono"
                      maxLength={200}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="uses">还能用几次</Label>
                    <Input
                      id="uses"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={product.max_uses}
                      value={uses}
                      onChange={(e) => setUses(e.target.value)}
                      placeholder={String(product.max_uses)}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="codes">邀请码</Label>
                  <Textarea
                    id="codes"
                    value={codes}
                    onChange={(e) => setCodes(e.target.value)}
                    placeholder={'一行一个，每个码都是独立的\nABCD-1234\nEFGH-5678'}
                    className="min-h-32 font-mono"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    识别到 {lines.length} 个。24 小时内最多分享 {limits?.maxSharesPerDay ?? 30} 个。
                    {product.has_pattern ? ' 格式不对的码会被拒绝。' : ''}
                  </p>
                </div>
              )}

              {blocked ? null : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="note">留言（可选）</Label>
                  <Input
                    id="note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="比如：注册时选中国区；用完记得点感谢"
                    maxLength={200}
                  />
                </div>
              )}
            </>
          ) : null}
        </CardContent>
        {product && !blocked ? (
          <CardFooter className="mt-6">
            <Button type="submit" className="w-full" disabled={busy || lines.length === 0}>
              {busy ? '提交中…' : multi ? '放入码池' : `放入码池（${lines.length} 个）`}
            </Button>
          </CardFooter>
        ) : null}
      </form>
      <RequestProductDialog open={requesting} onClose={() => setRequesting(false)} />
    </Card>
  )
}
