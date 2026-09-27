import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cachedAvatar, cachedAvatarUrl, primeAvatar, subscribeAvatar,
} from '../avatarCache.js'

const wire = (byte) => ({ mime: 'image/webp', data_b64: Buffer.from([byte]).toString('base64') })
const response = (avatars = {}, missing = []) => ({
  ok: true,
  json: async () => ({ avatars, missing, unavailable: [] }),
})

test('avatar cache batches peers, serializes batches, and tracks authoritative profile changes', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const calls = []
  const created = []
  const revoked = []
  let releaseFirst
  let releaseSecond
  URL.createObjectURL = () => {
    const url = `blob:test-${created.length + 1}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url) => revoked.push(url)

  try {
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      calls.push(hosts)
      return response(Object.fromEntries(hosts.map((host, index) => [host, wire(index + 1)])))
    }
    const initial = Array.from({ length: 10 }, (_, index) => (
      cachedAvatar(`initial-${index}.example`)
    ))
    await Promise.all(initial.map(record => record.promise))
    assert.deepEqual(calls, [
      Array.from({ length: 8 }, (_, index) => `initial-${index}.example`),
      ['initial-8.example', 'initial-9.example'],
    ])

    calls.length = 0
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      calls.push(hosts)
      if (calls.length === 1) return new Promise(resolve => { releaseFirst = resolve })
      return new Promise(resolve => { releaseSecond = resolve })
    }
    const early = cachedAvatar('early.example')
    const earlyPromise = early.promise
    await new Promise(resolve => setImmediate(resolve))
    const lateOne = cachedAvatar('late-one.example')
    const lateTwo = cachedAvatar('late-two.example')
    assert.equal(calls.length, 1)
    releaseFirst(response({ 'early.example': wire(3) }))
    await earlyPromise
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [
      ['early.example'],
      ['late-one.example', 'late-two.example'],
    ])
    releaseSecond(response({
      'late-one.example': wire(4), 'late-two.example': wire(5),
    }))
    await Promise.all([lateOne.promise, lateTwo.promise])

    let releaseStale
    globalThis.fetch = async () => new Promise(resolve => { releaseStale = resolve })
    const owner = cachedAvatar('owner.example')
    const ownerPromise = owner.promise
    await new Promise(resolve => setImmediate(resolve))
    const updates = []
    const unsubscribe = subscribeAvatar(owner, url => updates.push(url))
    primeAvatar('owner.example', wire(9))
    const authoritativeUrl = cachedAvatarUrl('owner.example')
    releaseStale(response({ 'owner.example': wire(1) }))
    await ownerPromise
    assert.equal(cachedAvatarUrl('owner.example'), authoritativeUrl)
    assert.deepEqual(updates, [authoritativeUrl])

    primeAvatar('owner.example', wire(10))
    const changedUrl = cachedAvatarUrl('owner.example')
    assert.notEqual(changedUrl, authoritativeUrl)
    assert.deepEqual(revoked, [authoritativeUrl])
    primeAvatar('owner.example', null)
    assert.equal(cachedAvatarUrl('owner.example'), null)
    assert.deepEqual(updates, [authoritativeUrl, changedUrl, null])
    assert.equal(revoked.length, 2)
    unsubscribe()

    const revokedBeforePrune = revoked.length
    for (let index = 0; index < 70; index += 1) {
      primeAvatar(`idle-${index}.example`, wire(index % 255))
    }
    assert.ok(revoked.length > revokedBeforePrune)
  } finally {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('expired mounted avatar refreshes stale-while-refresh and clears confirmed removal', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalNow = Date.now
  const revoked = []
  let now = 1_000_000
  let first = true
  Date.now = () => now
  URL.createObjectURL = () => 'blob:expiry-avatar'
  URL.revokeObjectURL = url => revoked.push(url)
  try {
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      if (first) {
        first = false
        return response({ 'expiry.example': wire(7) })
      }
      return response({}, hosts.includes('expiry.example') ? hosts : [])
    }
    const record = cachedAvatar('expiry.example')
    await record.promise
    const oldUrl = cachedAvatarUrl('expiry.example')
    const revokedBeforeRefresh = revoked.length
    const updates = []
    const unsubscribe = subscribeAvatar(record, url => updates.push(url))

    now += 24 * 60 * 60_000
    const refreshing = cachedAvatar('expiry.example')
    assert.equal(cachedAvatarUrl('expiry.example'), oldUrl)
    await refreshing.promise

    assert.equal(cachedAvatarUrl('expiry.example'), null)
    assert.deepEqual(updates, [null])
    assert.deepEqual(revoked.slice(revokedBeforeRefresh), [oldUrl])
    unsubscribe()
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('saved avatars paint without a service request and only definite answers are saved', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const day = 24 * 60 * 60_000
  const saved = new Map([
    ['cache/avatars/fresh.example.json', { checked_at: Date.now() - 1000, avatar: wire(1) }],
    ['cache/avatars/stale.example.json', { checked_at: Date.now() - day - 1000, avatar: wire(2) }],
  ])
  const writes = []
  const requested = []
  let created = 0
  URL.createObjectURL = () => `blob:saved-${++created}`
  URL.revokeObjectURL = () => {}
  globalThis.window = { mobius: { storage: {
    async get(path) { return saved.get(path) || null },
    async set(path, value) { writes.push([path, value]) },
    async remove() {},
  } } }
  try {
    globalThis.fetch = async (_url, options) => {
      const hosts = JSON.parse(options.body).hosts
      requested.push(hosts)
      if (hosts.includes('down.example')) throw new TypeError('offline')
      return response(Object.fromEntries(hosts.map(host => [host, wire(9)])), [])
    }

    const fresh = cachedAvatar('fresh.example')
    await fresh.promise
    assert.equal(cachedAvatarUrl('fresh.example'), 'blob:saved-1')
    assert.deepEqual(requested, [])

    // A day-old face shows at once and refreshes behind it.
    const stale = cachedAvatar('stale.example')
    const shown = []
    const unsubscribe = subscribeAvatar(stale, url => shown.push(url))
    await stale.promise
    unsubscribe()
    assert.deepEqual(shown, ['blob:saved-2', 'blob:saved-3'])
    assert.deepEqual(requested, [['stale.example']])

    await cachedAvatar('new.example').promise
    await cachedAvatar('down.example').promise
    assert.deepEqual(writes.map(([path, value]) => [path, value.avatar]), [
      ['cache/avatars/stale.example.json', wire(9)],
      ['cache/avatars/new.example.json', wire(9)],
    ])
    assert.equal(cachedAvatarUrl('down.example'), null)
  } finally {
    delete globalThis.window
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('a directory digest keeps a saved face current at any age and a new digest refreshes it on screen', async () => {
  const { noteAvatarDigests } = await import('../avatarHints.js')
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const first = 'a'.repeat(64)
  const second = 'b'.repeat(64)
  const writes = []
  const requests = []
  let created = 0
  URL.createObjectURL = () => `blob:digest-${++created}`
  URL.revokeObjectURL = () => {}
  globalThis.window = { mobius: { storage: {
    async get(path) {
      return path === 'cache/avatars/member.example.json'
        ? { checked_at: 1, avatar: wire(1), digest: first }
        : null
    },
    async set(path, value) { writes.push([path, value]) },
    async remove() {},
  } } }
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return response({ 'member.example': wire(2) }, [], )
    }
    noteAvatarDigests([{ host: 'member.example', avatar: first }])
    const record = cachedAvatar('member.example')
    await record.promise
    assert.equal(cachedAvatarUrl('member.example'), 'blob:digest-1')
    assert.deepEqual(requests, [])

    const shown = []
    const unsubscribe = subscribeAvatar(record, url => shown.push(url))
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return {
        ok: true,
        json: async () => ({
          avatars: { 'member.example': wire(2) }, missing: [], unavailable: [],
          digests: { 'member.example': second },
        }),
      }
    }
    noteAvatarDigests([{ host: 'member.example', avatar: second }])
    await cachedAvatar('member.example').promise
    unsubscribe()
    assert.deepEqual(requests, [{
      hosts: ['member.example'], avatars: { 'member.example': second },
    }])
    assert.deepEqual(shown, ['blob:digest-2'])
    assert.deepEqual(writes.map(([path, value]) => [path, value.digest]), [
      ['cache/avatars/member.example.json', second],
    ])
  } finally {
    delete globalThis.window
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('an answer checked against a directory hash stays current even when the directory could not serve it', async () => {
  const { noteAvatarDigests } = await import('../avatarHints.js')
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const requests = []
  const writes = []
  URL.createObjectURL = () => 'blob:checked'
  globalThis.window = { mobius: { storage: {
    async get() { return null },
    async set(path, value) { writes.push([path, value]) },
  } } }
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body))
      // The service fell back to the member's own server: no digest echoed.
      return response({ 'fallback.example': wire(5) })
    }
    noteAvatarDigests([{ host: 'fallback.example', avatar: 'c'.repeat(64) }])
    await cachedAvatar('fallback.example').promise
    await cachedAvatar('fallback.example').promise
    assert.equal(requests.length, 1)
    assert.equal(writes[0][1].checked_digest, 'c'.repeat(64))

    // The owner's own face comes from their profile, not the directory.
    primeAvatar('self.example', wire(6))
    noteAvatarDigests([{ host: 'self.example', avatar: 'd'.repeat(64) }])
    await cachedAvatar('self.example').promise
    assert.equal(requests.length, 1)
  } finally {
    delete globalThis.window
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
  }
})

test('a new face never waits behind a stuck refresh of a face already on screen', async () => {
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  let created = 0
  URL.createObjectURL = () => `blob:lane-${++created}`
  globalThis.window = { mobius: { storage: {
    async get(path) {
      return path === 'cache/avatars/shown.example.json' ? { checked_at: 1, avatar: wire(7) } : null
    },
    async set() {},
  } } }
  let releaseStale
  try {
    globalThis.fetch = (_url, options) => {
      const { hosts } = JSON.parse(options.body)
      if (hosts.includes('shown.example')) return new Promise(resolve => { releaseStale = resolve })
      return Promise.resolve(response(Object.fromEntries(hosts.map(host => [host, wire(8)]))))
    }
    const shown = cachedAvatar('shown.example')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(cachedAvatarUrl('shown.example'), 'the saved face paints while it refreshes')
    await cachedAvatar('new.example').promise
    assert.ok(cachedAvatarUrl('new.example'))
    assert.equal(typeof releaseStale, 'function', 'the refresh is still waiting')
    releaseStale(response({ 'shown.example': wire(9) }))
    await shown.promise
  } finally {
    delete globalThis.window
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
  }
})
