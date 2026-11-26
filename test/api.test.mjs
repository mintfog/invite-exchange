// 本地接口测试：node test/api.test.mjs
// 先跑：npx wrangler dev -c test/wrangler.test.jsonc --port 8799 --var LINUXDO_BASE:http://127.0.0.1:8800
// 脚本会自己在 8800 端口起一个假的 LinuxDO OAuth 服务。
import http from 'node:http'
import assert from 'node:assert/strict'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799'
const ORIGIN = new URL(BASE).origin
let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------- 假 LinuxDO ----------
const fakeUsers = {
  'code-good': { id: 1001, username: 'oauth_user', name: 'OAuth 用户', trust_level: 2, active: true, silenced: false, avatar_template: '/user_avatar/linux.do/oauth_user/{size}/1.png' },
  'code-silenced': { id: 1002, username: 'bad_user', trust_level: 2, active: true, silenced: true },
}
const tokens = {}
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (req.url === '/oauth2/token' && req.method === 'POST') {
      const p = new URLSearchParams(body)
      const auth = req.headers.authorization
      const expected = 'Basic ' + Buffer.from('test-client:test-secret').toString('base64')
      if (auth !== expected || p.get('grant_type') !== 'authorization_code' || !fakeUsers[p.get('code')]) {
        res.writeHead(400).end('{}')
        return
      }
      const t = 'tok-' + p.get('code')
      tokens[t] = fakeUsers[p.get('code')]
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: t }))
      return
    }
    if (req.url === '/api/user') {
      const t = (req.headers.authorization ?? '').replace('Bearer ', '')
      if (!tokens[t]) return res.writeHead(401).end('{}')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(tokens[t]))
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => mock.listen(8800, '127.0.0.1', r))

// ---------- 带 Cookie 的客户端 ----------
class Client {
  jar = {}
  cookie() {
    return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ')
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      const k = kv.slice(0, i)
      const v = kv.slice(i + 1)
      if (/Max-Age=0/i.test(c) || v === '') delete this.jar[k]
      else this.jar[k] = v
    }
  }
  async raw(path, init = {}) {
    const res = await fetch(BASE + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: this.cookie(), ...(init.headers ?? {}) },
    })
    this.store(res)
    return res
  }
  async json(path, method = 'GET', body) {
    const res = await this.raw(path, {
      method,
      headers: method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }
  async devLogin(u, tl = 2) {
    const res = await this.raw(`/api/auth/dev-login?u=${encodeURIComponent(u)}&tl=${tl}`)
    assert.equal(res.status, 302)
    return this
  }
}

try {
  console.log('LinuxDO OAuth')
  {
    const c = new Client()
    const r = await c.raw('/api/auth/login')
    assert.equal(r.status, 302)
    const loc = new URL(r.headers.get('location'))
    assert.equal(loc.origin + loc.pathname, 'http://127.0.0.1:8800/oauth2/authorize')
    assert.equal(loc.searchParams.get('client_id'), 'test-client')
    assert.equal(loc.searchParams.get('response_type'), 'code')
    assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/callback`)
    const state = loc.searchParams.get('state')
    assert.ok(state && c.jar.oauth_state === state)
    ok('登录跳转到 LinuxDO，带 client_id / redirect_uri / state')

    const bad = await c.raw(`/api/auth/callback?code=code-good&state=wrong`)
    assert.match(bad.headers.get('location'), /login_error=state/)
    ok('state 不对时拒绝登录')

    await c.raw('/api/auth/login')
    const st = c.jar.oauth_state
    const cb = await c.raw(`/api/auth/callback?code=code-good&state=${st}`)
    assert.equal(cb.headers.get('location'), '/')
    const me = await c.json('/api/me')
    assert.equal(me.data.user.username, 'oauth_user')
    assert.equal(me.data.user.trust_level, 2)
    assert.equal(me.data.user.avatar_url, 'https://linux.do/user_avatar/linux.do/oauth_user/96/1.png')
    ok('换 token、取用户、建会话都成功')

    const c2 = new Client()
    await c2.raw('/api/auth/login')
    const cb2 = await c2.raw(`/api/auth/callback?code=code-silenced&state=${c2.jar.oauth_state}`)
    assert.match(cb2.headers.get('location'), /login_error=blocked/)
    ok('被禁言的 LinuxDO 账号不能登录')

    const out = await c.json('/api/auth/logout', 'POST')
    assert.equal(out.status, 200)
    assert.equal((await c.json('/api/me')).data.user, null)
    ok('退出登录后会话失效')
  }

  console.log('分享')
  const alice = await new Client().devLogin('alice')
  const bob = await new Client().devLogin('bob')
  const newbie = await new Client().devLogin('newbie', 0)
  {
    const anon = new Client()
    assert.equal((await anon.json('/api/codes', 'POST', { product: 'Muse', codes: 'X' })).status, 401)
    ok('没登录不能分享')

    const noOrigin = await alice.raw('/api/codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'Muse', codes: 'X' }),
    })
    assert.equal(noOrigin.status, 403)
    ok('跨站请求（没有同源 Origin）被拒绝')

    const r = await alice.json('/api/codes', 'POST', { product: '  Muse ', codes: 'MUSE-1\nMUSE-2\nMUSE-2\n\nMUSE-3', note: '选中国区' })
    assert.equal(r.status, 200)
    assert.equal(r.data.added, 3)
    ok('一次分享多个码，重复行自动去掉')

    const dup = await bob.json('/api/codes', 'POST', { product: 'muse', codes: 'MUSE-1\nMUSE-B1' })
    assert.equal(dup.data.added, 1)
    assert.equal(dup.data.duplicates, 1)
    ok('产品名大小写/空格不同也归到同一个码池；已在池里的码不能重复放')

    const list = await new Client().json('/api/products')
    const muse = list.data.products.find((p) => p.key === 'muse')
    assert.equal(muse.name, 'Muse')
    assert.equal(muse.available, 4)
    assert.ok(!JSON.stringify(list.data).includes('MUSE-1'))
    ok('广场只显示产品名和数量，看不到码本身')
  }

  console.log('领取')
  {
    const low = await newbie.json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(low.status, 403)
    assert.equal(low.data.error, 'trust_level')
    ok('信任等级不够不能领')

    const r = await bob.json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(r.status, 200)
    assert.match(r.data.claim.code, /^MUSE-[123]$/)
    ok('bob 领到的是 alice 的码，不会领到自己的')
    const bobCode = r.data.claim.code

    const again = await bob.json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(again.data.error, 'already_claimed')
    ok('同一个产品每人只能领一个')

    const shared = await alice.json('/api/my/shared')
    const row = shared.data.codes.find((c) => c.code === bobCode)
    assert.equal(row.status, 'claimed')
    assert.equal(row.claimer_username, 'bob')
    assert.equal(shared.data.summary.claimed, 1)
    ok('分享者能看到码被谁领走')

    const claimed = await bob.json('/api/my/claimed')
    const cl = claimed.data.claims[0]
    assert.equal(cl.code, bobCode)
    assert.equal(cl.sharer_username, 'alice')
    assert.equal(cl.note, '选中国区')
    const th = await bob.json(`/api/claims/${cl.id}/thanks`, 'POST')
    assert.equal(th.status, 200)
    const th2 = await bob.json(`/api/claims/${cl.id}/thanks`, 'POST')
    assert.equal(th2.status, 409)
    const shared2 = await alice.json('/api/my/shared')
    assert.equal(shared2.data.summary.thanks, 1)
    ok('领取人可以感谢一次，分享者看到感谢数 +1')

    const carol = await new Client().devLogin('carol')
    const steal = await carol.json(`/api/claims/${cl.id}/thanks`, 'POST')
    assert.equal(steal.status, 409)
    ok('别人不能替领取人点感谢')

    const avail = shared2.data.codes.find((c) => c.status === 'available')
    assert.equal((await bob.json(`/api/codes/${avail.id}`, 'DELETE')).status, 409)
    assert.equal((await alice.json(`/api/codes/${avail.id}`, 'DELETE')).status, 200)
    assert.equal((await alice.json(`/api/codes/${row.id}`, 'DELETE')).status, 409)
    ok('只能撤回自己还在池里的码，已领走的不能撤回')

    const onlyMine = await alice.json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(onlyMine.status, 200) // 池里还有 bob 的 MUSE-B1
    const empty = await alice.json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(empty.data.error, 'already_claimed')
  }

  console.log('并发：20 个人同时抢 5 个码')
  {
    const sharer = await new Client().devLogin('sharer')
    await sharer.json('/api/codes', 'POST', { product: '小豆', codes: ['XD-1', 'XD-2', 'XD-3', 'XD-4', 'XD-5'].join('\n') })
    const people = await Promise.all(Array.from({ length: 20 }, (_, i) => new Client().devLogin(`racer${i}`)))
    const results = await Promise.all(people.map((p) => p.json('/api/claim', 'POST', { product_key: '小豆' })))
    const wins = results.filter((r) => r.status === 200).map((r) => r.data.claim.code)
    assert.equal(wins.length, 5)
    assert.equal(new Set(wins).size, 5)
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.data.error === 'empty'))
    ok('正好 5 人领到，5 个码互不相同，其余 15 人提示已领完')

    const p = (await new Client().json('/api/products')).data.products.find((x) => x.key === '小豆')
    assert.equal(p.available, 0)
    assert.equal(p.claimed, 5)
    ok('领完后广场显示 0 可领')
  }

  console.log('防刷')
  {
    const sh = await new Client().devLogin('bulk')
    const codes = Array.from({ length: 20 }, (_, i) => `B-${i}`).join('\n')
    const big = await sh.json('/api/codes', 'POST', { product: 'Bulk', codes: codes + '\nB-extra' })
    assert.equal(big.data.error, 'too_many')
    ok('一次最多放 20 个')
    for (const n of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      await sh.json('/api/codes', 'POST', { product: n, codes: `${n}-a\n${n}-b` })
    }
    const lim = await sh.json('/api/codes', 'POST', { product: 'Bulk', codes })
    assert.equal(lim.data.error, 'share_limit')
    ok('24 小时分享上限生效')

    const grabber = await new Client().devLogin('grabber')
    const got = []
    for (const n of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      got.push(await grabber.json('/api/claim', 'POST', { product_key: n.toLowerCase() }))
    }
    assert.equal(got.filter((r) => r.status === 200).length, 5)
    assert.equal(got[5].data.error, 'claim_limit')
    ok('24 小时领取上限（5 个）生效')
  }

  console.log(`\n全部通过：${passed} 项`)
} catch (e) {
  console.error('\n测试失败：', e)
  process.exitCode = 1
} finally {
  mock.close()
}
