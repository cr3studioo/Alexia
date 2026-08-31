// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Message } from '../src/store.js'
import { budgetFor, collapse, floor, size, summary, trim } from '../src/trim.js'

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

// The budget stopped being a constant. It was 24,000 characters whatever answered — safe on
// a 32k window and most of a 200k one left on the table.

test('a bigger window buys a bigger budget, and an unpublished one keeps the old default', () => {
  expect(budgetFor(200_000)).toBeGreaterThan(budgetFor(32_768))

  // The share is the one the fixed number already was, so nothing that fits a 32k model
  // today gets tighter tomorrow.
  expect(budgetFor(32_768)).toBeGreaterThanOrEqual(24_000)

  // Silence is not smallness. A provider that publishes no window gets the old default
  // rather than a budget of nothing.
  expect(budgetFor(0)).toBe(24_000)
})

test('a wide window keeps verbatim what a narrow one has to summarise', () => {
  // Long enough to overrun a 32k window's share and nowhere near a 200k one's, which is the
  // gap a fixed number could not see.
  const trace = [task, ...long(200)]
  const wide = trim(trace, { budget: budgetFor(200_000) })
  const narrow = trim(trace, { budget: budgetFor(32_768) })

  // What the budget buys is how many of the newest cycles survive as themselves rather than
  // as a line about themselves. That is the difference between a model that can see the file
  // it just read and one that has been told it read a file.
  const verbatim = (kept: Message[]): number => kept.filter((m) => m.role === 'tool').length
  expect(verbatim(wide)).toBeGreaterThan(verbatim(narrow))
  expect(size(wide)).toBeGreaterThan(size(narrow))
})

test('the floor is the head plus the newest cycle, and nothing else', () => {
  const trace = [task, ...long(5)]
  const kept = floor(trace)

  // The task, then exactly one plan-act-observe pair — the part trimming can never take.
  expect(kept[0]).toEqual(task)
  expect(kept.slice(1)).toEqual(trace.slice(-2))

  // Which is what makes it the right thing for a window to be measured against: it is the
  // smallest this trace can honestly be made.
  expect(size(kept)).toBeLessThan(size(trace))
  expect(size(kept)).toBeLessThanOrEqual(size(trim(trace, { budget: 1 })))
})

// The mechanical collapse (§11.3). **An observation matters until a conclusion supersedes
// it** — and four of the ways a conclusion supersedes one are not judgements at all, they
// are facts about two calls sitting in the same trace. No model is asked anything here.

/** What each tool turn says after the collapse, in order. The whole assertion, every time. */
const after = (trace: Message[]): string[] => collapse(trace).filter((m) => m.role === 'tool').map((m) => m.content)

test('a call that errored and was retried successfully loses the error', () => {
  const trace = [
    task,
    ...cycle(1, 'files__read', '{"name":"notes.txt"}', 'files__read failed: locked'),
    ...cycle(2, 'files__read', '{"name":"notes.txt"}', 'buy milk'),
    ...cycle(3, 'files__list', '{}', 'notes.txt'),
  ]
  // The retry answered the question the error was asking. What survives is the answer.
  expect(after(trace)).toEqual(['superseded by a later files__read', 'buy milk', 'notes.txt'])
})

test('a file read and then edited keeps the edit and drops the stale read', () => {
  const trace = [
    task,
    ...cycle(1, 'files__read', '{"name":"notes.txt"}', 'buy milk'),
    ...cycle(2, 'files__write', '{"name":"notes.txt","text":"buy oat milk"}', 'Done.'),
    ...cycle(3, 'files__list', '{}', 'notes.txt'),
  ]
  // Two different tools, one file. The read describes a file that no longer says that.
  expect(after(trace)).toEqual(['superseded by a later files__write', 'Done.', 'notes.txt'])
})

test('the same call made twice keeps one of them', () => {
  const trace = [
    task,
    ...cycle(1, 'files__list', '{}', 'notes.txt done.txt'),
    ...cycle(2, 'files__list', '{}', 'notes.txt done.txt'),
    ...cycle(3, 'files__read', '{"name":"notes.txt"}', 'buy milk'),
  ]
  expect(after(trace)).toEqual(['superseded by a later files__list', 'notes.txt done.txt', 'buy milk'])
})

test('a result superseded by a later one is the earlier one, not the newer', () => {
  const trace = [
    task,
    ...cycle(1, 'files__list', '{}', 'notes.txt'),
    ...cycle(2, 'files__write', '{"name":"done.txt","text":"x"}', 'Done.'),
    ...cycle(3, 'files__list', '{}', 'notes.txt done.txt'),
    ...cycle(4, 'files__read', '{"name":"done.txt"}', 'x'),
  ]
  // The folder has two files in it now. The line that says it has one is not a memory, it
  // is a wrong answer to a question that has since been asked again.
  expect(after(trace)).toEqual(['superseded by a later files__list', 'Done.', 'notes.txt done.txt', 'x'])
})

test('the paths that did not hold it are the finding, and they all survive', () => {
  const missed = ['bin', 'usr', 'opt', 'var', 'tmp']
  const trace = [
    task,
    ...missed.flatMap((where, i) => cycle(i + 1, 'files__list', `{"in":"${where}"}`, `files__list failed: no ${where}`)),
    ...cycle(6, 'files__list', '{"in":"apps"}', 'calculator.exe'),
    ...cycle(7, 'files__read', '{"name":"apps/calculator.exe"}', 'MZ'),
  ]
  // Five different calls, so nothing here is superseded by anything: they are negative
  // space, and they are what stops the next model searching /bin again. Retiring these is
  // the closing of a sub-goal, which is a judgement, and not a thing this makes.
  expect(after(trace)).toEqual([
    ...missed.map((where) => `files__list failed: no ${where}`),
    'calculator.exe',
    'MZ',
  ])
})

test('the step just taken is never collapsed, however much it repeats itself', () => {
  const trace = [task, ...cycle(1, 'files__list', '{}', 'notes.txt'), ...cycle(2, 'files__list', '{}', 'notes.txt')]
  // A model with no memory of the step it just took repeats it forever, which is the same
  // reason the newest cycle survives everywhere else in this file.
  expect(after(trace)).toEqual(['superseded by a later files__list', 'notes.txt'])
})

test('two tools that merely take no arguments are not about the same thing', () => {
  const trace = [
    task,
    ...cycle(1, 'files__list', '{}', 'notes.txt'),
    ...cycle(2, 'clock__now', '{}', 'Tuesday'),
    ...cycle(3, 'files__read', '{"name":"notes.txt"}', 'buy milk'),
  ]
  // Every no-argument tool in a plugin would match every other one, and the folder listing
  // is not answered by what time it is.
  expect(after(trace)).toEqual(['notes.txt', 'Tuesday', 'buy milk'])
})

test('collapsing shrinks what the model is shown, and the trim still fits', () => {
  const again = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) =>
      cycle(i + 1, 'files__read', '{"name":"notes.txt"}', `contents of notes.txt ${'detail '.repeat(40)}`),
    ).flat()

  const trace = [task, ...again(6)]
  const trimmed = trim(trace, { keepTurns: 4 })
  // One file, read six times. Five of those readings are the same reading, and only the
  // last one is what the file says — so the verbatim half of the window stops being spent
  // on five copies of it.
  expect(size(trimmed)).toBeLessThan(size(trace) / 2)
  expect(trimmed.at(-1)?.content).toContain('contents of notes.txt')
})

// Sub-goal tags (§11.5). One level, no graph — the model draws the boundaries itself by
// saying what it is about to do, and a stretch of work that closed on an answer collapses
// to that answer. Nothing here builds an edge between two entries in the trace.

/** A cycle the model narrated before acting. Saying something is what opens a new sub-goal. */
function saying(n: number, said: string, name: string, args: string, came: string): Message[] {
  return [
    { role: 'assistant', content: said, calls: [call(`c${String(n)}`, name, args)] },
    { role: 'tool', callId: `c${String(n)}`, content: came },
  ]
}

test('a sub-goal that closed on an answer collapses to the answer', () => {
  const digest = summary([
    task,
    ...saying(1, 'Let me find the calculator.', 'files__list', '{"in":"bin"}', 'files__list failed: no bin'),
    ...cycle(2, 'files__list', '{"in":"usr"}', 'files__list failed: no usr'),
    ...cycle(3, 'files__list', '{"in":"apps"}', 'calculator.exe'),
    ...saying(4, 'Found it. Now I will open it.', 'shell__run', '{"cmd":"apps/calculator.exe"}', 'started'),
  ]).split('\n')

  // The two folders it was not in stopped mattering the moment it was found in a third:
  // what survives is what the model said it was doing, and the step that answered it.
  expect(digest).toEqual([
    'Said: Let me find the calculator.',
    'Worked: files__list({"in":"apps"}) — calculator.exe',
    'Said: Found it. Now I will open it.',
    'Worked: shell__run({"cmd":"apps/calculator.exe"}) — started',
  ])
})

test('a sub-goal that closed on a failure keeps every path it tried', () => {
  const digest = summary([
    task,
    ...saying(1, 'Let me find the calculator.', 'files__list', '{"in":"bin"}', 'files__list failed: no bin'),
    ...cycle(2, 'files__list', '{"in":"usr"}', 'files__list failed: no usr'),
    ...cycle(3, 'files__list', '{"in":"opt"}', 'files__list failed: no opt'),
    ...saying(4, 'It is not installed. I will say so.', 'files__write', '{"name":"notes.txt"}', 'Done.'),
  ]).split('\n')

  // Nothing worked, so the paths are the finding rather than the search: negative space,
  // and the only thing stopping the next model looking in /bin again.
  expect(digest).toEqual([
    'Said: Let me find the calculator.',
    'Failed: files__list({"in":"bin"}) — files__list failed: no bin',
    'Failed: files__list({"in":"usr"}) — files__list failed: no usr',
    'Failed: files__list({"in":"opt"}) — files__list failed: no opt',
    'Said: It is not installed. I will say so.',
    'Worked: files__write({"name":"notes.txt"}) — Done.',
  ])
})

test('the sub-goal still being worked on is left whole', () => {
  const digest = summary([
    task,
    ...saying(1, 'First I will list the folder.', 'files__list', '{}', 'notes.txt done.txt'),
    ...saying(2, 'Now I will read both.', 'files__read', '{"name":"notes.txt"}', 'buy milk'),
    ...cycle(3, 'files__read', '{"name":"done.txt"}', 'called mum'),
  ]).split('\n')

  // The last stretch has nothing after it saying the work moved on — and there may be more
  // of it above this slice — so both of its steps survive.
  expect(digest).toEqual([
    'Said: First I will list the folder.',
    'Worked: files__list({}) — notes.txt done.txt',
    'Said: Now I will read both.',
    'Worked: files__read({"name":"notes.txt"}) — buy milk',
    'Worked: files__read({"name":"done.txt"}) — called mum',
  ])
})

// Pointers (§11.4). Context is a cache, not a record: a long answer to a question that can
// simply be asked again is one tool call away, and carrying it is carrying a copy.

/** A file big enough that carrying it is the whole problem. */
const big = 'export function route() { /* ... */ }\n'.repeat(200)

test('a large read is not carried, and what replaces it is the call that gives it back', () => {
  const trace = [
    task,
    ...cycle(1, 'files__read', '{"name":"src/router.ts"}', big),
    ...cycle(2, 'files__list', '{}', 'router.ts'),
  ]
  const trimmed = trim(trace, { keepTurns: 4 })
  const pointed = trimmed.find((m) => m.callId === 'c1')

  // Thirty tokens where two thousand were, and every character the next step needs to have
  // the two thousand back: the tool's name, and the arguments it was called with.
  expect(pointed?.content).toContain('files__read({"name":"src/router.ts"})')
  expect(pointed?.content.length).toBeLessThan(200)
  expect(big.length).toBeGreaterThan(2_000)
})

test('the step just taken is shown as it came back, however long it is', () => {
  const trimmed = trim([task, ...cycle(1, 'files__list', '{}', 'router.ts'), ...cycle(2, 'files__read', '{"name":"src/router.ts"}', big)], {
    keepTurns: 4,
  })
  const newest = trimmed.at(-1)

  // A model that is told to go and read the file it just read does exactly that, forever.
  expect(newest?.content).toContain('export function route()')
})

test('an answer that only exists once is clipped, never pointed at', () => {
  const said = `deleted ${'a-file.txt '.repeat(400)}`
  const trace = [task, ...cycle(1, 'shell__run', '{"cmd":"rm *.txt"}', said), ...cycle(2, 'files__list', '{}', 'nothing')]
  const trimmed = trim(trace, { keepTurns: 4 })
  const kept = trimmed.find((m) => m.callId === 'c1')

  // Running it again does not give this back — it does it again. So the ends survive and
  // the middle goes, which is what happens to any other long output.
  expect(kept?.content).toContain('characters cut')
  expect(kept?.content).toContain('deleted a-file.txt')
})
