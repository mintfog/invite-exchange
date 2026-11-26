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

// 领取人反馈「这个码用不了」。领到 24 小时内可以直接退还，不用等管理员。
export function ReportDialog({
  claimId,
  product,
  returnable = false,
  onlyReturn = false,
  onClose,
  onDone,
}: {
  claimId: string | null
  product?: string
  /** 还能自己退还（领到 24 小时内） */
  returnable?: boolean
  /** 已经反馈过了，只剩退还可选 */
  onlyReturn?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const doReturn = async () => {
    if (!claimId) return
    setBusy(true)
    try {
      const r = await api.returnClaim(claimId, reason)
      toast(r.invalidated ? '已退还，这个码作废了，你可以去广场再领一个' : '已退还，你可以去广场再领一个')
      setReason('')
      onDone()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '没退还成功')
    } finally {
      setBusy(false)
    }
  }

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
          <DialogTitle>{product ? `${product} 的` : ''}邀请码用不了？</DialogTitle>
          <DialogDescription>
            {returnable
              ? '可以直接退还：这次领取作废，码不会再发给别人，分享者拿不到这个码的奖励；付过押金的话押金回到「已付」，可以再领一个或退回。30 天内最多自己退还 3 次，请只在码确实用不了时退还。'
              : '管理员会核实。确认无效后，这个码会被撤下，分享者拿不到奖励，你也可以再领一个。'}
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
          {returnable && !onlyReturn ? (
            <Button variant="outline" onClick={submit} disabled={busy}>
              只反馈给管理员
            </Button>
          ) : null}
          {returnable ? (
            <Button onClick={doReturn} disabled={busy}>
              {busy ? '退还中…' : '退还这个码'}
            </Button>
          ) : (
            <Button onClick={submit} disabled={busy}>
              {busy ? '提交中…' : '提交反馈'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
