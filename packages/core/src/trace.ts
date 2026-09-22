// SPDX-License-Identifier: AGPL-3.0-only
import type { Step } from './agent.js'
import type { Phase, Size } from './router.js'

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

/**
 * **One stage of the wait, and how long it lasted** — the same {@link Phase} the screen turns
 * into a status line, kept here as a record of where the seconds went.
 *
 * The complaint this answers is *seventy seconds before the first word*, and the only number
 * there was to read was the seventy. A try is stamped when it *ends*, so a walk could not be
 * split into choosing, waiting on a busy model, and writing — and a fix aimed at the wrong one
 * of those is a fix that changes nothing. This splits it.
 *
 * Kept flat, as facts rather than a sentence: `detail` is the model asked or the tool run, and
 * the attempt for a retry, because *which* model was slow is the whole of the finding.
 */
export interface TracePhase {
  kind: Phase['kind']
  /** The model or the tool, and the attempt for `retrying`. Absent for `choosing` and `reading`. */
  detail?: string
  at: number
  /** Filled in when the next stage begins, or when the run ends. Absent is still going. */
  ms?: number
}

export interface Run {
  id: string
  /** The user's own line. It is what the run was for, so it is never paraphrased. */
  task: string
  at: number
  ended?: 'answered' | 'stopped' | 'ceiling' | 'refused' | 'paused'
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
  /**
   * How long the personality was, in characters, as the model was actually given it.
   *
   * **The reported bug was *the personality is not being sent* and it was being sent** — all
   * 221 characters of a document that should have been 5,825, because Adapt had saved half
   * one (D157). Neither the screen nor the trace could tell those two apart, so the first
   * guess was the wrong one. A number here separates them at a glance: `none sent` is the
   * fault that was reported, and a suspiciously small number is the fault that was there.
   *
   * Counted after trimming and zero when nothing was sent, because {@link system} trims it
   * and drops it when what is left is empty — so this is the length that reached the model,
   * not the length that was stored.
   *
   * **Every distinct length this run sent, in the order it first sent them.** D175 recorded
   * one number per run, on the grounds that a personality is read once per task and a per-step
   * number would print the same figure many times and imply it could have differed. §2's three
   * lengths are exactly that changing: the document is still read once, but *which of its three
   * sizes goes out* is decided for each model asked — so a task that falls back from a paid
   * model to a 2B router genuinely does send two different personalities, and one number here
   * would now be the misleading one.
   */
  personality?: { chars: number; size: Size }[]
  steps: TraceStep[]
  /**
   * **Where the time went**, stage by stage, in the order the stages began.
   *
   * Beside the steps rather than inside them, because most of the wait happens where no step
   * is: before the first tool call, a model is being chosen, asked, asked again and waited on,
   * and a run that needed no tool has no steps at all — only the wait. Absent on a run nothing
   * reported a stage for: one stopped before the loop began, or one started by a path that
   * does not report its stages — a plugin's task, which has no screen waiting on it.
   */
  phases?: TracePhase[]
  /**
   * Every charge this run made, from the ledger, looked up by the run's own id (M7-2).
   *
   * **Not a second tally.** These are the `usage` rows themselves, so what the trace says a
   * run cost and what the ledger says it cost cannot disagree — they are the same rows. It
   * replaced a difference across the run, which two tasks overlapping in time would split
   * between them, and which could say nothing at all about *which* call was the expensive one.
   */
  calls?: Charge[]
}

/** One model call and what it cost. `asked` differs from `model` when something fell back. */
export interface Charge {
  asked: string | null
  model: string
  provider: string
  cost: number
}

/** What a run cost. Summed from its charges, so there is one number and one source for it. */
export const spentOn = (run: Run): number => (run.calls ?? []).reduce((total, call) => total + call.cost, 0)

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

  /**
   * What personality a model call carries, in characters and in §2's own words.
   *
   * Told **per model asked**, because the loop picks a length for the model each call goes to.
   * Repeats collapse, so the common case — one length, fifteen steps — still reads as one
   * fact, and two entries mean a fallback genuinely changed what she was told.
   */
  personality(chars: number, size: Size): void {
    if (!this.#open) return
    const so = (this.#open.personality ??= [])
    // Distinct, in the order they first went out. A fifteen-step task that sends the same
    // length fifteen times is one entry, which is what makes several entries worth reading.
    if (!so.some((one) => one.chars === chars && one.size === size)) so.push({ chars, size })
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

  /**
   * **A stage began**, so the one before it is over and now has a length.
   *
   * Timed by the gap to the next stage rather than by anything a stage says about itself: every
   * stage is followed by another one or by the end, so the gaps add up to the whole wait, and
   * there is no second clock to keep in step with the first.
   *
   * **The same stage told twice is one stage.** A model reasoning is still the same model
   * reasoning when it says so again, and two rows for it would split one wait into two numbers
   * that each look smaller than the thing somebody came here to find. A retry is not a repeat —
   * its attempt is part of what it is — so five retries read as five, which is the point.
   *
   * `over` is a stage that finished before the run opened — the attachments, read before the
   * question is even written down — with its own start and length, so the time it took is
   * neither lost nor charged to whatever came next.
   */
  phase(phase: Phase, over?: { at: number; ms: number }): void {
    if (!this.#open) return
    const kept = (this.#open.phases ??= [])
    const detail = detailOf(phase)
    const last = kept.at(-1)
    if (last?.kind === phase.kind && last.detail === detail) return
    const at = over?.at ?? Date.now()
    if (last !== undefined) last.ms ??= at - last.at
    kept.push({ kind: phase.kind, ...(detail !== undefined && { detail }), at, ...(over !== undefined && { ms: over.ms }) })
  }

  end(ended: Run['ended'], extra: { why?: string; calls?: Charge[] } = {}): void {
    if (!this.#open) return
    // The last stage ends with the run. Left open, the stage the answer was written in would
    // read as *still going* on a run that has finished.
    const last = this.#open.phases?.at(-1)
    if (last !== undefined) last.ms ??= Date.now() - last.at
    this.#open.ended = ended
    if (extra.why !== undefined) this.#open.why = extra.why
    if (extra.calls !== undefined) this.#open.calls = extra.calls
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
    ...(run.ended === undefined ? [] : [spendLine(run)]),
    // Both, and only when they differ — a line saying the same model twice is a line that
    // trains people to skip the line.
    ...(run.answered !== undefined && run.asked !== undefined && run.asked !== run.answered ?
      [`asked ${run.asked}, answered ${run.answered} — the router fell back`]
    : run.answered !== undefined ? [`model ${run.answered}`]
    : []),
    // *Was it sent, and how much of it?* — the one question the last personality bug turned
    // on, and it was unanswerable from here.
    ...(run.personality === undefined ? [] : [personalityLine(run.personality)]),
    // Every charge, in order, and what each one was for. This is the line somebody came here
    // to read: a fallback costs more than the model on the badge, and this says which call.
    ...(run.calls ?? []).map(
      (call) =>
        `  $${call.cost.toFixed(4)}  ${
          call.asked !== null && call.asked !== call.model ?
            `asked ${call.asked}, answered ${call.model} — fell back`
          : call.model
        }`,
    ),
    ...(run.why !== undefined ? ['', run.why] : []),
  ]

  // The wait, before the steps it was spent around: *why did that take a minute* is usually
  // the question an export is sent to answer, and the steps cannot answer it on their own.
  if (run.phases !== undefined && run.phases.length > 0) {
    lines.push('', '## Where the time went', ...run.phases.map(phaseLine))
  }

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

/**
 * The fact that tells one stage of a kind from another — which model, which tool, which
 * attempt. Nothing for the two stages that are about no model: choosing one, and reading files.
 */
function detailOf(phase: Phase): string | undefined {
  switch (phase.kind) {
    case 'choosing':
    case 'reading':
      return undefined
    case 'retrying':
      return `${phase.model}, attempt ${String(phase.attempt)}`
    case 'asking':
    case 'backup':
    case 'thinking':
    case 'writing':
      return phase.model
    case 'tool':
      return phase.name
  }
}

/**
 * One stage and how long it lasted, in seconds to a tenth.
 *
 * Tenths, because the stages worth reading are seconds long: a millisecond column would be
 * noise that looked like precision, and a whole-second one would round a quick *choosing* to
 * nothing and hide it. Time first, like the charges above it, so the eye runs down one column.
 */
function phaseLine(phase: TracePhase): string {
  const took = phase.ms === undefined ? 'still going' : `${(phase.ms / 1000).toFixed(1)}s`
  return `  ${took}  ${phase.kind}${phase.detail === undefined ? '' : ` ${phase.detail}`}`
}

/**
 * The personality line, which says *sent* or *none sent* in as many words.
 *
 * It names the unit, because the number is only useful against the length of the document
 * somebody wrote — *221* beside a description they know ran to thousands is the whole story,
 * and *221 tokens* would be a different and wrong story.
 */
function personalityLine(sent: readonly { chars: number; size: Size }[]): string {
  const real = sent.filter((one) => one.chars > 0)
  if (real.length === 0) return 'personality: none sent'
  const said = real.map((one) => `${String(one.chars)} characters (${one.size})`)
  // Two lengths in one run is a fallback that changed the reader, and saying which way it
  // went is the whole reason the sizes exist. One is the ordinary case and reads as it did.
  return `personality: ${said.join(', then ')} sent`
}

/**
 * What it cost, and the honest sentence when there is nothing to join.
 *
 * A run with no charges is not a free run — it is a run where no model call was recorded,
 * which happens when the router refused before dispatch. `$0.0000` would read as *this was
 * free*, which is a different claim and sometimes a wrong one.
 */
function spendLine(run: Run): string {
  const calls = run.calls ?? []
  if (calls.length === 0) return 'no model call was recorded against this run'
  return `spent $${spentOn(run).toFixed(4)} across ${String(calls.length)} model call${calls.length === 1 ? '' : 's'}`
}
