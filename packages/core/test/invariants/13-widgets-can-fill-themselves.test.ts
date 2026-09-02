// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Manifest } from '@alexia/protocol'
import { declaredTable, declaredWidgets } from '../../src/settings.js'
import { repoRoot } from './_repo.js'

// Defends: a widget that says it fills itself from a tool can actually be asked for its rows.
//
// **Written after both of the widgets that fill themselves were unreachable at once.** The
// route behind `/api/rows` finds the widget by its key and then reads the tool off it, and the
// finder was a list of two type names — `table` and `graph`. `image` was added at D132 and
// `cards` at D141, and neither was put on that list, so core answered *there is no list called
// that* for both. The picture gallery had been saying it since the day it shipped, on a screen
// nobody had reason to open twice.
//
// It is one line of arithmetic against every manifest in the repo, and it fails on the day a
// fifteenth widget grows a `rows` and forgets, rather than on the day somebody opens the panel.

const plugins = join(repoRoot, 'plugins')

test('every widget that fills itself from a tool is reachable by its own key', () => {
  const missed: string[] = []
  for (const id of readdirSync(plugins)) {
    const file = join(plugins, id, 'plugin.json')
    if (!existsSync(file)) continue
    const manifest = Manifest.parse(JSON.parse(readFileSync(file, 'utf8')))
    // The same two places core itself reads: the settings page and the panel.
    const widgets = declaredWidgets(manifest)
    for (const widget of widgets) {
      if (!('rows' in widget) || typeof widget.rows !== 'string') continue
      // The key is what the shell sends and what the route looks up. If this cannot find it,
      // the panel draws the widget and then says the list does not exist.
      if (declaredTable(manifest, widget.key) === undefined) {
        missed.push(`${id}: ${widget.type} "${widget.key}" (rows: ${widget.rows})`)
      }
    }
  }
  expect(missed, 'widgets whose rows tool core cannot resolve').toEqual([])
})
