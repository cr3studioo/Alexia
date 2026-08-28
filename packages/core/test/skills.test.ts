// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Skills, SKILL_TOOL } from '../src/skills.js'
import { stage } from './staged.js'

/**
 * The skills loader (M2-2). Three things are actually being checked here: that the index
 * costs a sentence per skill and nothing more, that a broken folder comes back with the
 * reason rather than disappearing, and that `file` cannot read outside the skill's folder.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-skills-'))
const own = join(root, 'skills')
const plugin = join(root, 'extensions', 'demo')

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** One skill folder, written as an author would write it. */
function write(dir: string, name: string, front: string, body = 'Do the thing carefully.'): string {
  const at = join(dir, name)
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'SKILL.md'), `${front}\n${body}\n`)
  return at
}

write(
  own,
  'dictating-well',
  ['---', 'name: dictating-well', 'description: How to punctuate dictated speech.', '  Use when text arrives spoken rather than typed.', 'license: Apache-2.0', '---'].join('\n'),
  'Dictated text arrives without punctuation.\n\nRead `references/punctuation.md` for the cases.',
)
mkdirSync(join(own, 'dictating-well', 'references'), { recursive: true })
writeFileSync(join(own, 'dictating-well', 'references', 'punctuation.md'), 'Commas go where a breath goes.\n')

// The four ways a folder is not a skill. Every one of them has to be visible.
write(own, 'nameless', ['---', 'description: It never says what it is called.', '---'].join('\n'))
write(own, 'mute', ['---', 'name: mute', '---'].join('\n'))
write(own, 'misnamed', ['---', 'name: something-else', 'description: The folder and the name disagree.', '---'].join('\n'))
write(own, 'late', ['', '---', 'name: late', 'description: Its frontmatter starts on line two.', '---'].join('\n'))
mkdirSync(join(own, 'empty'), { recursive: true })

// Bundled with a plugin: same format, different arrival route and a different purge.
write(plugin, 'speaking-clearly', ['---', 'name: speaking-clearly', 'description: How to phrase an answer that will be read aloud.', '---'].join('\n'))

const skills = new Skills({
  dir: own,
  bundled: () => [{ dir: join(plugin, 'speaking-clearly'), pluginId: 'demo' }],
})

test('every loadable skill loads, from both arrival routes', () => {
  expect(skills.all.map((s) => s.name).sort()).toEqual(['dictating-well', 'speaking-clearly'])
  expect(skills.all.find((s) => s.name === 'dictating-well')?.license).toBe('Apache-2.0')
  // Which plugin it came with is what makes purge and the marketplace able to tell them
  // apart. A standalone skill carries nothing.
  expect(skills.all.find((s) => s.name === 'speaking-clearly')?.pluginId).toBe('demo')
  expect(skills.all.find((s) => s.name === 'dictating-well')?.pluginId).toBeUndefined()
})

test('a folder that is not a loadable skill is shown with the reason, never skipped', () => {
  const said = Object.fromEntries(skills.problems.map((p) => [p.dir.split(/[\\/]/).pop(), p.reason]))
  expect(Object.keys(said).sort()).toEqual(['empty', 'late', 'misnamed', 'mute', 'nameless'])
  expect(said.empty).toContain('no readable SKILL.md')
  expect(said.nameless).toContain('declares no name')
  expect(said.mute).toContain('declares no description')
  expect(said.misnamed).toContain('something-else')
  // The one rule most likely to be broken by a text editor rather than by an author.
  expect(said.late).toContain('very first byte')
})

test('the index is one sentence per skill, and the body is not in it', () => {
  const tool = skills.tool
  expect(tool?.name).toBe(SKILL_TOOL)
  // Level 1: what and when, folded onto one line. Nothing of the body.
  expect(tool?.description).toContain('- dictating-well: How to punctuate dictated speech. Use when text arrives spoken rather than typed.')
  expect(tool?.description).not.toContain('Dictated text arrives without punctuation')
  // A broken folder is not offered to the model as something it could read.
  expect(tool?.description).not.toContain('misnamed')
})

test('the body arrives on request, without the frontmatter it already paid for', () => {
  const read = skills.read({ name: 'dictating-well' })
  expect(read.ok).toBe(true)
  expect(read.text).toContain('Dictated text arrives without punctuation')
  expect(read.text).not.toContain('description:')
})

test('a reference file is free until the body asks for it', () => {
  const read = skills.read({ name: 'dictating-well', file: 'references/punctuation.md' })
  expect(read.ok).toBe(true)
  expect(read.text).toContain('Commas go where a breath goes')
})

test('a skill cannot be talked into reading outside its own folder', () => {
  for (const file of ['../misnamed/SKILL.md', '../../alexia.db', join(root, 'skills', 'mute', 'SKILL.md')]) {
    const read = skills.read({ name: 'dictating-well', file })
    expect(read.ok, `${file} was read`).toBe(false)
    expect(read.text).toContain('outside')
  }
})

test('asking for a skill that is not there is an observation, not a throw', () => {
  const read = skills.read({ name: 'no-such-thing' })
  expect(read.ok).toBe(false)
  // The model's next move is to pick one of these, so it is told what there is.
  expect(read.text).toContain('dictating-well')
})

test('two skills with one name is a problem said out loud, not a silent winner', () => {
  write(own, 'speaking-clearly', ['---', 'name: speaking-clearly', 'description: A second one, from the user’s own folder.', '---'].join('\n'))
  skills.invalidate()
  expect(skills.all.filter((s) => s.name === 'speaking-clearly')).toHaveLength(1)
  expect(skills.problems.map((p) => p.reason).join('\n')).toContain('already called')
})

test('nothing installed means no tool at all', () => {
  const none = new Skills({ dir: join(root, 'nowhere') })
  expect(none.all).toEqual([])
  expect(none.problems).toEqual([])
  expect(none.tool).toBeUndefined()
})

test('a skill bundled with a plugin is found through the folder that plugin was installed from', async () => {
  // The join core actually makes: the manifest says `skills/greeting-well`, and only the
  // loader knows which folder that is relative to. Nothing is spawned to find out.
  const data = mkdtempSync(join(tmpdir(), 'alexia-skills-serve-'))
  mkdirSync(join(data, 'cache'), { recursive: true })
  writeFileSync(join(data, 'cache', 'models.json'), JSON.stringify({ fetchedAt: Date.now(), models: [] }))
  const staged = stage('hello')
  const alexia = await serve({
    dataDir: data,
    uiDir: join(import.meta.dirname, '..', '..', 'ui'),
    pluginsDir: staged,
    secrets: memorySecrets(),
  })

  const ask = (path: string, body?: unknown) =>
    fetch(new URL(path, alexia.url), {
      headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' },
      ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    })

  try {
    // A skill bundled with a plugin nobody has said yes to is know-how about something Alexia
    // cannot currently do, so it waits with the plugin (M2-5).
    const waiting = (await (await ask('/api/plugins')).json()) as { skills: unknown[] }
    expect(waiting.skills).toEqual([])
    await ask('/api/plugin', { id: 'hello', action: 'enable' })

    const state = (await (await ask('/api/plugins')).json()) as {
      skills: { name: string; pluginId?: string }[]
      skillProblems: unknown[]
    }
    expect(state.skillProblems).toEqual([])
    expect(state.skills).toHaveLength(1)
    expect(state.skills[0]?.name).toBe('greeting-well')
    // Which plugin it arrived with is what makes M2-5 able to take it away again.
    expect(state.skills[0]?.pluginId).toBe('hello')
  } finally {
    await alexia.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(staged, { recursive: true, force: true })
  }
})
