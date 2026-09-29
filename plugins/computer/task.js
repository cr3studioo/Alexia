// SPDX-License-Identifier: AGPL-3.0-only
import { byRole, clearly, commits, enough, exact, favourite, fingerprint, groundRequest, pressReaches, readChoice, readSteps, risky, shortlist, table, titleOf, unsure } from './decide.js'

/** Steps one task may take. Past this it is a program, or it is lost. */
export const MAX_TASK_STEPS = 30

/** Actions in a row that may leave the screen unchanged before the task stops itself. */
const STUCK = 2

/** How few candidates Laya is asked to break a tie between. Past this it is guessing (measured). */
export const TIE_MOST = 5

/** How sure Laya must be to break a tie on its own word. Zero-shot it was 100% sure and wrong. */
export const TIE_SURE = 0.75

/** How long a step may run before the person is told what it is waiting on. */
export const SLOW_MS = 8000

/**
 * Run a plan: **the chat model says what, and nothing asks a model while it runs** (v3).
 *
 * The plan comes with the call, written by the chat model in its first turn — URL-first, every
 * control named by what it is called on screen or by a plain role (*the search box*, *the first
 * video*). Each step that needs a control finds it by the first rung that is sure:
 *
 * 1. **exact** — one control is called exactly that
 * 2. **words** — the target's words stand clearly in one control's name
 * 3. **role** — *the search box*, *the first video*, *the Latest tab* ({@link byRole})
 * 4. **Laya breaks a tie** — only between the few likeliest, only when it is sure, and for
 *    anything with more than one strong candidate it must agree with what the words favour
 * 5. **Jev**, when a key is set, for the same few
 * 6. **hand back** — with what is on screen and the steps not yet done, so the chat model sends
 *    a corrected plan in one turn. There is no planner inside this loop any more: the chat
 *    model answers in seconds, a free thinking model planning took half a minute to a minute.
 *
 * `read` copies a control's name into a value and `answer` ends the task with a sentence made
 * of those values, so a lookup's reply is read off the screen rather than written by a model.
 *
 * Everything that touches the world comes in through `io`, so this runs against a fake screen:
 *
 * - `look()` → rows · `settle({url})` → rows once the screen has stopped moving
 * - `laya(body)` / `jev(body)` → a raw answer, or absent when that rung is off
 * - `press(row)` → `{ found, how }` · `click(row)` · `type(text)` · `key(keys)` · `scroll(row, down)`
 * - `openUrl(url)` · `openApp(name)` · `read(row)` → its value, when it has one beyond its name
 * - `note(step)` → the action log · `onStep(n, what)` · `onPlan(stages)` → the checklist
 * - `paused()` → a promise that resolves when the person is no longer holding the task
 * - `grounded({ step, options, chosen, by })` → every control found, for Laya's fine-tuning data
 *
 * **An action is never retried**, and it is logged before the screen is read again.
 */
export async function runTask(goal, io, { signal, most = MAX_TASK_STEPS, steps: given, confirmed = false } = {}) {
  const history = []
  const rungs = { exact: 0, words: 0, role: 0, laya: 0, jev: 0 }
  const values = {}
  const plan = readSteps(given) ?? []
  let at = 0
  let waiting
  let running = false
  let unchanged = 0

  // What a person sees: every step done so far, then the rest of the plan.
  const show = () =>
    io.onPlan?.([
      ...history.map((one) => ({ label: one.say, state: one.failed ? 'failed' : 'done', ...(one.detail && { detail: one.detail }) })),
      ...plan.slice(at).map((one, n) => ({
        label: sayOf(one),
        state: n === 0 && at < plan.length && running ? 'running' : 'waiting',
        ...(n === 0 && running && { detail: waiting ?? 'working…' }),
      })),
    ])

  if (plan.length === 0) return finish('handback', 'There is no plan to run. Send the steps with the call.', { rows: table(await io.look(), 200) })
  // A plan that sends, deletes or pays is shown first. Looking and navigating never are.
  if (!confirmed && commits(plan)) {
    show()
    return finish('confirm', 'This plan commits something, so nothing was done yet. Show the person the steps, and call again with confirmed: true once they agree.')
  }

  let before = await io.look()
  show()
  while (at < plan.length) {
    const step = plan[at]
    if (signal?.aborted) return finish('stopped', 'Stopped before it was finished.')
    if (history.length >= most) return finish('handback', `It took ${String(most)} steps without finishing, which is the most one task may take.`, { rows: table(before, 200) })
    // The person took over: wait, then read the screen again — they may have moved things.
    if (io.paused) {
      const held = io.paused()
      if (held) {
        waiting = 'paused — you have the controls'
        running = true
        show()
        await held
        waiting = undefined
        before = await io.look()
      }
    }
    running = true
    show()
    const started = performance.now()
    // The one thing a watcher needs when a step takes long: what it is waiting on.
    const slow = setTimeout(() => {
      waiting = step.do === 'open_url' ? 'waiting for the page to load' : step.target ? 'looking for it on screen' : 'waiting'
      show()
    }, SLOW_MS)

    try {
      const done = { do: step.do, say: sayOf(step) }
      if (step.do === 'answer') {
        const text = fill(step.text, values)
        history.push({ ...done, detail: 'answered' })
        at += 1
        running = false
        return finish('done', text, { answer: text })
      }

      const now = table(before, 200)
      let row
      let by
      const needs = step.target !== undefined && ['press', 'type', 'read', 'scroll'].includes(step.do)
      if (needs) {
        const found = await ground({ goal, window: titleOf(before), step, rows: now }, io, rungs)
        if (found.row) {
          row = found.row
          by = found.by
        } else if (step.do !== 'scroll') {
          history.push({ ...done, failed: true, detail: 'could not find it' })
          at += 1
          running = false
          return finish('handback', found.why, { rows: now, choice: found.choice, remaining: plan.slice(at - 1) })
        }
      }
      const decided = performance.now()
      io.onStep?.(history.length + 1, describe(step, row, by))
      Object.assign(done, row && { target: row.name }, by && { by })

      if (step.do === 'read') {
        const value = (await io.read?.(row)?.catch(() => undefined)) || tidy(row.name)
        values[step.as ?? 'value'] = value
        Object.assign(done, { how: 'read', text: value })
      } else if (step.do === 'press' && row?.on === true && step.off !== true) {
        // A toggle that is already on is already done: pressing *Like* on a liked video un-likes it.
        Object.assign(done, { how: 'already', detail: 'already on' })
      } else if (step.do === 'press') Object.assign(done, await pressRow(io, before, row))
      else if (step.do === 'type') {
        await io.click(row)
        await io.type(step.text)
        Object.assign(done, { how: 'type', text: step.text, x: row.x, y: row.y })
      } else if (step.do === 'key') {
        await io.key(step.keys)
        Object.assign(done, { how: 'key', keys: step.keys })
      } else if (step.do === 'scroll') {
        // With no control to scroll, the middle of the window: a scroll cannot fail, so it
        // never needs anything asked.
        const where = row ?? middle(before)
        await io.scroll(where, step.down ?? 15)
        Object.assign(done, { how: 'scroll', down: step.down ?? 15, ...(where && { x: where.x, y: where.y }) })
      } else if (step.do === 'open_url') {
        await io.openUrl(step.url)
        Object.assign(done, { how: 'open_url', url: step.url })
      } else if (step.do === 'open_app') {
        await io.openApp(step.name)
        Object.assign(done, { how: 'open_app', name: step.name })
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500))
        done.how = 'wait'
      }
      const acted = performance.now()
      if (done.how !== 'already') done.detail = `${by ? `${by} · ` : ''}${seconds(acted - started)}`
      history.push(done)
      at += 1
      await io.note({ ...done, ms: { decide: Math.round(decided - started), act: Math.round(acted - decided) } })

      if (['read', 'wait'].includes(step.do) || done.how === 'already') continue
      // After an action the screen is still moving, so it is read again once it has settled.
      const after = await (io.settle ? io.settle(step.do === 'open_url' ? { url: step.url } : {}) : io.look())
      const changed = fingerprint(after) !== fingerprint(before) || titleOf(after) !== titleOf(before)
      unchanged = changed || step.do === 'scroll' ? 0 : unchanged + 1
      before = after
      // Checked with no model: the control it expected is there, or the screen changed at all.
      // Only a run of actions that changed nothing stops the plan.
      if (unchanged >= STUCK) {
        return finish('handback', `The last ${String(STUCK)} actions changed nothing on screen, so it stopped rather than keep pressing.`, { rows: table(after, 200), remaining: plan.slice(at) })
      }
      const met = step.expect === undefined || table(after, 200).some((one) => one.name.toLowerCase().includes(step.expect.toLowerCase()))
      if (!met) done.detail = `${done.detail} · “${step.expect}” not seen`
    } finally {
      clearTimeout(slow)
      waiting = undefined
      running = false
    }
  }
  return finish('done', history.some((one) => one.how === 'read') ? readOut(values) : 'Every step of the plan ran.')

  function finish(outcome, said, { rows, choice, remaining, answer } = {}) {
    running = false
    show()
    return {
      outcome,
      said,
      steps: history,
      rungs,
      values,
      ...(answer !== undefined && { answer }),
      ...(rows && { rows }),
      ...(choice && { choice }),
      ...(remaining && remaining.length > 0 && { remaining }),
    }
  }
}

/** A name read off the screen, without the length YouTube and others append to a title. */
export const tidy = (name) =>
  String(name)
    .replace(/\s+\d+\s+(?:hours?|minutes?|seconds?)(?:,?\s+\d+\s+(?:minutes?|seconds?))*\s*$/i, '')
    .trim()

/** `{title}` in an answer's text, filled from what was read. A value never read stays visible as `{title}`. */
export const fill = (text, values) => String(text).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (all, name) => (values[name] !== undefined ? String(values[name]) : all))

const readOut = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\n')

/** The middle of the window: its own row's centre, else the middle of what is listed. */
function middle(rows) {
  const window = rows.find((row) => row?.type === 'Window' && Number.isFinite(row.x))
  if (window) return { x: window.x, y: window.y }
  const placed = rows.filter((row) => Number.isFinite(row?.x) && Number.isFinite(row?.y))
  if (placed.length === 0) return undefined
  const xs = placed.map((row) => row.x).sort((a, b) => a - b)
  const ys = placed.map((row) => row.y).sort((a, b) => a - b)
  return { x: xs[Math.floor(xs.length / 2)], y: ys[Math.floor(ys.length / 2)] }
}

const seconds = (ms) => (ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`)

/** A step in a person's words: the plan's own `say`, else made from what it does. */
export const sayOf = (step) =>
  step.say ??
  (step.do === 'open_url' ? `Open ${hostOf(step.url)}`
  : step.do === 'open_app' ? `Open ${String(step.name)}`
  : step.do === 'press' ? `Press “${String(step.target)}”`
  : step.do === 'type' ? `Type into “${String(step.target)}”`
  : step.do === 'key' ? `Press ${String(step.keys)}`
  : step.do === 'scroll' ? 'Scroll'
  : step.do === 'read' ? `Read “${String(step.target)}”`
  : step.do === 'answer' ? 'Answer'
  : 'Wait')

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return 'the page'
  }
}

/**
 * Find the control a step means: exact, words, role, then Laya or Jev between the few likeliest.
 *
 * Returns `{ row, by }`, or `{ why, choice }` when nothing was sure — the caller hands back.
 */
export async function ground({ goal, window, step, rows }, io, rungs = {}) {
  const found = (row, by) => {
    rungs[by] = (rungs[by] ?? 0) + 1
    io.grounded?.({ step: `${String(step.do)} ${String(step.target)}`, options: JSON.stringify(shortlist(rows, step, TIE_MOST).map((one) => `${one.type} “${one.name}”`)), chosen: `${row.type} “${row.name}”`, by })
    return { row, by }
  }
  const hit = exact(rows, step)
  if (hit) return found(hit, 'exact')
  const plain = clearly(rows, step)
  if (plain) return found(plain, 'words')
  // A role is a reading of the words, not a second opinion, so it never presses what commits.
  const role = byRole(rows, step)
  if (role && !(risky(role.name) && step.do === 'press')) return found(role, 'role')

  const likely = shortlist(rows, step, TIE_MOST)
  const liked = favourite(rows, step)
  let choice
  let why = `Nothing on screen is plainly “${String(step.target)}”.`
  if (io.laya && likely.length > 1) {
    const body = groundRequest({ goal, window, step, rows: likely })
    const fromLaya = await io
      .laya(body)
      .then((result) => readChoice(result, body, likely, 'Laya'))
      .catch((error) => ({ error }))
    // Sure, and — when the words have a favourite — the same one: two signals agreeing.
    const agreed = fromLaya?.row !== undefined && (liked === undefined || fromLaya.row === liked)
    if (agreed && fromLaya.sure >= TIE_SURE && enough(fromLaya)) return found(fromLaya.row, 'laya')
    if (fromLaya?.row) choice = fromLaya
    why = fromLaya?.error ? fromLaya.error.message : unsure(fromLaya, 'Laya')
  }
  if (io.jev && likely.length > 1) {
    const body = groundRequest({ goal, window, step, rows: likely })
    const fromJev = await io
      .jev(body)
      .then((result) => result && readChoice(result, body, likely, 'Jev'))
      .catch((error) => ({ error }))
    if (enough(fromJev)) return found(fromJev.row, 'jev')
    if (fromJev?.row) choice = fromJev
    if (fromJev?.error) why = fromJev.error.message
    else if (fromJev?.row) why = unsure(fromJev, 'Jev')
  }
  return { why, choice }
}

/**
 * Press through the control when that reaches it, and click its middle when it does not.
 *
 * `invoke` finds a control by the first name that *contains* the text, which can be a different
 * control; a control with no way to be pressed comes back `none`. In both cases the click lands
 * on the row that was chosen, by the coordinates read for it.
 */
async function pressRow(io, rows, row) {
  if (pressReaches(rows, row)) {
    const done = await io.press(row)
    if (done.how === 'disabled') throw new Error(`“${row.name}” is greyed out, so nothing was pressed.`)
    if (done.found && done.how !== 'none') return { how: 'press' }
  }
  await io.click(row)
  return { how: 'click', x: row.x, y: row.y }
}

const describe = (step, row, by) =>
  step.do === 'open_url' ? `open ${String(step.url)}`
  : step.do === 'open_app' ? `open ${String(step.name)}`
  : ['press', 'type', 'read'].includes(step.do) ? `${step.do} “${String(row?.name ?? step.target)}”${by ? ` (${by})` : ''}`
  : step.do === 'key' ? `key ${String(step.keys)}`
  : step.do === 'scroll' ? 'scroll'
  : step.do
