// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ALEXIA_PROTOCOL_MAX,
  ALEXIA_PROTOCOL_MIN,
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
  const base = { name: 'Voice', alexia_protocol: ALEXIA_PROTOCOL_MAX, mcp_protocol: MCP_PINNED }

  test('the pinned pair loads', () => {
    expect(versionVerdict(base)).toEqual({ ok: true })
  })

  test('one revision back loads, which is the whole of the promise', () => {
    expect(versionVerdict({ ...base, alexia_protocol: ALEXIA_PROTOCOL_MAX - 1 })).toEqual({ ok: true })
  })

  test('two revisions back is refused, in words that name the way out', () => {
    // What raising `MIN` is *for*. It happened for the first time at 3 (D86), and the
    // sentence has to send somebody to the plugin's update rather than to a stack trace.
    const v = versionVerdict({ ...base, alexia_protocol: ALEXIA_PROTOCOL_MIN - 1 })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('written for an older version')
    expect(v.ok === false && v.reason).toContain('has an update')
  })

  test('a plugin from the future is refused in words a person can act on', () => {
    const v = versionVerdict({ ...base, alexia_protocol: 99 })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('Voice needs a newer Alexia')
  })

  test('an MCP revision outside the two-wide window is refused, and says which two', () => {
    const v = versionVerdict({ ...base, mcp_protocol: '2024-11-05' })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('2025-11-25 and 2026-07-28')
    expect(v.ok === false && v.reason).toContain('2024-11-05')
  })
})

describe('panel — a tab a plugin declares (M6-2, D86)', () => {
  const withPanel = (panel: unknown, revision = 3): Record<string, unknown> => ({
    ...structuredClone(voice),
    alexia_protocol: revision,
    panel,
  })
  const ok = { label: 'Voice', widgets: [{ key: 'clips', type: 'status', label: 'Clips' }] }

  test('a plugin declares a tab the same way it declares settings', () => {
    const r = Manifest.safeParse(withPanel(ok))
    expect(r.success ? null : r.error.issues).toBe(null)
  })

  test('declaring one while claiming an older revision is a load error', () => {
    // The rule `lifetime` established: an integer a manifest can quietly ignore is an
    // integer that means nothing, and the machine running yesterday's build is where that
    // gets found otherwise.
    const r = Manifest.safeParse(withPanel(ok, 2))
    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues.map((i) => i.path.join('.'))).toContain('panel')
  })

  test('a panel with no widgets is not a panel', () => {
    expect(Manifest.safeParse(withPanel({ label: 'Voice', widgets: [] })).success).toBe(false)
  })

  test('the widget rules are the widget rules, wherever they are declared', () => {
    const bent = withPanel({
      label: 'Voice',
      widgets: [{ key: 'size', type: 'choice', label: 'Size', options: ['tiny'], default: 'enormous' }],
    })
    const r = Manifest.safeParse(bent)
    expect(r.success).toBe(false)
    // And the path points at what the author wrote, not at the list core happened to check.
    expect(r.success === false && r.error.issues.map((i) => i.path.join('.'))).toContain('panel.widgets.0.default')
  })

  test('two widgets on one panel cannot share a key', () => {
    const clash = withPanel({
      label: 'Voice',
      widgets: [
        { key: 'clips', type: 'status', label: 'Clips' },
        { key: 'clips', type: 'status', label: 'Clips again' },
      ],
    })
    expect(Manifest.safeParse(clash).success).toBe(false)
  })

  test('a graph is refused on revision 3, and drawn on 4 (D115)', () => {
    const map = {
      label: 'Voice',
      widgets: [{ key: 'shape', type: 'graph', label: 'The shape of it', rows: 'list_things' }],
    }
    // The same rule `panel` and `lifetime` set: an older core would refuse this manifest as
    // unparseable, which tells an author nothing about which end is out of date.
    const old = Manifest.safeParse(withPanel(map, 3))
    expect(old.success).toBe(false)
    expect(old.success === false && old.error.issues.map((i) => i.message).join()).toContain('alexia_protocol": 4')

    const now = Manifest.safeParse(withPanel(map, 4))
    expect(now.success ? null : now.error.issues).toBe(null)
  })

  test('a key declared on both screens is a load error, because it is one stored value', () => {
    const shared = withPanel({
      label: 'Voice',
      // `download_state` is already a `progress` widget in the example's settings list.
      widgets: [{ key: 'download_state', type: 'status', label: 'Download' }],
    })
    const r = Manifest.safeParse(shared)
    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues.map((i) => i.message).join()).toContain('one namespace')
  })
})

test('the checked-in JSON Schema matches the zod schema', () => {
  // Editors validate against the file, core validates against zod. If they drift, the
  // author is told their manifest is fine right up until it does not load.
  const onDisk = read(...SCHEMA_PATH)
  expect(onDisk).toEqual(pluginJsonSchema())
})
