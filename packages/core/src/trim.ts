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

/** One assistant turn and the tool turns answering it. The unit that can never be split. */
interface Cycle {
  assistant: Message
  results: Message[]
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
  for (const message of messages) {
    if (message.role === 'assistant' && (message.calls?.length ?? 0) > 0) {
      cycles.push({ assistant: message, results: [] })
      continue
    }
    const open = cycles.at(-1)
    if (open && message.role === 'tool') {
      open.results.push(message)
      continue
    }
    if (cycles.length === 0) head.push(message)
    else cycles.push({ assistant: message, results: [] })
  }
  return { head, cycles }
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

export function trim(messages: Message[], options: TrimOptions = {}): Message[] {
  const { keepTurns, perResult, budget } = { ...DEFAULTS, ...options }
  const { head, cycles } = split(messages)

  const laid = (from: number): Message[] =>
    cycles.slice(from).flatMap((cycle) => [cycle.assistant, ...cycle.results.map((r) => clip(r, perResult))])

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
  const said: string[] = []
  for (const cycle of cycles) {
    if (cycle.assistant.content.trim()) said.push(`Said: ${oneLine(cycle.assistant.content, 200)}`)
    for (const call of cycle.assistant.calls ?? []) {
      const answer = cycle.results.find((r) => r.callId === call.id)
      const came = oneLine(answer?.content ?? '', 160)
      // Whether it worked is the field, and it is first, because it is what gets read.
      said.push(`${worked(came) ? 'Worked' : 'Failed'}: ${call.name}(${oneLine(call.arguments, 120)}) — ${came || 'no output'}`)
    }
  }
  return said
}

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
