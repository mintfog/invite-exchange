import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, LogIn, LogOut, Ticket } from 'lucide-react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'

import { api, ApiError, loginUrl, type Limits, type User } from '@/lib/api'
import { SquarePage } from '@/pages/square'
import { SharePage } from '@/pages/share'
import { MinePage } from '@/pages/mine'
import { AdminPage } from '@/pages/admin'
import { QueueWatcher } from '@/components/queue-watcher'
import { SiteNotice } from '@/components/site-notice'

type Tab = 'square' | 'share' | 'mine' | 'admin'
const TABS: Tab[] = ['square', 'share', 'mine', 'admin']

const LOGIN_ERRORS: Record<string, string> = {
  state: '登录超时或被打断，请再试一次',
  token: 'LinuxDO 授权失败，请再试一次',
  user: '没拿到 LinuxDO 账号信息，请再试一次',
  blocked: '这个 LinuxDO 账号已被禁言或未激活，不能登录',
}

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '') as Tab
  return TABS.includes(h) ? h : 'square'
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [version, setVersion] = useState(0)
  const [testLogin, setTestLogin] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [testPassword, setTestPassword] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  const loadMe = useCallback(
    () =>
      api.me().then((r) => {
        setUser(r.user)
        setLimits(r.limits)
        setTestLogin(r.test_login)
      }),
    [],
  )

  useEffect(() => {
    loadMe()
      .catch(() => toast.error('连不上服务器'))
      .finally(() => setReady(true))

    const params = new URLSearchParams(window.location.search)
    const err = params.get('login_error')
    if (err) {
      toast.error(LOGIN_ERRORS[err] ?? '登录失败')
      window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    }
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [loadMe])

  const go = (t: string) => {
    setTab(t as Tab)
    window.history.replaceState(null, '', `#${t}`)
  }

  const loginAsTest = async () => {
    setTestBusy(true)
    try {
      await api.testLogin(testPassword)
      await loadMe()
      setTestOpen(false)
      setTestPassword('')
      refresh()
      toast('已用测试账号登录')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '登录失败')
    } finally {
      setTestBusy(false)
    }
  }

  const logout = async () => {
    await api.logout().catch(() => {})
    setUser(null)
    refresh()
    toast('已退出登录')
  }

  return (
    <div className="min-h-svh bg-background">
      <Tabs value={tab} onValueChange={go} className="gap-0">
        <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
            <a href="#square" onClick={() => go('square')} className="flex items-center gap-2 font-semibold">
              <Ticket className="size-5" />
              <span>邀请码交换</span>
            </a>
            <TabsList className="ml-2 hidden sm:inline-flex">
              <TabsTrigger value="square">广场</TabsTrigger>
              <TabsTrigger value="share">分享邀请码</TabsTrigger>
              <TabsTrigger value="mine">我的</TabsTrigger>
              {user?.is_admin ? <TabsTrigger value="admin">管理</TabsTrigger> : null}
            </TabsList>
            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
              <SiteNotice />
              {!ready ? null : user ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="gap-2 px-2">
                      <Avatar className="size-7">
                        {user.avatar_url ? <AvatarImage src={user.avatar_url} alt={user.username} /> : null}
                        <AvatarFallback>{user.username.slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="hidden text-sm sm:inline">{user.username}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel className="flex items-center justify-between">
                      <span>{user.username}</span>
                      <Badge variant="outline">信任等级 {user.trust_level}</Badge>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => go('mine')}>我的邀请码</DropdownMenuItem>
                    {user.is_admin ? <DropdownMenuItem onSelect={() => go('admin')}>管理员</DropdownMenuItem> : null}
                    <DropdownMenuItem onSelect={logout}>
                      <LogOut />
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <div className="flex items-center gap-2">
                  {testLogin ? (
                    <Button size="sm" variant="ghost" onClick={() => setTestOpen(true)}>
                      <FlaskConical />
                      <span className="hidden sm:inline">测试账号</span>
                    </Button>
                  ) : null}
                  <Button asChild size="sm">
                    <a href={loginUrl}>
                      <LogIn />
                      用 LINUX DO 登录
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </div>
          <div className="mx-auto max-w-5xl px-4 pb-3 sm:hidden">
            <TabsList className="w-full">
              <TabsTrigger value="square">广场</TabsTrigger>
              <TabsTrigger value="share">分享</TabsTrigger>
              <TabsTrigger value="mine">我的</TabsTrigger>
              {user?.is_admin ? <TabsTrigger value="admin">管理</TabsTrigger> : null}
            </TabsList>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 py-8">
          <TabsContent value="square">
            <SquarePage user={user} limits={limits} version={version} onChanged={refresh} onGoShare={() => go('share')} />
          </TabsContent>
          <TabsContent value="share">
            <SharePage user={user} limits={limits} version={version} onShared={() => { refresh(); go('mine') }} />
          </TabsContent>
          <TabsContent value="mine">
            <MinePage user={user} version={version} onChanged={refresh} />
          </TabsContent>
          {user?.is_admin ? (
            <TabsContent value="admin">
              <AdminPage version={version} onChanged={refresh} />
            </TabsContent>
          ) : null}
        </main>
      </Tabs>

      <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-muted-foreground">
        码池里的邀请码对所有人隐藏，只有领取人和分享者能看到。码用不了可以在「我的 → 我领到的」里反馈。
      </footer>
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>用测试账号登录</DialogTitle>
            <DialogDescription>
              测试账号不需要 LinuxDO，是一个普通账号，可以拿来试分享和领取，不能进管理页，也不会收到 LDC。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (testPassword) loginAsTest()
            }}
          >
            <Label htmlFor="test-password">测试账号密码</Label>
            <Input
              id="test-password"
              type="password"
              autoComplete="current-password"
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
            />
          </form>
          <DialogFooter>
            <Button disabled={testBusy || !testPassword} onClick={() => loginAsTest()}>
              登录测试账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QueueWatcher user={user} version={version} onServed={refresh} onGoShare={() => go('share')} />
      <Toaster position="top-center" />
    </div>
  )
}
