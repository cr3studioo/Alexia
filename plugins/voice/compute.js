// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'

/**
 * The line between planning something said or heard and doing the inference for it.
 *
 * **Planning is everything that belongs to the person**: the microphone, the speakers, the
 * file they pointed at, the voice they chose and whether they agreed. It stays on the computer
 * they are sitting at. **The operation is the model running** — Whisper over a recording,
 * Piper or Qwen making one — and it runs wherever they chose: this computer, or one they
 * paired. This file is the join: a tool plans, hands the plan to `run`, and gets words or a
 * recording back without learning where they were made.
 *
 * **The operation can tell when its planner is in the same process.** Each run carries a
 * `trace` nobody else knows; an operation that finds it in this process's own table is being
 * run *here*, by the tool that planned it, and may behave exactly as that tool always did —
 * a voice that is not downloaded yet arrives on first use, with the bar the person is
 * watching. An operation that does not find it was sent by another computer, and is a worker:
 * it installs nothing unasked, and says what is missing instead. Nothing about who sent it is
 * learned either way — only whether the asker is this very process.
 *
 * A sibling of `plugins/media/compute.js` rather than an import of it, because plugins cannot
 * import each other. If the two stay this close, this is worth lifting into `@alexia/sdk`.
 */

/** `alexia/compute/run` is not known to this core at all. */
const METHOD_NOT_FOUND = -32601
/** Nothing answers — and for compute, said in exactly these words, it means there is no compute here. */
const CAPABILITY_NOT_AVAILABLE = -32050
const NO_COMPUTE = /compute is not available/i

/**
 * Is this core one that has no compute at all, as opposed to a computer that cannot do the job?
 *
 * The difference is the whole of whether running it here is honest. *No compute* means there
 * is no other computer to have chosen, so here is the only place there ever was. Anything else
 * — a paired computer that is offline, busy, or not set up — is an answer the person has to
 * see: doing the work somewhere they did not choose is the one thing this must never do.
 */
export const unwired = (error) =>
  error?.code === METHOD_NOT_FOUND ||
  (error?.code === CAPABILITY_NOT_AVAILABLE && NO_COMPUTE.test(String(error?.message ?? '')))

/** A failure as the sentence it was, without the wire's own prefix in front of it. */
export const plain = (error) => String(error?.message ?? error).replace(/^MCP error -?\d+:\s*/, '')

export function split(alexia) {
  /** The runs this process planned and has not heard back from, by trace. */
  const mine = new Map()
  const handlers = new Map()

  return {
    /**
     * Register what performs one operation.
     *
     * `perform(plan, io)` is given `io.here` — its planner is this process — along with the
     * signal that ends it and a `report(done, total, message)` that reaches whoever is
     * waiting. It answers `{ text?, files? }`, the files being ones it wrote.
     */
    operation(cap, perform) {
      handlers.set(cap, perform)
      alexia.computeOperation(cap, (args, ctx) => {
        const { trace, ...plan } = args ?? {}
        const planner = typeof trace === 'string' ? mine.get(trace) : undefined
        return perform(plan, {
          here: planner !== undefined,
          signal: ctx?.mcpReq?.signal,
          report: planner?.report ?? ((done, total, message) => alexia.progress(ctx, done, total, message)),
        })
      })
    },

    /**
     * Run an operation where the person chose, and bring back what it made.
     *
     * `report` is the planner's own; `inputs` are files to send with the job, each named in
     * the plan by the same path. A failure comes back as the sentence the operation said.
     */
    async run(cap, plan, { signal, report = () => {}, inputs } = {}) {
      const trace = randomUUID()
      mine.set(trace, { report })
      try {
        const made = await alexia.compute.run(
          cap,
          { ...plan, trace },
          {
            ...(inputs && { inputs }),
            ...(signal && { signal }),
            // Only what crossed a wire arrives here. An operation in this process reports
            // through `mine` instead, so nothing is said twice.
            onProgress: (done, total, message) => report(done, total, message),
          },
        )
        return { ...(made.text !== undefined && { text: made.text }), files: made.files ?? [] }
      } catch (error) {
        if (!unwired(error)) throw new Error(plain(error), { cause: error })
        const { text, files = [] } = await handlers.get(cap)(plan, { here: true, signal, report })
        return { ...(text !== undefined && { text }), files }
      } finally {
        mine.delete(trace)
      }
    },
  }
}

/**
 * The inference this process has running, so that all of it can be ended at once.
 *
 * **Nothing here keeps a model in memory between calls** — Whisper, Piper and Qwen are each a
 * program that loads, answers and exits, so the memory goes back when the program does.
 * *Release* therefore means ending whichever of them is still running, which is what `hold`
 * makes possible: every operation runs under a signal this can abort.
 */
export function holding() {
  const running = new Set()
  return {
    /** A signal for one piece of work, ended by the caller's own signal or by `release`. */
    hold(signal) {
      const mine = new AbortController()
      const give = () => mine.abort(signal?.reason)
      if (signal?.aborted) give()
      else signal?.addEventListener('abort', give, { once: true })
      running.add(mine)
      return {
        signal: mine.signal,
        done: () => {
          signal?.removeEventListener('abort', give)
          running.delete(mine)
        },
      }
    },
    /** End everything that is still working. Returns how many there were. */
    release() {
      const count = running.size
      for (const one of running) one.abort(new Error('released'))
      running.clear()
      return count
    },
  }
}
