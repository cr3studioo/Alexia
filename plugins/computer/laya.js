// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, sep } from 'node:path'

/**
 * Laya, looked after by this plugin (computer use v2).
 *
 * Laya is Convai's open decision model (Apache-2.0), served by its own `laya-serve` over the
 * same wire as TypeSafe's Jev. This file installs it into the plugin's own folder, starts it,
 * checks it is answering, and stops it — the same bargain `plugins/media/launch.js` made with
 * ComfyUI:
 *
 * - **Detached, and written down.** The plugin is stopped after five idle minutes while Laya
 *   takes the better part of a minute to load, so Laya outlives the plugin that started it and
 *   its pid goes in a file. **A Laya this plugin did not start is never stopped by it.**
 * - **Only on this computer.** It is bound to 127.0.0.1, never the `0.0.0.0` it defaults to.
 * - **In the plugin's own folder**, so deleting the plugin takes Laya and its models with it.
 *   A Laya installed by hand in a `.laya` folder in the home directory is used rather than
 *   installed twice, and left alone.
 */

/** Where Laya lives when this plugin installed it. */
export const home = (own) => join(own, 'laya')

/**
 * Where a Python to build Laya's environment from may be: `PATH`, Homebrew's own folder (an app
 * started from the Dock is not given the shell's `PATH`), and the per-user folder `pip` and `uv`
 * install into. Newest first; Laya needs 3.10 or newer.
 */
function pythons() {
  const dirs = [
    ...String(process.env.PATH ?? '').split(delimiter),
    ...(process.env.HOMEBREW_PREFIX ? [join(process.env.HOMEBREW_PREFIX, 'bin')] : []),
    join(sep, 'opt', 'homebrew', 'bin'),
    join(sep, 'usr', 'local', 'bin'),
    join(homedir(), '.local', 'bin'),
  ].filter(Boolean)
  const names = ['python3.12', 'python3.11', 'python3.13', 'python3.10', 'python3']
  return [...new Set(names.flatMap((name) => dirs.map((dir) => join(dir, name))))]
}

/** The `laya-serve` to run: this plugin's own, else one installed by hand, else none. */
export function server(own) {
  const bin = process.platform === 'win32' ? ['Scripts', 'laya-serve.exe'] : ['bin', 'laya-serve']
  for (const venv of [join(home(own), 'venv'), join(homedir(), '.laya', 'venv')]) {
    const exe = join(venv, ...bin)
    if (existsSync(exe)) return exe
  }
  return undefined
}

/** The first Python here that is 3.10 or newer, and not the 3.14 PyTorch has no wheels for yet. */
export async function python() {
  for (const exe of process.platform === 'win32' ? ['py', 'python'] : pythons()) {
    if (process.platform !== 'win32' && !existsSync(exe)) continue
    const said = await output(exe, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).catch(() => '')
    const [major, minor] = said.split('.').map(Number)
    if (major === 3 && minor >= 10 && minor <= 13) return exe
  }
  return undefined
}

function output(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${String(code)}`))))
  })
}

/**
 * Install it: a virtual environment in the plugin's folder, then `pip install "laya[serve]"`.
 *
 * Several minutes and about two gigabytes (PyTorch, then the model on first start), which is
 * longer than a tool call may take — so it runs detached into a log, and {@link state} reads the
 * log to say how far it got. A second call while one is running is told so rather than started.
 */
export async function install(own) {
  const dir = home(own)
  mkdirSync(dir, { recursive: true })
  const exe = await python()
  if (!exe) throw new Error('Laya needs Python 3.10 to 3.13, and none was found. Install one (brew install python@3.12), then try again.')
  const venv = join(dir, 'venv')
  const pip = process.platform === 'win32' ? join(venv, 'Scripts', 'pip.exe') : join(venv, 'bin', 'pip')
  const log = join(dir, 'install.log')
  const script =
    process.platform === 'win32' ?
      `& '${exe}' -m venv '${venv}'; & '${pip}' install -U pip; & '${pip}' install -U "laya[serve]"; 'LAYA-INSTALLED'`
    : `"${exe}" -m venv "${venv}" && "${pip}" install -q -U pip && "${pip}" install -q -U "laya[serve]" && echo LAYA-INSTALLED`
  const out = openSync(log, 'w')
  const child =
    process.platform === 'win32' ?
      spawn('powershell.exe', ['-NoProfile', '-Command', script], { detached: true, stdio: ['ignore', out, out], windowsHide: true })
    : spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  writeFileSync(join(dir, 'install.pid'), String(child.pid))
  return { log }
}

/** Is an install still running? */
const installing = (own) => alive(pidIn(join(home(own), 'install.pid')))

const pidIn = (file) => {
  try {
    return Number(readFileSync(file, 'utf8').trim()) || undefined
  } catch {
    return undefined
  }
}

const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Host and port from an address, only when it is this computer — nothing else is ours to start. */
export function local(address) {
  try {
    const url = new URL(address)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    return { host: '127.0.0.1', port: Number(url.port) || 8000 }
  } catch {
    return undefined
  }
}

/**
 * Start it on this computer, detached, and write its pid down.
 *
 * `LAYA_PRELOAD` loads the checkpoints now rather than on the first question, which is the
 * difference between a first step of forty milliseconds and one of forty seconds. The Apple GPU
 * (`mps`) on a Mac with Apple silicon; elsewhere Laya chooses.
 */
export function start(own, address, model = 'typed-decisions') {
  const exe = server(own)
  if (!exe) throw new Error('Laya is not installed yet. Set it up first.')
  const at = local(address)
  if (!at) throw new Error(`Laya can only be started on this computer, and ${String(address)} is somewhere else.`)
  const dir = home(own)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'serve.log')
  const out = openSync(log, 'w')
  const models = [...new Set([model === 'auto' ? 'english' : model, 'multilingual'])].join(',')
  const child = spawn(exe, [], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      LAYA_HOST: at.host,
      LAYA_PORT: String(at.port),
      LAYA_PRELOAD: '1',
      LAYA_MODELS: models,
      LAYA_LOG_LEVEL: 'warning',
      ...(process.platform === 'darwin' && process.arch === 'arm64' && { LAYA_DEVICE: 'mps' }),
    },
  })
  child.unref()
  writeFileSync(join(dir, 'serve.pid'), String(child.pid))
  return { pid: child.pid, log }
}

/** Stop the Laya this plugin started. One started any other way is not this plugin's to stop. */
export function stop(own) {
  const file = join(home(own), 'serve.pid')
  const pid = pidIn(file)
  rmSync(file, { force: true })
  if (!alive(pid)) return false
  process.kill(pid, 'SIGTERM')
  return true
}

/** Answering, and how fast. `undefined` when it is not. */
export async function health(address, signal) {
  const base = String(address).replace(/\/+$/, '')
  const at = performance.now()
  try {
    const response = await fetch(`${base}/health`, { signal: signal ?? AbortSignal.timeout(1500) })
    if (!response.ok) return undefined
    const said = await response.json().catch(() => ({}))
    return { ms: Math.round(performance.now() - at), ...said }
  } catch {
    return undefined
  }
}

/** Wait for it to answer, up to a bound well under a tool call's two minutes. */
export async function ready(address, { signal, timeoutMs = 90_000 } = {}) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (signal?.aborted) return false
    if (await health(address)) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/** The last line of a log, which is what went wrong when something did. */
async function last(file) {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
  } catch {
    return ''
  }
}

/**
 * Where Laya is, in one of five words, and a sentence for a person.
 *
 * `ready` · `starting` · `stopped` (installed, not running) · `installing` · `missing`
 */
export async function state(own, address) {
  const up = await health(address)
  if (up) return { state: 'ready', said: `Laya is ready (${String(up.ms)} ms).`, ms: up.ms }
  if (installing(own)) return { state: 'installing', said: `Laya is being installed. ${await last(join(home(own), 'install.log'))}`.trim() }
  if (!server(own)) {
    const log = await last(join(home(own), 'install.log'))
    return { state: 'missing', said: log && !log.includes('LAYA-INSTALLED') ? `Laya is not installed; the last attempt ended: ${log}` : 'Laya is not installed.' }
  }
  if (alive(pidIn(join(home(own), 'serve.pid')))) return { state: 'starting', said: 'Laya is starting — loading its model.' }
  return { state: 'stopped', said: 'Laya is installed but not running.' }
}
