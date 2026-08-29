// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { BATCH, parse, plan, prompt, TRIES } from './capture.js'
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

async function report() {
  const held = await alexia.storage.count('facts')
  const { capture } = await settings()
  const waiting = capture === true ? await alexia.storage.count('buffer') : 0
  const remembers =
    held === 0 ? '■ Nothing remembered yet' : `● ${held} thing${held === 1 ? '' : 's'} remembered`
  const noticing =
    capture === true ?
      waiting === 0 ? ', writing things down by itself'
      : `, ${waiting} exchange${waiting === 1 ? '' : 's'} waiting to be sorted`
    : ', only what it is told to'
  await alexia.status('state', `${remembers}${noticing}`).catch(() => {})
}

/** Every note, newest first. It is hundreds of short rows — see the ceiling in `search.js`. */
const notes = () => alexia.storage.select('facts', { order: [['at', 'desc']], limit: 2000 })

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
  // The buffer first, so nothing comes back on the next tick. Word overlap rather than an
  // exact match, because what is buffered is the exchange and what is forgotten is a fact
  // somewhere inside it.
  const waiting = await alexia.storage.select('buffer', { limit: 2000 })
  const doomed = rank(waiting, asked === '' ? String(going?.text ?? '') : asked)
  for (const row of doomed) await alexia.storage.delete('buffer', { rowid: Number(row.rowid) })

  let removed = 0
  if (going) {
    await alexia.storage.delete('facts', { rowid: Number(going.rowid) })
    removed = 1
    // A link pointing at something that is gone is a link that reads as a missing note.
    // Cheaper to mend now than to explain later.
    const name = nameOf(going)
    for (const row of await notes()) {
      const links = linksOf(row)
      if (!links.includes(name)) continue
      await alexia.storage.update('facts', { links: JSON.stringify(links.filter((l) => l !== name)) }, { rowid: Number(row.rowid) })
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
      },
      required: ['text'],
    }),
    // It writes, so it is not read-only. It is not *destructive* either — nothing is
    // overwritten and nothing is lost — and saying so is what keeps the default mode from
    // treating remembering a preference like deleting a file.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text, kind }) => {
    const said = String(text ?? '').trim()
    if (said === '') return { isError: true, content: [{ type: 'text', text: 'There was nothing to remember.' }] }
    // Said before, near enough. Remembering the same sentence four times is how recall
    // fills up with one fact and returns nothing else.
    const already = await alexia.storage.select('facts', { where: { text: said }, limit: 1 })
    if (already.length > 0) {
      return { content: [{ type: 'text', text: 'Already remembered, so nothing changed.' }] }
    }
    await alexia.storage.insert('facts', {
      // Its own name, so something else can link to it. A whole sentence is a poor name and
      // a truncated one is worse, so this is the first clause and it is enough.
      name: said.split(/[,.;:]/)[0].slice(0, 60).trim() || said.slice(0, 60),
      text: said,
      kind: KINDS.includes(kind) ? kind : 'other',
      links: '[]',
      // Somebody said this out loud. That is a different kind of true from something worked
      // out on a timer, and recall says which one it is reading back.
      source: STATED,
      at: Date.now(),
    })
    await report()
    return { content: [{ type: 'text', text: `Remembered: ${said}` }] }
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
    const rows = await notes()
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
    // guess back as fact is the failure automatic capture makes possible.
    const line = (row, why) =>
      `- ${String(row.text)}  (${new Date(Number(row.at)).toISOString().slice(0, 10)}${row.source === INFERRED ? ', worked out rather than said' : ''}${why})`
    const text = [...hits.map((row) => line(row, '')), ...linked.map((row) => line(row, ', linked'))].join('\n')
    return { content: [{ type: 'text', text }] }
  },
)

alexia.tool(
  'forget',
  {
    description:
      'Forget one remembered thing, by the words in it. Use when the user says something is ' +
      'wrong or out of date, or asks to be forgotten about something.',
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
    const hits = rank(await notes(), String(about ?? ''))
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
    const rows = await alexia.storage.select('facts', { order: [['at', 'desc']], limit: 50 })
    const text =
      rows.length === 0 ?
        'Nothing has been remembered yet. Things get written down when you say something worth keeping.'
      : rows.map((row) => `- ${String(row.text)}  (${new Date(Number(row.at)).toISOString().slice(0, 10)})`).join('\n')
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
    const rows = await notes()
    return {
      content: [{ type: 'text', text: `${rows.length} remembered` }],
      structuredContent: {
        rows: rows.map((row) => ({
          // The rowid, which is what makes forgetting one of them unambiguous.
          id: String(row.rowid),
          text: String(row.text),
          kind: String(row.kind ?? 'other'),
          // The column automatic capture makes necessary: *you said this* and *it worked
          // this out* are different kinds of true, and the second is the one worth checking.
          from: row.source === INFERRED ? 'Alexia noticed it' : 'you said it',
          when: new Date(Number(row.at)).toISOString().slice(0, 10),
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
    const [row] = await alexia.storage.select('facts', { where: { rowid: Number(id) }, limit: 1 })
    if (!row) return { isError: true, content: [{ type: 'text', text: 'That one is already gone.' }] }
    // The sentence as it was written down, uncut. A column has to truncate; this does not,
    // and the whole of a remembered thing is the thing worth reading before deleting it.
    const links = linksOf(row)
    return {
      content: [
        {
          type: 'text',
          text: [
            String(row.text),
            '',
            `Written down ${new Date(Number(row.at)).toISOString().slice(0, 10)}, as ${String(row.kind ?? 'other')}.`,
            row.source === INFERRED ?
              'Alexia worked this out from something you said rather than being told it.'
            : 'You said this.',
            // What it hangs off, by name. The reason a person can tell a note that belongs
            // somewhere from one that is floating on its own.
            ...(links.length === 0 ? [] : [`Filed under: ${links.join(', ')}.`]),
          ].join('\n'),
        },
      ],
    }
  },
)

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

  const held = await notes()
  let said
  try {
    const answer = await alexia.server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt(waiting, held.map(nameOf)) } }],
      systemPrompt: 'You write short notes about a person from what they said. Answer with JSON only.',
      maxTokens: 1200,
    })
    said = answer.content?.type === 'text' ? answer.content.text : ''
  } catch (error) {
    // No model reachable — on this path that also means no *free* model reachable, since a
    // plugin on its own clock never spends (G12). The rows keep their turn.
    return await failed(waiting, error instanceof Error ? error.message : String(error))
  }

  const candidates = parse(said)
  if (candidates === null) return await failed(waiting, 'the answer was not JSON')

  // The judgement, decided without a database in front of it — the duplicate overrule and
  // the link filtering both live in `capture.js`, where they can be argued with.
  const write = plan(candidates, held)
  for (const one of write) {
    const rowid = await alexia.storage.insert('facts', {
      name: one.name,
      text: one.text,
      kind: KINDS.includes(one.kind) ? one.kind : 'other',
      links: JSON.stringify(one.links),
      // Nobody asked for this one. Recall says so when it reads it back.
      source: INFERRED,
      at: Date.now(),
    })
    // The link goes on both, which is what lets one note sit under two parents with no new
    // machinery: one canonical note, one name appended to each of them.
    for (const name of one.links) {
      const parent = held.find((row) => nameOf(row) === name)
      if (!parent) continue
      const now = linksOf(parent)
      if (now.includes(one.name)) continue
      parent.links = JSON.stringify([...now, one.name])
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
    const done = await tick()
    return {
      content: [
        {
          type: 'text',
          text:
            done.why !== undefined ? done.why
            : `Read ${done.read} exchange${done.read === 1 ? '' : 's'} and wrote ${done.written} note${done.written === 1 ? '' : 's'}.`,
        },
      ],
    }
  },
)

/**
 * The binding, and it is where the consent lives (D73, M6-9).
 *
 * The capability is bound on the tool **only while the setting is on**, so with capture off
 * core resolves nothing and never hands the exchange over at all. That is a stronger promise
 * than taking it and dropping it here: with the switch off, core keeps the conversation to
 * itself until somebody has said yes. It needed no new mechanism either, because the runtime
 * binding was always separate from the manifest's declaration for exactly this sort of
 * reason (D73, M6-9).
 */
let timer
async function follow() {
  const { capture, interval } = await settings()
  noticed.update({ _meta: { 'alexia/provides': capture === true ? ['memory.capture'] : [] } })
  clearInterval(timer)
  if (capture === true) {
    const minutes = Math.min(240, Math.max(1, Number(interval) || 12))
    timer = setInterval(() => void tick().catch((error) => log.info(String(error))), minutes * 60_000)
    // Nothing is waiting on it. A timer that holds the process open is a resident plugin
    // that cannot be shut down, which is a different bug from the one it was added for.
    timer.unref?.()
  }
  await report()
}

await alexia.start()
// All three are answerable the moment this plugin is running: there is nothing to download
// and no credential to wait for, so those two bindings go on once and stay on. `capture` is
// the exception, and `follow` is why.
kept.update({ _meta: { 'alexia/provides': ['memory.remember'] } })
found.update({ _meta: { 'alexia/provides': ['memory.recall'] } })
alexia.onSettingsChanged(() => void follow())
await follow()
log.info(`${alexia.manifest.name} is ready`)
