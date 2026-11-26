import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { api, ApiError, loginUrl, type Limits, type User } from '@/lib/api'

type Props = { user: User | null; limits: Limits | null; version: number; onShared: () => void }

export function SharePage({ user, limits, version, onShared }: Props) {
  const [product, setProduct] = useState('')
  const [codes, setCodes] = useState('')
  const [note, setNote] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .products()
      .then((r) => setNames(r.products.map((p) => p.name)))
      .catch(() => {})
  }, [version])

  const lines = codes.split('\n').map((s) => s.trim()).filter(Boolean)

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

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api.share({ product, codes, note })
      if (r.added === 0) {
        toast.error('这些码已经在池子里了')
      } else {
        toast(`已放入 ${r.added} 个码${r.duplicates ? `，${r.duplicates} 个重复已跳过` : ''}`)
        setCodes('')
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
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>分享邀请码</CardTitle>
        <CardDescription>
          码会藏起来，别人只能看到产品名和数量。每被领走一个，你会在「我的」里看到。
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="product">产品</Label>
            <Input
              id="product"
              list="product-names"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="比如 Muse、ChatterFly、小豆"
              maxLength={40}
              required
            />
            <datalist id="product-names">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">已有的产品会自动提示，选它就能合并到同一个码池。</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="codes">邀请码</Label>
            <Textarea
              id="codes"
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
              placeholder={'一行一个，最多 20 个\nABCD-1234\nhttps://example.com/invite/xyz'}
              className="min-h-32 font-mono"
              required
            />
            <p className="text-xs text-muted-foreground">
              识别到 {lines.length} 个。邀请链接也可以。24 小时内最多分享 {limits?.maxSharesPerDay ?? 30} 个。
            </p>
          </div>
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
        </CardContent>
        <CardFooter className="mt-6">
          <Button type="submit" className="w-full" disabled={busy || !product.trim() || lines.length === 0}>
            {busy ? '提交中…' : `放入码池（${lines.length} 个）`}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
