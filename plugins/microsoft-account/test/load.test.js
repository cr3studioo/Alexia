// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))

test('the manifest parses, and its id is the folder name', () => {
  expect(manifest.id).toBe(basename(dir))
  expect(manifest.manifest_version).toBe(1)
  // 7: a setting's `when` arrived in alexia_protocol 7 (docs/spec/versions.md).
  expect(manifest.alexia_protocol).toBe(7)
  expect(Array.isArray(manifest.provides)).toBe(true)
})

test('manifest_parses_with_the_real_protocol_schema', async () => {
  const { Manifest } = await import(pathToFileURL(join(dir, '../../packages/protocol/src/index.ts')).href)
  const parsed = Manifest.safeParse(manifest)
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)

  // What the spec asks for, and nothing more: the network only, no listener.
  expect(manifest.requires).toEqual([{ cap: 'net.request', why: 'To talk to Microsoft: login.microsoftonline.com, graph.microsoft.com.' }])
  expect(manifest.provides).toEqual(['calendar.events', 'calendar.create', 'mail.list', 'mail.read', 'contacts.find', 'notice.items'])
  const byKey = Object.fromEntries(manifest.settings.map((s) => [s.key, s]))
  expect(Object.keys(byKey).sort()).toEqual(['client_id', 'connect', 'refresh_token', 'status', 'tenant'])
  expect(byKey.client_id.type).toBe('text')
  expect(byKey.tenant).toMatchObject({ type: 'text', default: 'common' })
  expect(byKey.connect).toMatchObject({ type: 'action', tool: 'connect' })
  expect(byKey.status.type).toBe('status')
  // The only secret is a password setting, and it is never drawn on the form.
  expect(byKey.refresh_token.type).toBe('password')
  expect(byKey.refresh_token.when).toEqual({ key: 'status', is: 'hidden' })

  // camelCase keys are not the manifest's language: the schema refuses them.
  const camel = { ...manifest, alexiaProtocol: manifest.alexia_protocol }
  delete camel.alexia_protocol
  expect(Manifest.safeParse(camel).success).toBe(false)
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia, tools, service } = await import('../index.js')
  expect(alexia.manifest.id).toBe(manifest.id)
  // Every capability the manifest provides is bound to a tool, and no tool claims one it does not.
  const svc = service({ settings: async () => ({}), keep: async () => {} })
  const bound = tools(svc).flatMap(([, config]) => config._meta?.['alexia/provides'] ?? [])
  expect(bound.sort()).toEqual([...manifest.provides].sort())
})
