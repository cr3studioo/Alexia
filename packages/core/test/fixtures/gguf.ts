// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
export const u64 = (n: number | bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export const str = (s: string): Buffer => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]) }
export type Metadata = [string, number, Buffer]
export interface FixtureOptions {
  version?: number
  metadata?: Metadata[]
  tensors?: { name: string; shape?: number[]; type?: number; offset?: number }[]
  payload?: Buffer
}
export function metadata(): Metadata[] {
  return [
    ['general.architecture', 8, str('llama')], ['general.name', 8, str('Fixture')],
    ['general.file_type', 4, u32(0)], ['llama.context_length', 4, u32(8192)],
    ['llama.block_count', 4, u32(2)], ['llama.embedding_length', 4, u32(32)],
    ['llama.attention.head_count', 4, u32(4)], ['llama.attention.head_count_kv', 4, u32(2)],
    ['tokenizer.ggml.model', 8, str('llama')],
    ['tokenizer.ggml.tokens', 9, Buffer.concat([u32(8), u64(3), str('<s>'), str('</s>'), str('hello')])],
    ['tokenizer.ggml.bos_token_id', 4, u32(0)],
  ]
}
/** Tiny structural GGUF, with actual tensor bytes, never used for inference. */
export function gguf(options: FixtureOptions = {}): Buffer {
  const entries = options.metadata ?? metadata()
  const tensors = options.tensors ?? [{ name: 'weight' }]
  const header = Buffer.concat([
    Buffer.from('GGUF'), u32(options.version ?? 3), u64(tensors.length), u64(entries.length),
    ...entries.flatMap(([key, type, value]) => [str(key), u32(type), value]),
    ...tensors.flatMap(({ name, shape = [32], type = 0, offset = 0 }) => [str(name), u32(shape.length), ...shape.map(u64), u32(type), u64(offset)]),
  ])
  return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), options.payload ?? Buffer.alloc(128, 7)])
}
export function splitFiles(dir: string, second: FixtureOptions = {}): string[] {
  return [0, 1].map((i) => {
    const path = join(dir, `fixture-${String(i + 1).padStart(5, '0')}-of-00002.gguf`)
    const options = i ? second : {}
    writeFileSync(path, gguf({ ...options, metadata: [...(options.metadata ?? metadata()),
      ['split.no', 2, Buffer.from([i, 0])], ['split.count', 2, Buffer.from([2, 0])], ['split.tensors.count', 5, u32(2)]],
    tensors: options.tensors ?? [{ name: `weight.${i}` }] }))
    return path
  })
}
