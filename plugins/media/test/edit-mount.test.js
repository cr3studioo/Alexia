// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { note } from '../compute.js'
import { encode, header } from '../edit/transforms/png.js'

// Exercise the mounted render adapter, capturing the compute boundary before transport.
const mounted = vi.hoisted(() => ({ adapters: null }))
vi.mock('../edit/run.js', async (original) => ({
  ...await original(),
  editor: (adapters) => { mounted.adapters = adapters; return {} },
}))
import { mountEditor } from '../edit/mount.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-edit-mount-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const picture = (name, width, height) => {
  const bytes = encode({ width, height, data: Buffer.alloc(width * height * 4, 120) })
  const path = join(root, name)
  writeFileSync(path, bytes)
  return { path, sha256: sha(bytes) }
}

const render = async (envelope, files) => {
  const run = vi.fn(async () => ({ text: note({ width: 832, height: 1216 }), files: ['result.png'] }))
  mountEditor({
    alexia: { storage: {}, tool: vi.fn() },
    compute: { operation: vi.fn(), run },
    own: () => root,
    connectManaged: vi.fn(),
  })
  await mounted.adapters.render(envelope, files, { conversation: 'test', candidateId: 'child1' })
  return run.mock.calls[0]
}

test('large render inputs are authorized by their transferred bytes, by slot, without changing the sources', async () => {
  const large = picture('large.png', 32, 4096)
  const small = picture('small.png', 24, 48)
  const envelope = { inputs: [
    { attachmentId: 'small', slot: 2, sha256: small.sha256 },
    { attachmentId: 'large', slot: 1, sha256: large.sha256 },
  ], masks: [] }
  const files = { inputs: [{ slot: 1, path: large.path }, { slot: 2, path: small.path }], masks: [] }
  const before = structuredClone({ envelope, files })
  const [, plan, options] = await render(envelope, files)
  for (const input of plan.envelope.inputs) {
    const staged = plan.inputs.find((file) => file.slot === input.slot)
    expect(input.sha256).toBe(sha(readFileSync(staged.path)))
    expect(options.inputs.some((file) => file.path === staged.path)).toBe(true)
  }
  expect(header(readFileSync(plan.inputs[0].path))).toMatchObject({ width: 16, height: 2048 })
  expect(plan.envelope.inputs.find((input) => input.slot === 1).sha256).not.toBe(large.sha256)
  expect(plan.envelope.inputs.find((input) => input.slot === 2).sha256).toBe(small.sha256)
  expect(sha(readFileSync(large.path))).toBe(large.sha256)
  expect({ envelope, files }).toEqual(before)
})

test('masked edits keep original image and mask paths and hashes for pixel alignment', async () => {
  const source = picture('masked-source.png', 32, 4096)
  const mask = picture('mask.png', 32, 4096)
  const envelope = { inputs: [{ slot: 1, sha256: source.sha256 }], masks: [{ id: 'mask1', sha256: mask.sha256 }] }
  const files = { inputs: [{ slot: 1, path: source.path }], masks: [{ id: 'mask1', path: mask.path }] }
  const [, plan, options] = await render(envelope, files)
  expect(plan.envelope).toBe(envelope)
  expect(plan.inputs).toBe(files.inputs)
  expect(plan.masks).toBe(files.masks)
  expect(options.inputs.map((file) => file.path)).toEqual([source.path, mask.path])
})
