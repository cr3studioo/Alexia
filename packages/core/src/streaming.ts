// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamFrame } from '@alexia/protocol'
import type { Phase } from './router.js'

/**
 * A plugin's answer, sent to it while it is still being written (`alexia/stream`).
 *
 * The window has always had this: the model's words land on screen as they arrive, and the
 * line under the question says what the wait is doing. A channel plugin — a phone — had the
 * finished answer and nothing before it, so a slow model looked exactly like a dead one until
 * the whole reply turned up at once. The hooks were already there, on `send()` and on the
 * loop, feeding the window's stream; this turns the same hooks into frames for a plugin.
 *
 * **Gathered, not forwarded.** A provider streams a few characters at a time, and a frame per
 * token is a pipe to another process busy with framing — the plugin on the other end would
 * then throttle it again before a phone saw any of it. So words are held and sent at most
 * every {@link STREAM_EVERY}, the first of them at once: the point is the first words, and
 * holding those back for the sake of a tidy cadence would be the wrong way round.
 *
 * **Everything else goes at once, and after the words before it.** A stage change or a restart
 * sends what was gathered first, so a frame never overtakes words that were written before it
 * — except the words a restart voids, which are dropped rather than sent to be thrown away.
 * And whatever is still held when the answer finishes goes before the answer does, because
 * the frames and the result share one pipe and a frame that arrives after its request has been
 * answered arrives at nothing.
 */

/** At most this often, gathered words go out. Five a second reads as live; fifty is noise. */
export const STREAM_EVERY = 200

/**
 * At most this often, a long tool step says it is still going. A tool that reports progress
 * ten times a second is a tool the plugin need not hear about ten times a second — only that
 * the silence is work, which once every few seconds says as well as every frame would.
 */
export const ALIVE_EVERY = 5_000

export interface Streamer {
  /** The model's words, as `send()` hands them over. Gathered, and sent on the clock above. */
  delta(text: string): void
  /** The words so far are void (D155). Whatever is still held goes with them, unsent. */
  restart(): void
  /** What the wait is doing now, by the stage's name. Sent at once, after the words before it. */
  phase(phase: Phase): void
  /** A tool step reporting progress: the stage again, at most every {@link ALIVE_EVERY}. */
  alive(): void
  /** Send what is still held, and stop. Anything after this is dropped. */
  end(): void
}

/**
 * The frames for one answer, sent through `send`.
 *
 * Only made when a plugin asked for them — a caller with no progress token makes none of this
 * and starts no clock. `now` is a seam for the test, which has a fake clock rather than a slow one.
 */
export function streamer(
  send: (frame: StreamFrame) => void,
  every: number = STREAM_EVERY,
  aliveEvery: number = ALIVE_EVERY,
  now: () => number = Date.now,
): Streamer {
  let held = ''
  let timer: NodeJS.Timeout | undefined
  /** When words last went out. Minus infinity, so the first words of an answer go at once. */
  let sentAt = -Infinity
  /** When a stage was last said, which is what a keep-alive is measured from. */
  let saidAt = -Infinity
  let stage: string | undefined
  /** Words have gone out since the last restart — so a tool after them is a break in the text. */
  let spoke = false
  /** The next words follow a tool, and are set apart from the words before it. */
  let gap = false
  let ended = false

  /** A frame, and never an exception: a plugin that has gone away is not the answer's problem. */
  const out = (frame: StreamFrame): void => {
    try {
      send(frame)
    } catch {
      // Nothing to do. The answer still arrives as a result, which is what it always was.
    }
  }

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (held === '') return
    const delta = held
    held = ''
    sentAt = now()
    out({ delta })
  }

  return {
    delta(text) {
      if (ended || text === '') return
      /**
       * In a task with tools, what a model says before it calls one streams too — *let me look
       * that up* — and the next turn's words would otherwise run straight on from it, full stop
       * against capital letter. A blank line between them is how the window's step row reads
       * when there is no row to draw.
       */
      held += gap ? `\n\n${text}` : text
      gap = false
      spoke = true
      if (timer !== undefined) return
      const wait = every - (now() - sentAt)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait).unref()
    },
    restart() {
      if (ended) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      held = ''
      spoke = false
      gap = false
      out({ restart: true })
    },
    phase(phase) {
      if (ended) return
      flush()
      if (phase.kind === 'tool' && spoke) gap = true
      stage = phase.kind
      saidAt = now()
      out({ phase: phase.kind })
    },
    alive() {
      if (ended || now() - saidAt < aliveEvery) return
      // Words first, here as in `phase`: a frame never overtakes what was written before it.
      // Nothing reachable today sends one of these before a `phase` has flushed — but *the
      // rule holds at every emitter* is the kind of thing that is true until one is added.
      flush()
      saidAt = now()
      out({ phase: stage ?? 'tool' })
    },
    /**
     * **The last words are not a frame — they are the answer** (D193, corrected).
     *
     * This used to flush what was held, on the reasonable-sounding grounds that a plugin should
     * be streamed every word it is about to be sent. It cannot be. A response is dispatched by
     * the receiving SDK the moment it is read, while a notification is handed to its handler a
     * microtask later — so a frame written immediately before the result is read *after* it, by
     * which time the request is finished and its progress handler is gone. What the plugin gets
     * for it is not the words but an error in its own log, on every answer: *a progress
     * notification for an unknown token*.
     *
     * So the tail is dropped rather than raced. The result carries the whole answer a moment
     * later — a draft that stops a few words short and is then replaced by the finished message
     * is what every streaming surface does anyway, and it is honest about what a notification
     * can promise.
     */
    end() {
      if (ended) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      held = ''
      ended = true
    },
  }
}
