// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const dir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))

/** Frontmatter must start at byte 0; the values here are single-line. */
function parse(file) {
  const raw = readFileSync(file, 'utf8')
  const found = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  expect(found, `${file} has frontmatter at byte 0`).not.toBeNull()
  const meta = {}
  for (const line of found[1].split(/\r?\n/)) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (pair) meta[pair[1]] = pair[2]
  }
  return { meta, body: found[2] }
}

const USES = {
  travel: ['web.research', 'calendar.events', 'calendar.create', 'memory.recall', 'tasks.add'],
  booking: ['web.research', 'calendar.events', 'calendar.create', 'memory.recall', 'tasks.add'],
  forms: ['memory.recall', 'tasks.add'],
}

test('each_skill_parses_and_never_pays', () => {
  expect(manifest.skills).toEqual(['skills/travel', 'skills/booking', 'skills/forms'])
  for (const path of manifest.skills) {
    const name = path.split('/').pop()
    const file = join(dir, path, 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    const { meta, body } = parse(file)
    expect(meta.name).toBe(name)
    expect(meta.description.length).toBeGreaterThan(20)
    expect(meta.description.length).toBeLessThanOrEqual(1024)
    expect(meta.description).toMatch(/use when/i)
    // The never-pays line, in bold.
    expect(body).toContain('**Never pay, book or submit anything without the owner\'s yes to that exact step.')
    for (const cap of USES[name]) expect(body, `${name} names ${cap}`).toContain(`\`${cap}\``)
  }
})

test('manifest_parses_with_the_real_protocol_schema', async () => {
  const { Manifest } = await import(pathToFileURL(join(dir, '../../packages/protocol/src/index.ts')).href)
  const parsed = Manifest.safeParse(manifest)
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  expect(manifest.requires.map((r) => r.cap)).toEqual(['fs.read_scoped', 'fs.write_scoped'])
  expect(manifest.provides).toEqual(['notice.items', 'notice.done'])
})
