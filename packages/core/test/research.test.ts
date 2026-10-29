// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { ResearchRuns } from '../src/research.js'
const snapshot = (sequence = 1, conversationId = 'c1', runId = 'r1') => ({ runId, conversationId, sequence, topic: 'Question', startedAt: 1, elapsedMs: 1, stage: 'reading', sources: [{ id: 'S1', url: 'https://example.org/', title: 'Example', state: 'complete', passages: [{ id: 'P1', text: 'Actual evidence.' }] }], counters: { read: 99, inProgress: 8, failed: 4 }, completion: 'running' })

test('snapshots are scoped to the host conversation and counters derive from stable extraction states', () => {
  const runs = new ResearchRuns(); const owner = {}
  runs.begin('provider', 'c1', owner)
  expect(runs.accept('provider', 'c1', owner, snapshot())?.counters).toEqual({ read: 1, inProgress: 0, failed: 0 })
  expect(runs.accept('provider', 'c1', owner, snapshot(2, 'c2'))).toBeUndefined()
  expect(runs.get('provider', 'c2')).toBeUndefined()
  expect(runs.get('other', 'c1')).toBeUndefined()
})

test('duplicates, old sequences, duplicate sources and late calls cannot replace a newer snapshot', () => {
  const runs = new ResearchRuns(); const a = {}; const b = {}
  runs.begin('p', 'c1', a)
  runs.accept('p', 'c1', a, snapshot(3))
  expect(runs.accept('p', 'c1', a, snapshot(2))).toBeUndefined()
  expect(runs.accept('p', 'c1', a, snapshot(3))).toBeUndefined()
  const duplicate = snapshot(4); duplicate.sources.push(duplicate.sources[0]!)
  expect(runs.accept('p', 'c1', a, duplicate)).toBeUndefined()
  runs.begin('p', 'c1', b)
  runs.accept('p', 'c1', b, snapshot(1, 'c1', 'r2'))
  expect(runs.accept('p', 'c1', a, snapshot(5))).toBeUndefined()
  expect(runs.get('p', 'c1')?.runId).toBe('r2')
})

test('cancel and worker failure settle fetching states; completed runs stay completed and deletion forgets runs', () => {
  for (const cancelled of [true, false]) {
    const runs = new ResearchRuns(); const owner = {}
    runs.begin('p', 'c1', owner)
    const next = snapshot(); next.sources[0]!.state = 'fetching'
    runs.accept('p', 'c1', owner, next)
    runs.close('p', 'c1', owner, cancelled)
    expect(runs.get('p', 'c1')).toMatchObject({ stage: 'finished', completion: cancelled ? 'cancelled' : 'failed', counters: { read: 0, inProgress: 0, failed: 1 } })
    expect(runs.accept('p', 'c1', owner, snapshot(9))).toBeUndefined()
    runs.forget('c1'); expect(runs.get('p', 'c1')).toBeUndefined()
  }
  const runs = new ResearchRuns(); const owner = {}
  runs.begin('p', 'c1', owner)
  runs.accept('p', 'c1', owner, { ...snapshot(), stage: 'finished', completion: 'complete' })
  runs.close('p', 'c1', owner, false)
  expect(runs.get('p', 'c1')?.completion).toBe('complete')
})
