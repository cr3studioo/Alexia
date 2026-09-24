// SPDX-License-Identifier: Apache-2.0

/**
 * Capabilities: dotted names that stand for *a thing that can be done*, with no plugin
 * attached. `docs/spec/capabilities.md` is the document; a test diffs it against this file.
 *
 * Two kinds, one syntax, resolved completely differently — confusing them is the main way
 * to get this wrong:
 *
 * - a **permission** is something core grants, from the fixed list below, and a plugin
 *   asking for a name that is not on it does not install;
 * - a **service** is something another plugin provides, resolved at runtime by
 *   `alexia/capability/call`, and answered by whichever plugin offers it.
 */

/**
 * The complete permission registry. Core defines every one of these, which is exactly why
 * the list is closed: a plugin cannot widen what it may ask for by inventing a name.
 */
export const PERMISSIONS = [
  'fs.own_dir',
  'fs.read_scoped',
  'fs.write_scoped',
  'net.download',
  'net.request',
  'audio.input',
  'audio.output',
  'screen.capture',
  'input.control',
  'proc.spawn',
  'notify',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const isPermission = (cap: string): cap is Permission =>
  (PERMISSIONS as readonly string[]).includes(cap)

/**
 * The service capabilities **core itself** reaches for, by name.
 *
 * Every other service capability is plugin-to-plugin and core never hears about it. These
 * are the ones where core has a step in its own loop that some plugin may want to take
 * over — and naming them here rather than in core is the point: `docs/spec/capabilities.md`
 * is the registry, this file is the registry in code, and a capability name in
 * `packages/core/src` would be indistinguishable from core naming a plugin.
 *
 * The rule for adding one: core must work, completely, when nothing provides it. If the
 * absence of a capability is a missing feature rather than a missing flourish, it does not
 * belong on this list — it belongs in core.
 */
export const CORE_CAPABILITIES = {
  /**
   * The standing instruction a chosen personality adds to Alexia's own (M4-4, revised).
   *
   * Read **once per task** and appended to the system prompt, which is the whole of the
   * revision: the first build rewrote the finished answer instead, and a rewrite arrives
   * after every decision it was meant to influence has already been made. A personality
   * that says *ask before anything with external consequence* has to be in front of the
   * model when it picks a tool, not in front of the sentence describing what it did.
   *
   * Nothing provides it → the stock four lines, unchanged, and streaming as normal.
   */
  personality: 'persona.personality',
  /**
   * Hand one finished exchange to whatever remembers things (M7-3).
   *
   * Core does not decide what is worth keeping and never reads it back — it hands over what
   * was just said and forgets about it. **Fire and forget, with no answer**, because a
   * memory that could delay an answer is a memory people turn off, and one that could refuse
   * an answer is a memory that can break a conversation.
   *
   * It sits on this list rather than in core because core is complete without it: nothing
   * asks, nothing waits, and an Alexia with no memory plugin simply does not notice things.
   * That is a missing flourish, which is the bar for being here.
   */
  capture: 'memory.capture',
  /**
   * **That wasn't her**: one answer marked as out of character (`plan-personality.md`
   * improvement 10), with an optional line on what she should have said.
   *
   * The sibling of *Bad answer* and the opposite question. *Bad answer* is about the **model**
   * — it was wrong, ask something else — and core handles it itself, because a model's record
   * is core's. This one is about the **personality**, which is a plugin's document, so core
   * hands over what was said and forgets about it.
   *
   * **Fire and forget, with no answer**, for the same reason `capture` is: the person has
   * already read the answer and pressed a button about it, and a mark that could delay or
   * refuse anything would be a button that sometimes fails for reasons about a plugin.
   *
   * Nothing provides it → the button is not drawn, which is the honest version of *there is
   * nothing here this would tell*. Core is complete without it: an Alexia with no personality
   * plugin has no personality to be out of character for.
   */
  notHer: 'persona.not_her',
  /**
   * **Which personality is in use, by name** (`plan-personality.md` improvement 8's chip).
   *
   * A second name rather than a field on {@link CORE_CAPABILITIES.personality}, because the
   * two are read at completely different rates: the document once a task, and the name on
   * every state poll. Folding one into the other would send a page of text to a header label
   * twenty times a minute.
   *
   * Nothing provides it → no chip. The chat header is complete without one: the name is a
   * convenience, and *which personality is on* has a settings screen either way.
   */
  inUse: 'persona.in_use',
  /**
   * Ask a person a question when they are not at the keyboard, and wait for the answer (M7-5).
   *
   * **The ruling stays in core; only the surface is new.** The permission modes (M15-3) and
   * the consent ladder (M6-9) decide *what* is asked and what the answer means; this is a
   * second place the asking can happen — a phone, most obviously, when the task was started
   * from one and there is no window open to answer in.
   *
   * Core works completely without it: with nothing providing it, a question nobody can be
   * shown is a no, which is what it already was.
   */
  ask: 'ask.confirm',
  /**
   * **A file in, markdown out** — what an attached document says.
   *
   * The same sentence `voice.transcribe` already is, with a different noun. *Not every model
   * can read a document* is the same problem as *not every model can hear*, and it has the
   * same answer: do not ask the model, ask a capability. Core carries the bytes, because the
   * composer is core's own surface and a plugin cannot add a control to it; reading them is
   * a plugin's, because there are several ways to do it and every one of them should be
   * deletable.
   *
   * It sits here rather than in core for the reason this whole list exists: what ships in
   * the box reads a text layer and refuses a scan, and a stronger extractor is a second
   * plugin offering **this same name** — a drop-in alternative rather than a competitor.
   * Naming a plugin instead would make that impossible.
   *
   * Core works completely without it. With nothing providing it an attached file is still
   * named in the conversation and still on disk; what is missing is a reading of it, and the
   * note under the composer says exactly that. A missing flourish, which is the bar for
   * being here.
   */
  extract: 'document.extract',
  /**
   * **Somebody can talk to her from somewhere other than this window** — a phone, a chat app,
   * anything that carries a conversation in and an answer out (D199's Chat page).
   *
   * The first name on this list that is **a mark rather than a call**. Nothing ever calls it
   * and no tool binds it: a plugin puts it in `provides` to say *I am a way in*, and core only
   * counts the enabled ones whose keys are all stored. That count is the whole use — the board
   * asks before the Chat page comes off only when it is zero, because taking the window's
   * conversation away is harmless with a phone paired and a lockout without one.
   *
   * A capability rather than a list of channel plugins for the reason every entry here is one:
   * the next way in is a second plugin offering this same name, and the board learns about it
   * without core ever learning who it is.
   *
   * Nothing provides it → the count is zero → the board asks every time, which is what it did
   * before this name existed.
   */
  channel: 'channel.chat',
} as const

/**
 * The `_meta` key a plugin puts on a `sampling/createMessage` to say *use my tools, and ask
 * me when you must* (M7-5).
 *
 * **A flag on the existing request rather than a new method**, and the reason is the one the
 * versioning doc gives for what needs a revision bump: an Alexia that does not understand
 * this ignores it and answers without tools, which is **exactly what it did before the flag
 * existed**. A change a plugin cannot see going wrong is not a change to the contract's
 * number — and `_meta` is MCP's own extension point, already carrying `alexia/provides`.
 *
 * What it turns on is the whole loop: the tool list, the permission gate, the trace and the
 * ledger, on the same terms as a task started at the keyboard. What it does not change is
 * who decides — a step that needs a yes still needs one, and {@link CORE_CAPABILITIES.ask}
 * is where that question goes when there is no window to show it in.
 */
export const TOOLS_META = 'alexia/tools'

/**
 * The `_meta` key a tool uses to say which capabilities it answers.
 *
 * The manifest's `provides` is the static declaration — what the library shows and what
 * another plugin's `requires` resolves against. This is the runtime binding, and it is on
 * the tool rather than in the manifest for the same reason tools are not in the manifest:
 * a plugin with no model downloaded yet cannot answer `voice.transcribe`, and should not
 * claim to until it can.
 */
export const PROVIDES_META = 'alexia/provides'

/**
 * The `_meta` key core puts on a `sampling/createMessage` **result** to hand a channel
 * plugin the files a task made.
 *
 * The window reads a tool's `resource_link` off the step trace and draws a row with the file
 * on it (D119). A channel plugin — Telegram — is in another process and cannot reach the
 * `/api/file` route that row uses, so core reads the bytes and returns them here:
 * `[{ name, mime, data }]`, `data` base64, the same shape `voice.render` already hands back
 * an Ogg in. A flag a plugin cannot see going wrong, like the two above: an Alexia that does
 * not set it delivers the words alone, which is every channel before this existed.
 */
export const FILES_META = 'alexia/files'

/**
 * The `_meta` key on the `notifications/progress` core sends back **while a plugin's
 * `sampling/createMessage` is still being answered** — the answer's words as they are written.
 *
 * The window has had them since M1: the model's words land on screen as they arrive, and the
 * line under the question says what the wait is doing. A channel plugin had the finished answer
 * and nothing before it, so a phone showed a typing dot for as long as a slow model took and
 * then the whole reply at once — which reads as nothing happening, and then everything. The
 * door was already open: MCP lets a request carry a `progressToken`, and a plugin that passes
 * `onprogress` to `createMessage` gets one on its request for free. Core now answers on it.
 *
 * **Only on the plugin's own token, only when it sent one.** No token, no frames — which is
 * every plugin written before this, and every call that did not ask. `progress` rises strictly
 * from one, as MCP requires, and has no `total`: an answer does not know how long it will be.
 * Each frame carries one {@link StreamFrame} under this key, and a frame may carry more than
 * one of its three fields.
 *
 * A flag a plugin cannot see going wrong, like the others: an Alexia that has never heard of it
 * sends nothing on the token and the finished answer arrives as it always did, so
 * `alexia_protocol` does not move. A slash command sends no frames — its answer is one line
 * that is already written.
 */
export const STREAM_META = 'alexia/stream'

/**
 * One frame of a streamed answer, as {@link STREAM_META} carries it.
 *
 * Three fields because a channel showing an answer while it is written needs to be told three
 * different things, and each of them is something the window is already told on its own stream:
 */
export interface StreamFrame {
  /**
   * **The words written since the last frame** — appended, never a replacement. Core gathers
   * them and sends at most a few frames a second, because a pipe carrying one frame per token
   * is a pipe busy with framing; join every `delta` in order and you have the answer so far.
   */
  delta?: string
  /**
   * **Throw away every word so far** (D155). The model writing them stopped partway, and the
   * answer is starting again on the next one — so a draft left showing would be two models'
   * sentences run together. The words after this frame are the new answer's first.
   */
  restart?: true
  /**
   * **What the wait is doing** — `choosing`, `asking`, `retrying`, `backup`, `thinking`,
   * `writing`, `tool` — the same stage names the line under the question in the window reads.
   * It doubles as a keep-alive: a long tool step sends `tool` every few seconds, so a plugin
   * that resets its timeout on progress is not left guessing whether a silent minute is a
   * slow answer or a dead one. A name this list does not have yet is a stage a newer Alexia
   * added; show nothing for it rather than failing.
   */
  phase?: string
  /**
   * **Which model the stage is about**, on `asking`, `retrying`, `backup`, `thinking` and
   * `writing` — the name the window's line reads, so a phone can say it too. Absent from an
   * Alexia older than this field, and from stages that are not about one model.
   */
  model?: string
  /** **Which tool is running**, on `tool`. Absent where the stage is not a tool. */
  tool?: string
}

/**
 * The `_meta` key core puts on a `sampling/createMessage` **result that a slash command
 * answered**, carrying what the command knows as data rather than as a sentence.
 *
 * A command's answer is one line in the words the person typing would use, and that stays the
 * `content` — every channel before this one relayed it and was right to. But a surface with a
 * shape of its own wants the thing the sentence was written from: a phone's `/` menu is a list
 * of names and summaries, not a paragraph to parse, and a panel drawing the state wants
 * numbers it can lay out. So when a command has any, they ride here:
 *
 * - `/help` — `[{ name, summary }]`, every command you could type right now, in the order
 *   `/help` lists them.
 * - `/status` — a {@link Standing}.
 *
 * Absent when the command has nothing more than its sentence, which is most of them. A flag a
 * plugin cannot see going wrong, like the others: an Alexia that does not set it hands back
 * the sentence alone, which is every command before this existed, so `alexia_protocol` does
 * not move. A plugin that needs the list from one parses `/name — summary` lines, which is
 * what the sentence has always been.
 */
export const COMMAND_META = 'alexia/command'

/**
 * **Where things stand**, as `/status` hands it over on {@link COMMAND_META}.
 *
 * The same facts as the sentence, and only the ones core actually has: a month with no cap
 * has no `cap`, rather than a zero that reads as *nothing may be spent*.
 */
export interface Standing {
  /** Where the work runs: `local`, `combined` or `cloud`. */
  mode: string
  /** Cheapest first, or strongest first — the `/cheap` and `/best` pin. */
  prefer: 'cheap' | 'best'
  /** Dollars spent today, against the day's allowance for paid models. */
  today: { spent: number; allowance: number }
  /** Dollars spent this month, against the monthly cap when somebody has set one. */
  month: { spent: number; cap?: number }
  /** Whether a task is running right now. */
  running: boolean
}

/**
 * The `_meta` key a plugin puts on a `sampling/createMessage` to hand over **a personality in
 * its three lengths, and which one to hear** (D189).
 *
 * On the request: `{ high, medium?, small?, hear? }` — the three documents, and `hear` one of
 * `small`, `medium`, `high`, or absent for *as the chat would*. Core sends each model the length
 * the chat would give it; with `hear` set it sends that length, to a model the chat would give it
 * to, under the person's own pins and paid switch. On the **result**, the same key says what
 * happened: `{ sent, model, paid, cost, matched, chat?: { model, size } }`.
 *
 * A flag a plugin cannot see going wrong, like the others: an Alexia that does not know it sends
 * `systemPrompt` as it always did and puts nothing on the result.
 */
export const LENGTHS_META = 'alexia/lengths'


/**
 * The `_meta` key a plugin puts on a progress notification to send **a picture of the work
 * while it is still work**.
 *
 * A `data:` URL and never a path: the frame exists for a second and is replaced, so writing
 * each one to disk to serve it back would be a file per step of every render. Under `_meta`
 * for the same reason as the three above — an Alexia that has never heard of it draws the bar
 * and ignores the rest, so nothing about it is a version number.
 */
export const PREVIEW_META = 'alexia/preview'

/**
 * The `_meta` key a plugin puts on a progress notification to send **the shape of the job**:
 * its own steps, in the order they run, each with its own state and its own fraction.
 *
 * The overall bar answers *how long*. This answers *how many, and which one* — which is the
 * question a person watching a pipeline actually has, and the one a single percentage cannot
 * be made to answer however precise it gets.
 */
export const STAGES_META = 'alexia/stages'

/**
 * One step of a long job, as the plugin running it describes its own shape.
 *
 * **Ordered by the plugin, and never sorted anywhere else.** Core cannot know that *decode*
 * follows *sample* — it would have to guess from names, or infer it from links it was not
 * given — and the plugin owns the pipeline and simply states the order. Which is the division
 * `graph` already draws: a plugin says what the things are, core decides every pixel.
 *
 * `label` is for a tooltip and nothing is laid out around it, because five names fit across a
 * rail and twenty-five do not, and a strip that is unreadable at twenty-five is a strip that
 * fails exactly where a pipeline got interesting.
 */
export interface Stage {
  label?: string
  state: 'waiting' | 'running' | 'done' | 'failed'
  /** How far this one step has got. A `total` of zero or absent means it cannot say. */
  progress?: number
  total?: number
}
