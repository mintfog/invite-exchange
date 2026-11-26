// 构建前检查 shadcn/ui 官方组件是否已安装；缺哪个就用官方命令行装哪个。
// 组件全部来自 ui.shadcn.com，不手写。装好后建议提交到仓库，之后构建就不再联网。
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

export const COMPONENTS = [
  'button', 'card', 'badge', 'input', 'textarea', 'label', 'tabs', 'dialog',
  'avatar', 'dropdown-menu', 'table', 'sonner', 'separator', 'skeleton', 'alert',
]

const missing = COMPONENTS.filter((n) => !existsSync(`src/components/ui/${n}.tsx`))
if (missing.length) {
  console.log(`[ui] 安装 shadcn/ui 组件：${missing.join(' ')}`)
  execSync(`npx shadcn add ${missing.join(' ')} --yes --overwrite`, { stdio: 'inherit' })
} else {
  console.log('[ui] shadcn/ui 组件已齐全')
}
