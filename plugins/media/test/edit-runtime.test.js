// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { buildGraph, missingNodes } from '../edit/graph.js'
import {
  CANDIDATES,
} from '../edit/profiles/candidates.js'
import {
  checkProfile, describeProfile, forgetHashes, graphSha256, inventory, manifestSha256, PROFILES, settingsProblem, slotNamer,
} from '../edit/profiles.js'
import { editRenderer, EditError } from '../edit/runtime.js'
import { encode } from '../edit/transforms/png.js'

/**
 * The edit render boundary, against a fake ComfyUI that records everything it was asked.
 *
 * The promises: nothing is uploaded or queued until the profile, its files and the staged
 * pictures all check out; no preview leaves; exactly one picture comes back, quarantined; and
 * whatever was lent to ComfyUI is taken back on every path. Real hardware is not exercised here —
 * these tests prove the checks, not that any model fits a graphics card.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-edit-runtime-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const sha = (b) => createHash('sha256').update(b).digest('hex')

const models = join(root, 'models')
const files = { diffusion: Buffer.from('unet bytes'), text_encoder: Buffer.from('clip bytes'), vae: Buffer.from('vae bytes') }
const candidate = CANDIDATES[0]
for (const a of candidate.artifacts) {
  mkdirSync(join(models, a.folder), { recursive: true })
  writeFileSync(join(models, a.folder, a.filename), files[a.id])
}
/** The candidate as it would look once verified — test-only, with hashes of the fake files. */
const verified = checkProfile({
  ...structuredClone(candidate),
  version: 'test-1',
  status: 'verified',
  artifacts: candidate.artifacts.map((a) => ({ ...a, bytes: files[a.id].length, sha256: sha(files[a.id]), url: 'https://example.invalid/x', license: 'test' })),
  evidence: { id: 'bench_test', gpuBytes: 7_000_000_000, hostBytes: 14_000_000_000 },
})

const png = encode({ width: 4, height: 4, data: Buffer.alloc(64, 200) })
const staged = (name, bytes = png) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}
const target = staged('target.png')
const reference = staged('reference.png', encode({ width: 2, height: 2, data: Buffer.alloc(16, 9) }))

const envelope = (over = {}) => ({
  version: '1', runId: 'run1', batchId: 'b1', childId: 'c1', attemptId: 'a1',
  sourceVersionId: 'v1', leaseId: 'l1', selectionId: 's1',
  operation: 'image_edit',
  profile: { id: verified.id, version: verified.version },
  manifestSha256: manifestSha256(verified),
  graphSha256: graphSha256(verified),
  compilerVersion: '1',
  instruction: 'Edit Picture 1. Use only the clothing from Picture 2.',
  settings: { dimensions: { width: 1024, height: 1024 }, preset: null, steps: 8, changeAmount: null, seed: null },
  seed: 42,
  expectedOutputs: 1,
  suppressPreviews: true,
  destination: { kind: 'interaction' },
  deadlineAt: Date.now() + 60_000,
  inputs: [{ attachmentId: 'att1', sha256: sha(png), slot: 1 }, { attachmentId: 'att2', sha256: sha(encode({ width: 2, height: 2, data: Buffer.alloc(16, 9) })), slot: 2 }],
  masks: [],
  ...over,
})
const plan = (over = {}, inputs = [{ slot: 1, path: target }, { slot: 2, path: reference }]) => ({ kind: 'edit', version: '1', envelope: envelope(over), inputs, masks: [] })

function fakeComfy({ outputs = [{ filename: 'alexia-edit_0001.png', subfolder: '', type: 'output' }], fail, uploadFailsAt } = {}) {
  const log = { uploads: [], queued: [], tidied: [], cancelled: [], progress: [] }
  let n = 0
  return {
    log,
    comfy: {
      upload: async (_server, { name }) => {
        if (uploadFailsAt !== undefined && log.uploads.length === uploadFailsAt) throw new Error('upload refused')
        const up = { name, filename: name, subfolder: '', type: 'input' }
        log.uploads.push(up)
        return up
      },
      queue: async (_server, graph) => {
        log.queued.push(graph)
        return `prompt${++n}`
      },
      wait: async (_server, _id, { onProgress, signal }) => {
        onProgress('Generating — step 1 of 8', 1, 8, { preview: 'data:image/png;base64,AAAA' })
        if (fail) throw new Error(fail)
        if (signal?.aborted) throw new Error('Stopped.')
        return { files: outputs, text: [] }
      },
      download: async () => png,
      cancel: async (_server, id) => log.cancelled.push(id),
      forgetHistory: async (_server, id) => log.forgotten = [...(log.forgotten ?? []), id],
    },
  }
}

const runner = (fake, { managed = true, classes = Object.fromEntries(verified.nodes.map((n) => [n, {}])), profiles = [verified] } = {}) => editRenderer({
  own: () => root,
  profiles,
  comfy: fake.comfy,
  connect: async () => ({ server: 'http://fake', managed, models, classes: async () => classes, tidy: async (f) => fake.log.tidied.push(f.filename) }),
})

describe('profiles', () => {
  test('shipped profiles are installable with publisher hashes and do not claim benchmark evidence', () => {
    for (const p of PROFILES) {
      expect(() => checkProfile(p)).not.toThrow()
      expect(describeProfile(p, { destination: { kind: 'interaction' } }).availability).toBe('needs_installation')
    }
    expect(PROFILES.every((p) => p.status === 'supported' && p.evidence === null)).toBe(true)
    const ready = describeProfile(PROFILES[0], { destination: { kind: 'interaction' }, installed: { ready: true, missing: [], mismatched: [] } })
    expect(ready).toMatchObject({ availability: 'available', measuredMemory: null, evidenceId: null })
  })

  test('a verified profile must carry hashes, sizes, sources and a benchmark', () => {
    expect(() => checkProfile({ ...candidate, status: 'verified' })).toThrow(/prompt slot|evidence|size, hash/)
    expect(() => checkProfile({ ...verified, evidence: null })).toThrow(/evidence/)
    expect(() => checkProfile({ ...verified, artifacts: [{ ...verified.artifacts[0], filename: '../escape' }] })).toThrow(/plain name/)
    expect(() => checkProfile({ ...verified, graph: { ...verified.graph, bindings: [{ node: '4', input: 'image', from: 'path' }] } })).toThrow(/trusted source/)
  })

  test('inventory hashes the files and notices a replaced one', async () => {
    expect(await inventory(verified, models)).toEqual({ ready: true, missing: [], mismatched: [] })
    const vae = join(models, 'vae', 'qwen_image_vae.safetensors')
    writeFileSync(vae, Buffer.from('VAE bytes'))
    forgetHashes()
    expect((await inventory(verified, models)).mismatched).toEqual(['qwen_image_vae.safetensors'])
    writeFileSync(vae, files.vae)
    forgetHashes()
    rmSync(join(models, 'text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'))
    expect((await inventory(verified, models)).missing).toEqual(['qwen_2.5_vl_7b_fp8_scaled.safetensors'])
    writeFileSync(join(models, 'text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'), files.text_encoder)
  })

  test('the picker sees why a profile cannot be used, and available needs evidence and every file', () => {
    const d = { kind: 'interaction' }
    expect(describeProfile(verified, { destination: d, installed: { ready: true, missing: [], mismatched: [] } })).toMatchObject({ availability: 'available', reason: null, evidenceId: 'bench_test' })
    expect(describeProfile(verified, { destination: d, installed: { ready: false, missing: ['x'], mismatched: [] } }).reason).toBe('Needs installation.')
    expect(describeProfile(verified, { destination: { kind: 'paired', hostId: 'h', displayName: 'Studio PC' }, offline: true }).reason).toMatch(/Studio PC/)
  })

  test('settings are checked against the profile, never adjusted', () => {
    const s = { dimensions: { width: 1024, height: 1024 }, preset: null, steps: 8, changeAmount: null, seed: null }
    expect(settingsProblem(verified, 'image_edit', s, 3)).toBeNull()
    expect(settingsProblem(verified, 'inpaint', s, 1)).toMatch(/does not support/)
    expect(settingsProblem(verified, 'image_edit', { ...s, dimensions: { width: 1000, height: 1000 } }, 1)).toMatch(/cannot make 1000×1000/)
    expect(settingsProblem(verified, 'image_edit', { ...s, steps: 400 }, 1)).toMatch(/steps/)
    expect(settingsProblem(verified, 'image_edit', { ...s, changeAmount: 0.5 }, 1)).toMatch(/change-amount/)
    expect(slotNamer(verified)(2)).toBe('Picture 2')
  })
})

describe('graph', () => {
  test('rebuilt from the profile: model names from its files, values only where bound', () => {
    const g = buildGraph(verified, { images: { 1: 'a.png', 2: 'b.png' }, prompt: 'P', seed: 7, steps: 8, width: 832, height: 1216 })
    expect(g['1'].inputs.unet_name).toBe('qwen_image_edit_2509_fp8_e4m3fn.safetensors')
    expect(g['4'].inputs.image).toBe('a.png')
    expect(g['7'].inputs.prompt).toBe('P')
    expect(g['13'].inputs).toMatchObject({ seed: 7, steps: 8 })
    // No third picture: its loader is gone and so is the link to it.
    expect(g['6']).toBeUndefined()
    expect(g['7'].inputs.image3).toBeUndefined()
    expect(g['7'].inputs.image2).toEqual(['5', 0])
  })

  test('the target slot is required', () => {
    expect(() => buildGraph(verified, { images: {}, prompt: 'P', seed: 1, steps: 8, width: 1024, height: 1024 })).toThrow(/missing image:1/)
  })

  test('missing node classes are named', () => {
    expect(missingNodes(verified, { LoadImage: {} })).toContain('TextEncodeQwenImageEditPlus')
  })
})

describe('render boundary', () => {
  test('a verified edit uploads, queues the rebuilt graph, and quarantines exactly one picture', async () => {
    const fake = fakeComfy()
    const reports = []
    const out = await runner(fake)(plan(), { report: (r) => reports.push(r) })
    expect(fake.log.uploads).toHaveLength(2)
    expect(fake.log.queued[0]['4'].inputs.image).toBe(`${sha(png)}.png`)
    expect(fake.log.queued[0]['13'].inputs.seed).toBe(42)
    expect(out).toMatchObject({ width: 4, height: 4, promptId: 'prompt1', cleanup: 'complete' })
    expect(out.file).toContain(join('quarantine', 'run1', 'a1'))
    expect(existsSync(out.file)).toBe(true)
    // ComfyUI's live preview goes out with the step it belongs to; the picture itself stays in quarantine.
    expect(reports).toContainEqual({ message: 'Generating — step 1 of 8', value: 1, total: 8, preview: 'data:image/png;base64,AAAA' })
    expect(reports).toContainEqual({ promptId: 'prompt1' })
    // Everything lent and made was taken back.
    expect(fake.log.tidied.sort()).toEqual([...fake.log.uploads.map((u) => u.filename), 'alexia-edit_0001.png'].sort())
    // The queued graph, prompt text and all, does not stay in ComfyUI's history.
    expect(fake.log.forgotten).toEqual(['prompt1'])
  })

  test('nothing is uploaded when the profile, server, files or nodes do not check out', async () => {
    const cases = [
      [{ profiles: [] }, plan(), 'profile_unavailable'],
      [{}, plan({ graphSha256: '0'.repeat(64) }), 'profile_mismatch'],
      [{ managed: false }, plan(), 'unsupported_server'],
      [{ classes: { LoadImage: {} } }, plan(), 'profile_unavailable'],
      [{ profiles: [{ ...verified, status: 'candidate' }] }, plan({ manifestSha256: manifestSha256({ ...verified, status: 'candidate' }) }), 'profile_unavailable'],
      [{}, plan({}, [{ slot: 1, path: reference }, { slot: 2, path: reference }]), 'attachment_unavailable'],
      [{}, plan({}, [{ slot: 1, path: target }]), 'attachment_unavailable'],
      [{}, { ...plan(), version: '2' }, 'schema_unsupported'],
      [{}, plan({ operation: 'inpaint', masks: [] }), 'schema_unsupported'],
    ]
    for (const [options, p, code] of cases) {
      const fake = fakeComfy()
      await expect(runner(fake, options)(p), code).rejects.toMatchObject({ code })
      expect(fake.log.uploads, code).toHaveLength(0)
      expect(fake.log.queued, code).toHaveLength(0)
    }
  })

  test('a model file replaced on the render host stops the job before upload', async () => {
    const vae = join(models, 'vae', 'qwen_image_vae.safetensors')
    writeFileSync(vae, Buffer.from('other vae'))
    forgetHashes()
    const fake = fakeComfy()
    await expect(runner(fake)(plan())).rejects.toMatchObject({ code: 'profile_unavailable' })
    expect(fake.log.uploads).toHaveLength(0)
    writeFileSync(vae, files.vae)
    forgetHashes()
  })

  test('extra or missing outputs are refused and cleaned up', async () => {
    const two = fakeComfy({ outputs: [{ filename: 'a.png' }, { filename: 'b.png' }] })
    await expect(runner(two)(plan())).rejects.toMatchObject({ code: 'render_failed' })
    expect(two.log.tidied).toEqual(expect.arrayContaining(['a.png', 'b.png']))
    expect(existsSync(join(root, 'quarantine', 'run1', 'a1'))).toBe(false)
  })

  test('a failed upload halfway through still takes back what was uploaded', async () => {
    const fake = fakeComfy({ uploadFailsAt: 1 })
    await expect(runner(fake)(plan())).rejects.toMatchObject({ code: 'render_failed' })
    expect(fake.log.tidied).toEqual([fake.log.uploads[0].filename])
    expect(fake.log.queued).toHaveLength(0)
  })

  test('cancellation cancels only this prompt and cleans up', async () => {
    const controller = new AbortController()
    const fake = fakeComfy()
    const original = fake.comfy.wait
    fake.comfy.wait = async (...args) => {
      controller.abort()
      return original(...args)
    }
    await expect(runner(fake)(plan(), { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fake.log.cancelled).toEqual(['prompt1'])
    expect(fake.log.tidied.length).toBe(2)
  })

  test('out of memory is reported as itself, with no fallback', async () => {
    const fake = fakeComfy({ fail: 'CUDA out of memory' })
    await expect(runner(fake)(plan())).rejects.toMatchObject({ code: 'out_of_memory' })
    expect(fake.log.queued).toHaveLength(1)
  })

  test('a failed tidy is reported as pending cleanup', async () => {
    const fake = fakeComfy()
    const run = editRenderer({
      own: () => root, profiles: [verified], comfy: fake.comfy,
      connect: async () => ({ server: 'x', managed: true, models, classes: async () => Object.fromEntries(verified.nodes.map((n) => [n, {}])), tidy: async () => { throw new Error('offline') } }),
    })
    expect((await run(plan())).cleanup).toBe('pending')
  })

  test('EditError carries a stable reason code', () => {
    expect(new EditError('timeout', 'x').code).toBe('timeout')
  })
})

describe('sweep', () => {
  test('removes only what editing lent: hashed uploads, edit outputs and temp files', async () => {
    const { sweep } = await import('../edit/runtime.js')
    const work = join(root, 'worker')
    for (const f of ['input', 'output', 'temp']) mkdirSync(join(work, f), { recursive: true })
    writeFileSync(join(work, 'input', `${'a'.repeat(64)}.png`), 'x')
    writeFileSync(join(work, 'input', 'their-photo.png'), 'x')
    writeFileSync(join(work, 'output', 'alexia-edit_00001_.png'), 'x')
    writeFileSync(join(work, 'output', 'ComfyUI_00001_.png'), 'x')
    writeFileSync(join(work, 'temp', 'preview.png'), 'x')
    expect(sweep(work)).toBe(3)
    expect(existsSync(join(work, 'input', 'their-photo.png'))).toBe(true)
    expect(existsSync(join(work, 'output', 'ComfyUI_00001_.png'))).toBe(true)
  })
})
