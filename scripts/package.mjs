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
 * What comes out is a folder that runs on a machine with nothing installed:
 *
 *   Alexia/
 *     Alexia.cmd    the double-click — `Alexia.command` on macOS, `alexia.sh` on Linux
 *     node.exe      the runtime, copied — `node` off Windows. Node is MIT and redistributable
 *     boot.mjs      start the server, then open the browser at it
 *     alexia.mjs    core, bundled to one file
 *     *.node        the one native dependency that cannot be bundled
 *     ui/           the shell: index.html, app.css, main.js, her face
 *
 * Data still goes to the platform's per-user data folder (`store.ts`) and never beside the
 * executable, which is what makes "delete the folder" a clean uninstall of the program and
 * not of the conversation.
 *
 * **Windows first; macOS since it was run on one (D144).** D75 held the other platforms back
 * as three small changes nobody had run. Running it on a Mac found a fourth, which is the
 * reason D75 held them back: the keyring slug was `darwin-universal`, and `@napi-rs/keyring`
 * 1.3.0 publishes no such package — one per architecture — so this script threw before
 * copying anything. Linux takes the same branches and still has not been run.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-app', 'Alexia')
const windows = process.platform === 'win32'
/** The runtime's filename. `scripts/sidecar.mjs` reads the same name back. */
const runtime = windows ? 'node.exe' : 'node'

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
//    Per platform *and* architecture: there is no universal macOS binary, so an Apple Silicon
//    build carries the arm64 one and an Intel build the x64 one.
const slug = {
  'win32-x64': 'win32-x64-msvc',
  'win32-arm64': 'win32-arm64-msvc',
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
}[`${process.platform}-${process.arch}`]
if (!slug) throw new Error(`No packaged build for ${process.platform}-${process.arch} yet.`)

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
// Windows only: the macOS fallback is the system's own `security` and needs no file.
if (windows) {
  const keychainDir = dirname(entry(join(root, 'packages', 'core'), 'cross-keychain'))
  mkdirSync(join(out, 'scripts'), { recursive: true })
  cpSync(join(keychainDir, 'scripts', 'credman.ps1'), join(out, 'scripts', 'credman.ps1'))
}

// 3. The shell. Everything `serve.ts` serves statically, in the folder its third candidate
//    looks in.
const ui = join(out, 'ui')
mkdirSync(join(ui, 'dist', 'src'), { recursive: true })
for (const file of [
  'index.html',
  'app.css',
  'alexia.png',
  'alexia-mark.svg',
  'alexia-panel.svg',
  'alexia-band.svg',
  // The two theme previews. Not masks like the three above — flat pictures of the two
  // palettes, which is what the settings screen is choosing between.
  'theme-light.webp',
  'theme-dark.webp',
]) {
  cpSync(join(root, 'packages', 'ui', file), join(ui, file))
}
// Every compiled shell module, not just the entry point: `serve.ts` serves any `dist/src/
// <name>.js` by name, and M2-1's settings screen is the second one. Naming them here would be
// a list that goes stale the first time somebody adds a third.
cpSync(join(root, 'packages', 'ui', 'dist', 'src'), join(ui, 'dist', 'src'), {
  recursive: true,
  filter: (from) => statSync(from).isDirectory() || from.endsWith('.js'),
})

/**
 * 4. **Nothing.** No plugin ships inside this build (D118).
 *
 * There used to be a list here, and it went from eight names to one to none. The eight were
 * copied in so that *install → talk → delete* was demonstrable without a registry, and they
 * sat in `resources\plugins\` costing 8.8 MB whether or not anybody wanted them — reachable
 * only by pasting a path out of `%LOCALAPPDATA%`, which is not a thing the person this is
 * built for will ever do. `hello` stayed one milestone longer as the offline proof that
 * installing works at all.
 *
 * It is gone too, because *offline proof* was the last argument for shipping code somebody
 * did not ask for, and it was an argument about the developers rather than about them. What
 * replaced it is a step of first run that reads the shelf and asks *what should it be able to
 * do?* — which is a better answer to the same question, since it offers thirteen plugins
 * rather than one and installs only what was ticked.
 *
 * The consequence, said plainly: **a first run with no network reaches a conversation and
 * nothing else.** That is the honest shape of a product whose plugins are downloads, and the
 * screen says so rather than hiding it.
 */

// 5. The runtime. 89 MB of Node, which is most of what the tester downloads and the honest
//    price of not asking them to install anything.
cpSync(process.execPath, join(out, runtime))

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
const { serve, fromShell } = await import('./alexia.mjs')

// Under the desktop app the shell holds the keychain and hands core the way in down stdin
// (D153), because an entry Node creates is readable by every script Node will run. Awaited
// before anything is served: a shell that hands over nothing is a core that does not start,
// never one that quietly keeps secrets where a plugin can read them.
const secrets = process.env.ALEXIA_TAURI ? await fromShell(process.stdin) : undefined

// The port is Alexia's own choice when nothing says otherwise, and the shell's choice when
// something does: the desktop app (M5-1) picks a free port before it builds its windows, so
// that they can be pointed somewhere without waiting for Node to boot.
const { url } = await serve({ port: Number(process.env.ALEXIA_PORT) || 0, secrets })
console.log('Alexia is running.')
console.log('')
console.log('   ' + url)
console.log('')
console.log('Your browser should have opened. If it did not, copy that address into it.')
console.log('')
console.log('Everything Alexia can do is a plugin, and they are on the Plugins screen.')
console.log('')
console.log('Closing this window stops Alexia.')

// Detached, and failure is not fatal: if no browser opens, the address above is still on
// screen and the whole thing still works. A launcher that dies because it could not find a
// browser would be worse than one that does nothing.
// Not under the desktop shell, which has its own windows and does not want a browser
// opening a second copy of the same conversation beside them.
if (!process.env.ALEXIA_TAURI) {
  const [opener, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]]
  try {
    const browser = spawn(opener, args, { detached: true, stdio: 'ignore' })
    // A missing opener is an \`error\` event rather than a throw, and an unheard one ends the
    // process — so without this, a machine with no \`xdg-open\` would lose Alexia a moment
    // after she said where she was.
    browser.on('error', () => {})
    browser.unref()
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
//    from wherever it was unzipped — Desktop, Downloads, a stick. Off Windows the same thing
//    is \`dirname "$0"\`, and a \`.command\` is what Finder opens in Terminal on a double-click.
if (windows) {
  writeFileSync(
    join(out, 'Alexia.cmd'),
    ['@echo off', 'title Alexia', 'cd /d "%~dp0"', 'node.exe boot.mjs', 'pause', ''].join('\r\n'),
  )
} else {
  writeFileSync(
    join(out, process.platform === 'darwin' ? 'Alexia.command' : 'alexia.sh'),
    ['#!/bin/sh', 'cd "$(dirname "$0")" || exit 1', 'exec ./node boot.mjs', ''].join('\n'),
    { mode: 0o755 },
  )
}

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
 *
 * **This script plays the shell** (D153). Under `ALEXIA_TAURI` core will not start until it
 * is handed a vault on stdin, so a stand-in is opened here and its line written down the
 * pipe — which also means the packaged handover is exercised, not just the unpackaged one.
 *
 * **It keeps what it is given, and it says there is nothing older to move** (D187). It used to
 * answer *ok* to every write and keep nothing — and core, finding nothing in it, moved a real
 * install's keys out of the old place into it and deleted them there, so building the app
 * deleted a developer's keys. A throwaway data folder does not isolate a keychain: Windows'
 * is per user whatever `LOCALAPPDATA` says. So the one entry is seeded with `moved: 'all'`,
 * which is the stand-in telling core never to look in the old places at all.
 */
const kept = new Map([['_core.vault', JSON.stringify({ secrets: {}, looked: [], moved: 'all' })]])
const vault = createServer((socket) => {
  let heard = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    heard += chunk
    const end = heard.indexOf('\n')
    if (end === -1) return
    let answer
    try {
      const ask = JSON.parse(heard.slice(0, end))
      if (ask.token !== 'package-check') answer = { error: 'refused' }
      else if (ask.op === 'get') answer = { ok: true, secret: kept.get(ask.account) ?? null }
      else if (ask.op === 'set' && typeof ask.secret === 'string') {
        kept.set(ask.account, ask.secret)
        answer = { ok: true, secret: null }
      } else if (ask.op === 'delete') {
        kept.delete(ask.account)
        answer = { ok: true, secret: null }
      } else answer = { error: 'not an operation' }
    } catch {
      answer = { error: 'not a request' }
    }
    socket.end(`${JSON.stringify(answer)}\n`)
  })
})
await new Promise((resolve) => vault.listen(0, '127.0.0.1', resolve))
const home = mkdtempSync(join(tmpdir(), 'alexia-package-check-'))
const app = spawn(join(out, runtime), ['--disable-sigusr1', 'boot.mjs'], {
  cwd: out,
  // Its own throwaway data folder, so checking the build cannot touch a real install. Each
  // platform finds that folder through a different variable (`store.ts`), so all three are
  // pointed at it: `LOCALAPPDATA` alone left a Mac checking against the real one.
  // `ALEXIA_TAURI` because under it no browser opens — a build check has no one to show.
  env: { ...process.env, LOCALAPPDATA: home, HOME: home, XDG_DATA_HOME: home, ALEXIA_TAURI: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
app.stdin.write(`${JSON.stringify({ port: vault.address().port, token: 'package-check' })}\n`)
let said = ''
app.stdout.on('data', (chunk) => (said += String(chunk)))
app.stderr.on('data', (chunk) => (said += String(chunk)))

try {
  const url = await new Promise((resolve, reject) => {
    // Every way out clears both clocks, so a build that fails says why and ends rather than
    // hanging with an interval still ticking.
    const done = (error, found) => {
      clearInterval(look)
      clearTimeout(gaveUp)
      app.off('exit', exited)
      if (error) reject(error)
      else resolve(found)
    }
    // A core that refused the handover, or crashed, has exited well before the clock runs out,
    // and what it said is the whole of the diagnosis.
    const exited = (code, signal) => done(new Error(`it exited (${signal ?? code}) before saying where it was:\n${said}`))
    app.once('exit', exited)
    const gaveUp = setTimeout(() => done(new Error(`it never said where it was:\n${said}`)), 30_000)
    const look = setInterval(() => {
      const found = /http:\/\/127\.0\.0\.1:\d+/.exec(said)
      if (found) done(undefined, found[0])
    }, 200)
  })
  const page = await (await fetch(url)).text()
  const token = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(page)?.[0]
  if (!token) throw new Error('the shell it served carries no token')
  const answer = await (await fetch(new URL('/api/plugins', url), { headers: { 'x-alexia-token': token } })).text()
  const state = JSON.parse(answer)
  if (!Array.isArray(state.panes)) throw new Error(`/api/plugins answered ${answer.slice(0, 200)}`)
  console.log('Started, took the handover, served the shell and read the keychain.')
} finally {
  // Waited for, not just signalled: Windows will not let go of a directory a live process is
  // sitting in, and removing it a millisecond early fails the build over nothing.
  // One that has already exited will never say so again, and waiting for it would hang the build.
  if (app.exitCode === null && app.signalCode === null) {
    const gone = new Promise((resolve) => app.once('exit', resolve))
    app.kill()
    await gone
  }
  vault.close()
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // A temp folder that outlives this script is untidy, not broken.
  }
}

const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(1)
console.log(`Packaged to ${out}`)
console.log(`  alexia.mjs  ${mb(join(out, 'alexia.mjs'))} MB`)
console.log(`  ${runtime.padEnd(10)}  ${mb(join(out, runtime))} MB`)
