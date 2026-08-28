// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
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

async function report() {
  const held = await alexia.storage.count('facts')
  await alexia
    .status('state', held === 0 ? '■ Nothing remembered yet' : `● ${held} thing${held === 1 ? '' : 's'} remembered`)
    .catch(() => {})
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
      text: said,
      kind: KINDS.includes(kind) ? kind : 'other',
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
    const rows = await alexia.storage.select('facts', { order: [['at', 'desc']], limit: 2000 })
    const hits = rank(rows, String(about ?? '')).slice(0, Number(limit) || 6)
    if (hits.length === 0) {
      return { content: [{ type: 'text', text: `Nothing was written down about that.` }] }
    }
    const text = hits
      .map((row) => `- ${String(row.text)}  (${new Date(Number(row.at)).toISOString().slice(0, 10)})`)
      .join('\n')
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
    const rows = await alexia.storage.select('facts', { order: [['at', 'desc']], limit: 2000 })
    const hits = rank(rows, String(about ?? ''))
    if (hits.length === 0) return { content: [{ type: 'text', text: 'Nothing remembered matches that.' }] }
    // Only the best match. Deleting everything that vaguely matched is how a request to
    // forget one wrong fact quietly takes six right ones with it.
    const going = hits[0]
    await alexia.storage.delete('facts', { text: String(going.text) })
    await report()
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

alexia.tool(
  'forget_all',
  {
    description: 'Empty long-term memory. The current conversation is not affected. Takes no arguments.',
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async () => {
    const held = await alexia.storage.count('facts')
    await alexia.storage.delete('facts', { all: true })
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

await alexia.start()
// Both are answerable the moment this plugin is running: there is nothing to download and
// no credential to wait for, so the binding goes on once and stays on.
kept.update({ _meta: { 'alexia/provides': ['memory.remember'] } })
found.update({ _meta: { 'alexia/provides': ['memory.recall'] } })
await report()
log.info(`${alexia.manifest.name} is ready`)
