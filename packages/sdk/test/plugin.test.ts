// SPDX-License-Identifier: Apache-2.0
import { MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { plugin, readManifest } from '../src/index.js'

/** A plugin folder on disk, because that is the only thing the SDK reads. */
function folder(over: Partial<ManifestInput> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-sdk-'))
  const manifest: ManifestInput = {
    manifest_version: 1,
    id: 'hello',
    name: 'Hello',
    summary: 'Answers.',
    version: '0.1.0',
    license: 'Apache-2.0',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 1,
    mcp_protocol: MCP_PINNED,
    ...over,
  }
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  return dir
}

test('a plugin knows its own manifest without repeating it in code', () => {
  const p = plugin({ dir: folder() })
  expect(p.manifest.id).toBe('hello')
  expect(readManifest(folder({ id: 'other', name: 'Other' })).id).toBe('other')
})

test('a manifest that declares the newer MCP revision is refused at start, not at runtime', () => {
  // The alternative is worse than a crash: every alexia/* call dropped on the newer wire
  // era, with nothing in any log saying why. See wire-protocol.md §1.1 and D57.
  expect(() => plugin({ dir: folder({ mcp_protocol: '2026-07-28' }) })).toThrow(/2026-07-28/)
})

test('an invalid manifest fails here rather than halfway through a call', () => {
  expect(() => plugin({ dir: folder({ id: 'Not Valid' }) })).toThrow()
})
