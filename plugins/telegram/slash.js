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
 *
 * Two regexes with no state and no I/O, kept out of `index.js` so both can be held to a test.
 */

/** `/stop`, `/stop@AlexiaBot`, `/stop now` — and nothing that merely starts with those letters. */
const STOP_RE = /^\/stop(@\w+)?(\s|$)/i

/** Whether this message is the stop command. */
export function stops(text) {
  return STOP_RE.test(String(text ?? ''))
}

/** `/status@AlexiaBot the rest` → `/status the rest`. Anything not a command is untouched. */
export function bare(text) {
  return String(text ?? '').replace(/^(\/[a-z0-9_]+)@\w+/i, '$1')
}
