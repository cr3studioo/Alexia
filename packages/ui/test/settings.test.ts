// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { isSettingsPage, mountSettings } from '../src/settings.js'
import type { Rendered } from '../src/widgets.js'

/**
 * Settings is what you choose; Activity is what happened (D205).
 *
 * Core's sections marked `screen: 'settings'` are drawn on Settings pages by the same renderer
 * the Activity sheet uses. These pin where each one lands, and that the money page reads core
 * again every time it is shown rather than drawing a slider from an older read.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '')

const ladder = (): Rendered => ({
  type: 'ladder',
  key: 'routing',
  label: 'What may answer',
  rows: 'routing',
  stops: [{ value: 'mixed', label: 'Free, then paid', hint: '' }],
  value: 'mixed',
  chose: 'set_spend',
})
const table = (key: string): Rendered => ({ type: 'table', key, label: key, rows: key, columns: [{ key: 'name', label: 'Name' }], filter: true })

function core(): { panelReads: number } {
  const state = { panelReads: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      let answer: unknown = { ok: true, rows: [] }
      if (path === '/api/panels') {
        state.panelReads += 1
        answer = {
          tabs: [
            { id: 'runs', label: 'Runs', widgets: [table('activity')] },
            { id: 'models', label: 'Models & money', screen: 'settings', widgets: [ladder(), table('models')] },
            { id: 'skills', label: 'Skills', screen: 'settings', widgets: [table('skills')] },
            { id: 'tools', label: 'Every tool', screen: 'settings', widgets: [table('tools')] },
          ],
        }
      }
      if (path === '/api/plugins') answer = { panes: [], problems: [] }
      if (path === '/api/library') answer = { ok: true, registry: 'x', plugins: [], skills: [] }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
    }),
  )
  return state
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('the local model block uses Settings auth and stops polling on tab change and view close', async () => {
  vi.useFakeTimers()
  document.body.innerHTML = body
  document.body.dataset.view = 'settings'
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/local-models') return {
      ok: true,
      json: async () => ({
        machine: { summary: '16 GB RAM', freeDiskBytes: 50 * 1024 ** 3 }, runtime: { installed: true, version: '1', supported: true },
        mode: 'combined', picks: {}, all: [], uncensored: [], installed: [],
        jobs: [{ id: 'active', target: 'qwen:Q4_K_M', name: 'Qwen', step: 'download', message: 'Downloading', done: 1, total: 100, startedAt: Date.now() }],
      }),
    }
    if (path.includes('/progress?')) return { ok: true, json: async () => ({ id: 'active', target: 'qwen:Q4_K_M', name: 'Qwen', step: 'download', message: 'Downloading', done: 5, total: 100, startedAt: Date.now() }) }
    if (path === '/api/panels') return { ok: true, json: async () => ({ tabs: [] }) }
    if (path === '/api/plugins') return { ok: true, json: async () => ({ panes: [], problems: [] }) }
    void init
    return { ok: true, json: async () => ({ ok: true, registry: 'https://registry.example', plugins: [], skills: [] }) }
  })
  vi.stubGlobal('fetch', request)
  const settings = mountSettings('same-origin-token')
  settings.open('models')
  await flush()
  expect(document.querySelector('#models-page .local-models')?.textContent).toContain('Local models')
  expect(request).toHaveBeenCalledWith('/api/local-models', expect.objectContaining({
    method: 'GET', headers: { 'content-type': 'application/json', 'x-alexia-token': 'same-origin-token' }, signal: expect.any(AbortSignal),
  }))
  const read = request.mock.calls.find(([path]) => path === '/api/local-models')![1]!
  expect(read.body).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1000)
  expect(request.mock.calls.some(([path]) => path === '/api/local-models/progress?job=active')).toBe(true)
  document.querySelector<HTMLButtonElement>('[data-settings="general"]')!.click()
  const before = request.mock.calls.filter(([path]) => path.includes('/progress?')).length
  await vi.advanceTimersByTimeAsync(5000)
  expect(request.mock.calls.filter(([path]) => path.includes('/progress?'))).toHaveLength(before)
  settings.open('models')
  await flush()
  settings.close()
  await vi.advanceTimersByTimeAsync(5000)
  expect(request.mock.calls.filter(([path]) => path.includes('/progress?'))).toHaveLength(before)
})

test('the palette and the rail can name every Settings page, and no Activity tab', () => {
  for (const page of ['general', 'models', 'safety', 'skills', 'plugins', 'about', 'tools']) expect(isSettingsPage(page)).toBe(true)
  for (const tab of ['runs', 'chats']) expect(isSettingsPage(tab)).toBe(false)
})

test('Models & money draws the ladder, with the model table behind a fold, and reads again each time', async () => {
  document.body.innerHTML = body
  const state = core()
  const settings = mountSettings('token')
  settings.open('models')
  await flush()

  const place = document.querySelector<HTMLElement>('#models-core')!
  expect(document.querySelector<HTMLElement>('#models-page')!.hidden).toBe(false)
  expect(document.querySelector<HTMLElement>('#general')!.hidden).toBe(true)
  expect(place.querySelector('.ladder')).not.toBeNull()
  const fold = place.querySelector<HTMLDetailsElement>('details.advanced')!
  expect(fold.open).toBe(false)
  expect(fold.querySelector('.table-box')).not.toBeNull()

  const reads = state.panelReads
  document.querySelector<HTMLButtonElement>('[data-settings="general"]')!.click()
  document.querySelector<HTMLButtonElement>('[data-settings="models"]')!.click()
  await flush()
  expect(state.panelReads).toBe(reads + 1)
})

test('the skills list is on Skills, and every tool is under Plugins > Advanced', async () => {
  document.body.innerHTML = body
  core()
  const settings = mountSettings('token')
  settings.open('skills')
  await flush()
  expect(document.querySelector('#skills-core .table-box')).not.toBeNull()

  settings.open('tools')
  await flush()
  expect(document.querySelector<HTMLElement>('#plugins-page')!.hidden).toBe(false)
  expect(document.querySelector<HTMLDetailsElement>('#plugins-advanced')!.open).toBe(true)
  expect(document.querySelector('#tools-core .table-box')).not.toBeNull()
  // The two ways to add something by hand are in the same fold, not on the grid.
  expect(document.querySelector('#plugins-adding')!.textContent).toContain('Add a plugin from a folder')
  expect(document.querySelector('#library')!.textContent).not.toContain('Add an MCP server')
})
