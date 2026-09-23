// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { clean, DEFAULT_FILLER, worthSorting } from '../prefilter.js'

/**
 * The prefilter: what the sorting pass is never shown. The examples are the kind of thing that
 * actually sits in the buffer — people nudging a slow answer, testing whether it is alive,
 * pasting output — next to the sentences that must still get through.
 */

const buffered = (said, answered = 'Done.') => `They said: ${said}\nAlexia answered: ${answered}`

test('filler is dropped, whatever the case and punctuation', () => {
  for (const said of ['.', 'ok', 'OK.', 'okay!', 'continue', 'why?', 'test', 'again', 'hey', 'hey?', 'Hey!!', 'you good?', 'you alive??', 'yes', 'no.', 'thanks!']) {
    expect(worthSorting(buffered(said)), said).toBe(false)
  }
  for (const said of ['jo', 'Ne.', 'díky!', 'pokračuj', 'proč?', 'ano']) {
    expect(worthSorting(buffered(said)), said).toBe(false)
  }
})

test('fewer than three real words is dropped, and a contraction is one word', () => {
  expect(worthSorting(buffered('ok thanks'))).toBe(false)
  expect(worthSorting(buffered('— :)'))).toBe(false)
  expect(worthSorting(buffered(''))).toBe(false)
  // The price, written down: a name said in two words does not get through. `remember` does.
  expect(worthSorting(buffered("I'm Vaclav"))).toBe(false)
})

test('a sentence that could hold a fact gets through', () => {
  expect(worthSorting(buffered('sort my downloads — I am doing a PhD at CTU FEL'))).toBe(true)
  expect(worthSorting(buffered('Jmenuju se Václav a bydlím v Praze.'))).toBe(true)
  expect(worthSorting(buffered('my dog is called Bruno'))).toBe(true)
  // The known limitation: three words and no fact. Word count and a list, nothing smarter.
  expect(worthSorting(buffered('who am i?'))).toBe(true)
})

test('only what the user said is judged, never the answer', () => {
  // An answer is long whatever it was asked. Counting it would pass everything.
  expect(worthSorting(buffered('continue', 'Here is the rest of the report, in four long paragraphs…'))).toBe(false)
})

test('the exchange can be handed over as the buffer text, the buffer row, or the fresh exchange', () => {
  expect(worthSorting({ said: 'ok', answered: 'A long answer about many things.' })).toBe(false)
  expect(worthSorting({ said: 'I teach at CTU on Tuesdays' })).toBe(true)
  expect(worthSorting({ rowid: 4, text: buffered('you alive?') })).toBe(false)
  expect(worthSorting('I teach at CTU on Tuesdays')).toBe(true)
})

test('what is not somebody talking does not count toward the words', () => {
  const pasted = buffered('```\nTraceback (most recent call last):\n  File "x.py", line 3, in <module>\n```\nagain')
  expect(worthSorting(pasted)).toBe(false)
  expect(worthSorting(buffered('[attached: Screenshot 2026-09-20 at 10.14.png] ok'))).toBe(false)
  expect(worthSorting(buffered(`data:image/png;base64,${'iVBORw0KGgo'.repeat(20)} thanks`))).toBe(false)
})

test('the filler list is a parameter, because it is going to be a setting', () => {
  expect(worthSorting(buffered('what do you think'))).toBe(true)
  expect(worthSorting(buffered('what do you think?'), { filler: [...DEFAULT_FILLER, 'what do you think'] })).toBe(false)
  // An empty list still has the word count behind it.
  expect(worthSorting(buffered('ok'), { filler: [] })).toBe(false)
})

test('clean takes out code, attachments, data URLs and blobs, and keeps the talking', () => {
  expect(clean('look at this ```js\nconst a = 1\n``` it breaks')).toBe('look at this it breaks')
  expect(clean('cut off ```\nstill code')).toBe('cut off')
  expect(clean('[attached: report.pdf] summarise it')).toBe('summarise it')
  expect(clean('see data:image/jpeg;base64,/9j/4AAQSkZJRg== here')).toBe('see here')
  expect(clean(`token ${'A'.repeat(80)} there`)).toBe('token there')
  const json = `here is the output\n{\n${'  "key": "value",\n'.repeat(20)}}\nwhat does it mean`
  expect(clean(json)).toBe('here is the output what does it mean')
  expect(clean('  several   spaces\n\nand lines  ')).toBe('several spaces and lines')
})
