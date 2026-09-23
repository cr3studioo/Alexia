// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test } from 'vitest'
import { chunk, LIMIT, send, sendDocument, sendDraft, sendRich, sendRichDraft, sendVoice, setMyCommands, updates } from '../api.js'

// The one piece of real logic in this plugin that is not a network call: Telegram refuses
// a message over 4096 characters, and a long answer arriving as an API error the user
// never sees is the failure that actually happens.

test('short messages are one message', () => {
  expect(chunk('hello')).toEqual(['hello'])
})

test('a long answer is split, and nothing is lost', () => {
  const text = `${'a'.repeat(5000)}\n${'b'.repeat(3000)}`
  const parts = chunk(text)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(LIMIT)
  expect(parts.join('')).toBe(text)
})

test('it breaks on a line when there is one within reach', () => {
  // A cut in the middle of a word reads as a bug. One at the end of a line does not.
  const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
  const parts = chunk(text)
  expect(parts[0]).toBe('a'.repeat(3000))
  expect(parts[1]).toBe(`\n${'b'.repeat(3000)}`)
})

test('a message of exactly the limit is not split', () => {
  expect(chunk('c'.repeat(LIMIT))).toHaveLength(1)
})

// The limit is an argument now, because a rich message takes 32768 rather than 4096 — and
// the whole point of that is the answer arriving as one bubble rather than eight (D194).

test('a bigger limit leaves a long answer whole', () => {
  const text = 'd'.repeat(20000)
  expect(chunk(text, 32768)).toEqual([text])
  expect(chunk(text).length).toBeGreaterThan(1)
})

test('a smaller limit splits sooner, and still loses nothing', () => {
  const text = `${'e'.repeat(60)}\n${'f'.repeat(60)}`
  const parts = chunk(text, 100)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(100)
  expect(parts.join('')).toBe(text)
})

/**
 * What actually goes on the wire (D194).
 *
 * Threading a reply is one field, formatting one is another, and both are the kind of thing
 * that looks right in a diff and silently does nothing — Telegram ignores a field it does not
 * recognise, so a misspelled `reply_parameters` is a reply that quietly stops quoting. A
 * stubbed `fetch` is the only way to see the body from here, since the alternative is a bot
 * token and somebody's phone.
 */
let sent
let held

beforeEach(() => {
  sent = []
  held = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
})

afterEach(() => {
  globalThis.fetch = held
})

/** The JSON body of the one request that was made. */
const body = () => JSON.parse(sent[0].init.body)

test('send puts extra fields on the message, beside the text', async () => {
  await send('T', 42, 'hello', undefined, undefined, {
    reply_parameters: { message_id: 7, allow_sending_without_reply: true },
  })
  expect(sent[0].url).toContain('/sendMessage')
  expect(body()).toEqual({
    chat_id: 42,
    text: 'hello',
    disable_web_page_preview: true,
    reply_parameters: { message_id: 7, allow_sending_without_reply: true },
  })
})

test('send with no extra is the message it always was', async () => {
  await send('T', 42, 'hello')
  expect(body()).toEqual({ chat_id: 42, text: 'hello', disable_web_page_preview: true })
})

test('send keeps its buttons when there is extra as well', async () => {
  await send('T', 42, 'pick', undefined, [{ label: 'Yes', data: 'a1' }], { reply_parameters: { message_id: 7 } })
  expect(body().reply_markup).toEqual({ inline_keyboard: [[{ text: 'Yes', callback_data: 'a1' }]] })
  expect(body().reply_parameters).toEqual({ message_id: 7 })
})

test('sendRich wraps the markdown and carries extra', async () => {
  await sendRich('T', 42, '**bold**', { reply_parameters: { message_id: 7, allow_sending_without_reply: true } })
  expect(sent[0].url).toContain('/sendRichMessage')
  expect(body()).toEqual({
    chat_id: 42,
    rich_message: { markdown: '**bold**' },
    reply_parameters: { message_id: 7, allow_sending_without_reply: true },
  })
})

test('an upload carries extra as a JSON form field', async () => {
  // A multipart body has no place for an object, so it goes in as its own JSON text —
  // which is what Telegram documents and the one difference between the two kinds of send.
  await sendDocument('T', 42, Buffer.from('bytes'), 'report.pdf', undefined, undefined, {
    reply_parameters: { message_id: 7, allow_sending_without_reply: true },
  })
  const form = sent[0].init.body
  expect(form.get('chat_id')).toBe('42')
  expect(JSON.parse(form.get('reply_parameters'))).toEqual({ message_id: 7, allow_sending_without_reply: true })
})

test('a voice note carries extra the same way, and without it is unchanged', async () => {
  await sendVoice('T', 42, Buffer.from('ogg'), undefined, { reply_parameters: { message_id: 7 } })
  expect(JSON.parse(sent[0].init.body.get('reply_parameters'))).toEqual({ message_id: 7 })
  await sendVoice('T', 42, Buffer.from('ogg'))
  expect(sent[1].init.body.get('reply_parameters')).toBeNull()
})

/**
 * What Phase 3 adds to the wire (D195).
 *
 * A draft that names the wrong field is a draft that never appears, and a `setMyCommands`
 * with the wrong scope is a menu offered to every group this bot is in. Both fail silently
 * against a real bot — Telegram answers `ok: true` to a body it understood and this end
 * cannot tell the difference from here — so the body is the thing worth pinning down.
 */

test('an empty draft is the "Thinking…" one, and it carries the Stop button', async () => {
  await sendDraft('T', 42, 12345, '', true)
  expect(sent[0].url).toContain('/sendMessageDraft')
  expect(body()).toEqual({ chat_id: 42, draft_id: 12345, text: '', can_stop: true })
})

test('a draft without can_stop does not send the field at all', async () => {
  await sendDraft('T', 42, 12345, 'half an answer')
  expect(body()).toEqual({ chat_id: 42, draft_id: 12345, text: 'half an answer' })
})

test('a rich draft wraps its markdown the same way a rich message does', async () => {
  await sendRichDraft('T', 42, 12345, '**half** an answer', true)
  expect(sent[0].url).toContain('/sendRichMessageDraft')
  expect(body()).toEqual({
    chat_id: 42,
    draft_id: 12345,
    rich_message: { markdown: '**half** an answer' },
    can_stop: true,
  })
})

test('the command menu is set for private chats, not for every chat this bot is in', async () => {
  await setMyCommands('T', [{ command: 'help', description: 'What you can type' }])
  expect(sent[0].url).toContain('/setMyCommands')
  expect(body()).toEqual({
    commands: [{ command: 'help', description: 'What you can type' }],
    scope: { type: 'all_private_chats' },
  })
})

test('the Stop button is asked for, or Telegram never sends the press', async () => {
  await updates('T', 7, 50)
  expect(body().allowed_updates).toContain('stopped_message_generation')
  expect(body().allowed_updates).toContain('message')
  expect(body().allowed_updates).toContain('callback_query')
})
