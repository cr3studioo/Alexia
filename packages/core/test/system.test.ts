// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  KEPT,
  linuxPressure,
  linuxTemperature,
  parseIoregGpu,
  parseNvidiaSmi,
  parseVmStat,
  pressureOf,
  remember,
  systemStats,
} from '../src/system.js'

/**
 * The Local stats page's machine readings. Every source here is a command's text or a file,
 * so every parser is tested on text as the platform prints it — the one thing a test on this
 * laptop cannot do is be every other laptop.
 */

// Trimmed from a real `ioreg -r -d 1 -c IOAccelerator` on an M-series Mac: one accelerator,
// its statistics on a single line among much else.
const IOREG = `+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X, id 0x1000003a1, registered, matched, active, busy 0 (0 ms), retain 42>
    {
      "IOClass" = "AGXAcceleratorG14X"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=1409286144,"Tiler Utilization %"=11,"recoveryCount"=0,"Renderer Utilization %"=23,"Device Utilization %"=24,"In use system memory"=545554432}
      "IOMatchCategory" = "IOAccelerator"
    }
`

test('the GPU busy share is read from the accelerator statistics ioreg prints', () => {
  expect(parseIoregGpu(IOREG)).toBe(24)
  // Two GPUs (an Intel Mac with a discrete card): the busier one answers "is it the GPU?"
  expect(parseIoregGpu(`${IOREG}\n"PerformanceStatistics" = {"Device Utilization %"=71}`)).toBe(71)
  // Nothing to read is no answer, not a zero.
  expect(parseIoregGpu('')).toBeNull()
  expect(parseIoregGpu('"Device Utilization %"=4000')).toBeNull()
})

test('nvidia-smi says one number a card, and the busiest card is the one shown', () => {
  expect(parseNvidiaSmi('12\n87\n')).toBe(87)
  expect(parseNvidiaSmi('[N/A]\n')).toBeNull()
  expect(parseNvidiaSmi('')).toBeNull()
})

test('memory pressure is the kernel’s own level in Activity Monitor’s words, and nothing else', () => {
  expect(pressureOf('1\n')).toBe('normal')
  expect(pressureOf('2')).toBe('warning')
  expect(pressureOf('4')).toBe('critical')
  // The kernel skips 3; a level this was not written for is no answer rather than a guess.
  expect(pressureOf('3')).toBeNull()
  expect(pressureOf('')).toBeNull()
})

test('on Linux, pressure is the share of memory still available against two lines', () => {
  const meminfo = (available: number): string => `MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:   ${String(available)} kB\n`
  expect(linuxPressure(meminfo(8_000_000))).toBe('normal')
  expect(linuxPressure(meminfo(2_000_000))).toBe('warning')
  expect(linuxPressure(meminfo(400_000))).toBe('critical')
  // A kernel too old to say MemAvailable has no verdict to give.
  expect(linuxPressure('MemTotal: 16000000 kB\n')).toBeNull()
})

test('memory used on a Mac is app memory, wired and compressed — not the file cache', () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Anonymous pages:                         400000.
Pages purgeable:                          10000.
Pages wired down:                        100000.
Pages occupied by compressor:             50000.
File-backed pages:                       900000.
`
  expect(parseVmStat(text)).toBe((400000 - 10000 + 100000 + 50000) * 16384)
  expect(parseVmStat('no page size here')).toBeUndefined()
})

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

test('Linux temperature is the hottest zone that reads sensibly, and no zones is no number', async () => {
  dir = mkdtempSync(join(tmpdir(), 'alexia-thermal-'))
  const zone = (name: string, text: string): void => {
    mkdirSync(join(dir!, name))
    writeFileSync(join(dir!, name, 'temp'), text)
  }
  zone('thermal_zone0', '48500\n')
  zone('thermal_zone1', '61250\n')
  zone('thermal_zone2', '0\n') // a zone that reports nothing
  zone('thermal_zone3', '255000\n') // a sentinel far above boiling
  mkdirSync(join(dir, 'cooling_device0')) // not a zone
  expect(await linuxTemperature(dir)).toBe(61.3)
  expect(await linuxTemperature(join(dir, 'absent'))).toBeNull()
})

test('the history keeps the last readings, and starts again after a gap rather than joining it', () => {
  let at = 1_000_000
  let last = remember({ cpu: 1, gpu: null, memory: 50 }, at)
  for (let i = 0; i < KEPT + 5; i += 1) last = remember({ cpu: i, gpu: null, memory: 50 }, (at += 3000))
  expect(last.cpu).toHaveLength(KEPT)
  expect(last.cpu.at(-1)).toBe(KEPT + 4)
  expect(last.gpu.every((one) => one === null)).toBe(true)

  // Ten minutes hidden, then one reading: a history of one, not a line drawn across the hole.
  last = remember({ cpu: 9, gpu: 3, memory: 40 }, at + 600_000)
  expect(last).toEqual({ cpu: [9], gpu: [3], memory: [40] })
})

test('a reading of this machine never throws, and has every field even where the number is absent', async () => {
  const stats = await systemStats()
  expect(stats.cpu.cores).toBeGreaterThan(0)
  expect(stats.memory.total).toBeGreaterThan(0)
  expect(stats.memory.used).toBeGreaterThan(0)
  expect(stats.uptime).toBeGreaterThan(0)
  expect(stats).toHaveProperty('gpu.percent')
  expect(stats).toHaveProperty('memory.pressure')
  expect(stats.history.cpu.length).toBeGreaterThan(0)
})
