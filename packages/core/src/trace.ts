// SPDX-License-Identifier: AGPL-3.0-only
import type { Step } from './agent.js'

/**
 * The trace, with a memory (M6-5).
 *
 * The live trace exists already (M15-5) and streams (D74), and it is **gone the moment the
 * task is** — which makes it a progress indicator rather than a record. This is the record:
 * the same event stream, read by a second consumer.
 *
 * **Two consumers, one stream, and do not conflate them.** M15-6 trims the trace *for the
 * model's context*: old steps collapse, raw tool output is dropped once what was learned
 * from it is recorded. What is kept here is what the loop actually did, untrimmed, because
 * a person looking at what happened wants the version that happened. Trimming this because
 * the context was trimmed would be one decision serving two jobs badly.
 *
 * **Five runs, in memory, gone on restart.** Kept from the predecessor along with its
 * reason: *restarting and finding an empty history is the honest behaviour for something
 * that was never meant to be a permanent log.* A person who wants one exports it, which is
 * the row action beside every run.
 */

/** How many runs are kept. Five was enough in practice and is a number, not a policy. */
export const KEPT = 5

/** How much of a tool's answer is worth keeping for a person to read. */
const OUTPUT_MAX = 4000

export interface TraceStep {
  /** 1-based, and the same number the ceiling counts. */
  n: number
  name: string
  args: Record<string, unknown>
  ok?: boolean
  /** What the tool said, untrimmed up to a length no screen would show anyway. */
  text?: string
  /**
   * This step began while the one before it was in error.
   *
   * Three lines, and it is the difference between a log and a story: a flat list becomes an
   * agent visibly recovering. Taken straight from the predecessor, where it was the smallest
   * change that made the trace readable.
   */
  backtrack?: boolean
  at: number
  ms?: number
}

export interface Run {
  id: string
  /** The user's own line. It is what the run was for, so it is never paraphrased. */
  task: string
  at: number
  ended?: 'answered' | 'stopped' | 'ceiling' | 'refused'
  /** Set when it ended in a refusal — the router's sentence, or the provider's. */
  why?: string
  /**
   * The model asked for, and the model that answered.
   *
   * **Two labels, because they differ, and here they differ for a reason core creates**: the
   * router falls back on a 429 (M1-8). The header badge shows one model; a trace that showed
   * one too would make the fallback invisible in the one place it is explicable.
   */
  asked?: string
  answered?: string
  steps: TraceStep[]
  /** What this run cost, from the ledger — the difference across it, not a second tally. */
  spent?: number
}

export class Trace {
  readonly #runs: Run[] = []
  #open?: Run

  /** Newest first, which is the order somebody reads them in. */
  get runs(): readonly Run[] {
    return [...this.#runs].reverse()
  }

  one(id: string): Run | undefined {
    return this.#runs.find((run) => run.id === id)
  }

  /** A task begins. The previous one is closed off if something ended it without saying so. */
  start(id: string, task: string): void {
    this.#open = { id, task, at: Date.now(), steps: [] }
    this.#runs.push(this.#open)
    // Oldest out. A list that grows without bound in a process that never restarts is a leak
    // with a nicer name.
    while (this.#runs.length > KEPT) this.#runs.shift()
  }

  /** Which model was asked and which answered, per turn. The last turn's is the run's. */
  turn(models: { asked: string; answered: string }): void {
    if (!this.#open) return
    this.#open.asked = models.asked
    this.#open.answered = models.answered
  }

  step(step: Step): void {
    if (!this.#open) return
    // In error, not merely finished: a step that begins after a failure is the loop trying
    // something else, and saying so is what turns the list into a story.
    const before = this.#open.steps.at(-1)
    this.#open.steps.push({
      n: step.n,
      name: step.name,
      args: step.args,
      at: Date.now(),
      ...(before?.ok === false && { backtrack: true }),
    })
  }

  done(step: Step): void {
    const found = this.#open?.steps.find((one) => one.n === step.n)
    if (!found || !step.outcome) return
    found.ok = step.outcome.ok
    found.text = step.outcome.text.slice(0, OUTPUT_MAX)
    found.ms = Date.now() - found.at
  }

  end(ended: Run['ended'], extra: { why?: string; spent?: number } = {}): void {
    if (!this.#open) return
    this.#open.ended = ended
    if (extra.why !== undefined) this.#open.why = extra.why
    if (extra.spent !== undefined) this.#open.spent = extra.spent
    this.#open = undefined
  }
}

/**
 * One run as text, which is what *export* means here.
 *
 * The second thing anybody does with a bad run is send it to somebody, so what comes out is
 * something a person can read in a message rather than a shape another program would have to
 * parse. Nothing is summarised: the arguments and the answers are as they were.
 */
export function asText(run: Run): string {
  const when = new Date(run.at).toISOString()
  const lines = [
    `# ${run.task}`,
    '',
    `${when} · ${String(run.steps.length)} step${run.steps.length === 1 ? '' : 's'} · ${run.ended ?? 'unfinished'}`,
    ...(run.spent !== undefined ? [`spent $${run.spent.toFixed(4)}`] : []),
    // Both, and only when they differ — a line saying the same model twice is a line that
    // trains people to skip the line.
    ...(run.answered !== undefined && run.asked !== undefined && run.asked !== run.answered ?
      [`asked ${run.asked}, answered ${run.answered} — the router fell back`]
    : run.answered !== undefined ? [`model ${run.answered}`]
    : []),
    ...(run.why !== undefined ? ['', run.why] : []),
  ]

  for (const step of run.steps) {
    lines.push(
      '',
      `## ${String(step.n)}. ${step.name}${step.backtrack === true ? '  (retrying after a failure)' : ''}`,
      `args: ${JSON.stringify(step.args)}`,
      `${step.ok === undefined ? 'did not finish' : step.ok ? 'ok' : 'failed'}${step.ms === undefined ? '' : ` · ${String(step.ms)}ms`}`,
    )
    if (step.text !== undefined && step.text !== '') lines.push('', step.text)
  }
  return lines.join('\n') + '\n'
}
