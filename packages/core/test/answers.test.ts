// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Host } from '../src/host.js'
import { Plugins } from '../src/plugins.js'
import { memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

/**
 * **`alexia/answers`** (`alexia_protocol` 10, `plan-personality.md` improvement 4).
 *
 * *Would anything here answer this capability, and is something that would switched off?* —
 * the reading half of `alexia/capability/call`, and the thing a plugin needed before it could
 * say *this line of your personality has nothing behind it*.
 *
 * The rule every one of these holds: **it names nobody, at either end.** You ask about a
 * capability and you are told two booleans.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-answers-'))
const from = mkdtempSync(join(tmpdir(), 'alexia-answers-plugins-'))

/** Two plugins that provide the same capability, so *enabled* and *installed* can differ. */
const manifest = (id: string, provides: string[]): void => {
  mkdirSync(join(from, id), { recursive: true })
  writeFileSync(
    join(from, id, 'plugin.json'),
    JSON.stringify({
      manifest_version: 1,
      id,
      name: id,
      summary: `Provides ${provides.join(', ')}, and nothing else.`,
      version: '0.1.0',
      license: 'AGPL-3.0-only',
      entry: { run: 'node', args: ['index.js'] },
      alexia_protocol: 2,
      mcp_protocol: '2025-11-25',
      provides,
    }),
  )
  writeFileSync(join(from, id, 'index.js'), '// never spawned by these tests\n')
}
manifest('rememberer', ['memory.remember'])
manifest('speaker', ['voice.speak'])

const store = new Store(':memory:')
const plugins = new Plugins({ dir: from, store, secrets: memorySecrets(), dataDir: root })
await plugins.load()

afterAll(() => {
  store.close()
  for (const path of [root, from]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('enabled is answers, installed-but-off is here, and neither is a name', () => {
  plugins.enable('rememberer')
  expect(plugins.answers('memory.remember')).toBe(true)
  expect(plugins.couldAnswer('memory.remember')).toEqual([])

  // The distinction the whole thing turns on: *nothing here can do that* sends somebody to a
  // library, and *something that could is switched off* sends them to a switch two inches away.
  expect(plugins.answers('voice.speak')).toBe(false)
  expect(plugins.couldAnswer('voice.speak')).toEqual(['speaker'])

  // And nothing at all, which is the third case and reads as false twice over.
  expect(plugins.answers('image.ocr')).toBe(false)
  expect(plugins.couldAnswer('image.ocr')).toEqual([])
})

test('the host answers over the method, with two booleans and no plugin id anywhere', async () => {
  const host = new Host({
    store,
    secrets: memorySecrets(),
    dataDir: root,
    // The asking plugin is one that declares no `requires[]` at all: asking runs nothing and
    // changes nothing, so it is not gated the way calling a capability is — and a plugin made
    // to declare a dependency in order to check for one would be declaring something untrue.
    manifest: () => ({
      manifest_version: 1,
      id: 'asker',
      name: 'Asker',
      summary: 'Asks whether things are here.',
      version: '0.1.0',
      license: 'AGPL-3.0-only',
      entry: { run: 'node', args: ['index.js'] },
      alexia_protocol: 10,
      mcp_protocol: '2025-11-25',
      requires: [],
    }),
    answers: (cap) => ({ answers: plugins.answers(cap), here: plugins.couldAnswer(cap).length > 0 }),
  })

  expect(await host.alexia('asker', 'alexia/answers', { cap: 'memory.remember' })).toEqual({ answers: true, here: false })
  expect(await host.alexia('asker', 'alexia/answers', { cap: 'voice.speak' })).toEqual({ answers: false, here: true })
  expect(await host.alexia('asker', 'alexia/answers', { cap: 'image.ocr' })).toEqual({ answers: false, here: false })
  // Nothing in any answer is a plugin id, which is the invariant this method had to keep to
  // exist at all — `speaker` provides `voice.speak` and is never mentioned.
  const said = JSON.stringify(await host.alexia('asker', 'alexia/answers', { cap: 'voice.speak' }))
  expect(said).not.toContain('speaker')
})

test('a host with nothing to ask reads as no, rather than as unknown', async () => {
  // Fails closed, like every other absent answer here: a caller asking this is deciding
  // whether to plan around something, and a host that cannot say is one where nothing will
  // answer. The plugin's own catch turns a *thrown* answer the other way — see
  // `plugins/persona/test/promises.test.js` — because a method that is not there means the
  // line was never checked rather than that the capability is missing, and a finding about a
  // plugin that is sitting there working is worse than no finding.
  const host = new Host({
    store,
    secrets: memorySecrets(),
    dataDir: root,
    manifest: () => plugins.manifest('rememberer'),
  })
  expect(await host.alexia('rememberer', 'alexia/answers', { cap: 'memory.remember' })).toEqual({
    answers: false,
    here: false,
  })
})

test('the register a plugin reads and the manifests in this repo say the same names', () => {
  // A capability name is only worth anything if the two ends spell it the same way, and the
  // failure when they do not is silent: a check that always says *nothing here does that*.
  const register = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', 'capabilities.md'), 'utf8')
  for (const id of ['rememberer', 'speaker']) {
    for (const cap of plugins.manifest(id)?.provides ?? []) expect(register, cap).toContain(`\`${cap}\``)
  }
})
