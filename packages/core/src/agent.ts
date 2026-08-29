// SPDX-License-Identifier: AGPL-3.0-only
import type { Ruling } from './permissions.js'
import { ProviderError, type ToolSpec } from './provider.js'
// The shape `notifications/progress` arrives in. It belongs to neither module, and it is one
// interface — a third file to hold it would be the abstraction, not the sharing.
import type { Progress } from './settings.js'
import { route, send, shapeOf, type Pins, type Shape, type World } from './router.js'
import type { SecretStore } from './secrets.js'
import type { Message, Store } from './store.js'
import { trim, type TrimOptions } from './trim.js'

/**
 * Plan → act → observe → repeat.
 *
 * The state is the conversation. There is no separate scratchpad, no plan object, no
 * step list held beside the messages: an assistant turn carrying `calls` *is* a plan, and
 * a `tool` turn answering one *is* an observation. That is not minimalism for its own
 * sake — it is what makes a reload show the same steps the user watched happen, and what
 * makes M15-6's trimming a question about messages rather than about two things that have
 * to be kept in step with each other.
 *
 * Three things here are load-bearing:
 *
 * - **Every step re-asks the router.** Not one model for the task — one per step. A free
 *   rung that ran out on step four does not fail the task on step five, and the mechanical
 *   steps do not pay for the planning step's tier.
 * - **The loop never names a plugin.** It is handed a `Tooling` and calls what that lists.
 *   Invariant 1 holds here by construction rather than by anybody remembering it.
 * - **A tool that fails is an observation, not an exception.** The failure goes back to the
 *   model as the answer to its call, because *the file is not there* is something to plan
 *   around. Only the user's stop and a router refusal end a task early.
 */

/**
 * What the model may call, and how to call it. The agent knows nothing else about plugins:
 * M15-2 supplies the real one over `tools/list`, and a test supplies a fake in four lines.
 */
export interface Tooling {
  /** Everything callable right now, already namespaced. Re-asked every step, on purpose. */
  list(): Promise<ToolSpec[]>
  /**
   * Run one.
   *
   * `onProgress` is how a step that takes four minutes says so while it is taking them
   * (M2-6). It is optional at both ends: a tool that reports nothing simply never calls it,
   * and a `Tooling` that cannot carry it — a fake in a test — is still one of these.
   */
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (update: Progress) => void,
  ): Promise<ToolOutcome>
}

export interface ToolOutcome {
  /** What the model reads back. A failure explains itself here rather than throwing. */
  text: string
  ok: boolean
}

/** One call the model made, and what came of it. The trace M15-5 draws is a list of these. */
export interface Step {
  /** 1-based, and it is what the ceiling counts. */
  n: number
  name: string
  args: Record<string, unknown>
  /** The last thing the tool said about how far along it is. Absent means it has said nothing. */
  progress?: Progress
  /** Absent until it comes back. */
  outcome?: ToolOutcome
}

export interface AgentEvents {
  /** The model's own words, as they arrive. A model narrating its plan is the good case. */
  delta?(text: string): void
  /** Core talking, not the model: a charge about to happen, a rung that ran out. */
  note?(line: string): void
  /**
   * Which model this turn asked for, and which one answered.
   *
   * **They differ, and here they differ for a reason core creates**: the router walks its
   * plan and a rung that says 429 hands the turn to the next one (M1-8). Every other surface
   * shows one model, so without this the fallback is invisible in the one place it could be
   * explained — which is the trace (M6-5).
   */
  turn?(models: { asked: string; answered: string }): void
  /** A call is about to run. Fired before the work, because that is the point of a trace. */
  step?(step: Step): void
  /**
   * The same step, still running, with something new to say about how far along it is (M2-6).
   *
   * **Silence is what kills a first run, not time.** A step that will take four minutes and
   * says nothing is indistinguishable from a step that has hung, and the person watching has
   * only one way to find out which.
   */
  progress?(step: Step): void
  /** The same step, now with its outcome. */
  done?(step: Step): void
}

export interface RunOptions {
  /** The conversation, ending with the line the user just sent. */
  messages: Message[]
  tools: Tooling
  pins: Pins
  /** Re-asked every step: a tier can be exhausted mid-task, which is the whole point. */
  world(): Promise<World>
  store: Store
  secrets: SecretStore
  /** Where the trace is written. Every message this produces is appended as it happens. */
  session: number
  /** The hard stop (M1-9). False and the paid rungs are not rungs at all. */
  paidAllowed?: boolean
  /**
   * The ceiling. M15-7 makes it editable and shows the cost before an expensive run; the
   * loop needs a bound from the first day regardless, because the failure without one is a
   * model calling the same tool until the month's budget is gone.
   */
  maxSteps?: number
  /**
   * How much trace the model is shown (M15-6). Re-applied every step, because the trace
   * grows under the loop — trimming once at the start would trim nothing.
   */
  trimming?: TrimOptions
  signal?: AbortSignal
  /**
   * May this call run? (M15-3.) The loop does not know what a permission is — it asks, and
   * treats every answer as something to plan around.
   */
  guard?(call: { name: string; args: Record<string, unknown> }): Ruling | Promise<Ruling>
  /** The user's decision on an `ask`. Absent means nobody is there to ask, so it is a no. */
  approve?(ruling: { verdict: 'ask'; why: string }): Promise<boolean>
  on?: AgentEvents
}

export interface RunResult {
  /** Everything the loop added, in order. Already appended to the store. */
  messages: Message[]
  steps: Step[]
  /** Why it ended. `answered` is the only one that is not a limit being hit. */
  ended: 'answered' | 'stopped' | 'ceiling' | 'refused'
  /** Set when `ended` is `refused` — the router's sentence, or the provider's. */
  why?: string
}

/** High enough that no honest task meets it; low enough that a loop cannot bankrupt anyone. */
export const MAX_STEPS = 24

export async function run(options: RunOptions): Promise<RunResult> {
  const { store, secrets, session, tools, pins, on } = options
  const ceiling = options.maxSteps ?? MAX_STEPS
  const messages = [...options.messages]
  const added: Message[] = []
  const steps: Step[] = []

  // The shape of the *request*, read once from the user's words. Every step after the
  // first is turning the crank on a plan that already exists, which is a different and
  // much cheaper job — see `Ask.shape`.
  const planning = shapeOf({ messages })
  let shape: Shape = planning

  for (;;) {
    if (options.signal?.aborted) return finish('stopped')

    const available = await tools.list()
    const ask = {
      messages,
      shape,
      ...(available.length > 0 && { tools: available.map((t) => ({ name: t.name })) }),
    }
    const verdict = route(ask, pins, await options.world())
    // A pin with nothing behind it is a sentence, never a quiet reach for something else.
    // Mid-task it is also the honest place to stop: half a task is better than a task
    // finished somewhere the user said not to go.
    if (!verdict.ok) return finish('refused', verdict.why)

    let answer
    try {
      answer = await send(
        verdict.choices,
        {
          // Trimmed here rather than in the store: what is kept is what a model is shown,
          // and the history itself stays whole so a reload shows every step that happened.
          messages: [system(available), ...trim(messages, options.trimming)],
          ...(available.length > 0 && { tools: available }),
          ...(options.signal && { signal: options.signal }),
        },
        store,
        secrets,
        {
          session,
          ...(options.paidAllowed !== undefined && { paidAllowed: options.paidAllowed }),
          ...(on?.delta && { onDelta: on.delta }),
          ...(on?.note && { onNote: on.note }),
        },
      )
    } catch (error) {
      // The user pressing stop arrives here as an abort, and it is not a failure.
      if (options.signal?.aborted) return finish('stopped')
      throw error
    }

    // The plan's first rung is what was asked for; `answer.model` is whoever took it.
    on?.turn?.({ asked: verdict.choices[0]?.model.id ?? answer.model.id, answered: answer.model.id })

    messages.push(answer.message)
    added.push(answer.message)
    store.append(session, answer.message)

    const calls = answer.message.calls ?? []
    if (calls.length === 0) return finish('answered')

    // Every call this turn asked for, then back around. The model gets all of the results
    // at once, which is what it asked for by making the calls in one turn.
    let failed = false
    for (const call of calls) {
      if (options.signal?.aborted) return finish('stopped')
      if (steps.length >= ceiling) return finish('ceiling')

      const step: Step = { n: steps.length + 1, name: call.name, args: parse(call.arguments) }
      steps.push(step)
      on?.step?.(step)

      const outcome = await permitted(step)
      step.outcome = outcome
      failed ||= !outcome.ok
      on?.done?.(step)

      const result: Message = { role: 'tool', callId: call.id, content: outcome.text }
      messages.push(result)
      added.push(result)
      store.append(session, result)
    }

    // Turning the crank is cheap work and gets a cheap model. Recovering is not: a tool
    // that failed — including one whose plugin was deleted out from under the task, which
    // is invariant 4 — means the plan was wrong, and re-planning is the expensive step the
    // user is actually paying for. So a failure buys back the planning tier for one turn.
    shape = failed ? planning : 'tools'
  }

  /**
   * The gate, and then the call.
   *
   * A refusal is an outcome, not an exception — the same as a tool that failed. *You are not
   * allowed to do that* is information the model can plan around, and stopping the whole task
   * on it would turn every careful permission setting into a broken assistant. The one thing
   * it must never be is silent: what comes back is the reason, in the words the user would
   * read, so the answer at the end can say what it could not do.
   */
  async function permitted(step: Step): Promise<ToolOutcome> {
    const ruling = (await options.guard?.({ name: step.name, args: step.args })) ?? { verdict: 'run' }
    if (ruling.verdict === 'blocked') return { ok: false, text: ruling.why }
    if (ruling.verdict === 'ask') {
      const said = await options.approve?.(ruling)
      if (said !== true) {
        return {
          ok: false,
          text: `Not allowed: ${ruling.why} The user did not approve it, so it did not run.`,
        }
      }
    }
    return tools.call(step.name, step.args, options.signal, (update) => {
      step.progress = update
      on?.progress?.(step)
    })
  }

  function finish(ended: RunResult['ended'], why?: string): RunResult {
    return { messages: added, steps, ended, ...(why !== undefined && { why }) }
  }
}

/**
 * Arguments as the model sent them. A model that emits malformed JSON is common enough at
 * the small end that it cannot be an exception: the empty object goes to the tool, the
 * tool says what it needed, and that sentence is what the model gets to plan around.
 */
function parse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ?
        (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The standing instruction, rebuilt every step because the tool list changes under it.
 *
 * It is not stored with the conversation: it is not something anybody said, and a system
 * line frozen into the history at the moment a plugin happened to be installed would still
 * be describing that plugin a week after it was deleted.
 *
 * Deliberately short. A small local model has limited context and spends it badly on
 * instructions it half-follows, and everything a longer prompt would buy — what a tool
 * does, what it needs — belongs in the tool descriptions, where the model actually looks.
 * Nothing here claims a capability: what is true about tools is whatever `available` says.
 */
function system(available: ToolSpec[]): Message {
  const lines = [
    'You are Alexia, an assistant running on the user’s own machine.',
    available.length > 0 ?
      'You have tools. Call them when they would help, one step at a time, and use what comes back.'
    : 'You have no tools available right now, so answer from what you know.',
    'When a tool fails, read the error and try a different approach rather than repeating the call.',
    'Stop calling tools and answer as soon as you can. Say what you did, briefly.',
  ]
  return { role: 'system', content: lines.join(' ') }
}

/** A provider error the loop could not route around, in the words the user gets. */
export const said = (error: unknown): string =>
  error instanceof ProviderError || error instanceof Error ? error.message : String(error)
