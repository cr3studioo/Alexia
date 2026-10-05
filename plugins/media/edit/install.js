// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchModel } from '../models.js'
import { installPacks, present } from '../library/packs.js'
import { find, inventory, PROFILES } from './profiles.js'

/** Install only the publisher-pinned files of the explicitly selected editing profile. */
export async function installProfile(selection, { models, dir, signal, report = () => {}, download = fetchModel, packs = installPacks, profiles = PROFILES }) {
  const profile = find(selection, profiles)
  if (!profile || profile.status === 'candidate') throw new Error('Choose an installable editing model.')
  if (!models || !dir) throw new Error('Install the managed ComfyUI on the picture computer first.')
  for (const artifact of profile.artifacts) {
    await mkdir(join(models, artifact.folder), { recursive: true })
    await download(artifact.url, join(models, artifact.folder, artifact.filename), {
      expect: artifact.bytes, sha256: artifact.sha256, signal,
      onProgress: (done, total, message) => report(`${artifact.filename}: ${message}`, done, total),
    })
  }
  if (profile.nodes.includes('UnetLoaderGGUF')) {
    const wanted = [{ name: 'ComfyUI-GGUF', registry: 'comfyui-gguf', nodes: ['UnetLoaderGGUF'] }]
    const missing = (await present(wanted, { dir })).filter((pack) => !pack.have)
    if (missing.length) await packs(missing, { dir, signal, onProgress: (done, total, message) => report(message, done, total) })
  }
  const installed = await inventory(profile, models, { signal })
  if (!installed.ready) throw new Error('Editing model installation did not pass the file check.')
  return installed
}
