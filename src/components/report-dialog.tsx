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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { api, ApiError } from '@/lib/api'

// 领取人反馈「这个码用不了」
export function ReportDialog({
  claimId,
  product,
  onClose,
  onDone,
}: {
  claimId: string | null
  product?: string
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!claimId) return
    setBusy(true)
    try {
      await api.report(claimId, reason)
      toast('已反馈，管理员确认后你可以再领一个')
      setReason('')
      onDone()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没提交成功')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!claimId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>反馈{product ? ` ${product} ` : ''}邀请码无效</DialogTitle>
          <DialogDescription>
            管理员会核实。确认无效后，这个码会被撤下，分享者拿不到奖励，你也可以再领一个。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="report-reason">哪里不对（可选）</Label>
          <Textarea
            id="report-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="比如：注册时提示邀请码不存在 / 已被用完"
            maxLength={200}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? '提交中…' : '提交反馈'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
