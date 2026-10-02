// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { stateSentence } from '../src/compute.js'
import { mountModeTransition, targetLine, type ModeState, type ModeTransition } from '../src/mode-transition.js'

const close: (() => void)[] = []
afterEach(() => { for (const one of close.splice(0)) one(); vi.useRealTimers(); document.body.innerHTML = '' })
function fixture() {
  document.body.innerHTML = '<div id="switch"></div><p id="settings-mode"></p>'
  const mode = vi.fn()
  const blocked = vi.fn()
  const picker = vi.fn()
  const failed = vi.fn()
  const refresh = vi.fn(async () => undefined)
  const read = vi.fn(async (): Promise<ModeState> => ({ setup: { mode: 'cloud' } }))
  const controller = mountModeTransition({ hosts: [...document.body.children] as HTMLElement[], mode, blocked, picker, failed, refresh, read, hostName: (id) => id === 'studio0001' ? 'Studio' : undefined })
  close.push(controller.close)
  return { controller, mode, blocked, picker, failed, refresh, read }
}
const state = (phase: ModeTransition['phase'], partial: Partial<ModeTransition> = {}): ModeState => ({
  setup: { mode: phase === 'ready' ? 'local' : 'cloud' },
  modeTransition: { id: 'transition', targetMode: 'local', phase, message: phase === 'loading' ? 'Loading Qwen3…' : phase === 'waiting' ? 'Switching after the current operation finishes.' : phase === 'ready' ? 'Local · Qwen3' : 'Runner failed.', ...partial },
})

test('both controls keep the confirmed mode, display loading, and poll each second until readiness', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.controller.sync({ setup: { mode: 'cloud' } })
  const ticket = f.controller.begin()
  expect(f.mode).toHaveBeenLastCalledWith('cloud')
  expect(f.blocked).toHaveBeenLastCalledWith(true)
  await f.controller.observe(state('loading'), ticket)
  expect([...document.querySelectorAll('.mode-transition')].map((line) => line.textContent)).toEqual(['Loading Qwen3…', 'Loading Qwen3…'])
  f.read.mockResolvedValueOnce(state('waiting')).mockResolvedValueOnce(state('ready'))
  await vi.advanceTimersByTimeAsync(999)
  expect(f.read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.mode).toHaveBeenLastCalledWith('cloud')
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.mode).toHaveBeenLastCalledWith('local')
  expect(f.blocked).toHaveBeenLastCalledWith(false)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.read).toHaveBeenCalledTimes(2)
})

test('failure restores controls and opens the picker with its explanation only once', async () => {
  const f = fixture()
  const failed = state('failed', { picker: true, message: 'Install a model that fits.' })
  await f.controller.observe(failed)
  expect(f.mode).toHaveBeenLastCalledWith('cloud')
  expect(f.blocked).toHaveBeenLastCalledWith(false)
  expect(f.picker).toHaveBeenCalledWith('Install a model that fits.')
  expect(f.failed).not.toHaveBeenCalled()
  await f.controller.observe(failed)
  expect(f.picker).toHaveBeenCalledOnce()
})

test('readiness errors are shown and obsolete HTTP responses cannot settle a newer selection', async () => {
  const f = fixture()
  await f.controller.sync({ setup: { mode: 'cloud' } })
  const old = f.controller.begin()
  const latest = f.controller.begin()
  await f.controller.observe(state('ready'), old)
  expect(f.blocked).toHaveBeenLastCalledWith(true)
  expect(f.mode).toHaveBeenLastCalledWith('cloud')
  await f.controller.sync(state('ready'))
  expect(f.blocked).toHaveBeenLastCalledWith(true)
  await f.controller.observe(state('failed'), latest)
  expect(f.failed).toHaveBeenCalledWith('Runner failed.')
  expect(f.blocked).toHaveBeenLastCalledWith(false)
})

test('a temporary polling error retains the block and retries; closing stops polling', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.read.mockRejectedValueOnce(new Error('offline'))
  await f.controller.observe(state('loading'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.blocked).toHaveBeenLastCalledWith(true)
  expect(document.querySelector('.mode-transition')?.textContent).toContain('Waiting for Alexia')
  f.controller.close()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.read).toHaveBeenCalledOnce()
})

test('a model on a paired computer is said with its host, how it is reached and its phase', async () => {
  const f = fixture()
  const target = { hostId: 'studio0001', modelId: 'llama/qwen:Q4_K_M' }
  const remote = (phase: ModeTransition['phase'], status: Partial<NonNullable<ModeTransition['targetStatus']>>): ModeState =>
    state(phase, { selectedModel: { id: `@${target.hostId}/${target.modelId}`, name: 'Qwen' }, target, targetStatus: { target, phase: 'loading', connection: 'direct', message: 'Loading Qwen…', ...status } })
  await f.controller.observe(remote('loading', { connection: 'relayed' }))
  expect(document.querySelector('.mode-transition')!.textContent).toBe('Studio · Qwen · Relayed — Loading Qwen…')
  expect(targetLine(remote('loading', { phase: 'queued', position: 2 }).modeTransition!, () => 'Studio')).toBe('Studio · Qwen · Direct — Waiting in its queue, number 2')
  expect(targetLine(remote('ready', { phase: 'ready' }).modeTransition!, () => 'Studio')).toBe('Studio · Qwen · Direct — Ready')
  // A model on this computer keeps core's own line.
  expect(targetLine(state('loading').modeTransition!)).toBeUndefined()
  // A settled failure names the state in its own sentence and opens the picker, where the host is still listed.
  await f.controller.observe(remote('failed', { phase: 'offline', connection: 'offline', message: 'core said offline' }))
  const line = `Studio · Qwen · Offline — ${stateSentence('offline', 'Studio')!}`
  expect(document.querySelector('.mode-transition')!.textContent).toBe(line)
  expect(f.picker).toHaveBeenCalledExactlyOnceWith(line)
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.mode).toHaveBeenLastCalledWith('cloud')
})
