// SPDX-License-Identifier: AGPL-3.0-only
import type { Step } from './agent.js'
import { redactSecrets } from './redact.js'
import type { Phase, Size } from './router.js'
import { RUNS_KEPT, type Store } from './store.js'

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
 * **Kept on disk now, and still not a permanent log.** D88 kept five runs in memory, gone on
 * restart, on the grounds that an empty history is honest for something never meant to be a
 * log. What that cost in practice was every *what was she doing an hour ago* after an update,
 * which restarts her — so a run is written to the store as it moves, and the Activity screen
 * reads the same list after a restart as before one. It is still bounded, which was the part
 * of D88 worth keeping: the newest {@link KEPT}, none older than thirty days (`RUNS_KEPT`),
 * the oldest dropped as new ones arrive. Export is still how one outlives that.
 *
 * **What is written is what the screen shows, less the credentials.** The same rule the store
 * already draws (`redact.ts`, M7-3): a key pasted into a task or printed by a tool is stripped
 * before it is recorded, in memory and on disk alike, and a location is not — it is fine to
 * write down and only dangerous when it leaves. A run left open by a crash is read back as
 * *stopped*, because that is what happened to it.
 */

/** How many runs are kept, in memory and on disk. */
export const KEPT = RUNS_KEPT.count

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
  /** When it ended. Absent while it is going. */
  until?: number
  /** The conversation it happened in, so the Activity screen can open it. */
  chat?: number
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
  /**
   * How long the user's profile (`memory.profile`) was, in characters, as the model was given
   * it — zero when something provides one and it said nothing. Absent when nothing provides one,
   * so a run with no memory plugin reads exactly as it did. One number, not a list: unlike the
   * personality it has one length for every model.
   */
  profile?: number
  steps: TraceStep[]
  /**
   * **Where the time went**, stage by stage, in the order the stages began.
   *
   * Beside the steps rather than inside them, because most of the wait happens where no step
   * is: before the first tool call, a model is being chosen, asked, asked again and waited on,
   * and a run that needed no tool has no steps at all — only the wait. Absent on a run nothing
   * reported a stage for: one stopped before the loop began.
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

/** Credentials out of a string, and nothing else (`redact.ts`, the storing door). */
const scrub = (text: string): string => redactSecrets(text).text

/** The same, through every string in a tool's arguments, so the shape of them survives. */
function scrubbed(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(scrubbed)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubbed(inner)]))
  }
  return value
}

/** Enough of a run to draw one, from a row that may have been written by an older build. */
const isRun = (value: unknown): value is Run =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Run).id === 'string' &&
  typeof (value as Run).task === 'string' &&
  typeof (value as Run).at === 'number' &&
  Array.isArray((value as Run).steps)

export class Trace {
  readonly #runs: Run[] = []
  #open?: Run
  readonly #store?: Store

  /**
   * With a store, the kept runs are read back and every new one is written as it moves. Without
   * one — the tests, a trial — it is the in-memory list it always was.
   */
  constructor(store?: Store) {
    this.#store = store
    if (!store) return
    let saved: unknown[] = []
    try {
      saved = store.savedRuns()
    } catch {
      // A history that cannot be read is an empty screen, never a core that will not start.
    }
    for (const run of saved.filter(isRun).slice(-KEPT)) {
      // **Open on disk means it was cut short**: nothing ends a run across a restart, so one
      // with no ending is one the app quit, crashed or was updated under. It reads as stopped,
      // and is written back that way, rather than as *still going* for the rest of its days.
      if (run.ended === undefined) {
        run.ended = 'stopped'
        run.until ??= run.steps.at(-1)?.at ?? run.at
        this.#save(run)
      }
      this.#runs.push(run)
    }
  }

  /** Written whole, and never allowed to break the task it is recording. */
  #save(run: Run): void {
    try {
      this.#store?.saveRun(run.id, run.at, run)
    } catch {
      // The record is a convenience for later; the task in front of somebody is not.
    }
  }

  /** Newest first, which is the order somebody reads them in. */
  get runs(): readonly Run[] {
    return [...this.#runs].reverse()
  }

  one(id: string): Run | undefined {
    return this.#runs.find((run) => run.id === id)
  }

  /**
   * A task begins. The previous one is closed off as stopped if something ended it without
   * saying so — left open, it would read as *still going* for as long as it was kept.
   */
  start(id: string, task: string, chat?: number): void {
    if (this.#open) this.end('stopped')
    this.#open = { id, task: scrub(task), at: Date.now(), ...(chat !== undefined && { chat }), steps: [] }
    this.#runs.push(this.#open)
    // Oldest out. A list that grows without bound in a process that never restarts is a leak
    // with a nicer name. The store drops its own oldest in the same breath as it writes.
    while (this.#runs.length > KEPT) this.#runs.shift()
    this.#save(this.#open)
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

  /** How much of the user's profile went out with this run. */
  profile(chars: number): void {
    if (!this.#open) return
    this.#open.profile = chars
  }

  step(step: Step): void {
    if (!this.#open) return
    // In error, not merely finished: a step that begins after a failure is the loop trying
    // something else, and saying so is what turns the list into a story.
    const before = this.#open.steps.at(-1)
    this.#open.steps.push({
      n: step.n,
      name: step.name,
      args: scrubbed(step.args) as Record<string, unknown>,
      at: Date.now(),
      ...(before?.ok === false && { backtrack: true }),
    })
    this.#save(this.#open)
  }

  done(step: Step): void {
    const found = this.#open?.steps.find((one) => one.n === step.n)
    if (!this.#open || !found || !step.outcome) return
    found.ok = step.outcome.ok
    found.text = scrub(step.outcome.text.slice(0, OUTPUT_MAX))
    found.ms = Date.now() - found.at
    this.#save(this.#open)
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
    this.#open.until = Date.now()
    if (extra.why !== undefined) this.#open.why = scrub(extra.why)
    if (extra.calls !== undefined) this.#open.calls = extra.calls
    this.#save(this.#open)
    this.#open = undefined
  }
}

/**
 * **Whether a model was ever asked** in this run: a stage that waited on one, a charge, or a
 * step, which only a model can have asked for.
 *
 * The loop ends two different things as `refused`: the router finding nothing to ask, and a
 * provider failing once it was asked. The second is not a refusal — nobody refused anything,
 * the service broke — and this is how the two are told apart without a second ending.
 */
const asked = (run: Run): boolean =>
  (run.calls ?? []).length > 0 ||
  run.steps.length > 0 ||
  (run.phases ?? []).some((phase) => phase.kind !== 'choosing' && phase.kind !== 'reading')

/**
 * **How a run ended, in words** — the Activity column and the export's first line. `refused`
 * was the loop's word for a provider failing too, and the screen said *refused* for a service
 * that had simply broken; this says what happened.
 */
export function ending(run: Run): string {
  switch (run.ended) {
    case undefined:
      return 'Still going'
    case 'answered':
      return 'Finished'
    case 'stopped':
      return 'Stopped'
    case 'ceiling':
      return 'Stopped at the step limit'
    case 'paused':
      return 'Paused for a paid model'
    case 'refused':
      return asked(run) ? 'The AI service failed' : 'No model could take it'
  }
}

/** `3 s`, `2 min 5 s` — how long, the way a person says it. */
export function took(ms: number): string {
  if (ms < 1000) return 'under a second'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`
}

/**
 * **A tool's name as a person reads it** — *take a picture of the whole screen and save it*,
 * not `computer__screenshot`.
 *
 * Taken from the tool's own description when there is one: its first clause, which is the
 * author's sentence for what the tool does — written for the model, and plain because of it.
 * Core writes no word about any plugin's tool here, so a plugin nobody has heard of reads as
 * well as a bundled one. Without a description, the name with its seams taken out.
 */
export function toolWords(name: string, description?: string): string {
  const first = (description ?? '').trim().split(/(?<=[.!?])\s|\n/)[0] ?? ''
  const clause = first.split(/[,;:(]| — /)[0]?.replace(/[.!?]+$/, '').trim() ?? ''
  if (clause !== '' && clause.length <= 70) {
    // Lower-case the first letter so it sits inside a sentence — unless it starts an acronym.
    return /^[A-Z][a-z]/.test(clause) ? clause.charAt(0).toLowerCase() + clause.slice(1) : clause
  }
  const cut = name.indexOf('__')
  return (cut === -1 ? name : name.slice(cut + 2)).replace(/[_.]+/g, ' ').trim()
}

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

/**
 * **The run in a few sentences** — what the Activity screen shows first, with the whole log
 * ({@link asText}) folded under it.
 *
 * *Answered by GPT-4o mini in 3 s. Used 1 tool: list the open windows.* The log answers every
 * question a developer has and few of the person who asked; this answers theirs — who answered,
 * how long it took, what she did and what it cost — in local time and plain words. `named`
 * turns a model id into its name and `tool` a tool's id into its words, from whatever the
 * caller knows; without them the ids stand.
 */
export function summary(
  run: Run,
  named: (model: string) => string = (model) => model,
  tool: (name: string) => string = (name) => toolWords(name),
): string {
  const lines: string[] = [
    new Date(run.at).toLocaleString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }),
  ]
  const long = run.until === undefined ? '' : took(run.until - run.at)
  const after = long === '' ? '' : ` after ${long}`
  switch (run.ended) {
    case undefined:
      lines.push('Still going.')
      break
    case 'answered':
      lines.push(`${run.answered === undefined ? 'Answered' : `Answered by ${named(run.answered)}`}${long === '' ? '' : ` in ${long}`}.`)
      break
    case 'stopped':
      lines.push(`Stopped${after}, before she had finished.`)
      break
    case 'ceiling':
      lines.push(`Stopped after ${String(run.steps.length)} steps, which is the most one task may take.`)
      break
    case 'paused':
      lines.push(`Paused${after}: the free models were used up, and a paid one needs your yes.`)
      break
    case 'refused':
      lines.push(asked(run) ? `The AI service failed${after}.` : 'No model could take this one.')
      break
  }
  if (run.why !== undefined && run.why.trim() !== '') lines.push(run.why.trim())
  // A fallback, said once and in names: the badge in the chat showed only who answered.
  if (run.asked !== undefined && run.answered !== undefined && run.asked !== run.answered) {
    lines.push(`${named(run.asked)} was asked first and could not answer, so ${named(run.answered)} did.`)
  }

  if (run.steps.length > 0) {
    // Each tool once, in the order it was first used, with how often when it was more than once.
    const uses = new Map<string, number>()
    for (const step of run.steps) uses.set(step.name, (uses.get(step.name) ?? 0) + 1)
    const said = [...uses].map(([name, n]) => (n > 1 ? `${tool(name)} (${String(n)} times)` : tool(name)))
    lines.push(`Used ${String(uses.size)} tool${uses.size === 1 ? '' : 's'}: ${listed(said)}.`)
    const failed = run.steps.filter((step) => step.ok === false).length
    const unfinished = run.steps.filter((step) => step.ok === undefined).length
    if (failed > 0) lines.push(`${String(failed)} ${failed === 1 ? 'step' : 'steps'} failed.`)
    if (unfinished > 0 && run.ended !== undefined) {
      lines.push(`${String(unfinished)} ${unfinished === 1 ? 'step' : 'steps'} never finished.`)
    }
  }

  const calls = run.calls ?? []
  if (run.ended !== undefined && calls.length > 0) {
    const spent = spentOn(run)
    lines.push(spent === 0 ? 'It cost nothing.' : `It cost $${spent.toFixed(4)}.`)
  }
  return lines.join('\n')
}

/**
 * One run as text, which is what *export* means here.
 *
 * The second thing anybody does with a bad run is send it to somebody, so what comes out is
 * something a person can read in a message rather than a shape another program would have to
 * parse. Nothing is summarised: the arguments and the answers are as they were.
 */
export function asText(run: Run): string {
  // Local time with its zone named, so a log sent to somebody elsewhere is still unambiguous.
  const when = new Date(run.at).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  })
  const lines = [
    `# ${run.task}`,
    '',
    `${when} · ${String(run.steps.length)} step${run.steps.length === 1 ? '' : 's'} · ${run.ended === undefined ? 'unfinished' : ending(run).toLowerCase()}`,
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
    // The same question about the one thing core reads back from memory.
    ...(run.profile === undefined ? []
    : [run.profile > 0 ? `profile: ${String(run.profile)} characters sent` : 'profile: none sent']),
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
    lines.push('', '## Where the time went', ...run.phases.map((phase) => phaseLine(phase, run.ended !== undefined)))
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
function phaseLine(phase: TracePhase, over: boolean): string {
  // A stage with no length on a run that has ended was cut short with it, not still going.
  const lasted = phase.ms !== undefined ? `${(phase.ms / 1000).toFixed(1)}s` : over ? 'did not finish' : 'still going'
  return `  ${lasted}  ${phase.kind}${phase.detail === undefined ? '' : ` ${phase.detail}`}`
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
