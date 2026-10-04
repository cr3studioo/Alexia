// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { CANDIDATES } from './profiles/candidates.js'

/**
 * Which editing models exist, exactly — and which of them may be used on this computer.
 *
 * **A profile is a trusted, versioned description of one complete execution path**: the exact
 * files with their sizes and hashes, the node classes, the fixed graph, the prompt syntax its
 * slots are referred to by, and the settings it supports. The planner chooses none of it; the
 * person chooses a profile and its supported settings, and this file says whether that is
 * possible.
 *
 * **Nothing is available without evidence.** A profile is `available` only when it is verified
 * — real hashes and a recorded benchmark with measured memory — and every artifact on the
 * render host matches its hash. A candidate is listed so the picker can say what it is waiting
 * for, never so it can be run. This file invents no hashes, sizes or memory figures; Step 0
 * puts them in `profiles/` when they have been measured.
 */

export const FOLDERS = ['checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras']
export const SOURCES = ['image:1', 'image:2', 'image:3', 'mask', 'prompt', 'negative', 'seed', 'steps', 'cfg', 'width', 'height']

/**
 * A profile is checked before it is believed — including the ones shipped in this folder, so a
 * typo in a manifest is a failing test rather than a render that loads the wrong file.
 */
export function checkProfile(p) {
  const fail = (why) => {
    throw new Error(`Profile ${p?.id ?? '?'}@${p?.version ?? '?'}: ${why}`)
  }
  if (!/^[a-z0-9-]{1,64}$/.test(p?.id ?? '')) fail('id is not a plain name')
  if (typeof p.version !== 'string' || p.version === '') fail('needs a version')
  if (!['candidate', 'verified'].includes(p.status)) fail('status is candidate or verified')
  if (typeof p.uncensored !== 'boolean') fail('says whether it is uncensored, from its publisher\'s documentation')
  if (!Array.isArray(p.operations) || p.operations.length === 0) fail('supports no operation')
  if (!Number.isInteger(p.maxInputs) || p.maxInputs < 1 || p.maxInputs > 3) fail('maxInputs is 1 to 3')
  if (p.status === 'verified') {
    if (typeof p.prompt?.slot !== 'string' || !p.prompt.slot.includes('{n}')) fail('a verified profile names its prompt slot syntax')
    if (!p.evidence?.id || !Number.isInteger(p.evidence.gpuBytes) || !Number.isInteger(p.evidence.hostBytes)) fail('a verified profile carries its benchmark evidence')
    if (p.artifacts.length === 0) fail('a verified profile lists its files')
  }
  for (const a of p.artifacts ?? []) {
    if (!FOLDERS.includes(a.folder)) fail(`${a.filename} is in an unknown folder`)
    if (typeof a.filename !== 'string' || a.filename.includes('/') || a.filename.includes('\\') || a.filename.startsWith('.')) fail('a filename is a plain name')
    if (p.status === 'verified' && (!/^[a-f0-9]{64}$/.test(a.sha256 ?? '') || !Number.isInteger(a.bytes) || !a.url || !a.license)) {
      fail(`${a.filename} needs its size, hash, source and licence`)
    }
  }
  for (const b of p.graph?.bindings ?? []) {
    if (!SOURCES.includes(b.from)) fail(`binding from ${b.from} is not a trusted source`)
    if (!p.graph.nodes?.[b.node]?.inputs) fail(`binding names missing node ${b.node}`)
  }
  for (const b of p.graph?.artifacts ?? []) {
    if (!(p.artifacts ?? []).some((a) => a.id === b.artifact)) fail(`graph loads unknown artifact ${b.artifact}`)
    if (!p.graph.nodes?.[b.node]?.inputs) fail(`artifact binding names missing node ${b.node}`)
  }
  if (!p.graph?.nodes || Object.keys(p.graph.nodes).length === 0) fail('has no graph')
  if (!p.graph.output || !p.graph.nodes[p.graph.output]) fail('names no output node')
  return p
}

export const PROFILES = CANDIDATES.map(checkProfile)

/** Stable bytes for hashing: keys sorted at every level. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex')
export const manifestSha256 = (profile) => digest(profile)
export const graphSha256 = (profile) => digest(profile.graph)

export function find(selection, profiles = PROFILES) {
  return profiles.find((p) => p.id === selection?.id && p.version === selection?.version) ?? null
}

/**
 * Hashing seven gigabytes takes a minute, so a file is hashed once per size and modification
 * time. Replacing it changes both, and the next check hashes again — a filename that matches
 * never stands in for bytes that do.
 */
const hashed = new Map()

export async function sha256File(path, signal) {
  const found = await stat(path)
  const key = `${path}\0${found.size}\0${found.mtimeMs}`
  if (hashed.has(key)) return hashed.get(key)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  const out = hash.digest('hex')
  hashed.set(key, out)
  return out
}
export const forgetHashes = () => hashed.clear()

/**
 * Every artifact of a profile on this host, checked: `{ ready, missing, mismatched }`.
 *
 * `models` is the managed ComfyUI's models folder. Paths are built from trusted folder and file
 * names and still checked to stay inside it.
 */
export async function inventory(profile, models, { signal } = {}) {
  const missing = []
  const mismatched = []
  const root = resolve(models)
  for (const a of profile.artifacts) {
    const path = resolve(join(root, a.folder, a.filename))
    if (!path.startsWith(root + sep)) {
      mismatched.push(a.filename)
      continue
    }
    let found
    try {
      found = await stat(path)
    } catch {
      missing.push(a.filename)
      continue
    }
    if (!found.isFile() || (a.bytes !== undefined && a.bytes !== null && found.size !== a.bytes)) {
      mismatched.push(a.filename)
      continue
    }
    if (!a.sha256 || (await sha256File(path, signal)) !== a.sha256) mismatched.push(a.filename)
  }
  return { ready: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

/**
 * What the picker shows for one profile, as the `ProfileDescriptor` contract has it.
 *
 * `installed` is the result of {@link inventory} on the chosen host, or null when the host could
 * not be asked. Availability is never better than the evidence: an unverified profile is
 * `unverified` even when every file is present.
 */
export function describeProfile(profile, { destination, installed = null, offline = false }) {
  let availability = 'available'
  let reason = null
  if (profile.status !== 'verified' || !profile.evidence) {
    availability = 'unverified'
    reason = 'Not measured on supported hardware yet, so it cannot be used.'
  } else if (offline) {
    availability = 'offline'
    reason = `${destination.kind === 'paired' ? destination.displayName : 'This computer'} is not reachable.`
  } else if (!installed || installed.missing.length > 0) {
    availability = 'needs_installation'
    reason = 'Needs installation.'
  } else if (installed.mismatched.length > 0) {
    availability = 'incompatible'
    reason = `${installed.mismatched[0]} is not the expected file. Reinstall this model.`
  }
  const steps = profile.settings?.steps ?? null
  return {
    selection: { id: profile.id, version: profile.version },
    name: profile.name,
    uncensored: profile.uncensored === true,
    operations: [...profile.operations],
    jobVersions: [...profile.jobVersions],
    maxInputs: profile.maxInputs,
    destination,
    availability,
    reason,
    evidenceId: profile.evidence?.id ?? null,
    measuredMemory: profile.evidence ? { gpuBytes: profile.evidence.gpuBytes, hostBytes: profile.evidence.hostBytes } : null,
    dimensions: profile.settings.dimensions.map((d) => ({ ...d })),
    controls: {
      presets: (profile.settings.presets ?? []).map((p) => p.id),
      steps: steps && { ...steps },
      changeAmount: null,
      seed: { ...profile.settings.seed },
    },
    batchSize: 1,
  }
}

/**
 * Do the person's chosen settings fit this profile? Returns the reason they do not, or null.
 * Never adjusts anything: a size the model cannot make is shown to the person, not rounded.
 */
export function settingsProblem(profile, operation, settings, inputs) {
  if (!profile.operations.includes(operation)) return `This model does not support ${operation.replace('_', ' ')}.`
  if (inputs > profile.maxInputs) return `This model takes at most ${profile.maxInputs} pictures.`
  if (!profile.settings.dimensions.some((d) => d.width === settings.dimensions.width && d.height === settings.dimensions.height)) {
    return `This model cannot make ${settings.dimensions.width}×${settings.dimensions.height}.`
  }
  if (settings.steps !== null) {
    const s = profile.settings.steps
    if (!s || settings.steps < s.min || settings.steps > s.max) return 'That number of steps is outside what this model supports.'
  }
  if (settings.preset !== null && !(profile.settings.presets ?? []).some((p) => p.id === settings.preset)) return 'That quality preset is not one this model has.'
  if (settings.changeAmount !== null) return 'This model has no verified change-amount control.'
  if (settings.seed !== null && (settings.seed < profile.settings.seed.min || settings.seed > profile.settings.seed.max)) return 'That seed is outside this model\'s range.'
  return null
}

/** How the compiled prompt names a slot, from the profile — the syntax Step 0 verified. */
export const slotNamer = (profile) => (n) => profile.prompt.slot.replace('{n}', String(n))
