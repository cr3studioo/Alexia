// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'

/**
 * The personality node (M4-4).
 *
 * **What is not here is the design.** Core sends conversational output through this and
 * nothing else — not a permission request, not an alert, not a mode switch, not code, not
 * an action. That exclusion list is enforced on the other side of the wire, in core's own
 * loop, because a permission prompt rewritten in a jaunty voice is a permission prompt
 * somebody misreads, and the place to make that impossible is the place that decides what
 * to send rather than the place that answers.
 *
 * What is left for this plugin is a narrow, closed task: same facts, different words. So
 * it runs on the cheapest rung that can do it (`min_tier: T0`) — the same reason the safety
 * checker does — and the default voice unbinds the capability entirely, which means core
 * skips the call rather than making one that changes nothing.
 */

const alexia = plugin()

/**
 * The instruction, per voice.
 *
 * Every one of them ends with the same two sentences, and they are the ones doing the
 * work: **change the wording, never the content**, and *if you cannot, return it
 * unchanged*. A model told only "be warm" will helpfully add a fact.
 */
const VOICES = {
  warm: 'Warm and encouraging. Friendly, never saccharine, never over-familiar.',
  brief: 'As short as it can be and still complete. Cut hedging and preamble. Prefer plain words.',
  dry: 'Understated and dry. Wry where it fits naturally, never at the expense of clarity.',
  formal: 'Formal and precise. Complete sentences, no contractions, no exclamation marks.',
}

const RULES = [
  'Rewrite the text below in that voice.',
  'Change only the wording. Do not add, remove, correct or reinterpret anything it says.',
  'Keep every number, name, path, command, quotation and code block exactly as written.',
  'Keep the same structure — the same paragraphs, lists and line breaks.',
  'If the text cannot be rewritten without changing what it says, return it exactly as it is.',
  'Reply with the rewritten text and nothing else. No preamble, no quotation marks around it.',
].join(' ')

const settings = () => alexia.settings()

/** The chosen voice as an instruction, or nothing when the default is chosen. */
async function chosen() {
  const { voice, custom_voice: own } = await settings()
  if (voice === 'custom') {
    const said = String(own ?? '').trim()
    return said === '' ? undefined : said
  }
  return VOICES[voice]
}

async function report() {
  const style = await chosen()
  const { voice } = await settings()
  const state =
    style === undefined ?
      voice === 'custom' ?
        '▲ Custom chosen, but no description written'
      : '■ Alexia’s own voice — no extra model call'
    : `● ${String(voice)}`
  await alexia.status('state', state).catch(() => {})
}

const restyle = alexia.tool(
  'rephrase',
  {
    description:
      'Rewrite one answer in the personality the user chose. Changes wording only, never ' +
      'content. Alexia calls this itself for conversational answers; there is no reason for ' +
      'a model to call it directly.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'The answer to rewrite.' } },
      required: ['text'],
    }),
    // It rewrites a string and returns it: no file is written, no row is stored, no state
    // is changed. That is exactly what `readOnlyHint` is for. (The rewrite itself is a
    // model call, and where that model runs is the privacy mode's business, not this
    // annotation's.)
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ text }) => {
    const words = String(text ?? '')
    const style = await chosen()
    // Nothing to do, and saying so rather than making a call is the point of the default.
    if (style === undefined || words.trim() === '') {
      return { content: [{ type: 'text', text: words }] }
    }

    try {
      const answered = await alexia.server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: words } }],
        systemPrompt: `You rewrite text in a given voice. The voice: ${style}. ${RULES}`,
        // Room for the same text in slightly different words, and not much more. A cap
        // this tight is also a cheap guard against a model that decides to elaborate.
        maxTokens: Math.min(2000, Math.ceil(words.length / 2) + 200),
        // The cheapest rung that can do this. Rephrasing is a narrow closed task and
        // paying planning prices for it is how a personality becomes a line on a bill.
        modelPreferences: { intelligencePriority: 0.2, speedPriority: 0.8, costPriority: 0.9 },
      })
      const said = answered.content?.type === 'text' ? answered.content.text.trim() : ''
      // A rewrite that came back empty, or wildly longer than what went in, is a model that
      // did something other than what it was asked. The original is always the safe answer.
      if (said === '' || said.length > words.length * 3 + 200) {
        log.warn('the rewrite did not look like a rewrite; keeping the original')
        return { content: [{ type: 'text', text: words }] }
      }
      return { content: [{ type: 'text', text: said }] }
    } catch (error) {
      // Never cost somebody their answer over a decoration.
      log.warn('could not rephrase', error)
      return { content: [{ type: 'text', text: words }] }
    }
  },
)

/**
 * The binding, and the reason it is a binding rather than a branch.
 *
 * On the default voice this capability is **not provided at all**, so core's own lookup
 * comes back empty and it streams the answer straight through with no extra call and no
 * extra wait. A plugin that answered and returned the input unchanged would still have
 * cost a round trip and still have turned streaming into a pause.
 */
async function bind() {
  const style = await chosen()
  restyle.update({ _meta: style === undefined ? {} : { 'alexia/provides': ['persona.rephrase'] } })
  await report()
}

await alexia.start()
await bind()
alexia.onSettingsChanged((changed) => {
  if ('voice' in changed || 'custom_voice' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
