// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { BATCH, parse, plan, prompt, TRIES } from './capture.js'
import {
  chain,
  due,
  GARDEN_EVERY,
  GARDEN_MOST,
  relative,
  REVIEW_AFTER,
  rewrite,
  rewritePrompt,
  stale,
  timeBound,
  valid,
  when,
} from './garden.js'
import { distinct, pinnedOf, profile, seedable } from './profile.js'
import { rank } from './search.js'

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

async function report() {
  const live = await current()
  const held = live.length
  const doubtful = live.filter(stale).length
  const { capture } = await settings()
  const waiting = capture === true ? await alexia.storage.count('buffer') : 0
  const remembers =
    held === 0 ? '■ Nothing remembered yet' : `● ${held} thing${held === 1 ? '' : 's'} remembered`
  const noticing =
    capture === true ?
      waiting === 0 ? ', writing things down by itself'
      : `, ${waiting} exchange${waiting === 1 ? '' : 's'} waiting to be sorted`
    : ', only what it is told to'
  // Kept in the profile and in recall, marked there; counted here so it is seen without asking.
  const checking = doubtful === 0 ? '' : `, ${doubtful} note${doubtful === 1 ? '' : 's'} may be out of date`
  await alexia.status('state', `${remembers}${noticing}${checking}`).catch(() => {})
}

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
 * Close `old` because `rowid` says what it said, better or later. Invalidate, never delete: the
 * old version is what `history` reads, and a wrong replacement stays one person's click from
 * undone rather than gone. Its pin goes to the new note (the caller writes that one), because
 * the profile should say the new thing and not stop saying anything.
 */
async function supersede(old, rowid, now) {
  await alexia.storage.update(
    'facts',
    { invalid_at: now, replaced_by: rowid, ...(pinnedOf(old) ? { pinned: false } : {}) },
    { rowid: Number(old.rowid) },
  )
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
      },
      required: ['text'],
    }),
    // It writes, so it is not read-only. It is not *destructive* either — nothing is
    // overwritten and nothing is lost, a replaced note included — and saying so is what keeps
    // the default mode from treating remembering a preference like deleting a file.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text, kind, pin, replaces, time_bound: bound }) => {
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
      // Only when asked. A key left off is a column left null, which reads as not pinned.
      ...(pinning ? { pinned: true } : {}),
      ...(bound === true ? { time_bound: true, review_at: now + REVIEW_AFTER } : {}),
      at: now,
      valid_from: now,
    })
    if (old) await supersede(old, rowid, now)
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
      '— a name, a preference, a decision, "the usual". Returns nothing when nothing matches, ' +
      'which means it was never written down rather than that it does not exist.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        about: { type: 'string', description: 'What to look for. Words from the question are enough.' },
      },
      required: ['about'],
    }),
    // Reading what is already stored changes nothing, which is what lets the default mode
    // run it without asking — and recall that stopped to ask permission every time would
    // be recall nobody left switched on.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ about }) => {
    const { recall_limit: limit } = await settings()
    // The whole table, ranked here. It is hundreds of short rows; the day it is not, the
    // ceiling named in search.js is the thing to raise.
    // Only what is still true. A replaced version is history, and history is `history`.
    const rows = await current()
    const hits = rank(rows, String(about ?? '')).slice(0, Number(limit) || 6)
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
    const line = (row, why) =>
      `- ${String(row.text)}  (${day(row.at)}${row.source === INFERRED ? ', worked out rather than said' : ''}${stale(row) ? ', may be out of date' : ''}${why})`
    const text = [...hits.map((row) => line(row, '')), ...linked.map((row) => line(row, ', linked'))].join('\n')
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
              `- ${String(row.text)}  (${day(row.at)}${pinnedOf(row) ? ', always known' : ''}${stale(row) ? ', may be out of date' : ''}; id ${String(row.rowid)})`,
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
          from: row.source === INFERRED ? 'Alexia noticed it' : 'you said it',
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
const tagsOf = (row) =>
  !valid(row) ? [{ says: GONE, tone: 'quiet' }]
  : [
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
      'Alexia itself before each task. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => ({ content: [{ type: 'text', text: profile(await current()) }] }),
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
      },
      required: ['said'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ said, answered, at }) => {
    const text = `They said: ${String(said ?? '').trim()}\nAlexia answered: ${String(answered ?? '').trim()}`
    await alexia.storage.insert('buffer', { text, tries: 0, at: Number(at) || Date.now() })
    await report()
    return { content: [{ type: 'text', text: 'kept' }] }
  },
)

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
    return await failed(waiting, error instanceof Error ? error.message : String(error))
  }

  const candidates = parse(said)
  if (candidates === null) return await failed(waiting, 'the answer was not JSON')

  // The judgement, decided without a database in front of it — the duplicate and replace
  // overrules, the pinned-note protection and the link filtering all live in `capture.js`,
  // where they can be argued with.
  const write = plan(candidates, held, now)
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
      // Never `pinned` — see the end of capture.js. The model's opinion is kept as a
      // suggestion for a person to act on, and only when it had one. The same for replacing
      // a pinned note: `suggest_replaces`, and the pinned one stays as it is.
      ...(one.suggestPin ? { suggest_pin: true } : {}),
      ...(one.suggestReplaces !== undefined ? { suggest_replaces: one.suggestReplaces } : {}),
      ...(one.timeBound ? { time_bound: true, review_at: one.reviewAt } : {}),
      at: now,
      valid_from: now,
    })
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

  for (const row of waiting) await alexia.storage.delete('buffer', { rowid: Number(row.rowid) })
  await report()
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
        ...(timeBound(note) ? { time_bound: true } : {}),
        ...doubt,
        ...(pinned ? { suggest_replaces: Number(note.rowid) } : {}),
        at: now,
        valid_from: now,
      })
      rewritten += 1
      if (!pinned) {
        await supersede(note, rowid, now)
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
    const { done, looked } = await pass()
    // The gardener is only mentioned when it did something; it is quiet on almost every pass.
    const tended =
      looked?.due === undefined ? ''
      : ` Checked ${looked.due} note${looked.due === 1 ? '' : 's'} that may have changed: rewrote ${looked.rewritten}, marked ${looked.marked} as may be out of date.`
    return {
      content: [
        {
          type: 'text',
          text:
            (done.why !== undefined ? done.why
            : `Read ${done.read} exchange${done.read === 1 ? '' : 's'} and wrote ${done.written} note${done.written === 1 ? '' : 's'}.`) + tended,
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
  return { done, looked }
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
 * The gardener rides the same timer, so it too only runs while that switch is on: it is the
 * other half of Alexia looking at memory by itself, and the switch is where that was agreed to.
 * `sort_now` runs it as well, because a button press is somebody asking.
 */
let timer
async function follow() {
  const { capture, interval } = await settings()
  noticed.update({ _meta: { 'alexia/provides': capture === true ? ['memory.capture'] : [] } })
  clearInterval(timer)
  if (capture === true) {
    const minutes = Math.min(240, Math.max(1, Number(interval) || 12))
    timer = setInterval(() => void pass().catch((error) => log.info(String(error))), minutes * 60_000)
    // Nothing is waiting on it. A timer that holds the process open is a resident plugin
    // that cannot be shut down, which is a different bug from the one it was added for.
    timer.unref?.()
  }
  await report()
}

await alexia.start()
// All four are answerable the moment this plugin is running: there is nothing to download
// and no credential to wait for, so those three bindings go on once and stay on. `capture` is
// the exception, and `follow` is why.
kept.update({ _meta: { 'alexia/provides': ['memory.remember'] } })
found.update({ _meta: { 'alexia/provides': ['memory.recall'] } })
known.update({ _meta: { 'alexia/provides': ['memory.profile'] } })
alexia.onSettingsChanged(() => void follow())
await follow()
// Last, after every binding is in place: a seed walks the whole table, and nothing else about
// starting up should wait on it. One that fails leaves the marker unwritten and tries again
// next start; it is never a reason for memory not to come up.
await seed().catch((error) => log.info(`could not seed the profile: ${String(error)}`))
log.info(`${alexia.manifest.name} is ready`)
