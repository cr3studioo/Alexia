// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { widget, type Rendered, type WidgetHost } from '../src/widgets.js'

/**
 * A plugin's own settings widgets: the hint a password box dropped, the number a refusal left
 * in the box, and the button that forgot everything in one press.
 */

function fakeHost(answers: Record<string, unknown> = {}): WidgetHost & { sent: { path: string; body: Record<string, unknown> }[] } {
  const sent: { path: string; body: Record<string, unknown> }[] = []
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  return {
    plugin: 'demo',
    screen: 'settings',
    sent,
    send: (path: string, body: unknown) => {
      sent.push({ path, body: body as Record<string, unknown> })
      return Promise.resolve((answers[path] ?? { ok: true }) as Record<string, unknown>)
    },
    fresh: () => Promise.resolve([] as Rendered[]),
    root: () => root,
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

test('a password box shows its author’s hint as well as where core keeps it', () => {
  const field = widget(fakeHost(), {
    type: 'password',
    key: 'token',
    label: 'Bot token',
    hint: 'From @BotFather on Telegram.',
    stored: 'Kept in the macOS Keychain.',
  })
  const hints = [...field.querySelectorAll('.hint')].map((one) => one.textContent)
  expect(hints).toEqual(['From @BotFather on Telegram.', 'Kept in the macOS Keychain.'])
})

test('a refused number goes back to what is really saved', async () => {
  const host = fakeHost({ '/api/settings': { ok: false, why: 'At most 600.' } })
  const field = widget(host, { type: 'number', key: 'every', label: 'Every', value: 60, min: 1, max: 600 })
  const input = field.querySelector<HTMLInputElement>('input')!
  input.value = '900'
  input.dispatchEvent(new Event('change'))
  await flush()
  expect(input.value).toBe('60')
  expect(field.querySelector('.error')?.textContent).toBe('At most 600.')
})

test('an action with a confirm takes two presses, and the second is not the tail of a double-click', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const host = fakeHost({ '/api/action': { ok: true, said: 'Forgot 12 things.' } })
  const field = widget(host, {
    type: 'action',
    key: 'forget_all',
    label: 'Forget everything',
    tool: 'forget_all',
    confirm: 'Press again to forget everything',
  })
  const button = field.querySelector('button')!
  button.click()
  expect(button.textContent).toBe('Press again to forget everything')
  button.click()
  await flush()
  expect(host.sent.filter((one) => one.path === '/api/action')).toHaveLength(0)

  // Left alone, it disarms.
  vi.advanceTimersByTime(6000)
  expect(button.textContent).toBe('Forget everything')

  button.click()
  vi.advanceTimersByTime(1500)
  button.click()
  await flush()
  expect(host.sent.filter((one) => one.path === '/api/action')).toEqual([
    { path: '/api/action', body: { plugin: 'demo', key: 'forget_all', confirm: true } },
  ])
})

test('an action without a confirm is still one press', async () => {
  const host = fakeHost()
  const field = widget(host, { type: 'action', key: 'sort_now', label: 'Sort through it now', tool: 'sort_now' })
  field.querySelector('button')!.click()
  await flush()
  expect(host.sent.filter((one) => one.path === '/api/action')).toHaveLength(1)
})
