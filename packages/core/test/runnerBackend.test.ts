// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest'
import { cudaCompatible, nvidiaBackendGpus, runnerBackendProfile, vulkanBackendGpu } from '../src/runnerBackend.js'

const row = (index = 0, free = 12000, driver = '570.26'): string => `${index}, GPU-abcd-${index}, NVIDIA Fixture, ${driver}, 8.6, 16384, ${free}, Default`
describe('runner backend policy', () => {
  test('CPU and Apple Silicon Metal need no hardware subprocess', async () => {
    const probe = async (): Promise<string> => { throw new Error('must not probe') }
    expect(await runnerBackendProfile({ platform: 'darwin', arch: 'arm64', preference: 'auto', probe })).toMatchObject({ backend: 'metal', accelerated: true })
    expect(await runnerBackendProfile({ platform: 'linux', arch: 'x64', preference: 'cpu', probe })).toMatchObject({ backend: 'cpu', accelerated: false })
    expect(await runnerBackendProfile({ platform: 'linux', arch: 'arm64', probe })).toMatchObject({ backend: 'cpu' })
  })
  test('selects a compatible CUDA GPU by free VRAM without adding system RAM', async () => {
    const profile = await runnerBackendProfile({ platform: 'linux', arch: 'x64', probe: async (command, args) => {
      expect(command).toBe('nvidia-smi')
      expect(args).toContain('--format=csv,noheader,nounits')
      return [row(0, 1000), row(1, 12000), row(2, 16000, '550.00')].join('\n')
    } })
    expect(profile).toMatchObject({ backend: 'cuda', gpu: { index: 1, uuid: 'GPU-abcd-1' }, memoryBudgetBytes: (12000 - 512) * 1024 ** 2 })
  })
  test.each([['linux', '570.25', false], ['linux', '570.26', true], ['win32', '551.60', false], ['win32', '551.61', true], ['darwin', '999.0', false]] as const)('enforces %s driver %s', (platform, driver, expected) => {
    expect(cudaCompatible(nvidiaBackendGpus(row(0, 12000, driver))[0]!, platform)).toBe(expected)
  })
  test('unknown/malformed telemetry and failed probes fall back to CPU', async () => {
    for (const output of ['garbage', row().replace('Default', 'Exclusive_Process'), row(0, 20000), row().replace('8.6', 'unknown')]) {
      expect(nvidiaBackendGpus(output)).toEqual([])
      expect(await runnerBackendProfile({ platform: 'linux', arch: 'x64', probe: async () => output })).toMatchObject({ backend: 'cpu' })
    }
    expect(await runnerBackendProfile({ platform: 'linux', arch: 'x64', probe: async () => { throw new Error('no driver') } })).toMatchObject({ backend: 'cpu' })
  })
  test('Vulkan requires explicit selection and a physical device supporting 1.2+', async () => {
    const summary = 'GPU0:\n apiVersion = 1.3.0\n deviceName = Software\n deviceType = PHYSICAL_DEVICE_TYPE_CPU\nGPU1:\n apiVersion = 1.2.0\n deviceName = Discrete\n deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU'
    expect(vulkanBackendGpu(summary)).toMatchObject({ index: 1, name: 'Discrete' })
    expect(vulkanBackendGpu(summary.replace('1.2.0', '1.1.0'))).toBeUndefined()
    expect(await runnerBackendProfile({ platform: 'linux', arch: 'x64', preference: 'vulkan', probe: async (command) => {
      expect(command).toBe('vulkaninfo'); return summary
    } })).toMatchObject({ backend: 'vulkan', gpu: { index: 1 } })
    expect(await runnerBackendProfile({ platform: 'linux', arch: 'x64', probe: async (command) => {
      expect(command).toBe('nvidia-smi'); return ''
    } })).toMatchObject({ backend: 'cpu' })
  })
  test('cancellation is preserved even if an in-flight probe fails', async () => {
    const cancel = new AbortController()
    await expect(runnerBackendProfile({ platform: 'linux', arch: 'x64', signal: cancel.signal, probe: async () => {
      cancel.abort(); throw new Error('probe interrupted')
    } })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(runnerBackendProfile({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

test('a failed nvidia-smi says why in the CPU reason', async () => {
  const profile = await runnerBackendProfile({ platform: 'win32', arch: 'x64', probe: async () => { throw new Error('spawn nvidia-smi ENOENT') } })
  expect(profile.backend).toBe('cpu')
  expect(profile.reason).toContain('nvidia-smi: spawn nvidia-smi ENOENT')
})
