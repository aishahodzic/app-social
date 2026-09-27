import { getPeerAvatars } from './api.js'
import { avatarDigest, onAvatarDigestChange } from './avatarHints.js'
import {
  AVATAR_NOT_FOUND_RETRY_MS, AVATAR_SUCCESS_RETRY_MS, avatarBlob,
  avatarCacheIsFresh, avatarFailureState,
} from './profile.js'

// A service process has a hard lifetime budget. Eight worst-case guarded
// decodes leave room for transport cleanup before the process deadline.
const AVATAR_BATCH_SIZE = 8
const MAX_IDLE_AVATARS = AVATAR_BATCH_SIZE * 8
const cache = new Map()
const queue = []
// One serial batch loop per lane, so a queued refresh of faces already on
// screen never holds up a face the owner is still waiting for.
const flushing = { foreground: false, background: false }
let accessSequence = 0

const hostKey = (host) => String(host || '').trim().toLowerCase()

// Every avatar the service resolves is also kept in app storage, which Möbius
// answers from the device first. A launch therefore paints known faces
// without a service round trip; a saved copy past the service's own one-day
// cache boundary is shown at once and refreshed as background upkeep.
// Saved shape: { checked_at: epoch ms, avatar: wire | null, digest?: string,
// checked_digest?: string }. A null avatar records a confirmed absence;
// digest names the community directory copy the face came from, and
// checked_digest the directory hash that answer was checked against (see
// avatarHints.js).
const savedAvatarPath = key => `cache/avatars/${encodeURIComponent(key)}.json`
const appStorage = () => globalThis.window?.mobius?.storage

async function readSavedAvatar(key) {
  const store = appStorage()
  if (typeof store?.get !== 'function') return null
  try {
    const saved = await store.get(savedAvatarPath(key))
    return saved && Number.isFinite(saved.checked_at) ? saved : null
  } catch {
    return null
  }
}

function saveAvatar(key, avatar, digest = null, checkedDigest = null) {
  const store = appStorage()
  if (typeof store?.set !== 'function') return
  Promise.resolve(store.set(savedAvatarPath(key), {
    checked_at: Date.now(), avatar: avatar || null,
    ...(digest ? { digest } : {}), ...(checkedDigest ? { checked_digest: checkedDigest } : {}),
  })).catch(() => {})
}

function forgetSavedAvatar(key) {
  const store = appStorage()
  if (typeof store?.remove !== 'function') return
  Promise.resolve(store.remove(savedAvatarPath(key))).catch(() => {})
}

function newRecord() {
  return {
    url: null,
    promise: null,
    failedAt: null,
    notFoundAt: null,
    fetchedAt: null,
    digest: null,
    checkedDigest: null,
    primedWith: undefined,
    generation: 0,
    lastUsed: ++accessSequence,
    listeners: new Set(),
  }
}

function touch(record) {
  record.lastUsed = ++accessSequence
}

function pruneIdleAvatars() {
  if (cache.size <= MAX_IDLE_AVATARS) return
  const idle = [...cache.entries()]
    .filter(([, record]) => !record.promise && record.listeners.size === 0)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  while (cache.size > MAX_IDLE_AVATARS && idle.length) {
    const [key, record] = idle.shift()
    cache.delete(key)
    if (record.url) URL.revokeObjectURL(record.url)
  }
}

// Returns whether the result was applied; a newer authoritative value (for
// example the owner's own profile) supersedes a response already in flight.
function updateRecord(
  record, wire, error = null, expectedGeneration = null, checkedAt = Date.now(), digest = null,
) {
  if (expectedGeneration !== null && record.generation !== expectedGeneration) return false
  touch(record)
  const blob = avatarBlob(wire)
  const oldUrl = record.url
  if (blob?.size) {
    Object.assign(record, {
      url: URL.createObjectURL(blob), failedAt: null, notFoundAt: null,
      fetchedAt: checkedAt, digest,
    })
  } else {
    Object.assign(record, avatarFailureState(error, checkedAt))
    if (error?.status === 404) {
      record.url = null
      record.fetchedAt = null
    }
  }
  record.generation += 1
  for (const listener of record.listeners) listener(record.url)
  if (oldUrl && oldUrl !== record.url) URL.revokeObjectURL(oldUrl)
  return true
}

// Owner-visible gaps (no face shown yet) use the foreground lane; refreshing
// a face that is already on screen is upkeep and yields to what the owner
// waits on.
const laneOf = job => (job.background ? 'background' : 'foreground')

function takeBatch(lane) {
  const jobs = queue.filter(job => laneOf(job) === lane).slice(0, AVATAR_BATCH_SIZE)
  for (const job of jobs) queue.splice(queue.indexOf(job), 1)
  return jobs
}

async function resolveBatch(jobs, lane) {
  const digests = Object.fromEntries(jobs
    .map(job => [job.key, avatarDigest(job.key)])
    .filter(([, digest]) => digest))
  let result = null
  try {
    result = await getPeerAvatars(jobs.map(job => job.key), {
      background: lane === 'background', digests,
    })
  } catch {
    // A shared transport failure stays retryable for every host.
  }
  const missing = new Set(result?.missing || [])
  for (const job of jobs) {
    const wire = result?.avatars?.[job.key]
    const digest = result?.digests?.[job.key] || null
    const applied = updateRecord(
      job.record,
      wire,
      { status: missing.has(job.key) ? 404 : 502 },
      job.generation,
      Date.now(),
      digest,
    )
    if (applied) {
      // Whatever the answer, it was checked against this directory hash; a
      // host the directory cannot serve then keeps time-based freshness.
      job.record.checkedDigest = digests[job.key] || null
      // Only a definite answer is worth keeping; a transient failure must
      // not replace a saved face.
      if (wire || missing.has(job.key)) {
        saveAvatar(job.key, wire, digest, job.record.checkedDigest)
      }
    }
    if (job.record.promise === job.promise) job.record.promise = null
    job.resolve()
  }
  pruneIdleAvatars()
}

function scheduleFlush() {
  for (const lane of ['foreground', 'background']) {
    if (flushing[lane] || !queue.some(job => laneOf(job) === lane)) continue
    flushing[lane] = true
    queueMicrotask(async () => {
      try {
        for (let jobs = takeBatch(lane); jobs.length; jobs = takeBatch(lane)) {
          await resolveBatch(jobs, lane)
        }
      } finally {
        flushing[lane] = false
        if (queue.some(job => laneOf(job) === lane)) scheduleFlush()
      }
    })
  }
}

// Paint a saved copy when nothing is shown yet. Returns true when that copy is
// still within its freshness window, so no service request is needed.
async function restoreSavedAvatar(key, record) {
  if (record.url) return false
  const generation = record.generation
  const saved = await readSavedAvatar(key)
  if (!saved || record.generation !== generation) return false
  const savedDigest = typeof saved.digest === 'string' ? saved.digest : null
  const applied = saved.avatar
    ? updateRecord(record, saved.avatar, null, generation, saved.checked_at, savedDigest)
    : updateRecord(record, null, { status: 404 }, generation, saved.checked_at)
  if (!applied) return false
  record.checkedDigest = typeof saved.checked_digest === 'string' ? saved.checked_digest : null
  return answerIsCurrent(record, key, Date.now())
}

// A known directory hash decides currency exactly. An answer already checked
// against that hash (the owner's own face, or a host the directory could not
// serve) and a host without one keep time-based freshness, which also spaces
// out retries after a failure.
function isCurrent(record, key, now) {
  return Boolean(record?.promise) || answerIsCurrent(record, key, now)
}

function answerIsCurrent(record, key, now) {
  const digest = avatarDigest(key)
  if (digest && record?.url && record.digest === digest) return true
  if (digest && record?.primedWith === undefined && record?.checkedDigest !== digest) return false
  return avatarCacheIsFresh(record && { ...record, promise: null }, now)
}

// A member who changed their picture gets a new hash in the next feed or
// directory response; refresh their face wherever it is on screen.
onAvatarDigestChange((hosts) => {
  for (const key of hosts) {
    const record = cache.get(key)
    if (record?.url && record.listeners.size && !isCurrent(record, key, Date.now())) {
      cachedAvatar(key)
    }
  }
})

export function cachedAvatar(host) {
  const key = hostKey(host)
  const now = Date.now()
  let record = cache.get(key)
  if (isCurrent(record, key, now)) {
    touch(record)
    return record
  }
  record = record || newRecord()
  let resolveJob
  const promise = new Promise((resolve) => { resolveJob = resolve })
  record.promise = promise
  cache.set(key, record)
  pruneIdleAvatars()
  restoreSavedAvatar(key, record).then((fresh) => {
    if (record.promise !== promise) {
      resolveJob()
      return
    }
    if (fresh) {
      record.promise = null
      resolveJob()
      return
    }
    queue.push({
      key, record, promise, resolve: resolveJob, generation: record.generation,
      background: Boolean(record.url),
    })
    scheduleFlush()
  })
  return record
}

export function cachedAvatarUrl(host) {
  return cache.get(hostKey(host))?.url || null
}

export function primeAvatar(host, wire) {
  const key = hostKey(host)
  if (!key) return
  const record = cache.get(key) || newRecord()
  touch(record)
  // The owner's own profile is authoritative; persist it only when it changes.
  const data = wire?.data_b64 ?? null
  if (record.primedWith !== data) saveAvatar(key, wire)
  record.primedWith = data
  if (!wire) {
    const oldUrl = record.url
    Object.assign(record, {
      url: null, failedAt: null, notFoundAt: null, fetchedAt: null,
    })
    record.generation += 1
    for (const listener of record.listeners) listener(null)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    cache.set(key, record)
    pruneIdleAvatars()
    return
  }
  updateRecord(record, wire, { status: 404 })
  cache.set(key, record)
  pruneIdleAvatars()
}

export function subscribeAvatar(record, listener) {
  touch(record)
  record.listeners.add(listener)
  return () => {
    record.listeners.delete(listener)
    pruneIdleAvatars()
  }
}

export function discardAvatar(host, url) {
  const key = hostKey(host)
  const record = cache.get(key)
  if (!record || record.url !== url) return
  URL.revokeObjectURL(record.url)
  record.url = null
  record.fetchedAt = null
  record.generation += 1
  for (const listener of record.listeners) listener(null)
  // An undecodable saved copy must not come back on the next launch.
  forgetSavedAvatar(key)
  pruneIdleAvatars()
}
