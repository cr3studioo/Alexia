// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { mountControl } from '../src/control.js'
import type { Rendered } from '../src/widgets.js'

/**
 * The Activity sheet, switching tabs.
 *
 * A tab's widgets carry the value standing in core. When the Models slider was a tab here,
 * redrawing from the list read when the sheet opened put the slider back where it was then,
 * and pressing the stop it showed sent nothing. The slider is on Settings since D205, but the
 * rule — read again on every switch — is the sheet's, and is pinned here with a stand-in tab.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** Core's side: whatever the slider stands at now, and every panels read counted. */
function core(): { spend: string; panelReads: number } {
  const state = { spend: 'mixed', panelReads: 0 }
  const ladder = (): Rendered => ({
    type: 'ladder',
    key: 'routing',
    label: 'What may answer',
    rows: 'routing',
    stops: [
      { value: 'free', label: 'Free only', hint: '' },
      { value: 'mixed', label: 'Free, then paid', hint: '' },
      { value: 'paid', label: 'Paid only', hint: '' },
    ],
    value: state.spend,
    chose: 'set_spend',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { body?: string }) => {
      let answer: unknown = { ok: true, rows: [] }
      if (path === '/api/panels') {
        state.panelReads += 1
        answer = {
          tabs: [
            { id: 'activity', label: 'Activity', soon: 'Runs.' },
            { id: 'models', label: 'Models', widgets: [ladder()] },
            { id: 'skills', label: 'Skills', screen: 'settings', soon: 'Drawn on Settings.' },
          ],
        }
      }
      if (path === '/api/action') {
        const body = JSON.parse(init?.body ?? '{}') as { key?: string; row?: string }
        if (body.key === 'set_spend' && typeof body.row === 'string') state.spend = body.row
        answer = { ok: true, said: '' }
      }
      return Promise.resolve({ json: () => Promise.resolve(answer) })
    }),
  )
  return state
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('switching tabs reads again, so the slider shows what core holds now', async () => {
  document.body.innerHTML =
    '<div id="control"><button id="tab-current"></button><nav id="tabs"></nav><div id="panel"></div></div>'
  const state = core()
  const control = mountControl('token')
  control.open('models')
  await flush()

  const stop = (value: string): HTMLInputElement =>
    [...document.querySelectorAll<HTMLInputElement>('.grade-stop input')].find((one) => one.value === value)!
  expect(stop('mixed').checked).toBe(true)

  // Paid only, pressed on the slider.
  stop('paid').checked = true
  stop('paid').dispatchEvent(new Event('change'))
  await flush()
  expect(state.spend).toBe('paid')

  // Away to another tab and back.
  const tab = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('#tabs .tab')].find((one) => one.textContent === label)!
  tab('Activity').click()
  await flush()
  tab('Models').click()
  await flush()

  expect(state.panelReads).toBe(3)
  expect(stop('paid').checked).toBe(true)
  expect(stop('mixed').checked).toBe(false)
})

test('a section core marks for Settings is not a tab here (D205)', async () => {
  document.body.innerHTML =
    '<div id="control"><button id="tab-current"></button><nav id="tabs"></nav><div id="panel"></div></div>'
  core()
  mountControl('token').open()
  await flush()
  const labels = [...document.querySelectorAll<HTMLButtonElement>('#tabs .tab')].map((one) => one.textContent)
  expect(labels).toEqual(['Activity', 'Models'])
})
