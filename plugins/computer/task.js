// SPDX-License-Identifier: AGPL-3.0-only
import { fingerprint, gate, pressReaches, readAnswer, request, table, titleOf } from './decide.js'

/** Steps one task may take. Past this it is a program, or it is lost. */
export const MAX_TASK_STEPS = 30

/** Actions in a row that may leave the screen unchanged before the task stops itself. */
const STUCK = 3

/**
 * Run one goal with the fast decider: look, choose, act, look again.
 *
 * Everything that touches the world comes in through `io`, so the loop is tested with a fake
 * screen and a fake Jev and no platform at all:
 *
 * - `look()` → the rows `elements` returns for the window being worked in
 * - `decide(body)` → Jev's raw answer to {@link request}
 * - `press(row)` → `{ how }`, pressing through the control itself
 * - `click(row)`, `type(text)`
 * - `write({ goal, window, field, history })` → the words for a field, or `undefined`
 * - `note(step)` → the action log, which is also what `save_plan` records from
 * - `onStep(n, what)`
 *
 * **It never acts on a guess.** A decision below the confidence {@link gate} stops the task and
 * says why, with what is on screen, so the chat model carries on step by step — version 1 is
 * the fallback, not a separate mode somebody has to switch to.
 *
 * **An action is never retried.** It is logged the moment it is done and before the screen is
 * read again, so a failure while looking cannot lose the fact that something was pressed.
 */
export async function runTask(goal, io, { signal, most = MAX_TASK_STEPS } = {}) {
  const history = []
  let unchanged = 0
  let before = await io.look()

  for (let n = 1; n <= most; n += 1) {
    if (signal?.aborted) return finish('stopped', 'Stopped before it was finished.')
    const rows = table(before)
    const window = titleOf(before)
    if (rows.length === 0) {
      return finish('handback', 'Nothing in this window names itself, so there is nothing for Jev to choose from. A screenshot is the way in here.')
    }
    const body = request({ goal, window, rows, history })
    const decision = readAnswer(await io.decide(body), body, rows)

    const why = gate(decision)
    if (why) return finish('handback', why, { rows, decision })
    if (decision.operation === 'DONE') return finish('done', 'Jev says the goal is finished. That is its reading of the screen — check it before relying on it.')
    if (decision.operation === 'BLOCKED') return finish('handback', 'Jev found nothing on screen that moves the goal forward.', { rows, decision })

    const step = { operation: decision.operation, ...(decision.row && { name: decision.row.name }), sure: decision.row ? decision.targetConfidence : decision.confidence }
    io.onStep?.(n, describe(step))

    if (decision.operation === 'WAIT') {
      await new Promise((resolve) => setTimeout(resolve, 500))
    } else if (decision.operation === 'PRESS') {
      await pressRow(io, before, decision.row, step)
    } else if (decision.operation === 'TYPE') {
      const text = await io.write({ goal, window, field: `${decision.row.type} “${decision.row.name}”`, history })
      if (text === undefined) {
        return finish('handback', `The goal does not say what goes in “${decision.row.name}”, so nothing was typed.`, { rows, decision })
      }
      await io.click(decision.row)
      await io.type(text)
      step.how = 'type'
      step.text = text
    }
    history.push(step)
    await io.note(step)

    const after = await io.look()
    unchanged = decision.operation !== 'WAIT' && fingerprint(after) === fingerprint(before) ? unchanged + 1 : 0
    before = after
    if (unchanged >= STUCK) return finish('handback', `The last ${String(STUCK)} actions changed nothing on screen, so it stopped rather than keep pressing.`)
  }
  return finish('handback', `It took ${String(most)} steps without finishing, which is the most one task may take.`)

  function finish(outcome, said, { rows, decision } = {}) {
    return { outcome, said, steps: history, ...(rows && { rows }), ...(decision && { decision }) }
  }
}

/**
 * Press through the control when that reaches it, and click its middle when it does not.
 *
 * `invoke` finds a control by the first name that *contains* the text, which can be a different
 * control ({@link pressReaches}); a control with no way to be pressed comes back `none`. In
 * both cases the click lands on the row Jev chose, by the coordinates we read for it.
 */
async function pressRow(io, rows, row, step) {
  if (pressReaches(rows, row)) {
    const done = await io.press(row)
    if (done.how === 'disabled') throw new Error(`“${row.name}” is greyed out, so nothing was pressed.`)
    if (done.found && done.how !== 'none') {
      step.how = 'press'
      return
    }
  }
  await io.click(row)
  step.how = 'click'
  step.x = row.x
  step.y = row.y
}

const describe = (step) =>
  step.operation === 'PRESS' ? `press “${step.name}”`
  : step.operation === 'TYPE' ? `type into “${step.name}”`
  : 'wait'
