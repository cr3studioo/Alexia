// SPDX-License-Identifier: AGPL-3.0-only
import type { Message } from './store.js'

/**
 * Keeping a long task inside a context window without losing what it learned.
 *
 * Recent steps stay verbatim. Older ones collapse into a running summary. Raw tool output
 * is dropped once what was learned from it has been written down.
 *
 * **Summarise for what worked, not only for what happened.** This is the instruction that
 * decides how good the whole thing is. A trace trimmed to *"read three files, then answered"*
 * is enough to carry on with and useless for anything else. A trace trimmed to *"listing the
 * folder first worked; reading archive.txt failed because it does not exist"* is both — and
 * it is also the raw material a learned skill is distilled from at M4-5. Trimming for
 * context and distilling for reuse want the same information, so getting this wrong here
 * quietly caps how good learned skills can ever be. It is the same summary, written once.
 *
 * **Nothing here may orphan a tool message.** Every OpenAI-compatible endpoint rejects a
 * `tool` turn whose `tool_calls` are not in the request, so an assistant turn and the tool
 * turns answering it are one unit — collapsed together or kept together, never split. That
 * is not a style rule; splitting them is a 400 from the provider and a task that dies at
 * step nine for no visible reason.
 */

export interface TrimOptions {
  /**
   * Assistant turns kept verbatim, counting back from the newest. Four is two full
   * plan-act-observe cycles, which is what a model needs to not repeat itself.
   */
  keepTurns?: number
  /** Characters of tool output kept in a verbatim step. Beyond it, the middle goes. */
  perResult?: number
  /** Rough character budget for everything. Trimming keeps collapsing until it fits. */
  budget?: number
}

const DEFAULTS = { keepTurns: 4, perResult: 2_000, budget: 24_000 } satisfies Required<TrimOptions>

/**
 * Characters per token, for holding a trace measured in characters against a window
 * published in tokens.
 *
 * {@link size} counts characters and says why — *tokens would need a tokeniser per model* —
 * so somewhere the two units have to meet, and this is the only honest place to put the
 * seam: named once, in the file that owns the character convention, rather than smuggled
 * into a comparison somewhere else.
 *
 * **Three, not four.** English averages nearer four, but a trace is not English: it is tool
 * arguments and JSON and file paths, which tokenise denser. Three over-counts what a trace
 * will cost, and over-counting is the side to be wrong on — wrong the other way sends a
 * conversation to a window that cannot hold it, which is not a shorter answer, it is a 400
 * from upstream and a task that dies at step nine for no visible reason.
 */
export const PER_TOKEN = 3

/**
 * The share of a model's window the trace may occupy. The rest is the system prompt, the
 * tool list — neither of which passes through here — and the answer itself.
 *
 * **A quarter is what the fixed 24,000 already was.** That number was calibrated against a
 * 32k window (32,768 x 3 characters is 98,304, and 24,000 is a little under a quarter of
 * it), so keeping the same share means nothing that fits today gets tighter, and the only
 * thing that changes is the case this exists for: a 200k window trimmed to a 32k one, which
 * is most of a good model bought and then not used.
 */
const SHARE = 0.25

/**
 * The character budget for a model's window. **Route first, then trim to this** — the budget
 * is a property of the model that won, not of the trace, so it cannot be known before the
 * routing is.
 *
 * A model that publishes no window falls back to the fixed default rather than to zero.
 * Silence is not smallness, the same reading it gets in the router's context filter.
 */
export const budgetFor = (context: number): number =>
  context > 0 ? Math.round(context * PER_TOKEN * SHARE) : DEFAULTS.budget

/** One assistant turn and the tool turns answering it. The unit that can never be split. */
interface Cycle {
  assistant: Message
  results: Message[]
  /**
   * **The sub-goal this cycle serves** (§11.5) — one level, and deliberately not a graph.
   *
   * A graph's value is answering *what does this conclusion depend on?*, and building one
   * means answering *does this line matter to this bug?*, which is the question nothing can
   * answer. So there are no edges here: just a number saying which stretch of work a cycle
   * belongs to, which gets dependency-collapse without dependency-tracking and is about
   * ninety per cent as good.
   *
   * **The model draws the boundaries itself, by narrating.** A turn that says something
   * before it acts — *now let me find the calculator* — has started a new piece of work, and
   * the turns after it that say nothing are that same piece being carried out. Nothing here
   * is inferred about what the words mean; only that a sentence was said.
   */
  goal: number
}

/**
 * A trace split into its head and its cycles.
 *
 * Everything before the first assistant turn is the conversation, not the trace: the user's
 * own words, and any earlier answers. They are never collapsed — the task is the one thing
 * that must survive, because a summary of the task is a different task.
 */
function split(messages: Message[]): { head: Message[]; cycles: Cycle[] } {
  const head: Message[] = []
  const cycles: Cycle[] = []
  let goal = 0
  /** A turn that spoke opened a new sub-goal; one that only acted is still serving the last. */
  const tag = (message: Message): number => (message.content.trim() ? (goal += 1) : goal)
  for (const message of messages) {
    if (message.role === 'assistant' && (message.calls?.length ?? 0) > 0) {
      cycles.push({ assistant: message, results: [], goal: tag(message) })
      continue
    }
    const open = cycles.at(-1)
    if (open && message.role === 'tool') {
      open.results.push(message)
      continue
    }
    if (cycles.length === 0) head.push(message)
    else cycles.push({ assistant: message, results: [], goal: tag(message) })
  }
  return { head, cycles }
}

/**
 * The part of a trace that can never be collapsed away: the head, plus the newest cycle.
 *
 * The head is the conversation — the user's own words — which {@link trim} never touches
 * because a summary of the task is a different task. The newest cycle is the step just
 * taken, which `trim` also never collapses, because a model with no memory of the step it
 * just took repeats it forever.
 *
 * So this is the smallest a trace can be made without lying about it, which makes it the
 * right thing for the router to measure a context window against. Anything above this
 * floor is negotiable; the floor is not, and a window that cannot hold it cannot hold the
 * request at any amount of trimming.
 */
export function floor(messages: Message[]): Message[] {
  const { head, cycles } = split(messages)
  const newest = cycles.at(-1)
  return newest ? [...head, newest.assistant, ...newest.results] : head
}

/**
 * What a task learned, as lines. **Two callers, one summary** — which is the whole point of
 * the plan's note. `trim` puts this in front of a model when the context is tight; M4-5
 * distils a learned skill from exactly the same text. They want the same information, so
 * producing it twice, differently, is how the second one quietly ends up worse.
 *
 * Available whether or not any trimming happened: whether a trace was long enough to need
 * collapsing has nothing to do with whether it was worth learning from.
 */
export function summary(messages: Message[]): string {
  return lines(split(messages).cycles).join('\n')
}

/**
 * **An observation matters until a conclusion supersedes it** (§11.3).
 *
 * The question a trimmer wants to ask is *is this important?*, and that one has no answer.
 * The question it can ask is **has this line of inquiry closed?** — and most of the time
 * that is not a judgement at all, it is a fact about two calls sitting in the same trace:
 *
 * - a call that errored and was **retried successfully** → the error is spent
 * - a file **read, then edited** → the edit is what the file says now
 * - the **same call made twice** → one of them is the answer
 * - a result **superseded** by a later one → the later one is the world
 *
 * All four are the same sentence — *something later already answered this* — and none of
 * them needs a model, which is why this is the cheap 80% and runs on every trim.
 *
 * **What it does not do is decide that a failure stopped mattering.** Forty-seven paths
 * that did not hold the file are forty-seven *different* calls, so nothing here touches
 * them: they are negative space, and they are what stops the next model repeating the
 * search. Only the closing of a sub-goal can retire those, which is a different mechanism.
 *
 * Contents are replaced rather than messages removed, because an assistant turn and the
 * tool turns answering it are one unit — see this file's own opening note, and the 400 from
 * upstream that breaking it earns.
 */
const superseded = (name: string): string => `superseded by a later ${name}`

/**
 * **Are these two calls about the same thing?** They agree on every argument they both
 * name, and there is at least one to agree about.
 *
 * Agreement on the *shared* keys rather than on all of them is what makes the read-then-
 * edited case fall out: `{"path":"a.ts"}` and `{"path":"a.ts","text":"…"}` are about a.ts,
 * while `{"path":"a.ts","mode":"r"}` and `{"path":"b.ts","mode":"r"}` are not about the same
 * file merely because they were opened the same way.
 *
 * Two calls that take no arguments at all are about the same thing only if they are the
 * same call: every no-argument tool in a plugin would otherwise match every other one.
 */
function about(a: Record<string, unknown>, b: Record<string, unknown>, sameName: boolean): boolean {
  const shared = Object.keys(a).filter((key) => key in b)
  if (shared.length === 0) return sameName && Object.keys(a).length === 0 && Object.keys(b).length === 0
  return shared.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

/**
 * What a tool's name says it does. Two questions are asked of it: does this change what it
 * is pointed at (which closes an earlier reading of the same thing), and would asking it
 * again give the same answer back (which is what makes an answer droppable).
 *
 * ponytail: a pair of verb lists, not a property of the tool. Nothing a plugin declares says
 * whether a tool writes or merely looks, and inventing a `ToolSpec` field for it is a schema
 * decision this file is not the place to take — so the name is read, and a name that says
 * neither is treated as neither. Read it off the manifest the day one carries it.
 */
const WRITES = /(?:^|[^a-z])(?:write|edit|create|update|append|save|patch|delete|remove|move|rename|set)/i
const READS = /(?:^|[^a-z])(?:read|get|list|show|view|cat|open|fetch|load|search|find|grep|look)/i

/** Arguments as an object. A model that sends something else has sent no arguments. */
function fields(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * The mechanical collapse, run before anything is measured or summarised.
 *
 * The newest cycle is never touched, for the reason it is never collapsed anywhere else in
 * this file: a model with no memory of the step it just took repeats it forever.
 */
export function collapse(messages: Message[]): Message[] {
  const planning = messages.map((m, at) => ({ m, at })).filter(({ m }) => (m.calls?.length ?? 0) > 0)
  const newest = planning.at(-1)?.at
  const made = planning.flatMap(({ m, at }) => (m.calls ?? []).map((c) => ({ ...c, at, args: fields(c.arguments) })))

  /** Which call each stale result was answered by. The value is what its content becomes. */
  const spent = new Map<string, string>()
  made.forEach((call, i) => {
    if (call.at === newest) return
    const later = made
      .slice(i + 1)
      .find((next) => about(call.args, next.args, next.name === call.name) && (next.name === call.name || WRITES.test(next.name)))
    if (later) spent.set(call.id, superseded(later.name))
  })

  if (spent.size === 0) return messages
  return messages.map((m) => {
    const said = m.role === 'tool' && m.callId !== undefined ? spent.get(m.callId) : undefined
    return said === undefined ? m : { ...m, content: said }
  })
}

export function trim(messages: Message[], options: TrimOptions = {}): Message[] {
  const { keepTurns, perResult, budget } = { ...DEFAULTS, ...options }
  const { head, cycles } = split(collapse(messages))
  // The step just taken is shown exactly as it came back. Everything else is a cache.
  const newest = cycles.at(-1)

  const laid = (from: number): Message[] =>
    cycles
      .slice(from)
      .flatMap((cycle) => [
        cycle.assistant,
        ...cycle.results.map((r) => (cycle === newest ? clip(r, perResult) : shrink(cycle, r, perResult))),
      ])

  // Everything kept, with only the oversized results clipped. This is the floor to beat.
  const whole = [...head, ...laid(0)]

  let keep = Math.min(keepTurns, cycles.length)
  for (;;) {
    const collapsed = cycles.slice(0, cycles.length - keep)
    const built =
      collapsed.length > 0 ?
        [...head, summarise(collapsed), ...laid(cycles.length - keep)]
      : whole
    // Under budget, or there is nothing left to give up. The last verbatim turn is never
    // collapsed: a model with no memory of the step it just took repeats it forever.
    if (size(built) <= budget || keep <= 1) return smaller(built, whole)
    keep -= 1
  }
}

/**
 * **Trimming never makes it bigger.** A summary line costs about as much as a terse step,
 * so collapsing a trace of short calls with short answers inflates it — which is the exact
 * opposite of the job, and it only shows up on the traces nobody thought to test. Where
 * summarising does not pay, the steps stay as they are.
 *
 * Both can still be over budget, on a task whose own instructions do not fit. Returning the
 * smaller one and letting the provider say so beats silently dropping the task.
 */
const smaller = (built: Message[], whole: Message[]): Message[] => (size(built) < size(whole) ? built : whole)

/**
 * The running summary: one line per step, saying what was tried and whether it worked.
 *
 * The arguments are kept and the output is not. That asymmetry is the whole design — the
 * arguments are what makes a step repeatable, and the raw output is the part already spent
 * once the outcome is recorded. *`files__read({"name":"archive.txt"})` failed: no such file*
 * tells a model not to try it again and tells M4-5 what the recipe should avoid, on one line.
 */
function lines(cycles: Cycle[]): string[] {
  const groups = runs(cycles)
  return groups.flatMap((group, at) => {
    const narration = group.flatMap((cycle) =>
      cycle.assistant.content.trim() ? [`Said: ${oneLine(cycle.assistant.content, 200)}`] : [],
    )
    const steps = group.flatMap(told)
    const last = steps.at(-1)
    /**
     * **A closed sub-goal collapses to its conclusion** (§11.5), and the asymmetry that
     * decides whether it may is §11.3's.
     *
     * *Found it* — the last thing tried worked — and the forty-seven paths that did not hold
     * the file are dead weight: what survives is what the model said it was doing and the
     * step that answered it. *Not found* — nothing worked — and those same paths **are** the
     * finding: negative space, and the only thing stopping the next model searching /bin
     * again. So a sub-goal that closed on a failure keeps every step it took.
     *
     * The last run is not closed. Nothing has come after it to say the work moved on, and
     * there may be more of it above this slice, so it is left whole.
     */
    const closed = at < groups.length - 1 && last !== undefined && last.ok
    return [...narration, ...(closed ? [last.line] : steps.map((step) => step.line))]
  })
}

/** The cycles of each sub-goal, in order. Contiguous by construction: the tag only moves forward. */
function runs(cycles: Cycle[]): Cycle[][] {
  const out: Cycle[][] = []
  for (const cycle of cycles) {
    const open = out.at(-1)
    if (open?.[0]?.goal === cycle.goal) open.push(cycle)
    else out.push([cycle])
  }
  return out
}

/** One line per call a cycle made, and whether it worked — which is the field that gets read. */
const told = (cycle: Cycle): { line: string; ok: boolean }[] =>
  (cycle.assistant.calls ?? []).map((call) => {
    const came = oneLine(cycle.results.find((r) => r.callId === call.id)?.content ?? '', 160)
    const ok = worked(came)
    return {
      ok,
      line: `${ok ? 'Worked' : 'Failed'}: ${call.name}(${oneLine(call.arguments, 120)}) — ${came || 'no output'}`,
    }
  })

const summarise = (cycles: Cycle[]): Message => ({
  role: 'system',
  content: ['Earlier steps in this task, summarised:', ...lines(cycles)].join('\n'),
})

/**
 * Did it work? Read off the outcome text core itself wrote, not guessed at.
 *
 * ponytail: the outcome is already known as a boolean at the moment the step runs, and it
 * is thrown away by being written into prose. When M4-5 needs this to be reliable, carry
 * `ok` on the tool message rather than re-deriving it here.
 */
const FAILED = /^(?:not allowed|there is no tool|the tool failed)\b|\bis gone —|\bfailed:/i
const worked = (said: string): boolean => said !== '' && !FAILED.test(said)

/**
 * **Context is a cache, not a record** (§11.4).
 *
 * `src/router.ts:198-211` is about thirty tokens. What is written at those lines is about two
 * thousand. In a chat window that difference is everything, because the words in the window
 * are all there is — but in an agent loop the call that produced the text is sitting right
 * above it and will produce it again, so carrying the text is carrying a copy of something
 * one tool call away.
 *
 * **Dropping it costs a call, not the information.** That is the difference between an agent
 * and a chat window, and it is what lets a 32k model work in a repo of hundreds of thousands
 * of lines — which matters here because a 32k model is what the keyless floor is made of.
 *
 * **Only what asking again would give back.** A listing, a read, a search: ask once more and
 * the same text arrives. Anything that *did* something has an answer that exists once —
 * *deleted 4 files* is not re-derivable, it is the only record that it happened — so it is
 * clipped like any other long output and never replaced by a note saying to run it again.
 */
function shrink(cycle: Cycle, result: Message, limit: number): Message {
  if (result.content.length <= limit) return result
  const call = (cycle.assistant.calls ?? []).find((c) => c.id === result.callId)
  if (!call || !READS.test(call.name) || WRITES.test(call.name)) return clip(result, limit)
  return {
    ...result,
    content: `${String(result.content.length)} characters, not carried — read it again with ${call.name}(${oneLine(call.arguments, 200)})`,
  }
}

/** Long tool output, middle removed. The ends are where the useful part usually is. */
function clip(message: Message, limit: number): Message {
  if (message.content.length <= limit) return message
  const half = Math.floor((limit - 40) / 2)
  const cut = message.content.length - limit
  return {
    ...message,
    content: `${message.content.slice(0, half)}\n… ${String(cut)} characters cut …\n${message.content.slice(-half)}`,
  }
}

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Rough size in characters. Tokens would need a tokeniser per model; this is close enough. */
export const size = (messages: Message[]): number =>
  messages.reduce((total, m) => total + m.content.length + (m.calls ?? []).reduce((n, c) => n + c.arguments.length + c.name.length, 0), 0)
