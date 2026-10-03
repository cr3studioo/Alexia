// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolSpec } from './provider.js'
import { textOf, type Message } from './store.js'
import { PER_TOKEN } from './trim.js'

/**
 * **The tools a small model can be shown at once** — for a model on this machine, whose window
 * somebody set by hand and may be able to afford only so much of.
 *
 * Every enabled plugin's tools go into every request, and eight plugins are a hundred and twenty
 * tools: about twenty thousand tokens of definitions before a word has been said. A cloud model
 * has the room. An 8B model on an 8 GB card has sixteen thousand at the very most, and the answer
 * to *the prompt exceeds the context* was "raise the context", which the card could not do.
 *
 * So a model is handed the tools it is most likely to need, as many as fit in {@link TOOL_SHARE} of
 * its window. A model whose window holds the whole list is sent the whole list, unchanged, and so is
 * every model that is not on this machine: this exists for the one case where sending everything
 * cannot work.
 */
export const TOOL_SHARE = 0.4

/** What a tool costs in the prompt, counted the way the rest of core counts (`trim.ts`): on the high side. */
const cost = (tool: ToolSpec): number => Math.ceil(JSON.stringify(tool).length / PER_TOKEN)

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your', 'are', 'can', 'will', 'has', 'have', 'not', 'any', 'one', 'its', 'into', 'about', 'what', 'when', 'then', 'than', 'was', 'use'])
const words = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOP.has(word))
/** A word and its plain singular, so *pictures* finds a tool that says *picture*. */
const stems = (list: string[]): Set<string> => new Set(list.flatMap((word) => (word.length > 3 && word.endsWith('s') ? [word, word.slice(0, -1)] : [word])))

/**
 * What the system prompt tells the model to reach for by name — *check it with the recall tool* — has
 * to be there whatever the person asked, or the instruction points at nothing.
 */
const pinned = (tool: ToolSpec): boolean => /recall/i.test(tool.name)

/**
 * The tools to send a model whose window is `context` tokens: all of them when they fit in
 * {@link TOOL_SHARE} of it, otherwise the best-matching ones that do.
 *
 * Matched on words, never on a guess about intent: the latest request and the one before it, against
 * each tool's name and description (a word in the name counts three times). A tool the conversation
 * has already called always stays, because a model half-way through a job needs the hands it started
 * with. The result keeps the order it was given, so the same request is the same prompt twice.
 */
export function fitTools(tools: readonly ToolSpec[], messages: readonly Message[], context: number): ToolSpec[] {
  if (!(context > 0) || tools.length === 0) return [...tools]
  const budget = Math.floor(context * TOOL_SHARE)
  const costs = tools.map(cost)
  if (costs.reduce((sum, one) => sum + one, 0) <= budget) return [...tools]

  const asked = messages.filter((message) => message.role === 'user').slice(-2)
  const wanted = stems(asked.flatMap((message, index) => {
    const said = words(textOf(message))
    // The latest request counts double the one before it.
    return index === asked.length - 1 ? [...said, ...said] : said
  }))
  const called = new Set(messages.flatMap((message) => (message.calls ?? []).map((call) => call.name)))

  const score = (tool: ToolSpec): number => {
    const name = stems(words(tool.name.replace(/_+/g, ' ')))
    const about = stems(words(tool.description ?? ''))
    let points = 0
    for (const word of wanted) points += (name.has(word) ? 3 : 0) + (about.has(word) ? 1 : 0)
    return points
  }
  const rows = tools.map((tool, index) => ({ tool, index, cost: costs[index]!, must: called.has(tool.name) || pinned(tool), score: score(tool), plugin: tool.name.split('__')[0]! }))
  const best = (a: (typeof rows)[number], b: (typeof rows)[number]): number => Number(b.must) - Number(a.must) || b.score - a.score || a.cost - b.cost || a.index - b.index

  const chosen = new Set<number>()
  let spent = 0
  const take = (one: (typeof rows)[number]): void => {
    if (chosen.has(one.index) || spent + one.cost > budget) return
    chosen.add(one.index)
    spent += one.cost
  }
  // What the conversation needs first, then what the words match — and nothing else for the sake of
  // filling the room: a tool that has nothing to do with the request only gives the model something to misuse.
  for (const one of [...rows].sort(best)) if (one.must || one.score > 0) take(one)
  // Then one tool from every plugin that has none yet, the best match and then the cheapest, so a request the
  // words did not catch (*what is the weather*, for a tool that says *search*) still finds a hand to start with.
  for (const plugin of new Set(rows.map((one) => one.plugin))) {
    const mine = rows.filter((one) => one.plugin === plugin)
    if (mine.some((one) => chosen.has(one.index))) continue
    take([...mine].sort(best)[0]!)
  }
  return tools.filter((_, index) => chosen.has(index))
}
