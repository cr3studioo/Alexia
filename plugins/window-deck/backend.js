// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * The one protocol both platforms speak.
 *
 * A backend is a constant script and a **runner** that hands it a JSON question and brings back
 * what it printed. Values never become script text: they travel beside it (an environment
 * variable for PowerShell, `argv` for `osascript`), so nothing a model or a window title says
 * is ever code. The tests fake the runner and nothing else.
 *
 * - `{do:'list'}` → `{windows:[row], monitors:[{x,y,w,h,work,primary}]}`
 * - `{do:'apply', ops:[{id, rect?, then?}]}` → `{results:[{id, ok, why?, gone?, unchanged?, window?}]}`
 * - `{do:'quit', app, force, spare, waitMs}` → `{found, windows, open, running}`
 * - `{do:'open', app, path?, aumid?}` → `{opened:true}`
 *
 * A script that must not go on answers `{refused:"a sentence"}`.
 */

/** Longer than any script should take; a hung one is killed rather than waited on. */
export const SCRIPT_MS = 60_000

/** Run a program and give back its standard output as UTF-8, or the last thing it complained of. */
export function runProgram(file, args, { signal, env, explain, timeout = SCRIPT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, env, timeout, windowsHide: true })
    const out = []
    const said = []
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => said.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      // Joined before decoding: a character split across two chunks stays one character.
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8').trim())
      const complaint = Buffer.concat(said).toString('utf8').trim()
      const why =
        code === null ? 'It took too long, so it was stopped.' : (explain?.(complaint) ?? complaint.split('\n')[0]?.trim())
      reject(new Error(why || `The helper exited ${String(code)}.`))
    })
  })
}

const number = (value, otherwise = 0) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : otherwise)
const list = (value) => (Array.isArray(value) ? value : value ? [value] : [])

function rect(one) {
  return { x: number(one?.x), y: number(one?.y), w: Math.max(0, number(one?.w)), h: Math.max(0, number(one?.h)) }
}

/** How much of `a` lies inside `b`, in pixels. */
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** How far apart two rectangles' middles are, squared. */
const apart = (a, b) => (a.x + a.w / 2 - b.x - b.w / 2) ** 2 + (a.y + a.h / 2 - b.y - b.h / 2) ** 2

/** The monitor a window is on: the one holding most of it, else the nearest. */
export function monitorOf(window, monitors) {
  let best
  for (const monitor of monitors) {
    const score = [overlap(window, monitor), -apart(window, monitor)]
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
      best = { monitor, score }
    }
  }
  return best?.monitor
}

/** One window row, coerced to its types. `launch` is how to start its app again. */
export function readWindow(raw) {
  const launch = {
    ...(typeof raw?.path === 'string' && raw.path !== '' && { path: raw.path }),
    ...(typeof raw?.aumid === 'string' && raw.aumid !== '' && { aumid: raw.aumid }),
  }
  return {
    id: String(raw?.id ?? ''),
    app: String(raw?.app ?? ''),
    title: String(raw?.title ?? ''),
    ...rect(raw),
    minimized: raw?.minimized === true,
    maximized: raw?.maximized === true,
    launch,
  }
}

/**
 * What a `list` printed, as windows and monitors. Monitors are numbered from 1, left to right and
 * then top to bottom, so the same desk gets the same numbers every time.
 */
export function readList(raw) {
  const monitors = list(raw?.monitors)
    .map((one) => ({ ...rect(one), work: rect(one?.work ?? one), primary: one?.primary === true }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((one, index) => ({ id: index + 1, ...one }))
  if (monitors.length === 0) throw new Error('No screen answered, so there is nothing to arrange windows on.')
  const windows = list(raw?.windows)
    .map(readWindow)
    .filter((one) => one.id !== '')
    .map((one) => ({ ...one, monitor: monitorOf(one, monitors).id }))
  return { windows, monitors }
}

const readResult = (raw) => ({
  id: String(raw?.id ?? ''),
  ok: raw?.ok === true,
  why: typeof raw?.why === 'string' ? raw.why : '',
  gone: raw?.gone === true,
  unchanged: raw?.unchanged === true,
  window: raw?.window ? readWindow(raw.window) : undefined,
})

const readQuit = (raw) => ({
  found: number(raw?.found),
  // null when the platform could not count windows (macOS without Accessibility).
  windows: raw?.windows === null ? null : number(raw?.windows),
  open: number(raw?.open),
  running: number(raw?.running),
})

/** The four operations, over one script and one runner. */
export function createBackend(run, script) {
  async function ask(question, signal) {
    const out = await run(script, question, signal)
    let answer
    try {
      answer = JSON.parse(out)
    } catch {
      throw new Error('The helper that reads the windows answered with something unreadable.')
    }
    if (typeof answer?.refused === 'string') throw new Error(answer.refused)
    return answer
  }

  return {
    list: async (signal) => readList(await ask({ do: 'list' }, signal)),
    apply: async (ops, signal) => list((await ask({ do: 'apply', ops }, signal))?.results).map(readResult),
    quit: async (what, signal) => readQuit(await ask({ do: 'quit', ...what }, signal)),
    open: async (what, signal) => void (await ask({ do: 'open', ...what }, signal)),
  }
}
