// SPDX-License-Identifier: AGPL-3.0-only
import { basename } from 'node:path'
import { clampSummary, parseNote, parsePlain } from './parse.js'
import { classify, gone, inside, kindOf, sha256, sortFolders, walk } from './scan.js'

/**
 * The library itself, with everything it touches handed in: the file system, the table, the
 * embedder, the model, the extractor, the clock. `index.js` hands in the real ones and the tests
 * hand in fakes, which is why none of this needs a disk, a model or a second plugin to be tested.
 *
 * **It never writes to the owner's files.** Nothing in the file-system interface it is given can.
 */

/** A file shorter than this is its own summary. Longer, and a model is asked for three sentences. */
export const SHORT = 200
/** The most `read_document` returns. */
export const MOST_CHARS = 20000
/** How much of a file goes to the model for its summary, and into the embedding. */
const SUMMARY_INPUT = 6000
const EMBED_INPUT = 1500
/** Texts per `text.embed` call. */
const EMBED_BATCH = 16
/** A match below this is not a match. */
const FLOOR = 0.3

const noop = async () => {}

export const pack = (vector) =>
  Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? JSON.stringify(vector.map((n) => Math.round(n * 1e5) / 1e5))
    : null

export function unpack(stored) {
  let vector = stored
  if (typeof stored === 'string') {
    try {
      vector = JSON.parse(stored)
    } catch {
      return null
    }
  }
  return Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === 'number') ? vector : null
}

export function cosine(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)))
}

const fold = (word) => word.normalize('NFD').replace(/\p{M}/gu, '')
const STOP = new Set(['the', 'and', 'for', 'about', 'with', 'from', 'that', 'this', 'what', 'where', 'file', 'document', 'note'])

/** The words of a text worth matching on: three letters or more, no accents, no filler. */
export function wordsOf(text) {
  const out = new Set()
  for (const word of String(text).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const bare = fold(word)
    if ([...bare].length >= 3 && !STOP.has(bare)) out.add(bare)
  }
  return [...out]
}

const jsonList = (stored) => {
  try {
    const list = JSON.parse(String(stored ?? '[]'))
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

/** Folders as the owner typed them: one per line (or `;`), quotes and blanks taken off. */
export function foldersOf(setting) {
  return String(setting ?? '')
    .split(/[\r\n;]+/)
    .map((line) => line.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter((line) => line !== '')
}

const clock = (ms) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

const plural = (n, one, many) => `${String(n)} ${n === 1 ? one : many}`

export function createLibrary(deps) {
  const now = deps.now ?? Date.now
  const setStatus = deps.status ?? noop
  const store = deps.storage
  let running
  let last // { at, files, folders, notes: [] }

  const roots = async () => (await deps.roots().catch(() => [])).filter((one) => typeof one === 'string')

  /** The folders to read: `folders` plus `notes_folder`, each checked against the owner's roots. */
  async function chosen() {
    const settings = await deps.settings()
    const listed = [...foldersOf(settings.folders), ...foldersOf(settings.notes_folder)]
    const wanted = [...new Set(listed)]
    const { allowed, refused } = await sortFolders(wanted, await roots(), deps.real)
    return { allowed, refused, notesFolder: foldersOf(settings.notes_folder)[0] }
  }

  async function embedAll(texts) {
    const vectors = []
    for (let from = 0; from < texts.length; from += EMBED_BATCH) {
      const part = texts.slice(from, from + EMBED_BATCH)
      const made = await Promise.resolve(deps.embed(part)).catch(() => null)
      if (!Array.isArray(made) || made.length !== part.length) return null
      vectors.push(...made.map(pack))
    }
    return vectors
  }

  async function summarise(title, body) {
    const flat = body.replace(/\s+/g, ' ').trim()
    if (flat.length < SHORT) return flat
    const said = await Promise.resolve().then(() =>
      deps.sample(
        'Summarise this document in at most three short sentences, so it can be found later by what it is about. ' +
          'Say what it is and who or what it concerns. Reply with the summary only.\n\n' +
          `Title: ${title}\n\n${body.slice(0, SUMMARY_INPUT)}`,
      ),
    ).catch(() => null)
    const summary = clampSummary(said ?? '')
    // The model could not be reached, or said nothing: the start of the text is the honest fallback.
    return summary !== '' ? summary : clampSummary(flat.slice(0, 400))
  }

  /** The text of one file, or `null` when it cannot be read here (no extractor, unreadable). */
  async function textOf(file, bytes, canExtract) {
    if (file.kind !== 'extract') return Buffer.from(bytes).toString('utf8')
    if (!canExtract) return null
    try {
      return await deps.extract(file.path)
    } catch {
      return null
    }
  }

  const embedText = (parsed, summary) => `${parsed.title}\n${summary}\n${parsed.body.replace(/\s+/g, ' ').slice(0, EMBED_INPUT)}`

  async function read() {
    const { allowed, refused, notesFolder } = await chosen()
    const canExtract = await deps.canExtract().catch(() => false)
    const known = await store.select('files', { limit: 100000 })
    const byPath = new Map(known.map((row) => [String(row.path), row]))

    const found = { files: [], unreadable: [], tooBig: 0, truncated: false }
    for (const folder of allowed) await walk(deps.fs, folder, found)

    const count = { read: 0, kept: 0, skipped: 0, unreadable: 0, removed: 0 }
    const pending = []
    const skippedKinds = new Set()
    const present = []

    for (const file of found.files) {
      present.push(file.path)
      const row = byPath.get(file.path)
      if (file.kind === 'extract' && !canExtract) {
        count.skipped += 1
        skippedKinds.add(file.path.split('.').pop().toLowerCase())
        continue
      }
      const result = await classify(file, row, (path) => deps.fs.readFile(path))
      if (result.state === 'unchanged') {
        count.kept += 1
      } else if (result.state === 'unreadable') {
        count.unreadable += 1
      } else if (result.state === 'touched') {
        await store.update('files', { size: file.size, mtime: file.mtime }, { rowid: Number(row.rowid) })
        count.kept += 1
      } else {
        const text = await textOf(file, result.bytes, canExtract)
        if (text === null) {
          count.unreadable += 1
          continue
        }
        const parsed = file.kind === 'markdown' ? parseNote(text, file.path) : parsePlain(text, file.path)
        const summary = await summarise(parsed.title, parsed.body)
        pending.push({ file, row, sha: result.sha, parsed, summary })
      }
    }

    // One embedding pass for everything changed this run, so the model is asked in batches.
    const vectors = await embedAll(pending.map((one) => embedText(one.parsed, one.summary)))
    const at = now()
    for (const [i, one] of pending.entries()) {
      const set = {
        size: one.file.size,
        mtime: one.file.mtime,
        sha256: one.sha,
        title: one.parsed.title,
        summary: one.summary,
        vec: vectors?.[i] ?? null,
        tags: JSON.stringify(one.parsed.tags),
        links: JSON.stringify(one.parsed.links),
        at,
      }
      if (one.row) await store.update('files', set, { rowid: Number(one.row.rowid) })
      else await store.insert('files', { path: one.file.path, ...set })
      count.read += 1
    }

    // Files from a run when nothing could embed get their vector now, from what is already kept.
    if (vectors !== null) {
      const missing = known.filter((row) => unpack(row.vec) === null && present.includes(String(row.path)))
        .filter((row) => !pending.some((one) => one.file.path === row.path))
      const made = await embedAll(missing.map((row) => `${String(row.title)}\n${String(row.summary)}`))
      if (made !== null) {
        for (const [i, row] of missing.entries()) await store.update('files', { vec: made[i] }, { rowid: Number(row.rowid) })
      }
    }

    for (const row of gone(known, present, found.unreadable)) {
      await store.delete('files', { rowid: Number(row.rowid) })
      count.removed += 1
    }
    // A file this run could not read for want of an extractor keeps its row until it is gone.

    last = { at, files: await store.count('files'), folders: allowed.length, ...count, skippedKinds: [...skippedKinds].sort(), refused, canExtract, notesFolder }
    last.canEmbed = vectors !== null
    await report()
    return { ...count, files: last.files, folders: allowed.length, refused, tooBig: found.tooBig, truncated: found.truncated, canExtract }
  }

  /** The line on the settings screen. A leading ● is ready, ▲ is something to look at, ■ is idle. */
  async function report() {
    if (!last) return setStatus('■ Nothing read yet — choose a folder')
    const parts = []
    const head = `${plural(last.files, 'file', 'files')} from ${plural(last.folders, 'folder', 'folders')}, last read ${clock(last.at)}`
    if (last.folders === 0 && last.refused.length === 0) return setStatus('■ Nothing read yet — choose a folder')
    if (last.refused.length > 0) parts.push(`${plural(last.refused.length, 'folder', 'folders')} outside the folders you opened and not read`)
    if (!last.canExtract && last.skipped > 0) {
      parts.push(`${plural(last.skipped, 'PDF or Word file', 'PDF and Word files')} not read: nothing here can read them, only text and Markdown are`)
    } else if (!last.canExtract) {
      parts.push('only text and Markdown are read: nothing here can read PDF or Word files')
    }
    if (!last.canEmbed && last.read > 0) parts.push('found by words only: nothing here can embed text')
    const mark = last.refused.length > 0 ? '▲' : '●'
    return setStatus(`${mark} ${head}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`)
  }

  /** Read what changed. One run at a time: the timer, a button and a tool can all ask at once. */
  function reindex() {
    running ??= read().finally(() => {
      running = undefined
    })
    return running
  }

  const asRow = (row) => ({
    title: String(row.title ?? ''),
    path: String(row.path),
    summary: String(row.summary ?? ''),
    tags: jsonList(row.tags),
    links: jsonList(row.links),
  })

  /**
   * Find files by what they are about. By meaning when something can embed the question — the
   * cosine of the question against each file's vector, with a small credit for shared words — and
   * by words alone when nothing can.
   */
  async function find(query, limit = 5) {
    const asked = String(query ?? '').trim()
    const rows = await store.select('files', { limit: 100000 })
    if (asked === '' || rows.length === 0) return { results: [], meaning: false, empty: rows.length === 0 }
    const made = await Promise.resolve(deps.embed([asked])).catch(() => null)
    const vector = Array.isArray(made) && made.length === 1 ? unpack(made[0]) : null
    const wanted = wordsOf(asked)
    const scored = []
    for (const row of rows) {
      const item = asRow(row)
      const hay = new Set(wordsOf(`${item.title} ${item.summary} ${item.tags.join(' ')} ${basename(item.path)}`))
      const hit = wanted.filter((word) => hay.has(word))
      const overlap = wanted.length === 0 ? 0 : hit.length / wanted.length
      const meaning = vector ? cosine(vector, unpack(row.vec)) : 0
      const score = vector && meaning > 0 ? 0.8 * meaning + 0.2 * overlap : overlap
      const matched = meaning >= FLOOR || hit.length > 0
      if (!matched) continue
      const why = [
        meaning >= FLOOR ? `close in meaning (${meaning.toFixed(2)})` : '',
        hit.length > 0 ? `shares the words ${hit.join(', ')}` : '',
      ].filter((one) => one !== '')
      scored.push({ ...item, score, why: why.join('; ') })
    }
    scored.sort((a, b) => b.score - a.score)
    const cap = Math.max(1, Math.min(20, Math.floor(Number(limit) || 5)))
    return { results: scored.slice(0, cap), meaning: vector !== null, empty: false }
  }

  /** The text of one file the owner chose to be read, at most {@link MOST_CHARS} characters. */
  async function open(path) {
    const asked = String(path ?? '').trim()
    if (asked === '') return { error: 'Which file? This needs a path.' }
    const { allowed } = await chosen()
    if (!inside(asked, allowed)) return { error: 'That file is not in the folders you chose, so it is not read.' }
    try {
      const real = await deps.real(asked)
      const { allowed: safe } = await sortFolders([real], await roots(), deps.real)
      if (safe.length === 0) return { error: 'That file leads outside the folders you opened, so it is not read.' }
    } catch {
      return { error: `There is no file at ${asked}.` }
    }
    const kind = kindOf(asked)
    if (kind === undefined) return { error: `${basename(asked)} is not a kind of file this reads.` }
    let text
    try {
      if (kind === 'extract') {
        if (!(await deps.canExtract().catch(() => false))) {
          return { error: `${basename(asked)} needs something that can read PDF and Word files, and nothing here can. Text and Markdown files are read.` }
        }
        text = await deps.extract(asked)
      } else {
        text = Buffer.from(await deps.fs.readFile(asked)).toString('utf8')
      }
    } catch {
      return { error: `${basename(asked)} could not be opened.` }
    }
    const cut = text.length > MOST_CHARS
    return { text: cut ? text.slice(0, MOST_CHARS) : text, cut, characters: text.length }
  }

  /** Notes — Markdown files — with their tags and links, optionally only those with one tag. */
  async function notes(tag) {
    const { notesFolder } = await chosen()
    const rows = await store.select('files', { limit: 100000 })
    const wanted = String(tag ?? '').replace(/^#/, '').trim().toLowerCase()
    return rows
      .filter((row) => kindOf(String(row.path)) === 'markdown')
      .filter((row) => notesFolder === undefined || inside(String(row.path), [notesFolder]))
      .map(asRow)
      .filter((note) => wanted === '' || note.tags.some((one) => one === wanted || one.startsWith(`${wanted}/`)))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  return { reindex, find, open, notes, report, status: () => last, hash: sha256 }
}
