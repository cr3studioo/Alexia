#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * **Step 0's harness: measure one editing profile on the machine it is meant for.**
 *
 *   node plugins/media/edit/benchmarks/run.mjs --profile qwen-image-edit-2509 --server http://127.0.0.1:8288 \
 *     --models /path/to/ComfyUI/models --images ./fixtures --out ./plugins/media/edit/benchmarks
 *
 * It runs the plan's matrix against an already running ComfyUI that this machine's Alexia
 * installed: for each supported input count (1, 2, 3), one cold run and three warm runs at the
 * profile's default size and at its largest, each through the same fixed graph the editor uses.
 * It records wall time, the graphics card's peak use as ComfyUI reports it, this process's view
 * of host memory, any failure verbatim, and the exact files' sizes and hashes — then writes one
 * JSON record. **It decides nothing**: a person reads the record, judges role adherence and drift
 * against the fixture rubric, and only then may a verified profile be written from it.
 *
 * Nothing here downloads anything. Missing files are reported, not fetched.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { freemem, totalmem, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import * as comfy from '../../comfy.js'
import { bytesOf } from '../../inputs.js'
import { buildGraph } from '../graph.js'
import { CANDIDATES } from '../profiles/candidates.js'
import { graphSha256, manifestSha256 } from '../profiles.js'

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const profile = CANDIDATES.find((p) => p.id === arg('profile', CANDIDATES[0].id))
if (!profile) throw new Error('No such candidate profile.')
const server = arg('server', 'http://127.0.0.1:8288')
const models = arg('models')
const images = arg('images')
const out = arg('out', join(import.meta.dirname))
if (!models || !images) {
  console.error('Pass --models (the managed ComfyUI models folder) and --images (a folder of licensed or consented PNG fixtures).')
  process.exit(2)
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const artifacts = profile.artifacts.map((a) => {
  const path = join(models, a.folder, a.filename)
  try {
    return { ...a, bytes: statSync(path).size, sha256: hash(path) }
  } catch {
    return { ...a, missing: true }
  }
})
if (artifacts.some((a) => a.missing)) {
  console.error(`Missing: ${artifacts.filter((a) => a.missing).map((a) => a.filename).join(', ')}`)
  process.exit(3)
}

const fixtures = readdirSync(images).filter((n) => n.endsWith('.png')).sort().map((n) => join(images, n))
if (fixtures.length < 3) throw new Error('Put at least three PNG fixtures in --images.')
const stats = async () => comfy.stats(server).catch(() => undefined)
const card = (s) => s?.devices?.find((d) => d.type === 'cuda' || d.type === 'mps')

async function once(inputs, size, seed) {
  const uploaded = []
  for (const path of inputs) uploaded.push(await comfy.upload(server, { ...bytesOf(path), name: `${hash(path)}.png` }))
  const graph = buildGraph(profile, {
    images: Object.fromEntries(uploaded.map((u, i) => [i + 1, u.name])),
    prompt: 'Edit Picture 1. Use only the clothing from Picture 2. Keep the identity of Picture 1 unchanged.',
    seed, steps: profile.settings.steps.default, width: size.width, height: size.height,
  })
  let peak = 0
  const begun = Date.now()
  const polling = setInterval(async () => {
    const c = card(await stats())
    if (c) peak = Math.max(peak, Number(c.vram_total) - Number(c.vram_free))
  }, 500)
  try {
    const id = await comfy.queue(server, graph)
    const done = await comfy.wait(server, id, { timeoutMs: 30 * 60_000 })
    await comfy.forgetHistory(server, id).catch(() => {})
    return { ok: true, ms: Date.now() - begun, peakGpuBytes: peak, hostFreeBytes: freemem(), outputs: done.files.length }
  } catch (error) {
    return { ok: false, ms: Date.now() - begun, peakGpuBytes: peak, error: String(error?.message ?? error) }
  } finally {
    clearInterval(polling)
  }
}

const sizes = [profile.settings.dimensions[0], [...profile.settings.dimensions].sort((a, b) => b.width * b.height - a.width * a.height)[0]]
const matrix = []
for (let count = 1; count <= profile.maxInputs; count++) {
  for (const size of sizes) {
    const runs = []
    for (let i = 0; i < 4; i++) runs.push({ kind: i === 0 ? 'cold' : 'warm', ...(await once(fixtures.slice(0, count), size, 1000 + i)) })
    matrix.push({ inputs: count, size, runs })
    console.error(`${count} input(s) at ${size.width}×${size.height}: ${runs.map((r) => (r.ok ? `${Math.round(r.ms / 1000)}s` : 'FAILED')).join(', ')}`)
  }
}

const machine = await stats()
const record = {
  profile: { id: profile.id, version: profile.version, manifestSha256: manifestSha256(profile), graphSha256: graphSha256(profile) },
  artifacts: artifacts.map(({ id, folder, filename, bytes, sha256 }) => ({ id, folder, filename, bytes, sha256 })),
  machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, hostBytes: totalmem(), comfy: machine?.system, device: card(machine) },
  at: new Date().toISOString(),
  matrix,
  // To be filled in by the person who reads the outputs: role adherence, identity drift,
  // unintended style transfer, against the fixture rubric chosen before running.
  judgement: null,
}
mkdirSync(out, { recursive: true })
const file = join(out, `${profile.id}-${record.at.slice(0, 10)}.json`)
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
console.error(`Wrote ${file}. Nothing is verified until a person has judged the outputs and written a verified profile from this record.`)
