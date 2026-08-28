// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Invariant 2, on the machine you are sitting at: **core passes its full suite with
 * `plugins/` empty.**
 *
 * There has been a CI job for this since P0-2, and it was red for two milestones without
 * anybody finding out, because the only way to run it was to push. Four test files that use
 * the repo's own plugins as fixtures had never joined `needPlugins` in `vitest.config.ts`,
 * and `pnpm check` cannot see that: it runs with `plugins/` present, which is the one
 * condition the check exists to remove.
 *
 * So: move the folder aside, run `pnpm check`, put it back — whatever happens. An invariant
 * you can only run somewhere you do not look is not a check.
 *
 * It moves a tracked directory, which is the whole point and also the risk. If this is ever
 * killed hard enough to skip the restore, the folder is sitting next to `plugins/` under the
 * name below and `git status` says so.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const plugins = join(repo, 'plugins')
const aside = join(repo, 'plugins-moved-aside-by-no-plugins-script')

if (!existsSync(plugins)) {
  console.error(`No ${plugins} to move. If ${aside} exists, an earlier run was killed — rename it back.`)
  process.exit(1)
}
if (existsSync(aside)) {
  console.error(`${aside} is already there, from a run that was killed. Rename it back to plugins/ first.`)
  process.exit(1)
}

// Restore on the way out of anything: a normal finish, a thrown error, or Ctrl-C.
const restore = () => {
  if (existsSync(aside)) renameSync(aside, plugins)
}
process.on('exit', restore)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}

renameSync(plugins, aside)
const { status } = spawnSync('pnpm', ['check'], { cwd: repo, stdio: 'inherit', shell: true })
restore()

if (status !== 0) {
  console.error(
    '\nInvariant 2 is red: core does not pass its suite with plugins/ absent.\n' +
      'A test that uses a plugin as a fixture belongs in `needPlugins` in vitest.config.ts.',
  )
}
process.exit(status ?? 1)
