// SPDX-License-Identifier: Apache-2.0
import { readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ALEXIA_METHODS,
  ALEXIA_PROTOCOL_MAX,
  COMPUTE_META,
  Manifest,
  MCP_PINNED,
  pluginJsonSchema,
  versionVerdict,
  type ComputeBinding,
  type ComputeHook,
  type ComputeOperation,
  type ManifestInput,
} from '../src/index.js'

/**
 * **`compute`** (`alexia_protocol` 13, `docs/spec/remote-compute.md` §4): a plugin saying which
 * of its capabilities are heavy work, so core can find the workers on a host by reading
 * manifests and never by knowing a name.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..')

const base: ManifestInput = {
  manifest_version: 1,
  id: 'painter',
  name: 'Painter',
  summary: 'Makes pictures.',
  version: '0.1.0',
  license: 'Apache-2.0',
  entry: { run: 'node', args: ['index.js'] },
  alexia_protocol: 13,
  mcp_protocol: MCP_PINNED,
  provides: ['image.generate', 'image.render'],
}
const render: ComputeOperation = { cap: 'image.render', summary: 'Render an image from a prepared workflow', weight: 'heavy' }
const hooks: ComputeHook[] = ['setup', 'install', 'release']

/** Where a manifest was refused, and in what words. */
function refused(m: unknown): { paths: string[]; said: string } {
  const r = Manifest.safeParse(m)
  expect(r.success, 'expected this manifest to be rejected').toBe(false)
  const issues = r.success ? [] : r.error.issues
  return {
    paths: issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : [i.path.join('.')])),
    said: issues.map((i) => i.message).join('\n'),
  }
}

describe('the declaration', () => {
  test('a manifest with compute validates at protocol 13, and 13 is one this Alexia loads', () => {
    const r = Manifest.safeParse({ ...base, compute: { operations: [render], hooks } })
    expect(r.success ? null : r.error.issues).toBe(null)
    expect(ALEXIA_PROTOCOL_MAX).toBeGreaterThanOrEqual(13)
    expect(versionVerdict({ name: base.name, alexia_protocol: 13, mcp_protocol: MCP_PINNED })).toEqual({ ok: true })
  })

  test('weight and hooks are optional, and an operation with neither is a heavy one with no lifecycle', () => {
    const r = Manifest.safeParse({ ...base, compute: { operations: [{ cap: 'image.render', summary: 'Render' }] } })
    expect(r.success ? null : r.error.issues).toBe(null)
    expect(r.success && r.data.compute?.operations[0]?.weight).toBe(undefined)
    expect(r.success && r.data.compute?.hooks).toBe(undefined)
  })

  test('an operation whose cap is not in provides is refused, at the operation', () => {
    // Core calls an operation by capability, and `provides` is where one is promised.
    const { paths, said } = refused({ ...base, provides: ['image.generate'], compute: { operations: [render] } })
    expect(paths).toContain('compute.operations.0.cap')
    expect(said).toContain('"image.render" must also be in provides')
    // And with no `provides` at all, which is the same mistake with one more line missing.
    const bare: Record<string, unknown> = { ...base, compute: { operations: [render] } }
    delete bare.provides
    expect(refused(bare).paths).toContain('compute.operations.0.cap')
  })

  test('two operations cannot share a cap', () => {
    const { paths, said } = refused({
      ...base,
      compute: { operations: [render, { cap: 'image.render', summary: 'Again', weight: 'light' }] },
    })
    expect(paths).toContain('compute.operations')
    expect(said).toContain('"image.render" is declared twice')
  })

  test('declaring it while claiming 12 is a load error that names the revision', () => {
    // The rule every field since `lifetime` has set: an Alexia that predates `compute` would
    // refuse this manifest as unparseable, which tells an author nothing.
    const { paths, said } = refused({ ...base, alexia_protocol: 12, compute: { operations: [render] } })
    expect(paths).toContain('compute')
    expect(said).toContain('compute arrived in alexia_protocol 13')
  })

  test('the shape is strict: no operations, an unknown hook, a misspelled key', () => {
    expect(refused({ ...base, compute: { operations: [] } }).paths).toContain('compute.operations')
    expect(refused({ ...base, compute: { operations: [render], hooks: ['warm'] } }).paths).toContain('compute.hooks.0')
    expect(refused({ ...base, compute: { operations: [render], hook: ['setup'] } }).paths).toContain('hook')
    expect(refused({ ...base, compute: { operations: [{ ...render, tool: 'render' }] } }).paths).toContain('tool')
    expect(refused({ ...base, compute: { operations: [{ ...render, weight: 'huge' }] } }).paths).toContain(
      'compute.operations.0.weight',
    )
    // A capability, in the registry's own syntax — not a tool name and not a plugin id.
    expect(refused({ ...base, compute: { operations: [{ cap: 'render', summary: 'Render' }] } }).paths).toContain(
      'compute.operations.0.cap',
    )
    expect(refused({ ...base, compute: { operations: [render], hooks: ['setup', 'setup'] } }).paths).toContain('compute.hooks')
  })

  test('it is optional: every manifest in plugins/ still validates, unchanged', () => {
    const manifests = globSync('*/plugin.json', { cwd: join(repoRoot, 'plugins') })
    for (const file of manifests) {
      const r = Manifest.safeParse(JSON.parse(readFileSync(join(repoRoot, 'plugins', file), 'utf8')))
      expect(r.success ? null : r.error.issues, file).toBe(null)
    }
  })

  test('the editor-facing schema knows the field', () => {
    const schema = pluginJsonSchema() as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toContain('compute')
    expect(schema.required).not.toContain('compute')
  })
})

describe('the binding and the method', () => {
  test('the _meta key is the documented one, and carries an operation or a hook', () => {
    expect(COMPUTE_META).toBe('alexia/compute')
    const bindings: ComputeBinding[] = [{ op: 'image.render' }, { hook: 'setup' }]
    expect(bindings).toHaveLength(2)
  })

  test('alexia/compute/run names a capability, its arguments and the files to send', () => {
    const { params, result } = ALEXIA_METHODS['alexia/compute/run']
    expect(params.safeParse({ cap: 'image.render' }).success).toBe(true)
    expect(
      params.safeParse({
        cap: 'image.render',
        arguments: { workflow: { steps: 20 }, source: 'input:photo' },
        inputs: [{ name: 'photo', path: join(repoRoot, 'photo.png'), mime: 'image/png' }],
      }).success,
    ).toBe(true)
    // A capability, never nothing — and an input is a name, a path and a type, all three.
    expect(params.safeParse({ cap: '' }).success).toBe(false)
    expect(params.safeParse({ cap: 'image.render', inputs: [{ name: 'photo', path: '' , mime: 'image/png' }] }).success).toBe(false)
    expect(params.safeParse({ cap: 'image.render', inputs: [{ name: 'photo', path: 'p' }] }).success).toBe(false)

    // There is no way to say which computer or which plugin: anything of the kind is dropped.
    const parsed = params.parse({ cap: 'image.render', host: 'studio', plugin: 'painter', _meta: { progressToken: 1 } })
    expect(parsed).toEqual({ cap: 'image.render' })

    expect(result.safeParse({ files: [] }).success).toBe(true)
    expect(result.safeParse({ text: 'Rendered.', files: ['/somewhere/out.png'] }).success).toBe(true)
    expect(result.safeParse({ text: 'Rendered.' }).success).toBe(false)
  })
})
