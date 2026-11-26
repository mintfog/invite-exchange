import { useState } from 'react'
import { toast } from 'sonner'

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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { api, ApiError, type Mode } from '@/lib/api'

// 普通用户申请一个广场上还没有的产品，管理员审核后上架
export function RequestProductDialog({
  open,
  initialName = '',
  onClose,
  onDone,
}: {
  open: boolean
  initialName?: string
  onClose: () => void
  onDone?: () => void
}) {
  const [name, setName] = useState(initialName)
  const [mode, setMode] = useState<Mode>('single')
  const [uses, setUses] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastOpen, setLastOpen] = useState(open)

  // 每次打开时用搜索框里的字填好产品名
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) setName(initialName)
  }

  const submit = async () => {
    const usesNum = uses.trim() ? Number(uses) : undefined
    if (mode === 'multi' && usesNum !== undefined && !(Number.isInteger(usesNum) && usesNum >= 1 && usesNum <= 1000)) {
      return toast.error('每个码能给几人用需要 1 到 1000')
    }
    setBusy(true)
    try {
      await api.requestProduct({
        name,
        mode,
        max_uses: mode === 'multi' ? usesNum : undefined,
        description: description.trim() || undefined,
      })
      toast(`已提交 ${name.trim()} 的申请，管理员通过后会出现在广场上`)
      setName('')
      setMode('single')
      setUses('')
      setDescription('')
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没提交成功')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>申请新产品</DialogTitle>
          <DialogDescription>
            广场上没有你想分享的产品，可以在这里申请。管理员通过后它会出现在广场上，你在「我的 → 我的申请」里能看到进度。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="req-name">产品名</Label>
            <Input
              id="req-name"
              maxLength={40}
              placeholder="比如 Muse、ChatterFly"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>邀请码怎么用</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant={mode === 'single' ? 'default' : 'outline'} onClick={() => setMode('single')}>
                一次性码
              </Button>
              <Button type="button" variant={mode === 'multi' ? 'default' : 'outline'} onClick={() => setMode('multi')}>
                多人可用码
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === 'single'
                ? '每个码只能给一个人用，一个人可能有好几个码。'
                : '每人只有一个码，可以给很多人用。'}
              不确定就随便选，管理员会再核对。
            </p>
          </div>
          {mode === 'multi' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="req-uses">每个码能给几人用（可选）</Label>
              <Input
                id="req-uses"
                type="number"
                min={1}
                max={1000}
                placeholder="比如 30"
                value={uses}
                onChange={(e) => setUses(e.target.value)}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="req-desc">说明（可选）</Label>
            <Textarea
              id="req-desc"
              maxLength={200}
              placeholder="这是什么产品、在哪里填邀请码、双方有什么好处"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? '提交中…' : '提交申请'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
