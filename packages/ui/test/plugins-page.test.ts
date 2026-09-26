// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { mountSettings, type Pane } from '../src/settings.js'

/**
 * Settings > Plugins, pressed the way a person presses it.
 *
 * Every case here is one somebody hit: a crashed plugin that said *stopped* and nothing else,
 * a double-click that deleted, an install that failed and could not be tried again, and
 * buttons left disabled by a request that never came back.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '')

const pane = (over: Partial<Pane> = {}): Pane => ({
  id: 'voice',
  name: 'Voice',
  summary: 'Speaks her answers out loud',
  version: '1.0.0',
  license: 'MIT',
  enabled: true,
  running: false,
  requires: [],
  settings: [],
  ...over,
})

interface Core {
  sent: { path: string; body: Record<string, unknown> }[]
  answers: Record<string, unknown>
  /** Paths whose request never comes back, as when core has gone. */
  dropped: Set<string>
}

function core(panes: Pane[], extra: Record<string, unknown> = {}, shelf: unknown[] = []): Core {
  const state: Core = { sent: [], answers: {}, dropped: new Set() }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { body?: string }) => {
      if (init?.body !== undefined) state.sent.push({ path, body: JSON.parse(init.body) as Record<string, unknown> })
      if (state.dropped.has(path)) return Promise.reject(new TypeError('Failed to fetch'))
      let answer: unknown = state.answers[path] ?? { ok: true }
      if (path === '/api/plugins') answer = { panes, problems: [], ...extra }
      if (path === '/api/library') answer = { ok: true, registry: 'x', plugins: shelf, skills: [] }
      if (path === '/api/panels') answer = { tabs: [] }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
    }),
  )
  return state
}

async function open(): Promise<ReturnType<typeof mountSettings>> {
  document.body.innerHTML = body
  const settings = mountSettings('token')
  settings.open('plugins')
  await flush()
  return settings
}

const card = (name: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('#bento .bento-card')].find((one) => one.querySelector('.bento-open')?.textContent === name)!

const page = (): HTMLElement => document.querySelector<HTMLElement>('#plugin-detail')!

const button = (within: HTMLElement, label: string): HTMLButtonElement =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)!

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('a plugin Alexia switched off says so, says why, and offers Restart', async () => {
  const state = core([pane({ state: 'unhealthy', reason: 'Voice stopped 3 times in a minute, so Alexia has switched it off.' })])
  await open()
  expect(card('Voice').querySelector('.pill.danger')?.textContent).toBe('Switched off')

  card('Voice').querySelector<HTMLButtonElement>('.bento-open')!.click()
  expect(page().querySelector('.pill.danger')?.textContent).toBe('Switched off')
  expect(page().textContent).toContain('Voice stopped 3 times in a minute')
  expect(page().textContent).not.toContain('stopped ·')

  button(page(), 'Restart').click()
  await flush()
  expect(state.sent).toContainEqual({ path: '/api/plugin', body: { id: 'voice', action: 'restart' } })
})

test('a healthy plugin between calls is Ready, not stopped', async () => {
  core([pane()])
  await open()
  card('Voice').querySelector<HTMLButtonElement>('.bento-open')!.click()
  const pill = page().querySelector('.pane-head .pill')!
  expect(pill.textContent).toBe('Ready')
  expect(pill.classList.contains('danger')).toBe(false)
  expect(button(page(), 'Restart')).toBeUndefined()
})

test('opening a card takes focus to its page heading, and back takes it to the card', async () => {
  core([pane()])
  await open()
  card('Voice').querySelector<HTMLButtonElement>('.bento-open')!.click()
  expect(document.activeElement).toBe(page().querySelector('.pane-head h3'))
  button(page(), '← All plugins').click()
  expect(document.activeElement).toBe(card('Voice').querySelector('.bento-open'))
})

test('the filter wants every word, not the words as one phrase', async () => {
  core([pane(), pane({ id: 'memory', name: 'Memory', summary: 'Remembers things about you' })])
  await open()
  const filter = document.querySelector<HTMLInputElement>('#plugin-filter')!
  filter.value = 'answers voice'
  filter.dispatchEvent(new Event('input'))
  expect(card('Voice')).toBeDefined()
  expect(card('Memory')).toBeUndefined()
})

test('Delete ignores a double-click, and forgets being armed after a few seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const state = core([pane()])
  await open()
  card('Voice').querySelector<HTMLButtonElement>('.bento-open')!.click()
  const remove = button(page(), 'Delete')

  remove.click()
  expect(remove.textContent).toBe('Delete for good')
  // The second click of a double-click.
  vi.advanceTimersByTime(200)
  remove.click()
  await flush()
  expect(state.sent.some((one) => one.body.action === 'delete')).toBe(false)

  // Left armed, it goes back to plain Delete.
  vi.advanceTimersByTime(6000)
  expect(remove.textContent).toBe('Delete')

  // Two deliberate presses still delete.
  remove.click()
  vi.advanceTimersByTime(1500)
  remove.click()
  await flush()
  expect(state.sent).toContainEqual({ path: '/api/plugin', body: { id: 'voice', action: 'delete', confirm: true } })
})

test('a failed install can be tried again, and a dropped one does not freeze the screen', async () => {
  const state = core([], {}, [{ id: 'voice', name: 'Voice', summary: 'Speaks', installed: false }])
  state.answers['/api/library/install'] = { ok: false, said: 'The registry could not be reached: offline' }
  await open()
  card('Voice').click()
  const install = button(card('Voice'), 'Install')
  install.click()
  await flush()
  const again = button(card('Voice'), 'Try again')
  expect(again).toBeDefined()
  expect(again.closest<HTMLElement>('.row')!.hidden).toBe(false)
  expect(card('Voice').querySelector('.error')?.textContent).toContain('could not be reached')

  state.dropped.add('/api/library/install')
  again.click()
  await flush()
  expect(button(card('Voice'), 'Try again')).toBeDefined()
  expect(card('Voice').querySelector('.error')?.textContent).toContain('Alexia did not answer')
})

test('the MCP form says what Add does, answers empty boxes, submits on Enter and comes back after a drop', async () => {
  const state = core([])
  await open()
  const form = document.querySelector<HTMLElement>('#plugins-adding')!
  expect(form.textContent).toContain('Adding runs this command once to see what it offers.')

  const add = button(form, 'Add')
  add.click()
  await flush()
  expect(form.textContent).toContain('Give it a name and the command that starts it.')
  expect(state.sent.some((one) => one.path === '/api/server')).toBe(false)

  const [name, command] = [...form.querySelectorAll<HTMLInputElement>('input')].filter((one) => one.placeholder !== 'The full path of a plugin folder')
  name!.value = 'files'
  command!.value = 'npx server-files ~/Documents'
  state.dropped.add('/api/server')
  command!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  await flush()
  expect(state.sent).toContainEqual({ path: '/api/server', body: { id: 'files', run: 'npx', args: ['server-files', '~/Documents'] } })
  expect(add.disabled).toBe(false)
  expect(form.querySelector('.error')?.textContent).toContain('Alexia did not answer')
})

test('an MCP server’s page lists what it offers, and trusting it takes two presses', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const state = core([pane({ id: 'files', name: 'files', summary: 'MCP server.', enabled: false })], {
    unreviewed: ['files'],
    offers: { files: [{ name: 'read_file', description: 'Reads a file' }] },
  })
  await open()
  card('files').querySelector<HTMLButtonElement>('.bento-open')!.click()
  expect(page().textContent).toContain('It offers one tool:')
  expect(page().textContent).toContain('read_file')

  const trust = button(page(), 'I have read what it does — trust it')
  trust.click()
  await flush()
  expect(state.sent.some((one) => one.body.action === 'trust')).toBe(false)
  expect(trust.textContent).toBe('Press again to trust it')
  vi.advanceTimersByTime(1500)
  trust.click()
  await flush()
  expect(state.sent).toContainEqual({ path: '/api/server', body: { id: 'files', action: 'trust', confirm: true } })
})

test('a card switch that is refused goes back and says why', async () => {
  const state = core([pane({ enabled: false })])
  state.answers['/api/plugin'] = { ok: false, said: 'There is no plugin called “voice”.' }
  await open()
  const box = card('Voice').querySelector<HTMLInputElement>('.switch input')!
  box.checked = true
  box.dispatchEvent(new Event('change'))
  await flush()
  expect(box.checked).toBe(false)
  expect(box.disabled).toBe(false)
  expect(card('Voice').querySelector('.card-error')?.textContent).toContain('There is no plugin called')
})
