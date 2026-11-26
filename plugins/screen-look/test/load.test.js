// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const PROVIDES = ['screen.look', 'screen.help', 'screen.text']
const REQUIRES = ['computer.screenshot', 'image.ocr', 'vision.describe', 'screen.draw']

test('the manifest parses, and its id is the folder name', () => {
  assert.equal(manifest.id, basename(dir))
  assert.equal(manifest.id, 'screen-look')
  assert.equal(manifest.manifest_version, 1)
  // 10 is where `alexia/answers` arrived, which pointing asks.
  assert.equal(manifest.alexia_protocol, 10)
  assert.equal(manifest.version, '0.1.0')
})

test('provides and requires match the plan, and every requirement says why', () => {
  assert.deepEqual(manifest.provides, PROVIDES)
  assert.deepEqual(
    manifest.requires.map((r) => r.cap),
    REQUIRES,
  )
  assert.ok(manifest.requires.every((r) => r.why.length > 0 && r.why.length <= 120))
})

test('index.js imports without throwing, and each declared capability is bound by exactly one tool', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  assert.equal(alexia.manifest.id, manifest.id)
  const tools = Object.entries(alexia.server._registeredTools)
  const bound = tools.flatMap(([name, tool]) => (tool._meta?.['alexia/provides'] ?? []).map((cap) => ({ name, cap, tool })))
  // Sorted lists rather than sets, so a capability bound twice fails too.
  assert.deepEqual(bound.map(({ cap }) => cap).sort(), [...manifest.provides].sort())
  assert.equal(new Set(bound.map(({ name }) => name)).size, bound.length)
  for (const { tool } of bound) assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false })
})

test('skill_file_parses', () => {
  assert.deepEqual(manifest.skills, ['skills/screen-help'])
  const raw = readFileSync(join(dir, 'skills/screen-help/SKILL.md'), 'utf8')
  // Frontmatter must start at byte 0; the values here are single-line.
  const found = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  assert.ok(found, 'frontmatter at byte 0')
  const meta = Object.fromEntries(
    found[1].split(/\r?\n/).map((line) => {
      const pair = /^([a-z-]+):\s*(.+)$/.exec(line)
      assert.ok(pair, `a frontmatter line that is not "key: value": ${line}`)
      // An unquoted colon-space in a value is not valid YAML.
      assert.ok(!pair[2].includes(': '), `${pair[1]} holds ": ", which YAML reads as a new key`)
      return [pair[1], pair[2]]
    }),
  )
  assert.equal(meta.name, 'screen-help')
  assert.ok(meta.description.length <= 1024)
  assert.match(meta.description, /use when/i)
  for (const said of ['this', 'here', 'on my screen']) assert.ok(meta.description.includes(`"${said}"`), said)
  for (const cap of manifest.provides) assert.ok(found[2].includes(`\`${cap}\``), `the body names ${cap}`)
})
