import { useState } from 'react'
import { Megaphone } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { loginUrl } from '@/lib/api'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

const NOTICE_KEY = 'invite-exchange:site-notice:v2'

const AUTHOR_SITE = 'https://exchange.fshark.cloud/'

export function SiteNotice({ isAdmin, showLogin }: { isAdmin: boolean; showLogin: boolean }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(NOTICE_KEY) !== 'seen'
    } catch {
      return true
    }
  })

  function handleOpenChange(nextOpen: boolean) {
    if (!isAdmin) return
    setOpen(nextOpen)
    if (!nextOpen) {
      try {
        localStorage.setItem(NOTICE_KEY, 'seen')
      } catch {}
    }
  }

  return (
    <Dialog open={!isAdmin || open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2" aria-label="站点公告" title="站点公告">
          <Megaphone aria-hidden="true" />
          <span className="hidden sm:inline">公告</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={isAdmin}
        onEscapeKeyDown={(event) => { if (!isAdmin) event.preventDefault() }}
        onInteractOutside={(event) => { if (!isAdmin) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>站点公告</DialogTitle>
          <DialogDescription>原作者服务器已恢复，请前往原作者网站继续接力。本站已停止发码、领码和接收新押金。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {showLogin && <Button variant="ghost" asChild><a href={loginUrl}>管理员登录</a></Button>}
          {isAdmin && <DialogClose asChild><Button variant="outline">关闭公告</Button></DialogClose>}
          <Button asChild><a href={AUTHOR_SITE}>前往原作者网站</a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
