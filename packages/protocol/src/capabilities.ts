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
