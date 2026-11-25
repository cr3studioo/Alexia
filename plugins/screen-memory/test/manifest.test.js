// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const dir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const protocol = () => import(pathToFileURL(join(dir, '../../packages/protocol/src/index.ts')).href)

test('manifest_parses_with_the_real_protocol_schema', async () => {
  // Core's loader drops a plugin whose manifest fails this.
  const { Manifest } = await protocol()
  const parsed = Manifest.safeParse(manifest)
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
})

test('manifest keys are snake_case: the camelCase spelling is refused', async () => {
  const { Manifest } = await protocol()
  const { manifest_version, alexia_protocol, mcp_protocol, ...rest } = manifest
  const camel = { ...rest, manifestVersion: manifest_version, alexiaProtocol: alexia_protocol, mcpProtocol: mcp_protocol }
  expect(Manifest.safeParse(camel).success).toBe(false)
})

test('the manifest asks for what the spec says and ships off', () => {
  expect(manifest.requires.map((r) => r.cap)).toEqual(['computer.screenshot', 'image.ocr', 'text.embed', 'fs.own_dir'])
  expect(manifest.storage).toEqual({ namespace: 'screen-memory', tables: ['moments'] })
  const setting = (key) => manifest.settings.find((s) => s.key === key)
  expect(setting('on')).toEqual(expect.objectContaining({ type: 'toggle', default: false }))
  expect(setting('every_minutes').options).toEqual(['2', '5', '10'])
  expect(setting('every_minutes').default).toBe('5')
  expect(setting('keep_days').options).toEqual(['3', '7', '14'])
  expect(setting('keep_days').default).toBe('14')
  expect(setting('skip_apps').default).toBe('KeePassXC.exe, 1Password.exe, Bitwarden.exe')
})

test('the tools are registered with the right annotations', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  const tools = alexia.server._registeredTools
  expect(Object.keys(tools).sort()).toEqual(['screen_forget', 'screen_recall', 'screen_status'])
  expect(tools.screen_recall.annotations.readOnlyHint).toBe(true)
  expect(tools.screen_status.annotations.readOnlyHint).toBe(true)
  expect(tools.screen_forget.annotations.destructiveHint).toBe(true)
})
