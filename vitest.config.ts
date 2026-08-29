import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The tests that need the repo's own plugins on disk. Invariant 2 has a CI job that moves
 * `plugins/` aside and runs the suite, to prove core never needs one — these files are
 * fixtures rather than core, so they step aside with it. A new plugin-dependent test that
 * forgets to join this list turns that job red, which is the right way round.
 */
const needPlugins = [
  'packages/core/test/command.test.ts',
  'packages/core/test/lifecycle.test.ts',
  'packages/core/test/panels.test.ts',
  'packages/core/test/plugin-panels.test.ts',
  'packages/core/test/plugins.test.ts',
  'packages/core/test/progress.test.ts',
  'packages/core/test/registry.test.ts',
  'packages/conformance/test/conform.test.ts',
  'packages/core/test/replan.test.ts',
  'packages/core/test/shutdown.test.ts',
  'packages/core/test/skills.test.ts',
  'packages/core/test/stop.test.ts',
  'packages/core/test/supervisor.test.ts',
  'packages/core/test/tooling.test.ts',
  'packages/core/test/invariants/01-core-names-no-plugin.test.ts',
  'packages/core/test/invariants/03-crasher-contained.test.ts',
  'packages/core/test/invariants/04-vanisher-replans.test.ts',
  'packages/core/test/invariants/05-purge-leaves-no-residue.test.ts',
  'packages/core/test/invariants/09-memory-budget.test.ts',
]
const withoutPlugins = existsSync(join(import.meta.dirname, 'plugins')) ? [] : needPlugins

// Two projects, because `pnpm check` runs them as separate gates: a red unit test is a
// bug, a red invariant is the thesis breaking. `pnpm vitest run --project invariants -t <name>`
// runs one check alone — see docs/spec/invariants.md.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // The first-party plugins are JavaScript, and they hold real logic — a download,
          // a child process, a parser over another program's output. Their tests step aside
          // with `plugins/` when the core-alone job moves it, which is the right way round.
          include: [
            'packages/*/test/**/*.test.ts',
            'plugins/*/test/**/*.test.js',
            // The registry is deployed separately and is not in the pnpm workspace, but it
            // is code in this repo and it holds the revoke button.
            'registry/test/**/*.test.ts',
          ],
          exclude: ['**/test/invariants/**', ...withoutPlugins],
        },
      },
      {
        test: {
          name: 'invariants',
          include: ['packages/core/test/invariants/**/*.test.ts'],
          exclude: withoutPlugins,
        },
      },
    ],
  },
})
