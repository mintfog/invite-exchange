import { useEffect, useState } from 'react'
import { ChevronRight, Hourglass, Inbox, UserRound } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Chain, type Product } from '@/lib/api'

/** 接力链图：每条正在运作的链，链上的人只显示头像，不显示名字 */
export function ChainDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const [data, setData] = useState<{ key: string; chains: Chain[]; relays: number } | null>(null)
  const key = product?.key ?? null

  useEffect(() => {
    if (!key) return
    let live = true
    api
      .chains(key)
      .then((r) => live && setData({ key, ...r }))
      .catch(() => live && setData({ key, chains: [], relays: 0 }))
    return () => {
      live = false
    }
  }, [key])

  const ready = data && data.key === key ? data : null

  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{product?.name} 的接力链</DialogTitle>
          <DialogDescription>
            {ready
              ? ready.chains.length
                ? `现在有 ${ready.chains.length} 条链在运行，累计接力 ${ready.relays} 次。从左到右是码传递的顺序，最右边是链现在走到的地方。`
                : '现在没有在运行的接力链。'
              : '正在加载…'}
          </DialogDescription>
        </DialogHeader>
        {!ready ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : ready.chains.length ? (
          <div className="flex max-h-[60vh] flex-col overflow-y-auto">
            {ready.chains.map((ch, i) => (
              <div key={i}>
                {i > 0 ? <Separator /> : null}
                <div className="flex flex-col gap-2 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">第 {i + 1} 条</span>
                    <span className="text-muted-foreground">{ch.length} 人</span>
                    <Badge variant={ch.state === 'pool' ? 'default' : 'outline'} className="ml-auto">
                      {ch.state === 'pool' ? '码在池子里，等人领' : '等链尾的人放回码'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto pb-1">
                    {ch.earlier ? (
                      <>
                        <span className="shrink-0 text-xs text-muted-foreground">前面还有 {ch.earlier} 人</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </>
                    ) : null}
                    {ch.nodes.map((n, j) => (
                      <div key={j} className="flex shrink-0 items-center gap-1">
                        {j > 0 ? <ChevronRight className="size-4 text-muted-foreground" /> : null}
                        <Avatar
                          className={`size-8 ${n.me ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
                          title={n.me ? '你' : undefined}
                        >
                          {n.avatar ? <AvatarImage src={n.avatar} alt="" referrerPolicy="no-referrer" /> : null}
                          <AvatarFallback>
                            <UserRound className="size-4" />
                          </AvatarFallback>
                        </Avatar>
                      </div>
                    ))}
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      {ch.state === 'pool' ? <Inbox className="size-4" /> : <Hourglass className="size-4" />}
                      {ch.state === 'pool' ? '池子' : '还没放回'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">只显示头像，不显示名字。带圈的是你。</p>
      </DialogContent>
    </Dialog>
  )
}
