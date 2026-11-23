// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { files, repoRoot } from './invariants/_repo.js'

/**
 * **One Alexia at a time.**
 *
 * **Not an eleventh invariant**, for the reason M6-1 gave (D82): the ten are about the plugin
 * contract and what survives a folder being deleted, and this is the desktop shell's own
 * correctness. So it joins `pnpm check` on its own merits and the ten stay ten. It has to be
 * a check of some kind because it is otherwise only visible by quitting a real window on a
 * real desktop and then looking at Task Manager, which is how it went unnoticed.
 *
 * **Found by looking, on 2026-08-29.** Two `alexia-core.exe` were alive with dead parents,
 * each holding a port and the database open. `spawn()` hands back a handle and dropping it
 * does not stop the process, so quitting from the tray left the core running — and the next
 * launch put a second one beside it on the same SQLite file.
 *
 * **The fix is deliberately two halves and neither replaces the other**, which is exactly the
 * sort of thing a later tidy-up removes one of:
 *
 * - the shell kills the core on `RunEvent::Exit` — immediate, orderly, and the path Quit
 *   takes;
 * - the core watches its parent and exits when it goes — slower, and the only one that
 *   survives a crash, an abort (`panic = "abort"` in the release profile) or Task Manager.
 *
 * **What must not change is the tray.** Closing the main window hides it and Alexia carries
 * on; that is the daemon, and the check below holds `prevent_close` in place beside the rest.
 */

const shell = () => files(['src-tauri/src/main.rs'])[0]?.text ?? ''
/** Where the shell finds, knocks on and stops the hub (P2D-13). */
const hubRs = () => files(['src-tauri/src/hub.rs'])[0]?.text ?? ''
/** Named without the number the invariants folder uses, because it is not one of them. */
const packager = () => files(['scripts/package.mjs'])[0]?.text ?? ''

test('one Alexia at a time: the shell keeps the hub it started and stops it on exit', () => {
  const source = shell()
  // Kept rather than dropped — and its events kept too, because they are the only way to hear
  // that the hub stopped. Dropping the handle closes the hub's stdin, which is its stop.
  expect(source, 'the hub handle must be kept').toMatch(/let \(mut events, child\) = hub_command\(app, port\)\?\.spawn\(\)\?;/)
  expect(source).toContain('= Some(child);')
  expect(source).toContain('Mutex::<Option<CommandChild>>::new(None)')
  expect(source).toContain('.env("ALEXIA_HUB_STOP_ON_EOF", "1")')

  // And stopped when the app actually ends — only if this shell started it (P2D-13): a hub from
  // Task Scheduler or a console serves Telegram too. `.run(generate_context!())` cannot do this —
  // it takes no event handler, which is how the leak got in.
  const exit = source.slice(source.indexOf('RunEvent::Exit =>'))
  expect(exit).toMatch(/if hub::ours\(held\(app\)\) \{\s*if let Some\(hub\) = take_hub\(app, None\) \{\s*hub::stop\(hub\);/)
  expect(source, 'the run loop needs an event handler to hang the stop on').not.toMatch(
    /\.run\(tauri::generate_context!\(\)\)/,
  )
  // The stop closes stdin first and kills only what is still there after a wait.
  const stop = hubRs().slice(hubRs().indexOf('pub fn stop('))
  expect(stop.indexOf('drop(hub)')).toBeGreaterThan(-1)
  expect(stop.indexOf('drop(hub)')).toBeLessThan(stop.indexOf('taskkill'))
})

test('a hub that stops on its own is looked for or started again, and one stopped by quitting is not', () => {
  const source = shell()
  // Every event drained until the one that says it ended.
  expect(source).toMatch(/while let Some\(event\) = events\.blocking_recv\(\)/)
  expect(source).toContain('CommandEvent::Terminated')
  // Quitting says so before it stops anything, and the watch asks before and after its wait.
  const exit = source.slice(source.indexOf('RunEvent::Exit =>'))
  expect(exit.indexOf('QUITTING.store(true')).toBeGreaterThan(-1)
  expect(exit.indexOf('QUITTING.store(true')).toBeLessThan(exit.indexOf('hub::stop('))
  expect(source).toContain('!QUITTING.load(Ordering::SeqCst) && GENERATION.load(Ordering::SeqCst) == generation')
  const again = source.slice(source.indexOf('fn again('), source.indexOf('fn start('))
  expect(again).toMatch(/if !current\(generation\) \{\s*return;/)
  expect(again).toMatch(/if current\(generation\) \{\s*launch\(app, lapse\);/)
  // Growing waits with a ceiling, never a tight loop.
  expect(again).toContain('thread::sleep(Duration::from_secs(1 << lapse.min(6)));')
  // Both watches go through it: the started hub's events and the attached hub's port.
  expect(source.match(/again\(&app, began, lapse, generation\);/g)?.length).toBe(2)
})

test('the shell attaches to a hub already running and never stops it', () => {
  const source = shell()
  const launch = source.slice(source.indexOf('fn launch('), source.indexOf('fn say('))
  expect(launch).toContain('hub::find(')
  expect(launch).toContain('attach(app, port, lapse, generation)')
  expect(launch).toContain('start(app, free_port(), lapse, generation)')
  // An attached hub holds no child, so nothing of it is in the slot quitting empties.
  const attach = source.slice(source.indexOf('fn attach('), source.indexOf('fn current('))
  expect(attach).not.toContain('CommandChild')
  expect(attach).not.toMatch(/kill|stop\(/)
  // *Try again* kills only ours; otherwise it looks again.
  const again = source.slice(source.indexOf('listen_any("start-core-again"'))
  expect(again).toMatch(/if !hub::ours\(held\(&handle\)\) \{[^}]*launch\(/)
  // `window.json` is read the way the hub writes it, and a dead pid is no hub.
  expect(hubRs()).toContain('join("window.json")')
  expect(hubRs()).toContain('"ALEXIA_V3_DATA"')
  expect(hubRs()).toMatch(/alive\(window\.pid\)/)
})

test('the windows wait for the hub: the starting page first, the hub only once it is listening', () => {
  const source = shell()
  expect(source).toContain('WebviewUrl::App("index.html".into())')
  expect(source, 'a window pointed at the hub before it listens stays white').not.toContain('WebviewUrl::External')
  expect(hubRs()).toMatch(/TcpStream::connect_timeout\(/)
  expect(source).toMatch(/if hub::answers\(port\) \{\s*return navigate\(&waiting, port\);/)
  expect(source).toMatch(/window\.navigate\(url\.clone\(\)\)/)
  // Never the edge of the screen.
  expect(source.slice(source.indexOf('fn navigate('))).toMatch(/if label != "control" \{\s*let _ = window\.navigate/)
  // The page's *Try again* is an event this process listens for, by the same name.
  const page = files(['src-tauri/placeholder/index.html'])[0]?.text ?? ''
  expect(page).toContain("emit('start-core-again')")
  expect(source).toContain('listen_any("start-core-again"')
  // And when there is no hub to start, the page says so rather than waiting forever.
  expect(page).toContain('id="late"')
  expect(hubRs()).toContain('pub const NOT_FOUND')
})

test('the overlay is shown on the main thread, whichever thread asked', () => {
  const source = shell()
  // `--overlay` arrives on single-instance's own thread; the panel is AppKit, and WebKit crashes
  // a process that touches it from any thread but the main one.
  const reveal = source.slice(source.indexOf('fn reveal('), source.indexOf('fn open_main('))
  expect(reveal).toContain('run_on_main_thread')
  expect(reveal.indexOf('run_on_main_thread')).toBeLessThan(reveal.indexOf('show_and_make_key'))
})

test('one Alexia at a time: the core watches its owner, for the exits Rust cannot reach', () => {
  const source = packager()
  expect(source).toContain('const owner = process.ppid')
  // Signal 0 asks whether it is there and sends nothing.
  expect(source).toMatch(/process\.kill\(owner, 0\)/)
  expect(source).toContain('process.exit(0)')
  // Only under the shell. A folder somebody unzipped has no owner to watch, and a watcher
  // there would be a process that quits when whatever launched it does.
  expect(source).toContain("if (!process.env.ALEXIA_TAURI)")
})

test('one Alexia at a time: the core hears its pipe close at once, and takes its plugins with it', () => {
  const source = packager()
  // The shell's end of stdin closes the moment the shell goes, however it went. The poll above
  // is the fallback; this is the prompt half.
  expect(source).toContain("process.stdin.once('end', leave)")
  expect(source).toContain('process.stdin.resume()')
  // A polite stop is honoured too, rather than dying with the plugins still running.
  expect(source).toContain("process.once('SIGTERM', leave)")
  // Leaving stops the plugins first (`close` is `plugins.stop()` and the rest), with a limit,
  // so a stop that hangs cannot keep a quit Alexia alive.
  expect(source).toContain('const { url, close } = await start(')
  expect(source).toMatch(/Promise\.race\(\[close\(\), new Promise\(\(resolve\) => setTimeout\(resolve, \d+\)\)\]\)/)
  // The watcher goes through the same door.
  expect(source).toMatch(/process\.kill\(owner, 0\)\s*\} catch \{\s*leave\(\)/)
})

test('one Alexia at a time: and closing a window still only puts it away', () => {
  // The half that must not be "fixed" along with the other one. Alexia is a daemon: closing
  // its window is putting it away, not switching it off, and the tray is the whole point.
  const source = shell()
  expect(source).toMatch(/WindowEvent::CloseRequested/)
  expect(source).toMatch(/api\.prevent_close\(\)/)
  expect(source).toMatch(/closing\.hide\(\)/)
  // One instance, so a second launch raises the window rather than starting a second core.
  expect(source).toContain('tauri_plugin_single_instance::init')
})

test('one Alexia at a time: the scanner is actually reading both files', () => {
  // A glob that matches nothing passes silently, forever, and looks exactly like a fix.
  expect(shell().length).toBeGreaterThan(1000)
  expect(hubRs().length).toBeGreaterThan(1000)
  expect(packager().length).toBeGreaterThan(1000)
})

/** Execute the staging script with fake builds and files: no package, installer or signing. */
async function staged(options: { host: string; arch?: string; universal?: boolean; targetDir?: string; cargoStatus?: number; missing?: string }) {
  const source = files(['scripts/sidecar.mjs'])[0]?.text ?? ''
  const commands: { command: string; args: string[] }[] = []
  const copies: [string, string][] = []
  const archive = Buffer.from('fake archive')
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const integrity = createHash('sha512').update(archive).digest('base64')
  const platform = options.host.includes('windows') ? 'win32' : options.host.includes('darwin') ? 'darwin' : 'linux'
  const program = source.replace(/^import .+\r?\n/gm, '').replaceAll('import.meta.url', 'scriptUrl')
  await runInNewContext(`(async () => {\n${program}\n})()`, {
    scriptUrl: pathToFileURL(join(repoRoot, 'scripts', 'sidecar.mjs')).href,
    dirname, join, resolve, fileURLToPath, createHash, Buffer,
    process: {
      platform, arch: options.arch ?? 'x64', version: 'v26.8.2', execPath: 'fake-node',
      argv: options.universal ? ['--universal'] : [],
      env: options.targetDir ? { CARGO_TARGET_DIR: options.targetDir } : {},
      exit: (status: number) => { throw new Error(`exit ${status}`) },
    },
    console: { log: () => {}, error: () => {} },
    spawnSync: (command: string, args: string[]) => {
      commands.push({ command, args })
      return { status: command === 'cargo' ? options.cargoStatus ?? 0 : 0, stdout: `host: ${options.host}\n` }
    },
    cpSync: (from: string, to: string) => { copies.push([from, to]) },
    existsSync: (path: string) => !(options.missing && path.includes(options.missing)),
    mkdirSync: () => {}, rmSync: () => {}, writeFileSync: () => {},
    mkdtempSync: (prefix: string) => `${prefix}fixture`, tmpdir: () => join(repoRoot, 'fake-tmp'),
    readdirSync: (dir: string) => dir.endsWith(join('dist', 'src'))
      ? ['main.js', 'settings.js', 'main.d.ts', 'main.js.map']
      : dir.endsWith(join('packages', 'ui')) ? ['index.html', 'compute.html', 'app.css', 'alexia.png', 'alexia-mark.svg', 'theme-dark.webp', 'package.json', 'tsconfig.json', 'notes.md'] : [],
    readFileSync: () => `'@napi-rs/keyring-darwin-arm64@1.0.0':\n  resolution: {integrity: sha512-${integrity}}\n'@napi-rs/keyring-darwin-x64@1.0.0':\n  resolution: {integrity: sha512-${integrity}}`,
    fetch: async () => ({ ok: true, text: async () => `${sha256}  node-v26.8.2-darwin-arm64.tar.gz\n${sha256}  node-v26.8.2-darwin-x64.tar.gz`, arrayBuffer: async () => archive }),
  })
  return { commands, copies }
}

test.each(['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin'])('packaging: %s stages the Cargo release binary beside core', async (host) => {
  const { commands, copies } = await staged({ host })
  const targetDir = join(repoRoot, 'connect', 'target')
  expect(commands.filter(({ command, args }) => command === 'cargo' && args.includes(join(repoRoot, 'connect', 'Cargo.toml')))).toEqual([{
    command: 'cargo', args: ['build', '--release', '--locked', '--manifest-path', join(repoRoot, 'connect', 'Cargo.toml'), '--target-dir', targetDir],
  }])
  const suffix = host.includes('windows') ? '.exe' : ''
  expect(copies).toContainEqual([join(targetDir, 'release', `alexia-connect${suffix}`), join(repoRoot, 'src-tauri', 'binaries', `alexia-connect-${host}${suffix}`)])
})

test.each(['arm64', 'x64'])('packaging: a universal Mac from %s builds both transport halves and merges them', async (arch) => {
  const { commands, copies } = await staged({ host: `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, arch, universal: true })
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  const cargo = commands.filter(({ command, args }) => command === 'cargo' && args.includes(join(repoRoot, 'connect', 'Cargo.toml')))
  expect(cargo).toHaveLength(2)
  const halves = targets.map((target, index) => {
    expect(cargo[index]?.args.slice(-2)).toEqual(['--target', target])
    const from = join(repoRoot, 'connect', 'target', target, 'release', 'alexia-connect')
    expect(copies).toContainEqual([from, join(repoRoot, 'src-tauri', 'binaries', `alexia-connect-${target}`)])
    return from
  })
  expect(commands).toContainEqual({ command: 'lipo', args: ['-create', '-output', join(repoRoot, 'src-tauri', 'binaries', 'alexia-connect-universal-apple-darwin'), ...halves] })
})

test('packaging: an isolated Cargo directory is both built into and copied from', async () => {
  const targetDir = join(repoRoot, 'connect', 'target', 'dev')
  const { commands, copies } = await staged({ host: 'aarch64-apple-darwin', targetDir })
  expect(commands.find(({ command }) => command === 'cargo')?.args.slice(-2)).toEqual(['--target-dir', targetDir])
  expect(copies).toContainEqual([join(targetDir, 'release', 'alexia-connect'), join(repoRoot, 'src-tauri', 'binaries', 'alexia-connect-aarch64-apple-darwin')])
  const dev = files(['scripts/dev-app.mjs'])[0]?.text ?? ''
  expect(dev).toMatch(/run\('pnpm', \['sidecar'\], \{\s*env: \{ \.\.\.process.env, ALEXIA_KEYCHAIN: KEYCHAIN, CARGO_TARGET_DIR: join\(root, 'connect', 'target', 'dev'\)/)
})

test('packaging: a failed Cargo build or missing output stops staging', async () => {
  await expect(staged({ host: 'aarch64-apple-darwin', cargoStatus: 1 })).rejects.toThrow('cargo could not build alexia-connect')
  await expect(staged({ host: 'aarch64-apple-darwin', missing: 'alexia-connect' })).rejects.toThrow('cargo produced no')
  await expect(staged({ host: 'x86_64-pc-windows-msvc', missing: 'alexia-hub' })).rejects.toThrow(/cargo produced no .*alexia-hub\.exe/)
  await expect(staged({ host: 'x86_64-pc-windows-msvc', missing: 'index.html' })).rejects.toThrow('staging left no')
})

test.each(['x86_64-pc-windows-msvc', 'aarch64-apple-darwin'])('packaging: %s builds the hub into v3/target and stages it with the UI it serves', async (host) => {
  const targetDir = join(repoRoot, 'connect', 'target', 'dev')
  const { commands, copies } = await staged({ host, targetDir })
  const hubTarget = join(repoRoot, 'v3', 'target')
  // Into v3's own target folder whatever CARGO_TARGET_DIR says, so the copy is what was just built.
  expect(commands).toContainEqual({
    command: 'cargo', args: ['build', '--release', '--locked', '-p', 'alexia-hub', '--manifest-path', join(repoRoot, 'v3', 'Cargo.toml'), '--target-dir', hubTarget],
  })
  const suffix = host.includes('windows') ? '.exe' : ''
  const resources = join(repoRoot, 'src-tauri', 'resources')
  expect(copies).toContainEqual([join(hubTarget, 'release', `alexia-hub${suffix}`), join(resources, 'hub', `alexia-hub${suffix}`)])
  // The UI exactly as statics.rs serves it, compiled modules kept under dist/src.
  const ui = join(repoRoot, 'packages', 'ui')
  const staged_ = copies.filter(([, to]) => to.startsWith(join(resources, 'ui'))).map(([from, to]) => [from.slice(ui.length), to.slice(join(resources, 'ui').length)])
  expect(staged_.map(([from]) => from).sort()).toEqual(
    ['index.html', 'compute.html', 'app.css', 'alexia.png', 'alexia-mark.svg', 'theme-dark.webp', join('dist', 'src', 'main.js'), join('dist', 'src', 'settings.js')].map((name) => join(sep, name)).sort(),
  )
  for (const [from, to] of staged_) expect(to).toBe(from)
  // No Node core any more: nothing it ran is staged.
  for (const gone of ['boot.mjs', 'alexia.mjs', 'scripts']) expect(copies.some(([, to]) => to === join(resources, gone))).toBe(false)
  // On a Mac the hub is signed, since Tauri signs nothing under resources.
  if (!suffix) expect(commands).toContainEqual(expect.objectContaining({ command: 'codesign', args: expect.arrayContaining([join(resources, 'hub', 'alexia-hub')]) }))
})

test('packaging: a universal Mac builds both hub halves and merges them', async () => {
  const { commands } = await staged({ host: 'aarch64-apple-darwin', arch: 'arm64', universal: true })
  const hubTarget = join(repoRoot, 'v3', 'target')
  const halves = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((target) => {
    expect(commands).toContainEqual(expect.objectContaining({ command: 'cargo', args: expect.arrayContaining(['alexia-hub', '--target', target]) }))
    return join(hubTarget, target, 'release', 'alexia-hub')
  })
  expect(commands).toContainEqual({ command: 'lipo', args: ['-create', '-output', join(repoRoot, 'src-tauri', 'resources', 'hub', 'alexia-hub'), ...halves] })
})

test('packaging: NSIS and DMG inherit both external binaries without dev configuration', () => {
  const base = files(['src-tauri/tauri.conf.json'])[0]?.text ?? ''
  const mac = files(['src-tauri/tauri.macos.conf.json'])[0]?.text ?? ''
  const config = JSON.parse(base) as { bundle: { targets: string[]; externalBin: string[] } }
  const overlay = JSON.parse(mac) as { bundle: { targets: string[]; externalBin?: string[] } }
  expect(config.bundle.targets).toContain('nsis')
  expect(overlay.bundle.targets).toContain('dmg')
  expect(config.bundle.externalBin).toEqual(['binaries/alexia-core', 'binaries/alexia-connect'])
  expect(overlay.bundle.externalBin ?? config.bundle.externalBin).toEqual(config.bundle.externalBin)
  for (const { text } of files(['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json', '.github/workflows/*'])) {
    expect(text).not.toMatch(/ALEXIA_DEV_NAME|ALEXIA_KEYCHAIN|tauri\.dev\.conf|dev-app/)
  }
})
