// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { importGguf } from '../src/importModel.js'
import { readGguf } from '../src/gguf.js'
import { gguf, splitFiles } from './fixtures/gguf.js'

const dirs: string[] = []
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'import-gguf-test-'))); dirs.push(dir); return dir }
const source = (): string => { const path = join(temp(), 'source.gguf'); writeFileSync(path, gguf()); return path }
const storage = (dir: string): string => join(dir, 'models', 'text', 'import')
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('GGUF import', () => {
  test('reference keeps canonical sources, creates no managed storage and marks capabilities unknown', async () => {
    const path = source(), dataDir = temp(), link = join(temp(), 'linked.gguf')
    symlinkSync(path, link)
    const model = await importGguf(link, dataDir, { mode: 'reference' })
    expect(model).toMatchObject({ files: [path], owned: false, imported: true, ready: false, format: 'gguf',
      tools: false, vision: false, vetted: false, nsfwOk: 'unknown', architecture: 'llama', context: 8192 })
    expect(model.sha256).toBe((await readGguf(path)).sha256)
    expect(readdirSync(dataDir)).toEqual([])
  })
  test.each([false, true])('copy verifies and reuses the complete import (split=%s)', async (split) => {
    const paths = split ? splitFiles(temp()) : [source()], dataDir = temp(), phases = new Set<string>()
    const model = await importGguf(paths.at(-1)!, dataDir, { onProgress: p => phases.add(p.phase) })
    expect(model.owned).toBe(true)
    expect(model.files).toEqual(paths.map(p => join(storage(dataDir), model.sha256!, basename(p))))
    expect(model.files.map(p => readFileSync(p))).toEqual(paths.map(p => readFileSync(p)))
    expect(phases).toEqual(new Set(['read', 'copy', 'verify']))
    expect((await readGguf(model.files[0]!)).sha256).toBe(model.sha256)
    expect((await importGguf(paths[0]!, dataDir)).id).toBe(model.id)
    expect(readdirSync(storage(dataDir))).toEqual([model.sha256])
    for (const p of paths) rmSync(p)
    expect((await readGguf(model.files[0]!)).sha256).toBe(model.sha256)
  })
  test('reference split includes every source in order', async () => {
    const paths = splitFiles(temp())
    expect((await importGguf(paths[1]!, temp(), { mode: 'reference' })).files).toEqual(paths)
  })
  test('rejects existing copy tampering without overwriting it or its source', async () => {
    const path = source(), dataDir = temp(), model = await importGguf(path, dataDir)
    const tampered = gguf({ payload: Buffer.alloc(128, 9) })
    writeFileSync(model.files[0]!, tampered)
    await expect(importGguf(path, dataDir)).rejects.toThrow(/checksum/)
    expect(readFileSync(model.files[0]!)).toEqual(tampered)
    expect(readFileSync(path)).toEqual(gguf())
    expect(readdirSync(storage(dataDir))).toEqual([model.sha256])
  })
  test.each(['copy', 'verify'] as const)('cancellation during %s removes only this staging import', async (phase) => {
    const path = source(), dataDir = temp(), cancel = new AbortController()
    mkdirSync(storage(dataDir), { recursive: true })
    writeFileSync(join(storage(dataDir), 'unrelated'), 'keep')
    await expect(importGguf(path, dataDir, { signal: cancel.signal, onProgress: p => { if (p.phase === phase) cancel.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirSync(storage(dataDir))).toEqual(['unrelated'])
    expect(readFileSync(path)).toEqual(gguf())
    expect((await importGguf(path, dataDir)).owned).toBe(true)
  })
  test('source mutation after copying is rejected and staging is cleaned', async () => {
    const path = source(), dataDir = temp()
    await expect(importGguf(path, dataDir, { onProgress: p => {
      if (p.phase === 'copy') writeFileSync(path, gguf({ payload: Buffer.alloc(128, 3) }))
    } })).rejects.toThrow(/changed/)
    expect(readdirSync(storage(dataDir))).toEqual([])
    expect(readFileSync(path)).toEqual(gguf({ payload: Buffer.alloc(128, 3) }))
  })
  test('refuses linked managed directories and leaves external contents alone', async () => {
    const dataDir = temp(), outside = temp()
    symlinkSync(outside, join(dataDir, 'models'), 'dir')
    await expect(importGguf(source(), dataDir)).rejects.toThrow(/symbolic links/)
    expect(readdirSync(outside)).toEqual([])
  })
  test('pre-cancellation and malformed input never create an import directory', async () => {
    const dataDir = temp()
    await expect(importGguf(source(), dataDir, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    const invalid = source(); writeFileSync(invalid, 'invalid')
    await expect(importGguf(invalid, dataDir)).rejects.toThrow()
    expect(existsSync(storage(dataDir))).toBe(false)
  })
})
