// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { Manifest } from '@alexia/protocol'
import { CORE_TABS } from '../src/panels.js'
import { keyOf, PROVIDERS } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'
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
/**
 * Two models from two providers, one of which has a key. No `at` map, so the whole cache
 * reads as fetched just now and the startup poll asks nobody anything — a panel test that
 * went to the network would be a panel test that fails on a train.
 */
const model = (over: Record<string, unknown>): Record<string, unknown> => ({
  name: 'A Model',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})
noPolling(root, [
  model({ id: 'openrouter/reachable', name: 'Reachable', provider: 'openrouter', weekly: 1_500_000 }),
  model({ id: 'groq/unreachable', name: 'Unreachable', provider: 'groq', priceIn: 2, tier: 'T3' }),
])

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

// One provider connected and one not, which is the difference the Models tab is about.
const secrets = memorySecrets()
await secrets.set(CORE, keyOf(PROVIDERS.find((p) => p.id === 'openrouter')!), 'sk-users-own')

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: extensions,
  secrets,
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
  /**
   * The M6-4 test, and it moved once — deliberately, on 2026-08-29 (M8-2).
   *
   * It read *a core tab holds tables and nothing else*, which is stricter than the property
   * its own next line names: **the moment one of them needs a widget that is not one of the
   * eleven, `table` was wrong.** Chats needs a *New chat* button, and `action` is one of the
   * eleven — the shell draws it with the same function it draws a plugin's, which is the
   * thing being protected. What would break this is a core tab needing a twelfth widget, or
   * one line of rendering that exists only for core, and both still fail here — the check is
   * now the manifest schema itself, so *what a plugin may declare* and *what core declares*
   * cannot drift apart into two lists that have to agree.
   */
  const declared = CORE_TABS.flatMap((tab) => tab.widgets ?? [])
  expect(declared.length).toBeGreaterThan(0)
  const asPlugin = Manifest.safeParse({
    manifest_version: 1,
    id: 'not-a-plugin',
    name: 'Core, pretending',
    summary: 'Every widget core declares for itself, offered as a plugin would offer them.',
    version: '0.0.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 3,
    mcp_protocol: '2025-11-25',
    settings: declared,
  })
  expect(asPlugin.error?.issues ?? []).toEqual([])

  // And every table names a source that answers. An `action` has no rows and is not asked.
  for (const widget of declared.filter((one) => one.type === 'table')) {
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

test('the library read survives its tab, because the palette is what indexes it', async () => {
  const listed = await rows('library')
  const mine = listed.find((row) => row.id === 'shipper')
  expect(mine?.name).toBe('Shipper')
  expect(mine?.version).toBe('0.1.0')
  expect(String(mine?.state)).toContain('enabled')

  // No tab of its own any more (M8-3). It was a read-only copy of a list the settings screen
  // owns the write path for, and one list in two places is one of them being out of date —
  // so the panel went and the read stayed, which is what the palette and the grid both use.
  expect(CORE_TABS.flatMap((tab) => tab.widgets ?? []).map((widget) => widget.key)).not.toContain('library')

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

test('a skill nobody said yes to waits on the screen, and says so', async () => {
  // The consent ladder (M6-9, D84). A plugin has had this since M2-5; a skill arrived and
  // was simply live. These two folders were put here by this test, which is exactly the
  // case: nothing said where they came from, so nothing may assume anybody wanted them.
  const listed = await rows('skills')
  const one = listed.find((row) => row.name === 'know')
  expect(one?.where).toBe('with shipper')
  // Except the bundled one — enabling its plugin was the yes, with the author's own words
  // on screen, and asking again would be asking twice.
  expect(String(one?.state)).not.toContain('waiting')

  const learned = await rows('learned')
  const model = learned.find((row) => row.name === 'sorting-downloads')
  expect(String(model?.state)).toContain('waiting for you')

  const allowed = await post('/api/action', { key: 'allow_here', row: 'sorting-downloads', confirm: true })
  expect(allowed.ok).toBe(true)
  expect(String((await rows('learned')).find((row) => row.name === 'sorting-downloads')?.state)).not.toContain('waiting')
})

test('the palette searches the same reads the panels use, and answers with a tab', async () => {
  const found = async (query: string): Promise<{ tab: string; kind: string; label: string }[]> =>
    ((await (
      await fetch(new URL(`/api/search?q=${encodeURIComponent(query)}`, alexia.url), {
        headers: { 'x-alexia-token': alexia.token },
      })
    ).json()) as { hits: { tab: string; kind: string; label: string }[] }).hits

  // A tab, by its own name.
  expect((await found('Tools'))[0]).toMatchObject({ tab: 'tools', kind: 'panel' })

  // A skill, from the same rows the skills table shows — no second index, so this is true
  // by construction rather than by being kept in step.
  expect((await found('sorting-downloads')).map((hit) => hit.kind)).toContain('learned skill')

  // A run, which only exists because a task happened earlier in this file.
  expect((await found('sort my downloads')).some((hit) => hit.tab === 'activity')).toBe(true)

  // And a thing that has just been forgotten is gone from the palette by the act that
  // removed it, because there was nothing else holding a copy.
  await post('/api/action', { key: 'forget_skill', row: 'older-habit', confirm: true })
  expect((await found('older-habit'))).toEqual([])
})

test('a list nobody declared is a sentence, not an empty table', async () => {
  const answer = await post('/api/rows', { key: 'imaginary' })
  expect(answer.ok).toBe(false)
  expect(String(answer.said)).toContain('no list called')
})

test('the models panel lists what you can actually reach, and nothing else', async () => {
  const models = await rows('models')
  // Only the connected provider's. A key for OpenRouter is not an invitation to browse the
  // six providers you have never signed up to — one key would bury twenty usable rows under
  // eighty you cannot send anything to.
  expect(models.map((row) => row.id)).toEqual(['openrouter/reachable'])

  // The one Automatic would pick, asked of the router rather than decided here.
  expect(models[0]?.state).toBe('★ recommended')

  // What the world put through it, from the fixture cache.
  expect(models[0]?.week).toBe('1.5M')
  // Free is a word, not $0.00 — those are different claims, and one of them is the tier the
  // whole project runs on.
  expect(models[0]?.price).toBe('free')
  expect(models[0]?.context).toBe('33k')

  // What expands under a row: the two flags nobody may guess at, repeated rather than
  // rounded off.
  const detail = String((await post('/api/detail', { key: 'models', row: 'openrouter/reachable' })).text)
  expect(detail).toContain('Trains on what you send it: unknown')
  expect(detail).toContain('1.5M tokens through this model last week')
})

test('choosing a model pins it, and Automatic gives the choice back', async () => {
  const pinned = async (): Promise<unknown> =>
    ((await (await fetch(new URL('/api/state', alexia.url), { headers: { 'x-alexia-token': alexia.token } })).json()) as {
      pins: { model?: string }
    }).pins.model

  expect(await pinned()).toBeUndefined()

  const chosen = await post('/api/action', { key: 'use_model', row: 'openrouter/reachable' })
  expect(chosen.ok).toBe(true)
  // The pin the router already treats as final. Nothing new was invented to hold this.
  expect(await pinned()).toBe('openrouter/reachable')
  // The chosen mark, which is what the shell colours and what the row is found by.
  expect((await rows('models')).find((row) => row.id === 'openrouter/reachable')?.state).toBe('◆ everything goes here')

  // The guard stays even though no unreachable model is listed any more: rows are fetched
  // and then pressed, and a key can be removed in between. A refusal here names what to do;
  // the router three screens later would only say it "is not available right now".
  const cannot = await post('/api/action', { key: 'use_model', row: 'groq/unreachable' })
  expect(cannot.ok).toBe(false)
  expect(String(cannot.said)).toContain('no key yet')
  expect(await pinned()).toBe('openrouter/reachable')

  const back = await post('/api/action', { key: 'automatic', row: 'openrouter/reachable' })
  expect(back.ok).toBe(true)
  // The sentence says what automatic *is*, because "how do I undo this" is the question the
  // press was asking and a bare "done" answers none of it.
  expect(String(back.said)).toContain('cheapest model that fits')
  expect(await pinned()).toBeUndefined()

  // Pressed again with nothing pinned it is not an error, and it does not pretend to have
  // changed something: a button that lies about having acted is worse than one that repeats.
  expect(String((await post('/api/action', { key: 'automatic', row: 'openrouter/reachable' })).said)).toContain(
    'Already automatic',
  )
})

test('chats: a new one, a way back into an old one, and the one you are in cannot be deleted', async () => {
  const chats = async (): Promise<Row[]> => await rows('chats')
  const openOne = (list: Row[]): Row | undefined => list.find((chat) => String(chat.state).includes('open'))

  // Whatever this instance has been saying lives in one conversation, and it is the open one.
  const before = await chats()
  expect(before.length).toBeGreaterThan(0)
  expect(openOne(before)).toBeDefined()
  const first = openOne(before)!

  // A new one is empty, open, and named for the fact that nothing has been said in it.
  expect((await post('/api/action', { key: 'new_chat' })).ok).toBe(true)
  const two = await chats()
  expect(two.length).toBe(before.length + 1)
  expect(openOne(two)?.title).toBe('New chat')
  expect(openOne(two)?.id).not.toBe(first.id)

  // Pressed again it does not stack: an empty chat is reused, because the second press means
  // the same thing as the first and a column of identical empty rows is nobody's intent.
  expect(String((await post('/api/action', { key: 'new_chat' })).said)).toContain('already in a new chat')
  expect((await chats()).length).toBe(two.length)

  // **The one you are in cannot be deleted.** Its messages go by ON DELETE CASCADE, so every
  // later append would point at a session row that is not there.
  const mine = openOne(await chats())!
  const refused = await post('/api/action', { key: 'forget_chat', row: String(mine.id), confirm: true })
  expect(refused.ok).toBe(false)
  expect(String(refused.said)).toContain('conversation you are in')

  // Back into the old one, and the empty one can go now that it is not the open one.
  expect((await post('/api/action', { key: 'open_chat', row: String(first.id) })).ok).toBe(true)
  expect(openOne(await chats())?.id).toBe(first.id)
  expect((await post('/api/action', { key: 'forget_chat', row: String(mine.id), confirm: true })).ok).toBe(true)
  expect((await chats()).map((chat) => chat.id)).not.toContain(mine.id)
})
