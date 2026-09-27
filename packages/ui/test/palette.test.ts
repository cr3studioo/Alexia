// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { EMPTY_HINT, localMatches, mountPalette, shortcut, type Hit, type Local } from '../src/palette.js'

/**
 * The ⌘K palette, against a core that answers `/api/search` when the test says so. The markup
 * is index.html's own, so a test cannot pass against ids the page no longer has.
 */

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const markup = /<div id="palette" hidden>[\s\S]*?<\/ul>\s*<\/div>\s*<\/div>/.exec(html)![0]
const find = /<button id="find"[\s\S]*?<\/button>/.exec(html)![0]

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** A core whose answers wait until the test lets each one go, in whatever order it likes. */
function core(): { answer: (query: string, hits: Hit[]) => void; asked: string[] } {
  const waiting = new Map<string, (hits: Hit[]) => void>()
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const query = new URL(path, 'http://x').searchParams.get('q') ?? ''
      asked.push(query)
      return new Promise((resolve) => {
        waiting.set(query, (hits) => resolve({ ok: true, json: () => Promise.resolve({ hits }) }))
      })
    }),
  )
  return {
    asked,
    answer: (query, hits) => waiting.get(query)?.(hits),
  }
}

function mount(local: Local[] = []): { go: ReturnType<typeof vi.fn>; open: () => void; input: HTMLInputElement; list: HTMLElement; box: HTMLElement } {
  document.body.innerHTML = `${find}${markup}`
  const go = vi.fn()
  const palette = mountPalette('token', go, local)
  return {
    go,
    open: palette.open,
    input: document.querySelector<HTMLInputElement>('#palette-input')!,
    list: document.querySelector<HTMLElement>('#palette-hits')!,
    box: document.querySelector<HTMLElement>('#palette')!,
  }
}

const type = (input: HTMLInputElement, text: string): void => {
  input.value = text
  input.dispatchEvent(new Event('input'))
}
const press = (input: HTMLInputElement, key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
  input.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const skill: Hit = { tab: 'skills', kind: 'skill', label: 'sorting-downloads', filter: 'sorting-downloads' }
const run: Hit = { tab: 'runs', kind: 'run', label: 'sort my downloads', filter: 'sort my downloads' }

test('picking a row hands over the row itself, with its own name as the filter — not what was typed', async () => {
  const server = core()
  const { go, open, input } = mount()
  open()
  type(input, 'sortin')
  server.answer('sortin', [skill])
  await flush()
  press(input, 'Enter')
  expect(go).toHaveBeenCalledWith(expect.objectContaining({ tab: 'skills', filter: 'sorting-downloads' }))
})

test('Enter while the answer is on its way waits for it, rather than taking a stale row', async () => {
  const server = core()
  const { go, open, input } = mount()
  open()
  type(input, 'so')
  server.answer('so', [skill, run])
  await flush()
  // Typed on, and Enter pressed before core has answered the new text.
  type(input, 'sort my')
  press(input, 'Enter')
  expect(go).not.toHaveBeenCalled()
  server.answer('sort my', [run])
  await flush()
  expect(go).toHaveBeenCalledTimes(1)
  expect(go).toHaveBeenCalledWith(expect.objectContaining({ tab: 'runs' }))
})

test('an older answer arriving late does not replace a newer one', async () => {
  const server = core()
  const { open, input, list } = mount()
  open()
  type(input, 'so')
  type(input, 'sort my')
  server.answer('sort my', [run])
  await flush()
  server.answer('so', [skill, run])
  await flush()
  expect([...list.querySelectorAll('[role="option"] b')].map((one) => one.textContent)).toEqual(['sort my downloads'])
})

test('an empty palette says what it can find, and a search with nothing says what was typed', async () => {
  const server = core()
  const { open, input, list } = mount()
  open()
  expect(list.textContent).toContain(EMPTY_HINT)
  type(input, 'zebra')
  server.answer('zebra', [])
  await flush()
  expect(list.textContent).toBe('Nothing matches “zebra”.')
})

test('a combobox over a listbox, with the active row named, and the mouse moves the highlight', async () => {
  const server = core()
  const { open, input, list } = mount()
  open()
  expect(input.getAttribute('role')).toBe('combobox')
  expect(input.getAttribute('aria-controls')).toBe('palette-hits')
  expect(list.getAttribute('role')).toBe('listbox')
  type(input, 'so')
  server.answer('so', [skill, run])
  await flush()
  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect(input.getAttribute('aria-activedescendant')).toBe('palette-hit-0')

  press(input, 'ArrowDown')
  expect(input.getAttribute('aria-activedescendant')).toBe('palette-hit-1')
  expect(list.children[1]?.getAttribute('aria-selected')).toBe('true')

  list.children[0]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  expect(list.children[0]?.classList.contains('on')).toBe(true)
  expect(list.children[1]?.classList.contains('on')).toBe(false)
  expect(input.getAttribute('aria-activedescendant')).toBe('palette-hit-0')
})

test('Tab stays inside, and closing gives focus back to where it was', () => {
  core()
  const { open, input, box } = mount()
  const button = document.querySelector<HTMLButtonElement>('#find')!
  button.focus()
  open()
  expect(document.activeElement).toBe(input)
  expect(press(input, 'Tab').defaultPrevented).toBe(true)
  press(input, 'Escape')
  expect(box.hidden).toBe(true)
  expect(document.activeElement).toBe(button)
})

test('the shell’s own entries match on the start of a word, so credit is not edit', () => {
  const layout: Local = { label: 'Edit layout', words: ['edit', 'layout', 'arrange'], run: () => undefined }
  expect(localMatches('edit', layout)).toBe(true)
  expect(localMatches('lay', layout)).toBe(true)
  expect(localMatches('edit lay', layout)).toBe(true)
  expect(localMatches('credit', layout)).toBe(false)
  expect(localMatches('dit', layout)).toBe(false)
})

test('the shortcut is written the way this keyboard writes it', () => {
  expect(shortcut(true)).toBe('⌘K')
  expect(shortcut(false)).toBe('Ctrl K')
  core()
  mount()
  expect(document.querySelector('[data-shortcut="palette"]')?.textContent).toBe(shortcut())
})
