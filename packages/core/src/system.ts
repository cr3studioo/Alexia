// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

/**
 * The machine itself, for the Local stats page: how busy the processor and the graphics chip
 * are, how much memory is in use and how hard the system is squeezing it, and how hot it is
 * running — the things somebody running a model on their own laptop wants to know before they
 * blame the model.
 *
 * **Everything here is a best effort, and a number that cannot be read is absent rather than
 * guessed.** A temperature of 0 °C or a memory bar stuck at 99 % is worse than no row, because
 * nobody can tell it is wrong. Nothing here throws.
 *
 * **No dependency.** CPU and memory come from `node:os`. Two platform facts make that less
 * simple than it sounds:
 *
 * - **macOS counts the file cache as used memory** in `os.freemem()`, so a Mac that is fine
 *   reads as full. There, memory in use is what Activity Monitor calls it — app memory, wired
 *   and compressed — read from `vm_stat`, which ships with every Mac and needs no rights.
 * - **Temperature has no portable source.** Linux publishes it as plain files under
 *   `/sys/class/thermal`, and that is read. macOS keeps its sensors behind private interfaces or
 *   `sudo powermetrics`, and Windows behind WMI classes that usually need an administrator —
 *   neither is something a daemon should ask for to draw one number. On those two the reading
 *   is `null` here, and the desktop app's shell answers instead (`system_temps`, the `sysinfo`
 *   crate): the page asks the shell first and falls back to this. In a browser on a Mac there
 *   is no temperature at all, and the page leaves the tiles out.
 * - **The graphics chip has no portable source either.** A Mac publishes its GPU's busy share
 *   in the IORegistry, where `ioreg` — also on every Mac, also needing no rights — prints it as
 *   `"Device Utilization %"`. An NVIDIA card anywhere says it through `nvidia-smi` when the
 *   driver put that on the PATH. Anything else is `null`.
 * - **Memory pressure is the Mac's own verdict**, not a threshold of ours: the kernel's
 *   `kern.memorystatus_vm_pressure_level` is the same Normal / Warning / Critical that Activity
 *   Monitor colours its graph by. Linux has no such verdict, so there it is the share of memory
 *   still available against two lines drawn here ({@link linuxPressure}). Windows is `null`.
 *
 * **Only when asked.** Nothing here runs on a timer: the page polls while it is on screen, and
 * each poll is one reading. The history is those readings kept, not a sampler of its own — a
 * machine nobody is looking at is not being measured.
 */

/** How hard the system is working to find memory, in the words Activity Monitor uses. */
export type Pressure = 'normal' | 'warning' | 'critical'

/** The last readings, oldest first, one per request — what the page draws its sparklines from. */
export interface History {
  cpu: (number | null)[]
  gpu: (number | null)[]
  memory: (number | null)[]
}

export interface SystemStats {
  cpu: {
    /** Busy share of all cores since the previous reading, 0–100. Null on the very first one. */
    percent: number | null
    cores: number
    model: string
  }
  /** The graphics chip's busy share, 0–100 — the busiest one, where there are two. */
  gpu: { percent: number | null }
  memory: { used: number; total: number; pressure: Pressure | null }
  /** One, five and fifteen minute load averages. Null on Windows, which has no such thing. */
  load: [number, number, number] | null
  /** The hottest CPU sensor, in °C. Null wherever it cannot be read without asking for rights. */
  temperature: number | null
  /** Seconds since the machine started — the machine, not Alexia. */
  uptime: number
  history: History
}

interface Ticks {
  idle: number
  total: number
}

const ticks = (): Ticks => {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * The previous reading, kept between calls: CPU use is a difference between two moments, and
 * the page asks every few seconds, so the last request's reading is the first moment of this
 * one. A reading older than {@link STALE} is too far back to mean "now" and is taken afresh.
 */
let previous: { at: number; ticks: Ticks } | undefined
const STALE = 30_000
/** How long to watch when there is no recent reading to compare against. */
const SAMPLE = 250

async function cpuPercent(now: () => number): Promise<number | null> {
  if (!previous || now() - previous.at > STALE) {
    previous = { at: now(), ticks: ticks() }
    await new Promise((resolve) => setTimeout(resolve, SAMPLE))
  }
  const current = ticks()
  const total = current.total - previous.ticks.total
  const idle = current.idle - previous.ticks.idle
  previous = { at: now(), ticks: current }
  if (total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 1000) / 10))
}

const run = (file: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 2000 }, (error, stdout) => resolve(error ? undefined : stdout))
  })

/** Activity Monitor's "memory used" from `vm_stat`: app memory, wired and compressed pages. */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text)?.[1]
  if (!size) return undefined
  const pages = (name: string): number => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? NaN)
  const app = pages('Anonymous pages') - pages('Pages purgeable')
  const used = app + pages('Pages wired down') + pages('Pages occupied by compressor')
  return Number.isFinite(used) && used > 0 ? used * Number(size) : undefined
}

/**
 * The busiest graphics chip's `"Device Utilization %"`, from `ioreg -r -d 1 -c IOAccelerator`.
 *
 * The figure sits inside each accelerator's `PerformanceStatistics` dictionary, which `ioreg`
 * prints on one line. A Mac with two GPUs prints two, and the busier one is the one that
 * answers *is the GPU the bottleneck?*
 */
export function parseIoregGpu(text: string): number | null {
  let busiest: number | null = null
  for (const [, n] of text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)) {
    const percent = Number(n)
    if (percent <= 100) busiest = Math.max(busiest ?? percent, percent)
  }
  return busiest
}

/** `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`: one number a card. */
export function parseNvidiaSmi(text: string): number | null {
  const all = text
    .split('\n')
    .map((line) => Number.parseFloat(line.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
  return all.length === 0 ? null : Math.max(...all)
}

/**
 * Whether `nvidia-smi` was missing last time. A machine without an NVIDIA driver is not going
 * to grow one between two polls, and a spawn every three seconds to find that out again is the
 * kind of cost a stats page must not have.
 */
let noNvidia = false

async function gpuPercent(): Promise<number | null> {
  if (process.platform === 'darwin') {
    const text = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'])
    return text ? parseIoregGpu(text) : null
  }
  if (noNvidia) return null
  const text = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])
  if (text === undefined) noNvidia = true
  return text ? parseNvidiaSmi(text) : null
}

/**
 * `kern.memorystatus_vm_pressure_level` in words: 1 is normal, 2 warning, 4 critical — the
 * kernel's own levels, which skip 3. Anything else is a value this was not written for, and is
 * no answer rather than a guess.
 */
export function pressureOf(level: string): Pressure | null {
  switch (level.trim()) {
    case '1':
      return 'normal'
    case '2':
      return 'warning'
    case '4':
      return 'critical'
    default:
      return null
  }
}

/**
 * Linux's nearest thing to a verdict: the share of memory still available (`MemAvailable`,
 * which counts the cache the kernel would give back) against `MemTotal`. Below 15 % the
 * system is reclaiming hard and swapping is near, which is *warning*; below 5 % the OOM killer
 * is close, which is *critical*. Lines of ours, drawn where a person would want telling.
 */
export function linuxPressure(meminfo: string): Pressure | null {
  const kb = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? NaN)
  const share = kb('MemAvailable') / kb('MemTotal')
  if (!Number.isFinite(share)) return null
  return share < 0.05 ? 'critical' : share < 0.15 ? 'warning' : 'normal'
}

async function memoryPressure(): Promise<Pressure | null> {
  if (process.platform === 'darwin') {
    const level = await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
    return level ? pressureOf(level) : null
  }
  if (process.platform === 'linux') {
    try {
      return linuxPressure(await readFile('/proc/meminfo', 'utf8'))
    } catch {
      return null
    }
  }
  return null
}

async function memoryUsed(): Promise<number> {
  const total = os.totalmem()
  if (process.platform === 'darwin') {
    const text = await run('vm_stat', [])
    const used = text ? parseVmStat(text) : undefined
    if (used !== undefined && used <= total) return used
  }
  return total - os.freemem()
}

/**
 * The hottest of the thermal zones Linux publishes, in °C. Zones are millidegrees in a file
 * each; a zone that reads nothing sensible (some report 0, or a sentinel far above boiling) is
 * skipped rather than trusted.
 */
export async function linuxTemperature(root = '/sys/class/thermal'): Promise<number | null> {
  let zones: string[]
  try {
    zones = (await readdir(root)).filter((name) => name.startsWith('thermal_zone'))
  } catch {
    return null
  }
  let hottest: number | null = null
  for (const zone of zones) {
    try {
      const celsius = Number((await readFile(join(root, zone, 'temp'), 'utf8')).trim()) / 1000
      if (Number.isFinite(celsius) && celsius > 1 && celsius < 150) hottest = Math.max(hottest ?? celsius, celsius)
    } catch {
      /* A zone that cannot be read is a zone without a number. */
    }
  }
  return hottest === null ? null : Math.round(hottest * 10) / 10
}

/** How many readings the history keeps: three minutes at the page's three seconds. */
export const KEPT = 60

/**
 * The readings so far, kept between calls in this process, and when the last one was taken.
 *
 * A history with a hole in it would draw as a line straight across the hole — ten quiet
 * minutes while the window was hidden, joined up as if they had been measured. So a reading
 * that comes more than {@link STALE} after the last one starts the history again.
 */
const kept: History = { cpu: [], gpu: [], memory: [] }
let keptAt = -Infinity

export function remember(sample: { cpu: number | null; gpu: number | null; memory: number | null }, at: number): History {
  if (at - keptAt > STALE) for (const series of Object.values(kept)) series.length = 0
  keptAt = at
  const push = (series: (number | null)[], value: number | null): void => {
    series.push(value)
    if (series.length > KEPT) series.shift()
  }
  push(kept.cpu, sample.cpu)
  push(kept.gpu, sample.gpu)
  push(kept.memory, sample.memory)
  return { cpu: [...kept.cpu], gpu: [...kept.gpu], memory: [...kept.memory] }
}

export async function systemStats(now: () => number = Date.now): Promise<SystemStats> {
  const cpus = os.cpus()
  const total = os.totalmem()
  const [percent, gpu, used, pressure, temperature] = await Promise.all([
    cpuPercent(now),
    gpuPercent().catch(() => null),
    memoryUsed(),
    memoryPressure().catch(() => null),
    process.platform === 'linux' ? linuxTemperature() : Promise.resolve(null),
  ])
  const [one, five, fifteen] = os.loadavg()
  const memory = total > 0 ? Math.round((used / total) * 1000) / 10 : null
  return {
    cpu: { percent, cores: cpus.length, model: cpus[0]?.model.trim() ?? '' },
    gpu: { percent: gpu },
    memory: { used, total, pressure },
    load: process.platform === 'win32' ? null : [one ?? 0, five ?? 0, fifteen ?? 0],
    temperature,
    uptime: Math.round(os.uptime()),
    history: remember({ cpu: percent, gpu, memory }, now()),
  }
}
