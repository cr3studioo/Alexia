// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { day, line, mark, overdue, STATES } from './ledger.js'

/**
 * Commitments — the accountability ledger (M6-8).
 *
 * **This is `plugins/hello`'s job, at the level of a screen.** Hello proves the wire carries
 * anything; this proves the control surface does. Everything else in M6 attaches to something
 * core already ships, which means any of it could have been quietly special-cased and still
 * passed. This one cannot: it was written after the panel mechanism, from the documents, and
 * core has never seen the word `commitments` anywhere.
 *
 * What it is, from the predecessor: an append-only record of things you said you would do,
 * with the one field that makes it more than a to-do list — **whether you imposed it on
 * yourself**, which is the difference between being reminded and being nagged.
 *
 * **The panel is read-only, on purpose.** The assistant records a commitment during a
 * conversation, where the sentence was actually said; a second write path from a table would
 * be a parallel mechanism into a record whose whole value is that it only ever grows.
 */

const alexia = plugin()

const today = () => new Date().toISOString().slice(0, 10)

/** Everything, newest first. It is a few hundred short rows and it is read whole. */
const all = () => alexia.storage.select('promises', { order: [['at', 'desc']], limit: 2000 })

/** The one line at the top of the settings pane: how much is outstanding. */
async function report() {
  const rows = await all()
  const open = rows.filter((row) => row.state === 'open')
  const late = open.filter((row) => overdue(row, today())).length
  await alexia
    .status(
      'standing',
      open.length === 0 ? '■ Nothing outstanding'
      : late > 0 ? `▲ ${open.length} open, ${late} overdue`
      : `● ${open.length} open`,
    )
    .catch(() => {})
}

alexia.tool(
  'commit',
  {
    description:
      'Write down something the user has said they will do, so it is not lost when this ' +
      'conversation is. Use when they commit to something — "I will send that by Friday", ' +
      '"remind me to call the bank". One commitment per call, in their own words.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'What they said they would do, as a sentence that still makes sense in a month.',
        },
        by: { type: 'string', description: 'The day it is due, as YYYY-MM-DD. Omit if they did not say one.' },
        mine: {
          type: 'boolean',
          description:
            'True when they imposed it on themselves, false when somebody else asked it of them. Defaults to true.',
        },
      },
      required: ['text'],
    }),
    // It appends. Nothing is overwritten and nothing is lost, which is what keeps the default
    // mode from treating writing down a promise like deleting a file.
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text, by, mine = true }) => {
    const said = String(text ?? '').trim()
    if (said === '') return { isError: true, content: [{ type: 'text', text: 'There was nothing to write down.' }] }
    const when = day(by)
    // Said and not understood is worth saying out loud: a date this plugin quietly dropped is
    // a commitment that will never be called overdue, and nobody would know why.
    const note = by !== undefined && when === undefined ? ` I did not understand “${String(by)}” as a date, so it has no day.` : ''
    await alexia.storage.insert('promises', {
      text: said,
      ...(when !== undefined && { by: when }),
      mine: mine === false ? 0 : 1,
      state: 'open',
      nudges: 0,
      at: Date.now(),
    })
    await report()
    return { content: [{ type: 'text', text: `Written down: ${said}.${note}` }] }
  },
)

alexia.tool(
  'promised',
  {
    description:
      'What the user still owes, newest first — everything open, and which of it is past its day. ' +
      'Use at the start of a conversation about what they have to do, or when they ask what they promised. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const now = today()
    const open = (await all()).filter((row) => row.state === 'open')
    if (open.length === 0) return { content: [{ type: 'text', text: 'Nothing outstanding.' }] }
    return { content: [{ type: 'text', text: open.map((row) => `- ${line(row, now)}`).join('\n') }] }
  },
)

alexia.tool(
  'close_commitment',
  {
    description:
      'Mark one commitment as kept or dropped. Use when the user says they have done it, or that it is no longer ' +
      'happening. Takes the commitment’s id, which `promises` and the panel both show.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Which commitment.' },
        kept: { type: 'boolean', description: 'True if they did it, false if it is no longer happening.' },
      },
      required: ['id', 'kept'],
    }),
    // It closes a row rather than removing one — the record only ever grows — so it is not
    // destructive, and the gate is not asked to treat it as though it were.
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, kept }) => {
    const rowid = Number(id)
    const [row] = await alexia.storage.select('promises', { where: { rowid }, limit: 1 })
    if (!row) return { isError: true, content: [{ type: 'text', text: 'There is no commitment with that id.' }] }
    if (row.state !== 'open') {
      return { content: [{ type: 'text', text: `That one is already ${String(row.state)}.` }] }
    }
    await alexia.storage.update('promises', { state: kept === false ? 'dropped' : 'kept' }, { rowid })
    await report()
    return {
      content: [{ type: 'text', text: `${kept === false ? 'Dropped' : 'Kept'}: ${String(row.text)}` }],
    }
  },
)

alexia.tool(
  'nudge',
  {
    description:
      'Record that you have raised a commitment with the user. Call it when you bring one up, so the ledger knows ' +
      'how many times it has been mentioned. Takes the commitment’s id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which commitment.' } },
      required: ['id'],
    }),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const rowid = Number(id)
    const [row] = await alexia.storage.select('promises', { where: { rowid }, limit: 1 })
    if (!row) return { isError: true, content: [{ type: 'text', text: 'There is no commitment with that id.' }] }
    const nudges = Number(row.nudges ?? 0) + 1
    await alexia.storage.update('promises', { nudges }, { rowid })
    // Counted rather than hidden: *this is the fourth time* is the thing that makes raising
    // it again either fair or unkind, and it is the person's call which.
    return { content: [{ type: 'text', text: `Noted — that is ${nudges} time${nudges === 1 ? '' : 's'}.` }] }
  },
)

/**
 * The panel's rows (M6-8), and the panel is the only thing that reads them this way.
 *
 * A tool rather than a special route, because that is the whole contract: core asks a plugin
 * for a list the same way whoever wrote this plugin asks for anything else.
 */
alexia.tool(
  'ledger',
  {
    description: 'List every commitment, open and closed, with its state and how often it has been raised. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const now = today()
    const rows = (await all()).map((row) => ({
      id: String(row.rowid),
      text: String(row.text),
      by: typeof row.by === 'string' && row.by !== '' ? row.by : '—',
      // The field that makes this more than a to-do list.
      whose: row.mine === 1 ? 'yours' : 'asked of you',
      state: mark(row, now),
      // A closed commitment is grouped away from an open one, which is the only sorting
      // anybody wants here.
      group: row.state === 'open' ? (overdue(row, now) ? 'Overdue' : 'Open') : 'Closed',
      nudges: Number(row.nudges ?? 0),
    }))
    return { content: [{ type: 'text', text: `${rows.length} commitments` }], structuredContent: { rows } }
  },
)

alexia.tool(
  'about_commitment',
  {
    description: 'Everything about one commitment. Takes its id.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string', description: 'Which commitment.' } },
      required: ['id'],
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const [row] = await alexia.storage.select('promises', { where: { rowid: Number(id) }, limit: 1 })
    if (!row) return { isError: true, content: [{ type: 'text', text: 'There is no commitment with that id.' }] }
    const written = new Date(Number(row.at)).toISOString().slice(0, 10)
    return {
      content: [
        {
          type: 'text',
          text: `${line(row, today())}\n\nWritten down ${written}. It is ${STATES.includes(String(row.state)) ? String(row.state) : 'open'}.`,
        },
      ],
    }
  },
)

await alexia.start()
await report()
log.info(`${alexia.manifest.name} is ready`)
