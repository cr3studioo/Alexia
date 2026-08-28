// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

/** One row per thing done, in this plugin's own namespace. Deleting it takes the log too. */
const noted = (what, detail) =>
  alexia.storage.insert('actions', { what, detail: String(detail).slice(0, 500), at: Date.now() }).catch(() => {})

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
      'in pixels. Use before clicking or typing, to see what is actually on screen, and ' +
      'after, to check what happened. Takes no arguments.',
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
      'top left of the screenshot. Use after taking a screenshot and working out where the ' +
      'thing you want actually is.',
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
      'Ctrl+V, %{F4} for Alt+F4. Use for anything that is not ordinary text.',
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
    await noted(String(action), `${x ?? ''} ${y ?? ''} ${keys ?? ''}`.trim())
    return { content: [{ type: 'text', text: `Did it: ${String(action)}.` }] }
  },
)

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
alexia.onSettingsChanged((changed) => {
  if ('allow_input' in changed) void bind()
})
log.info(`${alexia.manifest.name} is ready`)
