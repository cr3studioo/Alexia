// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import * as launcher from './launch.js'
import { fetchModel } from './models.js'
import { TIERS, tier } from './tier.js'

/**
 * This plugin as a compute worker: a ComfyUI of Alexia's own, for the jobs another computer sends.
 *
 * **A person's ComfyUI is theirs, and a paired computer is the place that matters most.** On
 * the machine somebody is sitting at, using the ComfyUI they already have open is a kindness —
 * one model in memory rather than two. On a machine they paired to do the heavy work it is the
 * opposite: jobs arrive from elsewhere at any hour, and queueing them into a program the
 * person may be in the middle of using means their own render waits behind a stranger's, gets
 * interrupted when a job is cancelled, and is stopped when the host goes idle.
 *
 * So the worker never talks to that one at all. It starts **a second ComfyUI from the same
 * install**, on a port of its own, writes down the pid, and that process is the only one it
 * ever queues to, cancels on, or stops. Nothing is written into the install either: the port,
 * the models folder and the output folder are all given on the command line and live in this
 * plugin's own directory, so removing the plugin takes every trace of the worker with it.
 */

/** The capability the worker answers. One place, so the manifest and the code cannot drift. */
export const RENDER = 'image.render'

/** Where ComfyUI listens when a person starts it themselves. Never taken, never spoken to. */
export const USUAL_PORT = 8188

/** Where the worker's own ComfyUI starts looking for a port. The first free one from here is used. */
export const WORKER_PORT = 8288

/** The storage key holding the one record that makes a ComfyUI Alexia's to stop. */
export const RECORD = 'worker'

/** Long enough for an install carrying thirty node packs, which was measured at six minutes. */
const START_MS = 10 * 60_000

/** How long a release waits for a worker that is still loading before leaving it for the next one. */
const SETTLE_MS = 10_000

const address = (port) => `http://127.0.0.1:${port}`

/**
 * The worker's ComfyUI: started on demand, found again after this plugin was stopped, and
 * stopped when the host lets go.
 *
 * Everything it touches is handed in, which is what lets a test hold it: `storage` is this
 * plugin's own key-value store, `dir` finds the install, `avoid` names the ports that belong
 * to somebody else, and `launch` is `launch.js`.
 */
export function dedicated({ storage, own, dir, avoid = async () => [], log = () => {}, launch = launcher }) {
  /** One start at a time. Two jobs arriving together must not become two ComfyUIs. */
  let booting

  const record = async () => {
    const said = await storage.get(RECORD).catch(() => undefined)
    return Number.isInteger(said?.pid) && Number.isInteger(said?.port) ? said : undefined
  }

  /** The worker's own folder inside the plugin's: what it renders, and its scratch space. */
  const folder = (name) => join(own(), 'worker', name)

  /**
   * A port that is nobody's.
   *
   * The usual port and the one in this plugin's settings are skipped **even when they are
   * free** — a person who starts their ComfyUI a minute from now expects it to come up where
   * it always does, and finding Alexia already sitting there is the worker getting in the way
   * of the program it promised to leave alone.
   */
  const port = async () => {
    const theirs = new Set([USUAL_PORT, ...(await avoid())])
    for (let at = WORKER_PORT; at < WORKER_PORT + 64; at++) {
      if (!theirs.has(at) && (await launch.vacant(at))) return at
    }
    throw new Error('There is no free port on this computer to start ComfyUI on.')
  }

  /** The worker's ComfyUI if it is up — its address — and nothing if it is not. */
  async function running(signal) {
    const mine = await record()
    if (!mine) return undefined
    if (!launch.alive(mine.pid)) {
      await storage.remove(RECORD).catch(() => {})
      return undefined
    }
    return (await launch.awake(address(mine.port), signal)) ? { server: address(mine.port), pid: mine.pid } : undefined
  }

  /**
   * Start it if it is not there, and wait until it answers.
   *
   * A worker still loading from a moment ago is waited for rather than joined by a second —
   * the pid on record is alive, so the wait simply carries on. Unlike a person's own picture,
   * nothing here has to fit inside one tool call: core gives a job as long as it needs, so the
   * wait is as long as a heavy install takes rather than the ninety seconds `launch.ready`
   * allows by default.
   */
  async function ensure({ signal, onProgress, timeoutMs = START_MS } = {}) {
    const up = await running(signal)
    if (up) return up
    booting ??= (async () => {
      let mine = await record()
      if (!mine) {
        const from = await dir()
        if (!from) throw new Error(ABSENT)
        const at = await port()
        const output = folder('output')
        const temp = folder('temp')
        await mkdir(output, { recursive: true })
        await mkdir(temp, { recursive: true })
        const fresh = await launch.start(from, {
          at,
          log: join(own(), 'comfyui-worker.log'),
          own: own(),
          // What it makes stays in Alexia's folder, so nothing a remote job rendered turns up
          // among the person's own pictures.
          args: ['--output-directory', output, '--temp-directory', temp],
        })
        mine = { pid: fresh.pid, port: at, dir: from, at: Date.now() }
        // Written down before the wait, so a plugin stopped mid-start still knows what it left
        // running. This record is the whole of what makes a ComfyUI Alexia's to stop.
        await storage.set(RECORD, mine).catch(() => {})
        log(`started the worker's ComfyUI (pid ${mine.pid}) from ${from} on port ${at}`)
      }
      const server = address(mine.port)
      if (!(await launch.ready(server, { signal, onProgress, timeoutMs }))) {
        const said =
          launch.alive(mine.pid) ?
            'ComfyUI is still starting on this computer. Ask again in a minute.'
          : `ComfyUI stopped while starting: ${(await launch.tail(join(own(), 'comfyui-worker.log'))) || 'nothing in its log to say why.'}`
        throw new Error(said)
      }
      return { server, pid: mine.pid }
    })().finally(() => {
      booting = undefined
    })
    return booting
  }

  /**
   * Stop the worker's ComfyUI, which is what gives the graphics card back.
   *
   * **Two conditions, as everywhere else this plugin stops something**: the pid on record is
   * alive, and ComfyUI answers on the port that record names. A pid alone could have been
   * handed to another program since; an answering server alone could be anybody's. A ComfyUI
   * with no record is never stopped, whichever port it is on — that is the person's.
   */
  async function release() {
    const mine = await record()
    if (!mine) return false
    if (!launch.alive(mine.pid)) {
      await storage.remove(RECORD).catch(() => {})
      return false
    }
    // Still loading is the one state where it is ours and not yet answering. It is given a
    // moment, and otherwise left on record so the next release finds it.
    if (!(await launch.ready(address(mine.port), { timeoutMs: SETTLE_MS }).catch(() => false))) return false
    if (!(await launch.stop(mine.pid))) return false
    await storage.remove(RECORD).catch(() => {})
    log('the worker’s ComfyUI was stopped, and its model memory with it')
    return true
  }

  /**
   * Remove one rendered file from the worker's own output folder, once its bytes are safe.
   *
   * ComfyUI has no call that deletes an output, and a worker that kept every picture it ever
   * rendered for somebody else would be a disk filling up on a machine nobody is looking at.
   * Only ever inside the worker's folder: a name that resolves outside it is left alone.
   */
  async function tidy({ filename, subfolder = '', type = 'output' } = {}) {
    if (type !== 'output' && type !== 'temp') return
    const root = resolve(folder(type))
    const path = resolve(root, String(subfolder), String(filename))
    if (!path.startsWith(root + sep)) return
    await rm(path, { force: true }).catch(() => {})
  }

  return { ensure, running, release, tidy }
}

/** The file types ComfyUI loads as a checkpoint. */
const CHECKPOINT = /\.(safetensors|ckpt|sft)$/i

/**
 * The checkpoints in these folders, read off the disk.
 *
 * **ComfyUI is the authority and this is what is asked when it is not running** — the setup
 * list is drawn before anything has been started, and starting a program to draw a list would
 * be the list deciding something. A model kept somewhere only ComfyUI's own configuration
 * knows about is missed here, which errs towards offering a download nobody needs to take.
 */
export async function onDisk(folders) {
  const found = []
  for (const at of folders.filter(Boolean)) {
    const entries = await readdir(join(at, 'models', 'checkpoints'), { withFileTypes: true, recursive: true }).catch(() => [])
    for (const entry of entries) if (entry.isFile() && CHECKPOINT.test(entry.name)) found.push(entry.name)
  }
  return found
}

const ABSENT = 'ComfyUI could not be found on this computer.'

/** What a person is told to do when there is no ComfyUI. Alexia does not install it for them. */
export const INSTALL_COMFYUI =
  'Install ComfyUI from comfy.org — its own installer handles the graphics-card half, which is the ' +
  'part that goes wrong. Alexia finds it afterwards in the usual places; if it is installed somewhere ' +
  'unusual, put the folder in this plugin’s settings.'

const requirementOf = (rung) => `model:${rung.file}`

/** The model a requirement id names, or nothing — an id this plugin never offered. */
export const rungOf = (requirementId) => TIERS.find((rung) => requirementOf(rung) === requirementId)

/**
 * What is missing before a picture can be rendered on this computer, with its size.
 *
 * Two things only, and in the order somebody has to deal with them: the program, which Alexia
 * will not install and says how to; then one model, which it will, and whose size is on the
 * list before anything is pressed. `card` is ComfyUI's own reading when it is running,
 * `null` when it looked and found none, and absent when nobody has asked yet.
 */
export function requirements({ dir, installed = [], card } = {}) {
  if (!dir) {
    return [
      {
        id: 'comfyui',
        kind: 'runtime',
        title: 'ComfyUI',
        detail: 'The program that makes the pictures. Alexia runs a copy of its own and leaves one you have open alone.',
        action: 'instructions',
        instructions: INSTALL_COMFYUI,
        blocks: [RENDER],
      },
    ]
  }
  if (installed.length > 0) return []
  // The card decides the rung where it has been read. Before that it is SDXL, which is what
  // `tier.js` calls the default; and with no card at all it is the smallest, because a larger
  // model on a processor alone is a picture nobody waits for.
  const rung = card ? tier(card.total) : card === null ? TIERS[0] : TIERS.find((one) => one.name === 'mid')
  return [
    {
      id: requirementOf(rung),
      kind: 'model',
      title: `${rung.label} image model`,
      detail: `Licensed ${rung.licence}. Kept in this plugin’s own folder, so removing the plugin removes it.`,
      bytes: rung.bytes,
      action: 'install',
      blocks: [RENDER],
    },
  ]
}

/**
 * Install one requirement — which here means downloading one model, and nothing else.
 *
 * Called only from the `install` hook, which core calls only after a person pressed the
 * button beside that requirement. Nothing else in the worker reaches this: starting ComfyUI,
 * listing what is missing and rendering a picture all run without a byte being fetched.
 */
export async function fetchRequirement(requirementId, { own, signal, onProgress, fetch = fetchModel } = {}) {
  const rung = rungOf(requirementId)
  if (!rung) {
    throw new Error(requirementId === 'comfyui' ? INSTALL_COMFYUI : 'There is nothing here to install by that name.')
  }
  if (!own) throw new Error('Alexia has not given this plugin a folder to work in.')
  const folder = join(own, 'models', 'checkpoints')
  await mkdir(folder, { recursive: true })
  return fetch(rung.url, join(folder, rung.file), { expect: rung.bytes, signal, onProgress })
}
