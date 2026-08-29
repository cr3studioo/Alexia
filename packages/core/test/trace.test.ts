// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Step } from '../src/agent.js'
import { asText, KEPT, Trace } from '../src/trace.js'

/**
 * The trace, with a memory (M6-5).
 *
 * The live trace is a progress indicator: it exists while the task does and goes with it.
 * This is the record, and the three things worth holding still are the three the predecessor
 * got right and nearly lost — **backtrack**, **two model labels**, and **five runs that go on
 * restart, on purpose**.
 */

const step = (n: number, name: string): Step => ({ n, name, args: { which: n } })
const done = (n: number, name: string, ok: boolean): Step => ({ ...step(n, name), outcome: { ok, text: `${name} said something` } })

test('a run is what the loop did, in the order it did it', () => {
  const trace = new Trace()
  trace.start('one', 'sort my downloads')
  trace.step(step(1, 'list_files'))
  trace.done(done(1, 'list_files', true))
  trace.end('answered', { spent: 0.0021 })

  const [run] = trace.runs
  expect(run?.task).toBe('sort my downloads')
  expect(run?.ended).toBe('answered')
  expect(run?.spent).toBe(0.0021)
  expect(run?.steps[0]).toMatchObject({ n: 1, name: 'list_files', ok: true })
  // Untrimmed: what the loop did, not what the model was shown (M15-6 owns the other one).
  expect(run?.steps[0]?.text).toBe('list_files said something')
  expect(typeof run?.steps[0]?.ms).toBe('number')
})

test('a step that begins after a failure is marked as a retry', () => {
  // Three lines, and it is the difference between a log and a story: a flat list becomes an
  // agent visibly recovering.
  const trace = new Trace()
  trace.start('two', 'open the file')
  trace.step(step(1, 'read_file'))
  trace.done(done(1, 'read_file', false))
  trace.step(step(2, 'list_files'))
  trace.done(done(2, 'list_files', true))
  trace.step(step(3, 'read_file'))
  trace.done(done(3, 'read_file', true))
  trace.end('answered')

  const run = trace.runs[0]
  expect(run?.steps.map((one) => one.backtrack === true)).toEqual([false, true, false])
})

test('the model asked for and the model that answered are two labels', () => {
  const trace = new Trace()
  trace.start('three', 'anything')
  trace.turn({ asked: 'free/one', answered: 'free/two' })
  trace.end('answered')

  const run = trace.runs[0]
  expect(run?.asked).toBe('free/one')
  expect(run?.answered).toBe('free/two')
  // The fallback said out loud. Every other surface shows one model, so this is the only
  // place a 429 the router walked past is explicable.
  expect(asText(run!)).toContain('the router fell back')
})

test('a run that used the model it asked for does not say so twice', () => {
  const trace = new Trace()
  trace.start('four', 'anything')
  trace.turn({ asked: 'free/one', answered: 'free/one' })
  trace.end('answered')
  // A line that says the same model twice is a line that trains people to skip the line.
  expect(asText(trace.runs[0]!)).toContain('model free/one')
  expect(asText(trace.runs[0]!)).not.toContain('fell back')
})

test('five runs, newest first, and the sixth pushes the first out', () => {
  const trace = new Trace()
  for (let n = 1; n <= KEPT + 2; n++) {
    trace.start(`run-${String(n)}`, `task ${String(n)}`)
    trace.end('answered')
  }
  expect(trace.runs).toHaveLength(KEPT)
  // Newest first, which is the order somebody reads them in.
  expect(trace.runs[0]?.task).toBe(`task ${String(KEPT + 2)}`)
  expect(trace.one('run-1')).toBeUndefined()
  expect(trace.one(`run-${String(KEPT + 2)}`)?.task).toBe(`task ${String(KEPT + 2)}`)
})

test('an export is the run as a person would send it on', () => {
  const trace = new Trace()
  trace.start('five', 'tidy the desktop')
  trace.step(step(1, 'list_files'))
  trace.done(done(1, 'list_files', false))
  trace.step(step(2, 'list_files'))
  trace.done(done(2, 'list_files', true))
  trace.end('answered', { spent: 0.5 })

  const text = asText(trace.runs[0]!)
  expect(text).toContain('# tidy the desktop')
  expect(text).toContain('spent $0.5000')
  // The arguments and the answers as they were — nothing summarised, because the second
  // thing anybody does with a bad run is send it to somebody who was not there.
  expect(text).toContain('args: {"which":1}')
  expect(text).toContain('list_files said something')
  expect(text).toContain('retrying after a failure')
})

test('a run nothing ended reads as unfinished rather than as finished', () => {
  const trace = new Trace()
  trace.start('six', 'something that hung')
  trace.step(step(1, 'wait'))
  expect(asText(trace.runs[0]!)).toContain('unfinished')
  expect(trace.runs[0]?.steps[0]?.ok).toBeUndefined()
  expect(asText(trace.runs[0]!)).toContain('did not finish')
})

test('events for a run that has already ended are dropped rather than misfiled', () => {
  // A late `done` from a task that was stopped must not land on the run after it. The loop
  // is single-threaded through one task, but the stream is not, and a step attributed to the
  // wrong run is worse than a step that is missing.
  const trace = new Trace()
  trace.start('seven', 'first')
  trace.end('stopped')
  trace.step(step(9, 'late'))
  trace.done(done(9, 'late', true))
  expect(trace.runs[0]?.steps).toEqual([])
})
