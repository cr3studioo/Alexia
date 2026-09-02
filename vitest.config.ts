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
  'packages/core/test/commitments.test.ts',
  'packages/core/test/documents.test.ts',
  'packages/core/test/lifecycle.test.ts',
  'packages/core/test/noticing.test.ts',
  'packages/core/test/ocr.test.ts',
  'packages/core/test/panels.test.ts',
  'packages/core/test/plugin-panels.test.ts',
  'packages/core/test/plugins.test.ts',
  'packages/core/test/progress.test.ts',
  'packages/core/test/registry.test.ts',
  'packages/conformance/test/conform.test.ts',
  'packages/core/test/replan.test.ts',
  'packages/core/test/shutdown.test.ts',
  'packages/core/test/tiers.test.ts',
  'packages/core/test/skills.test.ts',
  'packages/core/test/stop.test.ts',
  'packages/core/test/supervisor.test.ts',
  'packages/core/test/tooling.test.ts',
  'packages/core/test/invariants/01-core-names-no-plugin.test.ts',
  'packages/core/test/invariants/03-crasher-contained.test.ts',
  'packages/core/test/invariants/04-vanisher-replans.test.ts',
  'packages/core/test/invariants/05-purge-leaves-no-residue.test.ts',
  'packages/core/test/invariants/09-memory-budget.test.ts',
  'packages/core/test/invariants/13-widgets-can-fill-themselves.test.ts',
]
const withoutPlugins = existsSync(join(import.meta.dirname, 'plugins')) ? [] : needPlugins

/**
 * Long enough for what this suite actually does.
 *
 * Vitest's default is five seconds, which is a limit for pure functions. Half of this suite
 * spawns real plugin processes over real pipes, runs sqlite migrations, and starts HTTP
 * servers — and it runs eighty-eight files at once. Under that load a spawn that takes one
 * second alone takes six, and the failure is a timeout on a test that is not slow and not
 * broken. It cost a release: CI went red on *a database from the previous schema is carried
 * forward* while the same file passed in 1.6 seconds on its own.
 *
 * The suite already knew: the tests that were written after somebody hit this pass `30_000`
 * by hand. This makes that the default rather than a thing each author has to remember, and
 * it hides nothing — a test that genuinely hangs still fails, thirty seconds later.
 */
const testTimeout = 30_000

// Two projects, because `pnpm check` runs them as separate gates: a red unit test is a
// bug, a red invariant is the thesis breaking. `pnpm vitest run --project invariants -t <name>`
// runs one check alone — see docs/spec/invariants.md.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          testTimeout,
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
          testTimeout,
          include: ['packages/core/test/invariants/**/*.test.ts'],
          exclude: withoutPlugins,
        },
      },
    ],
  },
})
