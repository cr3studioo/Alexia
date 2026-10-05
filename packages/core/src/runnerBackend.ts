// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nvidiaSmi } from './nvidia.js'

export type RunnerBackend = 'cpu' | 'metal' | 'cuda' | 'vulkan'
export type BackendPreference = RunnerBackend | 'auto'
export interface BackendGpu {
  name: string
  index: number
  uuid?: string
  vramBytes?: number
  freeVramBytes?: number
  driver?: string
  computeCapability?: number
}
export interface BackendProfile {
  backend: RunnerBackend
  requested: BackendPreference
  platform: string
  arch: string
  accelerated: boolean
  /** Dedicated memory only; never add this to the system-memory budget. */
  memoryBudgetBytes?: number
  gpu?: BackendGpu
  reason: string
}
export interface BackendOptions {
  platform?: string
  arch?: string
  preference?: BackendPreference
  signal?: AbortSignal
  probe?: (command: string, args: string[]) => Promise<string>
}
const execute = promisify(execFile)
const MiB = 1024 ** 2
export function nvidiaBackendGpus(output: string): BackendGpu[] {
  return output.trim().split(/\r?\n/).flatMap((line) => {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length !== 8) return []
    const [index, uuid, name, driver, capability, total, free, mode] = parts
    if (!/^\d+$/.test(index!) || !/^GPU-[a-f0-9-]+$/i.test(uuid!) || !name || !/^\d+\.\d+(?:\.\d+)?$/.test(driver!) || !/^\d+\.\d+$/.test(capability!) || !/^(Default|0)$/i.test(mode!)) return []
    const vram = Number(total) * MiB, available = Number(free) * MiB
    if (!Number.isSafeInteger(vram) || !Number.isSafeInteger(available) || vram <= 0 || available < 0 || available > vram) return []
    return [{ name, index: Number(index), uuid, driver, computeCapability: Number(capability), vramBytes: vram, freeVramBytes: available }]
  })
}
/** Conservative CUDA 12 policy: require the full toolkit's driver, not minor-version PTX
 * compatibility. Source: NVIDIA CUDA 12.8 / 12.4 release notes. CUDA 12 release builds include
 * Pascal and newer architectures. MIG/exclusive compute modes and unknown telemetry use CPU.
 */
export function cudaCompatible(gpu: BackendGpu, os: string): boolean {
  const version = (gpu.driver ?? '').split('.').map(Number)
  const major = version[0] ?? 0, minor = version[1] ?? 0
  const minimum = os === 'linux' ? [570, 26] : [551, 61]
  return ['linux', 'win32'].includes(os) && (major > minimum[0]! || major === minimum[0] && minor >= minimum[1]!) &&
    (gpu.computeCapability ?? 0) >= 6 && (gpu.computeCapability ?? 0) < 13
}
/** Only discrete/integrated physical GPUs with Vulkan >= 1.2 pass this manual opt-in policy.
 * Actual pinned llama-server --list-devices is also checked before loading model weights.
 * Vulkan summary does not provide reliable free VRAM: system-memory fit remains conservative.
 */
export function vulkanBackendGpu(summary: string): BackendGpu | undefined {
  const sections = summary.split(/GPU(\d+):/).slice(1)
  for (let i = 0; i + 1 < sections.length; i += 2) {
    const block = sections[i + 1]!
    const version = /apiVersion\s*=\s*(\d+)\.(\d+)/.exec(block)
    const name = /deviceName\s*=\s*([^\r\n]+)/.exec(block)?.[1]?.trim()
    if (name && /deviceType\s*=\s*PHYSICAL_DEVICE_TYPE_(?:DISCRETE|INTEGRATED)_GPU/.test(block) && version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 2)) return { name, index: Number(sections[i]) }
  }
  return undefined
}
export async function runnerBackendProfile(options: BackendOptions = {}): Promise<BackendProfile> {
  const os = options.platform ?? process.platform, arch = options.arch ?? process.arch
  const requested = options.preference ?? 'auto'
  if (!['auto', 'cpu', 'metal', 'cuda', 'vulkan'].includes(requested)) throw new Error('Unknown local runner backend.')
  const base = { requested, platform: os, arch }
  const cpu = (reason: string): BackendProfile => ({ ...base, backend: 'cpu', accelerated: false, reason })
  options.signal?.throwIfAborted()
  if (requested === 'cpu') return cpu('CPU selected explicitly.')
  if (os === 'darwin' && arch === 'arm64' && ['auto', 'metal'].includes(requested)) return { ...base, backend: 'metal', accelerated: true, reason: 'Pinned Metal runtime on Apple Silicon; uses the system unified-memory budget.' }
  if (!['linux', 'win32'].includes(os) || arch !== 'x64') return cpu('No established accelerated runtime policy for this platform; using CPU.')
  const probe = options.probe ?? (async (command, args) => {
    // `nvidia-smi` goes through the shared probe, which gives Windows what the driver needs (`nvidia.ts`).
    if (command !== 'nvidia-smi') return (await execute(command, args, { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true, signal: options.signal, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } })).stdout
    const got = await nvidiaSmi(args, { platform: os, ...(options.signal && { signal: options.signal }) })
    if ('error' in got) throw new Error(got.error)
    return got.stdout
  })
  if (requested === 'vulkan') {
    let gpu: BackendGpu | undefined
    try { gpu = vulkanBackendGpu(await probe('vulkaninfo', ['--summary'])) } catch { /* A missing loader / probe is not established compatibility. */ }
    options.signal?.throwIfAborted()
    return gpu ? { ...base, backend: 'vulkan', accelerated: true, gpu, reason: 'Vulkan explicitly selected and a physical Vulkan 1.2+ GPU reported; runtime device check required.' } : cpu('Vulkan requested, but no compatible physical device was established by vulkaninfo; using CPU.')
  }
  if (requested === 'metal') return cpu('Metal is supported only on Apple Silicon by this policy; using CPU.')
  let gpus: BackendGpu[] = []
  let probeError: string | undefined
  try { gpus = nvidiaBackendGpus(await probe('nvidia-smi', ['--query-gpu=index,uuid,name,driver_version,compute_cap,memory.total,memory.free,compute_mode', '--format=csv,noheader,nounits'])) } catch (error) {
    // Unknown driver/hardware => CPU, and the reason says what the probe answered.
    probeError = error instanceof Error ? error.message : String(error)
  }
  options.signal?.throwIfAborted()
  const gpu = gpus.filter((g) => cudaCompatible(g, os)).sort((a, b) => (b.freeVramBytes ?? 0) - (a.freeVramBytes ?? 0))[0]
  return gpu ? { ...base, backend: 'cuda', accelerated: true, gpu,
    memoryBudgetBytes: Math.max(0, Math.floor(Math.min(gpu.vramBytes! * 0.8, gpu.freeVramBytes! - 512 * MiB))),
    reason: `Compatible NVIDIA GPU and driver detected for pinned CUDA ${os === 'linux' ? '12.8' : '12.4'}; system RAM and dedicated VRAM are separate constraints.` } : cpu(`No compatible NVIDIA GPU/driver established; using CPU. Vulkan requires an explicit selection.${probeError ? ` nvidia-smi: ${probeError}` : ''}`)
}
