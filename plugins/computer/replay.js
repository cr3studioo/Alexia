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
 * Did the step before this one actually work?
 *
 * **The registry had six ways to act and no way to check**, and that is the hole this closes.
 * A plan can do the wrong thing sixty times and report sixty successes, because nothing in it
 * could observe — so *it did it ten times* was something a model asserted rather than something
 * the plugin counted. A postcondition turns the second into the first, and it is the difference
 * between a script somebody can trust with sixty steps and one they have to watch.
 *
 * **The reader is the accessibility tree, and that is what keeps this file free.** Not OCR: a
 * document parser answers *what does this say* and the question here is *is the Save button
 * there, and does the display say 42* — different questions, and only the control tree answers
 * the second exactly. It lives in `./windows.js`, so this module still imports that and nothing
 * else, and the test that reads the imports still proves a script cannot bill. An OCR fallback
 * that reached for a model would break that, and the invariant is worth more than the fallback.
 */
async function postcondition(step, signal) {
  const wrong = expectation(step, await win.readElement(targeted(step), signal))
  if (wrong) throw new Error(wrong)
}

/** Which window and which control, from the three fields every screen-reading step carries. */
const targeted = (step) => ({
  ...(Number(step.pid) > 0 && { pid: Number(step.pid) }),
  ...(typeof step.title === 'string' && step.title !== '' && { title: step.title }),
  ...(typeof step.match === 'string' && step.match !== '' && { match: step.match }),
})

/**
 * The judgement, separated from the reading that produced it.
 *
 * Apart so it can be tested without a screen. Every other rule in this file is provable on any
 * machine — the import graph, the step registry, what a decision costs — and a postcondition
 * whose *only* test needed a Windows desktop with the right window open would be the one rule
 * nobody ever checked. The spawn stays in `windows.js`; the sentence is here.
 */
export function expectation(step, found) {
  const named = String(step.match ?? 'that window')
  // *And now it is gone* is as much a postcondition as *and now it is there* — closing a
  // dialog is half of what a sequence of clicks does.
  if (step.gone === true) {
    return found.found ? `“${named}” is still on screen, and the plan expected it to be gone by now` : undefined
  }
  if (!found.found) {
    return `there is no “${named}” on screen — the plan expected one, so the step before it did not do what it was supposed to`
  }
  if (step.says === undefined) return undefined
  const wanted = String(step.says)
  const said = String(found.text ?? '')
  // Contains rather than equals, and case-insensitively: a display reads `= 42`, a status bar
  // reads `Saved to Documents`, and a plan that had to spell either exactly would be a plan
  // that breaks on a space.
  return said.toLowerCase().includes(wanted.toLowerCase()) ? undefined : (
      `“${named}” says “${said}”, and the plan expected “${wanted}”`
    )
}

/**
 * What a step may be.
 *
 * Deliberately the same set as the `do` tool's actions plus the three that have no keyboard in
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
  /** The one step that changes nothing and can still stop the plan. See {@link postcondition}. */
  expect: (step, signal) => postcondition(step, signal),
  /**
   * Press a control by **name** rather than by coordinate, through the control itself.
   *
   * The step worth having in a saved plan, because it is the one that does not go stale. A
   * coordinate is a fact about where a window happened to be sitting on the afternoon somebody
   * recorded it; a name is a fact about the application. Move the window, change the screen
   * resolution, dock the laptop, and every `click` in a plan is now pressing whatever is at
   * those pixels — while `press Save` is still pressing Save.
   */
  press: (step, signal) => pressing(step, signal),
}

async function pressing(step, signal) {
  if (String(step.match ?? '') === '') throw new Error('a press step has to say which control it means')
  const wrong = pressed(step, await win.invoke(targeted(step), signal))
  if (wrong) throw new Error(wrong)
}

/** What a press came back with, judged — apart from the pressing, for {@link expectation}'s reason. */
export function pressed(step, done) {
  const named = String(step.match ?? '')
  if (!done.found) return `there is no “${named}” on screen to press`
  if (done.how === 'disabled') return `“${named}” is on screen and greyed out, so nothing was pressed`
  // A control the application exposes no way to operate. Stopping here rather than quietly
  // reaching for the mouse: a real click is a different permission and a different log line,
  // and a plan that silently escalated would be the one thing this rung must not do.
  if (done.how === 'none') {
    return `“${named}” is on screen and exposes no way to be pressed. Use a click step with its coordinates instead.`
  }
  return undefined
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
