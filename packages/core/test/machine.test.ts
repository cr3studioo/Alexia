// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, vi } from 'vitest'
import { machine, memoryBudget, nvidiaGpus, summary, type MachineOptions } from '../src/machine.js'

const GB = 1024 ** 3
const base: MachineOptions = {
  platform: 'linux', arch: 'x64', chip: 'Test CPU', ramBytes: 16 * GB, freeRamBytes: 12 * GB, cpuCores: 8,
  run: async () => { throw new Error('not installed') }, read: async () => '',
  disk: async () => ({ bavail: 100 * GB / 4096, bsize: 4096 }),
}

test('OS reserve and available RAM both bound the budget; invalid inputs fail closed', () => {
  expect(memoryBudget(16 * GB)).toBe(12 * GB)
  expect(memoryBudget(16 * GB, 6 * GB)).toBe(5 * GB)
  expect(memoryBudget(8 * GB, 8 * GB)).toBe(4 * GB)
  expect(memoryBudget(3 * GB)).toBe(0)
  expect(memoryBudget(NaN, Infinity)).toBe(0)
  expect(memoryBudget(16 * GB, -1)).toBe(0)
})

test('Apple silicon is recognised under Rosetta, uses actual page size, and never adds shared VRAM', async () => {
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === 'vm_stat') return 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 327680.\nPages purgeable: 327680.\nPages occupied by compressor: 327680.'
    return args.at(-1) === 'hw.optional.arm64' ? '1\n' : 'Apple M2 Pro\n'
  })
  const m = await machine('/models', { ...base, platform: 'darwin', arch: 'x64', run })
  expect(m.appleSilicon).toBe(true)
  expect(m.arch).toBe('x64')
  expect(m.freeRamBytes).toBe(6 * GB)
  expect(m.budgetBytes).toBe(5 * GB)
  expect(summary(m)).toContain('unified memory')
  expect(summary(m)).not.toMatch(/tokens|per second|fast/i)
})

test('missing Mac telemetry uses the OS free-memory reading', async () => {
  const m = await machine('/models', { ...base, platform: 'darwin', arch: 'arm64' })
  expect(m.appleSilicon).toBe(true)
  expect(m.budgetBytes).toBe(11 * GB)
})

test('Linux MemAvailable excludes swap and GPU capacity never expands system RAM', async () => {
  const m = await machine('/models', { ...base,
    read: async (path) => path === '/proc/meminfo' ? `MemAvailable: ${6 * GB / 1024} kB\nSwapFree: 999999999 kB` : '',
    run: async () => 'NVIDIA RTX Test, 24576, 20000\n',
  })
  expect(m.freeRamBytes).toBe(6 * GB)
  expect(m.budgetBytes).toBe(5 * GB)
  expect(m.gpus?.[0]?.vramBytes).toBe(24 * GB)
})

test.each(['v1', 'v2'])('Linux %s container limits cap host memory and account for current usage', async (version) => {
  const m = await machine('/models', { ...base, ramBytes: 128 * GB, freeRamBytes: 100 * GB,
    read: async (path) => {
      if (path === '/proc/meminfo') return `MemAvailable: ${100 * GB / 1024} kB`
      if (version === 'v2' && path.endsWith('memory.max') || version === 'v1' && path.endsWith('memory.limit_in_bytes')) return String(8 * GB)
      if (version === 'v2' && path.endsWith('memory.current') || version === 'v1' && path.endsWith('memory.usage_in_bytes')) return String(6 * GB)
      return ''
    },
  })
  expect(m.ramBytes).toBe(8 * GB)
  expect(m.freeRamBytes).toBe(2 * GB)
  expect(m.budgetBytes).toBe(GB)
})

test('Windows inventory leaves unreliable adapter memory unknown', async () => {
  const m = await machine('/models', { ...base, platform: 'win32', run: async (command) => {
    if (command === 'powershell.exe') return JSON.stringify({ cpu: 'AMD Test', gpus: ['AMD Radeon Test'] })
    throw new Error('no nvidia-smi')
  } })
  expect(m.chip).toBe('AMD Test')
  expect(m.gpus).toEqual([{ name: 'AMD Radeon Test' }])
  expect(m.budgetBytes).toBe(11 * GB)
})

test('a missing data directory uses its ancestor without creating it', async () => {
  const disk = vi.fn(async (path: string) => {
    if (path !== '/tmp') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { bavail: 2048, bsize: 4096 }
  })
  const m = await machine('/tmp/new/data', { ...base, disk })
  expect(disk.mock.calls.map(([path]) => path)).toEqual(['/tmp/new/data', '/tmp/new', '/tmp'])
  expect(m.freeDiskBytes).toBe(2048 * 4096)
  expect(m.diskKnown).toBe(true)
})

test('permission errors and malformed disk telemetry fail closed', async () => {
  for (const disk of [async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, async () => ({ bavail: -1, bsize: 4096 })]) {
    const m = await machine('/models', { ...base, disk })
    expect(m.freeDiskBytes).toBe(0)
    expect(m.diskKnown).toBe(false)
  }
})

test('NVIDIA telemetry parses multiple devices and preserves unknown capacities', () => {
  expect(nvidiaGpus('NVIDIA A, 8192, 6144\r\nNVIDIA B, N/A, N/A\n')).toEqual([
    { name: 'NVIDIA A', vramBytes: 8 * GB, freeVramBytes: 6 * GB }, { name: 'NVIDIA B' },
  ])
  expect(nvidiaGpus('')).toEqual([])
})

test('a measured NVIDIA card sets the model budget when it is larger than spare RAM, and an unmeasured one does not', async () => {
  const { modelBudget, summary } = await import('../src/machine.js')
  const GiB = 1024 ** 3
  const pc = { platform: 'win32', arch: 'x64', chip: 'Ryzen', appleSilicon: false, ramBytes: 16 * GiB, freeRamBytes: 2 * GiB, freeDiskBytes: 200 * GiB, budgetBytes: GiB }
  const measured = { ...pc, gpus: [{ name: 'NVIDIA GeForce RTX 4060 Ti', vramBytes: 8 * GiB, freeVramBytes: 7 * GiB }] }
  expect(modelBudget(measured)).toBe(Math.floor(8 * GiB * 0.9))
  expect(summary(measured)).toContain('RTX 4060 Ti 8 GiB')
  // A card known only by name (nvidia-smi did not answer) adds nothing; neither does a Mac.
  expect(modelBudget({ ...pc, gpus: [{ name: 'NVIDIA GeForce RTX 4060 Ti' }] })).toBe(GiB)
  expect(modelBudget({ ...measured, platform: 'darwin', arch: 'arm64' })).toBe(GiB)
  // Never the two added.
  expect(modelBudget({ ...measured, budgetBytes: 10 * GiB })).toBe(10 * GiB)
})
