// SPDX-License-Identifier: AGPL-3.0-only
// Core, in a process with nothing else in it, reporting what it costs. Run by the
// memory-budget check — measuring inside the test runner would be measuring the test
// runner, which is not the number anyone cares about.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plugins } from '../../dist/src/plugins.js'
import { Store } from '../../dist/src/store.js'

const store = new Store(':memory:')
const plugins = new Plugins({
  dir: process.argv[2] ?? mkdtempSync(join(tmpdir(), 'alexia-rss-')),
  store,
  dataDir: mkdtempSync(join(tmpdir(), 'alexia-rss-data-')),
})
plugins.load()
plugins.watch()

// Let the first allocations settle, then report. Nothing is spawned: enabled is not running.
setTimeout(() => {
  console.log(JSON.stringify({ rss: process.memoryUsage().rss, plugins: plugins.ids }))
  process.exit(0)
}, 300)
