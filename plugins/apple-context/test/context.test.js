// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore } from '../store.js'
import { DAY, healthOf } from '../schema.js'
import { daily, unionSeconds, pieces } from '../summary.js'
import { receiver, Inbox, scopedFolder } from '../transport.js'
const NOW = Date.parse('2026-10-23T12:00:00Z')
const stores = [], folders = [], servers = []
function store(options = {}) { const s = new ContextStore(':memory:', { now: () => NOW, zone: 'Europe/Prague', ...options }); stores.push(s); return s }
function sample(id = 'one', changes = {}) {
  return { schemaVersion: 1, recordVersion: 1, catalogVersion: 6, canonicalId: `apple.healthkit:${id}`, id, sourceRecord: { store: 'apple.healthkit', id, type: 'HKQuantityTypeIdentifierStepCount' }, canonicalType: 'activity.steps', kind: 'quantity', type: 'HKQuantityTypeIdentifierStepCount', startDate: '2026-10-23T10:00:00Z', endDate: '2026-10-23T11:00:00Z', source: { bundleIdentifier: 'com.apple.health', productType: 'Watch7,1', name: 'SECRET DEVICE NAME' }, quantity: { value: 1000, unit: 'count' }, metadata: { instruction: 'SECRET INSTRUCTION' }, ...changes }
}
function event(id = 'evt', changes = {}) { return { schemaVersion: 1, eventId: id, deviceId: 'phone', occurredAt: new Date(NOW - 60000).toISOString(), type: 'workout.ended', payload: {}, ...changes } }
const config = { event_token: 'a'.repeat(40), health_token: 'b'.repeat(40), device_id: 'phone', places: { gym: 'Gym' } }
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const s of stores.splice(0)) s.close(); for (const f of folders.splice(0)) await rm(f, { recursive: true, force: true }) })
test('cross-transport replay and revisions commit exactly once; older records cannot resurrect deletions', () => {
  const s = store(), a = sample()
  expect(s.ingestHealth(JSON.stringify([a])).records).toBe(1)
  expect(s.ingestHealth(JSON.stringify([a])).status).toBe('duplicate')
  expect(s.ingestHealth(JSON.stringify(a) + '\n').records).toBe(0)
  s.ingestHealth(JSON.stringify([sample('one', { recordVersion: 2, quantity: { value: 2000, unit: 'count' } })]))
  expect(s.summaries()[0].value).toBe(2000)
  s.ingestHealth(JSON.stringify([sample('one', { kind: 'deletion', recordVersion: 3 })]))
  expect(s.summaries()).toEqual([])
  s.ingestHealth(JSON.stringify([sample('one', { recordVersion: 2 })]))
  expect(s.rows()).toEqual([])
})
test('a malformed batch is atomic, unsupported categories never persist', () => {
  const s = store()
  expect(() => s.ingestHealth(JSON.stringify([sample(), sample('bad', { schemaVersion: 99 })]))).toThrow()
  expect(s.rows()).toEqual([])
  s.ingestHealth(JSON.stringify([sample('medical', { type: 'HKClinicalTypeIdentifierAllergyRecord' })]))
  expect(s.rows()).toEqual([])
  expect(() => healthOf(sample('one', { canonicalId: 'apple.healthkit:other' }))).toThrow()
})
test('source selection prevents phone/watch double counting and arbitrary metadata never leaves projections', () => {
  const s = store()
  s.ingestHealth(JSON.stringify([sample(), sample('two', { source: { bundleIdentifier: 'com.apple.phone', productType: 'iPhone17,1' } })]))
  expect(s.summaries()[0].value).toBe(1000)
  const projection = JSON.stringify([s.recent({}), s.trends(), s.workouts()])
  expect(projection).not.toContain('SECRET'); expect(projection).not.toContain('com.apple')
})
test('forgetting removes summaries, blocks new versions and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-')); folders.push(dir)
  const path = join(dir, 'data.sqlite')
  const s = new ContextStore(path, { now: () => NOW, zone: 'Europe/Prague' })
  s.ingestHealth(JSON.stringify([sample()]))
  s.forget(NOW - DAY, NOW, 'steps'); s.close()
  const reopened = new ContextStore(path, { now: () => NOW, zone: 'Europe/Prague' }); stores.push(reopened)
  reopened.ingestHealth(JSON.stringify([sample('one', { recordVersion: 2 })]))
  expect(reopened.summaries()).toEqual([])
  reopened.allowReimport(); reopened.ingestHealth(JSON.stringify([sample()]))
  expect(reopened.summaries()[0].value).toBe(1000)
})
test('workout events wait for unambiguous details; old arrivals are not current presence', () => {
  const s = store()
  s.ingestEvent(event(), 'phone', {})
  expect(s.recent({}).workoutEvent.details).toBe('pending')
  const workout = sample('workout', { type: 'HKWorkoutTypeIdentifier', kind: 'workout', activityType: 37, duration: 1800, endDate: new Date(NOW - 60000).toISOString() })
  s.ingestHealth(JSON.stringify([workout])); expect(s.recent({}).workoutEvent.details).toBe('available')
  s.ingestHealth(JSON.stringify([{ ...workout, id: 'other', canonicalId: 'apple.healthkit:other', sourceRecord: { ...workout.sourceRecord, id: 'other' } }]))
  expect(s.recent({}).workoutEvent.details).toBe('ambiguous')
  s.ingestEvent(event('place', { type: 'place.arrived', occurredAt: new Date(NOW - 3 * 3600000).toISOString(), payload: { placeId: 'gym' } }), 'phone', config.places)
  expect(s.recent(config.places).place.state).toContain('unknown')
})
test('coordinates never enter projections and expire from storage after 24 hours', () => {
  const s = store()
  s.ingestEvent(event('snapshot', { type: 'location.snapshot', occurredAt: new Date(NOW - 2 * DAY).toISOString(), payload: { latitude: 50.12345, longitude: 14.12345 } }), 'phone', {})
  expect(JSON.stringify(s.events({}))).not.toContain('50.12345')
  s.maintain()
  expect(s.db.prepare('SELECT body FROM events').get().body).not.toContain('latitude')
})
test('sleep union excludes awake samples and splits real elapsed time across DST', () => {
  expect(unionSeconds([[0, 10000], [5000, 15000]])).toBe(15)
  const start = Date.parse('2026-10-24T22:00:00Z'), end = Date.parse('2026-10-25T23:00:00Z')
  const segments = pieces(start, end, 'Europe/Prague')
  expect(segments).toHaveLength(1); expect((segments[0][2] - segments[0][1]) / 3600000).toBe(25)
  const rows = [1, 3, 2].map((value, i) => ({ id: String(i), metric: 'sleep', source: 'watch', rank: 0, value, start, end, unit: 'stage' }))
  expect(daily(rows, 'Europe/Prague')[0].value).toBe(25)
})
test('receiver isolates routes and credentials; status never exposes data', async () => {
  const s = store(), server = await receiver({ store: s, settings: async () => config }); servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  expect((await fetch(base + '/api/chat')).status).toBe(404)
  expect((await fetch(base + '/v1/events', { method: 'POST', body: JSON.stringify(event()) })).status).toBe(401)
  const options = { method: 'POST', headers: { authorization: `Bearer ${config.event_token}` }, body: JSON.stringify(event()) }
  expect((await (await fetch(base + '/v1/events', options)).json()).status).toBe('accepted')
  expect((await (await fetch(base + '/v1/events', options)).json()).status).toBe('duplicate')
  expect((await fetch(base + '/v1/health/hozz', options)).status).toBe(401)
  expect((await fetch(base + '/v1/events', { ...options, body: JSON.stringify(event('bad', { deviceId: 'stranger' })) })).status).toBe(422)
})
test('inbox refuses symlink escapes, retries partial files and deduplicates HTTP copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-')); folders.push(dir)
  await mkdir(join(dir, 'events')); await mkdir(join(dir, 'health'))
  const path = join(dir, 'events', 'event.json')
  await writeFile(path, '{'); await utimes(path, 0, 0)
  const s = store(), c = { ...config, inbox: dir }
  const inbox = new Inbox({ store: s, settings: async () => c, roots: async () => [dir] })
  await inbox.scan(); expect(s.events({})).toHaveLength(0)
  await writeFile(path, JSON.stringify(event())); await utimes(path, 0, 0)
  await inbox.scan(); expect(s.events({})).toHaveLength(1)
  expect(s.ingestEvent(event(), 'phone', {}).status).toBe('duplicate')
  await symlink('/tmp', join(dir, 'escape'))
  await expect(scopedFolder(join(dir, 'escape'), [dir])).rejects.toThrow()
  await expect(scopedFolder(dir, [])).rejects.toThrow()
})

test('archived summaries survive retention, but later source corrections invalidate them', () => {
  let clock = NOW
  const s = store({ now: () => clock })
  s.ingestHealth(JSON.stringify([sample()]))
  clock += 366 * DAY; s.maintain()
  expect(s.rows()).toHaveLength(0); expect(s.summaries()).toHaveLength(1)
  s.ingestHealth(JSON.stringify([sample('one', { recordVersion: 2, quantity: { value: 999, unit: 'count' } })]))
  expect(s.rows()).toHaveLength(0); expect(s.summaries()).toHaveLength(0)
})
test('source tombstones stay authoritative when unrelated forgetting rules are cleared', () => {
  const s = store()
  s.ingestHealth(JSON.stringify([sample()]))
  s.ingestHealth(JSON.stringify([sample('one', { recordVersion: 3, kind: 'deletion' })]))
  s.forget(NOW - 10 * DAY, NOW - 9 * DAY, 'sleep')
  s.allowReimport(); s.ingestHealth(JSON.stringify([sample()]))
  expect(s.rows()).toHaveLength(0)
})
test('coverage reports are versioned by observation time and never become measurements', () => {
  const s = store()
  const coverage = { schemaVersion: 1, kind: 'typeCoverage', type: 'HKQuantityTypeIdentifierStepCount', state: 'anchorClosed', complete: true, observedAt: new Date(NOW).toISOString() }
  s.ingestHealth(JSON.stringify([coverage]))
  s.ingestHealth(JSON.stringify([{ ...coverage, complete: false, observedAt: new Date(NOW - DAY).toISOString() }]))
  expect(s.coverage()[0].complete).toBe(true)
  expect(s.summaries()).toEqual([])
})

test('a Hozz connection probe does not claim fresh Health data', () => {
  const s = store()
  expect(s.ingestHealth('{"kind":"hozzConnectionTest","schemaVersion":1}\n').records).toBe(0)
  expect(s.get('lastHealthReceived')).toBeUndefined()
})

test('forgetting a deleted record and allowing reimport does not erase its source tombstone', () => {
  const s = store()
  s.ingestHealth(JSON.stringify([sample()]))
  s.ingestHealth(JSON.stringify([sample('one', { recordVersion: 3, kind: 'deletion' })]))
  s.forget(NOW - DAY, NOW, 'steps')
  s.allowReimport(); s.ingestHealth(JSON.stringify([sample()]))
  expect(s.rows()).toHaveLength(0)
})

test('categories without Health permission are reported as not shared', () => {
  const s = store()
  s.ingestHealth(JSON.stringify([{ schemaVersion: 1, kind: 'typeCoverage', type: 'HKWorkoutTypeIdentifier', state: 'authorizationIndeterminate', complete: false, deliveredCount: 0, observedAt: new Date(NOW).toISOString() }]))
  expect(s.coverage()).toEqual([expect.objectContaining({ metric: 'workout', complete: false, state: 'authorizationIndeterminate', note: expect.stringContaining('permission') })])
  s.ingestHealth(JSON.stringify([{ schemaVersion: 1, kind: 'typeCoverage', type: 'HKWorkoutTypeIdentifier', state: 'not a token!', complete: false, observedAt: new Date(NOW + 1).toISOString() }]))
  expect(s.coverage()[0].state).toBeUndefined()
})
