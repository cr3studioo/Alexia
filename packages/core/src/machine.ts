// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { arch, availableParallelism, cpus, freemem, platform, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const GB = 1024 ** 3
const execute = promisify(execFile)

export interface Gpu {
  name: string
  /** Dedicated VRAM only. Apple unified memory is never counted here. */
  vramBytes?: number
  freeVramBytes?: number
}

export interface Machine {
  platform: string
  arch: string
  chip: string
  appleSilicon: boolean
  ramBytes: number
  freeRamBytes?: number
  freeDiskBytes: number
  /** False means the disk probe failed; zero bytes must not be treated as unlimited. */
  diskKnown?: boolean
  /** System-memory budget, with OS and active applications left room. Never RAM + VRAM. */
  budgetBytes: number
  cpuCores?: number
  gpus?: Gpu[]
}

/** OS probes are injectable; no command shell, network, or writes are used. */
export interface MachineOptions {
  platform?: string
  arch?: string
  ramBytes?: number
  freeRamBytes?: number
  chip?: string
  cpuCores?: number
  run?: (command: string, args: string[]) => Promise<string>
  read?: (path: string) => Promise<string>
  disk?: (path: string) => Promise<{ bavail: number; bsize: number }>
}

const bytes = (n: number): number => Number.isFinite(n) && n > 0 ? Math.floor(n) : 0

/** Policy, not an OS limit: reserve at least 4 GiB or 25%, plus 1 GiB of currently available RAM. */
export function memoryBudget(ram: number, available?: number): number {
  const total = bytes(ram)
  const ceiling = Math.max(0, total - Math.max(4 * GB, total * 0.25))
  return Math.floor(available === undefined ? ceiling : Math.min(ceiling, Math.max(0, bytes(available) - GB)))
}

/** nvidia-smi reports MiB with nounits, not decimal megabytes. Missing telemetry stays unknown. */
export function nvidiaGpus(output: string): Gpu[] {
  return output.trim().split(/\r?\n/).flatMap((line) => {
    const fields = line.split(',').map((s) => s.trim())
    if (fields.length < 3) return []
    const free = Number(fields.pop())
    const total = Number(fields.pop())
    const name = fields.join(', ')
    if (!name) return []
    return [{ name, ...(Number.isFinite(total) && total > 0 && { vramBytes: bytes(total * 1024 ** 2) }),
      ...(Number.isFinite(free) && free >= 0 && { freeVramBytes: bytes(free * 1024 ** 2) }) }]
  })
}

async function diskFree(path: string, probe: NonNullable<MachineOptions['disk']>): Promise<number | undefined> {
  let target = resolve(path)
  for (;;) {
    try {
      const disk = await probe(target)
      const value = disk.bavail * disk.bsize
      return Number.isFinite(value) && value >= 0 && disk.bsize > 0 ? Math.floor(value) : undefined
    } catch (error) {
      // A first run can name a data directory which does not exist yet. Use its closest ancestor.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
      const parent = dirname(target)
      if (parent === target) return undefined
      target = parent
    }
  }
}

export async function machine(dataDir: string, options: MachineOptions = {}): Promise<Machine> {
  const os = options.platform ?? platform()
  const architecture = options.arch ?? arch()
  const run = options.run ?? (async (command, args) => (await execute(command, args, { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout)
  const read = options.read ?? ((path) => readFile(path, 'utf8'))
  const optionalRun = (command: string, args: string[]): Promise<string> => run(command, args).catch(() => '')
  const optionalRead = (path: string): Promise<string> => read(path).catch(() => '')
  let ram = bytes(options.ramBytes ?? totalmem())
  let available = bytes(options.freeRamBytes ?? freemem())
  let chip = options.chip ?? cpus()[0]?.model.trim() ?? 'Unknown processor'
  let appleSilicon = os === 'darwin' && architecture === 'arm64'
  let gpus: Gpu[] = []
  const freeDisk = diskFree(dataDir, options.disk ?? statfs)

  if (os === 'darwin') {
    const [brand, arm, vm] = await Promise.all([
      optionalRun('sysctl', ['-n', 'machdep.cpu.brand_string']),
      optionalRun('sysctl', ['-n', 'hw.optional.arm64']),
      optionalRun('vm_stat', []),
    ])
    chip = brand.trim() || chip
    appleSilicon ||= arm.trim() === '1' || /^Apple\s+[AM]\d/i.test(chip)
    // vm_stat's inactive pages can be reclaimed. Do not add purgeable pages again or swap.
    const page = Number(/page size of (\d+) bytes/.exec(vm)?.[1])
    const free = Number(/Pages free:\s+(\d+)/.exec(vm)?.[1])
    const inactive = Number(/Pages inactive:\s+(\d+)/.exec(vm)?.[1])
    if (page > 0 && Number.isFinite(free) && Number.isFinite(inactive)) available = bytes((free + inactive) * page)
  } else if (os === 'linux') {
    const [mem, max, current, v1Max, v1Current, gpu] = await Promise.all([
      optionalRead('/proc/meminfo'), optionalRead('/sys/fs/cgroup/memory.max'), optionalRead('/sys/fs/cgroup/memory.current'),
      optionalRead('/sys/fs/cgroup/memory/memory.limit_in_bytes'), optionalRead('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
      optionalRun('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']),
    ])
    const usable = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(mem)?.[1])
    if (Number.isFinite(usable)) available = bytes(usable * 1024)
    const limits: [string, string][] = [[max, current], [v1Max, v1Current]]
    for (const [limitText, usedText] of limits) {
      const limit = Number(limitText.trim())
      const used = Number(usedText.trim())
      if (limit > 0 && limit < ram) {
        ram = bytes(limit)
        available = Math.min(available, usedText.trim() && Number.isFinite(used) ? Math.max(0, ram - used) : ram)
      }
    }
    gpus = nvidiaGpus(gpu)
  } else if (os === 'win32') {
    const [gpu, details] = await Promise.all([
      optionalRun('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']),
      optionalRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[pscustomobject]@{cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name);gpus=@(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)} | ConvertTo-Json -Compress']),
    ])
    gpus = nvidiaGpus(gpu)
    try {
      const info = JSON.parse(details) as { cpu?: string; gpus?: string[] }
      chip = info.cpu?.trim() || chip
      for (const name of info.gpus ?? []) if (typeof name === 'string' && !gpus.some((g) => g.name === name)) gpus.push({ name })
      // Win32_VideoController.AdapterRAM is uint32; it cannot reliably describe modern VRAM.
      // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller
    } catch { /* Optional GPU inventory unavailable; CPU and RAM still work. */ }
  }
  available = Math.min(ram, available)
  const disk = await freeDisk
  return { platform: os, arch: architecture, chip, appleSilicon, ramBytes: ram, freeRamBytes: available,
    budgetBytes: memoryBudget(ram, available), freeDiskBytes: disk ?? 0, diskKnown: disk !== undefined,
    cpuCores: options.cpuCores ?? availableParallelism(), gpus }
}

export function summary(m: Machine): string {
  return `${m.chip} · ${(m.ramBytes / GB).toFixed(0)} GiB RAM${m.appleSilicon ? ' (unified memory)' : ''} · ${(m.budgetBytes / GB).toFixed(1)} GiB model budget`
}
