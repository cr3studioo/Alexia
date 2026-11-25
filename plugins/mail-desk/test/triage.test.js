// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { addressOf, BATCH, importantList, nameOf, parseBatch, ruleClass, triage } from '../triage.js'

const msg = (over) => ({
  id: 'm1',
  threadId: 't1',
  from: 'Ms Novak <novak@zs-example.cz>',
  subject: 'Trip',
  snippet: 'hello',
  labels: [],
  ...over,
})

test('important_sender_is_act', () => {
  const important = 'zs-example.cz, @mum.example, boss@work.example'
  expect(ruleClass(msg(), '', { important })).toMatchObject({ class: 'act' })
  expect(ruleClass(msg({ from: 'a@mail.zs-example.cz' }), '', { important })).toMatchObject({ class: 'act' })
  expect(ruleClass(msg({ from: 'Boss <Boss@Work.example>' }), '', { important })).toMatchObject({ class: 'act' })
  // A lookalike domain, and the right user at another domain, are not on the list.
  expect(ruleClass(msg({ from: 'x@evilzs-example.cz' }), '', { important })).toBeUndefined()
  expect(ruleClass(msg({ from: 'boss@other.example' }), '', { important })).toBeUndefined()
  expect(importantList(' a.cz ,\n@b.cz;c@d.cz')).toEqual(['a.cz', 'b.cz', 'c@d.cz'])
})

test('reply_in_own_thread', () => {
  const ownThreads = new Set(['t1'])
  expect(ruleClass(msg({ from: 'friend@x.example' }), '', { ownThreads })).toMatchObject({ class: 'reply' })
  expect(ruleClass(msg({ from: 'friend@x.example', threadId: 't9' }), '', { ownThreads })).toBeUndefined()
})

test('list_unsubscribe_is_noise', () => {
  const from = 'news@shop.example'
  expect(ruleClass(msg({ from, listUnsubscribe: '<mailto:u@shop.example>' }), '', {})).toMatchObject({ class: 'noise' })
  expect(ruleClass(msg({ from, headers: { 'List-Unsubscribe': '<x>' } }), '', {})).toMatchObject({ class: 'noise' })
  expect(ruleClass(msg({ from }), 'List-Unsubscribe: <https://shop.example/u>\nHi', {})).toMatchObject({ class: 'noise' })
  expect(ruleClass(msg({ from, labels: ['CATEGORY_PROMOTIONS'] }), '', {})).toMatchObject({ class: 'noise' })
  // Important beats newsletter: the owner listed it.
  expect(ruleClass(msg({ from, listUnsubscribe: 'x' }), '', { important: 'shop.example' })).toMatchObject({ class: 'act' })
})

test('model_sees_only_500_chars', async () => {
  const body = 'A'.repeat(500) + 'SECRETTAIL' + 'C'.repeat(1500)
  const prompts = []
  const sample = async (text) => {
    prompts.push(text)
    return '[{"id":"m1","class":"wait","reason":"ok"}]'
  }
  const sorted = await triage([{ message: msg({ from: 'a@b.example' }), text: body }], {}, sample)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('A'.repeat(500))
  expect(prompts[0]).not.toContain('SECRETTAIL')
  expect(prompts[0]).not.toContain('C')
  expect(sorted.get('m1')).toEqual({ class: 'wait', reason: 'ok' })
})

test('twenty per call, rules skip the model, a failed call leaves the batch unsorted', async () => {
  const entries = Array.from({ length: 45 }, (_, i) => ({
    message: msg({ id: `m${i}`, threadId: `t${i}`, from: 'p@q.example' }),
    text: 'x',
  }))
  entries.push({ message: msg({ id: 'imp', from: 'a@school.example' }), text: '' })
  let calls = 0
  const sample = async (text) => {
    calls += 1
    const ids = [...text.matchAll(/^id: (\S+)$/gm)].map((m) => m[1])
    expect(ids.length).toBeLessThanOrEqual(BATCH)
    if (calls === 2) throw new Error('model down')
    const reason = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    return JSON.stringify(ids.map((id) => ({ id, class: 'noise', reason })))
  }
  const sorted = await triage(entries, { important: 'school.example' }, sample)
  expect(calls).toBe(3)
  expect(sorted.get('imp').class).toBe('act')
  expect(sorted.has('m0')).toBe(true)
  expect(sorted.has('m20')).toBe(false) // the failed batch is tried again later
  expect(sorted.has('m44')).toBe(true)
  expect(sorted.get('m0').reason.split(' ')).toHaveLength(15)
})

test('parseBatch ignores unknown ids, bad classes and prose', () => {
  const answer = 'Sure! [{"id":"a","class":"act","reason":"r"},{"id":"zzz","class":"act"},{"id":"b","class":"urgent"}] done'
  expect([...parseBatch(answer, ['a', 'b']).keys()]).toEqual(['a'])
  expect(parseBatch('no json', ['a']).size).toBe(0)
})

test('sender helpers', () => {
  expect(addressOf('"A B" <A.B@X.example>')).toBe('a.b@x.example')
  expect(nameOf('"A B" <a@x.example>')).toBe('A B')
  expect(nameOf('a@x.example')).toBe('a@x.example')
})
