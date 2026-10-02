// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'

/**
 * The line between planning a piece of work and doing it.
 *
 * **Planning is everything that belongs to the person**: what they asked for, their settings,
 * their files, the question of whether they agreed. It stays on the computer they are sitting
 * at. **The operation is the part that needs a graphics card**, and it runs wherever they
 * chose — this computer, or one they paired. This file is the join: a tool plans, hands the
 * plan to `run`, and gets files back without learning where they were made.
 *
 * Two things make that line cheap to hold on the computer that has no second one.
 *
 * **The operation can tell when its planner is in the same process.** Each run carries a
 * `trace` nobody else knows; an operation that finds it in this process's own table is being
 * run *here*, by the tool that planned it, and may behave exactly as that tool always did —
 * use the ComfyUI the person has open, download on first use, show the picture as it forms.
 * An operation that does not find it was sent by another computer, and is a worker: it uses
 * only what is Alexia's own and installs nothing unasked. Nothing about who sent it is
 * learned either way — only whether the asker is this very process.
 *
 * **A richer progress report survives the short trip.** Core carries a number, a total and a
 * sentence between computers, which is right for a wire. In one process the planner's own
 * reporter is handed straight to the operation, so the preview and the stage strip a local
 * render has always shown are still there.
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
     * `perform(args, io)` is given `io.here` — its planner is this process — along with the
     * signal that ends it and a `report(message, done, total, work)` that reaches whoever is
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
          report: planner?.report ?? ((message, done, total, work) => alexia.progress(ctx, done, total, message, work)),
        })
      })
    },

    /**
     * Run an operation where the person chose, and bring back what it made.
     *
     * `report` is the planner's own; `inputs` are files to send with the job. A failure comes
     * back as the sentence the operation said.
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
            onProgress: (done, total, message) => report(message, done, total),
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
 * What an operation says about its work, as one line of JSON.
 *
 * An operation answers with files and a string. The planner needs a few facts as well — which
 * model painted it, whether memory was tight — and a string is where they go. Read forgivingly:
 * a line that is not JSON is taken as words, which is what a host running an older copy of
 * this plugin would send.
 */
export const note = (facts) => JSON.stringify(facts)

export function facts(text) {
  try {
    const said = JSON.parse(String(text ?? ''))
    return said !== null && typeof said === 'object' && !Array.isArray(said) ? said : {}
  } catch {
    return {}
  }
}
