// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CAN, endingLine, mountLive, type LiveRoots } from '../src/live.js'

/**
 * Running now, Steps and Current step (the live pages).
 *
 * The complaints these hold still: *Running now* stayed on after an error, a pause or a
 * refusal; Steps never said how a task ended; a reload emptied them while the run sat on the
 * Activity screen; and Current step opened on a capability id and a block of JSON.
 */

/** The three pages, as `index.html` draws them — only the parts `mountLive` looks up. */
function pages(): LiveRoots {
  const make = (inner: string): HTMLElement => {
    const page = document.createElement('section')
    page.innerHTML = inner
    document.body.append(page)
    return page
  }
  return {
    running: make('<span id="running-count"></span><div id="running"></div>'),
    steps: make('<span id="step-count"></span><div id="trace"></div>'),
    current: make('<div id="detail-head"></div><div id="detail"></div>'),
  }
}

/** What core answers: the tools with their words, one plugin, and the last saved run. */
function core(last: Record<string, unknown>[] = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { body?: string }) => {
      const sent = JSON.parse(init?.body ?? '{}') as { key?: string }
      const json =
        path === '/api/plugins' ? { panes: [{ id: 'computer', name: 'Computer control', requires: [{ cap: 'screen.capture', why: 'To see.' }] }] }
        : sent.key === 'tools' ? { rows: [{ id: 'computer__windows', plugin: 'computer', words: 'list the open windows' }] }
        : sent.key === 'last_run' ? { rows: last }
        : {}
      return Promise.resolve({ ok: true, json: () => Promise.resolve(json) })
    }),
  )
}

/** Every pending promise, twice — the facts are read, then the paint that waited on them runs. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('every ending clears Running now and says how it ended under the steps', async () => {
  core()
  const roots = pages()
  const live = mountLive('t', roots)
  await settle()

  for (const [how, why, said] of [
    ['answered', undefined, 'Finished'],
    ['stopped', undefined, 'Stopped'],
    ['failed', 'The provider said 500.', "Couldn't finish: The provider said 500."],
    ['refused', 'No model fits.', "Couldn't finish: No model fits."],
    ['paused', 'The free models are used up.', 'Paused: The free models are used up.'],
  ] as const) {
    live.begin('Chat')
    expect(roots.running.textContent).toContain('Chat')
    // When it started, rather than *this one*.
    expect(roots.running.textContent).not.toContain('this one')
    live.end(how, why)
    expect(roots.running.textContent).toContain('Nothing is running.')
    expect(roots.steps.textContent).toContain(said)
    // The backstop in `finally` changes nothing once the ending is said.
    live.end()
    expect(roots.steps.textContent).toContain(said)
  }
})

test('a step reads as words, and its raw data waits behind Details', async () => {
  core()
  const roots = pages()
  const live = mountLive('t', roots)
  live.begin('Chat')
  live.step(1, 'computer__windows', { filter: 'all' })
  live.done(1, true, '{"windows":[]}')
  await settle()

  const head = roots.current.querySelector('#detail-head')!.textContent ?? ''
  expect(head).toContain('list the open windows')
  expect(roots.steps.textContent).toContain('list the open windows')
  const card = roots.current.querySelector('#detail')!
  // The permission in words, not its id.
  expect(card.textContent).toContain(CAN['screen.capture'])
  expect(card.querySelector('.cap')?.textContent).not.toContain('screen.capture')
  // The JSON is folded, and the line outside the fold is a sentence.
  const fold = card.querySelector('details')
  expect(fold?.querySelector('summary')?.textContent).toBe('Details')
  expect(fold?.textContent).toContain('"filter": "all"')
  expect(card.querySelector('dl')?.textContent).toContain('Done. What it sent back is under Details.')
})

test('after a reload the pages show the last saved run as it ended, not an empty page', async () => {
  core([
    {
      id: 'r1',
      task: 'what is open',
      over: true,
      ended: 'The AI service failed',
      why: 'The provider said 500.',
      steps: [{ n: 1, name: 'computer__windows', args: {}, ok: true, text: 'Finder, Safari' }],
    },
  ])
  const roots = pages()
  mountLive('t', roots)
  await settle()

  expect(roots.steps.textContent).toContain('list the open windows')
  expect(roots.steps.textContent).toContain('The AI service failed: The provider said 500.')
  expect(roots.running.textContent).toContain('Nothing is running.')
  expect(roots.current.textContent).toContain('Done: Finder, Safari')
})

test('the ending line names the reason, and a clean finish needs none', () => {
  expect(endingLine('answered', 'ignored')).toBe('Finished')
  expect(endingLine('ceiling')).toBe('Stopped at the step limit')
  expect(endingLine('failed')).toBe("Couldn't finish")
})
