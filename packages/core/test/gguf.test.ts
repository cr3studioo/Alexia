// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readGguf } from '../src/gguf.js'
import { gguf, metadata, splitFiles, str, u32, u64, type FixtureOptions } from './fixtures/gguf.js'

const dirs: string[] = []
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gguf-test-'))); dirs.push(dir); return dir }
const file = (bytes = gguf()): string => { const path = join(temp(), 'model.gguf'); writeFileSync(path, bytes); return path }
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('bounded GGUF reader', () => {
  test.each([2, 3])('reads version %i metadata, tensor parameters and ordinary file SHA', async (version) => {
    const bytes = gguf({ version }), progress: number[] = []
    const result = await readGguf(file(bytes), { onProgress: p => progress.push(p.done) })
    expect(result).toMatchObject({ version, name: 'Fixture', quant: 'F32', architecture: 'llama', contextMax: 8192,
      kvBytesPerToken: 128, params: 32 / 1e9, tensorCount: 1, bytes: bytes.length, sha256: sha(bytes) })
    expect(result.parts[0]?.sha256).toBe(result.sha256)
    expect(progress.at(-1)).toBe(bytes.length)
  })
  test.each([
    ['magic', Buffer.from('not GGUF')], ['version', gguf({ version: 1 })],
    ['truncated weights', gguf().subarray(0, -1)],
    ['unsafe count', Buffer.concat([Buffer.from('GGUF'), u32(3), u64(2n ** 63n), u64(0)])],
    ['excessive count', Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(100001)])],
  ])('rejects %s', async (_name, bytes) => { await expect(readGguf(file(bytes))).rejects.toThrow() })
  const malformed: [string, FixtureOptions][] = [
    ['duplicate keys', { metadata: [...metadata(), metadata()[0]!] }],
    ['invalid UTF-8', { metadata: [['general.architecture', 8, Buffer.concat([u64(1), Buffer.from([255])])]] }],
    ['missing architecture', { metadata: [] }],
    ['adapter', { metadata: [...metadata(), ['general.type', 8, str('adapter')]] }],
    ['bad alignment', { metadata: [...metadata(), ['general.alignment', 4, u32(3)]] }],
    ['oversized string', { metadata: [['general.name', 8, u64(8192)]] }],
    ['oversized array', { metadata: [['tokenizer.ggml.tokens', 9, Buffer.concat([u32(8), u64(1000001)])]] }],
    ['nested array', { metadata: [['ignored', 9, Buffer.concat([u32(9), u64(0)])]] }],
    ['unknown type', { metadata: [['ignored', 13, Buffer.alloc(0)]] }],
    ['duplicate tensors', { tensors: [{ name: 'w' }, { name: 'w' }] }],
    ['overlapping tensors', { tensors: [{ name: 'w' }, { name: 'x' }] }],
    ['unaligned offset', { tensors: [{ name: 'w', offset: 1 }] }],
    ['quant block shape', { tensors: [{ name: 'w', type: 2, shape: [31] }] }],
    ['unknown tensor type', { tensors: [{ name: 'w', type: 999 }] }],
    ['zero dimension', { tensors: [{ name: 'w', shape: [0] }] }],
    ['oversized tensor', { tensors: [{ name: 'w', shape: [1000000000, 1000000000] }] }],
  ]
  test.each(malformed)('rejects %s before hashing', async (_name, options) => {
    let hashed = false
    await expect(readGguf(file(gguf(options)), { onProgress: () => { hashed = true } })).rejects.toThrow()
    expect(hashed).toBe(false)
  })
  test('tokenizer identity ignores metadata order/name/quant but includes tokens and special IDs', async () => {
    const first = await readGguf(file())
    const entries = metadata().map(([key, type, value]) => [key, type, key === 'general.name' ? str('Other') : key === 'general.file_type' ? u32(1) : value] as [string, number, Buffer]).reverse()
    expect((await readGguf(file(gguf({ metadata: entries })))).tokenizerFingerprint).toBe(first.tokenizerFingerprint)
    for (const key of ['tokenizer.ggml.tokens', 'tokenizer.ggml.bos_token_id']) {
      const changed = metadata().map(([k, t, v]) => [k, t, k !== key ? v : key.endsWith('tokens') ? Buffer.concat([u32(8), u64(3), str('<s>'), str('</s>'), str('bye')]) : u32(1)] as [string, number, Buffer])
      expect((await readGguf(file(gguf({ metadata: changed })))).tokenizerFingerprint).not.toBe(first.tokenizerFingerprint)
    }
  })
  test('partial tokenizer metadata cannot establish draft compatibility', async () => {
    for (const missing of ['tokenizer.ggml.model', 'tokenizer.ggml.tokens']) {
      expect((await readGguf(file(gguf({ metadata: metadata().filter(([key]) => key !== missing) })))).tokenizerFingerprint).toBeUndefined()
    }
    for (const value of [Buffer.concat([u32(4), u64(1), u32(0)]), Buffer.concat([u32(8), u64(0)])]) {
      const entries = metadata().filter(([key]) => key !== 'tokenizer.ggml.tokens')
      entries.push(['tokenizer.ggml.tokens', 9, value])
      await expect(readGguf(file(gguf({ metadata: entries })))).rejects.toThrow(/vocabulary/)
    }
  })
  test('discovers ordered splits from either shard and hashes the whole group', async () => {
    const files = splitFiles(temp()), result = await readGguf(files[1]!)
    expect(result.files).toEqual(files)
    expect(result.sha256).toBe(sha(Buffer.concat(files.map(f => readFileSync(f)))))
    expect(result.parts.map(p => p.sha256)).toEqual(files.map(f => sha(readFileSync(f))))
    expect(result.tensorCount).toBe(2)
    expect((await readGguf(files[0]!)).sha256).toBe(result.sha256)
  })
  test('rejects missing, mislabeled, aliased and inconsistent splits', async () => {
    const files = splitFiles(temp())
    rmSync(files[1]!)
    await expect(readGguf(files[0]!)).rejects.toThrow()
    linkSync(files[0]!, files[1]!)
    await expect(readGguf(files[0]!)).rejects.toThrow(/aliases/)
    rmSync(files[1]!)
    symlinkSync(files[0]!, files[1]!)
    await expect(readGguf(files[0]!)).rejects.toThrow(/distinct/)
    writeFileSync(join(temp(), 'fake-00001-of-00002.gguf'), gguf())
    await expect(readGguf(join(dirs.at(-1)!, 'fake-00001-of-00002.gguf'))).rejects.toThrow(/missing split/)
    for (const second of [{ tensors: [{ name: 'weight.0' }] }, { version: 2 },
      { metadata: metadata().map(([k, t, v]) => [k, t, k === 'general.architecture' ? str('qwen2') : v] as [string, number, Buffer]) }]) {
      const group = splitFiles(temp(), second)
      await expect(readGguf(group[0]!)).rejects.toThrow(/Duplicate|Mismatched|Conflicting/)
    }
  })
  test('cancellation and mutation during streaming never return an identity', async () => {
    const path = file()
    await expect(readGguf(path, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    const cancel = new AbortController()
    await expect(readGguf(path, { signal: cancel.signal, onProgress: () => cancel.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readGguf(path, { onProgress: () => writeFileSync(path, gguf({ payload: Buffer.alloc(128, 8) })) })).rejects.toThrow(/changed/)
  })
})
