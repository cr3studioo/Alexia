// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { foldSpace, htmlToText, MAX_TEXT } from './extract.js'
import { WatchError } from './fetch.js'
import { matchInterests, newItems, parseFeed, topics } from './feeds.js'

/**
 * What the plugin does, with everything it touches handed in so a test gives it a fake network
 * and a fake store. `deps`: `fetcher` (`get(url)`), `portal` (`read`, `notice`), `storage`
 * (`get(key)`, `set(key, value)`), `settings()`, `status(text)`, `now()`.
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const KEEP_ITEMS_MS = 3 * DAY
const MAX_PAGES = 30
const MAX_FEEDS = 20
const MAX_ITEMS = 60
const MAX_SEEN = 300
const DIFF_LINES = 10

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex')

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** The lines of a setting written one per line; blank lines and `#` comments dropped. */
export function lines(value, max = 100) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, max)
}

/** A page body as text: HTML is reduced to its main text, anything else is only folded. */
export function bodyText(body) {
  const raw = String(body ?? '')
  return /<\s*(html|body|p|div|h1|h2|table|ul)[\s>]/i.test(raw) ? htmlToText(raw) : foldSpace(raw.replace(/\r/g, '')).slice(0, MAX_TEXT)
}

/** What changed between two texts, by line: counts and at most ten lines, `+` added and `-` removed. */
export function diffSummary(before, after) {
  const count = (list) => {
    const m = new Map()
    for (const l of list) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const a = String(before).split('\n')
  const b = String(after).split('\n')
  const old = count(a)
  const now = count(b)
  const added = []
  const removed = []
  for (const l of b) {
    if ((old.get(l) ?? 0) > 0) old.set(l, old.get(l) - 1)
    else added.push(l)
  }
  for (const l of a) {
    if ((now.get(l) ?? 0) > 0) now.set(l, now.get(l) - 1)
    else removed.push(l)
  }
  const clip = (l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l)
  const shown = [...added.map((l) => `+ ${clip(l)}`), ...removed.map((l) => `- ${clip(l)}`)].slice(0, DIFF_LINES)
  const noun = (n) => `${n} ${n === 1 ? 'line' : 'lines'}`
  return { added: added.length, removed: removed.length, summary: `${noun(added.length)} added, ${noun(removed.length)} removed`, shown }
}

/** A short name for a URL in a sentence. */
const label = (raw) => {
  try {
    const u = new URL(raw)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return String(raw)
  }
}

export function createWatcher(deps) {
  const now = () => (deps.now ? deps.now() : Date.now())
  const tell = (line) => Promise.resolve(deps.status?.(line)).catch(() => {})
  const read = async (key, fallback) => (await deps.storage.get(key)) ?? fallback
  let running

  /** The page's main text for the `page.text` capability. */
  async function pageText(args = {}) {
    try {
      const res = await deps.fetcher.get(args.url)
      const body = bodyText(res.text)
      return text(body, { structuredContent: { text: body } })
    } catch (e) {
      return fail(e instanceof WatchError ? e.message : 'The page could not be read.')
    }
  }

  /** Remember a text for a URL; a value too big for the store is kept shorter rather than lost. */
  async function remember(url, hash, body) {
    const key = `page:${sha1(url)}`
    try {
      await deps.storage.set(key, { hash, text: body })
    } catch {
      await deps.storage.set(key, { hash, text: body.slice(0, 8000) })
    }
  }

  /** Compare a page's text with the last one seen. Returns a notice item, or undefined. */
  async function compare(url, body, urgency) {
    const hash = sha1(body)
    const before = await deps.storage.get(`page:${sha1(url)}`)
    if (!before) {
      await remember(url, hash, body)
      return undefined
    }
    if (before.hash === hash) return undefined
    await remember(url, hash, body)
    const diff = diffSummary(before.text ?? '', body)
    return {
      key: `pagewatch:${sha1(url)}:${hash.slice(0, 16)}`,
      text: `${label(url)} changed: ${diff.summary}.`,
      why: diff.shown.join('\n') || diff.summary,
      urgency,
    }
  }

  async function addItems(found) {
    if (found.length === 0) return
    const t = now()
    const kept = (await read('items', [])).filter((i) => t - i.at < KEEP_ITEMS_MS)
    const have = new Set(kept.map((i) => i.key))
    for (const item of found) if (!have.has(item.key)) kept.push({ ...item, at: t })
    await deps.storage.set('items', kept.slice(-MAX_ITEMS))
  }

  /** The new items of one feed. The first read only learns what is there. */
  async function readFeed(url, interests) {
    const res = await deps.fetcher.get(url)
    const items = parseFeed(res.text)
    const memo = await deps.storage.get(`feed:${sha1(url)}`)
    const seen = memo?.ids ?? []
    const fresh = memo ? newItems(items, seen) : []
    const ids = [...new Set([...items.map((i) => i.id), ...seen])].slice(0, MAX_SEEN)
    await deps.storage.set(`feed:${sha1(url)}`, { ids })
    // On the first read the newest few go to the brief, but nobody is told about them.
    const mine = matchInterests(memo ? fresh : items.slice(0, 5), interests)
    const t = now()
    const list = (await read('feeditems', [])).filter((i) => t - i.at < 8 * DAY)
    for (const item of mine) if (!list.some((i) => i.id === item.id && i.feed === url)) list.push({ id: item.id, feed: url, title: item.title, link: item.link, at: t })
    await deps.storage.set('feeditems', list.slice(-100))
    return memo
      ? matchInterests(fresh, interests).map((item) => ({
          key: `pagewatch:${sha1(url)}:${sha1(item.id).slice(0, 16)}`,
          text: `New: ${item.title || label(item.link)}`,
          why: [item.summary, item.link].filter(Boolean).join(' — ') || label(url),
          urgency: 'low',
        }))
      : []
  }

  /** One round over everything the owner named. Never throws; says what it did in the status. */
  async function runOnce() {
    const s = (await deps.settings()) ?? {}
    const pages = lines(s.pages, MAX_PAGES)
    const feeds = lines(s.feeds, MAX_FEEDS)
    const interests = topics(s.interests)
    const found = []
    const problems = []
    let watched = 0

    for (const url of pages) {
      try {
        const res = await deps.fetcher.get(url)
        const item = await compare(url, bodyText(res.text), 'normal')
        if (item) found.push(item)
        watched++
      } catch (e) {
        problems.push(e instanceof WatchError ? e.message : `${label(url)} could not be read.`)
      }
    }

    const portalCfg = { url: s.portal_url, user: s.portal_user, password: s.portal_password, pages: lines(s.portal_pages, 20) }
    const portal = await deps.portal.read(portalCfg)
    if (portal.ok) {
      for (const page of portal.pages) {
        if (page.error) {
          problems.push(`Portal page ${label(page.url)}: ${page.error}`)
          continue
        }
        const item = await compare(page.url, page.text, 'normal')
        if (item) found.push(item)
        watched++
      }
    } else if (!portal.idle) {
      problems.push(portal.reason)
    }

    for (const url of feeds) {
      try {
        found.push(...(await readFeed(url, interests)))
        watched++
      } catch (e) {
        problems.push(e instanceof WatchError ? e.message : `${label(url)} could not be read.`)
      }
    }

    await addItems(found)
    const configured = pages.length + feeds.length + (portalCfg.url ? 1 : 0)
    if (configured === 0) await tell('■ Nothing to watch yet. Add pages or feeds in the settings.')
    else if (problems.length) await tell(`▲ ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`)
    else await tell(`● Watching ${watched} ${watched === 1 ? 'page or feed' : 'pages and feeds'}.`)
    return { found: found.length, watched, problems }
  }

  /** `runOnce`, but never two at a time: a second ask waits for the first and shares its answer. */
  function run() {
    running ??= runOnce().finally(() => {
      running = undefined
    })
    return running
  }

  async function noticeItems() {
    const t = now()
    const stored = (await read('items', [])).filter((i) => t - i.at < KEEP_ITEMS_MS)
    const items = [...stored.map((i) => ({ key: i.key, text: i.text, why: i.why, urgency: i.urgency })), ...(await deps.portal.notice())]
    return text(items.map((i) => `- ${i.text}`).join('\n'), { structuredContent: { items } })
  }

  async function briefSection({ kind, now: at } = {}) {
    const t = Number.isFinite(Number(at)) && at !== undefined && at !== null ? Number(at) : now()
    const limit = kind === 'morning' ? 5 : kind === 'weekly' ? 10 : 0
    const since = t - (kind === 'weekly' ? 7 * DAY : DAY)
    const list = limit
      ? (await read('feeditems', [])).filter((i) => i.at >= since).sort((a, b) => b.at - a.at).slice(0, limit)
      : []
    const body = list.length ? ['From what you follow:', ...list.map((i) => `- ${i.title || label(i.link)}${i.link ? ` (${i.link})` : ''}`)].join('\n') : ''
    return text(body, { structuredContent: { title: 'From what you follow', text: body } })
  }

  async function checkNow() {
    const r = await run()
    const said = r.problems.length ? ` ${r.problems.join(' ')}` : ''
    return text(`Checked ${r.watched} ${r.watched === 1 ? 'page or feed' : 'pages and feeds'}; ${r.found} new ${r.found === 1 ? 'change' : 'changes'}.${said}`, { structuredContent: { watched: r.watched, found: r.found, problems: r.problems } })
  }

  return { pageText, run, noticeItems, briefSection, checkNow }
}
