// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'

/**
 * Starting ComfyUI, rather than waiting for somebody else to.
 *
 * **This is the difference between a plugin that works and a plugin that explains why it
 * cannot.** *ComfyUI is not running* was by far the commonest state of this plugin, and the
 * honest sentence it answered with — *start it and try again, it is a separate program* —
 * is a person being handed a chore by a machine that could have done it. So it does it.
 *
 * Nothing here embeds ComfyUI or ships a copy of it. It finds the one already on this
 * machine, works out which Python that install was set up with, and spawns `main.py` the
 * same way the user's own shortcut does. If there is no install, that is said plainly and
 * nothing is downloaded — a plugin that quietly pulls six gigabytes of PyTorch because
 * somebody asked for a picture is a plugin that has decided something for you.
 */

/** A file that is there and is not an empty stub. */
const file = async (path) => {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/**
 * Is this folder a ComfyUI?
 *
 * Two files rather than one: `main.py` alone is the commonest filename in Python and would
 * match half the folders on a machine. `main.py` beside `nodes.py` is ComfyUI's own layout
 * and has been since the first release.
 */
export const isInstall = async (dir) =>
  (await file(join(dir, 'main.py'))) && (await file(join(dir, 'nodes.py')))

/**
 * Folders where somebody's ComfyUI actually is.
 *
 * ponytail: this is a search of a handful of places two levels deep, not of the disk. It
 * finds the install on the desktop and the one in a projects folder, and it does not find
 * the one on a second drive under three directories nobody would guess — that install has
 * the `path` setting, which exists because this list cannot be complete and pretending
 * otherwise would mean walking somebody's whole filesystem to make a picture.
 */
const roots = () => {
  const home = homedir()
  // The drive is asked for rather than written down — invariant 7, and it is right: a drive
  // letter typed into this file is a guess about somebody else's machine, and it is wrong on
  // the first laptop that keeps its user profile anywhere else.
  return [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'), home, parse(home).root]
}

/** Folders never worth descending: enormous, or somewhere ComfyUI's own files live. */
const SKIP = new Set([
  'node_modules',
  'venv',
  '.venv',
  'models',
  'custom_nodes',
  'AppData',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'System Volume Information',
])

/**
 * One folder, then its children.
 *
 * Anything with *comfy* in the name is checked before anything else, so the ordinary case
 * costs one `readdir` and two `stat`s rather than the whole budget. The budget is the real
 * protection: a walk of somebody's home directory that is allowed to run forever is a
 * plugin that hangs on the machine with the most files, which is nobody's idea of a search.
 */
async function walk(at, depth, budget) {
  if (budget.left-- <= 0) return undefined
  let entries
  try {
    entries = await readdir(at, { withFileTypes: true })
  } catch {
    return undefined
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$') && !SKIP.has(entry.name))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().includes('comfy')) - Number(a.name.toLowerCase().includes('comfy')),
    )
  for (const entry of dirs) {
    const path = join(at, entry.name)
    if (await isInstall(path)) return path
  }
  if (depth <= 0) return undefined
  for (const entry of dirs) {
    const found = await walk(join(at, entry.name), depth - 1, budget)
    if (found) return found
  }
  return undefined
}

/** One folder searched, on its own, so the walk is a thing a test can hold. */
export const search = (at, depth = 2, budget = 400) => walk(at, depth, { left: budget })

/**
 * Where ComfyUI is, or nothing.
 *
 * A `hint` is the user's setting and it wins outright — including when they point at the
 * folder *above* the install, which is what the portable build looks like from the outside
 * and is the mistake anybody would make once.
 */
export async function install(hint, budget = 400) {
  const said = String(hint ?? '').trim()
  if (said) {
    for (const at of [said, join(said, 'ComfyUI')]) if (await isInstall(at)) return at
    return undefined
  }
  for (const root of roots()) {
    const found = await search(root, 2, budget)
    if (found) return found
  }
  return undefined
}

/**
 * The Pythons an install might have been set up with, in the order to try them.
 *
 * **Which one is not a detail.** ComfyUI needs PyTorch, and PyTorch is in exactly one of
 * these — running `main.py` with whatever Python is on `PATH` gets *no module named torch*
 * on a machine where ComfyUI works perfectly, which is the most confusing failure available
 * here. The venv beside the install is the ordinary case; `python_embeded` a level up is the
 * portable build's, and it is spelled that way in the release, missing letter and all.
 */
export const interpreters = (dir) =>
  process.platform === 'win32' ?
    [
      join(dir, 'venv', 'Scripts', 'python.exe'),
      join(dir, '.venv', 'Scripts', 'python.exe'),
      join(dirname(dir), 'python_embeded', 'python.exe'),
      join(dirname(dir), 'python_embedded', 'python.exe'),
    ]
  : [
      join(dir, 'venv', 'bin', 'python'),
      join(dir, '.venv', 'bin', 'python'),
      join(dirname(dir), 'python_embeded', 'bin', 'python'),
    ]

/** The first of those that is there, or the one on `PATH` and a hope. */
export async function python(dir) {
  for (const candidate of interpreters(dir)) if (await file(candidate)) return candidate
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Is this address something on this machine, and so something there would be a point starting? */
export function loopback(server) {
  try {
    const { hostname } = new URL(server)
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0', ''].includes(hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return false
  }
}

/** Which port to start it on: the one the rest of the plugin is going to talk to. */
export function port(server) {
  try {
    const found = Number(new URL(server).port)
    return Number.isInteger(found) && found > 0 ? found : 8188
  } catch {
    return 8188
  }
}

/**
 * Spawn it, and let go of it.
 *
 * `detached`, deliberately, and it is the decision here most worth arguing with. This plugin
 * is lazily spawned — five minutes without a call and core stops it — while ComfyUI takes
 * the better part of a minute to import PyTorch and load a checkpoint. Tying one to the
 * other means paying that minute again after every pause, so ComfyUI outlives the plugin
 * that started it, its pid is written down, and stopping it is a tool somebody can call.
 * **Alexia never kills a ComfyUI it did not start** — that one belongs to whoever did.
 *
 * Output goes to a log file rather than a pipe for the same reason: a detached process whose
 * parent has exited has nowhere to write, and when a start fails the last line of that file
 * is the whole of the explanation.
 */
/**
 * Tell ComfyUI to also look in Alexia's own folder for models.
 *
 * **This is what makes a clean uninstall possible without hiding the model.** A model downloaded
 * into somebody's ComfyUI folder is a six-gigabyte file Alexia cannot honestly remove when the
 * plugin is deleted — invariant 3 says a plugin leaves no residue. Kept in the plugin's own
 * folder it purges with everything else, but ComfyUI's editor would never see it, so a workflow
 * opened by hand could not select it.
 *
 * `--extra-model-paths-config` settles both. ComfyUI reads the folder as if it were its own, and
 * **nothing is written into the person's install** — the file lives on Alexia's side and is
 * passed on the command line, so an uninstall takes the configuration with the models.
 *
 * `is_default` is deliberately absent: these paths are searched, not preferred, so ComfyUI's own
 * downloads keep going where that person expects them.
 */
export function paths(own) {
  const base = own.split(sep).join('/')
  for (const one of ['checkpoints', 'loras', 'vae']) mkdirSync(join(own, 'models', one), { recursive: true })
  const file = join(own, 'extra_model_paths.yaml')
  writeFileSync(
    file,
    // Hand-written rather than a YAML dependency: it is four lines of key and value, and
    // forward slashes because a backslash in a YAML scalar is a question nobody needs to ask.
    ['alexia:', `    base_path: ${base}`, '    checkpoints: models/checkpoints/', '    loras: models/loras/', '    vae: models/vae/', ''].join(
      '\n',
    ),
    'utf8',
  )
  return file
}

export async function start(dir, { at, log, own, env = {} } = {}) {
  const exe = await python(dir)
  const out = openSync(log, 'w')
  // Alexia's own models folder, offered to ComfyUI without writing anything into its install.
  const extra = own ? ['--extra-model-paths-config', paths(own)] : []
  // **Previews are off unless asked for** — `--preview-method` defaults to `none`, which is why
  // watching a render produced a bar and no picture. `latent2rgb` rather than `auto`: `auto`
  // prefers TAESD, which is a model that has to be downloaded and a decode per preview on the
  // card already busy generating, while `latent2rgb` is a matrix multiply on the latent that is
  // already in memory. It is a rougher picture and it costs almost nothing, which is the right
  // trade for something somebody glances at while waiting.
  const previews = ['--preview-method', 'latent2rgb']
  // `--disable-auto-launch` because a browser window opening by itself is the desktop
  // equivalent of shouting: somebody asked for a picture, not for ComfyUI's editor.
  const child = spawn(exe, ['main.py', '--port', String(at), '--disable-auto-launch', ...previews, ...extra], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', out, out],
    // What the install's own launcher sets. Without it, ComfyUI's first non-ASCII log line
    // ends the process on a Windows console codepage, which reads as a crash on startup.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env },
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid, exe }
}

/** Answering? One request, and no opinion about what it says. */
export async function awake(server, signal) {
  try {
    return (await fetch(`${server}/system_stats`, { signal })).ok
  } catch {
    return false
  }
}

/**
 * Wait for it to come up, saying how long it has been.
 *
 * Bounded well under core's own two-minute ceiling on a tool call, because the useful thing
 * to say when the bound is hit is not *it never started* — it usually did — but *it is still
 * loading, ask again in a moment*, and that sentence has to reach the model while the call
 * is still alive to carry it.
 */
export async function ready(server, { signal, onProgress, timeoutMs = 90_000 } = {}) {
  const until = Date.now() + timeoutMs
  for (let tick = 0; Date.now() < until; tick++) {
    if (signal?.aborted) throw new Error('Stopped.')
    if (await awake(server, signal)) return true
    onProgress?.(tick)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/** What the log ended on, which is what went wrong when something did. */
export async function tail(log, lines = 2) {
  try {
    return (await readFile(log, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-lines)
      .join(' — ')
  } catch {
    return ''
  }
}

/** Is that pid still a process? It says nothing about *which* — see `stop`. */
export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * End the one we started.
 *
 * ponytail: a pid, not a job object — so a machine that has been up for weeks could in
 * principle hand this number to something else. What stands between that and killing a
 * stranger is that the pid is only ever used together with *and ComfyUI is answering on the
 * port we started it on*. `/t` because ComfyUI spawns workers of its own, and orphaning
 * those leaves the VRAM allocated with nothing left to free it.
 */
export function stop(pid) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const kill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      kill.on('error', () => resolve(false))
      kill.on('close', (code) => resolve(code === 0))
    })
  }
  try {
    // The negative pid is the process group `detached` gave it, and the workers are in it.
    process.kill(-pid, 'SIGTERM')
    return Promise.resolve(true)
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
      return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
  }
}
