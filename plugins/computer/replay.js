// SPDX-License-Identifier: AGPL-3.0-only
import * as win from './windows.js'

/**
 * The two rungs below a model deciding every step (M7-6).
 *
 * Version 1 split execution by **how much model sits in the path**, and the line between the
 * rungs is the whole idea:
 *
 * | Tier | Model in the path | Cost |
 * |---|---|---|
 * | skill | orchestrates every step | full |
 * | workflow | deterministic steps, a few decision points | partial |
 * | script | none at all | ~none |
 *
 * This repo had the top rung — `learned.ts` is a model writing a skill for itself, and this
 * plugin drives the machine with a model reading a screenshot before every click. **The
 * bottom two are the answer to *computer control is slow and expensive***: most of what
 * anybody wants it for is the same five clicks every day, and paying a model to re-derive
 * them is the waste.
 *
 * **The zero-cost guarantee is structural, and here it is stronger than the predecessor's.**
 * There, `script_engine.py` simply never imported the gateway or the ledger — a rule the
 * import graph enforced rather than a comment. Here this file imports `./windows.js` and
 * nothing else: no SDK, no `createMessage`, no capability call. There is **no code path from
 * this module to a model**, so a script cannot bill even by accident, and the test that says
 * so reads the imports rather than trusting this paragraph.
 *
 * **A step is a name from the registry below, never a string somebody runs.** A plan is data
 * a person edits by hand; if replaying one executed arbitrary strings, editing one would be
 * writing code and every plan would be a permission question nobody could answer. The
 * registry is the difference, and it holds nothing this plugin's own tools cannot already do
 * — so the permission ladder already knows how to rule on every step in it.
 */

/**
 * What a step may be.
 *
 * Deliberately the same set as the `do` tool's actions plus the two that have no keyboard in
 * them, and a test holds the two lists together. A registry that could grow past what this
 * plugin's tools do would be a way to reach something nobody annotated.
 */
export const STEPS = {
  click: (step, signal) => win.click(Number(step.x) || 0, Number(step.y) || 0, step.button ?? 'left', step.double === true, signal),
  move: (step, signal) => win.move(Number(step.x) || 0, Number(step.y) || 0, signal),
  type: (step, signal) => win.type(String(step.text ?? ''), signal),
  key: (step, signal) => win.key(String(step.keys ?? ''), signal),
  focus: (step, signal) => win.focus(Number(step.pid) || 0, signal),
  /** The one step that does nothing, and the one every real sequence needs. */
  wait: (step) => new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(0, Number(step.ms) || 0)))),
}

/**
 * The one step with a model in it, and it is not in the registry above on purpose.
 *
 * A plan holding only registry steps is a **script** and cannot cost anything. A plan holding
 * one of these is a **workflow**: it spends once, at the decision, and not once per click —
 * which is the difference the middle rung exists for.
 */
export const DECIDE = 'ask'

/** How many steps one plan may hold. A sequence longer than this is a program. */
export const MAX_STEPS = 60

/** `{name}` — an earlier step's actual answer, which is what makes a decision point useful. */
const FILL = /\{([a-z][a-z0-9_]*)\}/gi

const filled = (value, answers) =>
  typeof value !== 'string' ? value : (
    value.replace(FILL, (whole, name) => (name in answers ? String(answers[name]) : whole))
  )

/**
 * Is this something that can be replayed at all?
 *
 * Checked before anything runs rather than step by step, because a sequence that half-ran and
 * then refused has left the screen somewhere nobody planned for.
 */
export function check(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return 'that plan has no steps in it'
  if (plan.length > MAX_STEPS) return `that plan has ${String(plan.length)} steps, and ${String(MAX_STEPS)} is the most`
  for (const step of plan) {
    const what = String(step?.do ?? '')
    if (what !== DECIDE && !(what in STEPS)) {
      return `"${what}" is not something a plan can do — it must be one of: ${[...Object.keys(STEPS), DECIDE].join(', ')}`
    }
  }
  return undefined
}

/** Does this plan cost anything? A script is the plan with no decisions in it. */
export const free = (plan) => Array.isArray(plan) && !plan.some((step) => String(step?.do ?? '') === DECIDE)

/**
 * Run one.
 *
 * `ask` is supplied by the caller and is the only way a model ever enters this: a plan with
 * no `ask` steps never touches it, and a caller running a script may leave it out entirely.
 * That is not a convention — there is nothing in this file that could reach one.
 */
export async function replay(plan, { ask, signal, onStep } = {}) {
  const wrong = check(plan)
  if (wrong) throw new Error(wrong)

  const answers = {}
  let n = 0
  for (const step of plan) {
    if (signal?.aborted) return { steps: n, answers, stopped: true }
    n += 1
    const what = String(step.do)
    // Every field an earlier answer could reach, filled in before the step runs. The answer
    // is what the next deterministic step acts on, which is the whole point of a decision.
    const now = Object.fromEntries(Object.entries(step).map(([key, value]) => [key, filled(value, answers)]))
    onStep?.(n, what)

    if (what === DECIDE) {
      if (!ask) throw new Error('that plan has a decision in it, and nothing was given to decide with')
      answers[String(step.id ?? `step${String(n)}`)] = String(await ask(String(now.question ?? ''), now))
      continue
    }
    await STEPS[what](now, signal)
  }
  return { steps: n, answers, stopped: false }
}
