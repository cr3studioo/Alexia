// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Message } from '../src/store.js'
import { size, summary, trim } from '../src/trim.js'

// Two things are being protected here. One is the context window. The other is what a
// learned skill will be distilled from at M4-5, which is the same summary.

const call = (id: string, name: string, args = '{}') => ({ id, name, arguments: args })

/** One plan-act-observe cycle, as the loop writes it. */
function cycle(n: number, name: string, args: string, said: string): Message[] {
  return [
    { role: 'assistant', content: '', calls: [call(`c${String(n)}`, name, args)] },
    { role: 'tool', callId: `c${String(n)}`, content: said },
  ]
}

const task: Message = { role: 'user', content: 'Tidy the notes folder.' }

/** A trace with output worth collapsing. A file that reads back as four words is not one. */
const long = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) =>
    cycle(i + 1, 'files__read', `{"name":"n${String(i)}.txt"}`, `contents of n${String(i)} ${'detail '.repeat(40)}`),
  ).flat()

/** The same trace with almost nothing in it, where collapsing would cost more than it saves. */
const terse = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => cycle(i + 1, 'files__read', `{"name":"n${String(i)}.txt"}`, 'ok')).flat()

test('the task itself is never summarised, however long the trace gets', () => {
  const trimmed = trim([task, ...long(20)], { keepTurns: 2 })
  // A summary of the task is a different task. It survives verbatim, first.
  expect(trimmed[0]).toEqual(task)
})

test('recent steps stay verbatim and older ones become a summary', () => {
  const trimmed = trim([task, ...long(10)], { keepTurns: 3 })

  const verbatim = trimmed.filter((m) => m.role === 'tool')
  expect(verbatim).toHaveLength(3)
  // The newest three, not the oldest three.
  expect(verbatim.at(-1)?.content.startsWith('contents of n9')).toBe(true)

  const summary = trimmed.find((m) => m.role === 'system')
  expect(summary?.content).toContain('Earlier steps in this task')
  expect(summary?.content).toContain('files__read')
})

test('the summary records what worked, not only what happened', () => {
  const trace = [
    task,
    ...cycle(1, 'files__list', '{}', 'notes.txt done.txt'),
    ...cycle(2, 'files__read', '{"name":"archive.txt"}', 'files__read failed: no such file'),
    ...cycle(3, 'files__read', '{"name":"notes.txt"}', 'buy milk'),
    ...cycle(4, 'files__write', '{}', 'Done.'),
  ]
  // Asked directly, the way M4-5 will ask it: whether a trace was long enough to need
  // collapsing has nothing to do with whether it was worth learning from.
  const digest = summary(trace)

  // Worked and failed are the field, and it is what a later skill is distilled from: the
  // arguments are kept because they make a step repeatable, the raw output is spent.
  expect(digest).toContain('Worked: files__list({})')
  expect(digest).toContain('Failed: files__read({"name":"archive.txt"})')
  expect(digest).toContain('Worked: files__read({"name":"notes.txt"})')
})

test('a tool turn is never orphaned from the assistant turn that asked for it', () => {
  // Every OpenAI-compatible endpoint rejects a tool turn whose tool_calls are not in the
  // request. Splitting the pair is a 400 and a task that dies at step nine for no reason.
  for (const keepTurns of [1, 2, 3, 7]) {
    const trimmed = trim([task, ...long(9)], { keepTurns })
    const asked = new Set(trimmed.flatMap((m) => (m.calls ?? []).map((c) => c.id)))
    for (const message of trimmed) {
      if (message.role !== 'tool') continue
      expect(asked.has(message.callId ?? ''), `keepTurns ${String(keepTurns)}`).toBe(true)
    }
  }
})

test('raw output is clipped in the middle, where the useful part is not', () => {
  const huge = 'START' + 'x'.repeat(5_000) + 'END'
  const trimmed = trim([task, ...cycle(1, 'files__read', '{}', huge)], { keepTurns: 4, perResult: 400 })
  const said = trimmed.find((m) => m.role === 'tool')!.content

  expect(said.length).toBeLessThan(600)
  expect(said.startsWith('START')).toBe(true)
  expect(said.endsWith('END')).toBe(true)
  expect(said).toContain('characters cut')
})

test('a trace over budget keeps collapsing, and never collapses the last step', () => {
  // Long output is where collapsing pays, and it is what a real trace looks like.
  const trace = [
    task,
    ...Array.from({ length: 20 }, (_, i) =>
      cycle(i + 1, 'files__read', `{"name":"n${String(i)}.txt"}`, 'x'.repeat(1_000)),
    ).flat(),
  ]
  const trimmed = trim(trace, { keepTurns: 10, budget: 3_000 })

  expect(size(trimmed)).toBeLessThan(size(trace))
  // One verbatim turn always survives: a model with no memory of the step it just took
  // repeats it forever, which is the failure that looks like a hang.
  expect(trimmed.filter((m) => m.role === 'tool').length).toBeGreaterThanOrEqual(1)
})

test('trimming never makes a trace bigger than it was', () => {
  // A summary line costs about what a terse step costs, so collapsing short calls with
  // short answers inflates them — the exact opposite of the job, and invisible unless
  // somebody measures it. Where summarising does not pay, the steps stay.
  const trace = [task, ...terse(30)]
  expect(size(trim(trace, { keepTurns: 1, budget: 100 }))).toBeLessThanOrEqual(size(trace))
})

test('a short trace is returned as it is', () => {
  const trace = [task, ...cycle(1, 'files__list', '{}', 'notes.txt')]
  expect(trim(trace)).toEqual(trace)
})
