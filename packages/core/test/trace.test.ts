// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, vi } from 'vitest'
import type { Step } from '../src/agent.js'
import { asText, KEPT, spentOn, Trace } from '../src/trace.js'

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
  trace.end('answered', { calls: [{ asked: 'free/text', model: 'free/text', provider: 'alpha', cost: 0.0021 }] })

  const [run] = trace.runs
  expect(run?.task).toBe('sort my downloads')
  expect(run?.ended).toBe('answered')
  // From the ledger's own rows rather than a second tally, so the two cannot disagree (M7-2).
  expect(spentOn(run!)).toBe(0.0021)
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
  trace.end('answered', {
    calls: [
      { asked: 'free/text', model: 'free/text', provider: 'alpha', cost: 0.2 },
      // The fallback: asked for one and answered by another, which is the case where a
      // cost is surprising and therefore the one the export has to explain.
      { asked: 'free/text', model: 'paid/small', provider: 'beta', cost: 0.3 },
    ],
  })

  const text = asText(trace.runs[0]!)
  expect(text).toContain('# tidy the desktop')
  expect(text).toContain('spent $0.5000 across 2 model calls')
  expect(text).toContain('$0.3000  asked free/text, answered paid/small — fell back')
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

/**
 * *Was it sent, and how much of it?* (`plan-personality.md` step 3.)
 *
 * The bug was reported as *the personality is not being sent* and it was being sent — 221
 * characters of a document that should have run to thousands, because Adapt had saved half
 * one (D157). The trace could not tell *none* from *a stub*, so the first guess was wrong.
 */
test('a personality that was sent reads as its length, not as a yes', () => {
  const trace = new Trace()
  trace.start('eight', 'who are you')
  // Fifteen steps, one length: the ordinary case, and it still reads as one fact.
  for (let n = 0; n < 15; n++) trace.personality(221, 'high')
  trace.end('answered')

  expect(trace.runs[0]?.personality).toEqual([{ chars: 221, size: 'high' }])
  // The number, and the unit — 221 against a description somebody knows ran to thousands is
  // the whole story, and it is a story a bare *sent* cannot tell.
  expect(asText(trace.runs[0]!)).toContain('personality: 221 characters (high) sent')
})

test('a task that fell back to a weaker model says both lengths, in the order they went out', () => {
  // §2, and the reason D175's one-number-per-run no longer tells the truth: the document is
  // still read once per task, but which of its three lengths goes out is decided for each model
  // asked — so a fallback genuinely changes what she was told.
  const trace = new Trace()
  trace.start('eight-b', 'refactor this')
  trace.personality(612, 'high')
  trace.personality(612, 'high')
  trace.personality(98, 'small')
  trace.end('answered')

  expect(trace.runs[0]?.personality).toEqual([
    { chars: 612, size: 'high' },
    { chars: 98, size: 'small' },
  ])
  expect(asText(trace.runs[0]!)).toContain('personality: 612 characters (high), then 98 characters (small) sent')
})

test('no personality reads as none sent, which is a different fault from a short one', () => {
  const trace = new Trace()
  trace.start('nine', 'who are you')
  trace.personality(0, 'high')
  trace.end('answered')

  const text = asText(trace.runs[0]!)
  expect(text).toContain('personality: none sent')
  expect(text).not.toContain('characters sent')
})

test('a run told nothing about a personality says nothing about one', () => {
  // Silence rather than a guess: `trial.ts` sends no personality and no words of anybody's,
  // and a line claiming *none sent* on a run that was never asked would read as a finding.
  const trace = new Trace()
  trace.start('ten', 'reply with the single word OK')
  trace.end('answered')

  expect(trace.runs[0]?.personality).toBeUndefined()
  expect(asText(trace.runs[0]!)).not.toContain('personality:')
})

test('a personality told after the run ended is dropped rather than misfiled', () => {
  const trace = new Trace()
  trace.start('eleven', 'first')
  trace.end('answered')
  trace.personality(500, 'high')
  expect(trace.runs[0]?.personality).toBeUndefined()
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

/**
 * **Where the time went** — the stages of the wait, each timed by the gap to the next.
 *
 * The complaint was *a minute before the first word*, and the one number there was to read
 * was the minute: a try is stamped when it ends, so a walk could not be split into choosing,
 * waiting on a busy model and writing. These hold the split still.
 */
function clocked(body: (at: (ms: number) => void) => void): void {
  const clock = vi.spyOn(Date, 'now')
  try {
    body((ms) => clock.mockReturnValue(ms))
  } finally {
    clock.mockRestore()
  }
}

test('each stage lasts until the next begins, and the last one until the run ends', () => {
  clocked((at) => {
    const trace = new Trace()
    at(1_000)
    trace.start('twelve', 'why so slow')
    trace.phase({ kind: 'choosing' })
    at(1_150)
    trace.phase({ kind: 'asking', model: 'free/one' })
    at(2_650)
    trace.phase({ kind: 'retrying', model: 'free/one', attempt: 2 })
    at(4_000)
    trace.phase({ kind: 'writing', model: 'free/one' })
    at(9_250)
    trace.end('answered')

    // The model, and the attempt for a retry, because *which* model was slow is the finding.
    expect(trace.runs[0]?.phases).toEqual([
      { kind: 'choosing', at: 1_000, ms: 150 },
      { kind: 'asking', detail: 'free/one', at: 1_150, ms: 1_500 },
      { kind: 'retrying', detail: 'free/one, attempt 2', at: 2_650, ms: 1_350 },
      { kind: 'writing', detail: 'free/one', at: 4_000, ms: 5_250 },
    ])
  })
})

test('the same stage told twice is one stage, and a retry is not a repeat', () => {
  clocked((at) => {
    const trace = new Trace()
    at(0)
    trace.start('thirteen', 'think hard')
    trace.phase({ kind: 'thinking', model: 'free/one' })
    at(800)
    // Still the same model reasoning: one wait, not two smaller-looking ones.
    trace.phase({ kind: 'thinking', model: 'free/one' })
    at(2_000)
    trace.phase({ kind: 'retrying', model: 'free/two', attempt: 2 })
    at(2_400)
    trace.phase({ kind: 'retrying', model: 'free/two', attempt: 3 })
    at(3_000)
    trace.phase({ kind: 'tool', name: 'notes.read' })
    trace.phase({ kind: 'tool', name: 'notes.read' })
    at(3_500)
    trace.end('answered')

    expect(trace.runs[0]?.phases).toEqual([
      { kind: 'thinking', detail: 'free/one', at: 0, ms: 2_000 },
      { kind: 'retrying', detail: 'free/two, attempt 2', at: 2_000, ms: 400 },
      { kind: 'retrying', detail: 'free/two, attempt 3', at: 2_400, ms: 600 },
      { kind: 'tool', detail: 'notes.read', at: 3_000, ms: 500 },
    ])
  })
})

test('a stage over before the run opened keeps its own start and length', () => {
  // The attachments are read before the question is written down, and the run opens after.
  // Their seconds are neither lost nor charged to choosing, which is what comes next.
  clocked((at) => {
    const trace = new Trace()
    at(5_000)
    trace.start('fourteen', 'read this')
    trace.phase({ kind: 'reading' }, { at: 2_000, ms: 2_500 })
    at(5_100)
    trace.phase({ kind: 'choosing' })
    at(6_000)
    trace.end('answered')

    expect(trace.runs[0]?.phases).toEqual([
      { kind: 'reading', at: 2_000, ms: 2_500 },
      { kind: 'choosing', at: 5_100, ms: 900 },
    ])
  })
})

test('an export says where the time went, in seconds to a tenth, before the steps', () => {
  clocked((at) => {
    const trace = new Trace()
    at(0)
    trace.start('fifteen', 'sort my downloads')
    trace.phase({ kind: 'choosing' })
    at(120)
    trace.phase({ kind: 'asking', model: 'free/one' })
    at(1_620)
    trace.phase({ kind: 'writing', model: 'free/one' })
    at(13_960)
    trace.step(step(1, 'list_files'))
    trace.phase({ kind: 'tool', name: 'list_files' })
    trace.done(done(1, 'list_files', true))
    at(14_260)
    trace.end('answered')

    const text = asText(trace.runs[0]!)
    expect(text).toContain(
      [
        '## Where the time went',
        '  0.1s  choosing',
        '  1.5s  asking free/one',
        '  12.3s  writing free/one',
        '  0.3s  tool list_files',
      ].join('\n'),
    )
    // The summary first, then the story it summarises.
    expect(text.indexOf('## Where the time went')).toBeLessThan(text.indexOf('## 1. list_files'))
  })
})

test('a stage still going reads as still going, and a run with no stages says nothing about time', () => {
  const trace = new Trace()
  trace.start('sixteen', 'something that hung')
  trace.phase({ kind: 'asking', model: 'free/one' })
  expect(asText(trace.runs[0]!)).toContain('  still going  asking free/one')

  trace.start('seventeen', 'a run that never reached the loop')
  trace.end('refused', { why: 'No model fits.' })
  expect(asText(trace.runs[0]!)).not.toContain('Where the time went')
})

test('a stage told after the run ended is dropped rather than misfiled', () => {
  const trace = new Trace()
  trace.start('eighteen', 'first')
  trace.end('stopped')
  trace.phase({ kind: 'writing', model: 'free/one' })
  expect(trace.runs[0]?.phases).toBeUndefined()
})
