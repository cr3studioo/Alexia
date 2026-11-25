// SPDX-License-Identifier: AGPL-3.0-only
import { open, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addDays, day, dueCards, dueCount, grade, newCard, parseCards } from './cards.js'
import { CHUNK_MINUTES, chunkTranscript, fileStem, renderNote } from './notes.js'

/**
 * The tools, over what they are handed: storage, a way to call a capability, a model to
 * sample, the settings, the folders the owner opened, and a clock. Apart from `index.js` so
 * each runs in a test without a wire.
 *
 * Transcript text is never logged and never returned; it goes to the model and into the file.
 */

const EXAM_HORIZON_DAYS = 14
const MAX_CARDS_PER_SESSION = 30
const say = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }) })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const num = (value, fallback) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)
const textOf = (result) => (result?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
const localDay = (ms, tzMin) => new Date(ms + tzMin * 60_000).toISOString().slice(0, 10)

const NOTES_PROMPT =
  'You are making study notes from part of a lecture or meeting transcript. Reply in Markdown with exactly three sections: ' +
  '"## Key points" (a bulleted list), "## Terms" (a bulleted list of "term: meaning"), "## Open questions" (a bulleted list of what was left unanswered). ' +
  'Use only what the transcript says. Write in the language of the transcript.'
const MERGE_PROMPT =
  'You are given notes made from consecutive parts of one lecture or meeting. Merge them into one set of notes with exactly the sections ' +
  '"## Key points", "## Terms" and "## Open questions". Remove repeats, keep the order of the talk, lose nothing that matters.'
const CARDS_PROMPT =
  'Write study questions from these notes. One per line, in the form "Q: question | A: short answer". At most 10. ' +
  'Ask what is worth remembering; each question must make sense on its own. Reply with the lines only.'

/** Whether `path` is inside one of the folders the owner opened. `roots` are MCP roots (`{ uri }`) or paths. */
export async function insideRoots(path, roots) {
  let real
  try {
    real = await realpath(path)
  } catch {
    return false
  }
  for (const root of roots) {
    try {
      const base = await realpath(typeof root === 'string' ? root : fileURLToPath(root.uri))
      const tail = relative(base, real)
      if (tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))) return true
    } catch {
      /* an unreadable root grants nothing */
    }
  }
  return false
}

/** Write `content` to a new file in `folder`, never over an existing one: `wx` fails if it is there. */
export async function writeNew(folder, stem, content) {
  for (let n = 1; n < 10_000; n += 1) {
    const file = join(folder, n === 1 ? `${stem}.md` : `${stem} (${n}).md`)
    let handle
    try {
      handle = await open(file, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return file
  }
  throw new Error('Too many notes with the same name.')
}

export function createStudy({ storage, capability, answers, sample, settings, roots, now = () => Date.now(), tz = () => 0 }) {
  const today = () => localDay(now(), tz(now()))
  const allCards = () => storage.select('cards', { limit: 100_000 })
  const allNotes = () => storage.select('notes', { limit: 100_000 })
  const allExams = () => storage.select('exams', { limit: 10_000 })

  async function summarise(transcript) {
    const chunks = chunkTranscript(transcript, CHUNK_MINUTES)
    const parts = []
    for (const [i, chunk] of chunks.entries()) {
      parts.push(await sample(`Part ${i + 1} of ${chunks.length}.\n\n${chunk}`, NOTES_PROMPT, 1500))
    }
    // One part is already the whole talk; there is nothing to merge.
    return parts.length === 1 ? parts[0] : sample(parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n'), MERGE_PROMPT, 2000)
  }

  /** Cards for a note, asked of the model once; what it gives is kept. */
  async function makeCards(noteId, notesText) {
    const made = parseCards(await sample(notesText, CARDS_PROMPT, 1500))
    for (const card of made) await storage.insert('cards', newCard({ note_id: noteId, ...card }, today()))
    return made.length
  }

  return {
    async lectureNotes({ path, title, course } = {}) {
      if (typeof path !== 'string' || path.trim() === '') return fail('Say which recording to make notes from.')
      if ((await answers('voice.transcribe'))?.answers !== true) {
        return fail('Nothing here can turn a recording into words yet. Switch on a voice plugin that can transcribe, then try again.')
      }
      const folder = (await settings())?.notes_folder
      if (typeof folder !== 'string' || folder.trim() === '') return fail('Choose a notes folder in the Study desk settings first.')
      const opened = await roots()
      if (!(await insideRoots(folder, opened))) {
        return fail('The notes folder is outside the folders you opened in Alexia. Open it there first, or choose another.')
      }
      if (!(await insideRoots(path, opened))) return fail('That recording is outside the folders you opened in Alexia.')

      const heard = await capability('voice.transcribe', { file: path })
      if (heard?.isError) return fail(`The recording could not be transcribed: ${textOf(heard) || 'no reason given'}`)
      const transcript = textOf(heard).trim()
      if (transcript === '') return fail('There was nothing to hear in that recording.')

      const at = now()
      const name = String(title ?? '').trim() || basename(path).replace(/\.[^.]*$/, '')
      const summary = await summarise(transcript)
      const note = renderNote({ title: name, date: localDay(at, tz(at)), course, summary, transcript })
      const written = await writeNew(await realpath(folder), fileStem(name), note)
      const id = await storage.insert('notes', { title: name, path: written, course: course ? String(course).trim() : null, at })
      return say(`Notes saved: ${written}`, { id: String(id), path: written })
    },

    async study({ course, minutes, document } = {}) {
      const date = today()
      const tag = course ? String(course).trim() : null
      if (typeof document === 'string' && document.trim() !== '') {
        if (!(await insideRoots(document, await roots()))) return fail('That document is outside the folders you opened in Alexia.')
        const text = await readFile(document, 'utf8')
        const id = await storage.insert('notes', { title: basename(document), path: document, course: tag, at: now() })
        await makeCards(id, text.slice(0, 40_000))
      }
      const notes = (await allNotes()).filter((n) => !tag || String(n.course ?? '').toLowerCase() === tag.toLowerCase())
      const ids = new Set(notes.map((n) => String(n.rowid)))
      let cards = (await allCards()).filter((c) => ids.has(String(c.note_id)))
      // Nothing due, and a saved note with no questions yet: its questions are made now, one note at a time.
      const asked = new Set(cards.map((c) => String(c.note_id)))
      const bare = notes.find((n) => !asked.has(String(n.rowid)))
      if (bare && dueCount(cards, date) === 0) {
        try {
          const body = await readFile(String(bare.path), 'utf8')
          if ((await makeCards(bare.rowid, body.slice(0, 40_000))) > 0) cards = (await allCards()).filter((c) => ids.has(String(c.note_id)))
        } catch {
          /* the file is gone or unreadable: no cards from it */
        }
      }
      const count = Math.min(MAX_CARDS_PER_SESSION, Math.max(1, Math.round(num(minutes, 10))))
      const out = dueCards(cards, date)
        .slice(0, count)
        .map((c) => ({ id: String(c.rowid), q: String(c.q), a: String(c.a), box: Number(c.box) }))
      return say(
        out.length === 0
          ? 'No cards are due.'
          : `${out.length} card${out.length === 1 ? '' : 's'} to ask, one at a time. Ask the question, check the answer, then call answer_card.`,
        { cards: out },
      )
    },

    async answerCard({ id, right } = {}) {
      const rowid = Number(id)
      const [card] = Number.isInteger(rowid) ? await storage.select('cards', { where: { rowid }, limit: 1 }) : []
      if (!card) return fail('There is no card with that id.')
      if (typeof right !== 'boolean') return fail('Say whether the answer was right: true or false.')
      const next = grade(card, right, today())
      await storage.update('cards', next, { rowid })
      return say(right ? `Right. It comes back on ${next.due}.` : 'Not this time. It comes back tomorrow.', { id: String(rowid), ...next })
    },

    async exam({ course, day: said } = {}) {
      const name = String(course ?? '').trim()
      const when = day(said)
      if (name === '') return fail('Say which course the exam is for.')
      if (when === undefined) return fail(`"${String(said ?? '')}" is not a day. Use YYYY-MM-DD.`)
      const id = await storage.insert('exams', { course: name, day: when, done: 0 })
      return say(`Exam noted: ${name} on ${when}.`, { id: String(id) })
    },

    async exams() {
      const date = today()
      const rows = (await allExams()).filter((e) => !e.done && e.day >= date).sort((a, b) => (a.day < b.day ? -1 : 1))
      return say(rows.length === 0 ? 'No exams coming up.' : rows.map((e) => `- ${e.course}: ${e.day}`).join('\n'), {
        exams: rows.map((e) => ({ id: String(e.rowid), course: String(e.course), day: String(e.day) })),
      })
    },

    /** `notice.items`: cards due today (Low), and each exam in the next 14 days with its own `dueAt`. */
    async noticeItems({ now: at, tz_offset_min } = {}) {
      const moment = num(at, now())
      const offset = num(tz_offset_min, 0)
      const date = localDay(moment, offset)
      const items = []
      const due = dueCount(await allCards(), date)
      if (due > 0) {
        items.push({ key: `study:cards:${date}`, text: `${due} card${due === 1 ? '' : 's'} to review`, why: 'They are due today.', urgency: 'low' })
      }
      const limit = addDays(date, EXAM_HORIZON_DAYS)
      for (const e of await allExams()) {
        if (e.done || e.day < date || e.day > limit) continue
        items.push({
          key: `study:exam:${String(e.rowid)}`,
          text: `${String(e.course)} exam on ${String(e.day)}`,
          why: 'An exam is coming up; a review before it helps.',
          dueAt: Date.parse(`${e.day}T08:00:00Z`) - offset * 60_000,
        })
      }
      return say(items.map((i) => `- ${i.text}`).join('\n'), { items })
    },

    async noticeDone({ key } = {}) {
      const found = /^study:exam:(\d+)$/.exec(String(key ?? ''))
      if (!found) return say('Nothing to close.', { closed: false })
      const rowid = Number(found[1])
      const [row] = await storage.select('exams', { where: { rowid }, limit: 1 })
      if (!row || row.done) return say('Nothing to close.', { closed: false })
      await storage.update('exams', { done: 1 }, { rowid })
      return say('Closed.', { closed: true })
    },
  }
}
