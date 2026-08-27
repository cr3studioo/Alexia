// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../../src/plugins.js'
import { Store } from '../../src/store.js'

// Defends rule 4: core works with zero plugins installed. The moment core needs a plugin to
// start, "delete the folder" becomes "delete the folder and hope".
//
// The other half of this check is a CI job that moves `plugins/` aside and runs the suite,
// so nothing in the *wiring* quietly depends on the folder either.

const dataDir = mkdtempSync(join(tmpdir(), 'alexia-empty-'))
const empty = mkdtempSync(join(tmpdir(), 'alexia-noplugins-'))
const store = new Store(':memory:')
const plugins = new Plugins({ dir: empty, store, dataDir })

afterAll(async () => {
  await plugins.stop()
  store.close()
})

test('boots-with-no-plugins: an empty plugins folder is a working install', async () => {
  plugins.load()
  plugins.watch()

  expect(plugins.ids).toEqual([])
  expect(plugins.problems).toEqual([])
  expect(await plugins.tools()).toEqual([])
  expect(plugins.unmet('anything')).toEqual([])
})

test('boots-with-no-plugins: no plugins folder at all is also fine', () => {
  rmSync(empty, { recursive: true, force: true })
  // Not an error, and not a crash: a fresh install has nothing installed yet, and that is
  // the state every user starts in.
  expect(() => plugins.load()).not.toThrow()
  expect(plugins.ids).toEqual([])
})

test('boots-with-no-plugins: a capability nothing provides is answered, not thrown away', async () => {
  // The honest answer to "can anything speak?" on an empty install is no, in the shape the
  // spec fixes, so a caller can re-plan rather than guess.
  await expect(plugins.capability('voice.speak', { text: 'hello' })).rejects.toMatchObject({
    code: -32050,
  })
})
