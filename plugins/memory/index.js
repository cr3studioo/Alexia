// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { BATCH, originOf, parse, plan, prompt, TRIES } from './capture.js'
import {
  aliasesOf,
  findGoal,
  findPerson,
  fold,
  doneChange,
  fromContacts,
  idsOf,
  noticeItems,
  offsetAt,
  relinkPlan,
  unlinkPlan,
  normalBirthday,
  personLine,
  resolveDue,
} from './graph.js'
import { clean, DEFAULT_FILLER, worthSorting } from './prefilter.js'
import {
  chain,
  due,
  GARDEN_EVERY,
  GARDEN_MOST,
  duplicates,
  nightlyDue,
  nightOf,
  pastDates,
  relative,
  REVIEW_AFTER,
  rewrite,
  rewritePrompt,
  stale,
  tidiedLine,
  timeBound,
  valid,
  when,
} from './garden.js'
import { bullets, distinct, edits, lockedOf, pinnedLines, pinnedOf, profile, renderFile, same as sameLine, seedable, visible } from './profile.js'
import { batches, exportFile, insideRoots, origin as importedFrom, parseExport, rootPaths } from './import.js'
import { between, dayEntry, dayOf, dayPrompt, bounds as dayBounds, lineOf, plainEntry, section as briefSection, upsert as dayUpsert, before as dayBefore } from './timeline.js'
import { originFields, pack, rank, rankByMeaning, sourceOf } from './search.js'
import {
  bare,
  below,
  browse as browsing,
  build,
  depthOf,
  destination,
  DEPTH,
  group,
  header,
  height,
  homesOf,
  nodes as treeNodes,
  nameOk,
  PLACE_MOST,
  parseArray,
  pathOf,
  placePrompt,
  plan as planned,
  readSummaries,
  ROOT,
  SECTIONS,
  counts,
  childNamed,
  summaryPrompt,
  SUMMARY_MOST,
  touched,
  alsoOf,
} from './tree.js'

/**
 * Long-term memory (M4-3).
 *
 * **The line this plugin draws is the interesting part.** Deleting it makes Alexia forget
 * you *across* conversations — your preferences, what you told it last month, the name of
 * your dog. It does not touch the conversation you are having right now, because that
 * belongs to core and always did. That is the line a person would expect from something
 * called "memory", and it is why history lives in core rather than here.
 *
 * It asks for **no permissions at all**, which is the other thing worth noticing: the
 * riskiest-sounding plugin in the library needs nothing but its own namespace, because
 * everything it holds arrived through the contract and leaves through it.
 */

const alexia = plugin()

/** What a remembered thing is: a sentence, where it came from, and when. */
const KINDS = ['fact', 'preference', 'person', 'place', 'task', 'other']

const settings = () => alexia.settings()

/**
 * How a note got here, and it is the distinction automatic capture makes necessary.
 *
 * `stated` is *you told me*. `inferred` is *I worked it out from something you said*, which
 * is the thing that can be wrong in a way nobody remembers agreeing to. The predecessor
 * called this certainty decay and let it fade a float; naming the two is the same idea with
 * an answer a person can argue with, and recall says which one it is reading back.
 */
const STATED = 'stated'
const INFERRED = 'inferred'

/**
 * Pinned: in what Alexia always knows about you (`profile.js`), rather than only in what it can
 * find when it looks.
 *
 * **A column on `facts`, not a side table.** Plugin storage is schemaless — core adds a column
 * the first time a key appears in an insert *or* an update (`#ensure` in core's store) — so the
 * first `update(..., { pinned: true })` grows the column on a database that already holds rows,
 * and every older row reads it as `null`, which is *not pinned*. A side table would be a second
 * thing for `forget_one` and `forget_all` to remember to clean, and forgetting a pinned note
 * must take its pin with it by construction rather than by care.
 *
 * The one catch, and why nothing here says `where: { pinned: … }`: until the first pin, the
 * column does not exist, and filtering on a column that does not exist is an error on
 * purpose. So pinned notes are picked out of `notes()` with `pinnedOf`, which is hundreds of
 * rows and fine.
 */
const SEEDED = 'profile_seeded'

/** When the gardener last looked, in kv like `SEEDED` — see `garden` below. */
const GARDENED = 'gardened'

/**
 * The tree (`tree.js`): written once, like the profile seed, so pruning a section a person did
 * not want does not bring it back on the next start. `forget_all` plants it again.
 */
const PLANTED = 'tree_seeded'

/**
 * Branches whose summaries are behind what is under them, in kv as `{ ids }`. Anything that
 * changes what a branch holds — a placement, a note closed, replaced, forgotten or moved — adds
 * to it, and the next `arrange` re-summarises them in one call. Kept rather than done on the
 * spot, so that a person forgetting something is never waiting on a model.
 */
const BEHIND = 'resummarise'

/** The last nightly pass, as a sentence for the status line, and what is wrong with the profile file, if anything. */
let tidied = ''
let fileNote = ''

async function report() {
  const live = await current()
  const held = live.length
  const doubtful = live.filter(stale).length
  const { capture } = await settings()
  const waiting = capture === true ? await alexia.storage.count('buffer') : 0
  const meaning = await canEmbed()
  const remembers =
    held === 0 ? '■ Nothing remembered yet'
    : `● ${held} thing${held === 1 ? '' : 's'} remembered, ${meaning ? 'found by meaning' : 'by words only: nothing here can embed text'}`
  const noticing =
    capture === true ?
      waiting === 0 ? ', writing things down by itself'
      : `, ${waiting} exchange${waiting === 1 ? '' : 's'} waiting to be sorted`
    : ', only what it is told to'
  // Kept in the profile and in recall, marked there; counted here so it is seen without asking.
  const checking = doubtful === 0 ? '' : `, ${doubtful} note${doubtful === 1 ? '' : 's'} may be out of date`
  const tidy = tidied === '' ? '' : `. ${tidied}`
  const file = fileNote === '' ? '' : `. ${fileNote}`
  await alexia.status('state', `${remembers}${noticing}${checking}${tidy}${file}`).catch(() => {})
}

/**
 * Finding by meaning (P3-13).
 *
 * `text.embed` is a capability, named and never a plugin: whatever answers it (a local model,
 * today) turns sentences into vectors, and this plugin keeps each one as a column of its own
 * (`vec`, a JSON array rounded to five places; `vec_model` when the host says which model made
 * it). Nothing here can embed text → every function below answers `null` or `false` and the
 * plugin carries on with v2's word ranking, saying so once, in its status line.
 *
 * Facts are the owner's data: no text goes into a log line or an error message from here.
 */
const EMBED = 'text.embed'
/** How many facts without a vector one backfill pass embeds, and how many go in one call. */
const BACKFILL = 50
/** The model that made the last vectors, when the host said. A fact made by another is re-embedded. */
let modelNow
/** When an embed call last failed outright (ms), or 0. The status does not claim what is not true. */
let embedFailedAt = 0
/** After a failure, how long before `text.embed` is tried again. One bad call is not forever. */
const EMBED_RETRY_MS = 5 * 60 * 1000

/** Would anything answer `text.embed` right now? Asked, not assumed, and never throws. */
async function canEmbed() {
  if (embedFailedAt !== 0 && Date.now() - embedFailedAt < EMBED_RETRY_MS) return false
  try {
    return (await alexia.answers(EMBED)).answers === true
  } catch {
    return false
  }
}

/** The vectors for these texts, packed for storage, or `null` when nothing could make them. */
async function embedding(texts) {
  if (texts.length === 0 || !(await canEmbed())) return null
  try {
    const result = await alexia.capability(EMBED, { texts })
    if (result?.isError === true) throw new Error('embed refused')
    let body = result?.structuredContent
    if (!body || typeof body !== 'object') {
      const said = (result?.content ?? []).find((part) => part?.type === 'text')?.text
      body = JSON.parse(String(said ?? '{}'))
    }
    const vectors = Array.isArray(body?.vectors) ? body.vectors.map(pack) : []
    if (vectors.length !== texts.length || vectors.some((one) => one === null)) throw new Error('embed answered badly')
    embedFailedAt = 0
    const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined
    if (model !== undefined) modelNow = model
    return { vectors, model }
  } catch {
    // Not the error's words: it could carry the text that was sent.
    embedFailedAt = Date.now()
    return null
  }
}

/**
 * Give these facts a vector, as many as one call can carry. Best effort, always: a fact that
 * could not be embedded is still a fact, found by its words, and the backfill tries again.
 */
async function vectorise(facts) {
  for (let from = 0; from < facts.length; from += BACKFILL) {
    const batch = facts.slice(from, from + BACKFILL)
    const made = await embedding(batch.map((one) => String(one.text)))
    if (made === null) return
    for (let i = 0; i < batch.length; i += 1) {
      await alexia.storage
        .update('facts', { vec: made.vectors[i], ...(made.model === undefined ? {} : { vec_model: made.model }) }, { rowid: Number(batch[i].rowid) })
        .catch(() => {})
    }
  }
}

/**
 * Embed up to `BACKFILL` true facts that have no vector — or whose vector was made by another
 * model than the one answering now — newest first, so what was just said is found first.
 */
async function backfill() {
  if (!(await canEmbed())) return 0
  const pending = (await current())
    .filter((row) => row.vec === undefined || row.vec === null || row.vec === '' || (modelNow !== undefined && row.vec_model !== modelNow))
    .slice(0, BACKFILL)
  if (pending.length === 0) return 0
  await vectorise(pending)
  await report()
  return pending.length
}

/** The channel, turn and document a call came from, when the host said: arguments or private context. */
function originFrom(args, ctx) {
  const meta = ctx?.mcpReq?._meta?.['alexia/privateContext']
  const pick = (key) => args?.[key] ?? (meta !== null && typeof meta === 'object' ? meta[key] : undefined)
  return { channel: pick('channel'), session: pick('session'), doc: pick('doc') }
}

/** The line a fact is shown on: what it says, then where it came from. */
const factLine = (row, more = '') => `- ${String(row.text)}  (${sourceOf(row)}${stale(row) ? ', may be out of date' : ''}${more})`

/**
 * Every note, newest first. It is hundreds of short rows — see the ceiling in `search.js`.
 *
 * **Ties broken by the row, latest written first.** Notes written in one pass share a
 * millisecond often enough, and `at` alone left their order to SQLite — the list came back in a
 * different order from one read to the next.
 */
const NEWEST = [['at', 'desc'], ['rowid', 'desc']]
const notes = () => alexia.storage.select('facts', { order: NEWEST, limit: 2000 })

/**
 * The notes that are still true — what everything that *uses* memory reads. The closed ones
 * stay in the table as history (`garden.js`), and only `history`, `about_memory`, the panel's
 * list and forgetting ever look at them. Filtered here in code rather than with `where`,
 * because `invalid_at` does not exist as a column until the first note is closed.
 */
const current = async () => (await notes()).filter(valid)

/** A millisecond time as the day it was, which is all a person needs to read. */
const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10)

/**
 * Setting columns back to null, for the ones this row has. Writing `null` to a column that does
 * not exist yet would create it as TEXT, and every millisecond written to it after would come
 * back a string — and a row read without the column has nothing to clear anyway.
 */
const cleared = (row, keys) => Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, null]))

/**
 * The tree, as `tree.js` reads it. A few dozen rows; read whole, like the notes.
 */
const tree = async () => build(await alexia.storage.select('branches', { limit: 2000 }))

/**
 * The root and its sections, once. The root is written **without** a `parent` key, so the
 * column is created by the first section as a number — writing `null` first would make it TEXT
 * and every parent after it would come back a string (the same trap as `cleared`).
 */
let planting
const plant = () => {
  // One at a time: the start-up run and a panel opening in the same second would plant twice.
  planting ??= plantOnce().finally(() => {
    planting = undefined
  })
  return planting
}
async function plantOnce() {
  if (await alexia.storage.get(PLANTED)) return
  if ((await alexia.storage.count('branches')) === 0) {
    const now = Date.now()
    const root = await alexia.storage.insert('branches', { name: ROOT, summary: '', seed: true, at: now, updated_at: now })
    for (const name of SECTIONS) {
      await alexia.storage.insert('branches', { parent: root, name, summary: '', seed: true, at: now, updated_at: now })
    }
  }
  await alexia.storage.set(PLANTED, { at: Date.now() })
}

/** A new branch under `parent`. Returns its rowid. */
const sprout = (parent, name, now = Date.now()) =>
  alexia.storage.insert('branches', { parent, name, summary: '', seed: false, at: now, updated_at: now })

/** Branches to re-summarise next `arrange`, added to what is already waiting. */
async function behind(ids) {
  const more = [...ids].map(Number).filter((id) => Number.isInteger(id) && id > 0)
  if (more.length === 0) return
  const held = (await alexia.storage.get(BEHIND))?.ids ?? []
  await alexia.storage.set(BEHIND, { ids: [...new Set([...held.map(Number), ...more])] })
}

/**
 * The branches a note is filed in, marked behind — and, when `now`, their summaries blanked on
 * the spot along with every summary above them. That is for forgetting: a summary that still
 * says *Niki, his girlfriend, likes anime* after *forget Niki* has not forgotten anything, so
 * it goes before the forget returns, and a fresh one is written from what is left next run.
 */
async function unsettle(rows, { blank = false } = {}) {
  const t = await tree()
  const ids = touched(t, rows.flatMap((row) => homesOf(t, row)))
  if (blank) {
    for (const id of ids) {
      if (t.nodes.get(id)?.summary !== '') await alexia.storage.update('branches', { summary: '', updated_at: Date.now() }, { rowid: id })
    }
  }
  await behind(ids)
}

/**
 * What a new version of a note takes from the old one: where it was filed. A replacement is
 * the same subject said better or later, and making the placer find *Niki* again for it would
 * be a call spent learning what was already known.
 */
const filedLike = (old) =>
  old && when(old.branch) !== null ? { branch: when(old.branch), ...(alsoOf(old).length > 0 ? { also: JSON.stringify(alsoOf(old)) } : {}) } : {}

/** A replacement of a locked note is locked too: changing the words does not unlock them. */
const lockedLike = (old) => (old && lockedOf(old) ? { locked: true } : {})

/**
 * Close `old` because `rowid` says what it said, better or later. Invalidate, never delete: the
 * old version is what `history` reads, and a wrong replacement stays one person's click from
 * undone rather than gone. Its pin goes to the new note (the caller writes that one), because
 * the profile should say the new thing and not stop saying anything.
 */
async function supersede(old, rowid, now, { rewrite = false } = {}) {
  // A correction takes its deadlines, people and goals with it; a rewording only moves them.
  await mend([Number(old.rowid)], rewrite ? rowid : undefined).catch(() => log.info('could not tidy the life graph'))
  await alexia.storage.update(
    'facts',
    { invalid_at: now, replaced_by: rowid, ...(pinnedOf(old) ? { pinned: false } : {}) },
    { rowid: Number(old.rowid) },
  )
  // What its branch says is now about a version that stopped being true.
  await unsettle([old])
}

/** A note's own name, which is what a link points at. Older rows never had one. */
const nameOf = (row) => String(row.name ?? row.text ?? '').trim()

const linksOf = (row) => {
  try {
    const held = JSON.parse(String(row.links ?? '[]'))
    return Array.isArray(held) ? held.map(String) : []
  } catch {
    return []
  }
}

/**
 * Forgetting, in the order that makes it stick.
 *
 * **The buffer first.** The predecessor's owner caught this himself: *"if I say forget
 * something and in the buffer there is the same thing… that gets remembered in 12 minutes,
 * it kinda loses the point."* Today's `forget_one` was correct only because there was no
 * buffer; adding one without adding this **is** the bug, so the two arrive together.
 *
 * Two layers rather than the predecessor's three: it kept a permanent raw log behind the
 * buffer, and this does not — a second copy of everything anybody ever said, forever, is a
 * privacy cost paid for a feature nobody asked for. What is here is the buffer and the notes.
 *
 * **A tombstone every time, matched or not.** A forget that found nothing is still recorded,
 * so nobody later has to wonder whether it silently did nothing. Losing memory quietly is
 * the one unrecoverable failure this kind of system has.
 */
async function forgetting(about, going) {
  const asked = String(about ?? '').trim()
  // **Every version, not just the one pointed at.** Forgetting *where he lives* while *where
  // he lived before* sits one `history` call away is not forgetting. `chain` walks both ways
  // along `replaced_by`, so pointing at the oldest version takes the newest too.
  const all = going ? await notes() : []
  const versions = going ? chain(all, going.rowid) : []
  const closing = going && versions.length === 0 ? [going] : versions

  // The buffer first, so nothing comes back on the next tick. Word overlap rather than an
  // exact match, because what is buffered is the exchange and what is forgotten is a fact
  // somewhere inside it. Matched against every version's words too: an exchange about where
  // he *used* to live would otherwise write the forgotten old version straight back.
  const waiting = await alexia.storage.select('buffer', { limit: 2000 })
  const looks = [asked === '' ? String(going?.text ?? '') : asked, ...closing.map((row) => String(row.text ?? ''))]
  const doomed = [...new Set(looks.flatMap((words) => rank(waiting, words)))]
  for (const row of doomed) await alexia.storage.delete('buffer', { rowid: Number(row.rowid) })

  let removed = 0
  if (going) {
    for (const row of closing) await alexia.storage.delete('facts', { rowid: Number(row.rowid) })
    removed = closing.length
    // A day's line may say what was just forgotten. It goes too; the day is blank, not wrong.
    await dropDays(closing)
    // A link pointing at something that is gone is a link that reads as a missing note.
    // Cheaper to mend now than to explain later. Only names nothing left is called by.
    const ids = new Set(closing.map((row) => Number(row.rowid)))
    const left = all.filter((row) => !ids.has(Number(row.rowid)))
    const names = new Set(closing.map(nameOf).filter((name) => !left.some((row) => nameOf(row) === name)))
    for (const row of left) {
      const links = linksOf(row)
      if (!links.some((l) => names.has(l))) continue
      await alexia.storage.update('facts', { links: JSON.stringify(links.filter((l) => !names.has(l))) }, { rowid: Number(row.rowid) })
    }
    // The tree forgets too: every summary above what went is blanked now and rewritten from
    // what is left next run, and a bubble left with nothing in it goes (`bare` in tree.js) —
    // a branch called *Niki* after *forget Niki* is the thing forgotten, one screen away.
    // Nothing else points at a note by id (`also` holds branches), so there is nothing to mend.
    await unsettle(closing, { blank: true })
    await mend([...ids]).catch(() => log.info('could not tidy the life graph'))
    for (const id of bare(await tree(), left)) await alexia.storage.delete('branches', { rowid: id })
  }

  await alexia.storage.insert('forgotten', {
    about: asked === '' ? String(going?.text ?? '') : asked,
    matched: removed,
    buffered: doomed.length,
    at: Date.now(),
  })
  await report()
  return { removed, buffered: doomed.length }
}

const kept = alexia.tool(
  'remember',
  {
    description:
      'Write something down so it survives this conversation. Use for anything the user says ' +
      'about themselves, their preferences, their people or their work that would be useful ' +
      'weeks from now — not for what is already in this conversation, which is not forgotten ' +
      'yet. One fact per call, phrased so it still makes sense on its own in a year.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The thing to remember, as a complete sentence. "Vaclav’s deadline for the grant is in March" — not "March".',
        },
        kind: { type: 'string', enum: KINDS, description: 'Roughly what sort of thing it is.' },
        pin: {
          type: 'boolean',
          description:
            'Put this in what Alexia always knows about you — name, language, how to talk to you. ' +
            'Keep it rare: everything pinned is read before every task.',
        },
        replaces: {
          type: 'string',
          description:
            'The id of a remembered thing this makes out of date — a new name, a new city, a changed ' +
            'preference. The old one is kept as history and stops being used. Ids are in `remembered`.',
        },
        time_bound: {
          type: 'boolean',
          description:
            'True when this describes a current state that will stop being true — a year of study, a ' +
            'job, where they live now. Alexia will check it again in half a year.',
        },
        doc: {
          type: 'string',
          description: 'The title of the document this comes from, when it comes from one the user shared.',
        },
      },
      required: ['text'],
    }),
    // It writes, so it is not read-only. It is not *destructive* either — nothing is
    // overwritten and nothing is lost, a replaced note included — and saying so is what keeps
    // the default mode from treating remembering a preference like deleting a file.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text, kind, pin, replaces, time_bound: bound, ...rest }, ctx) => {
    const said = String(text ?? '').trim()
    if (said === '') return { isError: true, content: [{ type: 'text', text: 'There was nothing to remember.' }] }
    const now = Date.now()
    /**
     * What this replaces, checked before anything is written. A person said it, so unlike the
     * sorting pass it may replace a pinned note — changing your own name is exactly that — and
     * the new note takes the pin over. The id must be a note that exists and is still true.
     */
    let old
    if (replaces !== undefined && String(replaces).trim() !== '') {
      const rowid = Number(replaces)
      ;[old] = Number.isInteger(rowid) ? await alexia.storage.select('facts', { where: { rowid }, limit: 1 }) : []
      if (!old) return { isError: true, content: [{ type: 'text', text: `There is no remembered thing with id ${String(replaces)}.` }] }
      if (!valid(old)) {
        return { isError: true, content: [{ type: 'text', text: `That one is already no longer true: ${String(old.text)}` }] }
      }
    }
    const pinning = pin === true || (old !== undefined && pinnedOf(old))
    // Said before, near enough. Remembering the same sentence four times is how recall
    // fills up with one fact and returns nothing else. Only a *valid* copy counts: a sentence
    // that was true, stopped, and is true again is worth writing again.
    const already = (await alexia.storage.select('facts', { where: { text: said }, limit: 20 })).find(valid)
    if (already) {
      if (old !== undefined && Number(old.rowid) !== Number(already.rowid)) await supersede(old, Number(already.rowid), now)
      // Asked to pin something already held is still a pin — and saying it out loud makes it
      // stated, whatever it was before.
      if (pinning && !pinnedOf(already)) {
        await alexia.storage.update('facts', { pinned: true, source: STATED }, { rowid: Number(already.rowid) })
        await report()
        return { content: [{ type: 'text', text: `Already remembered, and now always known: ${said}` }] }
      }
      await report()
      return { content: [{ type: 'text', text: old ? `Already remembered, and it replaces: ${String(old.text)}` : 'Already remembered, so nothing changed.' }] }
    }
    const rowid = await alexia.storage.insert('facts', {
      // Its own name, so something else can link to it. A whole sentence is a poor name and
      // a truncated one is worse, so this is the first clause and it is enough. A replacement
      // keeps the old name, so whatever linked to the old version finds the new one.
      name: old ? nameOf(old) : said.split(/[,.;:]/)[0].slice(0, 60).trim() || said.slice(0, 60),
      text: said,
      kind: KINDS.includes(kind) ? kind : old ? String(old.kind ?? 'other') : 'other',
      links: old ? JSON.stringify(linksOf(old)) : '[]',
      // Somebody said this out loud. That is a different kind of true from something worked
      // out on a timer, and recall says which one it is reading back.
      source: STATED,
      // Which channel and turn, or which document, it was said in — only what the host told us.
      ...originFields(originFrom(rest, ctx)),
      // Only when asked. A key left off is a column left null, which reads as not pinned.
      ...(pinning ? { pinned: true } : {}),
      ...lockedLike(old),
      ...(bound === true ? { time_bound: true, review_at: now + REVIEW_AFTER } : {}),
      ...filedLike(old),
      at: now,
      valid_from: now,
    })
    if (old) await supersede(old, rowid, now)
    else soon()
    await vectorise([{ rowid, text: said }])
    await report()
    const how = pinning ? 'Remembered, and always known' : 'Remembered'
    return { content: [{ type: 'text', text: `${how}: ${said}${old ? `\nIt replaces, kept as history: ${String(old.text)}` : ''}` }] }
  },
)

const found = alexia.tool(
  'recall',
  {
    description:
      'Search what was remembered from earlier conversations and bring back what fits. Use at ' +
      'the start of a task when the user refers to something that is not in this conversation ' +
      '— a name, a preference, a decision, "the usual". Hits come grouped under the branch of the ' +
      'memory tree they are filed in, with its summary; `browse` opens a branch. Returns nothing when nothing matches, ' +
      'which means it was never written down rather than that it does not exist.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        about: { type: 'string', description: 'What to look for. Words from the question are enough.' },
        unlocked: {
          type: 'boolean',
          description: 'Set by Alexia itself, never by the model: true only in the owner’s own chat, where locked notes may be read. Default false.',
        },
      },
      required: ['about'],
    }),
    // Reading what is already stored changes nothing, which is what lets the default mode
    // run it without asking — and recall that stopped to ask permission every time would
    // be recall nobody left switched on.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ about, unlocked }) => {
    const { recall_limit: limit } = await settings()
    // The whole table, ranked here. It is hundreds of short rows; the day it is not, the
    // ceiling named in search.js is the thing to raise.
    // Only what is still true. A replaced version is history, and history is `history`.
    // A locked note is not in the table as far as this call can tell: left out, not hinted at.
    const rows = visible(await current(), unlocked === true)
    const asked = String(about ?? '')
    // By meaning when something can embed the question, blended with the words (search.js);
    // otherwise exactly v2's ranking. A fact with no vector yet still competes on its words.
    const made = asked.trim() === '' ? null : await embedding([asked])
    const hits = (made === null ? rank(rows, asked) : rankByMeaning(rows, asked, made.vectors[0])).slice(0, Number(limit) || 6)
    if (hits.length === 0) {
      return { content: [{ type: 'text', text: `Nothing was written down about that.` }] }
    }
    /**
     * One hop along the links, and it is what a vault buys over a longer list.
     *
     * A note names what it belongs under, so finding *the grant deadline* brings back the
     * project it is part of without either sentence having to contain the other's words —
     * which is what keyword ranking alone cannot do. One hop and no further: two would reach
     * most of the table and be a longer list again with extra steps.
     */
    const shown = new Set(hits.map(nameOf))
    const linked = []
    for (const hit of hits) {
      for (const name of linksOf(hit)) {
        if (shown.has(name)) continue
        const found = rows.find((row) => nameOf(row) === name)
        if (!found) continue
        shown.add(name)
        linked.push(found)
      }
    }
    // *Worked out rather than said* travels with the sentence. A model reading its own
    // guess back as fact is the failure automatic capture makes possible. *May be out of
    // date* travels the same way: the gardener could not confirm it, and a model that knows
    // that can ask rather than assert.
    const line = (row, why) => factLine(row, why)
    /**
     * Shown by where they live. The ranking above is untouched — MemTree found that searching
     * every note at once finds more than walking down the tree — and the tree only says where
     * each hit sits: `You/People/Niki — her summary`, then the notes. A reader gets the
     * neighbourhood for free, and can `browse` there if the neighbourhood is what it wanted.
     */
    const why = new Map([...hits.map((row) => [row, '']), ...linked.map((row) => [row, ', linked'])])
    const text = group(await tree(), [...why.keys()])
      .map((one) => [header(one.path, one.summary), ...one.rows.map((row) => line(row, why.get(row)))].join('\n'))
      .join('\n\n')
    return { content: [{ type: 'text', text }] }
  },
)

alexia.tool(
  'forget',
  {
    description:
      'Forget one remembered thing, by the words in it, with every earlier version of it. Use ' +
      'when the user says something was never true, or asks to be forgotten about something. ' +
      'For something that was true and has changed, use `remember` with `replaces`, or ' +
      '`no_longer_true` — those keep the history.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { about: { type: 'string', description: 'Words from the thing to forget.' } },
      required: ['about'],
    }),
    // This one really does remove something a person cannot get back, so it says so and
    // the gate asks in every mode but Full trust.
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ about }) => {
    // What is true first, then what used to be: *forget where I lived* may well mean an old
    // version, and forgetting takes the whole chain either way.
    const all = await notes()
    const hits = [...rank(all.filter(valid), String(about ?? '')), ...rank(all.filter((row) => !valid(row)), String(about ?? ''))]
    // Nothing matched, and it is still written down as having been asked — see `forgetting`.
    // The buffer is cleared either way, because the thing to forget may only be in there yet.
    if (hits.length === 0) {
      const { buffered } = await forgetting(about, undefined)
      return {
        content: [
          {
            type: 'text',
            text:
              buffered === 0 ?
                'Nothing remembered matches that. Written down as asked, so it stays asked.'
              : `Nothing written down matches that, but ${buffered} thing${buffered === 1 ? ' that was' : 's that were'} waiting to be sorted went with it.`,
          },
        ],
      }
    }
    // Only the best match. Deleting everything that vaguely matched is how a request to
    // forget one wrong fact quietly takes six right ones with it.
    const going = hits[0]
    await forgetting(about, going)
    return { content: [{ type: 'text', text: `Forgotten: ${String(going.text)}` }] }
  },
)

alexia.tool(
  'remembered',
  {
    description: 'List what is remembered from earlier conversations, newest first. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const rows = (await current()).slice(0, 50)
    const text =
      rows.length === 0 ?
        'Nothing has been remembered yet. Things get written down when you say something worth keeping.'
      : rows
          .map(
            (row) =>
              factLine(row, `${pinnedOf(row) ? ', always known' : ''}; id ${String(row.rowid)}`),
          )
          .join('\n')
    return { content: [{ type: 'text', text }] }
  },
)

/**
 * The panel (M6-7): what is remembered, and a way to forget one of them.
 *
 * **Forgetting one thing is the entire reason a person opens this screen.** `forget` already
 * existed and takes *words from the thing to forget*, which is right for a conversation and
 * wrong for a list: on a screen the person is pointing at a row, and the row knows exactly
 * which one it is. So this takes the row and nothing else, and there is no best-match guess
 * standing between what somebody pointed at and what goes.
 */
alexia.tool(
  'memories',
  {
    description: 'List everything remembered, newest first, with what each one is and when it was written down. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const all = await notes()
    const byId = new Map(all.map((row) => [Number(row.rowid), row]))
    /**
     * What is true first, then what used to be — the table has no way to hide rows by default,
     * so the closed ones come last and say so, in a tag a chip can narrow to and in a sentence
     * under the row. Kept on screen rather than left out, because *what did it used to think* is
     * a fair thing to open this screen to check, and forgetting one is still the reason it exists.
     */
    const rows = [...all.filter(valid), ...all.filter((row) => !valid(row))]
    return {
      content: [{ type: 'text', text: `${all.filter(valid).length} remembered` }],
      structuredContent: {
        rows: rows.map((row) => ({
          // The rowid, which is what makes forgetting one of them unambiguous.
          id: String(row.rowid),
          text: String(row.text),
          kind: String(row.kind ?? 'other'),
          // The column automatic capture makes necessary: *you said this* and *it worked
          // this out* are different kinds of true, and the second is the one worth checking.
          from: sourceOf(row),
          when: day(row.at),
          // In what Alexia reads before every task. `suggested` is the sorting pass saying
          // *this one might belong there*, which only a person can act on.
          pinned: pinnedOf(row) ? 'always known' : valid(row) && row.suggest_pin ? 'suggested' : '',
          tags: tagsOf(row),
          ...(standing(row, byId) === '' ? {} : { note: standing(row, byId) }),
        })),
      },
    }
  },
)

/**
 * Where a note stands, as the panel's tags. The words are what the chips in plugin.json match,
 * so they are written once, here.
 */
const GONE = 'no longer true'
const DOUBT = 'may be out of date'
const SUGGESTED = 'suggestion'
const LOCKED = '🔒 locked'
const tagsOf = (row) =>
  !valid(row) ? [{ says: GONE, tone: 'quiet' }]
  : [
      ...(lockedOf(row) ? [{ says: LOCKED, tone: 'quiet' }] : []),
      ...(stale(row) ? [{ says: DOUBT, tone: 'caution' }] : []),
      ...(when(row.suggest_replaces) !== null || row.suggest_pin ? [{ says: SUGGESTED, tone: 'quiet' }] : []),
    ]

/** Where a note stands, as the sentence under its row — or '' when there is nothing to say. */
function standing(row, byId) {
  if (!valid(row)) {
    const next = byId.get(when(row.replaced_by))
    return `No longer true since ${day(row.invalid_at)}${next ? `; replaced by: ${String(next.text)}` : ''}.`
  }
  const said = []
  const old = byId.get(when(row.suggest_replaces))
  if (old && valid(old)) said.push(`Alexia thinks this replaces “${String(old.text)}”. Accept the suggestion to make it so.`)
  if (stale(row)) said.push(`Checked ${day(row.stale_since)}: this may have changed since it was written. Still true?`)
  return said.join(' ')
}

/**
 * The same notes, as a map (M6-11).
 *
 * **This is what the links were for.** `recall` follows them one hop and the table shows what
 * each note is filed under; neither answers *what shape is any of this in* — which is the
 * question somebody has when they open a memory screen and start scrolling. The nodes are the
 * notes, the edges are the links the sorter wrote, and the ring is the notes nobody said out
 * loud.
 *
 * Ids rather than names on the wire: a name is what a link is written as, and the panel needs
 * something it can hand back to `about_memory`. A link to a name with no note behind it is
 * dropped rather than drawn — `forgetting` mends both ends of a link, so one that is still
 * dangling is a note that never arrived.
 */
alexia.tool(
  'memory_graph',
  {
    description:
      'Everything remembered as a map: each note, and what it is filed under. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    // The shape of what is true now. An old version sharing a name with its replacement would
    // otherwise draw the replacement's links to a note that no longer holds.
    const rows = await current()
    const ids = new Map(rows.map((row) => [nameOf(row), String(row.rowid)]))
    return {
      content: [{ type: 'text', text: `${rows.length} remembered` }],
      structuredContent: {
        rows: rows.map((row) => ({
          id: String(row.rowid),
          label: nameOf(row),
          links: linksOf(row)
            .map((name) => ids.get(name))
            .filter((id) => id !== undefined && id !== String(row.rowid)),
          // Worked out rather than said, which is the one a person might want to argue with.
          mark: row.source === INFERRED,
        })),
      },
    }
  },
)

/**
 * Walking down the tree, one level at a time — the ladder MemTree says is *worse* than a search
 * for finding one thing, and better for the other question a model has: *what is in this area*.
 * Which language to write code in lives somewhere under *Projects & code*, and no single word of
 * the task would find it; opening the branch does.
 */
alexia.tool(
  'browse',
  {
    description:
      'Look through what is remembered by area, like folders. With no path: the main sections, ' +
      'each with how many notes it holds and a one-line summary. With a path such as ' +
      '"You/Projects & code": that branch\'s sub-branches and the notes filed there. Use it to ' +
      'narrow down before `recall` when you want everything about one area — e.g. open ' +
      '"Projects & code" before writing code, to see which language and tools the user prefers.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The branch to open, e.g. "You/People" or "People/Niki". Leave out for the top.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ path }) => {
    await plant()
    const t = await tree()
    const line = (row) => factLine(row, `; id ${String(row.rowid)}`)
    const live = await current()
    const text = browsing(t, live, path, line)
    if (text !== null) return { content: [{ type: 'text', text }] }
    return refused(`There is no branch ${String(path)}. The sections are:\n${browsing(t, live, undefined, () => '') ?? ''}`)
  },
)

/**
 * The tree, for the panel: every branch and every note as one flat list of nodes with parents,
 * which a screen can draw as a tree, a map or an outline without asking twice.
 *
 * **The shape is a contract** the panel is built against: `{ nodes: [{ id, parent, kind, label,
 * summary?, count?, tags?, also? }] }`, branch ids `b<rowid>`, note ids the plain rowid (so
 * `about_memory` and the row actions work on them unchanged). Notes that are no longer true
 * are included under the branch they were filed in, tagged so; the ones closed before the tree
 * existed were never filed anywhere and are left out rather than piled on the root.
 */
alexia.tool(
  'memory_tree',
  {
    description: 'Everything remembered as a tree: the branches, and the notes filed under each. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    await plant()
    const t = await tree()
    const all = await notes()
    const shown = [...all.filter(valid), ...all.filter((row) => !valid(row) && when(row.branch) !== null && t.nodes.has(when(row.branch)))]
    const tags = (row) => [
      ...tagsOf(row).map((tag) => tag.says),
      ...(valid(row) && pinnedOf(row) ? ['always known'] : []),
      ...(row.source === INFERRED ? ['worked out'] : []),
    ]
    const nodes = treeNodes(t, shown, tags)
    return {
      content: [{ type: 'text', text: `${t.nodes.size} branches, ${all.filter(valid).length} remembered` }],
      structuredContent: { nodes },
    }
  },
)

/** `b12` or `12` for a branch; the plain rowid for a note. */
const branchId = (id) => {
  const n = Number(String(id ?? '').trim().replace(/^b/i, ''))
  return Number.isInteger(n) ? n : null
}

/** Where a person asked to put something: an existing branch, or one new one made for it. */
async function destined(t, path) {
  const where = destination(t, path)
  if (where.error !== undefined) return where
  if (where.create === undefined) return { branch: where.branch, made: false }
  return { branch: await sprout(where.branch, where.create), made: true }
}

alexia.tool(
  'move',
  {
    description:
      'Move one remembered thing, or a whole branch, under another branch. Takes the id (a note\'s ' +
      'row id, or a branch id like "b12") and the path to move it under, e.g. "You/People/Niki". ' +
      'The last name in the path may be new, and is then made.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A note\'s id, or a branch id starting with b.' },
        path: { type: 'string', description: 'Where to put it, from the root.' },
      },
      required: ['id', 'path'],
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, path }) => {
    await plant()
    const t = await tree()
    if (/^b/i.test(String(id ?? '').trim())) {
      const moving = branchId(id)
      const node = t.nodes.get(moving)
      if (!node) return refused('There is no such branch.')
      if (moving === t.root) return refused('The root cannot be moved.')
      const where = destination(t, path)
      if (where.error !== undefined) return refused(where.error)
      // Into itself or anything under it would make a loop, and a loop is a tree nobody can read.
      if (where.branch === moving || below(t, moving).includes(where.branch)) return refused('A branch cannot go inside itself.')
      const depth = depthOf(t, where.branch) + (where.create === undefined ? 1 : 2) + height(t, moving)
      if (depth > DEPTH) return refused(`That would put part of it deeper than ${DEPTH} levels.`)
      if (where.create === undefined && childNamed(t, where.branch, node.name) !== undefined) {
        return refused(`There is already a ${node.name} there. Merge the two instead.`)
      }
      const from = node.parent
      const under = where.create === undefined ? where.branch : await sprout(where.branch, where.create)
      await alexia.storage.update('branches', { parent: under, updated_at: Date.now() }, { rowid: moving })
      await behind([...touched(t, [from, where.branch]), under])
      return answered(`Moved ${node.name} under ${pathOf(await tree(), under)}.`)
    }
    const { one, error } = await lookup(id)
    if (error) return refused(error)
    const where = await destined(t, path)
    if (where.error !== undefined) return refused(where.error)
    const also = alsoOf(one).filter((other) => other !== where.branch)
    await alexia.storage.update('facts', { branch: where.branch, also: JSON.stringify(also) }, { rowid: Number(one.rowid) })
    await unsettle([one])
    await behind([...touched(await tree(), [where.branch])])
    return answered(`Moved under ${pathOf(await tree(), where.branch)}: ${String(one.text)}`)
  },
)

alexia.tool(
  'rename_branch',
  {
    description: 'Rename one branch of the memory tree. Takes the branch id (like "b12") and the new name, at most four words.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'The branch id.' }, name: { type: 'string', description: 'The new name.' } },
      required: ['id', 'name'],
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, name }) => {
    const t = await tree()
    const node = t.nodes.get(branchId(id))
    if (!node) return refused('There is no such branch.')
    const called = String(name ?? '').replace(/\s+/g, ' ').trim()
    if (!nameOk(called)) return refused('A branch name is at most four words and forty characters, with no slash.')
    const clash = node.parent === null ? undefined : childNamed(t, node.parent, called)
    if (clash !== undefined && clash !== node.id) return refused(`There is already a ${called} there. Merge the two instead.`)
    await alexia.storage.update('branches', { name: called, updated_at: Date.now() }, { rowid: node.id })
    if (node.parent !== null) await behind([...touched(t, [node.parent])])
    return answered(`Renamed ${node.name} to ${called}.`)
  },
)

alexia.tool(
  'merge_branch',
  {
    description:
      'Fold one branch of the memory tree into another: its notes and sub-branches move over and ' +
      'it goes. Takes the two branch ids, `from` and `into`.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The branch that goes, like "b12".' },
        into: { type: 'string', description: 'The branch that takes what was in it.' },
      },
      required: ['from', 'into'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ from, into }) => {
    const t = await tree()
    const going = t.nodes.get(branchId(from))
    const staying = t.nodes.get(branchId(into))
    if (!going || !staying) return refused('There is no such branch.')
    if (going.id === t.root) return refused('The root cannot be merged away.')
    if (going.id === staying.id || below(t, going.id).includes(staying.id)) return refused('A branch cannot be merged into itself.')
    const kids = t.children.get(going.id) ?? []
    for (const kid of kids) {
      const name = t.nodes.get(kid).name
      if (childNamed(t, staying.id, name) !== undefined) return refused(`Both have a ${name}. Merge those two first.`)
      if (depthOf(t, staying.id) + 1 + height(t, kid) > DEPTH) return refused(`That would put ${name} deeper than ${DEPTH} levels.`)
    }
    for (const kid of kids) await alexia.storage.update('branches', { parent: staying.id, updated_at: Date.now() }, { rowid: kid })
    // Every note filed in it, as home or as a link, now points at the one that stays — so no
    // `also` is left naming a branch that is gone.
    for (const row of await notes()) {
      const home = when(row.branch) === going.id ? staying.id : when(row.branch)
      const had = alsoOf(row)
      if (home === when(row.branch) && !had.includes(going.id)) continue
      const also = [...new Set(had.map((other) => (other === going.id ? staying.id : other)))].filter((other) => other !== home)
      await alexia.storage.update('facts', { ...(home === null ? {} : { branch: home }), also: JSON.stringify(also) }, { rowid: Number(row.rowid) })
    }
    await alexia.storage.delete('branches', { rowid: going.id })
    await behind([...touched(t, [staying.id, going.parent])].filter((id) => id !== going.id))
    return answered(`Merged ${going.name} into ${staying.name}.`)
  },
)

alexia.tool(
  'forget_one',
  {
    description: 'Forget exactly one remembered thing, by the row it is. Takes that row’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which row.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const rowid = Number(id)
    if (!Number.isInteger(rowid)) return { isError: true, content: [{ type: 'text', text: 'That is not a row.' }] }
    const [going] = await alexia.storage.select('facts', { where: { rowid }, limit: 1 })
    if (!going) return { isError: true, content: [{ type: 'text', text: 'That one is already gone.' }] }
    // The same cascade as the conversational one. A row deleted from the screen while the
    // same thing sat in the buffer would come back on the next tick, which is the whole bug.
    await forgetting(String(going.text), going)
    return { content: [{ type: 'text', text: `Forgotten: ${String(going.text)}` }] }
  },
)

alexia.tool(
  'about_memory',
  {
    description: 'Say everything about one remembered thing. Takes that row’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which row.' } },
      required: ['id'],
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const all = await notes()
    const row = all.find((one) => Number(one.rowid) === Number(id))
    if (!row) return { isError: true, content: [{ type: 'text', text: 'That one is already gone.' }] }
    // The sentence as it was written down, uncut. A column has to truncate; this does not,
    // and the whole of a remembered thing is the thing worth reading before deleting it.
    const links = linksOf(row)
    const byId = new Map(all.map((one) => [Number(one.rowid), one]))
    const versions = chain(all, row.rowid)
    const t = await tree()
    const filed = when(row.branch) === null || t.root === null ? [] : homesOf(t, row).map((id) => pathOf(t, id))
    return {
      content: [
        {
          type: 'text',
          text: [
            String(row.text),
            '',
            `Written down ${day(row.at)}, as ${String(row.kind ?? 'other')}.`,
            row.source === INFERRED ?
              'Alexia worked this out from something you said rather than being told it.'
            : 'You said this.',
            `Where it came from: ${sourceOf(row)}.`,
            ...(pinnedOf(row) ? ['Alexia always knows this: it is read before every task.']
            : valid(row) && row.suggest_pin ? ['Alexia thinks this might belong in what it always knows. Pin it if it does.']
            : []),
            ...(standing(row, byId) === '' ? [] : [standing(row, byId)]),
            ...(valid(row) && timeBound(row) && when(row.review_at) !== null ?
              [`It describes something that changes, so Alexia will check it again after ${day(row.review_at)}.`]
            : []),
            // What it hangs off, by name. The reason a person can tell a note that belongs
            // somewhere from one that is floating on its own.
            ...(links.length === 0 ? [] : [`Filed under: ${links.join(', ')}.`]),
            // Where it lives in the tree, and where else it is linked from.
            ...(filed.length === 0 ? [] : [`In the tree at ${filed[0]}${filed.length > 1 ? `, and also under ${filed.slice(1).join(', ')}` : ''}.`]),
            // Every version, oldest first, when there is more than this one.
            ...(versions.length > 1 ? ['', 'Its history:', ...versions.map(version)] : []),
          ].join('\n'),
        },
      ],
    }
  },
)

/**
 * Pinning one note, and unpinning it — by the row, like `forget_one`, because on a screen the
 * person is pointing at a row, and in a conversation `remembered` has just listed them with ids.
 *
 * A person may pin a note Alexia worked out rather than being told. That is them vouching for
 * it, and it is the only way an inferred note reaches the profile — where it still sorts after
 * every stated one (`profile.js`). The sorting pass itself never pins; see capture.js.
 */
async function pinning(id, on) {
  const rowid = Number(id)
  if (!Number.isInteger(rowid)) return { isError: true, content: [{ type: 'text', text: 'That is not a row.' }] }
  const [row] = await alexia.storage.select('facts', { where: { rowid }, limit: 1 })
  if (!row) return { isError: true, content: [{ type: 'text', text: 'That one is already gone.' }] }
  // A pin on a closed note would never reach the profile, which only reads what is true.
  if (on && !valid(row)) return { isError: true, content: [{ type: 'text', text: `That one is no longer true: ${String(row.text)}` }] }
  if (pinnedOf(row) === on) {
    return { content: [{ type: 'text', text: `${on ? 'Already always known' : 'Was not pinned'}, so nothing changed.` }] }
  }
  await alexia.storage.update('facts', { pinned: on }, { rowid })
  return {
    content: [{ type: 'text', text: `${on ? 'Always known now' : 'No longer always known, still remembered'}: ${String(row.text)}` }],
  }
}

const byRow = fromJsonSchema({
  type: 'object',
  properties: { id: { type: 'string', description: 'Which row.' } },
  required: ['id'],
})

alexia.tool(
  'pin',
  {
    description:
      'Put one remembered thing in what Alexia always knows about the user, which is read before ' +
      'every task. For who they are and how they want to be spoken to, and only when they ask. ' +
      'Takes that row’s id.',
    inputSchema: byRow,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => pinning(id, true),
)

alexia.tool(
  'unpin',
  {
    description:
      'Take one remembered thing out of what Alexia always knows. It stays remembered and can ' +
      'still be recalled. Takes that row’s id.',
    inputSchema: byRow,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => pinning(id, false),
)

/**
 * Truth over time, by hand: a person answering what the gardener could only ask.
 *
 * All by the row, like pinning. None of them deletes anything — a note that stops being true
 * is closed and kept (`garden.js`), and `forget_one` is still the way to make it gone.
 */
async function lookup(id) {
  const rowid = Number(id)
  if (!Number.isInteger(rowid)) return { error: 'That is not a row.' }
  const all = await notes()
  const one = all.find((note) => Number(note.rowid) === rowid)
  return one ? { one, all } : { error: 'That one is already gone.' }
}
const refused = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const answered = async (text) => {
  await report()
  return { content: [{ type: 'text', text }] }
}

/** One version, as `history` and `about_memory` list it. */
const version = (note) =>
  valid(note) ?
    `- since ${day(when(note.valid_from) ?? note.at)}: ${String(note.text)} (id ${String(note.rowid)}, still true)`
  : `- ${day(when(note.valid_from) ?? note.at)} to ${day(note.invalid_at)}: ${String(note.text)} (id ${String(note.rowid)})`

alexia.tool(
  'still_true',
  {
    description:
      'Confirm that one remembered thing marked "may be out of date" is still true. Something that ' +
      'changes over time is checked again in half a year. Takes that row’s id.',
    inputSchema: byRow,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const { one, error } = await lookup(id)
    if (error) return refused(error)
    if (!valid(one)) return refused(`That one is already no longer true: ${String(one.text)}`)
    await alexia.storage.update(
      'facts',
      // The mark goes, and the clock starts again for something that will change again.
      { ...cleared(one, ['stale_since', 'review_at']), ...(timeBound(one) ? { review_at: Date.now() + REVIEW_AFTER } : {}) },
      { rowid: Number(one.rowid) },
    )
    return answered(`Still true: ${String(one.text)}`)
  },
)

alexia.tool(
  'no_longer_true',
  {
    description:
      'Mark one remembered thing as no longer true. It is kept as history and stops being used, ' +
      'and it leaves what Alexia always knows. Use `remember` with `replaces` instead when there ' +
      'is something new to say in its place. Takes that row’s id.',
    inputSchema: byRow,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const { one, error } = await lookup(id)
    if (error) return refused(error)
    if (!valid(one)) return answered(`Already no longer true, so nothing changed: ${String(one.text)}`)
    await alexia.storage.update(
      'facts',
      { invalid_at: Date.now(), ...(pinnedOf(one) ? { pinned: false } : {}), ...cleared(one, ['stale_since', 'review_at']) },
      { rowid: Number(one.rowid) },
    )
    await unsettle([one])
    return answered(`No longer true, kept as history: ${String(one.text)}`)
  },
)

alexia.tool(
  'history',
  {
    description: 'Every version of one remembered thing, oldest first, with the dates each was true. Takes that row’s id.',
    inputSchema: byRow,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const { one, all, error } = await lookup(id)
    if (error) return refused(error)
    const versions = chain(all, one.rowid)
    return {
      content: [
        {
          type: 'text',
          text: versions.length <= 1 ? `Only ever this: ${version(one).slice(2)}` : versions.map(version).join('\n'),
        },
      ],
    }
  },
)

/**
 * What the sorting pass or the gardener only suggested, done as if a person had done it —
 * because a person just did. A suggested replacement closes the old note and hands its pin
 * and its links over; a suggested pin pins.
 */
alexia.tool(
  'accept_suggestion',
  {
    description:
      'Do what Alexia suggested about one remembered thing: replace the note it said this one ' +
      'replaces, and pin it if it suggested pinning. Takes that row’s id.',
    inputSchema: byRow,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const { one, all, error } = await lookup(id)
    if (error) return refused(error)
    if (!valid(one)) return refused(`That one is no longer true itself: ${String(one.text)}`)
    const old = all.find((note) => Number(note.rowid) === when(one.suggest_replaces))
    const replacing = old !== undefined && valid(old) && Number(old.rowid) !== Number(one.rowid)
    if (!replacing && !one.suggest_pin) {
      // A suggestion whose old note has since gone is cleared, so the tag stops asking.
      if (when(one.suggest_replaces) !== null) await alexia.storage.update('facts', cleared(one, ['suggest_replaces']), { rowid: Number(one.rowid) })
      return answered('Nothing is suggested about this one, so nothing changed.')
    }
    const now = Date.now()
    const links = replacing ? [...new Set([...linksOf(one), ...linksOf(old)])] : linksOf(one)
    await alexia.storage.update(
      'facts',
      {
        ...cleared(one, ['suggest_replaces', 'suggest_pin']),
        ...((replacing && pinnedOf(old)) || one.suggest_pin ? { pinned: true } : {}),
        links: JSON.stringify(links),
      },
      { rowid: Number(one.rowid) },
    )
    if (replacing) await supersede(old, Number(one.rowid), now)
    return answered(
      [
        ...(replacing ? [`Replaced, kept as history: ${String(old.text)}`] : []),
        ...(one.suggest_pin || (replacing && pinnedOf(old)) ? [`Always known now: ${String(one.text)}`] : []),
      ].join('\n'),
    )
  },
)

/**
 * What core reads once per task and puts in the system prompt (`memory.profile`).
 *
 * Text and nothing else, and an empty string when nothing is pinned — core reads that as
 * *nothing to add*, which is the right answer for somebody who has pinned nothing.
 */
const known = alexia.tool(
  'profile',
  {
    description:
      'What Alexia always knows about the user: the pinned notes, one per line, short. Called by ' +
      'Alexia itself before each task. Takes `unlocked` (default false): locked notes are left out unless it is true.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { unlocked: { type: 'boolean', description: 'True only in the owner’s own chat. Default false.' } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ unlocked } = {}) => ({ content: [{ type: 'text', text: profile(visible(await current(), unlocked === true)) }] }),
)

/**
 * The first profile, for somebody who had notes before pinning existed.
 *
 * Once, ever, and written down as having run — so unpinning everything it chose does not bring
 * it all back on the next start. It pins nothing when something is already pinned: that is a
 * person who has started choosing, and a seed on top of their choices is a second opinion
 * nobody asked for. What it picks is `seedable`, in `profile.js`, where it is tested.
 */
async function seed() {
  // An object once it has run; missing (or null, depending on the wire) before.
  if (await alexia.storage.get(SEEDED)) return
  const rows = await current()
  const chosen = rows.some(pinnedOf) ? [] : distinct(rows.filter(seedable))
  for (const row of chosen) await alexia.storage.update('facts', { pinned: true }, { rowid: Number(row.rowid) })
  await alexia.storage.set(SEEDED, { at: Date.now(), pinned: chosen.length })
  if (chosen.length > 0) log.info(`pinned ${chosen.length} existing note(s) for the profile`)
}

/**
 * Locking (P3-15, ME-13): a locked fact is recalled in the owner's own chats and nowhere else.
 * It stays what it is — pinned, filed, linked — and only stops being offered: `recall` and
 * `profile` leave it out unless core says `unlocked` (P3-16), `notice_items` never reads it, and
 * the branch summaries are written without it, so no sentence of it survives in a header.
 */
const lockTool = (name, on) =>
  alexia.tool(
    name,
    {
      description: on
        ? 'Lock one remembered thing, by its id (`remembered` shows ids): it is then only recalled in the owner’s own chats and never reaches a message Alexia starts herself.'
        : 'Unlock one remembered thing, by its id: it can be recalled and mentioned like any other.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { id: { type: 'string', description: 'The id of the remembered thing.' } },
        required: ['id'],
      }),
      // It writes, and it takes nothing away.
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id } = {}) => {
      const rowid = Number(id)
      const [row] = Number.isInteger(rowid) ? await alexia.storage.select('facts', { where: { rowid }, limit: 1 }) : []
      if (!row) return refused(`There is no remembered thing with id ${String(id)}.`)
      if (lockedOf(row) !== on) {
        await alexia.storage.update('facts', { locked: on }, { rowid })
        // Summaries above it were written with it (or without it): written again, and blanked now
        // when it has just been locked, because a summary that says it is not locked at all.
        await unsettle([row], { blank: on })
        if (on) await dropDays([row])
      }
      await report()
      return answered(on ? `Locked: ${String(row.text)}` : `Unlocked: ${String(row.text)}`)
    },
  )
lockTool('lock', true)
lockTool('unlock', false)

alexia.tool(
  'forget_all',
  {
    description: 'Empty long-term memory. The current conversation is not affected. Takes no arguments.',
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async () => {
    const held = await alexia.storage.count('facts')
    const waiting = await alexia.storage.count('buffer')
    await alexia.storage.delete('facts', { all: true })
    // Everything means everything, buffer included. Emptying the notes and leaving an hour
    // of exchanges to be written up on the next tick is the same bug one row at a time.
    await alexia.storage.delete('buffer', { all: true })
    // The tree goes back to its seed: branch names and summaries are made of what was forgotten.
    await alexia.storage.delete('branches', { all: true })
    // The life graph is made of what was forgotten too: a person, a deadline, a goal.
    for (const table of ['people', 'dates', 'goals', 'days']) await alexia.storage.delete(table, { all: true })
    await alexia.storage.set(BEHIND, { ids: [] })
    await alexia.storage.remove(PLANTED)
    await plant()
    await alexia.storage.insert('forgotten', { about: 'everything', matched: held, buffered: waiting, at: Date.now() })
    await report()
    return {
      content: [
        {
          type: 'text',
          text: `Forgot ${held} thing${held === 1 ? '' : 's'}. The conversation you are having now is untouched — that belongs to Alexia, not to this plugin.`,
        },
      ],
    }
  },
)

/**
 * Noticing (M7-3). Core hands over what was just said; this writes it down and returns.
 *
 * **No model, no judgement, no cost.** The bar for writing is on the floor because a fact
 * never written cannot be recalled, while a trivial one that was costs almost nothing to
 * skip past at read time. The thinking happens on the tick, later, and only if there is
 * something to think about.
 */
const noticed = alexia.tool(
  'capture',
  {
    description:
      'Keep one finished exchange so it can be sorted through later. Called by Alexia itself, ' +
      'not by the model. Nothing is returned.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        said: { type: 'string', description: 'What the user said.' },
        answered: { type: 'string', description: 'What Alexia answered.' },
        at: { type: 'number', description: 'When, in milliseconds.' },
        channel: { type: 'string', description: 'Which channel it was said on, e.g. "telegram" or "window".' },
        session: { type: 'number', description: 'Which conversation it was part of.' },
      },
      required: ['said'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ said, answered, at, ...rest }, ctx) => {
    // The filter first, and no model in it: *ok*, *continue* and a dot are most of a day, and
    // the cheapest call is the one never queued. Cleaned before it is kept, too — a pasted
    // image or a code block is thousands of characters the sorting pass would read for nothing.
    const { skip } = await settings()
    const filler = [...DEFAULT_FILLER, ...String(skip ?? '').split(',').map((one) => one.trim()).filter(Boolean)]
    if (!worthSorting({ said, answered }, { filler })) return { content: [{ type: 'text', text: 'not worth keeping' }] }
    const text = `They said: ${clean(said)}\nAlexia answered: ${clean(answered)}`
    // Kept with the exchange, so the note written from it can say where it came from.
    const { src_channel: channel, src_session: session } = originFields(originFrom(rest, ctx))
    await alexia.storage.insert('buffer', {
      text,
      tries: 0,
      at: Number(at) || Date.now(),
      ...(channel === undefined ? {} : { src_channel: channel }),
      ...(session === undefined ? {} : { src_session: session }),
    })
    await report()
    void enough()
    return { content: [{ type: 'text', text: 'kept' }] }
  },
)

/**
 * The life graph (P3-14): people, dated things and goals, each linked to the fact it came from.
 *
 * Tables are read whole and filtered here, like `facts`: a column that has never been written
 * does not exist, and asking for it is an error on purpose. Nothing said in these rows goes into
 * a log line.
 */
const peopleRows = () => alexia.storage.select('people', { order: [['rowid', 'asc']], limit: 2000 })
const datesRows = () => alexia.storage.select('dates', { order: [['rowid', 'asc']], limit: 2000 })
const goalRows = () => alexia.storage.select('goals', { order: [['rowid', 'asc']], limit: 2000 })

/**
 * What a locked fact must never start: a message nobody asked for. The life graph rows hang off
 * the fact they came from, so a date, a person or a goal whose every source is locked is as
 * private as the fact is, and is left out of what `notice_items` looks at.
 */
async function lockedIds() {
  return new Set((await notes()).filter((row) => valid(row) && lockedOf(row)).map((row) => Number(row.rowid)))
}
async function unlockedGraph(hidden) {
  const open = (ids) => ids.length === 0 || ids.some((id) => !hidden.has(Number(id)))
  return {
    people: (await peopleRows()).filter((row) => open(idsOf(row.notes_ids))),
    dates: (await datesRows()).filter((row) => !hidden.has(Number(row.fact_id))),
    goals: (await goalRows()).filter((row) => open(idsOf(row.fact_ids))),
  }
}

/** Make the life graph forget what came from these facts (`unlinkPlan`), or follow a rewrite (`to`). */
async function mend(factIds, to) {
  const rows = { people: await peopleRows(), dates: await datesRows(), goals: await goalRows() }
  const plan = to === undefined ? unlinkPlan(rows, factIds) : relinkPlan(rows, factIds[0], to)
  for (const table of ['people', 'dates', 'goals']) {
    for (const one of plan[table]) {
      if (one.remove) await alexia.storage.delete(table, { rowid: one.rowid })
      else await alexia.storage.update(table, one.set, { rowid: one.rowid })
    }
  }
}

/** Someone who came up again: the day, the note, a new spelling kept as an alias. */
async function meet(found, one, factId, at) {
  const set = { last_seen: at }
  const aliases = aliasesOf(found)
  if (fold(one.name) !== fold(found.name) && !aliases.some((a) => fold(a) === fold(one.name))) {
    aliases.push(one.name)
    set.aliases = JSON.stringify(aliases)
  }
  const ids = idsOf(found.notes_ids)
  if (!ids.includes(factId)) set.notes_ids = JSON.stringify([...ids, factId])
  if (one.relation !== undefined && String(found.relation ?? '') !== one.relation) set.relation = one.relation
  const birthday = normalBirthday(one.birthday)
  if (birthday !== null && found.birthday !== birthday) set.birthday = birthday
  if (one.followUp !== undefined) {
    set.follow_up = one.followUp
    set.follow_up_at = at
  }
  await alexia.storage.update('people', set, { rowid: Number(found.rowid) })
}

/** What a sorted fact said about people, dates and goals, written down and linked to the fact. */
async function absorb(one, factId, at) {
  if (one.people) {
    const known = await peopleRows()
    for (const person of one.people) {
      const found = findPerson(known, person.name)
      if (found) {
        await meet(found, person, factId, at)
        continue
      }
      const birthday = normalBirthday(person.birthday)
      const row = {
        name: person.name,
        aliases: '[]',
        relation: person.relation ?? '',
        ...(birthday === null ? {} : { birthday }),
        notes_ids: JSON.stringify([factId]),
        last_seen: at,
        ...(person.followUp === undefined ? {} : { follow_up: person.followUp, follow_up_at: at }),
      }
      const rowid = await alexia.storage.insert('people', row)
      known.push({ ...row, rowid })
    }
  }
  if (one.dates) {
    const held = await datesRows()
    for (const date of one.dates) {
      // Resolved here, from the message's own time: the model is not trusted with arithmetic.
      const due = resolveDue(date.due, at, offsetAt(at))
      if (due === null) continue
      // The same thing said again is the same row, now owed to the newer fact, so correcting
      // the older one does not take it away.
      const twin = held.find((row) => row.due === due && fold(row.what) === fold(date.what))
      if (twin) {
        if (Number(twin.fact_id) !== factId) await alexia.storage.update('dates', { fact_id: factId }, { rowid: Number(twin.rowid) })
        twin.fact_id = factId
        continue
      }
      const rowid = await alexia.storage.insert('dates', { what: date.what, due, kind: date.kind, fact_id: factId, state: 'open' })
      held.push({ rowid, what: date.what, due, fact_id: factId })
    }
  }
  if (one.goals) {
    const held = await goalRows()
    for (const goal of one.goals) {
      const same = findGoal(held, goal.text)
      if (same) {
        const ids = idsOf(same.fact_ids)
        const fact_ids = JSON.stringify([...new Set([...ids, factId])])
        await alexia.storage.update('goals', { last_touched: at, fact_ids }, { rowid: Number(same.rowid) })
        same.fact_ids = fact_ids
      } else {
        const fact_ids = JSON.stringify([factId])
        const rowid = await alexia.storage.insert('goals', { text: goal.text, since: at, last_touched: at, state: 'active', fact_ids })
        held.push({ rowid, text: goal.text, state: 'active', fact_ids })
      }
    }
  }
}

/** Ask whatever answers `contacts.find`, or nothing at all when nothing does. */
async function askContacts(query) {
  try {
    if ((await alexia.answers('contacts.find')).answers !== true) return null
    return await alexia.capability('contacts.find', { query })
  } catch {
    return null
  }
}

/** A person with their birthday and contact line filled from the address book, when there is one. */
async function lookedUp(person) {
  const patch = await fromContacts(person, askContacts)
  if (Object.keys(patch).length === 0) return person
  await alexia.storage.update('people', patch, { rowid: Number(person.rowid) })
  return { ...person, ...patch }
}

const reads = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const said = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) })

alexia.tool(
  'about_person',
  {
    description:
      'What is known about one person in the user’s life: how they know them, their birthday, what has been said about ' +
      'them, when they last came up, and anything the user said they would do for them. Use for "what do you know about Petr".',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'The person’s name, in any spelling or case.' } },
      required: ['name'],
    }),
    annotations: reads,
  },
  async ({ name } = {}) => {
    const found = findPerson(await peopleRows(), name)
    if (!found) return said('Nobody by that name is known yet.')
    // The address book is asked here, and nothing is said about it when it is not there.
    const person = await lookedUp(found)
    const ids = new Set(idsOf(person.notes_ids))
    const facts = (await current()).filter((row) => ids.has(Number(row.rowid)))
    const lines = [
      personLine(person),
      ...(String(person.contact ?? '') === '' ? [] : [`Contact: ${String(person.contact)}`]),
      ...(Number(person.last_seen) > 0 ? [`Last came up: ${day(person.last_seen)}`] : []),
      ...(String(person.follow_up ?? '') === '' ? [] : [`To follow up: ${String(person.follow_up)}`]),
      ...(facts.length === 0 ? ['Nothing else written down.'] : facts.slice(0, 20).map((row) => factLine(row))),
    ]
    return said(lines.join('\n'), {
      name: person.name,
      relation: person.relation ?? '',
      birthday: person.birthday ?? null,
      lastSeen: person.last_seen ?? null,
      followUp: person.follow_up ?? null,
      facts: facts.slice(0, 20).map((row) => Number(row.rowid)),
    })
  },
)

alexia.tool(
  'people',
  { description: 'Everyone in the user’s life that is known, one line each. Takes no arguments.', annotations: reads },
  async () => {
    const all = await peopleRows()
    return said(all.length === 0 ? 'Nobody yet.' : all.map((p) => `- ${personLine(p)}`).join('\n'))
  },
)

alexia.tool(
  'goal',
  {
    description: 'Write down something the user is working towards, so Alexia can ask after it. One goal per call.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'The goal, as a short sentence.' } },
      required: ['text'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text } = {}) => {
    const goal = String(text ?? '').trim()
    if (goal === '') return refused('A goal needs words.')
    const now = Date.now()
    const same = findGoal(await goalRows(), goal)
    if (same) {
      await alexia.storage.update('goals', { last_touched: now }, { rowid: Number(same.rowid) })
      return said(`Already working towards that (#${String(same.rowid)}).`)
    }
    const rowid = await alexia.storage.insert('goals', { text: goal, since: now, last_touched: now, state: 'active' })
    return said(`Noted as goal #${String(rowid)}.`, { id: rowid })
  },
)

alexia.tool(
  'goal_done',
  {
    description: 'Mark a goal as done, by its id (`goals` lists them).',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'The goal’s id.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id } = {}) => {
    const rowid = Number(String(id ?? '').replace(/^#/, ''))
    const [row] = Number.isFinite(rowid) ? await alexia.storage.select('goals', { where: { rowid }, limit: 1 }) : []
    if (!row) return refused('No goal with that id.')
    await alexia.storage.update('goals', { state: 'done', last_touched: Date.now() }, { rowid })
    return said('Marked as done.')
  },
)

alexia.tool(
  'goals',
  { description: 'The goals the user is working towards, one line each. Takes no arguments.', annotations: reads },
  async () => {
    const active = (await goalRows()).filter((g) => g.state === 'active')
    return said(active.length === 0 ? 'No goals right now.' : active.map((g) => `- #${String(g.rowid)} ${String(g.text)} (since ${day(g.since)})`).join('\n'))
  },
)

/**
 * What might be worth saying now (`notice.items`, §3.6). A goal that is raised is stamped
 * `raised_at`, which is how "once per 14 days" is counted; the scheduler dedupes by key anyway.
 */
alexia.tool(
  'notice_items',
  {
    description:
      'Birthdays coming up, dated things said in passing, people the user meant to get back to, and goals not touched ' +
      'in a while. Takes `now` (epoch ms), `horizon_days` and `tz_offset_min` (minutes east of UTC).',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        horizon_days: { type: 'number', description: 'How many days ahead counts as soon. Defaults to 7.' },
        tz_offset_min: { type: 'number', description: 'The owner’s offset from UTC in minutes, east positive. Defaults to 0.' },
      },
    }),
    annotations: reads,
    _meta: { 'alexia/provides': ['notice.items'] },
  },
  async ({ now, horizon_days, tz_offset_min } = {}) => {
    const num = (value, fallback) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)
    const at = num(now, Date.now())
    const found = noticeItems(
      await unlockedGraph(await lockedIds()),
      at,
      num(tz_offset_min, 0),
      num(horizon_days, 7),
    )
    for (const item of found) {
      const match = /^memory:goal:(\d+)$/.exec(item.key)
      if (match) await alexia.storage.update('goals', { raised_at: at }, { rowid: Number(match[1]) })
    }
    return said(found.map((item) => `- ${item.text}`).join('\n'), { items: found })
  },
)

/**
 * **The owner said Done to a notice** (`notice.done`). Every provider hears every key; only
 * `memory:follow:<id>` (the follow-up is cleared) and `memory:date:<id>` (an open date becomes
 * done) are ours. Anything else, or a row that is gone, does nothing.
 */
alexia.tool(
  'notice_done',
  {
    description:
      'Close what a notice was about, when its key is `memory:follow:<id>` or `memory:date:<id>`. Any other key does nothing.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { key: { type: 'string', description: 'The notice’s key.' } },
      required: ['key'],
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'alexia/provides': ['notice.done'] },
  },
  async ({ key } = {}) => {
    const change = doneChange(key)
    const rows = change === null ? [] : await alexia.storage.select(change.table, { where: { rowid: change.rowid }, limit: 1 })
    if (change === null || rows.length === 0) {
      return said('Nothing to close.', { closed: false })
    }
    await alexia.storage.update(change.table, change.set, { rowid: change.rowid })
    return said('Closed.', { closed: true })
  },
)

/**
 * Sorting by count as well as by clock (the owner's *every five messages*).
 *
 * The timer alone meant a busy half hour waited for the next tick and a note said at 9:01 was
 * not known at 9:05. So once `every` exchanges are waiting, the pass runs now. **One at a
 * time**: a second capture arriving mid-pass joins the one in flight rather than starting a
 * second call over the same rows. The timer stays, for the three that never reach five.
 */
let sorting
/** The timer's pass and the count's pass are the same pass, and only one is ever in flight. */
const sortOnce = () =>
  (sorting ??= tick()
    .catch((error) => log.info(String(error)))
    // Only when the pass wrote something; an empty buffer still asks nothing.
    .then((done) => (done?.written ? filing() : undefined))
    .finally(() => {
      sorting = undefined
    }))
async function enough() {
  if (sorting) return sorting
  const { every } = await settings()
  if ((await alexia.storage.count('buffer')) < Math.max(1, Number(every) || 5)) return
  return sortOnce()
}

/**
 * One pass over the buffer.
 *
 * Everything expensive is behind the first two lines: **an empty buffer asks nothing**,
 * which is what makes an idle Alexia cost nothing at all rather than a model call every
 * twelve minutes forever.
 *
 * What it decides is in `capture.js` and is tested there; what is here is the storage and
 * the queue around it.
 */
async function tick() {
  const { capture } = await settings()
  if (capture !== true) return { why: 'writing things down by itself is switched off' }
  // Set-aside rows are skipped and kept: `TRIES` failures means this content breaks the
  // call, and a row that is always the head of the queue is a queue that never drains.
  const waiting = (await alexia.storage.select('buffer', { order: [['at', 'asc']], limit: 2000 }))
    .filter((row) => Number(row.tries ?? 0) < TRIES)
    .slice(0, BATCH)
  if (waiting.length === 0) return { why: 'nothing waiting to be sorted' }

  const result = await sortExchanges(waiting)
  if (result.failure !== undefined) return await failed(waiting, result.failure)
  for (const row of waiting) await alexia.storage.delete('buffer', { rowid: Number(row.rowid) })
  await report()
  return { read: result.read, written: result.written }
}

/**
 * The sorting itself, for exchanges that are in hand: one model call, the judgement in
 * `capture.js`, the notes written. `extra` is what every note written here also carries — an
 * import says `stated` and where it came from, which the exchanges themselves cannot.
 * Returns `{ read, written }`, or `{ failure }` when nothing could be written from them.
 */
async function sortExchanges(waiting, extra = {}) {
  // Only what is still true: a closed note is not something to repeat, link to or replace.
  // Newest first, which is the order `prompt` cuts at.
  const held = await current()
  const now = Date.now()
  let said
  try {
    said = await sample(
      prompt(waiting, held, new Date(now)),
      'You write short notes about a person from what they said. Answer with JSON only.',
      1200,
    )
  } catch (error) {
    // No model reachable — on this path that also means no *free* model reachable, since a
    // plugin on its own clock never spends (G12). The rows keep their turn.
    return { failure: error instanceof Error ? error.message : String(error) }
  }

  const candidates = parse(said)
  if (candidates === null) return { failure: 'the answer was not JSON' }

  // The judgement, decided without a database in front of it — the duplicate and replace
  // overrules, the pinned-note protection and the link filtering all live in `capture.js`,
  // where they can be argued with.
  const write = plan(candidates, held, now)
  const origin = originFields(originOf(waiting))
  const fresh = []
  for (const one of write) {
    const old = one.replaces === undefined ? undefined : held.find((row) => Number(row.rowid) === one.replaces)
    // A replacement inherits what the old version was filed under, so closing a note does not
    // quietly unfile everything that hung off it. Only names of notes still held.
    if (old) for (const name of linksOf(old)) if (!one.links.includes(name) && held.some((row) => nameOf(row) === name)) one.links.push(name)
    const rowid = await alexia.storage.insert('facts', {
      name: one.name,
      text: one.text,
      kind: KINDS.includes(one.kind) ? one.kind : 'other',
      links: JSON.stringify(one.links),
      // Nobody asked for this one. Recall says so when it reads it back.
      source: INFERRED,
      ...origin,
      // Never `pinned` — see the end of capture.js. The model's opinion is kept as a
      // suggestion for a person to act on, and only when it had one. The same for replacing
      // a pinned note: `suggest_replaces`, and the pinned one stays as it is.
      ...(one.suggestPin ? { suggest_pin: true } : {}),
      ...(one.suggestReplaces !== undefined ? { suggest_replaces: one.suggestReplaces } : {}),
      ...(one.timeBound ? { time_bound: true, review_at: one.reviewAt } : {}),
      ...filedLike(old),
      ...lockedLike(old),
      ...extra,
      at: now,
      valid_from: now,
    })
    fresh.push({ rowid, text: one.text })
    // The exchange's own time, so "next Friday" is counted from when it was said.
    await absorb(one, rowid, Number(waiting[0]?.at) || now).catch(() => log.info('could not file people, dates and goals'))
    if (old) {
      await supersede(old, rowid, now)
      held.splice(held.indexOf(old), 1)
    }
    // The link goes on both, which is what lets one note sit under two parents with no new
    // machinery: one canonical note, one name appended to each of them.
    for (const name of one.links) {
      const parent = held.find((row) => nameOf(row) === name)
      if (!parent) continue
      const theirs = linksOf(parent)
      if (theirs.includes(one.name)) continue
      parent.links = JSON.stringify([...theirs, one.name])
      await alexia.storage.update('facts', { links: parent.links }, { rowid: Number(parent.rowid) })
    }
    // A note written a moment ago is a note the next one in this batch can hang off. Left
    // out, a parent and its child arriving together are linked one way only — and which way
    // depends on the order the model happened to list them in.
    held.push({ rowid, name: one.name, text: one.text, links: JSON.stringify(one.links) })
  }

  await vectorise(fresh)
  return { read: waiting.length, written: write.length }
}

/**
 * One question to a model, through sampling — the only way a plugin on its own clock reaches
 * one, and only ever a free one (G12). The sorting pass and the gardener both ask through here.
 */
async function sample(text, systemPrompt, maxTokens) {
  const answer = await alexia.server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text } }],
    systemPrompt,
    maxTokens,
  })
  return answer.content?.type === 'text' ? answer.content.text : ''
}

/**
 * Filing, and keeping the tree's summaries true: at most **two** free-model calls a run, and
 * none at all when nothing is unplaced and no branch is behind — an idle Alexia still makes no
 * calls.
 *
 * 1. **Placing.** Every valid note with no branch — at most `PLACE_MOST`, oldest first, so a
 *    table from before the tree drains in order — goes to the model in one prompt with the
 *    outline of the tree (names and summaries, never the notes). What comes back is checked
 *    item by item in `tree.js` (`plan`): an id it was not shown is ignored, a path that does not
 *    fit goes to the nearest branch that does, and a note it missed or misfiled is put by its
 *    kind. If the model cannot be reached at all, nothing is placed and the notes wait for the
 *    next run — filing all of them by kind because a model was briefly away would throw away
 *    the one thing this is for, on the owner's whole table at once.
 * 2. **Summarising.** Every branch a placement touched, and every branch marked behind since
 *    (`BEHIND`), with everything above them: one prompt, each branch shown what is directly
 *    under it. A summary that is not one sentence of at most 160 characters is not believed and
 *    the old one stays. A branch with nothing valid under it gets no call and an empty summary.
 *    What is past `SUMMARY_MOST` stays behind for the next run.
 *
 * One run at a time: the gardener's clock, the timer and a button can all ask at once, and two
 * placers reading the same unplaced notes would file them twice and make two *Niki*s.
 */
let arranging = Promise.resolve()
const arrange = () => {
  const run = arranging.catch(() => {}).then(arrangeOnce)
  arranging = run
  return run
}

async function arrangeOnce() {
  await plant()
  const all = await current()
  const unplaced = all
    .filter((row) => when(row.branch) === null)
    .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0) || Number(a.rowid) - Number(b.rowid))
    .slice(0, PLACE_MOST)
  const waiting = new Set(((await alexia.storage.get(BEHIND))?.ids ?? []).map(Number))
  if (unplaced.length === 0 && waiting.size === 0) return {}

  const done = { placed: 0, byModel: 0, made: 0, summarised: 0 }
  if (unplaced.length > 0) {
    const t = await tree()
    let said
    try {
      said = await sample(placePrompt(t, unplaced), 'You file short notes about a person into a tree. Answer with JSON only.', 1500)
    } catch (error) {
      log.info(`could not place notes: ${error instanceof Error ? error.message : String(error)}`)
      return done
    }
    const { create, place } = planned(t, unplaced, parseArray(said))
    // New branches first, parents before children, so a planned id can be swapped for a real one.
    const real = new Map()
    const now = Date.now()
    for (const one of create) {
      const parent = one.parent < 0 ? real.get(one.parent) : one.parent
      real.set(one.id, await sprout(parent, one.name, now))
    }
    const swap = (id) => (id < 0 ? real.get(id) : id)
    for (const one of place) {
      const branch = swap(one.branch)
      if (branch === null || branch === undefined) continue
      const also = one.also.map(swap).filter((id) => id !== undefined)
      await alexia.storage.update('facts', { branch, ...(also.length > 0 ? { also: JSON.stringify(also) } : {}) }, { rowid: one.id })
      waiting.add(branch)
      for (const id of also) waiting.add(id)
    }
    done.placed = place.length
    done.byModel = place.filter((one) => one.by === 'model').length
    done.made = create.length
    log.info(`filed ${done.placed} note(s), ${done.byModel} where the model said, ${done.made} new branch(es)`)
  }

  const t = await tree()
  // Without the locked ones: a summary is shown in every recall, and it must not say what a
  // locked note says.
  const fresh = visible(await current())
  const count = counts(t, fresh)
  const behindNow = [...touched(t, [...waiting].filter((id) => t.nodes.has(id)))]
  for (const id of behindNow) {
    if ((count.get(id) ?? 0) === 0 && t.nodes.get(id).summary !== '') {
      await alexia.storage.update('branches', { summary: '', updated_at: Date.now() }, { rowid: id })
    }
  }
  const asking = behindNow.filter((id) => (count.get(id) ?? 0) > 0).slice(0, SUMMARY_MOST)
  let left = behindNow.filter((id) => (count.get(id) ?? 0) > 0).slice(SUMMARY_MOST)
  if (asking.length > 0) {
    try {
      const said = await sample(summaryPrompt(t, asking, fresh), 'You summarise branches of a tree of notes. Answer with JSON only.', 1500)
      // Asked once, whatever came back: a model that answers badly would otherwise be asked the
      // same thing every run forever. A bad summary keeps the old one, which is only stale.
      for (const [id, summary] of readSummaries(t, asking, parseArray(said))) {
        await alexia.storage.update('branches', { summary, updated_at: Date.now() }, { rowid: id })
        done.summarised += 1
      }
    } catch (error) {
      // Unreachable is not an answer: they stay behind for the next run.
      log.info(`could not summarise branches: ${error instanceof Error ? error.message : String(error)}`)
      left = [...left, ...asking]
    }
  }
  await alexia.storage.set(BEHIND, { ids: left })
  return done
}

/**
 * A note saved with `remember` is filed a little later rather than never: the placer runs on
 * the sorting timer and the gardener's six-hour clock, and with capture off only the second
 * one ticks. So a `remember` also asks for a run a minute on — one, however many notes arrive
 * in that minute, which is what keeps a burst of remembering to one call.
 */
let pending
function soon() {
  if (pending) return
  pending = setTimeout(() => {
    pending = undefined
    void arrange().catch((error) => log.info(`could not file notes: ${String(error)}`))
  }, 60_000)
  pending.unref?.()
}

/**
 * The gardener: the notes whose review has come, looked at once.
 *
 * **It costs nothing unless something is due.** Like the tick, everything expensive is behind
 * two cheap checks: it runs at most once every `GARDEN_EVERY` (the last run is in kv, like the
 * seed), and not at all — not even to write that it ran — until some valid note's `review_at`
 * has passed. So an idle Alexia still makes no calls.
 *
 * **It does not guess.** For each due note (`garden.js` decides which): if the sentence uses
 * relative time, one free-model call may rewrite it into absolute time from the date it was
 * written, and code checks the rewrite before believing it (`rewrite`). A rewrite that passes
 * replaces the note — or, for a pinned note, is written beside it as a suggestion, the same
 * protection the sorting pass gets. Either way the note stops being due, and if it describes
 * something that changes it is marked *may be out of date* for a person to answer with
 * `still_true` or `no_longer_true`. Nothing here ever closes a note on its own judgement.
 *
 * At most `GARDEN_MOST` model calls per run; what is not reached is still due next week.
 */
async function garden(now = Date.now()) {
  const last = await alexia.storage.get(GARDENED)
  if (last && now - Number(last.at ?? 0) < GARDEN_EVERY) return { why: 'looked after less than a week ago' }
  const all = await notes()
  const waiting = due(all, now)
  if (waiting.length === 0) return { why: 'nothing due for a check' }
  // Written before the calls, so one that throws halfway does not make the next tick retry.
  await alexia.storage.set(GARDENED, { at: now, due: waiting.length })

  let asked = 0
  let rewritten = 0
  let marked = 0
  for (const note of waiting) {
    if (asked >= GARDEN_MOST && relative(note.text)) continue
    let better = null
    if (relative(note.text)) {
      asked += 1
      try {
        better = rewrite(note.text, await sample(rewritePrompt(note), 'You rewrite one short note. Answer with the sentence only.', 200))
      } catch (error) {
        log.info(`could not rewrite a note: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const doubt = timeBound(note) ? { stale_since: now } : {}
    if (better !== null) {
      const pinned = pinnedOf(note)
      // The same note, said so that it stays true. Where it came from travels with it: a
      // rewrite of what somebody said is still what they said.
      const rowid = await alexia.storage.insert('facts', {
        name: nameOf(note),
        text: better,
        kind: String(note.kind ?? 'other'),
        links: JSON.stringify(linksOf(note)),
        source: note.source === INFERRED ? INFERRED : STATED,
        ...originFields({ channel: note.src_channel, session: note.src_session, doc: note.src_doc }),
        ...(timeBound(note) ? { time_bound: true } : {}),
        ...doubt,
        ...(pinned ? { suggest_replaces: Number(note.rowid) } : {}),
        ...filedLike(note),
        ...lockedLike(note),
        at: now,
        valid_from: now,
      })
      rewritten += 1
      await vectorise([{ rowid, text: better }])
      if (!pinned) {
        await supersede(note, rowid, now, { rewrite: true })
        continue
      }
    }
    await alexia.storage.update('facts', { ...cleared(note, ['review_at']), ...doubt }, { rowid: Number(note.rowid) })
    if (timeBound(note)) marked += 1
  }
  await report()
  return { due: waiting.length, rewritten, marked }
}

/** A batch that could not be turned into notes. Its rows get another turn, up to `TRIES`. */
async function failed(waiting, why) {
  for (const row of waiting) {
    await alexia.storage.update('buffer', { tries: Number(row.tries ?? 0) + 1 }, { rowid: Number(row.rowid) })
  }
  const stuck = waiting.filter((row) => Number(row.tries ?? 0) + 1 >= TRIES).length
  const said = `could not sort ${waiting.length} exchange(s): ${why}${stuck > 0 ? ` - ${stuck} set aside` : ''}`
  log.info(said)
  await report()
  return { why: said }
}

/**
 * One pass, now, rather than at the next tick.
 *
 * A button, and the seam the test drives — twelve minutes is the right interval and the
 * wrong thing to wait for, either while watching whether this works or while writing a test
 * about whether it does.
 */
alexia.tool(
  'sort_now',
  {
    description:
      'Sort through what has been kept since the last pass and write down anything worth ' +
      'remembering, without waiting for the timer. Takes no arguments.',
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async () => {
    // A button press waits for a pass already running rather than racing it over the same rows.
    if (sorting) await sorting
    const { done, looked, filed } = await pass()
    await backfill().catch(() => {})
    // The gardener is only mentioned when it did something; it is quiet on almost every pass.
    const tended =
      looked?.due === undefined ? ''
      : ` Checked ${looked.due} note${looked.due === 1 ? '' : 's'} that may have changed: rewrote ${looked.rewritten}, marked ${looked.marked} as may be out of date.`
    // Filing is mentioned the same way: only when it filed something.
    const put =
      !filed?.placed ? ''
      : ` Filed ${filed.placed} note${filed.placed === 1 ? '' : 's'} in the tree${filed.made ? `, ${filed.made} new branch${filed.made === 1 ? '' : 'es'}` : ''}.`
    return {
      content: [
        {
          type: 'text',
          text:
            (done.why !== undefined ? done.why
            : `Read ${done.read} exchange${done.read === 1 ? '' : 's'} and wrote ${done.written} note${done.written === 1 ? '' : 's'}.`) +
            tended +
            put,
        },
      ],
    }
  },
)

/**
 * What the timer does: the sorting pass, then the gardener. Each is cheap when it has nothing
 * to do and neither stops the other — a sorting pass that failed is no reason to leave a due
 * note unchecked.
 */
async function pass() {
  const done = await tick().catch((error) => ({ why: `could not sort: ${String(error)}` }))
  const looked = await garden().catch((error) => {
    log.info(`could not look after old notes: ${String(error)}`)
    return undefined
  })
  // The nightly tidy-up is the first of these after 02:00 local; the rest of the night it is a read of one key.
  await nightly()
  // Filing last, so what the sorting pass and the gardener just wrote is filed in this pass.
  const filed = await filing()
  await syncing()
  return { done, looked, filed }
}

/** `arrange`, never throwing: a filing run that failed is no reason for anything else to. */
const filing = () =>
  arrange().catch((error) => {
    log.info(`could not file notes: ${String(error)}`)
    return {}
  })

// ---- files: where the plugin may read and write (P3-15) --------------------------------------

/** The folders the owner chose, as plain paths. Asked each time: they can change while this runs. */
async function chosenRoots() {
  try {
    return rootPaths((await alexia.server.server.listRoots()).roots)
  } catch {
    return []
  }
}

/** The plugin's own folder, when it has one. */
async function ownFolder() {
  try {
    const own = (await alexia.host()).paths?.ownDir
    return typeof own === 'string' && own !== '' ? [own] : []
  } catch {
    return []
  }
}

/** A path with its links followed as far as it exists, so a link inside a folder cannot lead out of it. */
async function real(path) {
  const rest = []
  let here = resolve(path)
  for (;;) {
    try {
      return join(await realpath(here), ...rest.reverse())
    } catch {
      const up = dirname(here)
      if (up === here) return resolve(path)
      rest.push(basename(here))
      here = up
    }
  }
}

/**
 * May this path be touched: inside a folder the owner chose, or (`own`) inside the plugin's own
 * folder — checked on the path as written and on where it really leads.
 */
async function mayTouch(path, { own = false } = {}) {
  const places = [...(await chosenRoots()), ...(own ? await ownFolder() : [])]
  if (!insideRoots(path, places)) return false
  return insideRoots(await real(path), await Promise.all(places.map(real)))
}

// ---- the timeline (P3-15, ME-05) -------------------------------------------------------------

const daysRows = () => alexia.storage.select('days', { order: [['date', 'asc']], limit: 4000 })

/** The owner's offset from UTC now, in minutes east: the clock this machine runs on. */
const zoneNow = (now = Date.now()) => offsetAt(now)

/**
 * The day lines written from these facts are dropped: forgetting or locking a fact must not leave
 * a sentence of it in the diary. Not rewritten — the day is blank, which is true.
 */
async function dropDays(rows) {
  const held = await daysRows().catch(() => [])
  if (held.length === 0) return
  const dates = new Set(rows.map((row) => dayOf(Number(row.at), zoneNow(Number(row.at)))))
  for (const row of held) if (dates.has(row.date)) await alexia.storage.delete('days', { rowid: Number(row.rowid) })
}

alexia.tool(
  'timeline',
  {
    description:
      'The owner’s days, one short line each, oldest first: what was said and done. Takes `from` and `to` (YYYY-MM-DD, both optional, both inclusive).',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
      },
    }),
    annotations: reads,
  },
  async ({ from, to } = {}) => {
    const rows = between(await daysRows(), from, to)
    return said(rows.length === 0 ? 'No days written down for that time.' : rows.map(lineOf).join('\n'), {
      days: rows.map((row) => ({ date: String(row.date), text: String(row.text) })),
    })
  },
)

/** One section of a brief (`brief.section`): the week's days, for the weekly one only. */
alexia.tool(
  'brief_section',
  {
    description: 'The week’s days as lines, for a weekly brief. Empty for the other kinds. Takes `kind`, `now` and `tz_offset_min`.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        kind: { type: 'string', description: '"morning", "evening" or "weekly".' },
        now: { type: 'number', description: 'Now, in epoch milliseconds.' },
        tz_offset_min: { type: 'number', description: 'Minutes east of UTC.' },
      },
      required: ['kind'],
    }),
    annotations: reads,
    _meta: { 'alexia/provides': ['brief.section'] },
  },
  async ({ kind, now, tz_offset_min } = {}) => {
    const num = (value, fallback) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)
    const one = briefSection(kind, await daysRows(), num(now, Date.now()), num(tz_offset_min, 0))
    return said(one.text, one)
  },
)

// ---- the nightly tidy-up (P3-15, ME-14) ------------------------------------------------------

/** In kv: the night last tidied, and what it did. */
const TIDIED = 'tidied'

/**
 * The first sort after 02:00 local, once a night: merge facts said twice, close dates that are
 * past, embed what has no vector, fill people from contacts, write yesterday's line.
 *
 * **It only writes this plugin's own tables**, and nothing in it is worth asking anybody about:
 * a merge closes the older fact (`supersede`, never a delete), a closed date is a state, a
 * vector is a column. One at a time, and written down as done *before* the work, so a pass that
 * throws halfway is not retried by every sort until morning.
 */
let nightlyRun
const nightly = (now) =>
  (nightlyRun ??= nightlyOnce(now)
    .catch((error) => {
      log.info(`could not tidy up: ${error instanceof Error ? error.message : 'unknown error'}`)
      return null
    })
    .finally(() => {
      nightlyRun = undefined
    }))

async function nightlyOnce(now = Date.now()) {
  const tz = zoneNow(now)
  const last = await alexia.storage.get(TIDIED)
  if (!nightlyDue(last, now, tz)) return null
  const night = nightOf(now, tz)
  await alexia.storage.set(TIDIED, { ...(last ?? {}), night, at: now })

  // Vectors first, so what was said this week takes part in the merge.
  await backfill().catch(() => {})

  let merged = 0
  for (const { old, keep } of duplicates(await current())) {
    // What the older one was must not be lost by being closed: its pin, its lock, and the fact
    // that somebody said it themselves all go to the one that stays.
    const carry = {
      ...(pinnedOf(old) && !pinnedOf(keep) ? { pinned: true } : {}),
      ...(lockedOf(old) && !lockedOf(keep) ? { locked: true } : {}),
      ...(old.source !== INFERRED && keep.source === INFERRED ? { source: STATED } : {}),
    }
    if (Object.keys(carry).length > 0) {
      await alexia.storage.update('facts', carry, { rowid: Number(keep.rowid) })
      Object.assign(keep, carry)
    }
    // A rewording in effect: the old one's dates, people and goals move to the one that stays.
    await supersede(old, Number(keep.rowid), now, { rewrite: true })
    merged += 1
  }

  let closed = 0
  for (const row of pastDates(await datesRows(), now, tz)) {
    await alexia.storage.update('dates', { state: 'closed' }, { rowid: Number(row.rowid) })
    closed += 1
  }

  for (const person of (await peopleRows()).slice(0, 200)) await lookedUp(person).catch(() => {})

  await writeDay(dayBefore(night), now, tz).catch((error) => log.info(`could not write the day: ${error instanceof Error ? error.message : 'unknown error'}`))

  // Said only when it did something: a night that found nothing is not worth a sentence in the status.
  if (merged + closed > 0) tidied = tidiedLine({ at: now, merged, closed }, tz)
  await alexia.storage.set(TIDIED, { night, at: now, merged, closed, line: tidied })
  await report()
  return { merged, closed }
}

/** One day's line, from that day's notes, dated things and exchanges not yet sorted. Locked notes are not in it. */
async function writeDay(date, now, tz) {
  const { from, to } = dayBounds(date, tz)
  const inDay = (ms) => Number(ms) >= from && Number(ms) < to
  const hidden = await lockedIds()
  const facts = (await notes()).filter((row) => inDay(row.at) && !lockedOf(row))
  const ids = new Set(facts.map((row) => Number(row.rowid)))
  const dates = (await datesRows())
    .filter((row) => !hidden.has(Number(row.fact_id)) && (ids.has(Number(row.fact_id)) || String(row.due ?? '').slice(0, 10) === date))
    .map((row) => `${String(row.what)} (${String(row.due)})`)
  const exchanges = (await alexia.storage.select('buffer', { order: [['at', 'asc']], limit: 2000 }))
    .filter((row) => inDay(row.at))
    .slice(0, 10)
    .map((row) => String(row.text ?? '').split('\nAlexia answered:')[0].replace(/^They said:\s*/, ''))
  const texts = facts.map((row) => String(row.text))
  if (texts.length === 0 && dates.length === 0 && exchanges.length === 0) return
  let text
  try {
    text = dayEntry(await sample(dayPrompt(date, { facts: texts, dates, exchanges }), 'You write one short diary entry. Answer with the sentences only.', 400))
  } catch {
    // No model: the plain line, which says only what was written down.
    text = plainEntry(texts)
  }
  if (text === null || text === undefined) return
  const write = dayUpsert(await daysRows(), date, text, now)
  if (write?.insert) await alexia.storage.insert('days', write.insert)
  else if (write?.update) {
    await alexia.storage.update('days', write.update.set, { rowid: write.update.rowid })
    for (const rowid of write.remove) await alexia.storage.delete('days', { rowid })
  }
}

// ---- the profile file (P3-15, ME-04) ---------------------------------------------------------

/** In kv: what the file was when it was last written or read — `{ path, mtime, hash, lines }`. */
const FILED = 'profile_file_state'
const hashOf = (text) => createHash('sha256').update(text).digest('hex')

/**
 * Pinned facts as a Markdown file the owner can read and edit, and what they change read back.
 *
 * On start and every sort: if the file's hash says it is not what was last written (its mtime is kept beside it), the
 * lines the owner added become pinned stated facts and the lines they took away are unpinned —
 * not forgotten. Then the file is rewritten only if what it says is no longer what is pinned, so
 * a file the owner has laid out their own way is left as it is. A path outside the folders the
 * owner chose (and this plugin's own) is a sentence in the status and nothing written. A locked
 * fact is never in the file, and so a file never makes it look removed.
 */
async function syncProfile() {
  const { profile_file: asked } = await settings()
  const path = typeof asked === 'string' ? asked.trim() : ''
  const before = fileNote
  fileNote = ''
  if (path === '') {
    if (before !== '') await report()
    return
  }
  if (!(await mayTouch(path, { own: true }))) {
    fileNote = 'The profile file is outside the folders you chose, so nothing was written to it.'
    await report()
    return
  }
  const kept = await alexia.storage.get(FILED)
  const mine = kept && kept.path === path ? kept : null
  let info = null
  try {
    info = await stat(path)
  } catch {
    info = null
  }
  let bulletsNow = mine?.lines ?? []
  let hash = mine?.hash
  let mtime = mine?.mtime
  // Read every time, however little the clock says changed: the file is a few lines, a coarse
  // file-system timestamp is exactly when an edit made a second after a write is missed, and the
  // hash is what decides.
  if (info !== null) {
    const text = await readFile(path, 'utf8')
    hash = hashOf(text)
    mtime = info.mtimeMs
    bulletsNow = bullets(text)
    if (!(mine && mine.hash === hash)) await readBack(edits(mine?.lines ?? [], bulletsNow))
  }
  const lines = pinnedLines(await current())
  const sameSet = info !== null && lines.length === bulletsNow.length && lines.every((line) => bulletsNow.some((one) => sameLine(one) === sameLine(line)))
  if (!sameSet) {
    const text = renderFile(lines)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
    hash = hashOf(text)
    mtime = (await stat(path)).mtimeMs
    bulletsNow = bullets(text)
  }
  await alexia.storage.set(FILED, { path, mtime, hash, lines: bulletsNow })
  if (before !== '') await report()
}

/** What the owner did to the file: pin what they added, unpin what they took away. */
async function readBack({ added, removed }) {
  const all = await current()
  const now = Date.now()
  const fresh = []
  for (const line of added) {
    const match = all.find((row) => sameLine(row.text) === sameLine(line))
    if (match) {
      // A locked note is not in the file, so a line that matches one is not the owner's doing.
      if (!lockedOf(match) && !pinnedOf(match)) await alexia.storage.update('facts', { pinned: true, source: STATED }, { rowid: Number(match.rowid) })
      continue
    }
    const rowid = await alexia.storage.insert('facts', {
      name: line.split(/[,.;:]/)[0].slice(0, 60).trim() || line.slice(0, 60),
      text: line,
      kind: 'other',
      links: '[]',
      source: STATED,
      pinned: true,
      at: now,
      valid_from: now,
    })
    fresh.push({ rowid, text: line })
  }
  for (const line of removed) {
    for (const row of all.filter((one) => pinnedOf(one) && sameLine(one.text) === sameLine(line))) {
      await alexia.storage.update('facts', { pinned: false }, { rowid: Number(row.rowid) })
    }
  }
  if (fresh.length > 0) {
    await vectorise(fresh)
    soon()
  }
}

/** `syncProfile`, never throwing, and with nothing the owner wrote in the log. */
const syncing = () =>
  syncProfile().catch((error) => log.info(`could not sync the profile file: ${error instanceof Error ? error.message : 'unknown error'}`))

// ---- importing (P3-15, ME-18) ----------------------------------------------------------------

/** The biggest export read at all: a year of chats is tens of megabytes, and this is not that either. */
const IMPORT_MOST_BYTES = 300 * 1024 * 1024

alexia.tool(
  'import_memories',
  {
    description:
      'Bring in what another assistant knew about the user, from an export file the user points at: ChatGPT’s data export ' +
      '(conversations.json, or the folder it was unpacked to), a Claude memory export (Markdown or JSON), or a text file with ' +
      'one memory per line. The file must be inside a folder the user chose. Takes `path`, and `assistant` to name where it came from.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The export file, or the folder it was unpacked to.' },
        assistant: { type: 'string', description: 'What to call where it came from, e.g. "ChatGPT". Guessed from the file when left out.' },
      },
      required: ['path'],
    }),
    // It writes notes, and takes nothing away.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ path, assistant } = {}, ctx) => {
    const asked = String(path ?? '').trim()
    if (!(await mayTouch(asked))) {
      return refused('That is not inside a folder you chose, so it was not opened. Add its folder to the folders Alexia may read, then ask again.')
    }
    let file = asked
    try {
      if ((await stat(asked)).isDirectory()) {
        const found = exportFile(await readdir(asked))
        if (found === undefined) return refused('That folder has no conversations.json or memory file in it.')
        file = join(asked, found)
        if (!(await mayTouch(file))) return refused('That file leads outside the folders you chose, so it was not opened.')
      }
      if ((await stat(file)).size > IMPORT_MOST_BYTES) return refused('That file is too big to read.')
    } catch {
      return refused('That file could not be opened.')
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return refused('That file could not be read.')
    }
    const found = parseExport(basename(file), text, assistant)
    if (found === null) return refused('Nothing in that file looks like memories or messages this can read.')
    const from = importedFrom(found.assistant)
    const done = found.kind === 'memories' ? await importMemories(found.items, from) : await importMessages(found.items, from, ctx)
    await report()
    const stopped = done.stopped ? ' It stopped there because no model could be reached; running it again carries on, and what was written is not written twice.' : ''
    const line =
      found.kind === 'memories' ?
        `Imported ${done.written} memor${done.written === 1 ? 'y' : 'ies'} from ${found.assistant}; ${done.skipped} already known.`
      : `Read ${done.read} of your messages from ${found.assistant} and wrote ${done.written} note${done.written === 1 ? '' : 's'} from them.${stopped}`
    return said(line, { assistant: found.assistant, kind: found.kind, ...done })
  },
)

/** Memories as they are: stated, saying where from, and not again when they are already held. */
async function importMemories(items, from) {
  const held = new Set((await current()).map((row) => sameLine(row.text)))
  const now = Date.now()
  const fresh = []
  let skipped = 0
  for (const text of items) {
    if (held.has(sameLine(text))) {
      skipped += 1
      continue
    }
    held.add(sameLine(text))
    const rowid = await alexia.storage.insert('facts', {
      name: text.split(/[,.;:]/)[0].slice(0, 60).trim() || text.slice(0, 60),
      text,
      kind: 'other',
      links: '[]',
      source: STATED,
      src_doc: from,
      at: now,
      valid_from: now,
    })
    fresh.push({ rowid, text })
  }
  await vectorise(fresh)
  if (fresh.length > 0) soon()
  return { written: fresh.length, skipped, read: items.length }
}

/** The owner's own messages, through the sorting pass in batches. Notes come out stated, from the file. */
async function importMessages(items, from, ctx) {
  const { skip } = await settings()
  const filler = [...DEFAULT_FILLER, ...String(skip ?? '').split(',').map((one) => one.trim()).filter(Boolean)]
  const rows = items
    .filter((said) => worthSorting({ said, answered: '' }, { filler }))
    .map((said) => ({ text: `They said: ${clean(said)}\nAlexia answered: `, at: Date.now(), tries: 0 }))
  const groups = batches(rows, BATCH)
  let read = 0
  let written = 0
  let stopped = false
  for (const [index, group] of groups.entries()) {
    alexia.progress?.(ctx, index, groups.length, 'Sorting what you said')
    const result = await sortExchanges(group, { source: STATED, src_doc: from })
    if (result.failure !== undefined) {
      stopped = true
      break
    }
    read += result.read
    written += result.written
  }
  if (written > 0) await filing()
  return { written, skipped: items.length - rows.length, read, stopped }
}

/**
 * The binding, and it is where the consent lives (D73, M6-9).
 *
 * The capability is bound on the tool **only while the setting is on**, so with capture off
 * core resolves nothing and never hands the exchange over at all. That is a stronger promise
 * than taking it and dropping it here: with the switch off, core keeps the conversation to
 * itself until somebody has said yes. It needed no new mechanism either, because the runtime
 * binding was always separate from the manifest's declaration for exactly this sort of
 * reason (D73, M6-9).
 *
 * **The gardener has a clock of its own**, and it does not follow the switch. It used to ride
 * this timer, which meant that with capture off a note saved through `remember` as time-bound
 * was never looked at again — the switch is about *the conversation* reaching a model, and
 * the gardener sends none: only a note already written, and only when one is due. So it runs
 * once at start (a plugin is spawned on demand and may never live long enough for a timer)
 * and then every `GARDEN_LOOK`; `garden` itself holds the weekly gate and the *anything due*
 * check, so almost every one of these is a read of the table and nothing else.
 */
const GARDEN_LOOK = 6 * 60 * 60_000
const gardening = () =>
  void garden()
    .catch((error) => log.info(`could not look after old notes: ${String(error)}`))
    // Filing rides the same clock, for the same reason: notes saved with `remember`, and the
    // ones written before the tree existed, get filed with capture off. Nothing unplaced and
    // nothing behind is a read of two tables and no call.
    .then(filing)
    .then(() => nightly())
    .then(syncing)
setInterval(gardening, GARDEN_LOOK).unref?.()

let timer
async function follow() {
  const { capture, interval } = await settings()
  noticed.update({ _meta: { 'alexia/provides': capture === true ? ['memory.capture'] : [] } })
  clearInterval(timer)
  if (capture === true) {
    const minutes = Math.min(240, Math.max(1, Number(interval) || 12))
    timer = setInterval(() => void sortOnce(), minutes * 60_000)
    // Nothing is waiting on it. A timer that holds the process open is a resident plugin
    // that cannot be shut down, which is a different bug from the one it was added for.
    timer.unref?.()
  }
  await report()
}

await alexia.start()
tidied = String((await alexia.storage.get(TIDIED).catch(() => null))?.line ?? '')
// All four are answerable the moment this plugin is running: there is nothing to download
// and no credential to wait for, so those three bindings go on once and stay on. `capture` is
// the exception, and `follow` is why.
kept.update({ _meta: { 'alexia/provides': ['memory.remember'] } })
found.update({ _meta: { 'alexia/provides': ['memory.recall'] } })
known.update({ _meta: { 'alexia/provides': ['memory.profile'] } })
alexia.onSettingsChanged(() => void follow())
await follow()
gardening()
// Last, after every binding is in place: a seed walks the whole table, and nothing else about
// starting up should wait on it. The backfill below is not waited on either. One that fails leaves the marker unwritten and tries again
// next start; it is never a reason for memory not to come up.
await seed().catch((error) => log.info(`could not seed the profile: ${String(error)}`))
void backfill().catch(() => log.info('could not embed what was remembered'))
log.info(`${alexia.manifest.name} is ready`)
