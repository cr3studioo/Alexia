// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { CORE_TABS } from '../src/panels.js'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * Core's own panels: skills, learned skills, tools and what is installed (M6-4).
 *
 * **Three panels, one widget.** They were one task rather than three because that is the
 * only way the question gets asked properly: if any of them had needed a line of bespoke
 * rendering, `table` was the wrong widget and M6-3 was wrong with it. What this file holds
 * still is the half that could drift — that every one of them is a declaration plus a
 * function returning rows, with no shape of its own.
 *
 * And the rule two of the old dashboard's panels opened with, which came across unchanged:
 * **read-only unless this screen is the only owner.** The plugins screen owns installing and
 * removing; `tooling.ts` reads the plugins. There is exactly one row action here, and it is
 * the one thing nothing else can do.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-surface-'))
mkdirSync(join(root, 'cache'), { recursive: true })
writeFileSync(join(root, 'cache', 'models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [] }))

const skillsDir = join(root, 'skills')
const skill = (name: string, front: string): void => {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: What ${name} is for.\n${front}---\n\nBody of ${name}.\n`)
}

// One somebody installed, and one Alexia wrote — the distinction the second table exists for.
skill('folding-laundry', '')
skill('sorting-downloads', 'metadata:\n  learned: true\n  learned_at: 2026-08-20\n  learned_from: "sort my downloads by year"\n')
// One written before the record existed. Shown as absent rather than guessed at.
skill('older-habit', 'metadata:\n  learned: true\n')
// And a folder that is not a skill, because "this folder is here and is doing nothing" is
// the sentence somebody opens this screen to find.
mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true })
writeFileSync(join(skillsDir, 'not-a-skill', 'readme.txt'), 'hello')

/**
 * A plugin that ships a skill and nothing else.
 *
 * On disk before the server starts, because core reads the folder once at boot and notices
 * later changes through a watcher — and a test that raced a filesystem watcher would be a
 * test that fails on somebody else's laptop for reasons that have nothing to do with panels.
 */
const extensions = join(root, 'extensions')
mkdirSync(join(extensions, 'shipper', 'know'), { recursive: true })
writeFileSync(
  join(extensions, 'shipper', 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'shipper',
    name: 'Shipper',
    summary: 'Ships a skill and nothing else.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 3,
    mcp_protocol: '2025-11-25',
    skills: ['know'],
  }),
)
writeFileSync(
  join(extensions, 'shipper', 'know', 'SKILL.md'),
  '---\nname: know\ndescription: Something that came with a plugin.\n---\n\nBody.\n',
)

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: extensions,
  secrets: memorySecrets(),
})

afterAll(async () => {
  await alexia.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

interface Row {
  id: string
  [field: string]: unknown
}

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

const rows = async (key: string): Promise<Row[]> => ((await post('/api/rows', { key })).rows ?? []) as Row[]

test('every core panel is a declaration and a function, with no shape of its own', async () => {
  // The M6-4 test, stated as one assertion: a core tab holds tables and nothing else. The
  // moment one of them needs a widget that is not one of the eleven, `table` was wrong.
  const declared = CORE_TABS.flatMap((tab) => tab.widgets ?? [])
  expect(declared.length).toBeGreaterThan(0)
  expect(declared.every((widget) => widget.type === 'table')).toBe(true)

  // And each one names a source that answers.
  for (const widget of declared) {
    const answer = await post('/api/rows', { key: widget.key })
    expect(answer.ok, widget.key).toBe(true)
  }
})

test('the skills panel separates what somebody installed from what Alexia wrote', async () => {
  const installed = await rows('skills')
  expect(installed.map((row) => row.name)).toContain('folding-laundry')
  // A learned one belongs to the other table, and appearing in both would be the same skill
  // twice with two different sets of actions on it.
  expect(installed.map((row) => row.name)).not.toContain('sorting-downloads')

  // A folder that is not a skill is a row with a reason, not an absence.
  const broken = installed.find((row) => String(row.state).startsWith('▲'))
  expect(String(broken?.state)).toContain('SKILL.md')
})

test('a learned skill says what it was learned from, and an unrecorded one says that instead', async () => {
  const learned = await rows('learned')
  expect(learned.map((row) => row.name).sort()).toEqual(['older-habit', 'sorting-downloads'])
  const one = learned.find((row) => row.name === 'sorting-downloads')
  // The question somebody asks a week later, and the skill's own text cannot answer it.
  expect(one?.from).toBe('sort my downloads by year')
  expect(one?.when).toBe('2026-08-20')

  // Written before the record existed: shown as absent rather than guessed at, which is the
  // same discipline as the catalog's honesty flags (M1-5).
  expect(learned.find((row) => row.name === 'older-habit')?.from).toBe('not recorded')
  expect(learned.find((row) => row.name === 'older-habit')?.when).toBe('—')
})

test('a detail is the skill’s own text, read rather than summarised', async () => {
  const answer = await post('/api/detail', { key: 'skills', row: 'folding-laundry' })
  expect(answer.ok).toBe(true)
  expect(String(answer.text)).toContain('Body of folding-laundry.')
})

test('forgetting a skill is guarded, and it is the one thing this screen owns', async () => {
  // No confirm: the guard refuses, because core acting on core's own data has no permission
  // ruling standing in front of it (M6-1).
  const naked = await fetch(new URL('/api/action', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ key: 'forget_skill', row: 'folding-laundry' }),
  })
  expect(naked.status).toBe(409)
  expect((await rows('skills')).map((row) => row.name)).toContain('folding-laundry')

  const done = await post('/api/action', { key: 'forget_skill', row: 'folding-laundry', confirm: true })
  expect(done.ok).toBe(true)
  expect((await rows('skills')).map((row) => row.name)).not.toContain('folding-laundry')
})

test('a bundled skill is refused with the reason, rather than having no button at all', async () => {
  // A missing button answers nothing. *It came with something, and it goes when that does*
  // is the answer to the question the person pressing it is actually asking.
  //
  // Installed is not enabled, and a bundled skill waits with its plugin (M2-2) — so it is
  // not in the list at all until somebody says yes, which this is.
  expect((await rows('skills')).map((row) => row.name)).not.toContain('know')
  await post('/api/plugin', { id: 'shipper', action: 'enable' })

  const listed = await rows('skills')
  const bundled = listed.find((row) => row.name === 'know')
  expect(bundled?.where).toBe('with shipper')

  const refused = await post('/api/action', { key: 'forget_skill', row: 'know', confirm: true })
  expect(refused.ok).toBe(false)
  expect(String(refused.said)).toContain('came with shipper')
  // And it is still there, which is the half a sentence alone would not prove.
  expect(readFileSync(join(extensions, 'shipper', 'know', 'SKILL.md'), 'utf8')).toContain('Body.')
})

test('the library panel says what is installed and what state it is in, and nothing writes', async () => {
  const listed = await rows('library')
  const mine = listed.find((row) => row.id === 'shipper')
  expect(mine?.name).toBe('Shipper')
  expect(mine?.version).toBe('0.1.0')
  expect(String(mine?.state)).toContain('enabled')

  // Read-only, deliberately: the plugins screen owns the write path, and a second one here
  // would be a parallel mechanism.
  const table = CORE_TABS.flatMap((tab) => tab.widgets ?? []).find((widget) => widget.key === 'library')
  expect(table?.type === 'table' && table.rowActions).toBeUndefined()

  const detail = await post('/api/detail', { key: 'library', row: 'shipper' })
  // The author's own sentence, verbatim.
  expect(String(detail.text)).toContain('Ships a skill and nothing else.')
})

test('the tools panel is every tool every enabled plugin offers, grouped by whoever offers it', async () => {
  const listed = await rows('tools')
  // Know-how is core's own, and it is the one tool that belongs to nobody's plugin.
  expect(listed.map((row) => row.plugin)).toContain('Alexia')

  const table = CORE_TABS.flatMap((tab) => tab.widgets ?? []).find((widget) => widget.key === 'tools')
  expect(table?.type === 'table' && table.groupBy).toBe('plugin')
  // Read-only for the reason the old dashboard gave: `tooling.ts` reads the plugins, and the
  // plugins are the write path.
  expect(table?.type === 'table' && table.rowActions).toBeUndefined()
})

test('a run is on the activity panel after the task that made it has ended', async () => {
  // The half M6-5 exists for, and the half M6-G checks on the same run: the live trace is
  // gone the moment the task is, and this is the record that is not. Nothing is connected
  // here, so the run ends in the router's refusal — which is a run like any other, and the
  // one somebody is most likely to want to send to somebody else.
  expect(await rows('activity')).toEqual([])

  await fetch(new URL('/api/chat', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ text: 'sort my downloads' }),
  }).then((answer) => answer.text())

  const runs = await rows('activity')
  expect(runs).toHaveLength(1)
  expect(runs[0]?.task).toBe('sort my downloads')
  expect(runs[0]?.ended).toBe('refused')

  // The detail is the whole run, and it is the same text `export` writes — one renderer, so
  // what somebody reads on screen is exactly what they send on.
  const detail = await post('/api/detail', { key: 'activity', row: String(runs[0]?.id) })
  expect(String(detail.text)).toContain('# sort my downloads')

  // Exporting takes nothing away, so it is the one core row action that is not guarded.
  const exported = await post('/api/action', { key: 'export_run', row: String(runs[0]?.id) })
  expect(exported.ok).toBe(true)
  expect(String(exported.said)).toContain('exports')
  expect(readFileSync(String(exported.said).replace('Written to ', ''), 'utf8')).toContain('sort my downloads')
})

test('a list nobody declared is a sentence, not an empty table', async () => {
  const answer = await post('/api/rows', { key: 'imaginary' })
  expect(answer.ok).toBe(false)
  expect(String(answer.said)).toContain('no list called')
})
