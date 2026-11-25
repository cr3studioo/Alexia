// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url'
import { decide, DEFAULT_SKIP_APPS, parseSkipApps } from './filter.js'

/**
 * Screen memory's working half: the capture loop, the daily prune, and the three things the
 * tools ask of the table. Everything it touches is handed in — storage, capability calls, the
 * file delete, the clock and the timers — so the tests drive it with fakes.
 *
 * The order of one capture is the privacy argument, so it is spelled out:
 *
 * 1. nothing at all unless `on` is set (it ships off);
 * 2. a screenshot through `computer.screenshot` — this plugin never captures the screen itself;
 * 3. if the window in front already rules the moment out, the picture is deleted unread;
 * 4. otherwise its words through `image.ocr`, and the picture deleted in a `finally`, whatever
 *    the OCR did, **before anything else happens to the words**;
 * 5. the filter, which drops the moment or cuts the secrets out of it;
 * 6. only then a row, with its meaning from `text.embed` when something answers it.
 *
 * Nothing read off the screen — words, window titles, app names — is ever logged. A log line
 * here says that something happened, never what was on screen when it did.
 */

export const TABLE = 'moments'
const DAY = 24 * 60 * 60 * 1000
const EVERY = [2, 5, 10]
const KEEP = [3, 7, 14]
/** At most this many rows are read for a recall: 14 days at one every 2 minutes, and some. */
const MOST_ROWS = 12_000
/** Rows per delete when forgetting a span by rowid. */
const DELETE_CHUNK = 500

const pick = (value, allowed, fallback) => {
  const n = Number(value)
  return allowed.includes(n) ? n : fallback
}

/** The settings, read leniently: a value that is not one of the choices is the default. */
export function readSettings(raw = {}) {
  return {
    // Only an explicit yes turns it on. A missing, unreadable or odd value is off.
    on: raw.on === true || raw.on === 'true',
    every_minutes: pick(raw.every_minutes, EVERY, 5),
    keep_days: pick(raw.keep_days, KEEP, 14),
    skip_apps: typeof raw.skip_apps === 'string' ? raw.skip_apps : DEFAULT_SKIP_APPS,
  }
}

/** A time from a tool argument: epoch milliseconds, or anything `Date.parse` reads. */
export function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && /^\d+$/.test(value.trim())) return n
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const textOf = (result) =>
  (result?.content ?? [])
    .flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')

/** Where the screenshot was saved: its file link, its structured path, or the path in its text. */
export function screenshotPath(result) {
  for (const part of result?.content ?? []) {
    if (part?.type === 'resource_link' && typeof part.uri === 'string') {
      try {
        return part.uri.startsWith('file:') ? fileURLToPath(part.uri) : part.uri
      } catch {
        // Not a file on this machine; try the other places.
      }
    }
  }
  const structured = result?.structuredContent
  if (typeof structured?.path === 'string' && structured.path !== '') return structured.path
  const said = /Saved (.+?\.(?:png|jpe?g|bmp|webp)) \(/i.exec(textOf(result))
  return said ? said[1] : undefined
}

/**
 * The window in front, as the screenshot's provider reported it, in the filter's words. A
 * provider that says nothing about it gives `undefined`, and the filter drops the moment.
 */
export function frontOf(result) {
  const s = result?.structuredContent
  const w = s?.front ?? s?.window
  if (!w || typeof w !== 'object') return { front: undefined, locked: s?.locked === true }
  const bool = (...values) => values.find((v) => typeof v === 'boolean')
  return {
    front: {
      app: [w.app, w.process, w.name].find((v) => typeof v === 'string'),
      title: typeof w.title === 'string' ? w.title : undefined,
      fullscreen: bool(w.fullscreen, w.full_screen),
      titleBar: bool(w.titleBar, w.title_bar),
    },
    locked: s.locked === true || w.locked === true,
  }
}

/** Vectors as stored: JSON text, rounded so a row is not mostly decimals. */
const pack = (vector) =>
  Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === 'number' && Number.isFinite(n)) ?
    JSON.stringify(vector.map((n) => Math.round(n * 1e5) / 1e5))
  : null

const unpack = (stored) => {
  try {
    const v = typeof stored === 'string' ? JSON.parse(stored) : stored
    return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number') ? v : null
  } catch {
    return null
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

const words = (text) => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])

/** Share of the question's words found in the text. */
const overlap = (question, text) => {
  const asked = words(question)
  if (asked.size === 0) return 0
  const have = words(text)
  let hit = 0
  for (const w of asked) if (have.has(w)) hit += 1
  return hit / asked.size
}

/**
 * @param {object} deps
 * @param {import('@alexia/sdk').Storage} deps.storage
 * @param {(cap: string, args?: object) => Promise<any>} deps.capability
 * @param {(cap: string) => Promise<{ answers: boolean }>} deps.answers
 * @param {() => Promise<Record<string, unknown>>} deps.settings
 * @param {(path: string) => Promise<void>} deps.unlink  deletes a file; may throw
 * @param {(text: string) => void} [deps.status]  the settings screen's State line
 * @param {(message: string) => void} [deps.warn]  a log line with nothing read off the screen in it
 * @param {() => number} [deps.now]
 */
export function createScreenMemory({ storage, capability, answers, settings, unlink, status = () => {}, warn = () => {}, now = Date.now }) {
  const can = async (cap) => {
    try {
      return (await answers(cap))?.answers === true
    } catch {
      return false
    }
  }

  const current = async () => readSettings((await settings().catch(() => ({}))) ?? {})

  /** One vector per text, or null when nothing answers `text.embed` or it failed. */
  async function embed(texts) {
    if (!(await can('text.embed'))) return null
    try {
      const result = await capability('text.embed', { texts })
      if (result?.isError === true) return null
      const vectors = result?.structuredContent?.vectors
      return Array.isArray(vectors) && vectors.length === texts.length ? vectors : null
    } catch {
      return null
    }
  }

  async function remember(outcome) {
    // Only the fixed outcome word and when; nothing read off the screen.
    await storage.set('last', { at: now(), outcome }).catch(() => {})
  }

  /** Delete the picture. Never throws: the caller is in a `finally`. */
  async function drop(path) {
    try {
      await unlink(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      warn('a screenshot could not be deleted')
      return false
    }
  }

  /**
   * One moment: look, read, delete, filter, keep. Resolves to `{ kept, reason }`, where reason
   * is a fixed word. Does nothing at all while the setting is off.
   */
  async function captureOnce() {
    const s = await current()
    if (!s.on) return { kept: false, reason: 'off' }
    if (!(await can('computer.screenshot'))) return finish('no_screenshot')
    if (!(await can('image.ocr'))) return finish('no_ocr')

    let shot
    try {
      shot = await capability('computer.screenshot', {})
    } catch {
      shot = undefined
    }
    const path = screenshotPath(shot)
    if (path === undefined) return finish('no_screenshot')

    const seen = frontOf(shot)
    const skip = parseSkipApps(s.skip_apps)
    let text
    let stopped
    try {
      if (shot?.isError === true) stopped = 'no_screenshot'
      else {
        // The window alone can rule the moment out: then the picture is never read at all.
        const early = decide({ ...seen, text: 'x' }, skip)
        if (!early.keep) stopped = early.reason
        else {
          try {
            const read = await capability('image.ocr', { file: path })
            if (read?.isError === true) stopped = 'ocr_failed'
            else text = textOf(read)
          } catch {
            stopped = 'ocr_failed'
          }
        }
      }
    } finally {
      // Before anything else, and whatever happened above.
      await drop(path)
    }
    if (stopped !== undefined) return finish(stopped)

    const verdict = decide({ ...seen, text }, skip)
    if (!verdict.keep) return finish(verdict.reason)
    const vectors = await embed([verdict.text])
    await storage.insert(TABLE, {
      at: now(),
      app: verdict.app,
      title: verdict.title,
      text: verdict.text,
      vec: pack(vectors?.[0]),
    })
    return finish('kept', true)
  }

  async function finish(reason, kept = false) {
    await remember(reason)
    return { kept, reason }
  }

  /** Delete every row older than `keep_days`. Runs whether or not capture is on. */
  async function prune() {
    const { keep_days } = await current()
    return storage.delete(TABLE, { at: { lt: now() - keep_days * DAY } })
  }

  /** Rows inside [from, to], oldest first. `where` takes one operator per column, so `to` is applied here. */
  async function within(from, to) {
    const where = from !== undefined ? { at: { gte: from } } : to !== undefined ? { at: { lte: to } } : undefined
    const rows = await storage.select(TABLE, { ...(where && { where }), order: [['at', 'asc']], limit: MOST_ROWS })
    return rows.filter((r) => (from === undefined || Number(r.at) >= from) && (to === undefined || Number(r.at) <= to))
  }

  /** The moments that best match a question, by meaning when something can embed, by words when not. */
  async function recall({ query, from, to, limit } = {}) {
    const question = String(query ?? '').trim()
    if (question === '') return { error: 'What should I look for? This needs a query.' }
    const start = timeOf(from)
    const end = timeOf(to)
    if ((from !== undefined && start === undefined) || (to !== undefined && end === undefined)) {
      return { error: 'That time is not one I can read. Give it as an ISO date and time.' }
    }
    const many = Math.min(20, Math.max(1, Number(limit) || 5))
    const rows = await within(start, end)
    if (rows.length === 0) return { results: [], empty: true }
    const made = await embed([question])
    const asked = made ? unpack(made[0]) : null
    const scored = rows
      .map((row) => {
        const meaning = asked ? cosine(asked, unpack(row.vec)) : 0
        const shared = overlap(question, `${String(row.title ?? '')} ${String(row.text ?? '')}`)
        return { row, score: asked && meaning > 0 ? 0.8 * meaning + 0.2 * shared : shared }
      })
      .filter((one) => one.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.row.at) - Number(a.row.at))
      .slice(0, many)
    return {
      byMeaning: asked !== null,
      results: scored.map(({ row, score }) => ({
        at: new Date(Number(row.at)).toISOString(),
        app: String(row.app ?? ''),
        title: String(row.title ?? ''),
        text: String(row.text ?? ''),
        score: Math.round(score * 1000) / 1000,
      })),
    }
  }

  /** Delete every moment in [from, to]. Both ends are required: forgetting is never open-ended by accident. */
  async function forget({ from, to } = {}) {
    const start = timeOf(from)
    const end = timeOf(to)
    if (start === undefined || end === undefined) return { error: 'Forgetting needs both a from and a to time.' }
    if (end < start) return { error: 'The to time is before the from time.' }
    const ids = (await within(start, end)).map((r) => Number(r.rowid)).filter(Number.isFinite)
    let deleted = 0
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      deleted += await storage.delete(TABLE, { rowid: { in: ids.slice(i, i + DELETE_CHUNK) } })
    }
    return { deleted, from: new Date(start).toISOString(), to: new Date(end).toISOString() }
  }

  async function info() {
    const s = await current()
    const count = await storage.count(TABLE)
    const [oldest] = count > 0 ? await storage.select(TABLE, { order: [['at', 'asc']], limit: 1 }) : []
    const [newest] = count > 0 ? await storage.select(TABLE, { order: [['at', 'desc']], limit: 1 }) : []
    const last = await storage.get('last').catch(() => undefined)
    const iso = (row) => (row ? new Date(Number(row.at)).toISOString() : null)
    return {
      on: s.on,
      every_minutes: s.every_minutes,
      keep_days: s.keep_days,
      moments: count,
      oldest: iso(oldest),
      newest: iso(newest),
      last: last && typeof last === 'object' ? last : null,
      can: {
        screenshot: await can('computer.screenshot'),
        ocr: await can('image.ocr'),
        embed: await can('text.embed'),
      },
    }
  }

  /** The State line. Counts and fixed words only. */
  async function report() {
    try {
      const i = await info()
      const outcome = i.last?.outcome
      let line
      if (!i.on) line = `■ Off. ${String(i.moments)} moments kept.`
      else if (!i.can.screenshot || !i.can.ocr) line = '▲ On, but nothing here can take a screenshot and read it.'
      else if (outcome === 'unknown_window') {
        line = '▲ On, but the screenshot does not say which window is in front, so nothing is kept.'
      } else line = `● On, every ${String(i.every_minutes)} minutes. ${String(i.moments)} moments kept for ${String(i.keep_days)} days.`
      status(line)
    } catch {
      // The State line is a courtesy; failing to write it changes nothing else.
    }
  }

  return { captureOnce, prune, recall, forget, info, report, settings: current }
}

/**
 * The timers. `arm` reads the settings and is called again on every settings change; a capture
 * runs only while `on` is set, a prune once a day whatever it is. A capture that is still
 * running when the next is due is not doubled up.
 */
export function createLoop({ memory, set = setInterval, clear = clearInterval }) {
  let capture
  let daily
  let busy = false
  let generation = 0

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await memory.captureOnce()
    } catch {
      // A failed moment is a missing moment; the next one is in a few minutes.
    } finally {
      busy = false
      await memory.report()
    }
  }

  const pruneNow = async () => {
    try {
      await memory.prune()
    } catch {
      // Tried again tomorrow.
    }
  }

  return {
    tick,
    async arm() {
      const mine = (generation += 1)
      const s = await memory.settings()
      if (mine !== generation) return
      clear(capture)
      capture = undefined
      if (s.on) {
        capture = set(() => void tick(), s.every_minutes * 60_000)
        capture.unref?.()
      }
      if (daily === undefined) {
        daily = set(() => void pruneNow(), DAY)
        daily.unref?.()
      }
      // keep_days may have just been lowered: the rows past it go now, not tomorrow.
      await pruneNow()
      await memory.report()
    },
    stop() {
      generation += 1
      clear(capture)
      clear(daily)
      capture = undefined
      daily = undefined
    },
  }
}
