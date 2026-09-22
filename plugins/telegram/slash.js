// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two things a slash command typed on a phone needs before anybody reads it (D194).
 *
 * **`@BotName` is Telegram's, not the command's.** Tapping a command from the `/` menu in a
 * group — and, on some clients, in a private chat too — sends `/status@AlexiaBot` rather than
 * `/status`, because in a group several bots are listening and the suffix says which one is
 * meant. It has done its job by the time the update arrives here. Core has never heard of it,
 * so `/status@AlexiaBot` would reach core as an unknown command and come back as *no such
 * thing* — which reads, from the phone, as a menu whose own entries do not work. `bare()`
 * takes it off the front word and leaves everything after it exactly as typed.
 *
 * **`/stop` has to be recognised before anything else is.** It is the one command that cannot
 * be queued behind the work it exists to end, so the poll loop tests for it by itself, and a
 * test that is slightly too eager is a command that eats messages: `/stopwatch timer` is not a
 * stop, and neither is a sentence that happens to begin with the word. The pattern wants the
 * word whole — end of message, or whitespace after it, with the optional `@BotName` between.
 * `/panel` is held to the same test for a different reason: core has never heard of it either.
 *
 * **And a leading slash is not a command** (D195). This end used to send anything starting
 * with `/` down the command path, while core only reads a line as a command when it matches
 * its own pattern (`packages/core/src/serve.ts`) and otherwise runs it as an ordinary question
 * with tools. The two disagreeing is not a cosmetic difference: `/2fa reset the code` is not a
 * command to core, so from the phone it was sent with no history, capped at a command's few
 * hundred tokens, and never written into the conversation — the answer arrived, and the
 * question it answered was not in the transcript. `isCommand` is core's test, copied
 * deliberately, so the two ends route the same line the same way.
 *
 * Regexes with no state and no I/O, kept out of `index.js` so every one can be held to a test.
 */

/** `/stop`, `/stop@AlexiaBot`, `/stop now` — and nothing that merely starts with those letters. */
const STOP_RE = /^\/stop(@\w+)?(\s|$)/i

/** `/panel`, the same shape. The other command core has never heard of, for the same reason. */
const PANEL_RE = /^\/panel(@\w+)?(\s|$)/i

/**
 * Core's own test, character for character: a slash, a letter, then letters, digits, dots and
 * dashes, and then either whitespace or the end. A dot is in it because a plugin's command is
 * namespaced (`commitments.due`).
 */
const COMMAND_RE = /^\/[a-z][a-z0-9.-]*(?:\s|$)/i

/**
 * Whether core will read this line as a slash command.
 *
 * Trimmed and single-line, both because core trims and because core refuses a line with a
 * newline in it — a wrapped prompt that happens to begin with a slash is a question, not a
 * command, and that check is the thing keeping it one. Pass it the text with any `@BotName`
 * already taken off by `bare`, since core has never heard of that suffix.
 */
export function isCommand(text) {
  const typed = String(text ?? '').trim()
  return !typed.includes('\n') && COMMAND_RE.test(typed)
}

/** Whether this message is the stop command. */
export function stops(text) {
  return STOP_RE.test(String(text ?? ''))
}

/**
 * Whether this message asks for the control panel (D196).
 *
 * The second of the two commands that are this plugin's own and not core's: the panel is a
 * page core does not know about, opened by a button only Telegram can draw, so sending
 * `/panel` on to core would come back as *there is no such command*. Held to the same
 * whole-word test `/stop` gets, because `/panels of the jury` is not a request for one.
 */
export function panels(text) {
  return PANEL_RE.test(String(text ?? ''))
}

/** `/status@AlexiaBot the rest` → `/status the rest`. Anything not a command is untouched. */
export function bare(text) {
  return String(text ?? '').replace(/^(\/[a-z0-9_]+)@\w+/i, '$1')
}
