// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest'
import { editorApi, EditorError, reasonText } from '../src/image-editor-api.js'
import { mountSelection } from '../src/image-editor-selection.js'
import { aspectRect, cropRect, fit, panBy, resized, resizePlan, toSource, toStage, zoomAt } from '../src/image-editor-viewport.js'
import type { Draft } from '../src/image-editor-api.js'

/**
 * The editor screen's arithmetic and wiring. The promise that matters most is that a mark stays
 * on the same spot of the picture whatever the zoom, pan or window size — so these test the
 * coordinate maths directly, and that the crop the frame shows is the crop the backend makes.
 */

describe('coordinates', () => {
  const source = { width: 4000, height: 3000 }
  const stage = { width: 800, height: 600 }

  test('a point survives zoom, pan and a resized window', () => {
    const point = { x: 0.31, y: 0.77 }
    const fitted = fit(source, stage)
    const zoomed = zoomAt(fitted, 3, { x: 123, y: 456 })
    const panned = panBy(zoomed, -250, 90)
    const views = [fitted, zoomed, panned, resized(panned, { width: 390, height: 844 })]
    for (const v of views) {
      const back = toSource(v, toStage(v, point))!
      expect(back.x).toBeCloseTo(point.x, 9)
      expect(back.y).toBeCloseTo(point.y, 9)
    }
  })

  test('off the picture is no point at all', () => {
    expect(toSource(fit(source, stage), { x: 1, y: 1 })).toBeNull()
  })

  test('zooming keeps the point under the cursor still', () => {
    const view = fit(source, stage)
    const at = { x: 400, y: 300 }
    const before = toSource(view, at)!
    const after = toSource(zoomAt(view, 2.5, at), at)!
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  test('the crop frame is the backend’s crop, pixel for pixel', async () => {
    // @ts-expect-error — plain JavaScript in the media plugin, imported for this one comparison.
    const backend = (await import('../../../plugins/media/edit/transforms.js')) as { cropRect: typeof cropRect; resizePlan: typeof resizePlan }
    for (const rect of [{ x: 0.1, y: 0.2, width: 0.5, height: 0.33 }, aspectRect(source, 4 / 5), aspectRect(source, 16 / 9), { x: 0.999, y: 0, width: 0.0001, height: 1 }]) {
      expect(cropRect(source, rect)).toEqual(backend.cropRect(source, rect))
    }
    for (const mode of ['fit', 'fill'] as const) {
      const ours = resizePlan(source, { width: 1080, height: 1350 }, mode)
      const theirs = backend.resizePlan(source, { width: 1080, height: 1350 }, mode) as ReturnType<typeof resizePlan>
      expect(ours).toEqual({ drawn: theirs.drawn, padded: theirs.padded, cropped: theirs.cropped, upscaled: theirs.upscaled })
    }
  })

  test('aspect presets are the largest centred frame of that shape', () => {
    const r = aspectRect(source, 1)
    expect(cropRect(source, r)).toEqual({ left: 500, top: 0, width: 3000, height: 3000 })
  })
})

describe('the client', () => {
  const fetcher = (answers: Record<string, unknown>[], seen: { url: string; body: Record<string, unknown> }[] = []): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      const next = answers.shift() ?? { ok: true }
      return new Response(JSON.stringify(next), { status: next.ok === false ? 409 : 200 })
    }) as unknown as typeof fetch

  test('every call names the conversation, and a command carries its type for the route guard', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    const api = editorApi('tok', '12', fetcher([{ ok: true, draft: null, batch: null, exports: [] }], seen))
    await api.command({ type: 'favorite', versionId: 'v1', favorite: true })
    expect(seen[0]).toEqual({ url: '/api/editor', body: { command: { type: 'favorite', versionId: 'v1', favorite: true }, action: 'favorite', call: 'command', conversationId: '12' } })
  })

  test('a refusal arrives as a reason code and a sentence', async () => {
    const api = editorApi('tok', '12', fetcher([{ ok: false, code: 'profile_unavailable', said: 'Not measured yet.' }]))
    await expect(api.call('profiles')).rejects.toEqual(new EditorError('profile_unavailable', 'Not measured yet.'))
    expect(reasonText('output_blocked')).toMatch(/discarded/)
  })

  test('only the editor’s own file URLs are fetched', () => {
    const api = editorApi('tok', '12', fetcher([]))
    expect(() => api.file('/api/file?id=x')).toThrow(EditorError)
  })
})

describe('notes', () => {
  const draft: Draft = {
    id: 'd1', revision: 3, conversationId: '12',
    source: { versionId: 'v1', attachmentId: 'a1', conversationId: '12', dimensions: { width: 100, height: 50 }, sha256: 'a'.repeat(64), origin: 'original', parentVersionId: null },
    referenceIds: [], instruction: '', operation: 'inpaint', transform: null, profile: null,
    settings: { dimensions: { width: 100, height: 50 }, preset: null, steps: null, changeAmount: null, seed: null }, variantCount: 1,
    regions: [
      { id: 'n1', sourceVersionId: 'v1', point: { x: 0.2, y: 0.5 }, instruction: 'make this blue', enabled: true, reviewed: false, stale: false, mask: null },
      { id: 'n2', sourceVersionId: 'v0', point: { x: 0.7, y: 0.5 }, instruction: 'a hat', enabled: true, reviewed: false, stale: true, mask: null },
    ],
  }

  test('each note is a numbered, labelled row a keyboard can use, in the order applied', () => {
    const panel = document.createElement('div')
    const selection = mountSelection(panel, {
      api: editorApi('tok', '12', (async () => new Response('{}')) as unknown as typeof fetch),
      draft: () => draft, commit: async (_label, next) => next, redraw: () => {}, say: () => {},
    }, () => 'inpaint')
    selection.render()
    const rows = [...panel.querySelectorAll('.image-editor-note')]
    expect(rows.map((r) => r.querySelector('.image-editor-note-title')!.textContent)).toEqual(['Note 1', 'Note 2 — placed on another version'])
    expect(rows[0]!.querySelector('textarea')!.getAttribute('aria-label')).toBe('What note 1 should change')
    // No area yet: it cannot be marked as checked.
    expect(rows[0]!.querySelector<HTMLInputElement>('.image-editor-check input[type=checkbox]:not(:checked)')).not.toBeNull()
    const reviewed = [...rows[0]!.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.includes('looks right'))!
    expect(reviewed.querySelector('input')!.disabled).toBe(true)
    expect(rows[1]!.textContent).toContain('Place this note again')
    expect(panel.querySelector('.image-editor-rect summary')!.textContent).toBe('Type an area instead')
    expect(panel.textContent).toContain('2 passes per version')
  })
})
