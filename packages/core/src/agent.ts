// SPDX-License-Identifier: AGPL-3.0-only
import type { Ruling } from './permissions.js'
import { FASTEST_STAR_WAIT, MOST_AT_ONCE, ProviderError, type ToolSpec } from './provider.js'
import { spent, underHalf, type Speed } from './pool.js'
// The shape `notifications/progress` arrives in. It belongs to neither module, and it is one
// interface — a third file to hold it would be the abstraction, not the sharing.
import type { Progress } from './settings.js'
import {
  bubble,
  paid,
  route,
  send,
  shapeOf,
  sizedFor,
  sizeFor,
  type Ask,
  type Bubble,
  type Choice,
  type Mode,
  type Personality,
  type Phase,
  type Pins,
  type Shape,
  type Size,
  type Switch,
  type Tier,
  type World,
} from './router.js'
import type { SecretStore } from './secrets.js'
import { carries, textOf, type Message, type Store } from './store.js'
import { budgetFor, trim, type TrimOptions } from './trim.js'
import { affordable, type Today } from './usage.js'

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

/**
 * A file a tool made, and is handing back.
 *
 * **MCP's own `resource_link` is the whole of the wire for this** — a block type the
 * standard already defines, arriving inside a `CallToolResult` that
 * `packages/protocol/src/methods.ts` deliberately declines to re-read. So nothing new is
 * sent, no `alexia/*` method is added, and `alexia_protocol` does not move: a plugin that
 * emits none behaves exactly as it did, which is that file's own bar for not bumping.
 *
 * The gap this closes was already open and already costing something. A plugin that
 * generates a picture finished its work and returned the path *as prose*; so did one that
 * takes a screenshot. Both were correct and neither was usable — a person reading the answer
 * got a sentence with a path in it, and no way to open, save or find the thing it named.
 *
 * (Which plugins those are is not core's business and is deliberately not written here —
 * invariant 1, which caught the first draft of this very comment.)
 */
export interface Produced {
  /** What to call it on screen. The file's own name unless the tool said otherwise. */
  name: string
  /** Absolute, on this machine. It never reaches a caller as something to ask core for. */
  path: string
  bytes: number
  mime: string
}

export interface ToolOutcome {
  /** What the model reads back. A failure explains itself here rather than throwing. */
  text: string
  ok: boolean
  /** Files the tool handed back, if it handed any back. Absent is the ordinary case. */
  files?: Produced[]
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
  /** Another model is answering this turn, and why (§4 G). Also kept on the message as a note. */
  switch?(event: Switch): void
  /** The line before a charge, for a place of its own (§4 G). */
  paid?(line: string): void
  /** **What the loop is doing right now** — choosing, asking, retrying, thinking — for the line under the question. */
  phase?(phase: Phase): void
  /**
   * **The words streamed since the last turn began are void** (D155): the model writing them
   * stopped partway, and the answer is starting again on the next one.
   */
  restart?(): void
  /**
   * Which model this turn asked for, which one answered, and **what state that leaves the
   * user in** (§8.4).
   *
   * **The first two differ, and here they differ for a reason core creates**: the router walks
   * its plan and a rung that says 429 hands the turn to the next one (M1-8). Every other
   * surface shows one model, so without this the fallback is invisible in the one place it
   * could be explained — which is the trace (M6-5).
   *
   * The bubble is on this event rather than on the result for the same reason: it is a
   * property of *whoever actually answered*, which is known here and nowhere downstream. A
   * screen that recomputed it from a model id would be guessing at the rung.
   */
  turn?(models: { asked: string; answered: string; bubble: Bubble }): void
  /** A call is about to run. Fired before the work, because that is the point of a trace. */
  step?(step: Step): void
  /**
   * **How much personality a model was given**, in characters, and which of §2's three lengths
   * that was. Fired for every rung actually asked — once a step when the first answers, again
   * when a fallback is asked — because the length is chosen for the model it goes to.
   */
  personality?(chars: number, size: Size): void
  /**
   * **How much of the user's profile went out**, in characters, once per run and only when there
   * was one. Once rather than per rung, because unlike the personality it has one length.
   */
  profile?(chars: number): void
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

/**
 * The default ceiling on one billed reply, in tokens.
 *
 * Eight times what `preview.ts` budgets for a step's output — a figure that file already
 * calls a deliberate overestimate. Generous on purpose: this number exists to bound an
 * unknown cost, not to shorten anybody's answer, and a ceiling that clips real replies gets
 * paid for twice, once in money and once in a truncated answer nobody asked for.
 */
export const REPLY_CEILING = 2_000

/**
 * **The favourite and one partner, started together** — Balanced speed, when the record says the
 * favourite was busy or slow to start a moment ago (`shaky` in `health.ts`). One partner rather
 * than {@link MOST_AT_ONCE}: somebody who did not ask for speed spends one extra free request, not
 * two, and only on a model that has lately needed a backup anyway.
 */
const SHAKY_AT_ONCE = 2

export interface RunOptions {
  /** The conversation, ending with the line the user just sent. */
  messages: Message[]
  /** Nobody at the screen is waiting: a plugin's task (§4 F). The chat keeps first claim on free requests. */
  background?: boolean
  /** Models not to ask in this task, keyed `provider\nmodel` — the one just marked a bad answer (§4 I). */
  avoid?: string[]
  /**
   * **The Models screen's speed switch** (`pool.ts`), read by the caller rather than here so the
   * loop never reads the store for it. Absent is `balanced`.
   */
  speed?: Speed
  /** Every step above this tier — *Bad answer* with the paid switch on asks a smarter model (§4 I). */
  above?: Tier
  /**
   * **The floor the asking plugin declared** — `min_tier` in its manifest (M8-1). Absent for a
   * task from the window, which is nobody's plugin and has no floor but `T0`.
   */
  minTier?: Tier
  /**
   * **The asking plugin wants a capable model, not the cheapest that fits** (M8-1), read from
   * MCP's `modelPreferences`. Carried on every step, because a fallback mid-task is the case
   * it exists for: a plugin that asked for one real model does not want step nine handed to a
   * router because step eight was busy.
   */
  capable?: boolean
  tools: Tooling
  pins: Pins
  /** Re-asked every step: a tier can be exhausted mid-task, which is the whole point. */
  world(): Promise<World>
  store: Store
  secrets: SecretStore
  /** Where the trace is written. Every message this produces is appended as it happens. */
  session: number
  /**
   * This task's id, so every charge it makes lands on a row that says which task made it
   * (M7-2). A session is not a run: ten tasks in one sitting share a session.
   */
  run?: string
  /**
   * Who asked for it, when that is not the person at the keyboard (M7-5).
   *
   * Absent for a task from the window, which is nobody's plugin. Present when a plugin asked
   * for one, so *which plugin is costing me money* keeps its answer on the path that did not
   * exist when `usage.plugin` was added.
   */
  plugin?: string
  /** The hard stop (M1-9). False and the paid rungs are not rungs at all. */
  paidAllowed?: boolean
  /**
   * The ceiling. M15-7 makes it editable and shows the cost before an expensive run; the
   * loop needs a bound from the first day regardless, because the failure without one is a
   * model calling the same tool until the month's budget is gone.
   */
  maxSteps?: number
  /**
   * The ceiling on one billed reply, in tokens. Defaults to {@link REPLY_CEILING}, and only
   * ever reaches the wire when a rung that charges is in the plan.
   */
  maxTokens?: number
  /**
   * How much trace the model is shown (M15-6). Re-applied every step, because the trace
   * grows under the loop — trimming once at the start would trim nothing.
   */
  trimming?: TrimOptions
  /**
   * The chosen personality, already resolved (M4-4), **in its three lengths** (§2, D160).
   *
   * Read once per task by whoever calls this, because a plugin asked every step is a plugin
   * woken twenty-four times to say the same sentence — and a personality that changed halfway
   * through a task would be worse than one that did not. **Which of the three goes out is
   * decided per model asked**, and that is not the same thing: the document does not change,
   * but the model does, and the one a fallback lands on may be a 2B router that cannot hold six
   * hundred words. `sizeFor` picks for each rung as `send` reaches it.
   */
  personality?: Personality
  /**
   * **What the user has asked to be known about them** (`memory.profile`), already resolved and
   * bounded by whoever provides it. Read once per task for the same reason the personality is,
   * and placed in front of it by {@link system}.
   */
  profile?: string
  /**
   * **Whether a long-term memory exists** to be looked in (`memory.recall`). It adds one sentence
   * to the floor telling the model to check before saying it does not know something about the
   * user — which is the whole fix for *who am I?* answered *I don't know you* with the answer one
   * tool call away. Only said when there are tools, because a sentence pointing at a tool the
   * model was not given is a sentence it can only fail to obey.
   */
  remembers?: boolean
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
  /**
   * Why it ended. `answered` is the only one that is not a limit being hit. `paused` is the free
   * models done with a paid one able to answer and the paid switch off (§4 H): *Allow switching
   * to a paid model* carries on from where it stopped.
   */
  ended: 'answered' | 'stopped' | 'ceiling' | 'refused' | 'paused'
  /** Set when `ended` is `refused` — the router's sentence, or the provider's. */
  why?: string
  /**
   * Set when `ended` is `refused`: whose choice the plan was (D155). A stop in `sequence` or
   * `pinned` is the person's own choice ending, and it can offer *Use Automatic for this
   * answer*; a stop in `automatic` has already asked everything there was.
   */
  mode?: Mode
}

/** High enough that no honest task meets it; low enough that a loop cannot bankrupt anyone. */
export const MAX_STEPS = 24

/**
 * **How badly is this going?** (§10.3.)
 *
 * The reframe this whole file's escalation rests on: **measure struggle, do not predict
 * difficulty.** Difficulty was being guessed from the user's words — `HARD` in `router.ts`,
 * plus *is it over 400 characters* — and no regex fixes that and no classifier does either,
 * because the difficulty is not in the sentence. *Open a calculator and screenshot it* reads
 * hard and is trivial; *fix this bug* reads trivial and is three hours.
 *
 * The loop knows what the sentence could not. By step six it has watched the work happen, and
 * these five signals are what it has seen — every one of them read off {@link Step}s that
 * already exist, none of them reading a word the user typed.
 *
 * **The honest limit** (§10.8): this catches **looping and thrashing**. It does not catch the
 * *confidently wrong* model — one making smooth, plausible progress towards a wrong answer.
 * No telemetry sees that; only a checker or the person reading the answer does, and that is
 * `checker.ts`'s problem rather than this one's. A signal here firing is evidence; a signal
 * here staying quiet is not a clean bill of health.
 */
export type Struggle = 'looping' | 'stuck' | 'spinning' | 'grinding' | 'expensive'

/**
 * The fraction of a leash that counts as *this is not working*, for both the step ceiling and
 * the task's money.
 *
 * §10.5 names it for the budget — *when a task has burned ~40% of its budget without
 * finishing, that is the evidence* — and §10.3 leaves the step one as *a fraction of
 * `maxSteps`*. One number for both, because two would be a table nobody keeps in step and
 * neither is measured closely enough to deserve its own. Against the default ceiling it is
 * ten steps, which is twice §10.4's *waste ~5 cheap steps detecting struggle*.
 */
const NOT_WORKING = 0.4

/** Consecutive failures of one tool that mean stuck, and consecutive dull steps that mean spinning. */
const IN_A_ROW = 3

/** A call, exactly as it was made. The whole of signal one, and it is a string compare. */
const signature = (step: Step): string => `${step.name}(${JSON.stringify(step.args)})`

/**
 * Which signal is showing, if any — in §10.3's own order, which is also cheapest-first.
 *
 * A function over the steps rather than a watcher holding state: everything it needs is
 * already on the trace, and a second copy of the trace kept beside the trace is the thing
 * that goes out of step with it.
 */
export function struggling(loop: {
  steps: readonly Step[]
  /** `maxSteps`, for the grinding signal. */
  ceiling: number
  /** Dollars this task may spend, and what it has spent. Zero budget means no signal, not a fired one. */
  budget: number
  spent: number
}): Struggle | undefined {
  const { steps, ceiling, budget, spent } = loop
  const last = steps.at(-1)

  // **Looping.** Same tool, same arguments, twice — exact rather than heuristic, and it
  // catches most of the *loops for hours* case on its own. Asked of the newest step only,
  // because this runs after every one of them and the older pairs were already caught.
  if (last && steps.slice(0, -1).some((step) => signature(step) === signature(last))) return 'looping'

  const tail = steps.slice(-IN_A_ROW)
  // **Stuck.** One tool, three failures running. Different arguments each time is still stuck:
  // what is not working is the tool, and the model is trying to argue with it.
  if (
    tail.length === IN_A_ROW &&
    tail.every((step) => step.outcome?.ok === false && step.name === tail[0]?.name)
  ) {
    return 'stuck'
  }

  /**
   * **Spinning.** Three steps running that came back with nothing the loop had not already
   * been told.
   *
   * §10.3 writes this as *N steps, nothing new touched*, and *touched* is read here as what
   * came back rather than as which tools were used: a task that reads one file repeatedly is
   * working, and a task collecting answers it already has is not. Different calls returning
   * identical text is exactly the case the exact signal above cannot see.
   */
  if (tail.length === IN_A_ROW) {
    const older = steps.slice(0, -IN_A_ROW).map((step) => step.outcome?.text)
    if (tail.every((step) => step.outcome !== undefined && older.includes(step.outcome.text))) return 'spinning'
  }

  // **Grinding.** Far enough into the leash that the leash is now the story. Free to detect —
  // it is a length — and it is the signal that fires on a task going nowhere quietly.
  if (steps.length >= ceiling * NOT_WORKING) return 'grinding'

  /**
   * **Expensive**, and this is §10.5's doorway rather than a wall.
   *
   * The objection to a per-task cap is that a cheap model burns it looping and then fails —
   * which is correct, *if the cap is a wall*. So it is a trigger: 40% of the budget spent
   * with nothing finished is not a reason to stop, it is the evidence that cheap is not
   * working, and the remaining 60% goes on one attempt with something better. Same budget,
   * opposite outcome. **The waste becomes the signal.**
   *
   * A budget of nothing is no signal at all, not a signal that has already fired: a task with
   * no allowance behind it has spent none of it and has nothing to escalate into.
   */
  if (budget > 0 && spent >= budget * NOT_WORKING) return 'expensive'
  return undefined
}

/** What just happened, in the words of somebody watching it happen. One line, before the change. */
const WHY: Record<Struggle, string> = {
  looping: 'That call has come back twice with the same arguments, so the next plan goes to a better model.',
  stuck: 'That tool has failed three times running, so the next plan goes to a better model.',
  spinning: 'The last few steps turned up nothing new, so the next plan goes to a better model.',
  grinding: 'This is taking a lot of steps, so the next plan goes to a better model.',
  expensive:
    'This has spent much of what the task had and is not finished, so the rest goes on one attempt with a better model.',
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { store, secrets, session, tools, pins, on } = options
  const ceiling = options.maxSteps ?? MAX_STEPS
  /**
   * A caller's own standing lines, lifted out of the trace and into the one system turn.
   *
   * A plugin holding a conversation somewhere else sends a `systemPrompt` with its task
   * (M7-5), and it arrived as a **second `system` message after the first** — so a chosen
   * personality was followed, every single step, by a plain *you are Alexia* from the
   * plugin, and later wins. It read exactly like a personality being ignored, and on the
   * one surface where nobody can open the settings screen to check.
   *
   * So there is one system turn again: Alexia's floor, then the caller's context, then what is
   * known about the user, then the personality last, which is the order {@link system} promises.
   */
  const standing = options.messages.filter((m) => m.role === 'system').map((m) => textOf(m))
  const messages = options.messages.filter((m) => m.role !== 'system')
  // The profile is one length for every model, so it is said once, here, rather than per rung.
  const profile = options.profile?.trim() ?? ''
  if (profile !== '') on?.profile?.(profile.length)
  const about = { profile, remembers: options.remembers === true }
  const added: Message[] = []
  const steps: Step[] = []

  // The shape of the *request*, read once from the user's words. Every step after the
  // first is turning the crank on a plan that already exists, which is a different and
  // much cheaper job — see `Ask.shape`.
  const planning = shapeOf({ messages })
  let shape: Shape = planning

  /**
   * **What the task has escalated past**, once it has (§10.6).
   *
   * The work here was never *build escalation*. {@link Ask.above} has existed since the
   * router did — it is what the *try that again with a smarter model* button sets — and every
   * step already re-asks the router, so changing what the task asks for mid-task **is** the
   * architecture. All that was missing is the loop firing the pin itself when it can see the
   * work going badly.
   *
   * Latched rather than recomputed each step: a signal that was true on step six is still
   * true on step seven, and re-firing it would only write the same sentence into the log a
   * second time.
   */
  let above: Tier | undefined
  /** Whoever answered last — what *better than this* is measured against. */
  let answered: Tier | undefined
  /**
   * Where the day's money stood when this task opened.
   *
   * **The task's purse is what the day had left when it started.** There is no per-task cap
   * setting and this does not add one: a second number to keep in step with MP-5's allowance
   * would drift, and one that let every task spend the whole allowance would not be a cap at
   * all. Read once, because a purse that grew when the allowance was raised mid-task would
   * quietly move the 40% line under a task already measuring itself against it.
   */
  let opening: Today | undefined

  for (;;) {
    if (options.signal?.aborted) return finish('stopped')

    /**
     * **Choosing, said before it happens.** Every step re-asks the router, and the router reads
     * a fresh world first — what is installed here, which keys are saved, thirty days of tries —
     * so the first thing a step does is quiet work nobody can see. Said here, it is the first
     * stage of the wait on screen instead of a `…`, and the trace can time it against the rest.
     */
    on?.phase?.({ kind: 'choosing' })
    const available = await tools.list()
    const named = available.map((t) => ({ name: t.name }))
    const now = await options.world()
    opening ??= now.today

    /**
     * **How badly is this going?** — asked of the trace, once a step (§10.3).
     *
     * Nothing here reads the user's words. The request was classified once, at the top, and
     * that is all a sentence can honestly say; from here the loop judges what it has actually
     * watched happen, which is the thing the sentence could not know.
     *
     * `spent` lags one turn, because the money for this turn's reply is not spent until the
     * reply has been made. Against a threshold of *about 40%* that is noise, and the
     * alternative is a second world call every step to find out.
     *
     * **Tried before it is announced.** *The next plan goes to a better model* is a promise,
     * and on a machine whose best model is the one already struggling there is no better model
     * to keep it with — so the pin is routed first. A pin with nothing behind it changes
     * nothing, and the work carries on exactly where it was, which is the one direction this
     * cannot make worse — rather than printing a sentence that was not true.
     */
    /**
     * **The paid switch and the allowance are the permission** (§9.2, §4 H). Setting them is how
     * somebody says yes to exactly this — a task going badly buying one better attempt inside a
     * daily cap — so an upgrade routes under the same pins as the plan, and the world's `cross`
     * decides whether paid may be reached at all.
     */
    const upward: Pins = pins

    /**
     * **What this conversation is carrying that words cannot stand in for** (§5.2, Q5).
     *
     * The filter this feeds has been in `route()` since Q5 with nothing setting it — built
     * then rather than later on the argument that *a rule nobody can see is a rule nobody can
     * disagree with*, and left with a comment saying it had no caller. This is the caller.
     *
     * It is re-read every step rather than decided once, because a picture can arrive in the
     * middle of a task: a tool takes a screenshot at step four, and the model that has to
     * look at it is chosen at step five. Asked of the *whole* conversation, not the last
     * turn, since history is re-sent whole — a model that cannot see is no use on turn nine
     * of a conversation whose turn one was a photograph.
     */
    const seeing = carries(messages)

    if (above === undefined && answered !== undefined) {
      const signal = struggling({
        steps,
        ceiling,
        budget: opening ? opening.allowance - opening.spent : 0,
        spent: opening && now.today ? now.today.spent - opening.spent : 0,
      })
      const upgrade: Ask = {
        messages,
        shape: planning,
        above: answered,
        ...(options.background === true && { background: true }),
        ...(options.avoid !== undefined && { avoid: options.avoid }),
        ...(options.minTier !== undefined && { minTier: options.minTier }),
        ...(options.capable === true && { capable: true }),
        ...(named.length > 0 && { tools: named }),
        ...(seeing.length > 0 && { modality: seeing }),
      }
      if (signal !== undefined && route(upgrade, upward, now).ok) {
        above = answered
        // **Escalate the planning step, not every step.** The good model gets to think; the
        // mechanical read-file, run-command turns after it stay on whatever was already doing
        // them, and that is where most of the saving lives.
        shape = planning
        // Core talking, not the model: something is about to change and this is why (M6-5).
        on?.note?.(WHY[signal])
      }
    }

    const plain: Ask = {
      messages,
      shape,
      ...(options.background === true && { background: true }),
      ...(options.avoid !== undefined && { avoid: options.avoid }),
      ...(options.above !== undefined && { above: options.above }),
      ...(options.minTier !== undefined && { minTier: options.minTier }),
      ...(options.capable === true && { capable: true }),
      ...(named.length > 0 && { tools: named }),
      ...(seeing.length > 0 && { modality: seeing }),
    }
    const ask: Ask = above !== undefined && shape === planning ? { ...plain, above } : plain
    let verdict = route(ask, ask === plain ? pins : upward, now)
    // A rung that has since run out can empty the upgrade's pool later in the same task, and
    // half a task is not the price of having asked for something better: the pin drops and the
    // work carries on where it was.
    if (!verdict.ok && ask !== plain) verdict = route(plain, pins, now)
    /**
     * **Above the marked answer's tier is a preference, not a wall** (§4 I). *Bad answer* on a
     * frontier model asks above `T3`, where there is nothing; on a small paid one only `T3` is
     * left, and it may be out. Either way the retry refused and the person lost the answer they
     * had for nothing. With nothing above, it asks at any tier — still without the model marked.
     */
    if (!verdict.ok && options.above !== undefined) {
      verdict = route({ ...plain, above: undefined }, pins, now)
    }
    // A pin with nothing behind it is a sentence, never a quiet reach for something else.
    // Mid-task it is also the honest place to stop: half a task is better than a task
    // finished somewhere the user said not to go.
    // Free done, paid able, the switch off: a pause the person can lift, not a stop (§4 H). The
    // monthly hard stop is not something *Allow* can lift, so it stays a refusal.
    if (!verdict.ok && verdict.paused !== undefined && options.paidAllowed !== false) return finish('paused', verdict.paused, verdict.mode)
    if (!verdict.ok) return finish('refused', ranOutOfHands(ask, now) ? NO_HANDS : verdict.why, verdict.mode)

    /**
     * **This Mac or paid, when both are next** (§4 H). The keyed free rungs are done, the model on
     * this machine heads the plan, and a paid rung is behind it. The paid switch answered the old
     * *slow local or paid?* question in advance: on, paid goes first; off, paid was never in the
     * plan, this Mac answers, and the work pauses only if this Mac cannot.
     */
    const slow = verdict.choices[0]
    const faster = verdict.choices.filter((c) => paid(c.model.tier))
    if (now.cross === true && slow?.model.tier === 'T0' && faster[0]) verdict = { ...verdict, choices: faster }

    /**
     * **Route first, then trim to the window that won.** The budget is a property of the
     * model, not of the trace, so it cannot be known until the routing is — and a fixed
     * number instead means one of two wrong answers: too big for the small rung at the
     * bottom, or a 200k window trimmed as though it were 32k, which is most of a good model
     * bought and then not used.
     *
     * The plan's first rung is what this trims for. Every rung under it already passed the
     * router's context filter, so all of them can hold the floor; what the first one buys is
     * how much *above* the floor survives, and that is the one worth optimising for because
     * it is the one that almost always answers.
     *
     * A caller that named its own budget keeps it. This fills a gap, it does not overrule.
     */
    const trimming: TrimOptions = {
      ...options.trimming,
      ...(options.trimming?.budget === undefined &&
        verdict.choices[0] !== undefined && { budget: budgetFor(verdict.choices[0].model.context) }),
    }

    /**
     * The ceiling on a billed reply, set only when the plan actually contains a rung that
     * charges. `send` refuses to bill without one — output tokens cannot be counted before
     * they exist, so the bound is declared rather than predicted.
     *
     * **Eight times what `preview.ts` budgets for a step's output**, which it already calls a
     * deliberate overestimate. The job of this number is to turn an unbounded cost into a
     * bounded one, not to shorten an answer: a ceiling that clips real replies gets paid for
     * twice, once in money and once in a truncated answer nobody asked for.
     *
     * Absent when every rung in the plan is free, so a free answer is never cut short by a
     * limit that exists for billing.
     */
    const billable = verdict.choices.some((c) => paid(c.model.tier))

    /**
     * **Which length of the personality each model is sent** (§2) — chosen per rung, as that
     * rung is asked, by the model it is asked of.
     *
     * It was chosen once per step for the *weakest* rung in the plan, on the grounds that a 429
     * hands the step to the next rung and the document has already gone with it. But a plan is
     * every model that fits — a hundred free ones, a router, this Mac's 3B — so the weakest was
     * nearly always small, and a 550B paid model at the head of the plan was handed a hundred
     * words. Sending is per rung, so the document is too: `send` asks for each rung's messages
     * just before asking it, and a fallback to a 2B still never gets the long one.
     */
    const trimmed = trim(messages, trimming)
    const wear = (choice: Choice): { text: string; size: Size } | undefined =>
      options.personality === undefined ? undefined : sizedFor(options.personality, sizeFor(choice, now))
    const first = verdict.choices[0]
    const dressed = (choice: Choice): Message[] => [system(available, wear(choice)?.text, standing, about), ...trimmed]
    const asking = (choice: Choice): void => {
      const worn = wear(choice)
      // Counted the way `system` counts it, so this is the length that reached the model rather
      // than the length that was stored — said per rung asked, which is what reached a model.
      if (worn !== undefined) on?.personality?.(worn.text.trim().length, worn.size)
    }

    /** What this turn's switches said, kept on the answer they belong to (§4 G). */
    const noted: string[] = []
    let answer
    try {
      answer = await send(
        verdict.choices,
        {
          // Trimmed here rather than in the store: what is kept is what a model is shown,
          // and the history itself stays whole so a reload shows every step that happened.
          // Each rung is actually sent `dressed(choice)`; this is the first rung's, for the record.
          messages: [system(available, first === undefined ? undefined : wear(first)?.text, standing, about), ...trimmed],
          ...(available.length > 0 && { tools: available }),
          ...(billable && { maxTokens: options.maxTokens ?? REPLY_CEILING }),
          ...(options.signal && { signal: options.signal }),
        },
        store,
        secrets,
        {
          session,
          ...(options.run !== undefined && { run: options.run }),
          ...(options.plugin !== undefined && { plugin: options.plugin }),
          ...(options.paidAllowed !== undefined && { paidAllowed: options.paidAllowed }),
          ...(verdict.left !== undefined && { left: verdict.left }),
          ...(on?.delta && { onDelta: on.delta }),
          ...(on?.note && { onNote: on.note }),
          onSwitch: (event: Switch) => {
            noted.push(event.says)
            // A screen that has no place for a switch still hears it, as the line it always was.
            if (on?.switch) on.switch(event)
            else on?.note?.(event.says)
          },
          ...(on?.paid && { onPaid: on.paid }),
          ...(on?.restart && { onRestart: on.restart }),
          ...(on?.phase && { onPhase: on.phase }),
          messagesFor: dressed,
          onAsk: asking,
          /**
           * **How many to start together** — the speed switch, read by the caller (`RunOptions`).
           * Fastest: {@link MOST_AT_ONCE} on every step, with the favourite first for only
           * {@link FASTEST_STAR_WAIT}. Balanced: the favourite and one partner when the record says
           * it was busy or slow a moment ago, and otherwise one at a time with the two-second hedge.
           */
          atOnce: (head: Choice) =>
            options.speed === 'fastest' ? MOST_AT_ONCE
            : now.health?.get(`${head.provider.id}\n${head.model.id}`)?.shaky === true ? SHAKY_AT_ONCE
            : 1,
          together: options.speed === 'fastest' ? 'fastest' : 'lately',
          ...(options.speed === 'fastest' && { starWait: FASTEST_STAR_WAIT }),
          /**
           * **A partner started together only from a provider with plenty of its free day left** —
           * not spent, and more than half of any daily or monthly ration: the same line a
           * background task is held to (§4 F), so racing for speed never eats the chat's half.
           */
          spare: (choice: Choice) => {
            const rung = now.rungs.find((one) => one.provider.id === choice.provider.id)
            return rung !== undefined && !spent(rung) && underHalf(rung)
          },
        },
      )
    } catch (error) {
      // The user pressing stop arrives here as an abort, and it is not a failure.
      if (options.signal?.aborted) return finish('stopped')
      // Every rung in the plan failed. That is a stop with a sentence — which models, and why
      // — rather than a crash, and whose plan it was decides what the screen offers next.
      /**
       * **The free rungs were all asked and none answered** (§4 H). With the switch off, the plan
       * had no paid rung in it; if one would answer with the price line open, this is the same
       * pause the router gives when the ledger already knew — and nothing has been billed.
       */
      if (error instanceof ProviderError && error.offline !== true && now.cross === false && options.paidAllowed !== false && verdict.mode !== 'pinned') {
        const opened = route(ask, pins, { ...now, cross: true, today: { spent: 0, allowance: Number.MAX_SAFE_INTEGER } })
        // Not behind a key that was just refused: *Allow* would only collect the same refusal.
        const refused = new Set(error.refused ?? [])
        if (opened.ok && opened.choices.some((c) => paid(c.model.tier) && !refused.has(c.provider.id))) {
          // What actually happened to the free ones, said beside *Allow* — not a fixed *used up*,
          // which was wrong for a conversation too long for them and for a model that was down.
          return finish('paused', error.message, verdict.mode)
        }
      }
      /**
       * **The switch is on and the day's amount is what stopped paid** (§4 H): the free rungs failed
       * and a paid one would have answered but for the allowance. It stops as the allowance always
       * did — and says so, rather than naming only the free model that was busy.
       */
      if (error instanceof ProviderError && now.cross === true && !affordable(now.today) && options.paidAllowed !== false && verdict.mode !== 'pinned') {
        const opened = route(ask, pins, { ...now, today: { spent: 0, allowance: Number.MAX_SAFE_INTEGER } })
        if (opened.ok && opened.choices.some((c) => paid(c.model.tier))) {
          return finish(
            'refused',
            `${error.message} And today's $${(now.today?.allowance ?? 0).toFixed(2)} for paid models is spent — raise it under the paid switch on the Models tab, or wait for tomorrow.`,
            verdict.mode,
          )
        }
      }
      if (error instanceof ProviderError) return finish('refused', error.message, verdict.mode)
      throw error
    }

    // The plan's first rung is what was asked for; `answer.model` is whoever took it — and
    // the bubble is about the one that did, not the one that was hoped for.
    on?.turn?.({
      asked: verdict.choices[0]?.model.id ?? answer.model.id,
      answered: answer.model.id,
      bubble: bubble({
        model: answer.model,
        provider: answer.provider,
        ...(answer.keyed !== undefined && { keyed: answer.keyed }),
      }),
    })
    answered = answer.model.tier

    messages.push(answer.message)
    added.push(answer.message)
    store.append(session, {
      ...answer.message,
      provider: answer.provider.id,
      // The row asked, when the provider named another model: what *Bad answer* acts on (§4 I).
      ...(answer.message.model !== answer.model.id && { row: answer.model.id }),
      ...(noted.length > 0 && { notes: noted }),
    })

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
      // The stage the wait is in now: a tool, by name, rather than the model that asked for it.
      // Beside `step`, so the stage begins where the step's own clock does, approval and all.
      on?.phase?.({ kind: 'tool', name: step.name })

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

  /**
   * Is *hands* what ran out, or is the refusal one of the other walls? {@link NO_HANDS} is
   * the reasoning; this is the question, asked by relaxing the one condition and re-routing.
   *
   * Nothing to strand and nothing was asking for hands both answer no before the second route
   * happens, so the ordinary refusal path costs no extra work.
   */
  function ranOutOfHands(ask: Ask, now: World): boolean {
    if (steps.length === 0 || (ask.tools?.length ?? 0) === 0) return false
    return route({ messages: ask.messages, shape: 'simple' }, pins, now).ok
  }

  function finish(ended: RunResult['ended'], why?: string, mode?: Mode): RunResult {
    return { messages: added, steps, ended, ...(why !== undefined && { why }), ...(mode !== undefined && { mode }) }
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
 *
 * A personality goes **after** these lines and is the user's own words, kept whole. Later
 * wins where the two disagree, which is the right way round: these four sentences are the
 * floor a model needs to drive a loop, and everything above that is the user's call.
 *
 * `caller` is a plugin's own `systemPrompt` (M7-5) and sits **between** the two, for the
 * same reason and in the same direction: it is context core cannot know — *this is a phone*
 * — and it is not the user saying how they want to be spoken to. Sent as a second `system`
 * message, which is how it used to arrive, it landed after the personality and won.
 *
 * So the order is **floor, caller, profile, personality**. The profile (`memory.profile`) is
 * *facts* — a name, a language, a life stage — and the personality is *voice*; facts go first
 * and the voice goes last, so that where the two brush against each other on style (*speak to
 * him informally*), the personality the user chose is what wins. The profile has a header of
 * its own so a model reads it as what is known rather than as another instruction, and no
 * header at all when there is nothing under it.
 *
 * One more floor line when a memory exists and there are tools to reach it: weak models answer
 * *I don't know you* without looking, and the sentence telling them to look is cheaper than
 * every fact they would otherwise have to be handed up front.
 */
function system(
  available: ToolSpec[],
  personality?: string,
  caller: string[] = [],
  about: { profile?: string; remembers?: boolean } = {},
): Message {
  const lines = [
    'You are Alexia, an assistant running on the user’s own machine.',
    available.length > 0 ?
      'You have tools. Call them when they would help, one step at a time, and use what comes back.'
    : 'You have no tools available right now, so answer from what you know.',
    'When a tool fails, read the error and try a different approach rather than repeating the call.',
    'Stop calling tools and answer as soon as you can. Say what you did, briefly.',
    ...(available.length > 0 && about.remembers === true ?
      [
        'You have a long-term memory about this user. Before saying you don’t know something about them, check it with the recall tool.',
      ]
    : []),
  ]
  const profile = about.profile?.trim() ?? ''
  const parts = [
    lines.join(' '),
    ...caller.map((one) => one.trim()),
    profile === '' ? '' : `What you know about the user:\n${profile}`,
    personality?.trim() ?? '',
  ]
  return { role: 'system', content: parts.filter((part) => part !== '').join('\n\n') }
}

/**
 * **The mid-task rule** (§8.5), which `router.ts` states beside its two siblings: never swap
 * from a helper with hands to one that only talks in the middle of a job.
 *
 * The rule itself is already kept, and not by anything here: a request carrying tools does not
 * route to a model without them, so there is no path down which the loop could quietly find
 * itself talking. What this adds is the half the user meets. Two things are allowed when the
 * last tool-capable rung goes mid-task — **(a)** retry within the hands ladder, which `send`
 * does by walking every rung of the plan past a 429, and **(b)** stop and say so — and (b)
 * arriving as *none of the models available to you can use tools* describes the wall without
 * naming what just happened to the work. Waiting for a free tier to reset is deliberately not
 * built: a loop that sleeps for an hour is not a third option, it is (b) with the sentence
 * withheld.
 *
 * **Asked by re-routing, not by reading the refusal.** Would something have answered if the
 * work had only needed talking? If yes, hands are exactly what ran out; if no, the wall is one
 * of the others and this sentence would send somebody after the wrong fix. It is the same
 * idiom the router uses on itself for *would money have answered this* — run the same filters
 * with the one condition relaxed and see, rather than inferring it from which filter emptied
 * the list.
 *
 * **Only once the job is underway.** On the first message nothing is half-done, and the
 * router's own sentence is the better one there because it names the fix rather than the loss.
 */
const NO_HANDS =
  'I ran out of helpers with hands — everything still available can only talk, and swapping to one now would strand this half-done. Wait for a free tier to reset, or connect a provider whose models can use tools.'

/** A provider error the loop could not route around, in the words the user gets. */
export const said = (error: unknown): string =>
  error instanceof ProviderError || error instanceof Error ? error.message : String(error)
