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
// 假 LINUX DO Credit：只记录请求，不会发出真的 LDC
const ldcCalls = []
const ldcSeen = new Set()
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (req.url === '/lpay/distribute' && req.method === 'POST') {
      const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
      if (req.headers.authorization !== 'Basic ' + Buffer.from('ldc-test:ldc-secret').toString('base64')) {
        return send(401, { error_msg: '凭证不对' })
      }
      const b = JSON.parse(body)
      if (ldcSeen.has(b.out_trade_no)) return send(400, { error_msg: '订单号重复' })
      if (b.username === 'poor') return send(400, { error_msg: '用户不存在' })
      ldcSeen.add(b.out_trade_no)
      ldcCalls.push(b)
      return send(200, { error_msg: '', data: { trade_no: String(9000 + ldcCalls.length), out_trade_no: b.out_trade_no } })
    }
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

  const alice = await new Client().devLogin('alice')
  const bob = await new Client().devLogin('bob')
  const newbie = await new Client().devLogin('newbie', 0)
  const boss = await new Client().devLogin('admin')

  console.log('管理员和产品')
  {
    assert.equal((await alice.json('/api/me')).data.user.is_admin, false)
    assert.equal((await boss.json('/api/me')).data.user.is_admin, true)
    ok('ADMIN_USERNAMES 里的账号是管理员，其他人不是')

    assert.equal((await new Client().json('/api/admin/products', 'POST', { name: 'X' })).status, 401)
    const denied = await alice.json('/api/admin/products', 'POST', { name: 'Muse', mode: 'multi', max_uses: 3 })
    assert.equal(denied.status, 403)
    assert.equal((await alice.json('/api/admin/codes')).status, 403)
    assert.equal((await alice.json('/api/admin/users')).status, 403)
    ok('普通用户不能建产品，也看不到管理接口')

    const noProduct = await alice.json('/api/codes', 'POST', { product_key: 'muse', codes: 'X' })
    assert.equal(noProduct.status, 404)
    assert.equal(noProduct.data.error, 'no_product')
    ok('用户不能分享到不存在的产品，也不会自动新建产品')

    const mk = (b) => boss.json('/api/admin/products', 'POST', b)
    assert.equal((await mk({ name: ' Muse ', mode: 'multi', max_uses: 3, description: '每人一个码，可以给 3 人用' })).status, 200)
    assert.equal(
      (await mk({ name: 'ChatterFly', mode: 'single', max_codes_per_user: 3, code_pattern: 'CF-[A-Z0-9]{4}' })).status,
      200,
    )
    assert.equal((await mk({ name: '小豆', mode: 'single' })).status, 200)
    assert.equal((await mk({ name: 'muse', mode: 'single' })).data.error, 'exists')
    assert.equal((await mk({ name: 'Bad', mode: 'single', code_pattern: '([' })).data.error, 'bad_pattern')
    assert.equal((await mk({ name: 'Bad', mode: 'multi', max_uses: 0 })).data.error, 'bad_max_uses')
    ok('管理员能建两种模式的产品；重名、坏正则、次数不对都会被拒')

    const list = (await new Client().json('/api/products')).data.products
    const muse = list.find((p) => p.key === 'muse')
    assert.equal(muse.name, 'Muse')
    assert.equal(muse.mode, 'multi')
    assert.equal(muse.max_uses, 3)
    assert.equal(muse.available, 0)
    ok('管理员建好的产品立刻出现在广场上，还没有码')
  }

  console.log('一次性码（ChatterFly 这类）')
  {
    const anon = new Client()
    assert.equal((await anon.json('/api/codes', 'POST', { product_key: 'chatterfly', codes: 'CF-AAAA' })).status, 401)
    ok('没登录不能分享')

    const noOrigin = await alice.raw('/api/codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_key: 'chatterfly', codes: 'CF-AAAA' }),
    })
    assert.equal(noOrigin.status, 403)
    ok('跨站请求（没有同源 Origin）被拒绝')

    const badFmt = await alice.json('/api/codes', 'POST', { product_key: 'chatterfly', codes: 'CF-AAAA\nhello' })
    assert.equal(badFmt.data.error, 'bad_format')
    ok('不符合产品格式的码放不进去')

    const r = await alice.json('/api/codes', 'POST', {
      product_key: 'chatterfly',
      codes: 'CF-0001\nCF-0002\nCF-0002\n\nCF-0003',
      note: '选中国区',
    })
    assert.equal(r.status, 200)
    assert.equal(r.data.added, 3)
    ok('一次分享多个码，重复行自动去掉')

    const over = await alice.json('/api/codes', 'POST', { product_key: 'chatterfly', codes: 'CF-0004' })
    assert.equal(over.data.error, 'code_limit')
    ok('每人最多放 3 个码，第 4 个被拒')

    const dup = await bob.json('/api/codes', 'POST', { product_key: 'chatterfly', codes: 'CF-0001\nCF-B001' })
    assert.equal(dup.data.added, 1)
    assert.equal(dup.data.duplicates, 1)
    ok('每个码唯一：别人已经放过的码不能重复放')

    const list = await new Client().json('/api/products')
    const cf = list.data.products.find((p) => p.key === 'chatterfly')
    assert.equal(cf.available, 4)
    assert.ok(!JSON.stringify(list.data).includes('CF-0001'))
    ok('广场只显示产品名和数量，看不到码本身')

    const low = await newbie.json('/api/claim', 'POST', { product_key: 'chatterfly' })
    assert.equal(low.status, 403)
    assert.equal(low.data.error, 'trust_level')
    ok('信任等级不够不能领')

    const got = await bob.json('/api/claim', 'POST', { product_key: 'chatterfly' })
    assert.equal(got.status, 200)
    assert.match(got.data.claim.code, /^CF-000[123]$/)
    assert.equal(got.data.claim.sharer_username, 'alice')
    ok('bob 领到的是 alice 的码，不会领到自己的')
    const bobCode = got.data.claim.code

    const again = await bob.json('/api/claim', 'POST', { product_key: 'chatterfly' })
    assert.equal(again.data.error, 'already_claimed')
    ok('同一个产品每人只能领一个')

    const shared = await alice.json('/api/my/shared')
    const row = shared.data.codes.find((c) => c.code === bobCode)
    assert.equal(row.status, 'claimed')
    assert.equal(row.used, 1)
    const who = shared.data.claimers.find((x) => x.code_id === row.id)
    assert.equal(who.username, 'bob')
    assert.equal(shared.data.summary.claimed, 1)
    ok('一次性码被领走就用完了，分享者能看到是谁领的')

    const claimed = await bob.json('/api/my/claimed')
    const cl = claimed.data.claims[0]
    assert.equal(cl.code, bobCode)
    assert.equal(cl.sharer_username, 'alice')
    assert.equal(cl.note, '选中国区')
    assert.equal((await bob.json(`/api/claims/${cl.id}/thanks`, 'POST')).status, 200)
    assert.equal((await bob.json(`/api/claims/${cl.id}/thanks`, 'POST')).status, 409)
    const shared2 = await alice.json('/api/my/shared')
    assert.equal(shared2.data.summary.thanks, 1)
    ok('领取人可以感谢一次，分享者看到感谢数 +1')

    const carol = await new Client().devLogin('carol')
    assert.equal((await carol.json(`/api/claims/${cl.id}/thanks`, 'POST')).status, 409)
    ok('别人不能替领取人点感谢')

    const avail = shared2.data.codes.find((c) => c.status === 'available')
    assert.equal((await bob.json(`/api/codes/${avail.id}`, 'DELETE')).status, 409)
    assert.equal((await alice.json(`/api/codes/${avail.id}`, 'DELETE')).status, 200)
    assert.equal((await alice.json(`/api/codes/${row.id}`, 'DELETE')).status, 409)
    ok('只能撤回自己还在池里的码，已用完的不能撤回')

    const room = await alice.json('/api/codes', 'POST', { product_key: 'chatterfly', codes: 'CF-0004' })
    assert.equal(room.data.added, 1)
    ok('撤回之后名额空出来，可以再放一个')
  }

  console.log('多人可用码（Muse 这类）')
  {
    const two = await alice.json('/api/codes', 'POST', { product_key: 'muse', codes: 'MUSE-A\nMUSE-A2' })
    assert.equal(two.data.error, 'one_code')
    const tooMany = await alice.json('/api/codes', 'POST', { product_key: 'muse', codes: 'MUSE-A', uses: 4 })
    assert.equal(tooMany.data.error, 'bad_uses')
    ok('每人只能放一个码，可用次数不能超过产品上限')

    assert.equal((await alice.json('/api/codes', 'POST', { product_key: 'muse', codes: 'MUSE-A' })).data.added, 1)
    assert.equal((await bob.json('/api/codes', 'POST', { product_key: 'muse', codes: 'MUSE-B', uses: 2 })).data.added, 1)
    const second = await alice.json('/api/codes', 'POST', { product_key: 'muse', codes: 'MUSE-A3' })
    assert.equal(second.data.error, 'has_code')
    ok('分享过一个码之后不能再放第二个')

    let muse = (await new Client().json('/api/products')).data.products.find((p) => p.key === 'muse')
    assert.equal(muse.available, 5)
    assert.equal(muse.available_codes, 2)
    ok('广场显示剩余可用次数（3 + 2 = 5）')

    const users = await Promise.all(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((u) => new Client().devLogin(u)))
    const codes = []
    for (const u of users.slice(0, 4)) {
      const r = await u.json('/api/claim', 'POST', { product_key: 'muse' })
      assert.equal(r.status, 200)
      codes.push(r.data.claim.code)
    }
    assert.equal(codes.filter((x) => x === 'MUSE-A').length, 2)
    assert.equal(codes.filter((x) => x === 'MUSE-B').length, 2)
    ok('随机轮流发：4 个人领，两个分享者各被用 2 次')

    const sharedA = await alice.json('/api/my/shared')
    const a = sharedA.data.codes.find((c) => c.code === 'MUSE-A')
    assert.equal(a.max_uses - a.used, 1)
    assert.equal(a.status, 'available')
    assert.equal(sharedA.data.claimers.filter((x) => x.code_id === a.id).length, 2)
    const sharedB = await bob.json('/api/my/shared')
    const b = sharedB.data.codes.find((c) => c.code === 'MUSE-B')
    assert.equal(b.status, 'claimed')
    ok('分享者看到剩余次数和每个用了码的人；用满的码自动标为用完')

    const r5 = await users[4].json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(r5.data.claim.code, 'MUSE-A')
    const r6 = await users[5].json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(r6.data.error, 'empty')
    ok('次数用完后不再发出')

    assert.equal((await bob.json(`/api/codes/${b.id}`, 'PATCH', { remaining: 1 })).status, 200)
    assert.equal((await bob.json(`/api/codes/${b.id}`, 'PATCH', { remaining: 99 })).data.error, 'bad_uses')
    assert.equal((await alice.json(`/api/codes/${b.id}`, 'PATCH', { remaining: 1 })).status, 404)
    muse = (await new Client().json('/api/products')).data.products.find((p) => p.key === 'muse')
    assert.equal(muse.available, 1) // 产品上限 3，bob 已被用 2 次，最多还能剩 1 次
    const r7 = await users[5].json('/api/claim', 'POST', { product_key: 'muse' })
    assert.equal(r7.data.claim.code, 'MUSE-B')
    ok('分享者可以改剩余次数（不超过产品上限），改完又能被领')

    const one = (await alice.json('/api/my/shared')).data.codes.find((c) => c.code === 'MUSE-A')
    assert.equal((await alice.json(`/api/codes/${one.id}`, 'PATCH', { remaining: 0 })).status, 200)
    const cfList = await alice.json('/api/my/shared')
    assert.equal(cfList.data.codes.find((c) => c.id === one.id).status, 'claimed')
    ok('剩余次数改成 0 就不再发出')

    const multiWd = await boss.json('/api/admin/products', 'POST', { name: 'Gamma', mode: 'multi', max_uses: 5 })
    assert.equal(multiWd.status, 200)
    await alice.json('/api/codes', 'POST', { product_key: 'gamma', codes: 'GAMMA-1' })
    const g = await users[0].json('/api/claim', 'POST', { product_key: 'gamma' })
    const gid = (await alice.json('/api/my/shared')).data.codes.find((c) => c.code === 'GAMMA-1').id
    assert.equal((await alice.json(`/api/codes/${gid}`, 'DELETE')).status, 200)
    const still = (await users[0].json('/api/my/claimed')).data.claims.find((c) => c.id === g.data.claim.id)
    assert.equal(still.code, 'GAMMA-1')
    ok('多人码用了一部分也能撤回，已经领到的人还能看到码')
  }

  console.log('管理员视图')
  {
    const all = await boss.json('/api/admin/codes')
    assert.equal(all.status, 200)
    assert.ok(all.data.codes.some((c) => c.code === 'MUSE-B' && c.sharer_username === 'bob'))
    const onlyAlice = await boss.json('/api/admin/codes?q=alice')
    assert.ok(onlyAlice.data.codes.length > 0 && onlyAlice.data.codes.every((c) => c.sharer_username === 'alice'))
    ok('管理员能看到所有人分享的码，并按用户或码搜索')

    const us = await boss.json('/api/admin/users')
    const al = us.data.users.find((u) => u.username === 'alice')
    assert.ok(al.codes >= 1 && al.given >= 1)
    assert.equal(us.data.users.find((u) => u.username === 'admin').is_admin, true)
    ok('管理员能看到所有注册用户和他们的分享、领取数')

    const target = all.data.codes.find((c) => c.code === 'CF-B001')
    assert.equal((await boss.json(`/api/admin/codes/${target.id}`, 'DELETE')).status, 200)
    assert.ok(!(await boss.json('/api/admin/codes')).data.codes.some((c) => c.code === 'CF-B001'))
    ok('管理员可以下架任何人的码')

    assert.equal((await boss.json('/api/admin/products/xiaodou', 'PATCH', { active: false })).status, 404)
    assert.equal((await boss.json('/api/admin/products/小豆', 'PATCH', { active: false })).status, 200)
    assert.ok(!(await new Client().json('/api/products')).data.products.some((p) => p.key === '小豆'))
    assert.equal((await alice.json('/api/codes', 'POST', { product_key: '小豆', codes: 'X' })).data.error, 'no_product')
    assert.equal((await boss.json('/api/admin/products/小豆', 'PATCH', { active: true })).status, 200)
    ok('管理员可以下架产品，下架后广场不显示、不能分享')

    const locked = await boss.json('/api/admin/products/muse', 'PATCH', { mode: 'single' })
    assert.equal(locked.data.error, 'mode_locked')
    assert.equal((await boss.json('/api/admin/products/muse', 'PATCH', { description: '新说明' })).status, 200)
    ok('已有码的产品不能改模式，其他设置可以改')
  }

  console.log('并发：20 个人同时抢')
  {
    const sharer = await new Client().devLogin('sharer')
    await sharer.json('/api/codes', 'POST', { product_key: '小豆', codes: ['XD-1', 'XD-2', 'XD-3', 'XD-4', 'XD-5'].join('\n') })
    const people = await Promise.all(Array.from({ length: 20 }, (_, i) => new Client().devLogin(`racer${i}`)))
    const results = await Promise.all(people.map((p) => p.json('/api/claim', 'POST', { product_key: '小豆' })))
    const wins = results.filter((r) => r.status === 200).map((r) => r.data.claim.code)
    assert.equal(wins.length, 5)
    assert.equal(new Set(wins).size, 5)
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.data.error === 'empty'))
    ok('一次性码：正好 5 人领到，5 个码互不相同，其余 15 人提示已领完')

    await boss.json('/api/admin/products', 'POST', { name: 'Delta', mode: 'multi', max_uses: 5 })
    await sharer.json('/api/codes', 'POST', { product_key: 'delta', codes: 'DELTA-1' })
    const r2 = await Promise.all(people.map((p) => p.json('/api/claim', 'POST', { product_key: 'delta' })))
    assert.equal(r2.filter((r) => r.status === 200).length, 5)
    const d = (await sharer.json('/api/my/shared')).data.codes.find((c) => c.code === 'DELTA-1')
    assert.equal(d.used, 5)
    assert.equal(d.status, 'claimed')
    ok('多人码：可用 5 次，20 人同时抢正好 5 人拿到，不会超发')
  }

  console.log('防刷')
  {
    for (const n of ['Bulk', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      await boss.json('/api/admin/products', 'POST', { name: n, mode: 'single' })
    }
    const sh = await new Client().devLogin('bulk')
    const codes = Array.from({ length: 20 }, (_, i) => `B-${i}`).join('\n')
    const big = await sh.json('/api/codes', 'POST', { product_key: 'bulk', codes: codes + '\nB-extra' })
    assert.equal(big.data.error, 'too_many')
    ok('一次最多放 20 个')
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      await sh.json('/api/codes', 'POST', { product_key: n, codes: `${n}-a\n${n}-b` })
    }
    const lim = await sh.json('/api/codes', 'POST', { product_key: 'bulk', codes })
    assert.equal(lim.data.error, 'share_limit')
    ok('24 小时分享上限生效')

    const grabber = await new Client().devLogin('grabber')
    const got = []
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      got.push(await grabber.json('/api/claim', 'POST', { product_key: n }))
    }
    assert.equal(got.filter((r) => r.status === 200).length, 5)
    assert.equal(got[5].data.error, 'claim_limit')
    ok('24 小时领取上限（5 个）生效')
  }

  console.log('LDC 奖励（假 LDC 服务，不会真的发）')
  {
    assert.equal((await alice.json('/api/admin/settings')).status, 403)
    const st = (await boss.json('/api/admin/settings')).data
    assert.equal(st.settings.ldc_enabled, false)
    assert.equal(st.ldc_configured, true)
    ok('LDC 默认关闭；只有管理员能看设置')

    await boss.json('/api/admin/products', 'POST', { name: 'Echo', mode: 'single' })
    await boss.json('/api/admin/products', 'POST', { name: 'Fox', mode: 'multi', max_uses: 3 })
    const giver = await new Client().devLogin('giver')
    const takers = await Promise.all(Array.from({ length: 10 }, (_, i) => new Client().devLogin(`taker${i}`)))
    const claim = async (who, key) => {
      const r = await who.json('/api/claim', 'POST', { product_key: key })
      assert.equal(r.status, 200, JSON.stringify(r.data))
      return r.data.claim
    }
    const codeId = async (who, code) => (await who.json('/api/my/shared')).data.codes.find((c) => c.code === code).id
    const payouts = async (status = 'all') => (await boss.json(`/api/admin/payouts?status=${status}`)).data.payouts
    const run = async () => (await boss.json('/api/admin/payouts/run', 'POST')).data

    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-1' })
    await claim(takers[0], 'echo')
    assert.equal((await payouts()).length, 0)
    assert.equal((await new Client().json('/api/products')).data.products.find((p) => p.key === 'echo').share_reward_cents, 0)
    ok('关闭时领取不产生奖励，广场也不显示奖励')

    assert.equal((await boss.json('/api/admin/settings', 'PUT', { claim_reward_cents: -1 })).data.error, 'bad_amount')
    const put = await boss.json('/api/admin/settings', 'PUT', {
      ldc_enabled: true,
      share_reward_cents: 100,
      claim_reward_cents: 50,
      daily_cap_cents: 1000,
      hold_hours: 0,
    })
    assert.equal(put.status, 200)
    assert.equal((await boss.json('/api/admin/products/echo', 'PATCH', { claim_reward_cents: 'x' })).data.error, 'bad_reward')
    assert.equal((await boss.json('/api/admin/products/echo', 'PATCH', { claim_reward_cents: 20 })).status, 200)
    const sq = (await new Client().json('/api/products')).data.products
    assert.deepEqual(
      [sq.find((p) => p.key === 'echo'), sq.find((p) => p.key === 'fox')].map((p) => [p.share_reward_cents, p.claim_reward_cents]),
      [
        [100, 20],
        [100, 50],
      ],
    )
    ok('管理员能开启 LDC、设全站金额，单个产品可以覆盖；广场显示实际奖励')

    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-2' })
    await giver.json('/api/codes', 'POST', { product_key: 'fox', codes: 'FOX-1', uses: 3 })
    await claim(takers[1], 'echo')
    await claim(takers[2], 'fox')
    await claim(takers[3], 'fox')
    const fox1 = await codeId(giver, 'FOX-1')
    const ps = await payouts()
    assert.equal(ps.length, 5)
    assert.equal(ps.filter((p) => p.id === `share-${fox1}`).length, 1)
    assert.ok(ps.every((p) => p.status === 'pending' && p.sharer_username === 'giver'))
    ok('一次性码：贡献 + 领取各一笔；多人码：贡献奖励只记一次，每次领取一笔')

    const r1 = await run()
    assert.equal(r1.sent, 5)
    assert.equal(ldcCalls.length, 5)
    assert.ok(ldcCalls.every((b) => b.username === 'giver' && typeof b.user_id === 'number' && b.out_trade_no))
    assert.deepEqual(ldcCalls.map((b) => b.amount).sort(), [0.2, 0.5, 0.5, 1, 1])
    assert.equal((await run()).sent, 0)
    assert.equal(ldcCalls.length, 5)
    const mine = (await giver.json('/api/my/shared')).data
    assert.equal(mine.summary.rewarded_cents, 320)
    assert.equal(mine.payouts.filter((p) => p.status === 'sent').length, 5)
    ok('到期奖励通过 LDC 分发接口发给分享者；再跑一次不会重复发；分享者能看到收到多少')

    const poor = await new Client().devLogin('poor')
    await poor.json('/api/codes', 'POST', { product_key: 'fox', codes: 'FOX-P', uses: 1 })
    await claim(takers[4], 'fox')
    const r2 = await run()
    assert.equal(r2.failed, 2)
    const failed = await payouts('failed')
    assert.equal(failed.length, 2)
    assert.equal(failed[0].error, '用户不存在')
    assert.equal((await boss.json(`/api/admin/payouts/${failed[0].id}/retry`, 'POST')).status, 200)
    assert.equal((await run()).failed, 1)
    assert.equal((await boss.json(`/api/admin/payouts/${failed[1].id}/cancel`, 'POST')).status, 200)
    assert.equal((await boss.json(`/api/admin/payouts/${failed[1].id}/retry`, 'POST')).data.error, 'not_retryable')
    ok('LDC 拒绝时记为失败并显示原因，管理员可以重试或取消')

    await boss.json('/api/admin/settings', 'PUT', { daily_cap_cents: 320 })
    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-3' })
    await claim(takers[5], 'echo')
    const r3 = await run()
    assert.equal(r3.sent, 0)
    assert.equal(r3.waiting, 2)
    await boss.json('/api/admin/settings', 'PUT', { daily_cap_cents: 1000 })
    assert.equal((await run()).sent, 2)
    ok('超过全站 24 小时上限的先不发，调高上限后补发')

    await boss.json('/api/admin/settings', 'PUT', { hold_hours: 24 })
    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-4' })
    const c7 = await claim(takers[6], 'echo')
    assert.equal((await run()).sent, 0)
    const echo4 = await codeId(giver, 'ECHO-4')
    assert.equal((await payouts('pending')).filter((p) => p.code_id === echo4).length, 2)
    ok('观察期内不发')

    assert.equal((await takers[1].json(`/api/claims/${c7.id}/report`, 'POST', {})).status, 404)
    assert.equal((await takers[6].json(`/api/claims/${c7.id}/report`, 'POST', { reason: '提示邀请码无效' })).status, 200)
    assert.equal((await takers[6].json(`/api/claims/${c7.id}/report`, 'POST', {})).data.error, 'already_reported')
    assert.equal((await payouts('held')).filter((p) => p.code_id === echo4).length, 2)
    const shared = (await giver.json('/api/my/shared')).data.codes.find((c) => c.id === echo4)
    assert.equal(shared.reports_open, 1)
    ok('只有领取人能反馈无效；反馈后这个码的奖励被扣下，分享者能看到有反馈')

    const reports = (await boss.json('/api/admin/reports')).data.reports
    const rep = reports.find((r) => r.code_id === echo4)
    assert.equal(rep.reason, '提示邀请码无效')
    assert.equal(rep.held_cents, 120)
    assert.equal((await alice.json(`/api/admin/reports/${rep.id}/resolve`, 'POST', { action: 'confirm' })).status, 403)
    assert.equal((await boss.json(`/api/admin/reports/${rep.id}/resolve`, 'POST', { action: 'confirm' })).status, 200)
    assert.equal((await payouts('canceled')).filter((p) => p.code_id === echo4).length, 2)
    const myc = (await takers[6].json('/api/my/claimed')).data.claims.find((x) => x.id === c7.id)
    assert.ok(myc.void_at)
    assert.equal(myc.report_status, 'confirmed')
    assert.ok(!(await giver.json('/api/my/shared')).data.codes.some((c) => c.id === echo4))
    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-5' })
    assert.equal((await claim(takers[6], 'echo')).code, 'ECHO-5')
    ok('管理员确认无效：撤下码、取消奖励、领取作废，反馈人可以再领一个')

    const c8 = await claim(takers[7], 'fox')
    assert.equal(c8.code, 'FOX-1')
    await takers[7].json(`/api/claims/${c8.id}/report`, 'POST', { reason: '不确定' })
    const rep2 = (await boss.json('/api/admin/reports')).data.reports.find((r) => r.claim_id === c8.id)
    assert.equal((await boss.json(`/api/admin/reports/${rep2.id}/resolve`, 'POST', { action: 'dismiss' })).status, 200)
    assert.equal((await payouts('pending')).filter((p) => p.code_id === fox1).length, 1)
    ok('管理员驳回反馈：扣下的奖励恢复待发')

    assert.equal((await boss.json(`/api/admin/codes/${fox1}`, 'DELETE')).status, 200)
    assert.equal((await payouts('pending')).filter((p) => p.code_id === fox1).length, 0)
    ok('管理员撤下码时，没发的奖励一起取消')

    await boss.json('/api/admin/settings', 'PUT', { ldc_enabled: false, hold_hours: 0 })
    const before = ldcCalls.length
    await giver.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-6' })
    await claim(takers[8], 'echo')
    assert.equal((await run()).enabled, false)
    assert.equal(ldcCalls.length, before)
    ok('关闭后既不记新奖励也不发')
  }

  console.log('测试账号')
  {
    const anon = new Client()
    assert.equal((await anon.json('/api/me')).data.test_login, true)
    const bad = await anon.json('/api/auth/test-login', 'POST', { password: 'nope' })
    assert.equal(bad.status, 403)
    assert.equal((await anon.json('/api/me')).data.user, null)
    ok('密码不对不能登录测试账号')

    const tu = new Client()
    assert.equal((await tu.json('/api/auth/test-login', 'POST', { password: 'test-pass' })).status, 200)
    const me2 = (await tu.json('/api/me')).data.user
    assert.equal(me2.username, '测试用户')
    assert.equal(me2.is_admin, false)
    assert.equal((await tu.json('/api/admin/settings')).status, 403)
    assert.equal((await tu.json('/api/admin/users')).status, 403)
    // 以前的 account: 'admin' 参数不再有用，还是普通测试用户
    const ta = new Client()
    await ta.json('/api/auth/test-login', 'POST', { password: 'test-pass', account: 'admin' })
    const me = (await ta.json('/api/me')).data.user
    assert.equal(me.username, '测试用户')
    assert.equal(me.is_admin, false)
    ok('测试账号只有一个普通用户，进不了管理页')

    const users = (await boss.json('/api/admin/users')).data.users
    assert.ok(users.find((u) => u.username === '测试用户').is_test)
    assert.ok(!users.some((u) => u.username === '测试管理员'))
    ok('管理页的用户列表标出测试账号')

    await boss.json('/api/admin/settings', 'PUT', { ldc_enabled: true, hold_hours: 0 })
    await tu.json('/api/codes', 'POST', { product_key: 'echo', codes: 'ECHO-T' })
    const t9 = await new Client().devLogin('taker9')
    assert.equal((await t9.json('/api/claim', 'POST', { product_key: 'echo' })).data.claim.code, 'ECHO-T')
    const tid = (await tu.json('/api/my/shared')).data.codes.find((c) => c.code === 'ECHO-T').id
    assert.equal((await boss.json('/api/admin/payouts')).data.payouts.filter((p) => p.code_id === tid).length, 0)
    await boss.json('/api/admin/settings', 'PUT', { ldc_enabled: false })
    ok('测试账号分享的码被领取，不会记 LDC 奖励')
  }

  console.log('立即发放（跳过观察期）')
  {
    await boss.json('/api/admin/products', 'POST', { name: 'Quick', mode: 'single' })
    await boss.json('/api/admin/settings', 'PUT', {
      ldc_enabled: true,
      share_reward_cents: 100,
      claim_reward_cents: 0,
      daily_cap_cents: 1_000_000,
      hold_hours: 24,
    })
    const vip = await new Client().devLogin('vip')
    const other = await new Client().devLogin('other-sharer')
    const vipId = (await vip.json('/api/me')).data.user.id
    const shareRes = await vip.json('/api/codes', 'POST', { product_key: 'quick', codes: 'G-1\nG-2\nG-3' })
    assert.equal(shareRes.status, 200, JSON.stringify(shareRes.data))
    for (let i = 0; i < 3; i++) {
      const r = await (await new Client().devLogin(`gtaker${i}`)).json('/api/claim', 'POST', { product_key: 'quick' })
      assert.equal(r.status, 200, JSON.stringify(r.data))
    }
    await other.json('/api/codes', 'POST', { product_key: 'quick', codes: 'G-9' })
    await (await new Client().devLogin('gtaker9')).json('/api/claim', 'POST', { product_key: 'quick' })
    const list = async () =>
      (await boss.json('/api/admin/payouts')).data.payouts.filter((p) => p.product === 'Quick')
    const vipPayouts = (await list()).filter((p) => p.sharer_username === 'vip')
    assert.equal(vipPayouts.length, 3)
    assert.ok(vipPayouts.every((p) => p.status === 'pending' && p.due_at > Date.now() + 23 * 3600 * 1000))
    const before = ldcCalls.length
    await boss.json('/api/admin/payouts/run', 'POST')
    assert.equal(ldcCalls.length, before)
    ok('观察期 24 小时内，普通发放不会发')

    assert.equal((await vip.json(`/api/admin/payouts/${vipPayouts[0].id}/send-now`, 'POST')).status, 403)
    const one = await boss.json(`/api/admin/payouts/${vipPayouts[0].id}/send-now`, 'POST')
    assert.equal(one.status, 200)
    assert.equal(one.data.sent, 1)
    assert.equal(ldcCalls.length, before + 1)
    assert.equal(ldcCalls.at(-1).out_trade_no, vipPayouts[0].id)
    assert.equal((await boss.json(`/api/admin/payouts/${vipPayouts[0].id}/send-now`, 'POST')).status, 409)
    ok('管理员对单笔立即发放：马上发出，只发这一笔，发过的不能再发')

    const users = (await boss.json('/api/admin/users')).data.users
    const vu = users.find((u) => u.username === 'vip')
    assert.equal(vu.unpaid_cents, 200)
    assert.equal(vu.sent_cents, 100)
    const all = await boss.json(`/api/admin/users/${vipId}/send-now`, 'POST')
    assert.equal(all.status, 200)
    assert.equal(all.data.sent, 2)
    assert.equal(ldcCalls.length, before + 3)
    assert.ok(ldcCalls.slice(before).every((b) => b.username === 'vip'))
    const otherP = (await list()).find((p) => p.sharer_username === 'other-sharer')
    assert.equal(otherP.status, 'pending')
    assert.equal((await boss.json(`/api/admin/users/${vipId}/send-now`, 'POST')).status, 404)
    ok('管理员对某个用户立即发放：发完他所有待发的奖励，别人的不受影响')

    // 有人反馈无效的不能立即发
    const gclaim = (await (await new Client().devLogin('gtaker9')).json('/api/my/claimed')).data.claims[0]
    const g9 = await new Client().devLogin('gtaker9')
    await g9.json(`/api/claims/${gclaim.id}/report`, 'POST', { reason: '不能用' })
    const held = await boss.json(`/api/admin/payouts/${otherP.id}/send-now`, 'POST')
    assert.equal(held.status, 409)
    assert.equal(held.data.error, 'held')
    ok('有人反馈无效、被扣下的奖励不能立即发')

    await boss.json('/api/admin/settings', 'PUT', { ldc_enabled: false })
    const off = await boss.json(`/api/admin/users/${vipId}/send-now`, 'POST')
    assert.equal(off.status, 409)
    assert.equal(off.data.error, 'ldc_disabled')
    ok('LDC 奖励关闭时不能立即发放')
  }

  console.log('申请新产品')
  {
    const pr = await new Client().devLogin('requester')
    const pr2 = await new Client().devLogin('requester2')
    assert.equal((await new Client().json('/api/product-requests', 'POST', { name: 'Zed' })).status, 401)
    assert.equal((await pr.json('/api/product-requests', 'POST', { name: '' })).status, 400)
    const dup = await pr.json('/api/product-requests', 'POST', { name: 'echo' })
    assert.equal(dup.status, 409)
    assert.equal(dup.data.error, 'exists')
    ok('没登录不能申请；广场上已有的产品不能再申请')

    const a = await pr.json('/api/product-requests', 'POST', {
      name: ' Zed  AI ',
      mode: 'multi',
      max_uses: 10,
      description: '注册时填码，双方都加额度',
    })
    assert.equal(a.status, 200)
    const same = await pr2.json('/api/product-requests', 'POST', { name: 'zed ai' })
    assert.equal(same.status, 409)
    assert.equal(same.data.error, 'already_requested')
    ok('提交申请；同一个产品同时只能有一条待审核')

    await pr.json('/api/product-requests', 'POST', { name: 'Req B' })
    await pr.json('/api/product-requests', 'POST', { name: 'Req C' })
    const over = await pr.json('/api/product-requests', 'POST', { name: 'Req D' })
    assert.equal(over.status, 429)
    ok('每人同时最多 3 条待审核')

    const mine = (await pr.json('/api/my/product-requests')).data.requests
    assert.equal(mine.length, 3)
    assert.equal(mine.find((r) => r.id === a.data.id).name, 'Zed AI')
    const c = mine.find((r) => r.name === 'Req C')
    assert.equal((await pr2.json(`/api/product-requests/${c.id}`, 'DELETE')).status, 404)
    assert.equal((await pr.json(`/api/product-requests/${c.id}`, 'DELETE')).status, 200)
    assert.equal((await pr.json('/api/product-requests', 'POST', { name: 'Req D' })).status, 200)
    ok('申请人能看到自己的申请，能撤回，别人撤不了')

    assert.equal((await pr.json('/api/admin/product-requests')).status, 403)
    const pending = (await boss.json('/api/admin/product-requests')).data.requests
    assert.ok(pending.some((r) => r.id === a.data.id && r.username === 'requester'))
    assert.equal((await pr.json(`/api/admin/product-requests/${a.data.id}/approve`, 'POST', {})).status, 403)
    ok('只有管理员能看和审核申请')

    const ok1 = await boss.json(`/api/admin/product-requests/${a.data.id}/approve`, 'POST', {
      admin_note: '已上架',
      share_reward_cents: 200,
    })
    assert.equal(ok1.status, 200)
    const prods = (await pr.json('/api/products')).data.products
    const zed = prods.find((p) => p.key === ok1.data.key)
    assert.equal(zed.name, 'Zed AI')
    assert.equal(zed.mode, 'multi')
    assert.equal(zed.max_uses, 10)
    const again = await boss.json(`/api/admin/product-requests/${a.data.id}/approve`, 'POST', {})
    assert.equal(again.status, 404)
    const mine2 = (await pr.json('/api/my/product-requests')).data.requests
    const done = mine2.find((r) => r.id === a.data.id)
    assert.equal(done.status, 'approved')
    assert.equal(done.admin_note, '已上架')
    ok('管理员通过：按申请建好产品（多人可用、10 次），可以改设置，申请人看到已通过')

    const b = mine2.find((r) => r.name === 'Req B')
    assert.equal((await boss.json(`/api/admin/product-requests/${b.id}/reject`, 'POST', { note: '太冷门' })).status, 200)
    const rej = (await pr.json('/api/my/product-requests')).data.requests.find((r) => r.id === b.id)
    assert.equal(rej.status, 'rejected')
    assert.equal(rej.admin_note, '太冷门')
    assert.ok(!(await pr.json('/api/products')).data.products.some((p) => p.name === 'Req B'))
    assert.equal((await pr2.json('/api/product-requests', 'POST', { name: 'Req B' })).status, 200)
    ok('管理员拒绝：不建产品，申请人看到理由；拒绝后别人可以再申请')
  }

  console.log(`\n全部通过：${passed} 项`)
} catch (e) {
  console.error('\n测试失败：', e)
  process.exitCode = 1
} finally {
  mock.close()
}
