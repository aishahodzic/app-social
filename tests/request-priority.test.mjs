import test from 'node:test'
import assert from 'node:assert/strict'

import { clearUnread, getFeed, getReplies, searchPeople } from '../api.js'

// Möbius runs one private Social request at a time, so upkeep must never queue
// ahead of something the owner is waiting on.
const tick = () => new Promise(resolve => setImmediate(resolve))

test('upkeep waits for owner-visible requests and then runs one at a time', async () => {
  const started = []
  const release = new Map()
  globalThis.fetch = (url) => {
    const path = url.replace('/api/services/social/', '')
    started.push(path)
    return new Promise(resolve => release.set(path, () => resolve({
      ok: true, async json() { return { path } },
    })))
  }
  try {
    const feed = getFeed()
    const prefetch = getReplies('post-1', { background: true })
    const receipt = clearUnread('peer.example')
    await tick()
    assert.deepEqual(started, ['feed?limit=30'])

    release.get('feed?limit=30')()
    await feed
    await tick()
    assert.deepEqual(started, ['feed?limit=30', 'replies/post-1'])

    // An owner-visible request is never held back by queued upkeep.
    const search = searchPeople('ada')
    await tick()
    assert.deepEqual(started.slice(-1), ['people?q=ada'])

    release.get('replies/post-1')()
    await prefetch
    await tick()
    assert.equal(started.includes('conversations/peer.example/read'), false)
    release.get('people?q=ada')()
    await search
    await tick()
    assert.equal(started.at(-1), 'conversations/peer.example/read')
    release.get('conversations/peer.example/read')()
    await receipt
  } finally {
    delete globalThis.fetch
  }
})

test('aborted upkeep leaves the queue without ever reaching the service', async () => {
  const started = []
  let releaseForeground
  globalThis.fetch = (url) => {
    started.push(url)
    return new Promise(resolve => { releaseForeground = () => resolve({ ok: true, async json() { return {} } }) })
  }
  try {
    const foreground = getFeed()
    const controller = new AbortController()
    const queued = searchPeople('', controller.signal, { background: true })
    controller.abort()
    await assert.rejects(queued, { name: 'AbortError' })
    releaseForeground()
    await foreground
    await tick()
    assert.equal(started.length, 1)
  } finally {
    delete globalThis.fetch
  }
})

test('feed, reply, and directory responses teach the avatar cache each member hash', async () => {
  const { avatarDigest } = await import('../avatarHints.js')
  const digest = (letter) => letter.repeat(64)
  const bodies = {
    'feed?limit=30': { posts: [{ host: 'author.example', avatar: digest('a'),
      reply_authors: [{ host: 'replier.example', avatar: digest('b') }] }] },
    'people?q=': { users: [{ host: 'listed.example', avatar: digest('c') }, { host: 'plain.example' }] },
    'replies/post-9': { replies: [{ host: 'late.example', avatar: digest('d') }] },
  }
  globalThis.fetch = async (url) => {
    const body = bodies[url.replace('/api/services/social/', '')]
    return { ok: true, async json() { return body } }
  }
  try {
    await getFeed()
    await searchPeople('')
    await getReplies('post-9')
  } finally {
    delete globalThis.fetch
  }
  assert.equal(avatarDigest('author.example'), digest('a'))
  assert.equal(avatarDigest('Replier.Example'), digest('b'))
  assert.equal(avatarDigest('listed.example'), digest('c'))
  assert.equal(avatarDigest('late.example'), digest('d'))
  assert.equal(avatarDigest('plain.example'), null)
})
