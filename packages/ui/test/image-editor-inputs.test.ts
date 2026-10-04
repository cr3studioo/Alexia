// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { openImageEditor, pacer, splitMessage } from '../src/image-editor.js'
import type { Draft, Picture } from '../src/image-editor-api.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup() {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  const pictures: Picture[] = ['a1', 'a2', 'a3'].map((id, index) => ({ id, label: `image_${String(index + 1)}`, displayName: id + '.png', mime: 'image/png', dimensions: { width: 64, height: 64 }, bytes: 4, sha256: 'a'.repeat(64) }))
  let draft: Draft = {
    id: 'd1', revision: 1, conversationId: 'c1',
    source: { versionId: 'v1', attachmentId: 'a1', conversationId: 'c1', dimensions: { width: 64, height: 64 }, sha256: 'a'.repeat(64), origin: 'original', parentVersionId: null },
    referenceIds: [], referenceRoles: [], instruction: '', regions: [], operation: 'image_edit', transform: null, profile: null,
    settings: { dimensions: { width: 64, height: 64 }, preset: null, steps: null, changeAmount: null, seed: null }, variantCount: 1,
  }
  const saves: Draft[] = []
  const fetcher = (async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/editor/picture')) return new Response(new Uint8Array([1, 2, 3]))
    const body = JSON.parse(String(options?.body ?? '{}')) as { call?: string; command?: { type: string; draft: Draft; expectedRevision: number } }
    if (body.call === 'open') return Response.json({ draft })
    if (body.call === 'pictures') return Response.json({ pictures })
    if (body.call === 'versions') return Response.json({ versions: [] })
    if (body.call === 'profiles') return Response.json({ profiles: [] })
    if (body.call === 'pending') return Response.json({ pending: null })
    if (body.command?.type === 'save') {
      expect(body.command.expectedRevision).toBe(draft.revision)
      draft = { ...body.command.draft, revision: draft.revision + 1 }
      saves.push(draft)
      return Response.json({ draft, batch: null, exports: [] })
    }
    return Response.json({ events: [] })
  }) as unknown as typeof fetch
  return { fetcher, saves }
}
function openAdd(): void {
  const add = document.querySelector<HTMLDetailsElement>('.image-editor-add')!
  add.open = true
  add.dispatchEvent(new Event('toggle'))
}
async function chooseReference(id: string): Promise<void> {
  openAdd()
  document.querySelector<HTMLButtonElement>(`[aria-label="Use ${id}.png as a reference"]`)!.click()
  await vi.waitFor(() => expect(document.querySelectorAll('.image-editor-input-slot')).toHaveLength(Number(id.slice(1))))
}
const chips = (reference: number): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="What to take from reference ${String(reference)}"] .image-editor-chip`)]
const chip = (reference: number, label: string): HTMLButtonElement => chips(reference).find((c) => c.textContent === label)!

test('starts with one photo and adds at most two references', async () => {
  const f = setup()
  await openImageEditor({ token: 'test', conversationId: 'c1', attachmentId: 'a1', behind: () => [], fetcher: f.fetcher })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Use a2.png as a reference"]')).not.toBeNull())
  expect(document.querySelectorAll('.image-editor-input-slot')).toHaveLength(1)
  await chooseReference('a2')
  await chooseReference('a3')
  expect(document.querySelector('.image-editor-add')).toBeNull()
  expect(f.saves.at(-1)?.referenceIds).toEqual(['a2', 'a3'])
})

test('quick role selections save together with increasing draft revisions', async () => {
  const f = setup()
  await openImageEditor({ token: 'test', conversationId: 'c1', attachmentId: 'a1', behind: () => [], fetcher: f.fetcher })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Use a2.png as a reference"]')).not.toBeNull())
  await chooseReference('a2')
  chip(1, 'Clothing').click()
  chip(1, 'Pose').click()
  await vi.waitFor(() => expect(f.saves.at(-1)?.referenceRoles).toEqual([{ attachmentId: 'a2', roles: ['clothing', 'pose'] }]))
  expect(f.saves.map((draft) => draft.revision)).toEqual([2, 3, 4])
})

test('a role belongs to one reference: choosing it on another moves it', async () => {
  const f = setup()
  await openImageEditor({ token: 'test', conversationId: 'c1', attachmentId: 'a1', behind: () => [], fetcher: f.fetcher })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Use a2.png as a reference"]')).not.toBeNull())
  await chooseReference('a2')
  await chooseReference('a3')
  chip(1, 'Pose').click()
  await vi.waitFor(() => expect(f.saves.at(-1)?.referenceRoles).toEqual([{ attachmentId: 'a2', roles: ['pose'] }]))
  await vi.waitFor(() => expect(chip(2, 'Pose')).toBeDefined())
  chip(2, 'Pose').click()
  await vi.waitFor(() => expect(f.saves.at(-1)?.referenceRoles).toEqual([{ attachmentId: 'a3', roles: ['pose'] }]))
})

test('the rail’s Apple glass is told to hide while the editor is open', async () => {
  const f = setup()
  await openImageEditor({ token: 'test', conversationId: 'c1', attachmentId: 'a1', behind: () => [], fetcher: f.fetcher })
  expect(document.body.dataset.overlay).toBe('image-editor')
  document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
  expect(document.body.dataset.overlay).toBeUndefined()
})

test('a download on the picture computer shows as a progress bar with its file', async () => {
  const f = setup()
  const fetcher = (async (url: string, options?: RequestInit) => url === '/api/compute/queue'
    ? Response.json({ queue: { running: { progress: { progress: 5e9, total: 2e10, message: 'qwen_edit.safetensors: Downloading the model — 5.0 GB of 20.0 GB' } }, waiting: [{}], paused: false } })
    : f.fetcher(url, options)) as unknown as typeof fetch
  await openImageEditor({ token: 'test', conversationId: 'c1', attachmentId: 'a1', behind: () => [], fetcher })
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.image-editor-work')!.hidden).toBe(false))
  const card = document.querySelector('.image-editor-work')!
  expect(card.textContent).toContain('Downloading the model — 5.0 GB of 20.0 GB')
  expect(card.textContent).toContain('qwen_edit.safetensors')
  expect(card.textContent).toContain('25%')
  expect(card.querySelector('progress')!.value).toBe(5e9)
  document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
})

test('a progress message is split into its file and its words only when it names a file', () => {
  expect(splitMessage('a.gguf: Downloading')).toEqual(['a.gguf', 'Downloading'])
  expect(splitMessage('Step 3: sampling')).toEqual([undefined, 'Step 3: sampling'])
  expect(splitMessage(undefined)).toEqual([undefined, undefined])
})

test('the pace says how fast and how long is left, for bytes and for steps, and notices a stall', () => {
  let t = 0
  const pace = pacer(() => t)
  const job = (done: number, total: number, id = 'j1') => ({ id, label: 'image.edit', done, total, waiting: 0 })
  expect(pace.see(job(0, 1e9))).toBe('measuring the speed…')
  t = 10_000
  expect(pace.see(job(1e8, 1e9))).toBe('10.0 MB/s · about 1 min left')
  // A render: the count is steps, and a new job starts the measuring again.
  t = 20_000
  expect(pace.see(job(0, 20, 'j2'))).toBe('step 0 of 20 · measuring the speed…')
  t = 28_000
  expect(pace.see(job(2, 20, 'j2'))).toBe('step 2 of 20 · 4.0 s per step · about 1 min left')
  t = 60_000
  expect(pace.see(job(2, 20, 'j2'))).toBe('step 2 of 20 · nothing has moved for 32 s')
})
