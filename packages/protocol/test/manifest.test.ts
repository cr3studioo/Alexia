// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  Manifest,
  MCP_PINNED,
  pluginJsonSchema,
  SCHEMA_PATH,
  versionVerdict,
  type ManifestInput,
} from '../src/index.js'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const read = (...p: string[]) => JSON.parse(readFileSync(join(repoRoot, ...p), 'utf8'))

const voice = read('docs', 'spec', 'plugin.example.json') as ManifestInput

/** The example manifest with one field bent. Returns the list of paths that failed. */
function reject(bend: (m: Record<string, unknown>) => void): string[] {
  const m = structuredClone(voice) as Record<string, unknown>
  bend(m)
  const r = Manifest.safeParse(m)
  expect(r.success, 'expected this manifest to be rejected').toBe(false)
  // An unrecognised key is reported at the root with the offending names attached, so
  // name it directly — that is what the author needs to read.
  return r.success
    ? []
    : r.error.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : [i.path.join('.')]))
}

test('the voice manifest is valid', () => {
  const r = Manifest.safeParse(voice)
  expect(r.success ? null : r.error.issues).toBe(null)
})

// P0-4's acceptance criterion, one test per mistake. Each is a mistake a real author
// makes, not a synthetic one — a wrong `id`, a default that is not an option, a namespace
// that drifted from the folder name after a rename.
describe('six deliberate mistakes', () => {
  test('1. an id that is not lowercase-and-hyphens', () => {
    expect(reject((m) => (m.id = 'Voice_Plugin'))).toContain('id')
  })

  test('2. a manifest_version this Alexia does not know', () => {
    expect(reject((m) => (m.manifest_version = 2))).toContain('manifest_version')
  })

  test('3. a required capability with no reason given', () => {
    // `why` is what the user reads when asked to allow it. A capability with no reason
    // is a permission prompt with nothing in it.
    const paths = reject((m) => delete (m.requires as Record<string, unknown>[])[0]!.why)
    expect(paths).toContain('requires.0.why')
  })

  test('4. a choice whose default is not one of its options', () => {
    const paths = reject(
      (m) => ((m.settings as Record<string, unknown>[])[0]!.default = 'enormous'),
    )
    expect(paths).toContain('settings.0.default')
  })

  test('5. a storage namespace that does not match the id', () => {
    const paths = reject((m) => ((m.storage as Record<string, unknown>).namespace = 'speech'))
    expect(paths).toContain('storage.namespace')
  })

  test('6. a settings widget type that does not exist', () => {
    // There are ten widgets and no eleventh. A plugin cannot style itself wrong because
    // it never styles itself — a private widget type would re-open that door.
    expect(reject((m) => ((m.settings as Record<string, unknown>[])[0]!.type = 'slider'))).not
      .toHaveLength(0)
  })
})

describe('and four more that would hurt later', () => {
  test('an unknown top-level key is not silently ignored', () => {
    // The failure this prevents: `provide` instead of `provides` — a plugin that asks for
    // nothing, loads happily, and fails at the first capability call.
    expect(reject((m) => (m.provide = ['voice.speak']))).toContain('provide')
  })

  test('an absolute path in entry.run', () => {
    expect(reject((m) => ((m.entry as Record<string, unknown>).run = 'C:\\Program Files\\node.exe')))
      .toContain('entry.run')
  })

  test('a version that is not a semantic version', () => {
    expect(reject((m) => (m.version = 'v0.1'))).toContain('version')
  })

  test('a skill path that climbs out of the plugin folder', () => {
    expect(reject((m) => (m.skills = ['../../etc/passwd']))).toContain('skills.0')
  })
})

describe('the two version checks', () => {
  const base = { name: 'Voice', alexia_protocol: 1, mcp_protocol: MCP_PINNED }

  test('the pinned pair loads', () => {
    expect(versionVerdict(base)).toEqual({ ok: true })
  })

  test('a plugin from the future is refused in words a person can act on', () => {
    const v = versionVerdict({ ...base, alexia_protocol: 99 })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('Voice needs a newer Alexia')
  })

  test('an MCP revision outside the two-wide window is refused, and says which two', () => {
    const v = versionVerdict({ ...base, mcp_protocol: '2024-11-05' })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('2026-07-28 and 2025-11-25')
    expect(v.ok === false && v.reason).toContain('2024-11-05')
  })
})

test('the checked-in JSON Schema matches the zod schema', () => {
  // Editors validate against the file, core validates against zod. If they drift, the
  // author is told their manifest is fine right up until it does not load.
  const onDisk = read(...SCHEMA_PATH)
  expect(onDisk).toEqual(pluginJsonSchema())
})
