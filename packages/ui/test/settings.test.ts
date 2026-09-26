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
