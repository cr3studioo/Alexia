// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Step } from './agent.js'
import { route, send, type Pins, type World } from './router.js'
import type { SecretStore } from './secrets.js'
import type { Message, Store } from './store.js'

/**
 * Learned skills (M4-5) — the best answer this project has to *an agent should not solve
 * the same problem twice*.
 *
 * An agent working something out is expensive: ten model calls, three wrong turns, a
 * permission prompt. Doing it again from scratch next week is pure waste. So after a task
 * that actually involved problem-solving, the offer is made — *want me to remember how to
 * do this?* — and a yes sends the episode to a strong model that turns it into a skill.
 *
 * > **The hard part, named honestly.** A trajectory is not a skill. It records what
 * > happened *once*, mixing transferable decisions with incidental detail, dead ends and
 * > mistakes. The distillation has to produce a *procedure*: what to do, when it applies,
 * > what to check along the way. That difficulty is the whole feature, and it is why this
 * > uses the strongest rung available rather than the cheapest — it runs once, after a task
 * > that was already expensive, and pays for itself on every reuse.
 *
 * Two rules that are not negotiable:
 *
 * - **Ask, never assume.** Nothing is written without somebody saying yes.
 * - **A learned skill can be wrong**, so it is attributed the moment it fires, with *edit*
 *   and *forget* right there. Finding out in a settings list nobody opens is finding out
 *   too late.
 *
 * Two more, written down here because this is where a future version of this file would
 * break them (M6-9, D84):
 *
 * - **The checker is code, never a model.** What is checked about a skill Alexia wrote is
 *   checked by `skills.ts`'s parser and then by a person, on the panel, before it is in the
 *   index at all. Routing a self-authored skill through an LLM to review it makes the
 *   checker itself the unauditable thing it exists to catch, and *the model said it was
 *   fine* is not a review.
 * - **A revise-and-recheck loop asks the ceiling before it dispatches, not after.** There is
 *   no such loop today — `distil` runs once and declines by returning nothing, which is the
 *   cheapest correct shape. If one is ever added: an author that keeps trying and a checker
 *   that keeps failing is a loop **spawning fresh calls**, which is the one shape a ceiling
 *   checked afterwards never catches. Check M15-7's ceilings before each round, and bound
 *   the rounds separately.
 */

/** The frontmatter key that marks a skill as one Alexia wrote rather than one somebody installed. */
export const LEARNED_META = 'learned'

/** How many steps make a task worth a second look. Below this, nothing was worked out. */
const ENOUGH_STEPS = 3

export interface Episode {
  /** What the user actually asked for, in their words. */
  task: string
  steps: Step[]
  /** The answer the task ended on. Part of the evidence, not the skill. */
  answer: string
}

/**
 * Was this worth learning?
 *
 * A cheap gate first, and it is deliberately cheap: **most tasks are not worth a model
 * call to decide they are not worth a model call.** What survives it is a task that took
 * real steps and hit something — a recovered failure, or enough distinct tools that the
 * order of them was a decision.
 *
 * The model's judgement comes after, in `distil`, where it can decline by returning
 * nothing. That ordering means one call rather than two, and it means the model deciding
 * *what* the skill is and *whether* there is one are the same question, which they are.
 */
export function learnable(episode: Episode): boolean {
  const { steps } = episode
  if (steps.length < ENOUGH_STEPS) return false
  // A run where nothing worked is not a procedure, however many tools it tried. Offering
  // to remember one would be offering to write down a way of failing.
  if (!steps.some((step) => step.outcome?.ok === true)) return false
  const recovered = steps.some((step) => step.outcome?.ok === false) && steps.at(-1)?.outcome?.ok === true
  const distinct = new Set(steps.map((step) => step.name)).size
  return recovered || distinct >= ENOUGH_STEPS
}

/**
 * A one-line description of what happened, for the offer.
 *
 * The offer has to say what it would be remembering, or *want me to remember how to do
 * this?* is a question nobody can answer. It is built from the task and the tools rather
 * than from a model call: the offer appears at the end of a task the user has just watched,
 * and making them wait for a sentence describing what they saw would be absurd.
 */
export function outline(episode: Episode): string {
  const tools = [...new Set(episode.steps.map((step) => step.name))]
  const shown = tools.slice(0, 3).join(', ')
  return `${episode.steps.length} steps, using ${shown}${tools.length > 3 ? ` and ${String(tools.length - 3)} more` : ''}`
}

/** What the model is shown: the task, then each step and what came back, trimmed. */
function transcript(episode: Episode): string {
  const lines = [`The user asked: ${episode.task}`, '', 'What happened, step by step:']
  for (const step of episode.steps) {
    lines.push(
      `${String(step.n)}. ${step.name}(${JSON.stringify(step.args).slice(0, 300)})` +
        ` -> ${step.outcome?.ok === false ? 'FAILED: ' : ''}${(step.outcome?.text ?? '(no answer)').slice(0, 400)}`,
    )
  }
  lines.push('', `It finished by saying: ${episode.answer.slice(0, 800)}`)
  return lines.join('\n')
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const BRIEF = [
  'You turn one recorded episode into a reusable skill, in the agentskills.io format.',
  '',
  'A trajectory is not a skill. What happened once is full of incidental detail, dead ends and',
  'mistakes; what you write must be a *procedure* — what to do, when it applies, and what to',
  'check along the way. Drop everything specific to this run: exact paths, exact filenames,',
  'exact numbers, the wrong turns. Keep the decisions that would be the same next time.',
  '',
  'Answer with a Markdown document and nothing else, in exactly this shape:',
  '',
  '---',
  'name: lowercase-hyphenated-name',
  'description: What this is for and WHEN to use it, in one or two sentences. The "when" is',
  '  what decides whether it is ever opened, so it must name the situation.',
  '---',
  '',
  'The procedure. Numbered steps, plain sentences, under 300 words.',
  '',
  'If nothing here generalises — if it was a one-off, or trivial, or it mostly failed —',
  'answer with exactly: NOTHING TO LEARN',
].join('\n')

export interface Distilled {
  name: string
  description: string
  /** The whole file, frontmatter included, ready to write. */
  document: string
}

/**
 * The episode, turned into a procedure by the strongest rung available.
 *
 * `shape: 'hard'` on purpose. This is the one place in Alexia where paying for the good
 * model is obviously right: it happens once, by invitation, after a task that already cost
 * more than this call will, and everything it saves it saves repeatedly.
 */
export async function distil(
  episode: Episode,
  context: { store: Store; secrets: SecretStore; pins: Pins; world(): Promise<World>; paidAllowed?: boolean },
): Promise<Distilled | { why: string }> {
  const messages: Message[] = [
    { role: 'system', content: BRIEF },
    { role: 'user', content: transcript(episode) },
  ]
  const verdict = route({ messages, shape: 'hard' }, context.pins, await context.world())
  if (!verdict.ok) return { why: verdict.why }

  let said: string
  try {
    const answer = await send(verdict.choices, { messages, maxTokens: 1200 }, context.store, context.secrets, {
      ...(context.paidAllowed !== undefined && { paidAllowed: context.paidAllowed }),
    })
    said = answer.message.content.trim()
  } catch (error) {
    return { why: error instanceof Error ? error.message : String(error) }
  }

  // The model declining is a real answer and the commonest one. Most tasks are not skills.
  if (/^NOTHING TO LEARN/i.test(said)) return { why: 'There was nothing in that worth keeping for next time.' }
  return parse(said)
}

/**
 * What came back, held to the same rules a downloaded skill is held to.
 *
 * The frontmatter has to start at byte 0, the name has to be a folder name, and the
 * description has to exist — because a skill failing any of those is a skill that silently
 * never fires, which is indistinguishable from one that was never written.
 */
export function parse(said: string): Distilled | { why: string } {
  const body = said.replace(/^```(?:markdown|md)?\n?/i, '').replace(/```\s*$/, '').trim()
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body)
  if (!front) return { why: 'The model did not write a skill with frontmatter, so nothing was saved.' }
  const name = /^name:\s*(.+)$/m.exec(front[1] ?? '')?.[1]?.trim()
  const description = /^description:\s*([\s\S]*?)(?=\n[a-z_]+:|\n*$)/m.exec(front[1] ?? '')?.[1]?.trim()
  if (!name || !NAME.test(name)) return { why: `“${name ?? ''}” is not a usable skill name, so nothing was saved.` }
  if (!description) return { why: 'The skill it wrote has no description, so nothing would ever read it.' }
  return { name, description: description.replace(/\s+/g, ' '), document: body }
}

/**
 * Write it, marked as learned.
 *
 * `metadata.learned` is what tells everything downstream that Alexia wrote this rather
 * than a person installing it — which is what the attribution line reads, and what makes
 * *forget* offerable on this one and not on a skill somebody chose.
 */
export function save(skillsDir: string, learned: Distilled, from?: string): string {
  const dir = join(skillsDir, learned.name)
  mkdirSync(dir, { recursive: true })
  // The task it came out of, kept with it (M6-4). A learned skill can be wrong, and the
  // question somebody asks a week later is *where did this come from* — which is
  // unanswerable from the skill's own text, because the model wrote that text. Quoted as a
  // YAML string and stripped of line breaks, since it is one sentence a person typed.
  const source = from?.replace(/\s+/g, ' ').trim().slice(0, 200)
  const marked = learned.document.replace(
    /^---\r?\n/,
    `---\nmetadata:\n  ${LEARNED_META}: true\n  learned_at: ${new Date().toISOString().slice(0, 10)}\n` +
      (source ? `  learned_from: ${JSON.stringify(source)}\n` : ''),
  )
  writeFileSync(join(dir, 'SKILL.md'), `${marked}\n`)
  return dir
}

/** Forget one. It is a folder, so forgetting is deleting it — the same as any other skill. */
export function forget(skillsDir: string, name: string): boolean {
  if (!NAME.test(name)) return false
  rmSync(join(skillsDir, name), { recursive: true, force: true })
  return true
}
