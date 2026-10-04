// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'
import { Store } from '../src/store.js'
import { noPolling, stage } from './staged.js'

/**
 * **The image editor, connected** (A10): real core, the real media plugin as its own process,
 * and the editor screen's HTTP routes in between — the path a press in the window takes.
 *
 * What this proves is the wiring and the promises that do not need a graphics card: pictures are
 * kept per conversation and refused to any other; the plugin reaches them only through core; no
 * edit runs without a verified model; a deterministic crop goes all the way through to a new
 * version core keeps; an export is served by token; and forgetting the pictures removes them from
 * both sides. Rendering with a real model, real policy evidence and real hardware are *not*
 * proven here — see the plan's release checklist.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-editor-'))
noPolling(root)
const from = stage('media')
const extensions = mkdtempSync(join(tmpdir(), 'alexia-editor-ext-'))
{
  // Its ComfyUI address points nowhere and nothing autostarts: the plugin starting must not speak
  // to whatever answers on the usual port — another test's stand-in, or somebody's real one.
  const before = new Store(join(root, 'alexia.db'))
  before.setSetting('media', 'server', 'http://127.0.0.1:9')
  before.setSetting('media', 'autostart', false)
  before.close()
}
const alexia: Serving = await serve({ dataDir: root, pluginsDir: extensions, secrets: memorySecrets(), local: false })
afterAll(async () => {
  await alexia.close()
  for (const path of [root, from, extensions]) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}, 60_000)

const call = async (path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; bytes?: Buffer }> => {
  const answered = await fetch(new URL(path, alexia.url), {
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' },
  })
  const type = answered.headers.get('content-type') ?? ''
  if (type.startsWith('image/')) return { status: answered.status, json: {}, bytes: Buffer.from(await answered.arrayBuffer()) }
  return { status: answered.status, json: (await answered.json().catch(() => ({}))) as Record<string, unknown> }
}

const chunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const png = (w: number, h: number): Buffer => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h, 120)
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('prompt\0private words')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const size = (bytes: Buffer): { width: number; height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

let conversationId = ''
let pictureId = ''

test('installing and switching on the media plugin makes the editor available', async () => {
  expect((await call('/api/install', { path: join(from, 'media') })).json.ok).toBe(true)
  expect((await call('/api/plugin', { id: 'media', action: 'enable' })).json.ok).toBe(true)
  const state = (await call('/api/state')).json as { editor: { installed: boolean; conversationId: string; private: boolean } }
  expect(state.editor.installed).toBe(true)
  conversationId = state.editor.conversationId
}, 60_000)

test('a picture is kept with its conversation, stripped of metadata, and private from then on', async () => {
  const added = await call('/api/editor/upload', { conversationId, name: 'C:\\me\\photo.png', data: png(64, 32).toString('base64') })
  expect(added.status).toBe(200)
  const picture = added.json.picture as { id: string; label: string; displayName: string }
  expect(picture).toMatchObject({ label: 'image_1', displayName: 'photo.png' })
  pictureId = picture.id
  const shown = await call(`/api/editor/picture?conversation=${conversationId}&id=${pictureId}`)
  expect(shown.bytes?.includes(Buffer.from('private words'))).toBe(false)
  expect(((await call('/api/state')).json.editor as { private: boolean }).private).toBe(true)
  // Another conversation's id does not reach it, and neither does a made-up one.
  expect((await call(`/api/editor/picture?conversation=99999&id=${pictureId}`)).status).toBe(409)
})

test('the editor checks the render computer and reports missing installation', async () => {
  const listed = await call('/api/editor', { conversationId, call: 'profiles' })
  expect(listed.status).toBe(200)
  const profiles = listed.json.profiles as { availability: string; reason: string; selection: { id: string; version: string } }[]
  expect(profiles.length).toBeGreaterThan(0)
  expect(profiles.every((p) => p.availability !== 'available')).toBe(true)
  expect(profiles[0]!.reason).toMatch(/Install.*ComfyUI/)
}, 60_000)

test('opening, saving and generating: no model chosen, then an unverified one, and nothing renders', async () => {
  const opened = await call('/api/editor', { conversationId, call: 'open', attachmentId: pictureId })
  expect(opened.status).toBe(200)
  let draft = opened.json.draft as Record<string, unknown> & { id: string; revision: number }
  const generate = (d: typeof draft) => call('/api/editor', { conversationId, call: 'command', command: { type: 'generate', draftId: d.id, revision: d.revision, invocationId: `inv_${d.revision}` } })
  const saved = await call('/api/editor', { conversationId, call: 'command', command: { type: 'save', draft: { ...draft, instruction: 'warmer evening light' }, expectedRevision: draft.revision } })
  draft = (saved.json.draft as typeof draft)
  const none = await generate(draft)
  expect(none.status).toBe(409)
  expect(none.json.code).toBe('settings_incompatible')

  const { profiles } = (await call('/api/editor', { conversationId, call: 'profiles' })).json as { profiles: { selection: { id: string; version: string } }[] }
  draft = ((await call('/api/editor', { conversationId, call: 'command', command: { type: 'save', draft: { ...draft, profile: profiles[0]!.selection }, expectedRevision: draft.revision } })).json.draft as typeof draft)
  const unverified = await generate(draft)
  expect(unverified.json.code).toBe('profile_unavailable')

  // A stale revision is a conflict, never a silent overwrite.
  const stale = await call('/api/editor', { conversationId, call: 'command', command: { type: 'save', draft: { ...draft, instruction: 'colder' }, expectedRevision: draft.revision - 1 } })
  expect(stale.json.code).toBe('draft_conflict')
}, 60_000)

test('a crop goes all the way through: a new version core keeps, the original untouched, an export by token', async () => {
  const opened = (await call('/api/editor', { conversationId, call: 'open', attachmentId: pictureId })).json.draft as Record<string, unknown> & { id: string; revision: number }
  const set = (await call('/api/editor', {
    conversationId, call: 'command',
    command: { type: 'save', draft: { ...opened, operation: 'crop', transform: { kind: 'crop', rect: { x: 0, y: 0, width: 0.5, height: 1 } } }, expectedRevision: opened.revision },
  })).json.draft as typeof opened
  const cropped = await call('/api/editor', { conversationId, call: 'command', command: { type: 'generate', draftId: set.id, revision: set.revision, invocationId: 'crop_1' } })
  expect(cropped.status).toBe(200)
  const draft = cropped.json.draft as { source: { attachmentId: string; versionId: string; origin: string; dimensions: { width: number; height: number } } }
  expect(draft.source).toMatchObject({ origin: 'deterministic_transform', dimensions: { width: 32, height: 32 } })

  const made = await call(`/api/editor/picture?conversation=${conversationId}&id=${draft.source.attachmentId}`)
  expect(size(made.bytes!)).toEqual({ width: 32, height: 32 })
  const original = await call(`/api/editor/picture?conversation=${conversationId}&id=${pictureId}`)
  expect(size(original.bytes!)).toEqual({ width: 64, height: 32 })
  // The new version is the conversation's next picture, with its own label.
  const { pictures } = (await call('/api/editor', { conversationId, call: 'pictures' })).json as { pictures: { label: string }[] }
  expect(pictures.map((p) => p.label)).toEqual(['image_1', 'image_2'])

  const versions = ((await call('/api/editor', { conversationId, call: 'versions' })).json.versions as { source: { origin: string } }[]).map((v) => v.source.origin)
  expect(versions).toEqual(['original', 'deterministic_transform'])

  const exported = await call('/api/editor', { conversationId, call: 'command', command: { type: 'export', versionIds: [draft.source.versionId], format: 'png', background: null } })
  const url = (exported.json.exports as { url: string }[])[0]!.url
  expect(url).toMatch(/^\/api\/editor\/file\?token=/)
  const file = await call(url)
  expect(size(file.bytes!)).toEqual({ width: 32, height: 32 })
  expect((await call('/api/editor/file?token=made-up')).status).toBe(404)
}, 60_000)

test('removing a version asks first', async () => {
  const versions = (await call('/api/editor', { conversationId, call: 'versions' })).json.versions as { source: { versionId: string; origin: string } }[]
  const result = versions.find((v) => v.source.origin !== 'original')!
  const unasked = await call('/api/editor', { conversationId, call: 'command', action: 'remove_version', command: { type: 'remove_version', versionId: result.source.versionId } })
  expect(unasked.status).toBe(409)
  expect(unasked.json.confirm).toBe(true)
  const asked = await call('/api/editor', { conversationId, call: 'command', action: 'remove_version', confirm: true, command: { type: 'remove_version', versionId: result.source.versionId } })
  expect(asked.status).toBe(200)
})

test('forgetting the pictures removes them from core and from the editor, and says so truthfully', async () => {
  const unasked = await call('/api/editor/forget', { conversationId })
  expect(unasked.status).toBe(409)
  const forgotten = await call('/api/editor/forget', { conversationId, confirm: true })
  expect(forgotten.json.receipt).toMatchObject({ local: 'complete', remote: [] })
  expect((await call(`/api/editor/picture?conversation=${conversationId}&id=${pictureId}`)).status).toBe(409)
  expect(((await call('/api/editor', { conversationId, call: 'versions' })).json.versions as unknown[])).toEqual([])
  expect(((await call('/api/editor', { conversationId, call: 'pictures' })).json.pictures as unknown[])).toEqual([])
}, 60_000)

test('adult content: off until confirmed 18+ in Settings, asked to confirm, and off again in one press', async () => {
  expect(((await call('/api/state')).json.adult as { confirmed: boolean })).toEqual({ confirmed: false, on: false })
  // The route guard asks first; without the 18+ tick it refuses.
  expect((await call('/api/adult', { enabled: true, adult: true })).status).toBe(409)
  expect((await call('/api/adult', { enabled: true, confirm: true })).json.ok).toBe(false)
  expect((await call('/api/adult', { enabled: true, adult: true, confirm: true })).json.ok).toBe(true)
  expect(((await call('/api/state')).json.adult as { confirmed: boolean }).confirmed).toBe(true)
  expect((await call('/api/adult', { enabled: false })).json.ok).toBe(true)
  expect(((await call('/api/state')).json.adult as { confirmed: boolean })).toEqual({ confirmed: false, on: false })
})
