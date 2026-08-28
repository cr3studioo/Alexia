// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The crude installer (M1-I1, pulled forward from M2-7).
 *
 * It exists because of one sentence in a cold-install report that was never going to be
 * true: *"hand them a terminal command."* A machine that has never had Alexia on it has no
 * Node, no pnpm and no repo, so `pnpm start` there measures npm for twenty minutes and
 * Alexia for none. cold-install.md permits a terminal command at test #1; the machine does
 * not. Alexia.md settled the principle already — *"a build that person can double-click has
 * to exist long before M5"*.
 *
 * Not signed, not pretty, no auto-update. `Ugly is fine. Silent is not.`
 *
 * What comes out is a folder that runs on a Windows box with nothing installed:
 *
 *   Alexia/
 *     Alexia.cmd    the double-click
 *     node.exe      the runtime, copied — Node is MIT and redistributable
 *     boot.mjs      start the server, then open the browser at it
 *     alexia.mjs    core, bundled to one file
 *     *.node        the one native dependency that cannot be bundled
 *     ui/           the shell: index.html, app.css, main.js, her face
 *
 * Data still goes to %LOCALAPPDATA%\Alexia and never beside the executable, which is what
 * makes "delete the folder" a clean uninstall of the program and not of the conversation.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-app', 'Alexia')

/**
 * What a package resolves to, seen from a given folder — its entry file, not its folder,
 * because a package.json is not reliably reachable: `exports` is allowed to hide it and
 * napi-rs's platform packages do exactly that.
 *
 * It has to be walked hop by hop. pnpm's store is strict on purpose — a package can only
 * see what it declared — so a transitive dependency is not resolvable from the repo root,
 * only from whatever declared it.
 */
const entry = (fromDir, id) => createRequire(join(fromDir, 'resolving.js')).resolve(id)

rmSync(join(root, 'dist-app'), { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1. Core, bundled. ESM out, because serve.ts reads `import.meta.dirname` to find the shell
//    and `import.meta.main` to know it is being run rather than imported — both of which a
//    CJS bundle would quietly destroy. The banner gives the bundled CommonJS dependencies
//    the `require` they expect, resolved against this file, which is also what makes the
//    `.node` below land as a sibling.
await build({
  entryPoints: [join(root, 'packages', 'core', 'dist', 'src', 'serve.js')],
  outfile: join(out, 'alexia.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // A `.node` is a compiled binary; a bundler can only leave it alone and let the runtime
  // load it from beside the output. Two patterns, because napi-rs reaches its binary two
  // ways: a sibling file (which `*.node` covers and which the copy below satisfies) and a
  // per-platform package whose *entry point* is the binary — no `.node` in the specifier
  // for the first pattern to match, and a hard build error if it is left to be bundled.
  external: ['*.node', '@napi-rs/keyring-*'],
  banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
})

// 2. The one thing that cannot be bundled. `@napi-rs/keyring` is how a key reaches the
//    Windows credential locker instead of the database, so this is not optional — losing it
//    would mean silently falling back to storing secrets somewhere worse.
const slug = { win32: 'win32-x64-msvc', darwin: 'darwin-universal', linux: 'linux-x64-gnu' }[process.platform]
if (!slug) throw new Error(`No packaged build for ${process.platform} yet.`)

let at = join(root, 'packages', 'core')
for (const hop of ['cross-keychain', '@napi-rs/keyring']) at = dirname(entry(at, hop))
// The platform package's entry point *is* the binary, so resolving it is the same as
// finding it — and it is found rather than named, which is what stops this script quietly
// shipping yesterday's copy under today's filename.
const source = entry(at, `@napi-rs/keyring-${slug}`)
const native = basename(source)
cpSync(source, join(out, native))

// 3. The shell. Everything `serve.ts` serves statically, in the folder its third candidate
//    looks in.
const ui = join(out, 'ui')
mkdirSync(join(ui, 'dist', 'src'), { recursive: true })
for (const file of ['index.html', 'app.css', 'alexia.png']) {
  cpSync(join(root, 'packages', 'ui', file), join(ui, file))
}
cpSync(join(root, 'packages', 'ui', 'dist', 'src', 'main.js'), join(ui, 'dist', 'src', 'main.js'))

// 4. The runtime. 89 MB of Node, which is most of what the tester downloads and the honest
//    price of not asking them to install anything.
cpSync(process.execPath, join(out, 'node.exe'))

// 5. Start it, then take them to it. `Silent is not fine`: the window stays, says where she
//    is, and says what to do if the browser did not come up on its own.
writeFileSync(
  join(out, 'boot.mjs'),
  `// SPDX-License-Identifier: AGPL-3.0-only
// Generated by scripts/package.mjs. The packaged entry point: what \`import.meta.main\`
// does in the repo, done here instead, plus the one thing a browser build has to do that
// a Tauri window at M5 will not — put itself in front of the person who double-clicked.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The native keyring, by absolute path. napi-rs checks this before every other route it
// has, so the folder can be unzipped anywhere and the credential locker still works. It is
// set before the import rather than after, which is why the import below is dynamic: a
// static one is hoisted above every statement here, including this one.
const here = dirname(fileURLToPath(import.meta.url))
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(here, '${native}')

const { serve } = await import('./alexia.mjs')

const { url } = await serve()
console.log('Alexia is running.')
console.log('')
console.log('   ' + url)
console.log('')
console.log('Your browser should have opened. If it did not, copy that address into it.')
console.log('Closing this window stops Alexia.')

// Detached, and failure is not fatal: if no browser opens, the address above is still on
// screen and the whole thing still works. A launcher that dies because it could not find a
// browser would be worse than one that does nothing.
try {
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref()
} catch {
  // No browser is not a failure. The address is on screen.
}
`,
)

// 6. The double-click itself. \`%~dp0\` is this file's own folder, so the whole thing runs
//    from wherever it was unzipped — Desktop, Downloads, a stick.
writeFileSync(
  join(out, 'Alexia.cmd'),
  ['@echo off', 'title Alexia', 'cd /d "%~dp0"', 'node.exe boot.mjs', 'pause', ''].join('\r\n'),
)

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(1)
console.log(`Packaged to ${out}`)
console.log(`  alexia.mjs  ${mb(join(out, 'alexia.mjs'))} MB`)
console.log(`  node.exe    ${mb(join(out, 'node.exe'))} MB`)
