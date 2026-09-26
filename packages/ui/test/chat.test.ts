// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { grow, moveIn, nearBottom, shownTurn, slashMatches, usedTools, wordsOf } from '../src/chat.js'

/**
 * The small rules of the conversation on screen: what an old turn shows when it is drawn again,
 * when the log follows new words, which commands the `/` menu lists, and how the box you type
 * in grows. Each of these was a complaint from somebody using it.
 */

const ui = join(import.meta.dirname, '..')

// ---- old turns, drawn again ------------------------------------------------------------------

test('a question with a document shows what was typed, and the document by name', () => {
  const content = 'What is the rent?\n\n[attached: lease.pdf — PDF, 3 pages]\nThe rent is £900.\n[end of lease.pdf]'
  // With `typed`, which every turn with attachments has since core started keeping it.
  expect(shownTurn({ role: 'user', content, typed: 'What is the rent?' })).toEqual({
    text: 'What is the rent?',
    attached: [{ name: 'lease.pdf', picture: false }],
    tools: 0,
    stopped: false,
  })
  // An older turn, stored before `typed`: cut where the first document starts.
  expect(shownTurn({ role: 'user', content }).text).toBe('What is the rent?')
  // A file that was not read is still named.
  expect(shownTurn({ role: 'user', content: '[attached: dark.heic — not read. Nothing reads these.]' })).toMatchObject({
    text: '',
    attached: [{ name: 'dark.heic', picture: false }],
  })
})

test('a question with a picture shows its words and a picture chip, never [object Object]', () => {
  const shown = shownTurn({
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this?' },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
    ],
  })
  expect(shown.text).toBe('What is in this?')
  expect(shown.text).not.toContain('[object')
  expect(shown.attached).toEqual([{ name: 'picture', picture: true }])
})

test('a turn that only ran tools has no words and counts its tools', () => {
  const shown = shownTurn({ role: 'assistant', content: '', calls: [{ id: '1' }, { id: '2' }] })
  expect(shown.text).toBe('')
  expect(shown.tools).toBe(2)
  expect(usedTools(1)).toBe('Used 1 tool')
  expect(usedTools(3)).toBe('Used 3 tools')
})

test('a stopped answer says so only when core marked it stopped', () => {
  expect(shownTurn({ role: 'assistant', content: 'Half an', stopped: true }).stopped).toBe(true)
  // Read defensively: anything but `true` is not a stop.
  expect(shownTurn({ role: 'assistant', content: 'Half an', stopped: 'yes' }).stopped).toBe(false)
  expect(shownTurn({ role: 'assistant', content: 'Whole.' }).stopped).toBe(false)
})

// ---- following new words ---------------------------------------------------------------------

test('the log follows new words only for somebody reading the bottom', () => {
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true)
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true)
  // Scrolled up to reread something: left where they are.
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 400 })).toBe(false)
})

// ---- the slash menu --------------------------------------------------------------------------

const known = Array.from({ length: 11 }, (_, at) => ({ name: `cmd${String(at)}`, summary: '' })).concat([
  { name: 'new', summary: '', alias: 'n' } as { name: string; summary: string; alias?: string },
])

test('the menu lists every command, not the first eight, and narrows as you type', () => {
  expect(slashMatches(known, '/')).toHaveLength(12)
  expect(slashMatches(known, '/cmd1').map((c) => c.name)).toEqual(['cmd1', 'cmd10'])
  expect(slashMatches(known, '/NE').map((c) => c.name)).toEqual(['new'])
  // A short name finds its command too, and arguments after the word do not hide it.
  expect(slashMatches(known, '/n').map((c) => c.name)).toEqual(['new'])
  expect(slashMatches(known, '/new something').map((c) => c.name)).toEqual(['new'])
  expect(slashMatches(known, 'hello')).toEqual([])
})

test('↑ and ↓ go round the list at either end', () => {
  expect(moveIn(3, 0, true)).toBe(1)
  expect(moveIn(3, 2, true)).toBe(0)
  expect(moveIn(3, 0, false)).toBe(2)
  expect(moveIn(0, 0, true)).toBe(0)
})

// ---- the box you type in, and an answer's words ------------------------------------------------

test('the box grows with what is typed, up to six lines, then scrolls', () => {
  const box = document.createElement('textarea')
  box.style.lineHeight = '20px'
  box.style.padding = '0'
  box.style.border = '0'
  document.body.append(box)
  const tall = (px: number): void => {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => px })
  }
  tall(40)
  grow(box)
  expect(box.style.height).toBe('40px')
  expect(box.style.overflowY).toBe('hidden')
  tall(400)
  grow(box)
  expect(box.style.height).toBe('120px')
  expect(box.style.overflowY).toBe('auto')
  box.remove()
})

test('Copy takes her words, not the buttons and lines drawn into the answer', () => {
  const answer = document.createElement('div')
  const line = document.createElement('p')
  line.textContent = 'Another model is answering.'
  const row = document.createElement('div')
  row.textContent = 'Copy Bad answer'
  answer.append(line, document.createTextNode('The answer is 42.'), row)
  expect(wordsOf(answer)).toBe('The answer is 42.')
})

// ---- the markup the shell reaches for --------------------------------------------------------

test('Attach is a real button a keyboard reaches, not a label around a hidden input', () => {
  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  expect(html).toMatch(/<button id="attach" type="button"/)
  expect(html).not.toMatch(/<label id="attach"/)
  const main = readFileSync(join(ui, 'src', 'main.ts'), 'utf8')
  expect(main).toContain("querySelector<HTMLButtonElement>('#attach')!.addEventListener('click', () => filePicker.click())")
})

test('the new classes the chat draws have rules in the sheet', () => {
  const css = readFileSync(join(ui, 'app.css'), 'utf8')
  for (const rule of ['.turn.reply', '.tools-used', '.stopped-mark', '#new-words', '#menu li.on']) expect(css).toContain(rule)
})
