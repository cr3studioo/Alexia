// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostView } from '../src/compute.js'
import { MORE, mountRail, railHost, railModels, recentWhen, whenOf } from '../src/rail.js'

/**
 * The rail: the General page's conversations, model list and plugin switches, against a core
 * that answers from a table here. The markup is index.html's own, so a test cannot pass
 * against ids the page no longer has.
 */

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const aside = /<aside id="rail"[\s\S]*?<\/aside>/.exec(html)![0]

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

interface Core {
  chats: Record<string, unknown>[]
  models: Record<string, unknown>[]
  panes: { id: string; name: string; enabled: boolean; running: boolean }[]
  answers: Record<string, unknown>
  sent: { path: string; body: Record<string, unknown> }[]
}

function core(partial: Partial<Core> = {}): Core {
  const state: Core = { chats: [], models: [], panes: [], answers: {}, sent: [], ...partial }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      state.sent.push({ path, body })
      let answer: unknown = state.answers[path] ?? { ok: true }
      if (path === '/api/rows') answer = { rows: body.key === 'chats' ? state.chats : state.models }
      if (path === '/api/plugins') answer = { panes: state.panes }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
    }),
  )
  return state
}

function mount(hosts: HostView[] = []): {
  root: HTMLElement
  heading: HTMLElement
  openControl: ReturnType<typeof vi.fn>
  openSettings: ReturnType<typeof vi.fn>
  refresh: () => Promise<void>
} {
  document.body.innerHTML = `${aside}<h1 id="chat-title"></h1><button id="open-control"></button><button id="open-settings"></button>`
  const root = document.querySelector<HTMLElement>('#rail')!
  const heading = document.querySelector<HTMLElement>('#chat-title')!
  const openControl = vi.fn()
  const openSettings = vi.fn()
  const rail = mountRail(root, 'token', {
    heading,
    openPalette: () => undefined,
    openControl,
    openSettings,
    reload: () => Promise.resolve(),
    hosts: () => hosts,
  })
  return { root, heading, openControl, openSettings, refresh: rail.refresh }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const now = new Date(2026, 8, 25, 15, 0)

test('rail dates: today is a time, then Yesterday, a weekday, a date, and a year when it is not this one', () => {
  expect(recentWhen(new Date(2026, 8, 25, 9, 42).getTime(), now, 'en-GB')).toBe('9:42')
  expect(recentWhen(new Date(2026, 8, 24, 23, 59).getTime(), now, 'en-GB')).toBe('Yesterday')
  expect(recentWhen(new Date(2026, 8, 21, 8, 0).getTime(), now, 'en-GB')).toBe('Mon')
  expect(recentWhen(new Date(2026, 8, 12, 8, 0).getTime(), now, 'en-GB')).toBe('12 Sept')
  expect(recentWhen(new Date(2025, 8, 12, 8, 0).getTime(), now, 'en-GB')).toBe('12 Sept 2025')
})

test('rail dates: core’s own text when a row has no timestamp', () => {
  expect(whenOf({ when: '9/12/26, 2:03 PM' }, now)).toBe('9/12/26, 2:03 PM')
  expect(whenOf({ when: 'x', at: new Date(2026, 8, 24, 10, 0).getTime() }, now)).not.toBe('x')
})

test('rail models: each once, and the one just chosen does not jump to the top', () => {
  const rows = [
    { id: 'kilo\nb', state: '◆ everything goes here' },
    { id: 'kilo\na', state: '★ recommended' },
    { id: 'kilo\nb', state: '◆ everything goes here' },
    { id: 'openrouter\nb', state: '◆ everything goes here' },
    { id: 'kilo\nc', state: '✓ · tools' },
  ]
  expect(railModels(rows).map((row) => row.id)).toEqual(['kilo\na', 'kilo\nb', 'kilo\nc'])
  // A chosen model no plan holds is only in its own group, and is kept.
  expect(railModels([{ id: 'x\nz', state: '◆ everything goes here' }, rows[1]!]).map((row) => row.id)).toEqual(['x\nz', 'kilo\na'])
})

test('the local install link opens Models in Settings, including when no provider is connected', async () => {
  core()
  const { root, refresh, openSettings } = mount()
  await refresh()
  const local = [...root.querySelectorAll<HTMLButtonElement>('#model-drop button')].find((one) => one.textContent === 'Install a local model…')!
  expect(local).toBeDefined()
  root.querySelector<HTMLButtonElement>('#model-row')!.click()
  local.click()
  expect(openSettings).toHaveBeenCalledWith('models')
  expect(root.querySelector<HTMLElement>('#model-drop')!.hidden).toBe(true)
})

test('a model on a paired computer shows that computer and how it is reached beside it', async () => {
  const studio: HostView = { host: { id: 'studio0001', name: 'Studio', endpointId: 'e', peerRole: 'compute', pairedAt: 1 }, connection: 'relayed' }
  expect(railHost('remote\n@studio0001/llama/qwen:Q4_K_M', [studio])).toBe('Studio · Relayed')
  expect(railHost('remote\n@studio0001/llama/qwen:Q4_K_M', [{ ...studio, connection: 'offline' }])).toBe('Studio · Offline')
  expect(railHost('llama\nllama/qwen:Q4_K_M', [studio])).toBe('')
  expect(railHost('remote\n@gone000001/llama/qwen:Q4_K_M', [studio])).toBe('Paired computer')
  core({
    models: [
      { id: 'remote\n@studio0001/llama/qwen:Q4_K_M', name: 'Qwen', provider: 'remote', price: 'free', state: '◆ everything goes here' },
      { id: 'llama\nllama/qwen:Q4_K_M', name: 'Qwen', provider: 'llama', price: 'free', state: '✓' },
    ],
  })
  const { root, refresh } = mount([studio])
  await refresh()
  expect(root.querySelector('#model-value')!.textContent).toBe('Qwen · Studio · Relayed')
  // Two models of one name on two computers are two rows, told apart by where they run.
  expect([...root.querySelectorAll('#model-drop .opt .meta')].map((meta) => meta.textContent)).toEqual(['per request', 'Studio · Relayed', 'free'])
})

test('rail recent: the open chat is marked, named in full on hover, and dated from its timestamp', async () => {
  core({
    chats: [
      { id: '2', title: 'A long question about the printer in the hall', turns: '4', when: 'core text', state: '● open', at: Date.now() },
      { id: '1', title: 'hey', turns: '1', when: 'older text', state: '' },
    ],
  })
  const { root, heading, refresh } = mount()
  await refresh()
  const rows = [...root.querySelectorAll<HTMLElement>('#recent .rail-row')]
  expect(rows).toHaveLength(2)
  expect(rows[0]!.classList.contains('on')).toBe(true)
  expect(rows[0]!.getAttribute('aria-current')).toBe('true')
  expect(rows[0]!.title).toBe('A long question about the printer in the hall')
  expect(rows[0]!.querySelector('.when')!.textContent).not.toBe('core text')
  expect(rows[1]!.hasAttribute('aria-current')).toBe(false)
  expect(rows[1]!.querySelector('.when')!.textContent).toBe('older text')
  expect(heading.textContent).toBe('A long question about the printer in the hall')
})

test('rail recent: Show more adds ten, and the rest are in Activity', async () => {
  core({ chats: Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `chat ${String(i)}`, turns: '1', when: '', state: '' })) })
  const { root, openControl, refresh } = mount()
  await refresh()
  const more = root.querySelector<HTMLButtonElement>('#recent-more')!
  const all = root.querySelector<HTMLButtonElement>('#recent-all')!
  expect(root.querySelectorAll('#recent .rail-row')).toHaveLength(3)
  expect(more.textContent).toBe(`Show ${String(MORE)} more`)
  expect(all.hidden).toBe(true)
  more.click()
  expect(root.querySelectorAll('#recent .rail-row')).toHaveLength(3 + MORE)
  expect(more.textContent).toBe('Show fewer')
  expect(all.hidden).toBe(false)
  all.click()
  expect(openControl).toHaveBeenCalledWith('chats')
  more.click()
  expect(root.querySelectorAll('#recent .rail-row')).toHaveLength(3)
})

test('rail model: a pick closes the list and says what core said about it', async () => {
  const state = core({
    models: [
      { id: 'kilo\na', name: 'Model A', provider: 'kilo', price: 'free', state: '★ recommended' },
      { id: 'kilo\nb', name: 'Model B', provider: 'kilo', price: 'free', state: '✓ · tools' },
    ],
    answers: { '/api/action': { ok: false, said: 'Model B comes from kilo, which has no key yet.' } },
  })
  const { root, refresh } = mount()
  await refresh()
  const row = root.querySelector<HTMLButtonElement>('#model-row')!
  const drop = root.querySelector<HTMLElement>('#model-drop')!
  const said = root.querySelector<HTMLElement>('#model-said')!
  row.click()
  expect(drop.hidden).toBe(false)
  const options = [...drop.querySelectorAll<HTMLButtonElement>('.opt')]
  expect(options.map((one) => one.textContent)).toEqual(['Automaticper request', '★Model Afree', 'Model Bfree'])
  options[2]!.click()
  expect(drop.hidden).toBe(true)
  await flush()
  expect(state.sent.some((one) => one.body.key === 'use_model' && one.body.row === 'kilo\nb')).toBe(true)
  expect(said.hidden).toBe(false)
  expect(said.textContent).toBe('Model B comes from kilo, which has no key yet.')
  expect(said.classList.contains('refused')).toBe(true)
})

test('rail model: a click outside closes the list, and Escape closes it without reaching the window', async () => {
  core({ models: [{ id: 'kilo\na', name: 'Model A', provider: 'kilo', price: 'free', state: '' }] })
  const { root, refresh } = mount()
  await refresh()
  const row = root.querySelector<HTMLButtonElement>('#model-row')!
  const drop = root.querySelector<HTMLElement>('#model-drop')!
  row.click()
  document.querySelector<HTMLElement>('#chat-title')!.click()
  expect(drop.hidden).toBe(true)

  const hides = vi.fn()
  document.addEventListener('keydown', hides)
  row.click()
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(drop.hidden).toBe(true)
  expect(hides).not.toHaveBeenCalled()
  // With the list closed, Escape is the window's again.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(hides).toHaveBeenCalledTimes(1)
  document.removeEventListener('keydown', hides)
})

test('rail model: with no provider, the way out is a button to Settings, where keys live', async () => {
  core()
  const { root, openSettings, refresh } = mount()
  await refresh()
  root.querySelector<HTMLButtonElement>('#model-row')!.click()
  const button = [...root.querySelectorAll<HTMLButtonElement>('#model-drop button')].find((one) => one.textContent === 'Add a key in Settings')
  expect(button).toBeDefined()
  button!.click()
  expect(openSettings).toHaveBeenCalledWith('models')
})

test('rail plugins: a switch that did not take says so', async () => {
  core({
    panes: [{ id: 'memory', name: 'Memory', enabled: false, running: false }],
    answers: { '/api/plugin': { ok: false, said: 'There is no plugin called “memory”.' } },
  })
  const { root, refresh } = mount()
  await refresh()
  const row = root.querySelector<HTMLElement>('#rail-plugins .rail-row')!
  expect(row.title).toBe('Off stops it. Its data is kept.')
  const box = row.querySelector<HTMLInputElement>('input')!
  box.checked = true
  box.dispatchEvent(new Event('change'))
  await flush()
  const said = root.querySelector<HTMLElement>('#rail-plugins .rail-said')!
  expect(said.hidden).toBe(false)
  expect(said.textContent).toBe('There is no plugin called “memory”.')
  expect(root.querySelector<HTMLInputElement>('#rail-plugins input')!.checked).toBe(false)
})

test('rail model: the chosen one is current, and the star is named for what it means', async () => {
  core({
    models: [
      { id: 'kilo\na', name: 'Model A', provider: 'kilo', price: 'free', state: '★ recommended' },
      { id: 'kilo\nb', name: 'Model B', provider: 'kilo', price: 'free', state: '◆ chosen' },
    ],
  })
  const { root, refresh } = mount()
  await refresh()
  const options = [...root.querySelectorAll<HTMLButtonElement>('#model-drop .opt')]
  expect(options.map((one) => one.getAttribute('aria-current'))).toEqual([null, null, 'true'])
  expect(options[1]!.querySelector('.star')!.getAttribute('aria-label')).toBe("Automatic's pick")
})

test('rail tabs: arrow keys, Home and End choose a tab and take focus with them', () => {
  core()
  const { root } = mount()
  const setup = root.querySelector<HTMLButtonElement>('#tab-setup')!
  const plugins = root.querySelector<HTMLButtonElement>('#tab-plugins')!
  expect(setup.getAttribute('aria-controls')).toBe('rail-setup')
  setup.focus()
  setup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  expect(plugins.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(plugins)
  expect(root.querySelector<HTMLElement>('#rail-plugins')!.hidden).toBe(false)
  expect([setup.tabIndex, plugins.tabIndex]).toEqual([-1, 0])
  plugins.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  expect(document.activeElement).toBe(setup)
  expect(root.querySelector<HTMLElement>('#rail-setup')!.hidden).toBe(false)
})
