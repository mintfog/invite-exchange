import { useEffect, useState } from 'react'
import { Heart } from 'lucide-react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { CopyButton } from '@/components/copy-button'
import { api, ApiError, loginUrl, timeAgo, type Claim, type SharedCode, type SharedSummary, type User } from '@/lib/api'

type Props = { user: User | null; version: number; onChanged: () => void }

export function MinePage({ user, version, onChanged }: Props) {
  const [shared, setShared] = useState<SharedCode[] | null>(null)
  const [summary, setSummary] = useState<SharedSummary | null>(null)
  const [claims, setClaims] = useState<Claim[] | null>(null)

  useEffect(() => {
    if (!user) return
    api
      .myShared()
      .then((r) => {
        setShared(r.codes)
        setSummary(r.summary)
      })
      .catch(() => setShared([]))
    api
      .myClaimed()
      .then((r) => setClaims(r.claims))
      .catch(() => setClaims([]))
  }, [user, version])

  if (!user) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>登录后查看</CardTitle>
          <CardDescription>这里会列出你分享的码被谁领走了，以及你领到的码。</CardDescription>
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

  return (
    <Tabs defaultValue="shared" className="gap-6">
      <TabsList>
        <TabsTrigger value="shared">我分享的</TabsTrigger>
        <TabsTrigger value="claimed">我领到的</TabsTrigger>
      </TabsList>

      <TabsContent value="shared" className="flex flex-col gap-6">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="还在池子里" value={summary?.available} />
          <Stat label="已被领走" value={summary?.claimed} />
          <Stat label="收到感谢" value={summary?.thanks} icon />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>分享记录</CardTitle>
            <CardDescription>被领走的码会显示领取人；对方点了感谢，这里会亮起红心。</CardDescription>
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
                    <TableHead>状态</TableHead>
                    <TableHead>领取人</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shared.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.product}</TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">{c.code}</TableCell>
                      <TableCell>
                        {c.status === 'claimed' ? (
                          <Badge variant="secondary">已领走 · {timeAgo(c.claimed_at!)}</Badge>
                        ) : (
                          <Badge variant="outline">在池中</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {c.claimer_username ? (
                          <div className="flex items-center gap-2">
                            <Avatar className="size-6">
                              {c.claimer_avatar ? <AvatarImage src={c.claimer_avatar} /> : null}
                              <AvatarFallback className="text-xs">
                                {c.claimer_username.slice(0, 1).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-sm">{c.claimer_username}</span>
                            {c.thanked_at ? <Heart className="size-4 fill-foreground" aria-label="已感谢" /> : null}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.status === 'available' ? (
                          <Button variant="ghost" size="sm" onClick={() => withdraw(c.id)}>
                            撤回
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
      </TabsContent>

      <TabsContent value="claimed">
        <Card>
          <CardHeader>
            <CardTitle>我领到的</CardTitle>
            <CardDescription>这些码只有你和分享者看得到。用上了别忘了说声谢谢。</CardDescription>
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
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.product}</span>
                        <span className="text-xs text-muted-foreground">
                          来自 {c.sharer_username} · {timeAgo(c.claimed_at)}
                        </span>
                      </div>
                      <code className="truncate rounded-md bg-muted px-2 py-1 font-mono text-sm">{c.code}</code>
                      {c.note ? <span className="text-xs text-muted-foreground">留言：{c.note}</span> : null}
                    </div>
                    <div className="flex gap-2">
                      <CopyButton value={c.code} label="复制" />
                      <Button variant="outline" size="sm" disabled={!!c.thanked_at} onClick={() => thank(c.id)}>
                        <Heart className={c.thanked_at ? 'fill-foreground' : undefined} />
                        {c.thanked_at ? '已感谢' : '感谢'}
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

function Stat({ label, value, icon }: { label: string; value: number | null | undefined; icon?: boolean }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-1">
          {icon ? <Heart className="size-3.5" /> : null}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value ?? 0}</CardTitle>
      </CardHeader>
    </Card>
  )
}
