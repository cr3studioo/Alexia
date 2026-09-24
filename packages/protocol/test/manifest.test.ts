// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ALEXIA_PROTOCOL_MAX,
  ALEXIA_PROTOCOL_MIN,
  Manifest,
  MCP_PINNED,
  pageOf,
  pluginJsonSchema,
  SCHEMA_PATH,
  versionVerdict,
  type ManifestInput,
} from '../src/index.js'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const read = (...p: string[]) => JSON.parse(readFileSync(join(repoRoot, ...p), 'utf8'))

const example = read('docs', 'spec', 'plugin.example.json') as ManifestInput
/**
 * The example as it was before it had a page: revision 2 and no `page`. Most of the tests
 * below bend one field and lower the revision to the one that field arrived in, and a `page`
 * riding along would be refused at every revision under 11 for a reason none of them is about.
 */
const unpaged: Record<string, unknown> = { ...example, alexia_protocol: 2 }
delete unpaged.page
const voice = unpaged as ManifestInput

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
  const r = Manifest.safeParse(example)
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

test('groupOrder arrived in revision 8, and a manifest claiming 7 is told so', () => {
  const table = {
    key: 'things',
    type: 'table',
    label: 'Things',
    rows: 'list_things',
    columns: [{ key: 'name', label: 'Name' }],
    groupBy: 'group',
    groupOrder: ['Open', 'Closed'],
  }
  const withTable = (revision: number): Record<string, unknown> => {
    const m = structuredClone(voice) as Record<string, unknown>
    m.alexia_protocol = revision
    m.panel = { label: 'Things', widgets: [table] }
    return m
  }
  const refused = Manifest.safeParse(withTable(7))
  expect(refused.success).toBe(false)
  expect(refused.success === false && refused.error.issues.map((i) => i.message).join()).toContain(
    'groupOrder arrived in alexia_protocol 8',
  )
  const accepted = Manifest.safeParse(withTable(8))
  expect(accepted.success ? null : accepted.error.issues).toBe(null)
})

test('groupNotes and chips arrived in revision 9, and a manifest claiming 8 is told so', () => {
  const table = {
    key: 'things',
    type: 'table',
    label: 'Things',
    rows: 'list_things',
    columns: [{ key: 'name', label: 'Name' }],
    groupBy: 'group',
    groupNotes: { Open: 'Still waiting on somebody.' },
    chips: [{ key: 'open', label: 'Open', group: 'Open' }],
  }
  const withTable = (revision: number): Record<string, unknown> => {
    const m = structuredClone(voice) as Record<string, unknown>
    m.alexia_protocol = revision
    m.panel = { label: 'Things', widgets: [table] }
    return m
  }
  const refused = Manifest.safeParse(withTable(8))
  expect(refused.success).toBe(false)
  const said = refused.success === false ? refused.error.issues.map((i) => i.message).join() : ''
  expect(said).toContain('groupNotes arrived in alexia_protocol 9')
  expect(said).toContain('chips arrived in alexia_protocol 9')
  const accepted = Manifest.safeParse(withTable(9))
  expect(accepted.success ? null : accepted.error.issues).toBe(null)
})

test('a chip naming neither a group nor a tag is still parsed, and simply matches nothing', () => {
  // The shell drops it rather than the manifest refusing it: a chip that matches nothing is a
  // chip nobody sees, where a load error would take the whole plugin down over one dead filter.
  const m = structuredClone(voice) as Record<string, unknown>
  m.alexia_protocol = 9
  m.panel = {
    label: 'Things',
    widgets: [
      {
        key: 'things',
        type: 'table',
        label: 'Things',
        rows: 'list_things',
        columns: [{ key: 'name', label: 'Name' }],
        chips: [{ key: 'empty', label: 'Nothing' }],
      },
    ],
  }
  expect(Manifest.safeParse(m).success).toBe(true)
})

describe('page — a page of its own on the board (alexia_protocol 12, D199)', () => {
  /** The example with its page bent, and every message it was refused with. */
  const said = (bend: (page: Record<string, unknown>) => void, revision = 12): string => {
    const m = structuredClone(example) as Record<string, unknown>
    m.alexia_protocol = revision
    bend(m.page as Record<string, unknown>)
    const r = Manifest.safeParse(m)
    expect(r.success, 'expected this page to be refused').toBe(false)
    return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
  }
  const sizes = (page: Record<string, unknown>) => page.sizes as Record<string, { at: number[]; show: string[] }>

  test('the example declares one, and it loads', () => {
    expect(Manifest.safeParse(example).success).toBe(true)
  })

  test('declaring one while claiming revision 11 is a load error, in the words the others use', () => {
    expect(said(() => {}, 11)).toContain('page arrived in alexia_protocol 12 — declare "alexia_protocol": 12 to use it')
  })

  test('a page with no sizes shows nothing, and is refused', () => {
    expect(said((page) => (page.sizes = {}))).toContain('page.sizes needs at least one of S, M or L')
  })

  test('show names only widgets the plugin declares — settings and panel alike', () => {
    expect(said((page) => sizes(page).M!.show.push('nonsense'))).toContain(
      'page.sizes.M.show.3: show "nonsense" is not a widget this plugin declares',
    )
    // A panel widget counts: one namespace (D86).
    const m = structuredClone(example) as Record<string, unknown>
    m.panel = { label: 'Voice', widgets: [{ key: 'clips', type: 'status', label: 'Clips' }] }
    sizes(m.page as Record<string, unknown>).S!.show = ['clips']
    expect(Manifest.safeParse(m).success).toBe(true)
  })

  test('S, M and L grow in both directions', () => {
    expect(said((page) => (sizes(page).M!.at = [12, 3]))).toContain(
      'M (12×3) is smaller than S (8×4) — S, M and L must not shrink in either direction',
    )
  })

  test('a size the page offers is one it can be stretched to', () => {
    expect(said((page) => (sizes(page).M!.at = [30, 8]))).toContain('M (30×8) is outside scale (8×4 to 24×16)')
    expect(said((page) => (page.scale = { min: [9, 4] }))).toContain('S (8×4) is outside scale (9×4 to any)')
  })

  test('a fixed page has one size and does not stretch', () => {
    expect(said((page) => (page.fixed = true))).toContain('a fixed page has exactly one size')
    const one = said((page) => {
      page.fixed = true
      delete sizes(page).M
    })
    expect(one).toContain('a fixed page does not stretch')
    expect(one).not.toContain('exactly one size')
  })

  test('a size is whole dots, and not a typo', () => {
    expect(said((page) => (sizes(page).S!.at = [8.5, 4]))).toContain('page.sizes.S.at.0')
    expect(said((page) => (sizes(page).L = { at: [800, 16], show: ['model_size'] }))).toContain('page.sizes.L.at.0')
  })

  test('the page the board reads: the declared one as written, with fixed always said', () => {
    const parsed = Manifest.parse(example)
    expect(pageOf(parsed)).toEqual({
      title: 'Voice in/out',
      sizes: {
        S: { at: [8, 4], show: ['download_state'] },
        M: { at: [12, 8], show: ['model_size', 'download_state', 'redownload'] },
      },
      scale: { min: [8, 4], max: [24, 16] },
      fixed: false,
    })
  })

  test('a panel and no page is a default M page, on any revision', () => {
    const m = Manifest.parse({
      ...voice,
      alexia_protocol: 3,
      panel: { label: 'Clips', widgets: [{ key: 'clips', type: 'status', label: 'Clips' }, { key: 'more', type: 'status', label: 'More' }] },
    })
    expect(pageOf(m)).toEqual({ title: 'Clips', sizes: { M: { at: [12, 10], show: ['clips', 'more'] } }, fixed: false })
  })

  test('neither a panel nor a page is no page at all', () => {
    expect(pageOf(Manifest.parse(voice))).toBeNull()
  })
})

test('a tree, and when on a row action, arrived in revision 11 and a manifest claiming 10 is told so', () => {
  const withPanel = (revision: number, widgets: unknown[]): Record<string, unknown> => {
    const m = structuredClone(voice) as Record<string, unknown>
    m.alexia_protocol = revision
    m.panel = { label: 'Things', widgets }
    return m
  }
  const tree = {
    key: 'shelves',
    type: 'tree',
    label: 'Shelves',
    rows: 'list_tree',
    detail: 'explain_thing',
    filter: true,
    rowActions: [
      { key: 'pin', label: 'Pin', tool: 'pin', unless: { tag: 'pinned' } },
      { key: 'unpin', label: 'Unpin', tool: 'unpin', when: { field: 'pinned', is: ['yes', 'always'] } },
      { key: 'forget', label: 'Forget', tool: 'forget', confirm: 'Forget {label}?' },
    ],
  }
  const refused = Manifest.safeParse(withPanel(10, [tree]))
  expect(refused.success).toBe(false)
  const said = refused.success === false ? refused.error.issues.map((i) => i.message).join() : ''
  expect(said).toContain('tree arrived in alexia_protocol 11')
  expect(said).toContain('when on a row action arrived in alexia_protocol 11')
  expect(said).toContain('unless on a row action arrived in alexia_protocol 11')
  const accepted = Manifest.safeParse(withPanel(11, [tree]))
  expect(accepted.success ? null : accepted.error.issues).toBe(null)

  // A table's row action takes the same condition, and one without it means what it always did.
  const table = {
    key: 'things',
    type: 'table',
    label: 'Things',
    rows: 'list_things',
    columns: [{ key: 'name', label: 'Name' }],
    rowActions: [
      { key: 'still', label: 'Still true', tool: 'still', when: { tag: 'may be out of date' } },
      { key: 'plain', label: 'Plain', tool: 'plain' },
    ],
  }
  expect(Manifest.safeParse(withPanel(10, [table])).success).toBe(false)
  expect(Manifest.safeParse(withPanel(11, [table])).success).toBe(true)
  expect(Manifest.safeParse(withPanel(9, [{ ...table, rowActions: [table.rowActions[1]] }])).success).toBe(true)

  // One form at a time: a condition naming a tag and a field is a question with two answers.
  const both = { ...table, rowActions: [{ key: 'x', label: 'X', tool: 'x', when: { tag: 'a', field: 'b' } }] }
  expect(Manifest.safeParse(withPanel(11, [both])).success).toBe(false)

  // A tree's row actions share the one namespace, like a table's.
  const clash = { ...tree, rowActions: [{ key: 'things', label: 'Clash', tool: 'x' }] }
  expect(Manifest.safeParse(withPanel(11, [table, clash])).success).toBe(false)
})
