// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { brief, clean, nameFrom, unique, usable } from './writing.js'

/**
 * The personality node (M4-4, revised 2026-08-29).
 *
 * **It used to rewrite the finished answer, and that was the wrong end of the pipe.** The
 * evidence was a real personality somebody wrote: a page of chief-of-staff instructions —
 * *raise the dates he set himself*, *ask before anything with external consequence*, *say
 * so when he opens something new while something else is stalled* — handed to a node whose
 * only input is one completed paragraph and whose instruction is *change the wording,
 * never the content*. Every behavioural line in it was inert by construction, and the
 * rewrite's own clamp made the honest answer *return it unchanged*, which is what it did.
 *
 * So a personality is now a **standing instruction**: core reads it once per task and
 * appends it to the system prompt, in front of the decisions it is about. Three things
 * fall out of that, all of them good — behaviour rules work, streaming comes back, and the
 * second model call per answer is gone.
 *
 * What is left here is a library: write what you want in your own words, press Adapt, and
 * a model turns it into the document. Switching is a row action, and nothing outside this
 * folder knows any of these names — core asks for `persona.personality` and is handed a
 * paragraph.
 */

const alexia = plugin()

const settings = () => alexia.settings()

/** Every saved personality, newest first. */
const saved = () => alexia.storage.select('personalities', { order: [['at', 'desc']] })

/** The one in use, if any. At most one row has `active`, and `use` is what keeps that true. */
const active = async () =>
  (await alexia.storage.select('personalities', { where: { active: 1 }, limit: 1 }))[0]

const text = (said) => ({ content: [{ type: 'text', text: said }] })
const nope = (said) => ({ isError: true, content: [{ type: 'text', text: said }] })

async function report() {
  const using = await active()
  const count = (await saved()).length
  const state =
    using ? `● ${String(using.name)}`
    : count > 0 ? '■ Speaking plainly — none of them in use'
    : '■ Nothing written yet'
  await alexia.status('state', state).catch(() => {})
}

/**
 * The capability, and the reason it is a tool rather than a setting core could read.
 *
 * Core asks for `persona.personality` and is handed a paragraph. It does not learn that a
 * plugin called persona exists, that there is a list of them, or which one this is — which
 * is the invariant. Delete the folder and core's own lookup comes back empty and Alexia
 * speaks with the four lines she was born with.
 */
const standing = alexia.tool(
  'personality',
  {
    description:
      'The standing instruction Alexia is currently running with, or nothing when none is ' +
      'chosen. Alexia reads this herself at the start of a task; there is no reason for a ' +
      'model to call it.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => text(String((await active())?.doc ?? '')),
)

/**
 * Adapt (the button), and the whole of what it is for.
 *
 * Somebody who knows how they want to be spoken to should not also have to know how to
 * write a system prompt. They type the four words they actually mean, and a model turns it
 * into the document — once, at the moment they ask, on a rung that can write.
 */
alexia.tool(
  'adapt',
  {
    description:
      'Turn the description in Personality settings into a saved personality and start ' +
      'using it. Takes no arguments — it reads the box on the settings screen.',
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    const { custom_voice: described, save_as: called } = await settings()
    const description = String(described ?? '').trim()
    if (description === '') {
      return nope('Write a line or two describing how she should be, then press Adapt.')
    }

    alexia.progress(ctx, 1, 3, 'Reading what you wrote')
    let said
    try {
      const answered = await alexia.server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: brief(description) } }],
        maxTokens: 1200,
        // Writing, not rephrasing — this is the only call this plugin makes, and it makes
        // it once per personality, so it is worth a rung that can actually write. The old
        // node's cheapest-possible preference was right for a task that ran on every answer
        // and wrong for this one.
        modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.3, costPriority: 0.3 },
      })
      alexia.progress(ctx, 2, 3, 'Writing it')
      said = answered.content?.type === 'text' ? answered.content.text : ''
    } catch (error) {
      log.warn('could not adapt', error)
      return nope(`Could not write it: ${error instanceof Error ? error.message : String(error)}`)
    }

    const doc = clean(said)
    if (!usable(doc)) {
      return nope('That came back as something other than a personality. Try describing her again.')
    }

    const existing = await saved()
    const name = unique(
      nameFrom(called, description),
      existing.map((row) => String(row.name)),
    )
    alexia.progress(ctx, 3, 3, 'Saving')
    // Exactly one is in use, and the one just written is it. Switching is a row action; a
    // person who pressed Adapt has already said which one they want.
    await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await alexia.storage.insert('personalities', { name, doc, at: Date.now(), active: 1 })
    await bind()
    return text(`Saved as “${name}” and in use from your next message.\n\n${doc}`)
  },
)

alexia.tool(
  'personalities',
  {
    description: 'List every saved personality and say which one is in use. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const rows = await saved()
    return {
      ...text(rows.length === 0 ? 'Nothing written yet' : `${rows.length} saved`),
      structuredContent: {
        rows: rows.map((row) => ({
          id: String(row.rowid),
          name: String(row.name),
          using: row.active === 1 ? 'in use' : '',
          written: new Date(Number(row.at)).toISOString().slice(0, 10),
        })),
      },
    }
  },
)

const byId = async (id) => {
  const rowid = Number(id)
  if (!Number.isInteger(rowid)) return undefined
  return (await alexia.storage.select('personalities', { where: { rowid }, limit: 1 }))[0]
}

const one = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Which saved personality.' } },
  required: ['id'],
}

alexia.tool(
  'use',
  {
    description:
      'Start using one saved personality. Takes the row it is, and takes effect on the next thing said.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await alexia.storage.update('personalities', { active: 1 }, { rowid: Number(row.rowid) })
    await bind()
    return text(`Using “${String(row.name)}” from your next message.`)
  },
)

alexia.tool(
  'plainly',
  {
    description: 'Stop using any personality. Nothing is deleted — Alexia goes back to her own voice.',
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async () => {
    await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await bind()
    return text('Speaking plainly. All of them are still saved.')
  },
)

alexia.tool(
  'forget',
  {
    description: 'Delete one saved personality for good. Takes the row it is.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    await alexia.storage.delete('personalities', { rowid: Number(row.rowid) })
    await bind()
    return text(`“${String(row.name)}” is gone.`)
  },
)

alexia.tool(
  'about_personality',
  {
    description:
      'The full text of one saved personality — exactly what Alexia is told. Takes the row it is.',
    inputSchema: fromJsonSchema(one),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    return text(String(row.doc))
  },
)

/**
 * The binding, and why it is a binding rather than a branch.
 *
 * With nothing in use this capability is **not provided at all**, so core's own lookup
 * comes back empty and it never makes the call. A plugin that answered with an empty
 * string would still have cost a spawn and a round trip to say nothing.
 */
async function bind() {
  const using = await active()
  standing.update({ _meta: using ? { 'alexia/provides': ['persona.personality'] } : {} })
  await report()
}

await alexia.start()
await bind()
// Adapt, Use, Forget and Speak plainly all call `bind()` themselves. This is for the
// settings screen, where the description can be edited without anything else happening.
alexia.onSettingsChanged(() => void report())
log.info(`${alexia.manifest.name} is ready`)
