// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createTasks } from '../tools.js'
import { placeEvent, placeFires, mentionedSince, personFires } from '../triggers.js'
import { memoryStore } from './store.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const MIN = 60_000

/** What apple-context's `current_context` says: prose, then the observation as JSON. */
const context = (type, at, place = 'Gym') => ({
  content: [{ type: 'text', text: `Observed data only. ${JSON.stringify({ place: { type, occurredAt: new Date(at).toISOString(), place } })}` }],
})

const seed = (store, ...rows) => rows.forEach((r) => store.rows.push({ rowid: store.rows.length + 1, state: 'open', list: 'tasks', due: null, place: null, person: null, ...r }))
const make = (store, caps) =>
  createTasks({
    storage: store,
    capability: async (cap, args) => {
      if (!caps[cap]) throw Object.assign(new Error('capability not available'), { code: -32050 })
      return caps[cap](args)
    },
    now: () => NOW,
  })

test('place_event_fires_place_item', async () => {
  const store = memoryStore()
  seed(store, { text: 'Ask about the locker', place: 'gym' }, { text: 'Elsewhere', place: 'Office' }, { text: 'Done one', place: 'Gym', state: 'done' })
  const tasks = make(store, { 'context.current': () => context('place.arrived', NOW - 5 * MIN) })
  const { items } = (await tasks.noticeItems({ now: NOW })).structuredContent
  expect(items).toEqual([{ key: 'tasks:1', text: 'Ask about the locker', why: "You're at gym.", urgency: 'normal' }])
  // The pure half agrees, and a departure is not an arrival.
  expect(placeEvent(context('place.arrived', NOW))).toMatchObject({ place: 'Gym' })
  expect(placeEvent(context('place.left', NOW))).toBeUndefined()
})

test('old_place_event_ignored', async () => {
  const store = memoryStore()
  seed(store, { text: 'Ask about the locker', place: 'Gym' })
  const old = make(store, { 'context.current': () => context('place.arrived', NOW - 16 * MIN) })
  expect((await old.noticeItems({ now: NOW })).structuredContent.items).toEqual([])
  const edge = make(store, { 'context.current': () => context('place.arrived', NOW - 15 * MIN) })
  expect((await edge.noticeItems({ now: NOW })).structuredContent.items).toHaveLength(1)
  expect(placeFires([{ rowid: 1, state: 'open', place: 'Gym', text: 'x' }], undefined, NOW)).toEqual([])
})

test('person_mentioned_fires', async () => {
  const store = memoryStore()
  seed(store, { text: 'Return the book', person: 'Petr' }, { text: 'Other', person: 'Jana' })
  const asked = []
  const tasks = make(store, {
    'memory.recall': (args) => {
      asked.push(args)
      const mentioned = args.about === 'Petr'
      return { content: [{ type: 'text', text: 'x' }], structuredContent: { mentions: mentioned ? [{ at: NOW - 2 * MIN }] : [{ at: NOW - 60 * MIN }] } }
    },
  })
  const { items } = (await tasks.noticeItems({ now: NOW })).structuredContent
  expect(items).toEqual([{ key: 'tasks:1', text: 'Return the book', why: "You're talking about Petr.", urgency: 'normal' }])
  expect(asked).toEqual([{ about: 'Petr', since: NOW - 10 * MIN }, { about: 'Jana', since: NOW - 10 * MIN }])
  // Plain text with no times never counts as a mention, so a memory without `since` cannot fire it.
  expect(mentionedSince({ content: [{ type: 'text', text: 'Petr likes tea.' }] }, NOW - 10 * MIN)).toBe(false)
  expect(personFires([{ rowid: 3, state: 'open', person: 'PETR', text: 't' }], ['petr'])).toHaveLength(1)
})

test('no_context_provider_place_items_wait', async () => {
  const store = memoryStore()
  seed(store, { text: 'Ask about the locker', place: 'Gym' }, { text: 'Pay rent', due: '2026-11-25' }, { text: 'Tell Petr', person: 'Petr' })
  const tasks = make(store, {})
  const { items } = (await tasks.noticeItems({ now: NOW })).structuredContent
  // Nothing threw; only the item with a day is raised, and the others wait.
  expect(items.map((i) => i.key)).toEqual(['tasks:2'])
  expect(items[0].dueAt).toBe(Date.parse('2026-11-25T18:00:00Z'))
  expect(store.rows[0].state).toBe('open')
})
