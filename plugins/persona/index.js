// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { check, noteOf, removedOf } from './safety.js'
import {
  brief,
  clean,
  matchName,
  nameFrom,
  priorOf,
  provenance,
  ROOM,
  unique,
  usable,
  versionOf,
  WAIT,
} from './writing.js'

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

/**
 * What Adapt and Re-adapt both say back, in one order: what happened, what was taken out of
 * the document and why, and then the document itself.
 *
 * One function because the two buttons produce the same things and a person pressing either
 * is owed the same account of it — and because the next one along (Refine, improvement 2) is
 * a third caller that should not have to reassemble this from parts.
 */
const reply = (headline, removed, doc) =>
  [headline, noteOf(removed), doc].filter((part) => part !== '').join('\n\n')

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
 * The one model call this plugin makes, and the two buttons that make it.
 *
 * Adapt writes a personality that does not exist yet; Re-adapt writes one that does, from the
 * same words it came from the first time. Same brief, same rung, same clamp — all that differs
 * is which row the answer lands on, so the call lives here instead of twice. Every clamp below
 * is D157's, and it is load-bearing: a personality that saves half-written reads as chosen and
 * behaves as if nothing was set, which is the bug that started the rebuild.
 */
async function write(ctx, description) {
  alexia.progress(ctx, 1, 3, 'Reading what you wrote')
  let answered
  try {
    answered = await alexia.server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: brief(description) } }],
      // Room to think as well as to write. It was 1,200, and a reasoning model spent almost
      // all of it thinking — which is counted and never shown — so the document it did
      // write stopped at `## How` (2026-09-15). Nearly every free model is a reasoning
      // model now, and on a free one the headroom costs nothing.
      maxTokens: ROOM,
      // Writing, not rephrasing — this is the only call this plugin makes, and it makes
      // it once per personality, so it is worth a rung that can actually write. The old
      // node's cheapest-possible preference was right for a task that ran on every answer
      // and wrong for this one.
      modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.3, costPriority: 0.3 },
    }, {
      // The SDK's own default is sixty seconds, and a model thinking before it writes four
      // hundred words takes longer than that — the first press after raising `ROOM` timed
      // out at exactly 60.0s (2026-09-15). Just under core's 120-second ceiling on a
      // button, so a slow model ends in this plugin's sentence rather than a bare timeout.
      timeout: WAIT,
    })
  } catch (error) {
    log.warn('could not adapt', error)
    if (error instanceof Error && /timed out/i.test(error.message)) {
      return { error: 'The model took longer than two minutes, so nothing was saved. Press Adapt again, or pick a faster model.' }
    }
    return { error: `Could not write it: ${error instanceof Error ? error.message : String(error)}` }
  }

  alexia.progress(ctx, 2, 3, 'Writing it')
  // Half a personality is worse than none: it saves, it reads as chosen, and she acts as
  // if nothing was. An Alexia too old to say `maxTokens` still gets caught by `usable`.
  if (answered.stopReason === 'maxTokens') {
    return { error: 'The model ran out of room before it finished, so nothing was saved. Press Adapt again, or pick a different model.' }
  }
  const said = answered.content?.type === 'text' ? answered.content.text : ''
  // Which model wrote it, as core reported it back. Empty when whatever answered did not say.
  const wrote = String(answered.model ?? '')

  // Every document this plugin saves comes through here, so this is the one place the check
  // has to be: Adapt and Re-adapt both land on it, and anything added later (Refine, import)
  // reaches a save the same way.
  const { doc, removed } = check(clean(said))
  if (!usable(doc)) {
    return {
      error:
        removed.length > 0 ?
          'What came back was mostly rules a personality cannot grant, and what was left is ' +
          `not a personality.\n\n${noteOf(removed)}`
        : 'That came back without all four parts of a personality, so nothing was saved. Press Adapt again.',
    }
  }
  return { doc, wrote, removed }
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

    const written = await write(ctx, description)
    if (written.error !== undefined) return nope(written.error)

    const existing = await saved()
    const name = unique(
      nameFrom(called, description),
      existing.map((row) => String(row.name)),
    )
    alexia.progress(ctx, 3, 3, 'Saving')
    // Exactly one is in use, and the one just written is it. Switching is a row action; a
    // person who pressed Adapt has already said which one they want.
    await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await alexia.storage.insert('personalities', {
      name,
      doc: written.doc,
      // The words that produced it, kept beside it: provenance to read, and the input
      // Re-adapt writes from.
      described: description,
      wrote: written.wrote,
      removed: written.removed,
      at: Date.now(),
      active: 1,
    })
    await bind()
    return text(
      reply(`Saved as “${name}” and in use from your next message.`, written.removed, written.doc),
    )
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
          // Blank for everything saved before the writer was recorded, which is every row
          // already on this machine. A blank cell is the honest answer; a guess is not.
          wrote: String(row.wrote ?? ''),
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

/**
 * Re-adapt: the same words, written again.
 *
 * The description is on the row now, so this needs nothing from the settings box — which is
 * the point. A personality adapted six weeks ago on whatever model was reachable that day can
 * be written again today without the person having to remember what they originally typed, or
 * retype it into a box that is now showing something else.
 */
alexia.tool(
  'readapt',
  {
    description:
      'Write one saved personality again from the same description it was adapted from. ' +
      'Takes the row it is. The version it replaces is kept, and Undo brings it back.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }, ctx) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    const was = versionOf(row)
    if (was.described === '') {
      return nope(
        `“${String(row.name)}” was saved before the words that made it were kept, so there is ` +
          'nothing to write it again from. Adapt writes a new one.',
      )
    }

    const written = await write(ctx, was.described)
    if (written.error !== undefined) return nope(written.error)

    alexia.progress(ctx, 3, 3, 'Saving')
    await alexia.storage.update(
      'personalities',
      {
        doc: written.doc,
        wrote: written.wrote,
        removed: written.removed,
        at: Date.now(),
        previous: was,
      },
      { rowid: Number(row.rowid) },
    )
    await bind()
    return text(
      reply(
        `Wrote “${String(row.name)}” again. Undo brings the previous one back.`,
        written.removed,
        written.doc,
      ),
    )
  },
)

/**
 * Undo, and why it swaps rather than pops.
 *
 * One version is kept, so Undo is its own inverse: press it again and you are back where you
 * started. A one-way pop would make *Undo* the button you cannot undo, which is the one thing
 * a person pressing it is worried about.
 */
alexia.tool(
  'undo',
  {
    description:
      'Put back the previous version of one saved personality. Takes the row it is. ' +
      'Pressing it again returns to the version you undid.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    const prior = priorOf(row)
    if (!prior) return nope(`“${String(row.name)}” has only ever had the one version.`)
    await alexia.storage.update(
      'personalities',
      { ...prior, previous: versionOf(row) },
      { rowid: Number(row.rowid) },
    )
    await bind()
    return text(`Put back the previous “${String(row.name)}”. Undo again returns to the other one.`)
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
    const trailer = [provenance(row), noteOf(removedOf(row))]
      .filter((part) => part !== '')
      .join('\n\n')
    return text(trailer === '' ? String(row.doc) : `${String(row.doc)}\n\n---\n${trailer}`)
  },
)

/**
 * `/persona`, and `/persona <name>` — the same two things the settings screen does, from a
 * phone, where there is no settings screen.
 *
 * **`<name>` does not reach here yet, and that is core's half, not this plugin's.**
 * `run()` in `packages/core/src/commands.ts:133` takes the first word of what was typed, and
 * `commandTool()` in `serve.ts:948` calls `process.callTool(tool)` with no arguments at all —
 * there is nowhere on that path to put the rest of the line. So today every `/persona
 * anything` arrives here as a bare list. The argument is declared and handled anyway, so the
 * day core forwards the rest of the line this works without being reopened; until then the
 * list is what a person gets, and it tells them the row action is there.
 */
alexia.tool(
  'persona',
  {
    description:
      'List every saved personality and say which one is in use. Give a name to switch to ' +
      'that one instead.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'Which one to switch to, by name.' } },
      required: [],
    }),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    const rows = await saved()
    const typed = String(args?.name ?? '').trim()

    if (typed === '') {
      if (rows.length === 0) return text('Nothing written yet. Write one on the Personality screen.')
      const list = rows
        .map((row) => `${row.active === 1 ? '● ' : '○ '}${String(row.name)}`)
        .join('\n')
      return text(`${list}\n\n/persona <name> switches. /plainly stops using any of them.`)
    }

    const found = matchName(rows, typed)
    if (found.among) {
      return nope(`“${typed}” could be ${found.among.join(' or ')}. Say more of the name.`)
    }
    if (!found.row) return nope(`There is no personality called “${typed}”.`)
    await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await alexia.storage.update('personalities', { active: 1 }, { rowid: Number(found.row.rowid) })
    await bind()
    return text(`Using “${String(found.row.name)}” from your next message.`)
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
