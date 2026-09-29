// SPDX-License-Identifier: AGPL-3.0-only
/**
 * **One plugin from `plugins/`, built into the tree that is installed** — shared by
 * `publish.mjs` (which packs it) and `dev-app.mjs` (which copies it into Alexia Dev).
 *
 * A plugin in this repo reaches its SDK through a pnpm symlink into a store nobody installing it
 * has, so what is installed is a manifest, one bundled file, and the skills it brought with it —
 * built exactly the way `package.mjs` builds core.
 *
 * The manifest is held to the loader's own schema first: one that would not load is refused
 * here, in a second, rather than on a machine after a download.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Manifest } from '../packages/protocol/dist/src/index.js'

/** Build `plugins/<id>` into `tree`. Throws with a sentence when it cannot. Returns the manifest. */
export async function bundlePlugin(root, id, tree) {
  const from = join(root, 'plugins', id)
  const raw = JSON.parse(readFileSync(join(from, 'plugin.json'), 'utf8'))
  // `$schema` points at a path in this repo, which is not somewhere anybody installing it has.
  delete raw.$schema

  const parsed = Manifest.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(`${id}: plugin.json is not valid — ${first?.path.join('.')} ${first?.message}`)
  }
  const manifest = parsed.data
  // `Library.install` refuses when the row and the manifest disagree, calling it a substitution.
  if (manifest.id !== id) throw new Error(`${id}: its plugin.json calls it "${manifest.id}". The folder name is the id.`)

  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'plugin.json'), JSON.stringify(raw, null, 2))
  const script = (manifest.entry.args ?? []).find((arg) => arg.endsWith('.js'))
  if (!script) throw new Error(`${id}: no script in entry.args to bundle.`)
  await build({
    entryPoints: [join(from, script)],
    outfile: join(tree, script),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
    logLevel: 'error',
  })
  // Its skills (M2-2). Text, and they install and purge with the plugin that brought them.
  for (const skill of manifest.skills ?? []) cpSync(join(from, skill), join(tree, skill), { recursive: true })
  return manifest
}
