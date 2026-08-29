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
 *     plugins/      the first-party plugins, bundled — something to install (M2-7)
 *
 * Data still goes to %LOCALAPPDATA%\Alexia and never beside the executable, which is what
 * makes "delete the folder" a clean uninstall of the program and not of the conversation.
 *
 * **Windows only, and that is a decision rather than an omission (M2-7, D75).** The other
 * platforms are three small changes away — the runtime's filename, the launcher's extension,
 * and the command that opens a browser — and the keyring's platform table already carries
 * their slugs. What stops it is that a bundle nobody has run on a machine that never had
 * Alexia is not a bundle anybody should be handed: `@napi-rs/keyring` reaches libsecret on
 * Linux and the Keychain on macOS, and *whether the app starts at all* is exactly what a
 * packaged build is supposed to answer. The line below fails loudly on an unsupported
 * platform, which is the honest state. The day there is a machine to test on, this becomes
 * a small commit rather than a hope.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
  // `require` for the bundled CommonJS, and **`__filename` for one of them in particular.**
  // `@napi-rs/keyring/index.js` opens with `createRequire(__filename)`, which is free in CJS
  // and undefined in an ESM bundle — so the import threw, cross-keychain's native backend
  // reported itself unsupported, and every secret quietly took the PowerShell route instead.
  // Nothing said so. See D75.
  //
  // Only `__filename`: `__dirname` is already declared inside the bundle by a dependency
  // that shims its own, and a second declaration is a syntax error rather than a shadow.
  banner: {
    js:
      'import{createRequire as __cr}from"node:module";import{fileURLToPath as __ftp}from"node:url";' +
      'const require=__cr(import.meta.url);const __filename=__ftp(import.meta.url);',
  },
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

// And the fallback's script, because a credential store with no second route is a credential
// store that fails silently the day the first one moves. `cross-keychain` reaches it as
// `<its own bundled location>/scripts/credman.ps1`, which after bundling is beside this file.
const keychainDir = dirname(entry(join(root, 'packages', 'core'), 'cross-keychain'))
mkdirSync(join(out, 'scripts'), { recursive: true })
cpSync(join(keychainDir, 'scripts', 'credman.ps1'), join(out, 'scripts', 'credman.ps1'))

// 3. The shell. Everything `serve.ts` serves statically, in the folder its third candidate
//    looks in.
const ui = join(out, 'ui')
mkdirSync(join(ui, 'dist', 'src'), { recursive: true })
for (const file of ['index.html', 'app.css', 'alexia.png']) {
  cpSync(join(root, 'packages', 'ui', file), join(ui, file))
}
// Every compiled shell module, not just the entry point: `serve.ts` serves any `dist/src/
// <name>.js` by name, and M2-1's settings screen is the second one. Naming them here would be
// a list that goes stale the first time somebody adds a third.
cpSync(join(root, 'packages', 'ui', 'dist', 'src'), join(ui, 'dist', 'src'), {
  recursive: true,
  filter: (from) => statSync(from).isDirectory() || from.endsWith('.js'),
})

// 4. Something to install (M2-7). The lifecycle at M2-5 installs from a folder somebody
//    points at, and a packaged Alexia with no folder to point at makes *install → talk →
//    delete* a thing you can only do with a checkout.
//
//    Each one is bundled exactly the way core is, for exactly the same reason: a plugin in
//    this repo reaches its SDK through a pnpm symlink into a store that will not exist on the
//    tester's machine. What ships is a folder holding a manifest, one file, and whatever it
//    bundles — which is also what a registry download will look like at M3.
//
//    `crasher` and `vanisher` are not on this list and are not going to be: they exist to be
//    broken, and handing somebody a plugin whose job is to die is not a demonstration.
//
//    Everything here ships **installable, not installed**. The folder is where somebody
//    points the Add a plugin box until there is a registry to browse — and even after they
//    point at one, it arrives not enabled, because the screen has still to show what it
//    asked for.
//
//    **Trimmed to one, now that there is a registry to browse (`scripts/publish.mjs`).**
//    Eight of these shipped inside the installer and then sat in `resources\plugins\`
//    costing 8.8 MB whether or not anybody wanted them — the exact opposite of *install only
//    what you need*, and reachable only by pasting a path out of `%LOCALAPPDATA%`, which is
//    not a thing the person this is built for will ever do. The rest come off the shelf now.
//
//    `hello` stays, and stays for the reason the list existed: it is the offline proof that
//    installing works at all. A registry is a network call, and a first run behind a captive
//    portal or a dead DNS entry should still be able to demonstrate *install → talk →
//    delete* without one.
const SHIPPED = ['hello']
const plugins = join(out, 'plugins')
for (const id of SHIPPED) {
  const from = join(root, 'plugins', id)
  const to = join(plugins, id)
  mkdirSync(to, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(from, 'plugin.json'), 'utf8'))
  // `$schema` points at a path in this repo, which is not somewhere the tester has. It is a
  // convenience for whoever edits the file, and it does not travel.
  delete manifest.$schema
  writeFileSync(join(to, 'plugin.json'), JSON.stringify(manifest, null, 2))

  // The entry point, and only the entry point: `entry.args` names the script, and everything
  // it imports comes with it.
  const script = (manifest.entry.args ?? []).find((arg) => arg.endsWith('.js'))
  if (!script) throw new Error(`${id} has no script in entry.args to bundle.`)
  await build({
    entryPoints: [join(from, script)],
    outfile: join(to, script),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
  })

  // Its skills, if it brought any (M2-2). They are text and they install and purge with it.
  for (const skill of manifest.skills ?? []) cpSync(join(from, skill), join(to, skill), { recursive: true })
}

// 5. The runtime. 89 MB of Node, which is most of what the tester downloads and the honest
//    price of not asking them to install anything.
cpSync(process.execPath, join(out, 'node.exe'))

// 6. Start it, then take them to it. `Silent is not fine`: the window stays, says where she
//    is, and says what to do if the browser did not come up on its own.
writeFileSync(
  join(out, 'boot.mjs'),
  `// SPDX-License-Identifier: AGPL-3.0-only
// Generated by scripts/package.mjs. The packaged entry point: what \`import.meta.main\`
// does in the repo, done here instead, plus the one thing a browser build has to do that
// a Tauri window at M5 will not — put itself in front of the person who double-clicked.
import { spawn } from 'node:child_process'

// The native keyring is found as a **sibling of alexia.mjs**, which is where it is copied,
// and that works from wherever the folder was unzipped.
//
// It is deliberately *not* pointed at with \`NAPI_RS_NATIVE_LIBRARY_PATH\` (D75). That
// variable is checked first, as its documentation says — and @napi-rs/keyring 1.3.0's loader
// assigns the module it loads to an inner variable and then returns nothing, while its caller
// writes the return value over that same variable. So setting it does not merely fail: it
// takes the branch that would have worked out of reach, and the failure is silent, because
// cross-keychain reads a missing native module as *this backend is not supported here* and
// quietly spawns PowerShell for every secret instead.
const { serve } = await import('./alexia.mjs')

// The port is Alexia's own choice when nothing says otherwise, and the shell's choice when
// something does: the desktop app (M5-1) picks a free port before it builds its windows, so
// that they can be pointed somewhere without waiting for Node to boot.
const { url } = await serve({ port: Number(process.env.ALEXIA_PORT) || 0 })
console.log('Alexia is running.')
console.log('')
console.log('   ' + url)
console.log('')
console.log('Your browser should have opened. If it did not, copy that address into it.')
console.log('')
console.log('More plugins are on the Plugins screen. They download when you ask for them.')
console.log('')
console.log('Closing this window stops Alexia.')

// Detached, and failure is not fatal: if no browser opens, the address above is still on
// screen and the whole thing still works. A launcher that dies because it could not find a
// browser would be worse than one that does nothing.
// Not under the desktop shell, which has its own windows and does not want a browser
// opening a second copy of the same conversation beside them.
if (!process.env.ALEXIA_TAURI) {
  try {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // No browser is not a failure. The address is on screen.
  }
} else {
  /**
   * Under the desktop shell the window is the owner, and this goes when it goes.
   *
   * The shell kills this on its own \`Quit\` and that is the orderly path — but it cannot
   * reach a crash, an abort (the release profile is \`panic = "abort"\`) or somebody ending
   * the process from Task Manager, and what survives all three is a core still holding the
   * database. The next launch then makes a second one beside it, which is the thing nobody
   * wants: **two Alexias on one database.**
   *
   * So the two halves are deliberate and neither replaces the other. The shell's kill is
   * immediate and tidy; this is the one that survives the shell being shot.
   *
   * \`unref\` because the server is what keeps this process alive. This timer is a watcher,
   * not a reason to stay.
   *
   * ponytail: polling, and a pid Windows may eventually hand to something else. A Job
   * Object would be exact and is a page of Rust in a file whose line count is an invariant.
   * The cost of being wrong here is one surviving core, which is today's behaviour.
   */
  const owner = process.ppid
  setInterval(() => {
    try {
      // Signal 0 asks *is it there* and sends nothing.
      process.kill(owner, 0)
    } catch {
      process.exit(0)
    }
  }, 5000).unref()
}
`,
)

// 7. The double-click itself. \`%~dp0\` is this file's own folder, so the whole thing runs
//    from wherever it was unzipped — Desktop, Downloads, a stick.
writeFileSync(
  join(out, 'Alexia.cmd'),
  ['@echo off', 'title Alexia', 'cd /d "%~dp0"', 'node.exe boot.mjs', 'pause', ''].join('\r\n'),
)

/**
 * 8. Start what was just built and ask it one question.
 *
 * A packaged build is the one artefact nothing else in this repo exercises: a different
 * module format, a different resolver and a different folder layout from anything the tests
 * see. It hid three real bugs for a whole milestone, all in the same place and all silent,
 * and running the thing is what found every one of them (D75).
 *
 * `/api/plugins` is the question because it reads manifests, the store *and* the keychain,
 * which is the whole of what a fresh install touches before anybody types anything.
 *
 * ponytail: it proves the build starts, serves the shell and can reach **a** credential
 * store. It cannot say **which** — the native module and the PowerShell fallback answer
 * identically, and telling them apart would mean core reporting its own backend, which is a
 * product change to satisfy a build script. The day a slow first run points back here, that
 * is the thing to add.
 */
const home = mkdtempSync(join(tmpdir(), 'alexia-package-check-'))
const app = spawn(join(out, 'node.exe'), ['boot.mjs'], {
  cwd: out,
  // Its own throwaway `%LOCALAPPDATA%`, so checking the build cannot touch a real install.
  env: { ...process.env, LOCALAPPDATA: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let said = ''
app.stdout.on('data', (chunk) => (said += String(chunk)))
app.stderr.on('data', (chunk) => (said += String(chunk)))

try {
  const url = await new Promise((resolve, reject) => {
    const gaveUp = setTimeout(() => reject(new Error(`it never said where it was:
${said}`)), 30_000)
    const look = setInterval(() => {
      const found = /http:\/\/127\.0\.0\.1:\d+/.exec(said)
      if (!found) return
      clearInterval(look)
      clearTimeout(gaveUp)
      resolve(found[0])
    }, 200)
  })
  const page = await (await fetch(url)).text()
  const token = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(page)?.[0]
  if (!token) throw new Error('the shell it served carries no token')
  const answer = await (await fetch(new URL('/api/plugins', url), { headers: { 'x-alexia-token': token } })).text()
  const state = JSON.parse(answer)
  if (!Array.isArray(state.panes)) throw new Error(`/api/plugins answered ${answer.slice(0, 200)}`)
  console.log('Started, served the shell and read the keychain.')
} finally {
  // Waited for, not just signalled: Windows will not let go of a directory a live process is
  // sitting in, and removing it a millisecond early fails the build over nothing.
  const gone = new Promise((resolve) => app.once('exit', resolve))
  app.kill()
  await gone
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // A temp folder that outlives this script is untidy, not broken.
  }
}

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(1)
console.log(`Packaged to ${out}`)
console.log(`  alexia.mjs  ${mb(join(out, 'alexia.mjs'))} MB`)
console.log(`  node.exe    ${mb(join(out, 'node.exe'))} MB`)
for (const id of SHIPPED) console.log(`  plugins/${id}   ${mb(join(plugins, id, 'index.js'))} MB`)
