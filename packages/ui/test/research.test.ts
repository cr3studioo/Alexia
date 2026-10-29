// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { researchViewer } from '../src/research.js'
import type { WidgetHost } from '../src/widgets.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element): void { this.callback([{ isIntersecting: true, target }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver) }
    disconnect(): void {}
  })
})
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const source = (id: string) => ({ id, url: `https://example.org/${id}`, title: `Source ${id}`, state: 'complete', passages: [{ id: 'P1', text: `Actual evidence from source ${id}.` }] })
const run = (sequence: number, currentSourceId: string) => ({ runId: 'r1', conversationId: 'c1', sequence, topic: 'A research question', startedAt: Date.now(), elapsedMs: 100, stage: 'reading', completion: 'running', currentSourceId, sources: [source('S1'), source('S2')], counters: { read: 2, inProgress: 0, failed: 0 }, gaps: [] })

test('viewer renders evidence, accurate counters, source pinning and follow latest without sending provider commands', async () => {
  let snapshot = run(1, 'S1')
  const send = vi.fn<WidgetHost['send']>(async () => ({ snapshot }))
  const host = { plugin: 'provider', screen: 'board', send, root: () => document.body, fresh: async () => [] } as WidgetHost
  const view = researchViewer(host)
  document.body.append(view)
  await vi.advanceTimersByTimeAsync(1)
  expect(view.textContent).toContain('Reading view · snapshot unavailable')
  expect(view.textContent).toContain('2 read · 0 in progress · 0 unavailable')
  const entries = view.querySelectorAll<HTMLButtonElement>('.research-history-entry')
  expect(entries[0]?.textContent).toContain('S2')
  entries[1]?.click()
  snapshot = run(2, 'S2')
  await vi.advanceTimersByTimeAsync(400)
  expect(view.querySelector('.research-preview')?.textContent).toContain('source S1')
  const follow = [...view.querySelectorAll('button')].find((b) => b.textContent === 'Follow latest')!
  follow.click()
  expect(view.querySelector('.research-preview')?.textContent).toContain('source S2')
  expect(send.mock.calls.every((args) => args[0] === '/api/research')).toBe(true)
  view.remove()
  await vi.advanceTimersByTimeAsync(500)
})

test('conversation change clears old evidence; final report uses scoped file access', async () => {
  let snapshot: Record<string, unknown> | null = { ...run(1, 'S1'), stage: 'finished', completion: 'complete', report: { path: '/private/report.md', name: 'report.md' } }
  const send = vi.fn<WidgetHost['send']>(async () => ({ snapshot }))
  const host = { plugin: 'provider', screen: 'board', send, root: () => document.body, fresh: async () => [] } as WidgetHost
  const view = researchViewer(host); document.body.append(view)
  await vi.advanceTimersByTimeAsync(1)
  const link = view.querySelector('a')!
  expect(link.href).toContain('/api/research-file?')
  expect(link.href).not.toContain('/private/')
  snapshot = null
  await vi.advanceTimersByTimeAsync(1100)
  expect(view.textContent).toContain('Ready for research')
  expect(view.querySelector('a')).toBeNull()
  expect(view.querySelector('.research-preview')?.textContent).toBe('')
  view.remove(); await vi.advanceTimersByTimeAsync(1100)
})

test('snapshots and report downloads authenticate scoped requests and release preview blobs', async () => {
  const token = document.createElement('div'); token.dataset.token = 'test-session-token'; document.body.append(token)
  const fetchFile = vi.fn<typeof fetch>(async () => new Response('file contents'))
  vi.stubGlobal('fetch', fetchFile)
  const objectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:research-file')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  let snapshot: Record<string, unknown> | null = { ...run(1, 'S1'), stage: 'finished', completion: 'complete', sources: [{ ...source('S1'), preview: '/private/capture.png' }], report: { path: '/private/report.md', name: 'research-topic.md' } }
  const view = researchViewer({ plugin: 'provider', send: async () => ({ snapshot }) }); document.body.append(view)
  await vi.advanceTimersByTimeAsync(1)
  expect(view.querySelector<HTMLImageElement>('.research-snapshot')?.src).toBe('blob:research-file')
  expect(fetchFile).toHaveBeenCalledWith('/api/research-file?plugin=provider&run=r1&source=S1', expect.objectContaining({ headers: { 'x-alexia-token': 'test-session-token' } }))
  const link = view.querySelector('a')!
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await vi.advanceTimersByTimeAsync(1)
  expect(fetchFile).toHaveBeenLastCalledWith('/api/research-file?plugin=provider&run=r1&kind=report', expect.objectContaining({ headers: { 'x-alexia-token': 'test-session-token' } }))
  expect(download).toHaveBeenCalledOnce()
  expect(objectURL).toHaveBeenCalledTimes(2)
  snapshot = null
  await vi.advanceTimersByTimeAsync(1100)
  expect(revoke).toHaveBeenCalledWith('blob:research-file')
  expect(view.querySelector('img')).toBeNull()
  expect(fetchFile.mock.calls.every(([path]) => !String(path).includes('private') && !String(path).includes('test-session-token'))).toBe(true)
  view.remove(); await vi.advanceTimersByTimeAsync(1100)
})
