// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { installProfile } from '../edit/install.js'
import { PROFILES } from '../edit/profiles.js'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-edit-install-'))
  roots.push(dir)
  const models = join(dir, 'models')
  const profile = structuredClone(PROFILES[0])
  profile.artifacts = profile.artifacts.map((artifact) => {
    const bytes = Buffer.from(artifact.id)
    return { ...artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const download = vi.fn(async (url, path, options) => {
    const artifact = profile.artifacts.find((a) => a.url === url)
    expect(options).toMatchObject({ expect: artifact.bytes, sha256: artifact.sha256 })
    expect(path).toBe(join(models, artifact.folder, artifact.filename))
    writeFileSync(path, Buffer.from(artifact.id))
  })
  return { dir, models, profile, download, profiles: [profile], selection: { id: profile.id, version: profile.version } }
}

test('installs pinned artifacts into their model folders and verifies the actual bytes', async () => {
  const f = fixture()
  expect(await installProfile(f.selection, f)).toEqual({ ready: true, missing: [], mismatched: [] })
  expect(f.download).toHaveBeenCalledTimes(3)
  expect(readFileSync(join(f.models, 'vae', f.profile.artifacts[2].filename)).toString()).toBe('vae')
})
test('a corrupt completed download does not report installation success', async () => {
  const f = fixture()
  f.download = async (_url, path) => writeFileSync(path, Buffer.from('wrong'))
  await expect(installProfile(f.selection, f)).rejects.toThrow(/file check/)
})
test('an unknown selection cannot download or install a pack', async () => {
  const f = fixture()
  await expect(installProfile({ id: 'unknown', version: '1' }, f)).rejects.toThrow(/Choose/)
  expect(f.download).not.toHaveBeenCalled()
})
test('the GGUF loader pack is added only when absent', async () => {
  const f = fixture()
  f.profile.nodes.push('UnetLoaderGGUF')
  const packs = vi.fn(async () => {
    mkdirSync(join(f.dir, 'custom_nodes', 'ComfyUI-GGUF'), { recursive: true })
  })
  await installProfile(f.selection, { ...f, packs })
  expect(packs).toHaveBeenCalledOnce()
  await installProfile(f.selection, { ...f, packs })
  expect(packs).toHaveBeenCalledOnce()
})
