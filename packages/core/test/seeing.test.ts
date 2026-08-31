// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { carries, imagesIn, textOf, withText, type Message } from '../src/store.js'
import { redact } from '../src/redact.js'
import { size } from '../src/trim.js'

/**
 * **A picture on the wire** (§5.1, Q4) — the change that made `document.describe` possible
 * and that everything else about images was blocked on.
 *
 * `Message.content` was a `string`. Not `string | Part[]`: a string at the store, a string
 * through `trim.ts`, a string at the provider boundary. So Alexia could not send an image to
 * *any* model — not a weak one, not a strong one, not a local one the catalog already
 * labelled as taking images — and extraction-to-text was not the fallback for weak models,
 * it was the only thing the wire could carry.
 *
 * What is tested here is the three places that had to stop assuming, and each of them is a
 * place where getting it wrong is silent: text is read out of a turn that is no longer a
 * string, a picture survives being rewritten, and a picture is *weighed* rather than counted
 * as the million characters its base64 happens to be.
 */

const picture = (url = 'data:image/png;base64,iVBORw0KGgo='): Message => ({
  role: 'user',
  content: [
    { type: 'text', text: 'what is this' },
    { type: 'image', url },
  ],
})

test('the words come out of a turn whichever shape it is in', () => {
  expect(textOf({ content: 'just words' })).toBe('just words')
  expect(textOf(picture())).toBe('what is this')
  // Several text parts read as the paragraphs they are, not as one run-on line.
  expect(textOf({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
})

test('a string stays a string, because that is every turn anybody has ever sent', () => {
  // The migration that is deliberately not happening. Rewriting every stored turn to
  // `[{type:'text'}]` would touch everybody's database to buy nothing, and a string is
  // still what a turn made only of words is.
  const plain: Message = { role: 'user', content: 'hello' }
  expect(withText(plain, 'goodbye').content).toBe('goodbye')
  expect(imagesIn(plain)).toEqual([])
})

test('rewriting what was said does not throw the picture away', () => {
  // The bug this is here for is silent and would have been shipped: `{ ...m, content: text }`
  // is the obvious way to rewrite a message and it **deletes the attachment**, on the two
  // paths that rewrite every outgoing message — redaction and trimming.
  const rewritten = withText(picture(), '[redacted]')
  expect(textOf(rewritten)).toBe('[redacted]')
  expect(imagesIn(rewritten)).toHaveLength(1)
})

test('redaction reads and rewrites the words, and the picture goes through untouched', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo='
  const { messages, kinds } = redact([
    { role: 'user', content: [{ type: 'text', text: 'my key is sk-abcdefghijklmnop1234' }, { type: 'image', url }] },
  ])
  expect(kinds).toContain('api key')
  expect(textOf(messages[0]!)).toContain('[redacted]')
  expect(textOf(messages[0]!)).not.toContain('sk-abcdefghijklmnop1234')
  // **What this cannot do, asserted rather than assumed.** Every rule in `redact.ts` is a
  // regex over text; a credential photographed rather than typed goes past all of them. The
  // picture is unchanged here because nothing inspected it, and that is a real widening of
  // §5.4 written down where somebody will meet it.
  expect(imagesIn(messages[0]!)[0]?.url).toBe(url)
})

test('a picture is weighed, not counted as the million characters it is', () => {
  // The trap: a `data:` URL for a one-megabyte photograph is about 1.4 million characters and
  // costs a model roughly fifteen hundred tokens. Counting the string makes `fits()` refuse
  // every model on earth; counting it as nothing makes `fits()` promise a window the request
  // then blows through, and the failure arrives as somebody else's 400 at step nine.
  const huge = `data:image/png;base64,${'A'.repeat(1_400_000)}`
  const weighed = size([picture(huge)])

  expect(weighed).toBeLessThan(100_000)
  // And not free either: a picture that weighed nothing would let four of them into a window
  // that holds one.
  expect(weighed).toBeGreaterThan(1_000)
  // A conversation of words is unchanged, which is nearly every conversation.
  expect(size([{ role: 'user', content: 'hello' }])).toBe(5)
})

test('a conversation says whether it is carrying something words cannot stand in for', () => {
  // What the router's `modality` filter reads. It has been built since Q5 with no caller —
  // this is what finally sets it.
  const words: Message[] = [{ role: 'user', content: 'hello' }]
  expect(carries(words)).toEqual([])
  expect(carries([picture()])).toEqual(['image'])
  // Asked of the whole conversation rather than the last turn, because history is re-sent
  // whole: a model that cannot see is no use on turn nine of a conversation whose turn one
  // was a photograph.
  const later: Message[] = [picture(), { role: 'assistant', content: 'a chart' }, { role: 'user', content: 'and now' }]
  expect(carries(later)).toEqual(['image'])
})
