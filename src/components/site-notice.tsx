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

const AUTHOR_SITE = 'https://exchange.fshark.cloud/'

export function SiteNotice() {
  const [open, setOpen] = useState(true)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2" aria-label="站点公告" title="站点公告">
          <Megaphone aria-hidden="true" />
          <span className="hidden sm:inline">公告</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>站点公告</DialogTitle>
          <DialogDescription>原作者服务器已恢复，请前往原作者网站继续接力。本站已停止发码、领码和接收新押金。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">关闭公告</Button></DialogClose>
          <Button asChild><a href={AUTHOR_SITE}>前往原作者网站</a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
