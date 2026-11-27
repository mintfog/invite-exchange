import { useState } from 'react'
import { Megaphone } from 'lucide-react'

import { Button } from '@/components/ui/button'
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

const NOTICE_KEY = 'invite-exchange:site-notice:v1'

const links = [
  { label: '私聊站长 @codeover', href: 'https://linux.do/u/codeover/summary' },
  { label: '源码仓库 mintfog/invite-exchange', href: 'https://github.com/mintfog/invite-exchange' },
  { label: '原作者 @StarFox', href: 'https://linux.do/u/starfox/summary' },
]

export function SiteNotice() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(NOTICE_KEY) !== 'seen'
    } catch {
      return true
    }
  })

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      try {
        localStorage.setItem(NOTICE_KEY, 'seen')
      } catch {}
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2" aria-label="站点公告" title="站点公告">
          <Megaphone aria-hidden="true" />
          <span className="hidden sm:inline">公告</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>站点公告</DialogTitle>
          <DialogDescription>使用邀请码交换时遇到问题，请在 LINUX DO 私聊站长。</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {links.map(({ label, href }) => (
            <li key={href}>
              <Button variant="ghost" asChild className="w-full justify-start">
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <DialogClose asChild>
            <Button>知道了</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
