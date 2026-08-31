// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { check, free, MAX_STEPS, replay, STEPS } from './replay.js'
import * as win from './windows.js'

/**
 * Computer control (M4-2) — the reason the permission model exists.
 *
 * Every other plugin so far asks for something narrow: a microphone, a network call, a
 * folder. This one asks for *everything a person at this keyboard could do*, which is the
 * only honest way to describe moving a mouse and typing. It is here because a permission
 * model nobody has pointed at the worst case is a permission model nobody has tested.
 *
 * Three things it does that the others do not:
 *
 * - **Its tools are annotated honestly, and that costs it.** Nothing that touches the mouse
 *   or the keyboard claims `readOnlyHint`, so the default mode asks before every one of
 *   them. That is not a limitation to work around; it is the feature.
 * - **It has an off switch of its own.** *Allow it to move the mouse and type* is off by
 *   default, so an install that goes wrong can still only look. Looking is the useful half
 *   most of the time anyway.
 * - **It writes down what it did.** Every action lands in this plugin's own table, so
 *   "what did it just do" has an answer that is not a scroll back through the chat.
 *
 * The never-touch list, the folder scope and the checker all still apply above this: what
 * is here is the plugin being honest about itself, and core deciding is a separate thing.
 */

const alexia = plugin()

let own

const settings = () => alexia.settings()

/** Whether the user has turned on the half that touches things. Read per call, never cached. */
async function mayTouch() {
  const { allow_input: allow } = await settings()
  if (allow !== true) {
    throw new Error(
      'Computer control is set to look but not touch. Turn on “Allow it to move the mouse and type” in its settings first.',
    )
  }
}

/**
 * One row per thing done, in this plugin's own namespace. Deleting it takes the log too.
 *
 * `step` is the same row as JSON (M7-6), which is what makes recording a sequence free: the
 * log was already being written, so *save what just happened as a plan* is a read of it
 * rather than a second mechanism watching the same events.
 */
const noted = (what, detail, step) =>
  alexia.storage
    .insert('actions', {
      what,
      detail: String(detail).slice(0, 500),
      ...(step && { step: JSON.stringify(step) }),
      at: Date.now(),
    })
    .catch(() => {})

async function report() {
  const { allow_input: allow } = await settings()
  const state =
    !win.supported() ? `▲ Not available on ${process.platform} yet`
    : allow === true ? '▲ Can move the mouse and type'
    : '● Looking only'
  await alexia.status('state', state).catch(() => {})
}

/** Keep the last N screenshots and no more. A folder that only grows is a disk that fills. */
async function prune() {
  const { keep_screenshots: keep } = await settings()
  const limit = Number.isFinite(Number(keep)) ? Number(keep) : 20
  if (!own) return
  try {
    const shots = readdirSync(own)
      .filter((name) => name.startsWith('screen-') && name.endsWith('.png'))
      .sort()
    for (const old of shots.slice(0, Math.max(0, shots.length - limit))) {
      rmSync(join(own, old), { force: true })
    }
  } catch (error) {
    log.warn('could not tidy screenshots', error)
  }
}

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const unsupported = () =>
  refuse(
    `Computer control only works on Windows so far, and this is ${process.platform}. Nothing was done.`,
  )

const shot = alexia.tool(
  'screenshot',
  {
    description:
      'Take a picture of the whole screen and save it, returning the file path and the size ' +
      'in pixels. Nothing here reads the picture — for what is on screen and where, use the ' +
      'elements tool, which returns names and coordinates. Reach for this when a window draws ' +
      'its own controls and elements comes back empty, or when a person has asked for a ' +
      'screenshot. Takes no arguments.',
    // Looking changes nothing. This is the one tool here that can honestly say so, and it
    // is why "look but not touch" is a useful state rather than a disabled plugin.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    if (!win.supported()) return unsupported()
    if (!own) return refuse('Alexia has not given this plugin a folder to work in.')
    const to = join(own, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const size = await win.screenshot(to, ctx?.mcpReq?.signal)
    await noted('screenshot', to)
    await prune()
    return {
      content: [
        {
          type: 'text',
          text: `${to}\n${size.width}x${size.height} pixels. Coordinates for clicking are measured from the top left of this image.`,
        },
      ],
    }
  },
)

alexia.tool(
  'windows',
  {
    description:
      'List the open windows that have a title, with the process id of each. Use to find ' +
      'out what is running before switching to something. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    if (!win.supported()) return unsupported()
    const open = await win.windows(ctx?.mcpReq?.signal)
    const text =
      open.length === 0 ?
        'No window has a title right now.'
      : open.map((w) => `${w.Id}  ${w.ProcessName}  ${w.MainWindowTitle}`).join('\n')
    return { content: [{ type: 'text', text }] }
  },
)

alexia.tool(
  'click',
  {
    description:
      'Move the pointer to a screen coordinate and click. Coordinates are measured from the ' +
      'top left of the screen. Get them from the elements tool, which says where each control ' +
      'is. Prefer the press tool where the thing has a name: it needs no coordinates, it ' +
      'cannot miss, and it does not take the pointer away from whoever is using it.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixels from the left of the screen.' },
        y: { type: 'number', description: 'Pixels from the top of the screen.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which button. Defaults to left.' },
        double: { type: 'boolean', description: 'Double click rather than single.' },
      },
      required: ['x', 'y'],
    }),
    // A click can send an email, delete a file, or buy something. There is no honest
    // annotation here other than this one, and the prompt it produces is the point.
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ x, y, button, double }, ctx) => {
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    await win.click(x, y, button ?? 'left', double === true, ctx?.mcpReq?.signal)
    await noted('click', `${x},${y} ${button ?? 'left'}${double === true ? ' double' : ''}`)
    return { content: [{ type: 'text', text: `Clicked at ${Math.round(x)}, ${Math.round(y)}.` }] }
  },
)

alexia.tool(
  'move',
  {
    description: 'Move the pointer without clicking. Use to hover over something, or to get out of the way before a screenshot.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixels from the left of the screen.' },
        y: { type: 'number', description: 'Pixels from the top of the screen.' },
      },
      required: ['x', 'y'],
    }),
    // Moving the pointer changes nothing on its own, but it is still input on somebody's
    // machine and it is still gated by the toggle. `destructiveHint` would be a lie; a
    // bare declaration is the honest middle, and the default mode asks.
    annotations: { openWorldHint: true },
  },
  async ({ x, y }, ctx) => {
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    await win.move(x, y, ctx?.mcpReq?.signal)
    return { content: [{ type: 'text', text: `Pointer at ${Math.round(x)}, ${Math.round(y)}.` }] }
  },
)

alexia.tool(
  'type',
  {
    description:
      'Type text into whatever has focus, as if it came from the keyboard. Click the field ' +
      'first. Use for filling in a form or writing into a document.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to type. Typed literally, including punctuation.' } },
      required: ['text'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ text }, ctx) => {
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    await win.type(text, ctx?.mcpReq?.signal)
    // The text itself is not written to the log. This tool is how a password gets typed,
    // and a plugin that keeps a copy of everything it typed is a keylogger with a manifest.
    await noted('type', `${String(text).length} characters`)
    return { content: [{ type: 'text', text: `Typed ${String(text).length} characters.` }] }
  },
)

alexia.tool(
  'key',
  {
    description:
      'Press a key or a combination — {ENTER}, {TAB}, {ESC}, {F5}, ^c for Ctrl+C, ^v for ' +
      'Ctrl+V, %{F4} for Alt+F4, {WIN} for the Windows key on its own (this opens the start ' +
      'menu) and {WIN}r for Windows+R. Use for anything that is not ordinary text.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The combination, in SendKeys notation.' },
      },
      required: ['keys'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ keys }, ctx) => {
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
      await win.key(keys, ctx?.mcpReq?.signal)
    } catch (error) {
      // Including the grammar refusal, which is a sentence the model can act on: it says
      // what the notation is, so the next attempt is a corrected one rather than a repeat.
      return refuse(error.message)
    }
    await noted('key', keys)
    return { content: [{ type: 'text', text: `Pressed ${String(keys)}.` }] }
  },
)

alexia.tool(
  'focus',
  {
    description: 'Bring a window to the front, by the process id from the windows tool.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { pid: { type: 'number', description: 'The process id of the window to focus.' } },
      required: ['pid'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ pid }, ctx) => {
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
      await win.focus(pid, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('focus', pid)
    return { content: [{ type: 'text', text: `Focused ${Math.round(pid)}.` }] }
  },
)

/**
 * **Seeing, as opposed to taking a picture.**
 *
 * `screenshot` returns a path and a resolution, and nothing has ever read the pixels — so
 * `click`'s own description, *use after taking a screenshot and working out where the thing
 * you want actually is*, asks for something the tool surface could not do. These three close
 * that loop, and they do it with the accessibility tree rather than with OCR, because the
 * question a screen gets asked is not *what does this say* but *is the button there, and
 * where*. Only one of the two has an exact answer, and it is free.
 *
 * `screen.capture` already covers it: reading the control tree **is** seeing the screen, which
 * is what that permission grants and what its sentence already says.
 */
const where = ({ pid, title, match }) => ({
  ...(Number(pid) > 0 && { pid: Number(pid) }),
  ...(typeof title === 'string' && title.trim() !== '' && { title }),
  ...(typeof match === 'string' && match.trim() !== '' && { match }),
})

/** The three arguments every one of these takes, written once. */
const targeting = {
  pid: { type: 'number', description: 'Which window, by the process id from the windows tool. Leave out for whatever is in front.' },
  title: { type: 'string', description: 'Which window, by part of its title. Leave out for whatever is in front.' },
}

alexia.tool(
  'elements',
  {
    description:
      'List the controls in a window — every button, box, list and label — with its name, ' +
      'what kind of control it is, and where the middle of it is on screen. Use this instead ' +
      'of a screenshot when the question is where something is or whether it is there: it ' +
      'gives the coordinates a click needs, which a picture does not. Defaults to the window ' +
      'in front.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...targeting,
        match: { type: 'string', description: 'Only controls whose name or id contains this.' },
        limit: { type: 'number', description: 'How many at most. Defaults to 60.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ pid, title, match, limit }, ctx) => {
    if (!win.supported()) return unsupported()
    let rows
    try {
      rows = await win.elements({ ...where({ pid, title, match }), limit }, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Nothing there names itself. Either that window is not the one you meant, or it ' +
              'draws its own controls — a game, a canvas, a document inside a viewer, a remote ' +
              'desktop — and there is nothing in it to ask. A screenshot is the fallback for those.',
          },
        ],
      }
    }
    const said = rows
      .map((row) => {
        const at = row.x === null || row.y === null ? 'not on screen right now' : `${row.x},${row.y}`
        const named = row.name === '' ? row.id : row.name
        return `${named}  [${row.type}]  ${at}${row.off ? '  (hidden)' : ''}`
      })
      .join('\n')
    await noted('elements', `${String(rows.length)} controls`)
    return {
      content: [{ type: 'text', text: `${said}\n\nCoordinates are the middle of each control, on the screen as a whole.` }],
      structuredContent: { rows },
    }
  },
)

alexia.tool(
  'read',
  {
    description:
      'Read what one control says — the number in a calculator display, the text in a box, ' +
      'the label on a status bar. Use when the question is what something says rather than ' +
      'where it is. If a person could select the text, this returns it exactly; it is not OCR ' +
      'and it cannot read words that were painted rather than written.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...targeting,
        match: { type: 'string', description: 'Which control, by part of its name or id. Leave out for the window itself.' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ pid, title, match }, ctx) => {
    if (!win.supported()) return unsupported()
    let found
    try {
      found = await win.readElement(where({ pid, title, match }), ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    if (!found.found) return refuse(`There is nothing called “${String(match ?? '')}” on screen.`)
    return {
      content: [{ type: 'text', text: found.text === '' ? `“${found.name}” is there and says nothing.` : found.text }],
      structuredContent: found,
    }
  },
)

alexia.tool(
  'check',
  {
    description:
      'Check that something is true on screen — that a control is there, that it says a ' +
      'particular thing, or that it has gone. Use after doing something, to make sure it ' +
      'actually worked, rather than assuming it did. Checking once and then saving the ' +
      'sequence as a plan is how a repeated job gets checked every time without a model.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...targeting,
        match: { type: 'string', description: 'Which control, by part of its name or id.' },
        says: { type: 'string', description: 'What it has to say. Left out, being there at all is the check.' },
        gone: { type: 'boolean', description: 'Check that it is *not* there — a dialog that should have closed.' },
      },
      required: ['match'],
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ pid, title, match, says, gone }, ctx) => {
    if (!win.supported()) return unsupported()
    const step = {
      do: 'expect',
      match: String(match ?? ''),
      ...(Number(pid) > 0 && { pid: Number(pid) }),
      ...(typeof title === 'string' && title.trim() !== '' && { title }),
      ...(says !== undefined && { says: String(says) }),
      ...(gone === true && { gone: true }),
    }
    try {
      await STEPS.expect(step, ctx?.mcpReq?.signal)
    } catch (error) {
      // A failed check is a refusal rather than a `false`, because the caller that ignores a
      // `false` is the caller this exists to catch.
      return refuse(error.message)
    }
    // Written to the log in the shape a plan holds, which is what makes `save_plan` pick it
    // up: record the check once, and every replay from then on checks itself.
    await noted('check', step.match, step)
    return { content: [{ type: 'text', text: `Checked: ${describe(step)}.` }] }
  },
)

const describe = (step) =>
  step.gone === true ? `“${step.match}” is gone`
  : step.says === undefined ? `“${step.match}” is there`
  : `“${step.match}” says ${step.says}`

alexia.tool(
  'press',
  {
    description:
      'Press a control by name — a button, a checkbox, a menu item, a list row — without ' +
      'using the mouse at all. Prefer this to clicking: it needs no coordinates, it cannot ' +
      'miss, and it does not take the pointer away from whoever is using it. Falls back to ' +
      'saying so when the control offers no way to be pressed, so a click can be used instead.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        ...targeting,
        match: { type: 'string', description: 'Which control, by part of its name or id.' },
      },
      required: ['match'],
    }),
    // It presses buttons in somebody's applications. There is no honest annotation but this
    // one, and the fact that no pointer moves does not make it less of an action.
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ pid, title, match }, ctx) => {
    if (!win.supported()) return unsupported()
    const step = {
      do: 'press',
      match: String(match ?? ''),
      ...(Number(pid) > 0 && { pid: Number(pid) }),
      ...(typeof title === 'string' && title.trim() !== '' && { title }),
    }
    try {
      // Gated with the mouse and the keyboard, deliberately. It reaches the application by a
      // different road, and *look but not touch* is about the touching rather than the road.
      await mayTouch()
      await STEPS.press(step, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('press', step.match, step)
    return { content: [{ type: 'text', text: `Pressed “${step.match}”, without moving the pointer.` }] }
  },
)

/**
 * The runtime half of `provides`. Seeing is answerable wherever this runs; controlling is
 * answerable only when the user turned it on — so the two go on and off separately, and a
 * caller asking for `computer.control` while it is off gets `-32050` rather than a refusal
 * halfway through a click.
 */
async function bind() {
  const { allow_input: allow } = await settings()
  const here = win.supported()
  shot.update({ _meta: here ? { 'alexia/provides': ['computer.screenshot'] } : {} })
  controller.update({ _meta: here && allow === true ? { 'alexia/provides': ['computer.control'] } : {} })
  await report()
}

/**
 * One entry point for the capability, separate from the individual tools.
 *
 * Another plugin wanting *computer control* wants to do a thing, not to learn this
 * plugin's tool names — and it must never learn them, because learning them is depending
 * on this plugin by name.
 */
const controller = alexia.tool(
  'do',
  {
    description:
      'Do one thing on the screen: click somewhere, type something, or press a key. Prefer ' +
      'the specific tools; this exists so another plugin can ask for computer control ' +
      'without knowing what any of them are called.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'move', 'type', 'key'], description: 'What to do.' },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        keys: { type: 'string' },
      },
      required: ['action'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ action, x, y, text, keys }, ctx) => {
    if (!win.supported()) return unsupported()
    const signal = ctx?.mcpReq?.signal
    try {
      await mayTouch()
      if (action === 'click') await win.click(x ?? 0, y ?? 0, 'left', false, signal)
      else if (action === 'move') await win.move(x ?? 0, y ?? 0, signal)
      else if (action === 'type') await win.type(text ?? '', signal)
      else if (action === 'key') await win.key(keys ?? '', signal)
      else return refuse(`"${String(action)}" is not something this can do.`)
    } catch (error) {
      return refuse(error.message)
    }
    await noted(String(action), `${x ?? ''} ${y ?? ''} ${keys ?? ''}`.trim(), {
      do: String(action),
      ...(x !== undefined && { x }),
      ...(y !== undefined && { y }),
      ...(text !== undefined && { text }),
      ...(keys !== undefined && { keys }),
    })
    return { content: [{ type: 'text', text: `Did it: ${String(action)}.` }] }
  },
)

/**
 * The bottom two rungs (M7-6): a sequence saved, and a sequence replayed.
 *
 * **Recording is a read of a log that already existed.** Every action this plugin takes is
 * written to `actions` for the *what did it just do* question, and a plan is the last few of
 * those rows. No recorder, no second mechanism watching the same events, and nothing to keep
 * in step with the first one.
 */
const plans = async () => (await alexia.storage.get('plans')) ?? {}

alexia.tool(
  'save_plan',
  {
    description:
      'Save what was just done as a plan that can be replayed without a model. Takes a name ' +
      'and, optionally, how many of the last actions to keep. Use after doing something the ' +
      'user says they will want again.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What to call it.' },
        steps: { type: 'number', description: `How many of the last actions. Defaults to 10, at most ${String(MAX_STEPS)}.` },
      },
      required: ['name'],
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ name, steps }) => {
    const called = String(name ?? '').trim()
    if (called === '') return refuse('A plan needs a name.')
    const many = Math.min(MAX_STEPS, Math.max(1, Number(steps) || 10))
    const rows = await alexia.storage.select('actions', { order: [['at', 'desc']], limit: many })
    const plan = rows
      .reverse()
      .flatMap((row) => {
        try {
          return [JSON.parse(String(row.step))]
        } catch {
          // A row written before this existed, or one that was not a replayable action.
          return []
        }
      })
      .filter((step) => step && String(step.do) in STEPS)
    const wrong = check(plan)
    if (wrong) return refuse(`Nothing to save: ${wrong}.`)
    await alexia.storage.set('plans', { ...(await plans()), [called]: plan })
    return {
      content: [
        {
          type: 'text',
          text: `Saved “${called}” — ${String(plan.length)} step${plan.length === 1 ? '' : 's'}, and replaying it costs nothing.`,
        },
      ],
    }
  },
)

alexia.tool(
  'plans',
  {
    description: 'List the saved plans, how many steps each has, and whether replaying one costs anything. Takes no arguments.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    const held = await plans()
    const rows = Object.entries(held).map(([name, plan]) => ({
      id: name,
      name,
      steps: plan.length,
      // The line this whole task is about, on the row rather than in a document.
      cost: free(plan) ? 'nothing — no model in the path' : 'one model call, at the decision',
    }))
    return { content: [{ type: 'text', text: `${rows.length} plans` }], structuredContent: { rows } }
  },
)

alexia.tool(
  'replay_plan',
  {
    description:
      'Do a saved plan again. A plan with no decisions in it runs with no model at all. Takes ' +
      'the plan’s name.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'Which plan.' } },
      required: ['name'],
    }),
    // Every step in it is something this plugin's own tools do, and those are annotated
    // honestly — so this one is too. The gate asks once for the sequence rather than once
    // per click, which is the trade the middle and bottom rungs are made of.
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ name }, ctx) => {
    const plan = (await plans())[String(name ?? '')]
    if (!plan) return refuse(`There is no plan called “${String(name ?? '')}”.`)
    // A plan is data a person can hand-edit, so it is checked for what it holds before the
    // platform gate — an unrunnable step is rejected as such on every OS, not hidden behind
    // "Windows only" on the ones that cannot run it anyway.
    const wrong = check(plan)
    if (wrong) return refuse(wrong)
    if (!win.supported()) return unsupported()
    try {
      await mayTouch()
      /**
       * **The whole of what a decision costs, and it is passed in from here.**
       *
       * `replay.js` cannot reach a model — it imports `./windows.js` and nothing else — so
       * this is the only way one enters, and a plan with no `ask` steps never reaches this
       * line. A script is free by construction rather than by intention.
       */
      const done = await replay(plan, {
        signal: ctx?.mcpReq?.signal,
        /**
         * **What tells a person that Alexia is driving, right now.**
         *
         * This plugin's stated safety model is a sentence in its own settings — *turn this on
         * only while you are watching* — and until this line it gave a watcher nothing to
         * watch. The Plans panel records what happened afterwards; nothing marked what was
         * happening. A replay in particular is the case that needs it most, because the
         * permission gate asks **once** for a sequence that then presses sixty things.
         *
         * It is the progress channel MCP already has, which core already streams to the live
         * panel a frame at a time, so what is on screen is never more than a moment behind
         * what the mouse is doing. Nothing new, nothing to miss, and no window of its own.
         */
        onStep: (n, what) => {
          alexia.progress(ctx, n, plan.length, `${String(name)}: ${what}`)
          void alexia.status('state', `▲ Driving — step ${String(n)} of ${String(plan.length)} of “${String(name)}”`).catch(() => {})
        },
        ask: async (question) => {
          const answer = await alexia.server.server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: question } }],
            maxTokens: 200,
          })
          return answer.content?.type === 'text' ? answer.content.text.trim() : ''
        },
      })
      await noted('replay', `${String(name)} — ${String(done.steps)} steps`)
      return {
        content: [
          {
            type: 'text',
            text: `${done.stopped ? 'Stopped after' : 'Did'} ${String(done.steps)} step${done.steps === 1 ? '' : 's'} of “${String(name)}”${free(plan) ? ', costing nothing' : ''}.`,
          },
        ],
      }
    } catch (error) {
      // Including a failed `expect`. A postcondition that does not hold stops the sequence
      // where it stopped being true, and says which check it was — which is the whole reason
      // the step exists: sixty successes reported by something that could not observe are
      // sixty claims, and this is the one that turns them into a count.
      return refuse(error.message)
    } finally {
      // The indicator goes back, whatever happened. A state that says *driving* after it has
      // stopped is worse than no state at all.
      await report()
    }
  },
)

alexia.tool(
  'forget_plan',
  {
    description: 'Delete a saved plan. Takes its name.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'Which plan.' } },
      required: ['name'],
    }),
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ name }) => {
    const held = await plans()
    const called = String(name ?? '')
    if (!(called in held)) return refuse(`There is no plan called “${called}”.`)
    await alexia.storage.set(
      'plans',
      Object.fromEntries(Object.entries(held).filter(([one]) => one !== called)),
    )
    return { content: [{ type: 'text', text: `“${called}” is gone.` }] }
  },
)

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
alexia.onSettingsChanged((changed) => {
  if ('allow_input' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
