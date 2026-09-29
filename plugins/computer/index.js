// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log, plugin } from '@alexia/sdk'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, free, MAX_STEPS, replay, STEPS } from './replay.js'
import { desktop } from './desktop.js'
import { askJev, askLaya, commits, groundRequest, jevCost, LAYA_ADDRESS, readSteps } from './decide.js'
import { recipe } from './recipes.js'
import * as laya from './laya.js'
import { runTask, sayOf } from './task.js'

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
  const s = await settings()
  const helpers = []
  if (s.speed !== 'model' && own) {
    if (s.use_laya !== false) {
      const now = await laya.state(own, s.laya_address || LAYA_ADDRESS)
      // The health light (B8): warm and how its last decision went, loading, or off.
      const last = lastLaya ? `, last decision ${String(lastLaya.ms)} ms${Number.isFinite(lastLaya.sure) ? ` at ${String(Math.round(lastLaya.sure * 100))}%` : ''}` : ''
      helpers.push(now.state === 'ready' ? `Laya warm (${String(now.ms)} ms${last})` : now.state === 'starting' ? 'Laya loading' : `Laya ${now.state}`)
    }
    if (typeof s.typesafe_key === 'string' && s.typesafe_key.trim() !== '') {
      const spent = await jevSpent()
      const limit = Number.isFinite(Number(s.jev_daily_limit)) ? Number(s.jev_daily_limit) : JEV_LIMIT
      helpers.push(spent >= limit ? 'Jev paused, today’s limit reached' : `Jev $${spent.toFixed(3)} of $${limit.toFixed(2)} today`)
    }
  }
  const extra = [...helpers, ...(lastTask ? [lastTask] : [])].map((one) => ` · ${one}`).join('')
  const state =
    !desktop.supported() ? `▲ Not available on ${process.platform} yet`
    : s.allow_input === true ? `▲ Can move the mouse and type${extra}`
    : `● Looking only${extra}`
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

/**
 * **The controls a model has been told about, and where** — the only coordinates it can know.
 *
 * No model here sees a screenshot: core hands it `[file: screen-….png]` and nothing else. So a
 * click at a point no listing ever gave is a guess, and one run spent ten clicks at 500,350 and
 * 400,350 "after looking" at pictures it never saw. `click` only lands inside something that
 * `elements`, `read` or a handed-back `run_task` said was there, in the last few minutes.
 */
const told = []
const TOLD_MS = 5 * 60_000
const SLACK = 6

function remember(rows) {
  const now = Date.now()
  for (const row of rows ?? []) {
    if (Number.isFinite(row?.x) && Number.isFinite(row?.y)) told.push({ x: row.x, y: row.y, w: row.w, h: row.h, name: row.name, at: now })
  }
  while (told.length > 0 && (told.length > 2000 || now - told[0].at > TOLD_MS)) told.shift()
}

/** One control as the model reads it. */
function line(row) {
  const at = row.x === null || row.y === null ? 'not on screen right now' : `${row.x},${row.y}`
  const named = row.name === '' ? row.id : row.name
  return `${named}  [${row.type}]  ${at}${row.off ? '  (hidden)' : ''}${row.on ? '  (on)' : ''}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Site and path, so a tab already open on the same site is not taken for the page just asked for. */
const hostOf = (url) => {
  try {
    const at = new URL(url)
    return `${at.host}${at.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

/**
 * **What is on screen after an action, in the same answer** — so the model's next turn is spent
 * on the next step, not on asking what happened. A turn of Alexia's model took 4.8 s on
 * average in a run that took 36 of them; reading the window takes a tenth of that.
 *
 * It waits for the screen to settle: two looks 150 ms apart that agree, and after `open_url`
 * the new site's own controls there too (up to 6 s; 2.5 s after anything else). What is listed
 * is remembered, so `click` can use it.
 */
async function glance(signal, { url } = {}) {
  const rows = await settle(() => desktop.elements({ limit: 40 }, signal), signal, { url })
  const note = desktop.webNote?.() ? `\n\n${desktop.webNote()}` : ''
  if (rows.length === 0) return note
  remember(rows)
  return `\n\nOn screen now (no need to call elements):\n${rows.map(line).join('\n')}${note}`
}

/** Read the screen with `read` until it has settled, and give back the last reading. */
async function settle(read, signal, { url } = {}) {
  const until = Date.now() + (url ? 6000 : 2500)
  await sleep(url ? 300 : 200)
  let rows
  let last
  for (;;) {
    rows = await read().catch(() => [])
    const page = desktop.pageState?.()
    const now = rows.map((row) => `${row.name}|${String(row.x)},${String(row.y)}`).join('\n')
    // Settled is *the page's own controls are there and have stopped changing* — not the
    // browser's "complete", which a page full of adverts reaches seconds after it is usable,
    // and not the first look, which after Enter was still the suggestions dropdown.
    const arrived = url ? page !== undefined && hostOf(page.url) === hostOf(url) && rows.filter((row) => row.web).length >= 5 : true
    if ((arrived && now === last) || Date.now() > until || signal?.aborted) break
    last = now
    await sleep(150)
  }
  return rows
}

/** Why a click at this point is a guess, or `undefined` when it lands on a listed control. */
function guessed(x, y) {
  const now = Date.now()
  const on = told.some((row) => {
    if (now - row.at > TOLD_MS) return false
    const halfW = (Number.isFinite(row.w) ? row.w / 2 : 0) + SLACK
    const halfH = (Number.isFinite(row.h) ? row.h / 2 : 0) + SLACK
    return Math.abs(x - row.x) <= halfW && Math.abs(y - row.y) <= halfH
  })
  if (on) return undefined
  return (
    `Nothing listed is at ${String(Math.round(x))}, ${String(Math.round(y))}, so nothing was clicked. ` +
    'You cannot see screenshots — they are shown to the person, not to you — so a point that ' +
    'did not come from elements is a guess. List the window with elements and click a control ' +
    'it names, use press with its name, or hand the goal to run_task.'
  )
}

const unsupported = () =>
  refuse(
    `Computer control works on Windows and macOS, and this is ${process.platform}. Nothing was done.`,
  )

const shot = alexia.tool(
  'screenshot',
  {
    description:
      'Take a picture of the whole screen for the person to see. You will not see it: you get ' +
      'a file name, never the picture, so it tells you nothing about what is on screen or where ' +
      'to click. Use it only when the person asks for a screenshot. For what is on screen and ' +
      'where, use elements. Takes no arguments.',
    // Looking changes nothing. This is the one tool here that can honestly say so, and it
    // is why "look but not touch" is a useful state rather than a disabled plugin.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async (ctx) => {
    if (!desktop.supported()) return unsupported()
    if (!own) return refuse('Alexia has not given this plugin a folder to work in.')
    const to = join(own, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const size = await desktop.screenshot(to, ctx?.mcpReq?.signal)
    await noted('screenshot', to)
    await prune()
    return {
      content: [
        {
          type: 'text',
          text: `Saved ${to} (${size.width}x${size.height}) and showed it to the person. You cannot see it, so take no coordinates from it — elements says what is on screen and where.`,
        },
        // So the person watching can see what Alexia saw. The path was already in the text
        // above and was already useless to anybody not willing to go and find it.
        alexia.file(to, { mime: 'image/png', description: 'What was on screen' }),
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
    if (!desktop.supported()) return unsupported()
    const open = await desktop.windows(ctx?.mcpReq?.signal)
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
      'top left of the screen, and must be a control’s from elements: a point nothing listed ' +
      'is refused, because you cannot see the screen to pick one. Prefer the press tool where ' +
      'the thing has a name: it needs no coordinates, it cannot miss, and it does not take the ' +
      'pointer away from whoever is using it.',
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
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    const guess = guessed(x, y)
    if (guess) return refuse(guess)
    await desktop.click(x, y, button ?? 'left', double === true, ctx?.mcpReq?.signal)
    await noted('click', `${x},${y} ${button ?? 'left'}${double === true ? ' double' : ''}`)
    return { content: [{ type: 'text', text: `Clicked at ${Math.round(x)}, ${Math.round(y)}.${await glance(ctx?.mcpReq?.signal)}` }] }
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
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    await desktop.move(x, y, ctx?.mcpReq?.signal)
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
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
    } catch (error) {
      return refuse(error.message)
    }
    await desktop.type(text, ctx?.mcpReq?.signal)
    // The text itself is not written to the log. This tool is how a password gets typed,
    // and a plugin that keeps a copy of everything it typed is a keylogger with a manifest.
    await noted('type', `${String(text).length} characters`)
    return { content: [{ type: 'text', text: `Typed ${String(text).length} characters.` }] }
  },
)

alexia.tool(
  'key',
  {
    // The notation is the platform's: SendKeys on Windows, cmd+c on a Mac. Each backend says
    // its own, so a model is never taught a grammar the machine in front of it refuses.
    description: desktop.KEY_HELP,
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        keys: { type: 'string', description: desktop.KEY_NOTATION },
      },
      required: ['keys'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ keys }, ctx) => {
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
      await desktop.key(keys, ctx?.mcpReq?.signal)
    } catch (error) {
      // Including the grammar refusal, which is a sentence the model can act on: it says
      // what the notation is, so the next attempt is a corrected one rather than a repeat.
      return refuse(error.message)
    }
    await noted('key', keys)
    return { content: [{ type: 'text', text: `Pressed ${String(keys)}.${await glance(ctx?.mcpReq?.signal)}` }] }
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
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
      await desktop.focus(pid, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('focus', pid)
    return { content: [{ type: 'text', text: `Focused ${Math.round(pid)}.` }] }
  },
)

/**
 * **The direct rung: say what is wanted to the system or the app, before any pressing** (v2).
 *
 * Opening an app was four keystrokes into Spotlight and a hunt for the window; opening a page
 * was the same through a browser's address bar. Each is one call here, and each lands in the
 * log in plan form, so a saved plan can start with *open Mail* rather than with where Spotlight
 * happened to be. A script or a Shortcut asks the app itself — Music, Mail, Finder, Notes answer
 * AppleScript with their real objects — which is one call where the screen would be a dozen.
 */
alexia.tool(
  'open_app',
  {
    description:
      'Open an app by its name, or bring it to the front if it is already open — "Calculator", ' +
      '"Safari", "Spotify". Much faster and surer than opening it through Spotlight or the Dock. ' +
      'Answers with the process id to pass to the other tools.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'The app’s name, as it appears in the Applications folder or the Start menu.' } },
      required: ['name'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ name }, ctx) => {
    if (!desktop.supported()) return unsupported()
    let opened
    try {
      await mayTouch()
      opened = await desktop.openApp(name, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('open_app', opened.name, { do: 'open_app', name: opened.name })
    // Another browser than the chosen one: say where pages go, because a model that opens Safari
    // to browse in it then reads an empty Safari while every page lands in the chosen browser.
    const chosen = chosenBrowser(await settings())
    const elsewhere =
      chosen && BROWSERS.has(String(opened.name)) && opened.name !== chosen ?
        ` Web pages open in ${chosen}, the browser chosen in settings, not here: for anything on a web page, use run_task with open_url and no process id, and it works in ${chosen}.`
      : ''
    return {
      content: [
        {
          type: 'text',
          text:
            (opened.pid ?
              `Opened ${opened.name} (process id ${String(opened.pid)}). To get something done in it, give the goal to run_task with this process id.`
            : `Asked ${opened.name} to open; it has no window yet. Give it a moment, then list windows — do not open it again.`) + elsewhere,
        },
      ],
      structuredContent: opened,
    }
  },
)

alexia.tool(
  'open_url',
  {
    description:
      'Open a web page in the default browser, the one the person is signed in to: their ' +
      'accounts on any site open as them, with no password from you. Go straight ' +
      'to the page that does the job — studio.youtube.com, a settings page, or a site’s own ' +
      'search results address (https://www.amazon.com/s?k=usb+cable) — rather ' +
      'than clicking through from a home page. Typing into the browser’s address bar searches ' +
      'the web, not the site that is open.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { url: { type: 'string', description: 'The whole address, starting with https://.' } },
      required: ['url'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ url }, ctx) => {
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
      await desktop.openUrl(url, ctx?.mcpReq?.signal, chosenBrowser(await settings()))
    } catch (error) {
      return refuse(error.message)
    }
    await noted('open_url', url, { do: 'open_url', url: String(url) })
    const seen = await glance(ctx?.mcpReq?.signal, { url: String(url) })
    // Which browser it landed in, by process id: the default browser is not always the one a
    // model opened earlier, and a pid remembered from another app lists the wrong window.
    const browser = await desktop.front(ctx?.mcpReq?.signal).catch(() => null)
    const where = browser?.name ? ` in ${String(browser.name)}${browser.pid ? ` (process id ${String(browser.pid)})` : ''}` : ''
    return { content: [{ type: 'text', text: `Opened ${String(url)}${where}.${seen}` }] }
  },
)

alexia.tool(
  'scroll',
  {
    description:
      'Scroll whatever is under a point on screen: positive "down" scrolls down, negative up, ' +
      'in lines. A web page moves about a screenful every 15 lines, so to see what is further ' +
      'down use 15 or more, not 2 or 3. Use the middle of a list or page from elements. Answers ' +
      'with what is on screen afterwards.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        down: { type: 'number', description: 'Lines to scroll down; negative scrolls up. Defaults to 15, about a screenful.' },
        right: { type: 'number', description: 'Lines to scroll right; negative scrolls left.' },
      },
      required: ['x', 'y'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ x, y, down = 15, right = 0 }, ctx) => {
    if (!desktop.supported()) return unsupported()
    try {
      await mayTouch()
      await desktop.scroll(x, y, down, right, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('scroll', `${String(down)} at ${String(Math.round(x))},${String(Math.round(y))}`, { do: 'scroll', x, y, down, right })
    return { content: [{ type: 'text', text: `Scrolled ${String(down)} lines.${await glance(ctx?.mcpReq?.signal)}` }] }
  },
)

alexia.tool(
  'run_script',
  {
    description:
      'macOS: ask an app directly with AppleScript instead of pressing through its window — ' +
      'Music, Mail, Finder, Safari, Notes, Calendar, Reminders, System Events and many others ' +
      'answer with their real objects. One call where the screen would be many steps. Answers ' +
      'with what the script returned. Prefer an app’s own tools if Alexia has them.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The script, e.g. tell application "Music" to play playlist "Focus".' },
        language: { type: 'string', enum: ['AppleScript', 'JavaScript'], description: 'Defaults to AppleScript.' },
      },
      required: ['script'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ script, language }, ctx) => {
    if (!desktop.supported()) return unsupported()
    let out
    try {
      await mayTouch()
      out = await desktop.runScript(script, language, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    await noted('run_script', String(script))
    return { content: [{ type: 'text', text: out === '' ? 'Done; the script returned nothing.' : out }] }
  },
)

alexia.tool(
  'run_shortcut',
  {
    description:
      'macOS: run one of the person’s own Shortcuts by name. Leave the name out to list them. ' +
      'A Shortcut someone made for a job is the surest way to do that job.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'The Shortcut’s name, exactly. Leave out to list them.' } },
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ name }, ctx) => {
    if (!desktop.supported()) return unsupported()
    const signal = ctx?.mcpReq?.signal
    try {
      if (typeof name !== 'string' || name.trim() === '') {
        const all = await desktop.shortcuts(signal)
        return { content: [{ type: 'text', text: all.length > 0 ? all.join('\n') : 'There are no Shortcuts on this computer.' }] }
      }
      await mayTouch()
      const out = await desktop.runShortcut(name.trim(), signal)
      await noted('run_shortcut', name.trim())
      return { content: [{ type: 'text', text: out === '' ? `Ran “${name.trim()}”.` : out }] }
    } catch (error) {
      return refuse(error.message)
    }
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
    void settings().then(warm).catch(() => {})
    if (!desktop.supported()) return unsupported()
    let rows
    try {
      rows = await desktop.elements({ ...where({ pid, title, match }), limit }, ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    if (rows.length === 0 && typeof match === 'string' && match.trim() !== '') {
      // Not the same thing as an empty window, and saying it was sent a model off to take
      // screenshots it cannot see of a page that was there all along.
      return {
        content: [
          {
            type: 'text',
            text:
              `No control there has “${match.trim()}” in its name or id. That does not mean the ` +
              'window is empty: it may not have loaded yet, be further down, or be named ' +
              'differently (an icon button is often called by what it does). List the window ' +
              `without match to see what is there, or hand the goal to run_task.${desktop.webNote?.() ? ` ${desktop.webNote()}` : ''}`,
          },
        ],
      }
    }
    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Nothing there names itself. Either that window is not the one you meant, or it ' +
              'draws its own controls — a game, a canvas, a document inside a viewer, a remote ' +
              'desktop — and there is nothing in it to ask. You cannot see a screenshot of it ' +
              `either, so say so to the person rather than clicking at guessed points.${desktop.webNote?.() ? ` ${desktop.webNote()}` : ''}`,
          },
        ],
      }
    }
    const said = rows.map(line).join('\n')
    remember(rows)
    await noted('elements', `${String(rows.length)} controls`)
    return {
      content: [{ type: 'text', text: `${said}\n\nCoordinates are the middle of each control, on the screen as a whole.${desktop.webNote?.() ? `\n\n${desktop.webNote()}` : ''}` }],
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
    if (!desktop.supported()) return unsupported()
    let found
    try {
      found = await desktop.readElement(where({ pid, title, match }), ctx?.mcpReq?.signal)
    } catch (error) {
      return refuse(error.message)
    }
    if (!found.found) return refuse(`There is nothing called “${String(match ?? '')}” on screen.`)
    remember([found])
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
    if (!desktop.supported()) return unsupported()
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
    if (!desktop.supported()) return unsupported()
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
    return { content: [{ type: 'text', text: `Pressed “${step.match}”, without moving the pointer.${await glance(ctx?.mcpReq?.signal)}` }] }
  },
)

/**
 * **Computer use v3: the chat model's plan, carried out with no model in the loop.**
 *
 * The chat model writes the whole plan in its first turn — it answers in seconds, where a free
 * thinking model asked to plan took half a minute to a minute, or came back empty. Here each
 * step is done and checked; each control is found by exact name, words, role, then Laya or Jev
 * between the few likeliest (`task.js`). When a step cannot be done, it hands back with what is
 * on screen and the steps still to do, and the chat model sends the rest.
 *
 * With no steps, the plan that finished last time for this goal is used, then a recipe
 * (`recipes.js`). A read-only lookup that ends with an `answer` replies to the person itself
 * (`alexia/final`), which saves the chat model a turn.
 *
 * What stays the same whichever way it runs: the input toggle gates every action, every action
 * lands in the log, and the plan shows as a checklist in the chat, the Plans panel and on the
 * edge of the screen.
 */
alexia.tool(
  'run_task',
  {
    description:
      'Do a whole goal on this computer in one call, from a plan you write. Send the goal in one ' +
      'sentence and the steps in "steps": it runs them at once with no model in the loop, finds ' +
      'each control by name or role with a local model breaking ties, shows the person a ' +
      'checklist, and hands back with what is on screen and the steps left when one cannot be ' +
      'done. Start at the page that does the job with open_url rather than clicking through a ' +
      'home page. End a lookup with read then answer, and the person gets the answer directly. ' +
      'Without steps it uses the plan that worked last time, or a built-in one for common goals. ' +
      'The browser is the person’s own and already signed in to their accounts — school (Moodle, ' +
      'Bakaláři), mail, shops — so for anything in one of them, go there and do it: never ask ' +
      'for their password or tell them to fetch it themselves.',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What should be true when it is finished, in one sentence.' },
        steps: {
          type: 'array',
          description:
            'The plan, in order, at most 20. Each is one of {"do":"open_url","url":"https://…"}, ' +
            '{"do":"open_app","name":"Comet"}, {"do":"press","target":"what it is called on screen, or ' +
            'a role: the search box, the first video, the Latest tab"}, {"do":"type","target":"the ' +
            'search box","text":"what to type"}, {"do":"key","keys":"enter"}, {"do":"scroll","down":15}, ' +
            '{"do":"wait"}, {"do":"read","target":"the first video","as":"title"}, ' +
            '{"do":"answer","text":"The newest video is “{title}”."}. Add "say" (under six words, for ' +
            'the person) and "expect" (a word from a control that should show afterwards).',
          items: { type: 'object' },
        },
        confirmed: { type: 'boolean', description: 'True once the person agreed to a plan that sends, deletes or pays.' },
        pid: targeting.pid,
      },
      required: ['goal'],
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  (args, ctx) => doTask(args, ctx),
)

/** `run_task` itself, named so the Plans panel's *Do it again* runs exactly the same thing. */
async function doTask({ goal, steps, pid, confirmed }, ctx) {
    if (!desktop.supported()) return unsupported()
    const wanted = String(goal ?? '').trim()
    if (wanted === '') return refuse('A task needs a goal.')
    const s = await settings()
    const signal = ctx?.mcpReq?.signal
    // Which window the task reads and presses in. Not fixed: a page opened by the plan lands in
    // the browser chosen in settings, and the task follows it there (see `openUrl` below).
    let target = where({ pid })
    const began = performance.now()
    void warm(s)
    let done
    let app
    let plan
    // The plan's last shape, kept outside the try so a stop still leaves it in the panel.
    let lastStages = []
    const shown = (heading, stages) => {
      void alexia.status('plan_now', checklist(heading, stages)).catch(() => {})
    }
    try {
      await mayTouch()
      if (target.pid) await desktop.focus(target.pid, signal)
      let front = await desktop.front(signal).catch(() => null)
      // Handed another browser than the one chosen — a model that opened Safari on its own —
      // the task goes to the chosen one, where the pages it opens will be.
      const browser = chosenBrowser(s)
      if (browser && front?.name && BROWSERS.has(front.name) && front.name !== browser) {
        const opened = await desktop.openApp(browser, signal)
        if (opened?.pid) {
          target = { pid: opened.pid }
          await desktop.focus(opened.pid, signal).catch(() => {})
          front = { name: opened.name ?? browser, pid: opened.pid }
        }
      }
      app = front?.name ?? 'this app'
      const key = remembered(app, wanted)
      const saved = (await alexia.storage.get('auto_plans'))?.[key]
      plan = readSteps(steps) ?? readSteps(saved?.plan) ?? readSteps(recipe(wanted))
      const by = readSteps(steps) ? 'your plan' : readSteps(saved?.plan) ? 'the plan that worked last time' : plan ? 'a built-in plan' : undefined

      const useLaya = s.speed !== 'model' && s.use_laya !== false && (await layaUp(s))
      const jevKey = typeof s.typesafe_key === 'string' ? s.typesafe_key.trim() : ''
      const limit = Number.isFinite(Number(s.jev_daily_limit)) ? Number(s.jev_daily_limit) : JEV_LIMIT
      const look = () => desktop.elements({ ...target, limit: 200 }, signal)
      holding = undefined
      done = await runTask(
        wanted,
        {
          look,
          settle: ({ url } = {}) => settle(look, signal, { url }),
          // The page opens in the chosen browser, which may not be the window the task was
          // reading — so from here on it reads and presses in whichever browser now has it.
          openUrl: async (url) => {
            await desktop.openUrl(url, signal, chosenBrowser(s))
            const now = await desktop.front(signal).catch(() => null)
            if (now?.pid) target = { pid: now.pid }
          },
          openApp: (name) => desktop.openApp(name, signal),
          onPlan: (now) => {
            lastStages = now
            // The buttons on the running step (B2): take over while it runs, continue while held.
            const controls = holding ? [{ key: 'resume_task', label: 'Continue' }] : [{ key: 'pause_task', label: 'Take over' }]
            alexia.progress(ctx, now.filter((one) => one.state === 'done').length, Math.max(now.length, 1), now.find((one) => one.state === 'running')?.label, { stages: now, plan: true, controls })
            shown(`▲ ${wanted}`, now)
          },
          ...(useLaya && {
            laya: (body) => {
              const asked = performance.now()
              return askLaya({ address: s.laya_address || LAYA_ADDRESS, model: s.laya_model, key: typeof s.laya_key === 'string' ? s.laya_key.trim() : undefined, body, signal }).then((result) => {
                lastLaya = { ms: Math.round(performance.now() - asked), sure: Object.values(result?.answers ?? {})[0]?.confidence }
                return result
              })
            },
          }),
          ...(s.speed !== 'model' && jevKey !== '' && {
            // Undefined when today's budget is spent: the loop treats that as Jev not answering.
            jev: async (body) => {
              if ((await jevSpent()) >= limit) return undefined
              const result = await askJev({ key: jevKey, body, signal })
              await jevSpend(jevCost(result, body))
              return result
            },
          }),
          press: (row) => desktop.invoke({ ...target, match: row.name }, signal),
          click: (row) => desktop.click(row.x, row.y, 'left', false, signal),
          type: (text) => desktop.type(text, signal),
          key: (keys) => desktop.key(keys, signal),
          scroll: async (row, down) => {
            const at = row ?? (await desktop.cursor(signal))
            return desktop.scroll(at.x, at.y, down, 0, signal)
          },
          // Every control found, with what it was chosen from: labelled data for Laya's own
          // fine-tuning notebook (`laya_export`). Written, never read back by a task.
          grounded: (one) => void alexia.storage.insert('grounding', { goal: wanted, app, at: Date.now(), ...one }).catch(() => {}),
          paused: () => holding?.promise,
          note: (step) => {
            void alexia.storage.insert('steps', { app, goal: wanted, step: JSON.stringify(step), at: Date.now() }).catch(() => {})
            return noted(step.how ?? step.do, step.target ?? step.keys ?? step.url ?? step.name ?? '', planStep(step, target))
          },
          onStep: (n, what) => {
            void alexia.status('state', `▲ Driving — step ${String(n)}: ${what}`).catch(() => {})
          },
        },
        { signal, confirmed: confirmed === true, ...(plan && { steps: plan }) },
      )
      if (by && done.outcome !== 'confirm') log.info(`run_task “${wanted}”: ${by}, ${String(plan?.length ?? 0)} steps`)
      if (done.outcome === 'done' && plan) {
        const all = (await alexia.storage.get('auto_plans')) ?? {}
        await alexia.storage.set('auto_plans', { ...all, [key]: { plan, goal: wanted, app, at: Date.now() } })
      }
      if (plan) lastRun = { goal: wanted, plan, pid: target.pid }
    } catch (error) {
      const failed = lastStages.map((one) => (one.state === 'running' ? { ...one, state: 'failed', detail: 'did not finish' } : one))
      shown(`Stopped: ${wanted}`, failed)
      return refuse(error.message)
    } finally {
      holding?.release()
      holding = undefined
      await report()
    }
    const took = performance.now() - began
    shown(`${done.outcome === 'done' ? 'Done' : done.outcome === 'confirm' ? 'Waiting for your yes' : 'Stopped'}: ${wanted}`, lastStages)
    const used = Object.entries(done.rungs).filter(([, n]) => n > 0).map(([rung, n]) => `${rung} ${String(n)}`).join(' · ')
    await finishReport(took, used || 'no model')
    const did = done.steps.map((step, n) => `${String(n + 1)}. ${String(step.say ?? step.do)}${step.target && step.do !== 'type' ? ` → “${String(step.target)}”` : ''}${step.detail ? ` (${String(step.detail)})` : ''}`)
    remember(done.rows?.slice(0, 60))
    // A plan that finished without an answer of its own: what it left on screen is the answer's
    // material, so the chat model reads it here rather than asking for it again.
    const onScreen =
      done.rows ? `\n\nOn screen now:\n${done.rows.slice(0, 60).map(line).join('\n')}`
      : done.outcome === 'done' && done.answer === undefined ? await glance(signal)
      : ''
    const left = done.remaining ? `\n\nSteps not done yet — send them again, corrected, in a new run_task:\n${JSON.stringify(done.remaining)}` : ''
    const confirm = done.outcome === 'confirm' ? `\n\nThe plan:\n${(plan ?? []).map((step, n) => `${String(n + 1)}. ${sayOf(step)}`).join('\n')}` : ''
    // A page the browser would not let be read is why nothing on it could be found: say that,
    // rather than leave the model weighing the menu bar.
    const unreadable = done.outcome === 'handback' && desktop.webNote?.() ? `\n\n${desktop.webNote()}` : ''
    const weighing = done.choice?.alternatives && !unreadable ? `\nIt was weighing: ${done.choice.alternatives.map((one) => `“${one.name}” ${String(Math.round(one.p * 100))}%`).join(', ')}.` : ''
    const opened = [...(plan ?? [])].reverse().find((step) => step.do === 'open_url')?.url
    const card = done.outcome === 'done' && Object.keys(done.values).length > 0 ? { title: wanted, fields: done.values, ...(opened && { url: opened }) } : undefined
    const timing = { ms: Math.round(took), steps: done.steps.length, rungs: done.rungs, models: 0 }
    // The person gets the answer straight from the screen: nothing it pressed could commit
    // anything (`commits` would have asked first), and nothing a model wrote is in it.
    const final = done.outcome === 'done' && done.answer !== undefined && !commits(plan ?? [])
    return {
      content: [
        {
          type: 'text',
          text:
            done.outcome === 'done' && done.answer !== undefined ?
              done.answer
            : `${did.length > 0 ? `${did.join('\n')}\n\n` : ''}${done.said} (${seconds(took)})${weighing}${unreadable}${confirm}${left}${onScreen}`,
        },
      ],
      structuredContent: { outcome: done.outcome, ...timing, ...(card && { card }), ...(done.remaining && { remaining: done.remaining }) },
      _meta: {
        'alexia/timing': { ms: timing.ms, steps: timing.steps, models: 0 },
        ...(card && { 'alexia/card': card }),
        ...(final && { [FINAL_META]: done.answer }),
      },
    }
}

/** Browsers by the name macOS gives their app, for noticing a task is in the wrong one. */
const BROWSERS = new Set(['Safari', 'Comet', 'Google Chrome', 'Chromium', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Firefox', 'Vivaldi', 'Opera'])

/** The browser pages open in (B3): the one chosen in settings, or `undefined` for the default. */
const chosenBrowser = (s) => (typeof s.browser === 'string' && s.browser !== '' && s.browser !== 'default' ? s.browser : undefined)

/** The `_meta` key a tool's result carries its reply to the person under (core's `alexia/final`). */
const FINAL_META = 'alexia/final'

/** What a saved run is kept under: the app, and the goal with its spacing and case ironed out. */
const remembered = (app, goal) => `${app.toLowerCase()}|${goal.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '')}`

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

/** The task being run, so the Plans panel can do it again (`rerun_last`). */
let lastRun

/** The person holding the task (`pause_task`): a promise the loop waits on between steps. */
let holding

/** Laya's last decision, for the health light: how long it took and how sure it was. */
let lastLaya

/**
 * A plan as the Plans panel's *Now* shows it: a heading, then one line a step, ticked.
 *
 * The heading's first character is the status widget's colour: `▲` while it runs, and no mark
 * once it has stopped, so the last plan stays readable in the plain colour without looking busy.
 */
const MARK = { done: '✓', running: '▸', waiting: '○', failed: '✗' }
const checklist = (heading, stages) =>
  [heading, ...stages.map((one) => `${MARK[one.state] ?? '○'} ${one.label}${one.detail && one.state !== 'waiting' ? ` — ${one.detail}` : ''}`)].join('\n')

/** A step the loop took, as the action log's plan form. */
function planStep(step, window) {
  if (step.how === 'open_url') return { do: 'open_url', url: step.url }
  if (step.how === 'open_app') return { do: 'open_app', name: step.name }
  if (step.how === 'press') return { do: 'press', match: step.target, ...window }
  if (step.how === 'click') return { do: 'click', x: step.x, y: step.y }
  if (step.how === 'type') return { do: 'type', text: step.text }
  if (step.how === 'key') return { do: 'key', keys: step.keys }
  if (step.how === 'scroll') return { do: 'scroll', x: step.x, y: step.y, down: step.down }
  return { do: 'wait', ms: 500 }
}

/** Jev's spending today, in dollars, kept per day so it resets on its own at midnight. */
const JEV_LIMIT = 0.1
const today = () => new Date().toLocaleDateString('sv')
async function jevSpent() {
  const spent = (await alexia.storage.get('jev_spend')) ?? {}
  return spent.day === today() ? Number(spent.dollars) || 0 : 0
}
async function jevSpend(dollars) {
  await alexia.storage.set('jev_spend', { day: today(), dollars: (await jevSpent()) + dollars })
}

/**
 * Laya answering now? When it is installed but stopped, it is started — and this task goes on
 * without it rather than waiting the minute it takes to load; the next one has it.
 */
async function layaUp(s) {
  const address = s.laya_address || LAYA_ADDRESS
  if (await laya.health(address)) return true
  if (s.laya_auto_start !== false) void wakeLaya(s)
  return false
}

async function wakeLaya(s) {
  const address = s.laya_address || LAYA_ADDRESS
  const now = await laya.state(own, address)
  if (now.state !== 'stopped') return now
  try {
    laya.start(own, address, s.laya_model)
    return { state: 'starting', said: 'Laya is starting — loading its model.' }
  } catch (error) {
    return { state: 'stopped', said: error.message }
  }
}

/**
 * **Laya warm before it is needed** (A6). The first question to a checkpoint that has not been
 * asked for a while takes 0.6–3.4 s on this kind of machine; every later one 50–220 ms. So one
 * throwaway question goes to it whenever a task or a look starts, at most once a minute, and the
 * cold start is paid while the chat model is still writing the plan. Never awaited by a task.
 */
let warmedAt = 0
async function warm(s) {
  if (s.speed === 'model' || s.use_laya === false || Date.now() - warmedAt < 60_000) return
  warmedAt = Date.now()
  const address = s.laya_address || LAYA_ADDRESS
  if (!(await laya.health(address).catch(() => false))) {
    if (s.laya_auto_start !== false) void wakeLaya(s)
    return
  }
  const rows = [
    { index: '1', type: 'Button', name: 'OK' },
    { index: '2', type: 'Button', name: 'Cancel' },
  ]
  const body = groundRequest({ goal: 'warm up', window: '', step: { do: 'press', target: 'OK' }, rows })
  await askLaya({ address, model: s.laya_model, key: typeof s.laya_key === 'string' ? s.laya_key.trim() : undefined, body }).catch(() => {})
}

/** The status line after a task: how long, and which rungs did the work. */
async function finishReport(ms, how) {
  lastTask = `last task ${seconds(ms)}${how ? ` · ${how}` : ''}`
  await report()
}
let lastTask = ''

/**
 * The runtime half of `provides`. Seeing is answerable wherever this runs; controlling is
 * answerable only when the user turned it on — so the two go on and off separately, and a
 * caller asking for `computer.control` while it is off gets `-32050` rather than a refusal
 * halfway through a click.
 */
async function bind() {
  const { allow_input: allow } = await settings()
  const here = desktop.supported()
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
    if (!desktop.supported()) return unsupported()
    const signal = ctx?.mcpReq?.signal
    try {
      await mayTouch()
      // The same guard as `click`: turned away there, a model reaches for this one next.
      const guess = action === 'click' ? guessed(x ?? 0, y ?? 0) : undefined
      if (guess) return refuse(guess)
      if (action === 'click') await desktop.click(x ?? 0, y ?? 0, 'left', false, signal)
      else if (action === 'move') await desktop.move(x ?? 0, y ?? 0, signal)
      else if (action === 'type') await desktop.type(text ?? '', signal)
      else if (action === 'key') await desktop.key(keys ?? '', signal)
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
    // *not available here* on the ones that cannot run it anyway.
    const wrong = check(plan)
    if (wrong) return refuse(wrong)
    if (!desktop.supported()) return unsupported()
    // The saved steps as a checklist in the Plans panel's *Now*: before `n`, done; `n`, running.
    const labels = plan.map((step) => `${String(step.do)} ${String(step.match ?? step.url ?? step.name ?? step.keys ?? step.text ?? '')}`.trim().slice(0, 80))
    let at = 0
    const shown = (heading, current = 'running') =>
      checklist(heading, labels.map((label, i) => ({ label, state: i < at - 1 ? 'done' : i === at - 1 ? current : 'waiting' })))
    try {
      await mayTouch()
      /**
       * **The whole of what a decision costs, and it is passed in from here.**
       *
       * `replay.js` cannot reach a model — it imports `./desktop.js` and nothing else — so
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
          at = n
          void alexia.status('plan_now', shown(`▲ ${String(name)}`)).catch(() => {})
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
      // Stopped means stopped before the next step: every step counted ran.
      at = done.steps + 1
      void alexia.status('plan_now', shown(`${done.stopped ? 'Stopped' : 'Done'}: ${String(name)}`, 'waiting')).catch(() => {})
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
      void alexia.status('plan_now', shown(`Stopped: ${String(name)}`, 'failed')).catch(() => {})
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

/**
 * **Take over, then hand back** (B2). The person pauses a running task to do a step themselves
 * — a scroll, a sign-in — and the task waits between steps, then reads the screen again and
 * carries on from where it was. A pause never interrupts an action halfway.
 */
alexia.tool(
  'pause_task',
  {
    description: 'Hold the running task between steps so the person can use the computer. Takes no arguments.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    if (!holding) {
      let release
      const promise = new Promise((resolve) => (release = resolve))
      holding = { promise, release }
    }
    void alexia.status('state', '▲ Paused — you have the controls. Continue when you are done.').catch(() => {})
    return { content: [{ type: 'text', text: 'Paused. The task waits before its next step.' }] }
  },
)

alexia.tool(
  'resume_task',
  {
    description: 'Let a paused task carry on from the screen as it is now. Takes no arguments.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const held = holding
    holding = undefined
    held?.release()
    await report()
    return { content: [{ type: 'text', text: held ? 'Carrying on.' : 'Nothing was paused.' }] }
  },
)

/** The Plans panel's *Do it again*: the last plan, run the same way, with no model at all (B6). */
alexia.tool(
  'rerun_last',
  {
    description: 'Run the last task’s plan again. Takes no arguments.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async (_args, ctx) => {
    if (!lastRun) return refuse('No task has run since Alexia started, so there is nothing to do again.')
    return doTask({ goal: lastRun.goal, steps: lastRun.plan, pid: lastRun.pid }, ctx)
  },
)

/** The Plans panel's *Save as plan*: the last task's plan, kept under its goal (B6). */
alexia.tool(
  'save_last',
  {
    description: 'Keep the last task’s plan under its goal, so it shows in Saved sequences. Takes no arguments.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async () => {
    if (!lastRun) return refuse('No task has run since Alexia started, so there is nothing to save.')
    await alexia.storage.set('task_plans', { ...((await alexia.storage.get('task_plans')) ?? {}), [lastRun.goal]: { plan: lastRun.plan, at: Date.now() } })
    return { content: [{ type: 'text', text: `Saved “${lastRun.goal}” — ${String(lastRun.plan.length)} steps.` }] }
  },
)

/**
 * **Laya's own training data** (A7): every control a task found, as the JSON lines Laya's
 * fine-tuning notebook reads — the step as the question, what was on offer as the options, and
 * what was chosen as the answer. Laya zero-shot picks the right control about one time in three;
 * trained on this machine's own screens it should do much better.
 */
alexia.tool(
  'laya_export',
  {
    description: 'Write what tasks chose on screen as training data for Laya, and say where the file is. Takes no arguments.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const rows = await alexia.storage.select('grounding', { limit: 100_000 }).catch(() => [])
    if (rows.length === 0) return refuse('No task has found a control yet, so there is nothing to export.')
    const lines = rows.flatMap((row) => {
      const options = (() => {
        try {
          return JSON.parse(String(row.options))
        } catch {
          return []
        }
      })()
      if (!options.includes(row.chosen)) return []
      return [
        JSON.stringify({
          state: { goal: row.goal, app: row.app },
          questions: { target: { type: 'choice', instructions: `Which control is meant by: ${String(row.step)}?`, criteria: Object.fromEntries(options.map((one) => [one, one])) } },
          labels: { target: row.chosen },
        }),
      ]
    })
    const file = join(own, `laya-grounding-${today()}.jsonl`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    return { content: [{ type: 'text', text: `Wrote ${String(lines.length)} decisions to ${file}.` }] }
  },
)

/**
 * **Laya, set up and looked after from here** (`laya.js`): install once, then started with the
 * plugin and left running, so the first task after a pause does not wait for it to load.
 */
alexia.tool(
  'laya',
  {
    description:
      'Laya, the small decision model on this computer that makes run_task fast and free: say ' +
      '"status" to see how it is, "setup" to install it (about 2 GB, a few minutes, once), ' +
      '"start" or "stop".',
    inputSchema: fromJsonSchema({
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'setup', 'start', 'stop'] } },
      required: ['action'],
    }),
    annotations: { openWorldHint: true },
  },
  async ({ action }) => {
    const s = await settings()
    const address = s.laya_address || LAYA_ADDRESS
    try {
      if (action === 'setup') {
        const now = await laya.state(own, address)
        if (now.state !== 'missing') return { content: [{ type: 'text', text: now.said }] }
        await laya.install(own)
        return { content: [{ type: 'text', text: 'Installing Laya in the background — a few minutes and about 2 GB. Ask for its status to see how far it got; it starts by itself when it is done.' }] }
      }
      if (action === 'start') {
        const now = await wakeLaya(s)
        if (now.state === 'starting' && (await laya.ready(address, { timeoutMs: 60_000 }))) return { content: [{ type: 'text', text: 'Laya is ready.' }] }
        return { content: [{ type: 'text', text: (await laya.state(own, address)).said }] }
      }
      if (action === 'stop') {
        return { content: [{ type: 'text', text: laya.stop(own) ? 'Stopped Laya.' : 'This plugin did not start the Laya that is running, so it left it alone.' }] }
      }
      return { content: [{ type: 'text', text: (await laya.state(own, address)).said }] }
    } catch (error) {
      return refuse(error.message)
    } finally {
      await report()
    }
  },
)

await alexia.start()
own = (await alexia.host()).paths.ownDir
await bind()
alexia.onSettingsChanged((changed) => {
  if ('allow_input' in changed || 'speed' in changed || 'use_laya' in changed || 'typesafe_key' in changed) void bind()
})
// Laya is started with the plugin, and an install that just finished is started too.
void settings().then(warm).catch(() => {})
void (async () => {
  const s = await settings()
  if (s.speed !== 'model' && s.use_laya !== false && s.laya_auto_start !== false) await wakeLaya(s)
})()
log.info(`${alexia.manifest.name} is ready`)
