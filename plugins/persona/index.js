// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { budgetLine, costLine } from './cost.js'
import { changed, sizeOf } from './diff.js'
import { check, noteOf, removedOf } from './safety.js'
import {
  brief,
  clean,
  HEAR,
  HEAR_UNASKED,
  HEARD,
  HEARING,
  matchName,
  nameFrom,
  priorOf,
  provenance,
  refining,
  ROOM,
  unasked,
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
 * the document and why, what it will cost, and then the document itself.
 *
 * One function because the two buttons produce the same four things and a person pressing
 * either is owed the same account of it — and because the next one along (Refine, improvement
 * 2) is a third caller that should not have to reassemble this from parts.
 */
const reply = (headline, removed, doc) =>
  [headline, noteOf(removed), costLine(doc), budgetLine(doc), doc]
    .filter((part) => part !== '')
    .join('\n\n')

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
 * **Hear her before she goes live** (improvement 3).
 *
 * Adapt used to save and switch in one press, so the first time anybody heard a new
 * personality was in a real conversation — and on this machine the first time was a 2.6B model
 * answering *who are you* in a stranger's voice, with nothing on screen to say so (D157).
 *
 * **Answered by the model Automatic would use for chat**, which is why this call carries no
 * `modelPreferences`: a sample written by a better model than the one that will actually read
 * her is a sample that lies in the one direction that matters. The pins, the slider and the
 * allowance are the person's own, exactly as in the chat.
 *
 * **It cannot be the whole truth and says so.** Core writes its own opening lines in front of a
 * personality and a plugin cannot see them — that is the invariant, not an omission — so this
 * is her document and this model, and the line above the samples says as much.
 *
 * **Nothing here can lose a document.** The row is already saved when this runs, so a sample
 * that times out, refuses or comes back empty is a sentence about the sample. The automatic
 * checks ran whether or not anybody listens, which is D160's own wording for the Skip.
 */
async function hearing(doc) {
  const line = unasked(doc)
  const asking = [{ ask: HEAR }, ...(line === '' ? [] : [{ ask: HEAR_UNASKED, watching: line }])]
  const heard = []
  for (const one of asking) {
    try {
      const answer = await alexia.server.server.createMessage(
        {
          messages: [{ role: 'user', content: { type: 'text', text: one.ask } }],
          // The document, as the system prompt — which is where core puts it too (D103).
          systemPrompt: doc,
          maxTokens: HEARD,
        },
        { timeout: HEARING },
      )
      const said = answer.content?.type === 'text' ? answer.content.text.trim() : ''
      heard.push({
        ...one,
        model: String(answer.model ?? ''),
        said: said === '' ? '(she said nothing at all, which is itself an answer about this model)' : said,
        cut: answer.stopReason === 'maxTokens',
      })
    } catch (error) {
      log.warn('could not hear her', error)
      heard.push({ ...one, failed: error instanceof Error ? error.message : String(error) })
    }
  }
  return heard
}

/** The samples, written out under a line saying what they are and are not. */
const asHeard = (heard) => {
  if (heard.length === 0) return ''
  const model = heard.find((one) => one.model !== undefined && one.model !== '')?.model
  const lines = [
    model === undefined ?
      'Nothing could be asked, so there is nothing to listen to:'
    : `Here is how she answers, on ${model} — the model your chat would use. Alexia's own opening lines are not in this; only your personality is.`,
  ]
  for (const one of heard) {
    lines.push('', `You: ${one.ask}${one.watching === undefined ? '' : `   (listening for “${one.watching}”)`}`)
    lines.push(one.failed === undefined ? `Her: ${one.said}${one.cut === true ? ' …' : ''}` : `Her: — ${one.failed}`)
  }
  return lines.join('\n')
}

/** What the progress bar says while each button waits, so the three do not read alike. */
const STEPS = {
  adapt: ['Reading what you wrote', 'Writing it'],
  refine: ['Reading her as she is', 'Changing it'],
}

/**
 * The one model call this plugin makes, and the three buttons that make it.
 *
 * Adapt writes a personality that does not exist yet; Re-adapt writes one that does, from the
 * same words it came from the first time; Refine writes one that exists from itself and a
 * sentence. Same rung, same room, same patience, same clamps — all that differs is the brief
 * the caller hands in and which row the answer lands on, so the call lives here instead of
 * three times. Every clamp below is D157's, and it is load-bearing: a personality that saves
 * half-written reads as chosen and behaves as if nothing was set, which is the bug that
 * started the rebuild. Refine is held to them too, because *changed and then truncated* is the
 * same half-a-personality with a different cause.
 */
async function write(ctx, prompt, [reading, writing] = STEPS.adapt) {
  alexia.progress(ctx, 1, 3, reading)
  let answered
  try {
    answered = await alexia.server.server.createMessage({
      // The name goes in rather than coming back: the title is the row's own name, so the
      // document cannot end up called one thing and listed as another (2026-09-18).
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      // Room to think as well as to write. It was 1,200, and a reasoning model spent almost
      // all of it thinking — which is counted and never shown — so the document it did
      // write stopped at `## How` (2026-09-15). Nearly every free model is a reasoning
      // model now, and on a free one the headroom costs nothing.
      maxTokens: ROOM,
      // Writing, not rephrasing — this is the only call this plugin makes, and it makes
      // it once per personality, so it is worth a rung that can actually write. The old
      // node's cheapest-possible preference was right for a task that ran on every answer
      // and wrong for this one.
      //
      // **Read by core since M8-1 (2026-09-19).** It was ignored from the day this line was
      // written, which is how a 5,825-character description came back as a paragraph from a
      // 2.6B model: intelligence first now means strongest-first, never a router — not even
      // a pinned one — and never a model Alexia's own record doubts while another fits. With
      // that is the whole of what this plugin gets to say about the model, and the user's pins,
      // slider and allowance still decide.
      //
      // **The manifest's floor went the other way, and to `T0`.** It said `T1` — never a model
      // on this machine — written while the field was inert, so nobody could see what it meant:
      // in Local mode the pool *is* this machine, so honouring `T1` would have made Adapt a
      // button that cannot be pressed for exactly the people who chose Alexia for privacy. The
      // preference below already prefers the strongest thing reachable, which is the honest way
      // to want a good writer; a floor is a way to refuse everybody who has not got one.
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

  alexia.progress(ctx, 2, 3, writing)
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
 *
 * **It no longer switches by itself** (improvement 3). It saved and switched in one press, so
 * the first anybody heard of a new personality was a real conversation in it. Now it saves the
 * row not in use, asks her two questions, and leaves **Use** as the press that changes how she
 * behaves — so nothing is committed by the thing that wrote it.
 *
 * **And skipping that is one toggle, from the very first time** (D160). *Hear her before
 * switching* off is exactly what this button always did: save, switch, done. The checks that
 * refuse a cut-off or unusable document run either way, which is the half of the Skip that is
 * not optional.
 */
alexia.tool(
  'adapt',
  {
    description:
      'Turn the description in Personality settings into a saved personality. Takes no ' +
      'arguments — it reads the box on the settings screen. It does not switch to it unless ' +
      '*Hear her before switching* is off; Use is what switches.',
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    const { custom_voice: described, save_as: called, hear_first: listen } = await settings()
    const hearFirst = listen !== false
    const description = String(described ?? '').trim()
    if (description === '') {
      return nope('Write a line or two describing how she should be, then press Adapt.')
    }

    // Named before it is written, not after: the brief is given this exact name for the first
    // line, so the saved document and the row it lands in cannot disagree about who she is.
    const existing = await saved()
    const name = unique(
      nameFrom(called, description),
      existing.map((row) => String(row.name)),
    )

    const written = await write(ctx, brief(description, name))
    if (written.error !== undefined) return nope(written.error)

    alexia.progress(ctx, 3, 3, hearFirst ? 'Hearing her' : 'Saving')
    // At most one row is in use. With the toggle on, the new one is not it: nothing about how
    // she behaves changes until somebody presses Use, having read what came back below.
    if (!hearFirst) await alexia.storage.update('personalities', { active: 0 }, { active: 1 })
    await alexia.storage.insert('personalities', {
      name,
      doc: written.doc,
      // The words that produced it, kept beside it: provenance to read, and the input
      // Re-adapt writes from.
      described: description,
      wrote: written.wrote,
      removed: written.removed,
      at: Date.now(),
      active: hearFirst ? 0 : 1,
    })
    await bind()
    const headline =
      hearFirst ?
        `Saved as “${name}”. Nothing has changed yet — press Use on its row to switch to her, or Forget to throw it away.`
      : `Saved as “${name}” and in use from your next message.`
    const heard = hearFirst ? asHeard(await hearing(written.doc)) : ''
    return text([reply(headline, written.removed, written.doc), ...(heard === '' ? [] : ['---', heard])].join('\n\n'))
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
 * Hear her, on any row and at any time.
 *
 * The same two questions Adapt asks, available afterwards — which is what makes this useful
 * past the first press: after Refine, after Edit, after a month on a different model. Refine
 * and Edit deliberately do **not** run it themselves; they already come back with a document
 * and a diff, and two more model calls on every tuning press is the thing that makes people
 * stop tuning. One press away is close enough for a sample; automatic is not free.
 */
alexia.tool(
  'hear',
  {
    description:
      'Ask one saved personality two questions and show how she answers, in her voice, on the ' +
      'model your chat would use. Takes the row it is. Nothing is changed or switched.',
    inputSchema: fromJsonSchema(one),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    const doc = String(row.doc ?? '')
    if (doc === '') return nope(`“${String(row.name)}” has no document to read out.`)
    const heard = await hearing(doc)
    return text(`“${String(row.name)}”, out loud.\n\n${asHeard(heard)}`)
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

    // Its own name, so writing it again does not retitle it — the row keeps the name it has.
    const written = await write(ctx, brief(was.described, String(row.name)))
    if (written.error !== undefined) return nope(written.error)

    alexia.progress(ctx, 3, 3, 'Saving')
    await keep(row, was, written)
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
 * One new version onto a row, with the one it replaces kept.
 *
 * Re-adapt wrote this first and Refine and Edit want the same five lines, which is the whole
 * reason it is a function: *the previous version is kept* is a promise made on the row action's
 * label, and a third copy of it is a third place it could quietly stop being true.
 */
async function keep(row, was, written) {
  await alexia.storage.update(
    'personalities',
    { doc: written.doc, wrote: written.wrote, removed: written.removed, at: Date.now(), previous: was },
    { rowid: Number(row.rowid) },
  )
  await bind()
}

/** What a change did, over the words it did it to — the sentence, then the lines. */
const showing = (was, now) => `What changed (${sizeOf(was, now)}):\n\n${changed(was, now)}`

/**
 * Refine: the same personality, one thing about it different.
 *
 * **Why this is not Re-adapt.** Re-adapt throws the document away and writes it again from the
 * original description, so *more blunt* would mean editing the description and hoping the
 * second draft keeps everything you liked about the first. Refine is the way a person actually
 * talks about this: here is who she is, make her blunter, leave the rest alone.
 *
 * It is also the cheap call. A document is about 500 tokens and the instruction is a sentence;
 * the description Adapt reads was 1,300 on this machine, and it is the one that ran a reasoning
 * model out of room before it had written anything (D157).
 *
 * **The change is shown line by line, and the previous version is kept.** The plan asked for
 * the diff *before* it saves. It saves and then shows it, with Undo as the way back, because
 * this plugin is `lazy` — core may stop it between two presses, and a draft held in memory for
 * a decision nobody has made yet is a draft that is sometimes gone when they make it. A saved
 * version with a kept predecessor is the same promise kept by the storage rather than by the
 * process staying alive.
 */
alexia.tool(
  'refine',
  {
    description:
      'Change one thing about a saved personality, in your own words. Takes the row it is, ' +
      'and reads the sentence in the Refine box on the settings screen. The version it ' +
      'replaces is kept, and Undo brings it back.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }, ctx) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    const { refine_with: asked } = await settings()
    const change = String(asked ?? '').trim()
    if (change === '') {
      return nope('Write what should change — “more blunt”, “stop saying man to man” — then press Refine.')
    }
    const was = versionOf(row)
    if (was.doc === '') return nope(`“${String(row.name)}” has no document to change.`)

    const written = await write(ctx, refining(was.doc, change), STEPS.refine)
    if (written.error !== undefined) return nope(written.error)

    alexia.progress(ctx, 3, 3, 'Saving')
    await keep(row, was, written)
    const using = row.active === 1
    return text(
      [
        reply(
          `Changed “${String(row.name)}”.${using ? ' She is using it from your next message.' : ''}` +
            ' Undo brings the previous one back.',
          written.removed,
          written.doc,
        ),
        '---',
        showing(was.doc, written.doc),
      ].join('\n\n'),
    )
  },
)

/**
 * Edit: the words, by hand, with every check still standing.
 *
 * **Why it is a box on the page and not a field on the row.** A plugin may write exactly one
 * kind of setting — its own `status` — so there is no way for this one to put a document into
 * an editable box for you; and core does not offer `elicitation`, so there is no modal to
 * prefill either. What is left is the honest flow: open the row, which already shows exactly
 * what she is being told, copy it, change it here, press Edit on that row.
 *
 * **The checks are not optional here, and that is the point of routing it through the same
 * two.** A document somebody typed is exactly as able to be half a personality, or to carry a
 * line telling her to skip asking, as one a model wrote — more so, because a person pasting
 * from somewhere else is the import path this plugin does not have yet. `usable` and `check`
 * run on it unchanged (improvement 6, D157).
 */
alexia.tool(
  'edit',
  {
    description:
      'Replace one saved personality with the text in the Edit box on the settings screen. ' +
      'Takes the row it is. The version it replaces is kept, and Undo brings it back.',
    inputSchema: fromJsonSchema(one),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const row = await byId(id)
    if (!row) return nope('There is no saved personality with that id.')
    const { edit_doc: typed } = await settings()
    const written = String(typed ?? '').trim()
    if (written === '') {
      return nope('The Edit box is empty. Open the row, copy what she is being told, change it there, then press Edit.')
    }
    const was = versionOf(row)
    if (written === was.doc) return nope(`That is what “${String(row.name)}” already says.`)

    const { doc, removed } = check(clean(written))
    if (!usable(doc)) {
      return nope(
        removed.length > 0 ?
          'What is left after the lines below were taken out is not a personality, so nothing ' +
            `was saved.\n\n${noteOf(removed)}`
        : 'That is missing one of the four parts of a personality — # a name, then Who you ' +
            'are, How you talk, What you do without being asked, and Hard rules, each with ' +
            'something under it. Nothing was saved.',
      )
    }

    // Written by whoever typed it, and said so: a document with no model behind it should not
    // read as one a model wrote, on a row whose other column is *Written by*.
    await keep(row, was, { doc, wrote: 'you', removed })
    const using = row.active === 1
    return text(
      [
        reply(
          `Saved your own “${String(row.name)}”.${using ? ' She is using it from your next message.' : ''}` +
            ' Undo brings the previous one back.',
          removed,
          doc,
        ),
        '---',
        showing(was.doc, doc),
      ].join('\n\n'),
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
    const trailer = [
      provenance(row),
      noteOf(removedOf(row)),
      costLine(String(row.doc)),
      budgetLine(String(row.doc)),
    ]
      .filter((part) => part !== '')
      .join('\n\n')
    return text(trailer === '' ? String(row.doc) : `${String(row.doc)}\n\n---\n${trailer}`)
  },
)

/**
 * `/persona`, and `/persona <name>` — the same two things the settings screen does, from a
 * phone, where there is no settings screen.
 *
 * **`<name>` arrives under `rest`, which is core's word and not this plugin's** (D177). Core
 * hands over whatever followed the command whole, under that one key for every plugin command
 * alike, and reads none of it. So the name is called `rest` in the schema even though what it
 * holds here is a personality's name: the key belongs to the binding, and the sentence beside
 * it is the only place this plugin gets to say what it wants in there.
 */
alexia.tool(
  'persona',
  {
    description:
      'List every saved personality and say which one is in use. Give a name to switch to ' +
      'that one instead.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { rest: { type: 'string', description: 'Which one to switch to, by name.' } },
      required: [],
    }),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    const rows = await saved()
    const typed = String(args?.rest ?? '').trim()

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
