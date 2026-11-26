import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error('复制失败，请手动选中复制')
    }
  }
  return (
    <Button type="button" variant="outline" size={label ? 'sm' : 'icon'} onClick={copy} aria-label="复制">
      {done ? <Check /> : <Copy />}
      {label ? (done ? '已复制' : label) : null}
    </Button>
  )
}
