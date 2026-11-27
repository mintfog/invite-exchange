import { useEffect, useRef, useState } from 'react'
import { BellRing, Repeat } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CopyButton } from '@/components/copy-button'
import { api, type QueueServed, type User } from '@/lib/api'
import { chime, unlockAudio } from '@/lib/queue-alerts'

const POLL_MS = 15_000

function seenKey(userId: number) {
  return `queue-served-seen:${userId}`
}

function readSeen(userId: number): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenKey(userId)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function markSeen(userId: number, ids: string[]) {
  const seen = readSeen(userId)
  ids.forEach((id) => seen.add(id))
  localStorage.setItem(seenKey(userId), JSON.stringify([...seen].slice(-100)))
}

/** 排队中时每隔一会儿看一次有没有排到；排到了响铃、弹系统通知、弹窗给码 */
export function QueueWatcher({
  user,
  version,
  onServed,
  onGoShare,
}: {
  user: User | null
  version: number
  onServed: () => void
  onGoShare: () => void
}) {
  const [shown, setShown] = useState<QueueServed[]>([])
  const onServedRef = useRef(onServed)
  useEffect(() => {
    onServedRef.current = onServed
  }, [onServed])

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    return () => window.removeEventListener('pointerdown', unlockAudio)
  }, [])

  useEffect(() => {
    if (!user) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      clearTimeout(timer)
      try {
        const r = await api.myQueue()
        if (stopped) return
        const seen = readSeen(user.id)
        const fresh = r.served.filter((s) => !seen.has(s.id))
        if (fresh.length) {
          markSeen(user.id, fresh.map((s) => s.id))
          setShown((cur) => [...cur, ...fresh.filter((f) => !cur.some((c) => c.id === f.id))])
          chime()
          if ('Notification' in window && Notification.permission === 'granted') {
            for (const s of fresh) {
              try {
                new Notification(`排到了：${s.product}`, { body: '邀请码已经发给你，回到网页查看' })
              } catch {
                // 有的手机浏览器不能直接 new Notification
              }
            }
          }
          onServedRef.current()
        }
        if (r.waiting.length) timer = setTimeout(tick, POLL_MS)
      } catch {
        if (!stopped) timer = setTimeout(tick, POLL_MS * 2)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    void tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user, version])

  const current = shown[0] ?? null
  const close = () => setShown((cur) => cur.slice(1))

  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="size-5" />
            排到了：{current?.product}
          </DialogTitle>
          <DialogDescription>
            你排队的邀请码已经发给你了，随时可以在「我的 → 我领到的」里找回。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={current?.code ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
          <CopyButton value={current?.code ?? ''} />
        </div>
        <Alert>
          <Repeat />
          <AlertTitle>记得接力，押金才能退回</AlertTitle>
          <AlertDescription>
            注册好以后，把你自己的 {current?.product} 邀请码放进分享。满 5 小时无人领，或被领走且过了观察期没人反馈无效，排队押金会全额原路退回。
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              close()
              onGoShare()
            }}
          >
            去放回我的码
          </Button>
          <Button onClick={close}>好的</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
