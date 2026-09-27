// Content hashes of directory members' avatars, as the community host reports
// them on board posts, reply authors, and directory rows. A hash names one
// exact image: a saved face with the same hash is current however old it is,
// and a different hash means the member changed their picture. People without
// a hash keep time-based refresh.

const DIGEST = /^[0-9a-f]{64}$/
const digests = new Map()
const listeners = new Set()

const hostKey = (host) => String(host || '').trim().toLowerCase()

export function avatarDigest(host) {
  return digests.get(hostKey(host)) || null
}

export function onAvatarDigestChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Accepts any rows shaped like { host, avatar } and returns them unchanged.
export function noteAvatarDigests(people) {
  const changed = []
  for (const person of people || []) {
    const key = hostKey(person?.host)
    const digest = person?.avatar
    if (!key || typeof digest !== 'string' || !DIGEST.test(digest)) continue
    if (digests.get(key) === digest) continue
    digests.set(key, digest)
    changed.push(key)
  }
  if (changed.length) for (const listener of listeners) listener(changed)
  return people
}

export function noteBoardAvatarDigests(posts) {
  noteAvatarDigests(posts)
  for (const post of posts || []) noteAvatarDigests(post?.reply_authors)
  return posts
}
