// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How this plugin asks core for an answer, and what reaches it while it waits (D195).
 *
 * Three small things that were written inline in `index.js` and were wrong there for the same
 * reason: **they are per-call details that must be identical on every call**, and a second
 * call site that forgets one of them fails in a way nothing points at.
 *
 * That is not hypothetical. `answer()` passed the option bag; `command()` was written earlier
 * and passed nothing, so it carried the MCP SDK's own sixty-second default — and a plugin
 * command that has to ask a person for permission waits on a human being, which sixty seconds
 * is not long enough for. The command was cancelled, core read the cancel as the plugin giving
 * up, and the phone got an error for a question nobody had answered yet. One exported function
 * is the version of that which cannot drift, and a test can hold it to the numbers.
 *
 * **Ten minutes, reset on progress** (D192). The SDK's minute is a limit on a *round trip*, and
 * what is happening here is a task: a tool run, a picture, a question waiting on somebody
 * making tea. Since D193 core reports progress while it writes, so this is ten minutes of
 * *silence* rather than a ceiling — and `resetTimeoutOnProgress` is what turns one into the
 * other.
 *
 * **Asking for progress is also what creates the channel.** MCP puts a `progressToken` on a
 * request only when the caller passes `onprogress`, and core sends `alexia/stream` frames on
 * that token and nowhere else — so the default handler is a real function rather than
 * `undefined`, even where nothing is listening yet.
 */

/** The `_meta` key core sends each frame of an answer under (`STREAM_META`, D193). */
export const STREAM = 'alexia/stream'

/**
 * How long an answer may go without a word from core.
 *
 * Long enough for a permission question on the other end of a phone, short enough that a task
 * whose other end has died is eventually given up on rather than held forever.
 */
export const ANSWER_WAIT = 10 * 60_000

/**
 * The second argument every `sampling/createMessage` on this path is made with.
 *
 * `signal` is the answer's own `AbortController`, which is what `/stop` and the draft's Stop
 * button both reach for.
 */
export function sampling(signal, onprogress = () => {}) {
  return { signal, timeout: ANSWER_WAIT, resetTimeoutOnProgress: true, onprogress }
}

/**
 * One `alexia/stream` frame out of the progress notification that carried it, or `undefined`.
 *
 * Core sends `{ delta?, restart?, phase? }`; an Alexia older than D193 sends progress with no
 * `_meta` at all, and a newer one may add a fourth field. Both read as *nothing to draw*
 * rather than as something going wrong.
 */
export function frameOf(params) {
  const frame = params?._meta?.[STREAM]
  return frame !== null && typeof frame === 'object' ? frame : undefined
}

/** An answer that was stopped on purpose. Not a failure, and nothing more to say about it. */
export class Stopped extends Error {}

/**
 * Was that the stop, or something genuinely going wrong (D194)?
 *
 * The signal is the answer that can be trusted: a stop aborts the controller, and whatever the
 * rejection turns out to look like, the abort is why it happened. The other two are what an
 * abort looks like from further away — the platform's own `AbortError`, and the sentence MCP
 * wraps a cancelled request in on its way back across the wire, where the SDK has already
 * turned the reason into one of its own errors. A stop dressed up as *something went wrong
 * here* would be the plugin reporting a fault for the thing the person just asked for.
 */
export function wasStopped(signal, error) {
  if (signal?.aborted) return true
  if (error?.name === 'AbortError') return true
  return /\b(?:aborted|cancell?ed)\b/i.test(String(error?.message ?? error))
}
