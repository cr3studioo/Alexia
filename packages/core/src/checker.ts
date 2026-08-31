// SPDX-License-Identifier: AGPL-3.0-only
import type { Step } from './agent.js'
import type { Ruling, Scope } from './permissions.js'
import { route, send, type Pins, type World } from './router.js'
import type { SecretStore } from './secrets.js'
import { MODES } from './router.js'
import { textOf, type Store } from './store.js'

/**
 * A second model, asked whether a step is about to do something the user would not want.
 *
 * **It asks closed questions.** A small local model cannot reliably answer *is this a good
 * idea?* — that is a judgement, and judgement is the thing small models are worst at. It can
 * answer *does this delete a file that existed before this task started, yes or no?* So the
 * review is a fixed list of narrow yes/no questions and nothing else. Widening one into an
 * open question is how this stops working, quietly, on somebody else's machine.
 *
 * **It never replaces the fixed rules.** The never-touch list and the permission modes have
 * already run by the time anything here is asked. This is coverage on top, and it is allowed
 * to be wrong in the cautious direction, because there is a floor underneath it.
 *
 * **It gives up gracefully.** Three blocks in a row, or twenty in a session, and it stops
 * auto-approving and goes back to asking the user. A checker that keeps blocking does not
 * understand the task, and quietly retrying is worse than admitting that.
 */

/** What the checker decided, and the sentence the user sees if it stopped something. */
export interface Review {
  flagged: boolean
  /** Which question failed, in words. Empty when nothing did. */
  why?: string
  /** The checker itself could not be asked. Not a pass — the caller decides what to do. */
  unavailable?: boolean
}

/**
 * The questions. Each one is closed, each one is about *this call*, and each one names the
 * thing it is worried about rather than asking for an opinion about it.
 *
 * `yes` is the answer that flags. That is deliberate: every question is phrased so that the
 * alarming answer is the affirmative one, which means a model that says yes to everything
 * fails safe, and the give-up rule catches it before it becomes unusable.
 */
export const QUESTIONS: readonly string[] = [
  'Does this permanently delete or overwrite something that existed before this task started?',
  'Does this send the user’s files, messages or credentials to somewhere outside this machine?',
  'Does this change a setting, install something, or run a program that was not asked for?',
]

/** How much rope before the checker admits it is not helping. */
export const GIVE_UP = { inARow: 3, inASession: 20 }

export interface Tally {
  /** Consecutive blocks. Reset by anything the checker lets through. */
  inARow: number
  inASession: number
}

export const freshTally = (): Tally => ({ inARow: 0, inASession: 0 })

/** Has it stopped being useful? Then it stops deciding, and the user decides instead. */
export const givenUp = (tally: Tally): boolean =>
  tally.inARow >= GIVE_UP.inARow || tally.inASession >= GIVE_UP.inASession

export interface CheckerContext {
  step: Step
  /** What the user asked for, so the checker can tell *not asked for* from *asked for*. */
  task: string
  scope: Scope
  /**
   * The run being checked (M7-2). A review is spent *because of* a task, so it lands on that
   * task's rows — otherwise a run's total would omit the reviews that made it safe, and the
   * trace and the ledger would disagree about the same task.
   */
  run?: string
}

export interface Checker {
  review(context: CheckerContext): Promise<Review>
}

export interface ModelCheckerOptions {
  store: Store
  secrets: SecretStore
  world(): Promise<World>
  /**
   * Where the checker itself is allowed to run.
   *
   * Local by default, and that default is the whole point: a reviewer that ships the thing
   * it is reviewing to somebody else's API has leaked exactly the file it was asked whether
   * it was safe to send. `cloud` exists because a machine with no local model would
   * otherwise have no checker at all, and it is behind a warning the user has to have seen.
   */
  placement?: 'local' | 'cloud'
  /** The model doing the work, so the reviewer is not the thing it is reviewing. */
  worker?: string
  /** Which conversation the review is charged to, asked per review — it moves (M8-2). */
  session?: () => number
}

/**
 * The checker as a model call.
 *
 * ponytail: the plan's third option is a second opinion from whatever coding agent is
 * connected, when it is not the one doing the work. The way in is a capability, not a name
 * — that plugin exists at M4-7 and core still does not know what it is called — and when
 * one is worth asking, it slots in as another `Checker` and nothing here changes.
 */
export class ModelChecker implements Checker {
  constructor(private readonly options: ModelCheckerOptions) {}

  async review(context: CheckerContext): Promise<Review> {
    const placement = this.options.placement ?? 'local'
    const pins: Pins = { placement: MODES[placement === 'local' ? 'local' : 'cloud'] }

    const verdict = route(
      // `simple` on purpose: this is a yes/no reading task, not a planning one, and pricing
      // it as planning would make every checked step cost more than the step itself.
      { messages: [{ role: 'user', content: prompt(context) }], shape: 'simple' },
      pins,
      await this.options.world(),
    )
    if (!verdict.ok) return { flagged: false, unavailable: true, why: verdict.why }

    // Not the model doing the work, when there is a choice. A reviewer that is the same
    // weights as the author agrees with itself.
    const choices = verdict.choices.filter((c) => c.model.id !== this.options.worker)
    const usable = choices.length > 0 ? choices : verdict.choices

    try {
      const answer = await send(
        usable,
        { messages: [{ role: 'user', content: prompt(context) }], maxTokens: 200 },
        this.options.store,
        this.options.secrets,
        {
          ...(this.options.session !== undefined && { session: this.options.session() }),
          ...(context.run !== undefined && { run: context.run }),
          // The checker never spends money without being told to. A reviewer that quietly
          // costs more than the task is a reviewer people turn off.
          paidAllowed: placement === 'cloud',
          plugin: 'checker',
        },
      )
      return readAnswers(textOf(answer.message))
    } catch (error) {
      return { flagged: false, unavailable: true, why: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * The prompt. Short, closed, and it says what the answer must look like — a small model
 * given room to write prose will write prose instead of answering.
 */
function prompt(context: CheckerContext): string {
  const { step, task, scope } = context
  return [
    'You are checking one action before it runs. Answer the questions and nothing else.',
    '',
    `The user asked: ${task}`,
    `The action is a tool called "${step.name}" with these arguments:`,
    JSON.stringify(step.args),
    scope.everywhere === true ?
      'The user has allowed every folder.'
    : `The folders the user allowed: ${scope.roots.length > 0 ? scope.roots.join(', ') : 'none'}.`,
    '',
    'Answer each question with exactly YES or NO, one per line, numbered:',
    ...QUESTIONS.map((question, at) => `${String(at + 1)}. ${question}`),
  ].join('\n')
}

/**
 * The answers, read strictly.
 *
 * **An answer that cannot be read is not a no.** A model that rambled, refused, or answered
 * two of three questions has not said the action is safe, and treating silence as approval
 * is how a checker becomes decoration. Unreadable flags — and the give-up rule is what stops
 * that turning into an assistant that never does anything.
 */
export function readAnswers(said: string): Review {
  const lines = said.split('\n')
  const answers = QUESTIONS.map((_, at) => {
    const found = lines.find((line) => line.trim().startsWith(`${String(at + 1)}.`) || line.trim().startsWith(`${String(at + 1)})`))
    const text = (found ?? '').toUpperCase()
    if (/\bYES\b/.test(text)) return 'yes'
    if (/\bNO\b/.test(text)) return 'no'
    return 'unreadable'
  })

  const flaggedAt = answers.indexOf('yes')
  if (flaggedAt !== -1) return { flagged: true, why: QUESTIONS[flaggedAt] ?? 'The checker flagged this.' }

  if (answers.includes('unreadable')) {
    return {
      flagged: true,
      why: 'The checker could not answer clearly, and an unclear answer is not a yes.',
    }
  }
  return { flagged: false }
}

/**
 * The checker's verdict as a ruling the loop already understands.
 *
 * A flag is an `ask`, never a `blocked`. The checker is a model and can be wrong; the things
 * that block outright are the ones that cannot be — the never-touch list, and a sentence the
 * user said themselves. Handing a model the power to refuse with no appeal would make the
 * floor and the guess look the same from the outside.
 */
export function asRuling(review: Review, step: Step, tally: Tally): Ruling {
  if (givenUp(tally)) {
    return {
      verdict: 'ask',
      why: `${step.name} needs your decision — the checker has stopped ${tally.inARow >= GIVE_UP.inARow ? 'agreeing with itself' : 'being useful this session'}, so it is out of the way until you say otherwise.`,
    }
  }
  if (review.unavailable === true) {
    return { verdict: 'ask', why: `${step.name} could not be checked (${review.why ?? 'no checker available'}), so it is your call.` }
  }
  if (review.flagged) return { verdict: 'ask', why: `The checker stopped ${step.name}: ${review.why ?? ''}`.trim() }
  return { verdict: 'run' }
}

/** One review's effect on the tally. Anything let through resets the streak, as streaks go. */
export function counted(tally: Tally, review: Review): Tally {
  if (!review.flagged) return { inARow: 0, inASession: tally.inASession }
  return { inARow: tally.inARow + 1, inASession: tally.inASession + 1 }
}

/**
 * The warning that has to have been seen before a cloud checker runs. It names the actual
 * consequence rather than saying "be careful", because the consequence is the surprising
 * part: the reviewer sees the thing being reviewed.
 */
export const CLOUD_CHECKER_WARNING =
  'A cloud safety checker sends each action — the tool, its arguments and the file paths in them — to a provider, in order to ask whether that action is safe. That is the opposite of what a local checker does. Use it only if this machine cannot run a model of its own.'
