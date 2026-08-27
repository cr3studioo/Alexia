// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { files, hits, repoRoot } from './_repo.js'

// Defends rule 1: core may never know a plugin exists. The single most important check in
// the repo, and the one the whole thesis reduces to — if core can name a plugin, core can
// depend on one, and deleting the folder stops being safe.
//
// Two mechanisms, because neither alone is enough. This is the grep, which catches the
// string `"voice"` in a switch statement. The import edge is `.dependency-cruiser.mjs`,
// which catches the same thing spelled as a variable.

const coreSource = ['packages/core/src/**/*.ts', 'packages/core/src/**/*.tsx']

/** Every folder under `plugins/`. The list grows; the rule does not. */
const installed = (): string[] =>
  readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

/**
 * A plugin's name as core could actually use it: quoted, or as a path segment. Deliberately
 * not a bare word — `memory` and `computer` are plugins at M4 and also ordinary English,
 * and a check that cannot tell them apart is a check somebody switches off.
 */
const names = (id: string): RegExp =>
  new RegExp(String.raw`['"\`]${id}['"\`]|plugins[\\/]${id}\b`)

test('core-names-no-plugin: no plugin id appears anywhere in core', () => {
  const ids = installed()
  expect(ids.length, 'the scanner found no plugins to look for').toBeGreaterThan(0)

  const found = files(coreSource).flatMap((file) =>
    ids.flatMap((id) => hits(file, names(id)).map((h) => `${h}   (names "${id}")`)),
  )
  expect(
    found,
    'if you are about to type a plugin name in core, you have found a missing capability:\n' +
      found.join('\n'),
  ).toEqual([])
})

test('core-names-no-plugin: nothing in core imports from plugins/', () => {
  const found = files(coreSource).flatMap((file) =>
    hits(file, /from\s+['"][^'"]*plugins[\\/]/),
  )
  expect(found, `core may not import a plugin:\n${found.join('\n')}`).toEqual([])
})

test('core-names-no-plugin: the check catches a real violation', () => {
  // A check that has never seen one is a comment. These are the violations, in the two
  // shapes they actually take.
  const file = { path: 'packages/core/src/router.ts', text: '' }
  const inASwitch = { ...file, text: `  case 'voice':\n    return speak(text)` }
  const inAPath = { ...file, text: `const dir = join(root, 'plugins/voice')` }
  expect(hits(inASwitch, names('voice'))).toHaveLength(1)
  expect(hits(inAPath, names('voice'))).toHaveLength(1)

  // And that it does not fire on the word itself, which core is allowed to use: the M4
  // plugins are called `memory` and `computer`, and both are ordinary English.
  const prose = { ...file, text: '// the memory budget for a computer with 8 GB of VRAM' }
  expect(hits(prose, names('memory'))).toHaveLength(0)
  expect(hits(prose, names('computer'))).toHaveLength(0)
})
