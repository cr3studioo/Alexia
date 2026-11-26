// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gitDriverSettings, readOnly } from '../classify.js'
import { BREW_PLACES, choose, createInstaller, parseWingetShow, parseWingetTable } from '../install.js'
import { MAX_OUTPUT, minimalEnv, shellInvocation, startProcess } from '../proc.js'
import { createShell, Refused } from '../shell.js'
import { createWatches, MOST_READ, QUIET_MS } from '../watch.js'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
/** Processes started here can be slow to start on a loaded Windows machine. */
const SLOW = { timeout: 90_000 }

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Wait until `check()` is true, for at most `ms`. */
async function until(check, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return check()
}

/** The first line a started process prints, as a number (the grandchild's pid). */
function firstLine(onOutput) {
  let text = ''
  let give
  const line = new Promise((resolve) => (give = resolve))
  onOutput.fn = (stream, chunk) => {
    if (stream !== 'stdout') return
    text += chunk
    const nl = text.indexOf('\n')
    if (nl >= 0) give(Number(text.slice(0, nl).trim()))
  }
  return line
}

/** A node program that starts a grandchild that never ends, prints its pid, and never ends. */
const TREE = [
  "const { spawn } = require('node:child_process')",
  "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  'console.log(c.pid)',
  'setInterval(() => {}, 1000)',
].join(';')

// --- the read-only classifier ---------------------------------------------------------------

test('readonly_list_accepts', () => {
  const accepted = [
    'Get-ChildItem -Path C:\\Users\\me\\Documents -Recurse',
    'get-content notes.txt',
    'Get-Process',
    'Get-Service -Name Spooler',
    'Test-Path "C:\\Program Files\\Git"',
    'ls -la /tmp',
    'cat README.md',
    'pwd',
    'git log --oneline -n 20 --format=%h',
    'git status --short',
    'git diff HEAD~1 -- src/main.rs',
    'du -sh ./build',
    'df -h',
    'whoami',
    'which node',
  ]
  assert.ok(accepted.length >= 10)
  for (const command of accepted) {
    const said = readOnly(command)
    assert.equal(said.ok, true, `${command}: ${said.why}`)
  }
  // log and diff cannot be made to start a diff driver from the repository's settings.
  assert.equal(readOnly('git diff HEAD').command, 'git --no-pager diff --ignore-submodules=all --no-ext-diff --no-textconv HEAD')
  assert.equal(readOnly('git log -p -n 3').command, 'git --no-pager log --ignore-submodules=all --no-ext-diff --no-textconv -p -n 3')
  assert.equal(readOnly('git status').command, 'git --no-pager status --ignore-submodules=all')
})

test('readonly_rejects_escapes', () => {
  const tricks = [
    'ls; rm -rf ~',
    'cat x | sh',
    'ls $(rm -rf ~)',
    'ls `rm -rf ~`',
    'ls\nrm -rf ~',
    'ls\r\nrm x',
    'ls \uff1b rm x', // full-width semicolon
    'ls \u01c0 sh', // Latin letter dental click, looks like |
    'cat x \u2502 sh', // box-drawing vertical
    'Get-ChildItem -Path x -Recurse | Remove-Item',
    'ls && rm x',
    'ls & calc',
    'cat a > b',
    'cat < /etc/passwd',
    'ls (Remove-Item x)',
    'Get-Content @(Remove-Item x)',
    'ls ${env:USERPROFILE}',
    'Get-Process -ComputerName server1',
    'Get-ChildItem \\\\attacker\\share',
    'git log --output=/tmp/x',
    'git diff --ext-diff',
    'git push',
    'git -c core.pager=sh log',
    'rm -rf /',
    'lsof',
    './ls',
    'ls\t-la',
    'ls \u2013ComputerName x', // en dash, which PowerShell reads as a dash
    'cat \u201cx\u201d', // curly quotes
    'git log --show-signature', // runs gpg
    'git log --show-sig', // the same, shortened
    'git log "--show-signature"',
    'git log --format=%G?', // a signature check in a format
    'git log --pretty=format:%h%GS',
    'git status --ignore-submodules=none',
    'git diff --submodule=diff',
    'git log --git-dir=x',
    '',
    '   ',
  ]
  assert.ok(tricks.length >= 20)
  for (const command of tricks) {
    const said = readOnly(command)
    assert.equal(said.ok, false, JSON.stringify(command))
    assert.equal(typeof said.why, 'string')
  }
  assert.equal(readOnly(undefined).ok, false)
})

test('readonly_rejects_network_paths anywhere in an argument', () => {
  const network = [
    'cat //srv/share/f',
    'Get-Content -Path://srv/share/f',
    'Get-Content -Path:\\\\srv\\share\\f',
    'Get-Content -LiteralPath=//srv/share/f',
    'cat "//srv/share/f"',
    "cat '\\\\srv\\share\\f'",
    'Get-ChildItem a,//srv/share',
    'cat \\/srv/share/f', // mixed: Windows reads / as \
    'cat /\\srv\\share\\f',
    'Get-Content \\??\\UNC\\srv\\share\\f',
    'Get-Content FileSystem:://srv/share/f',
    'ls x=//srv/share',
    'git diff HEAD -- //srv/share/f',
  ]
  for (const command of network) {
    const said = readOnly(command)
    assert.equal(said.ok, false, JSON.stringify(command))
    assert.match(said.why, /network path/, JSON.stringify(command))
  }
  // A path on this computer still passes.
  assert.equal(readOnly('Get-Content -Path:C:\\notes\\a.txt').ok, true)
  assert.equal(readOnly('cat /home/me/a.txt').ok, true)
})

test('shell_read refuses what the classifier refuses, and never starts it', async () => {
  const started = []
  const shell = createShell({ roots: async () => [], start: (job) => (started.push(job), fakeChild({ exit: 0 })) })
  await assert.rejects(shell.run({ command: 'ls; rm -rf ~' }, { readonly: true }), Refused)
  await assert.rejects(shell.run({ command: 'Remove-Item x' }, { readonly: true }), /not on the read-only list/)
  assert.equal(started.length, 0)
  // shell_run takes the same command: being asked first is its rule, not refusal.
  await shell.run({ command: 'Remove-Item x' })
  assert.equal(started.length, 1)
})

test('a read-only git command runs with the repository unable to name a program', async () => {
  const started = []
  const listed = []
  // What `git config --list -z` says for a repository that names its own drivers.
  const listing = ['core.bare\nfalse', 'filter.evil.clean\nrun-me', 'filter.evil.required\ntrue', 'diff.pic.textconv\nrun-me', 'pretty.mine\n%G?', 'user.name\nme', ''].join('\0')
  const gitConfig = async (cwd, env) => (listed.push({ cwd, env }), listing)
  const shell = createShell({ roots: async () => [], start: (job) => (started.push(job), fakeChild({ exit: 0 })), platform: 'darwin', env: { PATH: '/bin' }, gitConfig })
  await shell.run({ command: 'git diff', shell: 'zsh' }, { readonly: true })
  assert.deepEqual(started[0].args, ['-c', 'git --no-pager diff --ignore-submodules=all --no-ext-diff --no-textconv'])
  const env = started[0].env
  const settings = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]))
  assert.equal(settings['core.fsmonitor'], 'false')
  assert.equal(settings['log.showSignature'], 'false')
  assert.equal(settings['gpg.program'], 'git')
  assert.equal(settings['gpg.ssh.program'], 'git')
  assert.equal(settings['gpg.x509.program'], 'git')
  assert.equal(settings['core.pager'], 'cat')
  assert.equal(settings['diff.external'], '')
  assert.equal(settings['filter.evil.clean'], '')
  assert.equal(settings['filter.evil.required'], 'false')
  assert.equal(settings['diff.pic.textconv'], '')
  assert.equal(settings['pretty.mine'], 'medium')
  assert.equal('user.name' in settings, false)
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  // The settings were read with the same locked-down environment, in the folder it runs in.
  assert.equal(listed[0].env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(listed[0].cwd, started[0].cwd)
  // A non-git command reads no git settings.
  await shell.run({ command: 'ls', shell: 'zsh' }, { readonly: true })
  assert.equal(listed.length, 1)
  // Unreadable settings: nothing runs.
  const failing = createShell({ roots: async () => [], start: (job) => (started.push(job), fakeChild({ exit: 0 })), gitConfig: async () => Promise.reject(new Error('x')) })
  const before = started.length
  await assert.rejects(failing.run({ command: 'git status' }, { readonly: true }), /could not read the git settings/)
  assert.equal(started.length, before)
  assert.deepEqual(gitDriverSettings(''), [])
})

/**
 * A repository whose own .git/config names a program for every way git can be made to run one
 * (a signature program with signatures shown, fsmonitor, a filter and a diff driver, an external
 * diff, a pager, a hooks folder), each a script that leaves a marker file behind.
 */
function hostileRepo() {
  const base = mkdtempSync(join(tmpdir(), 'p423-git-'))
  const repo = join(base, 'repo')
  const marks = join(base, 'marks')
  const hooks = join(base, 'hooks')
  mkdirSync(marks)
  mkdirSync(hooks)
  const slash = (p) => p.split(sep).join('/')
  const script = (name) => {
    const path = join(base, `${name}.sh`)
    writeFileSync(path, `#!/bin/sh\necho ran > "${slash(join(marks, name))}"\ncat\n`, { mode: 0o755 })
    return slash(path)
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
  // A commit carrying a signature, so showing signatures has something to check.
  const tree = git('write-tree').trim()
  const parent = git('rev-parse', 'HEAD').trim()
  const body = [`tree ${tree}`, `parent ${parent}`, 'author Test <test@example.invalid> 1 +0000', 'committer Test <test@example.invalid> 1 +0000', 'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' abc', ' -----END PGP SIGNATURE-----', '', 'signed', ''].join('\n')
  writeFileSync(join(base, 'commit'), body)
  git('update-ref', 'HEAD', execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', join(base, 'commit')], { encoding: 'utf8' }).trim())
  git('config', 'log.showSignature', 'true')
  git('config', 'gpg.program', script('gpg'))
  git('config', 'gpg.ssh.program', script('gpg-ssh'))
  git('config', 'core.fsmonitor', script('fsmonitor'))
  git('config', 'filter.evil.clean', script('clean'))
  git('config', 'filter.evil.smudge', script('smudge'))
  git('config', 'diff.evil.textconv', script('textconv'))
  git('config', 'diff.external', script('external'))
  git('config', 'core.pager', script('pager'))
  git('config', 'pager.log', script('pager-log'))
  git('config', 'core.hooksPath', slash(hooks))
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\necho ran > "${slash(join(marks, 'hook'))}"\n`, { mode: 0o755 })
  writeFileSync(join(repo, '.gitattributes'), '* filter=evil diff=evil\n')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const ran = () => readdirSync(marks)
  const clear = () => {
    for (const f of readdirSync(marks)) rmSync(join(marks, f))
  }
  return { repo, ran, clear }
}

test('shell_read git never runs a program the repository names', { timeout: 240_000 }, async () => {
  const { repo, ran, clear } = hostileRepo()
  // The repository really is hostile: plain git runs its programs.
  for (const args of [['log', '-n', '2'], ['status'], ['diff']]) {
    try {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: minimalEnv() })
    } catch {
      // Whether it fails does not matter, only what it ran.
    }
  }
  assert.ok(ran().includes('gpg'), `plain git log checks the signature: ${ran()}`)
  assert.ok(ran().includes('clean'), `plain git status runs the filter: ${ran()}`)
  clear()

  const shell = createShell({ roots: async () => [{ uri: pathToFileURL(repo).href }] })
  for (const command of ['git log', 'git log -n 2 -p', 'git log --stat', 'git status', 'git status --short', 'git diff', 'git diff HEAD~1']) {
    const result = await shell.run({ command, cwd: repo, timeout_s: 120 }, { readonly: true })
    assert.equal(result.exit, 0, `${command}: ${result.stderr}`)
    assert.deepEqual(ran(), [], `${command} ran ${ran()}`)
  }
  // And the output is still git's: the signed commit and the change are there.
  const log = await shell.run({ command: 'git log -n 1', cwd: repo, timeout_s: 120 }, { readonly: true })
  assert.match(log.stdout, /signed/)
  const diff = await shell.run({ command: 'git diff', cwd: repo, timeout_s: 120 }, { readonly: true })
  assert.match(diff.stdout, /\+two/)
  assert.equal(existsSync(join(repo, '.git', 'index.lock')), false)
})

// --- running ---------------------------------------------------------------------------------

test('timeout_kills_tree', SLOW, async () => {
  const onOutput = {}
  const grandchild = firstLine(onOutput)
  const child = startProcess({ file: NODE, args: ['-e', TREE], env: minimalEnv(), timeoutMs: 8_000, onOutput: (s, t) => onOutput.fn(s, t) })
  const gpid = await grandchild
  assert.ok(Number.isInteger(gpid) && gpid > 0)
  assert.equal(pidAlive(gpid), true)
  const done = await child.done
  assert.equal(done.timedOut, true)
  assert.equal(done.exit, null)
  assert.equal(await until(() => !pidAlive(child.pid)), true, 'the child is gone')
  assert.equal(await until(() => !pidAlive(gpid)), true, 'the grandchild is gone')
})

test('a command through the shell past timeout_s is stopped', SLOW, async () => {
  const shell = createShell({ roots: async () => [] })
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 120' : 'sleep 120'
  const started = Date.now()
  const result = await shell.run({ command, timeout_s: 3 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exit, null)
  assert.ok(Date.now() - started < 60_000)
})

test('cancel_kills', SLOW, async () => {
  const onOutput = {}
  const grandchild = firstLine(onOutput)
  const abort = new AbortController()
  const child = startProcess({ file: NODE, args: ['-e', TREE], env: minimalEnv(), timeoutMs: 120_000, signal: abort.signal, onOutput: (s, t) => onOutput.fn(s, t) })
  const gpid = await grandchild
  abort.abort()
  const done = await child.done
  assert.equal(done.cancelled, true)
  assert.equal(done.timedOut, false)
  assert.equal(await until(() => !pidAlive(gpid)), true, 'the grandchild is gone')
})

test('a cancelled shell_run says so', async () => {
  const abort = new AbortController()
  abort.abort()
  const shell = createShell({ roots: async () => [], start: () => fakeChild({ exit: null, cancelled: true }) })
  await assert.rejects(shell.run({ command: 'x' }, { signal: abort.signal }), /cancelled/)
})

test('env_is_minimal', SLOW, async () => {
  const secret = 'ALEXIA_SECRET_' + 'P423_TOKEN'
  process.env[secret] = ['not', 'real'].join('-')
  process.env.ALEXIA_PLUGIN_DIR = dir
  try {
    const kept = minimalEnv(process.env)
    assert.equal(secret in kept, false)
    assert.equal('ALEXIA_PLUGIN_DIR' in kept, false)
    assert.ok(Object.keys(kept).some((k) => k.toUpperCase() === 'PATH'))

    // And the real thing: a child started through the shell lists what it was given.
    const shell = createShell({ roots: async () => [] })
    const listing = "\"Object.keys(process.env).join(',')\""
    const command = process.platform === 'win32' ? `& '${NODE}' -p ${listing}` : `'${NODE}' -p ${listing}`
    const result = await shell.run({ command, timeout_s: 60 })
    assert.equal(result.exit, 0, result.stderr)
    const names = result.stdout.trim().split(/\r?\n/).at(-1).split(',')
    assert.ok(names.some((n) => n.toUpperCase() === 'PATH'), names.join(','))
    assert.equal(names.includes(secret), false)
    assert.equal(names.some((n) => n.toUpperCase().startsWith('ALEXIA_')), false, names.join(','))
  } finally {
    delete process.env[secret]
  }
})

test('output_cut_with_note', SLOW, async () => {
  const child = startProcess({ file: NODE, args: ['-e', "process.stdout.write('x'.repeat(200 * 1024)); process.stderr.write('short')"], env: minimalEnv(), timeoutMs: 60_000 })
  const done = await child.done
  assert.equal(done.exit, 0)
  assert.equal(done.truncated, true)
  assert.ok(done.stdout.startsWith('x'.repeat(MAX_OUTPUT)))
  assert.ok(!done.stdout.startsWith('x'.repeat(MAX_OUTPUT + 1)))
  const note = `[cut: ${200 * 1024 - MAX_OUTPUT} more bytes were not kept; at most 64 KiB is]`
  assert.ok(done.stdout.endsWith(note), done.stdout.slice(-100))
  assert.equal(done.stderr, 'short')
})

test('a missing program is said, not thrown', SLOW, async () => {
  const done = await startProcess({ file: 'alexia-no-such-program-p423', env: minimalEnv(), timeoutMs: 30_000 }).done
  assert.equal(done.exit, null)
  assert.equal(done.error, 'ENOENT')
})

test('PowerShell gets its script encoded, so nothing in it is re-quoted', () => {
  const { file, args } = shellInvocation('powershell', 'Write-Output "a \\ b"')
  assert.equal(file, 'powershell.exe')
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes('Write-Output "a \\ b"'))
  assert.deepEqual(shellInvocation('zsh', 'echo hi'), { file: 'zsh', args: ['-c', 'echo hi'] })
})

test('cwd_outside_roots_refused', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p423-'))
  const root = join(base, 'opened')
  const outside = join(base, 'other')
  mkdirSync(join(root, 'inner'), { recursive: true })
  mkdirSync(outside)
  const started = []
  const shell = createShell({ roots: async () => [{ uri: pathToFileURL(root).href }], start: (job) => (started.push(job), fakeChild({ exit: 0 })) })
  await assert.rejects(shell.run({ command: 'pwd', cwd: outside }), /outside the folders you opened/)
  await assert.rejects(shell.run({ command: 'pwd', cwd: join(root, '..', 'other') }), /outside the folders you opened/)
  await assert.rejects(shell.run({ command: 'pwd', cwd: 'relative/path' }), /full path/)
  assert.equal(started.length, 0)
  await shell.run({ command: 'pwd', cwd: join(root, 'inner') })
  assert.equal(started.length, 1)
  assert.match(started[0].cwd, /inner$/)
  // With no folder opened, only home is allowed.
  const closed = createShell({ roots: async () => [], start: () => fakeChild({ exit: 0 }) })
  await assert.rejects(closed.run({ command: 'pwd', cwd: root }), /No folder has been opened/)
})

test('timeout_s above 600 is refused', async () => {
  const shell = createShell({ roots: async () => [], start: () => fakeChild({ exit: 0 }) })
  await assert.rejects(shell.run({ command: 'x', timeout_s: 601 }), /1 to 600/)
  await assert.rejects(shell.run({ command: 'x', shell: 'cmd' }), /not cmd/)
})

// --- installing ------------------------------------------------------------------------------

/** One row of a winget table, its columns as wide as winget makes them. */
const row = (...cells) =>
  cells
    .map((cell, i) => cell.padEnd([21, 37, 10, 17, 0][i]))
    .join('')
    .trimEnd()
const SEARCH = [
  // winget's spinner, which it draws with carriage returns before the table.
  ['\r   - ', '\r   / ', '\r'].join(''),
  row('Name', 'Id', 'Version', 'Match', 'Source'),
  '-'.repeat(90),
  row('Visual Studio Code', 'Microsoft.VisualStudioCode', '1.95.3', 'Moniker: vscode', 'winget'),
  row('VS Code Insiders', 'Microsoft.VisualStudioCode.Insiders', '1.96.0', 'Tag: vscode', 'winget'),
].join('\n')
const SHOW = ['Found Visual Studio Code [Microsoft.VisualStudioCode]', 'Version: 1.95.3', 'Publisher: Microsoft Corporation', 'Description: Code editing.'].join('\n')

function fakeExec(answers) {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    const said = answers[args[0]]
    return { exit: 0, stdout: typeof said === 'function' ? said(args) : (said ?? ''), stderr: '' }
  }
  return { exec, calls }
}

const installs = (calls) => calls.filter((c) => c[1] === 'install')

test('winget_id_resolved_before_install', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH, show: SHOW, install: 'Successfully installed' })
  const installer = createInstaller({ exec, platform: 'win32' })
  const done = await installer.install({ name: 'Visual Studio Code', publisher: 'microsoft corporation' })
  assert.deepEqual(
    calls.map((c) => c.slice(0, 2)),
    [
      ['winget', 'search'],
      ['winget', 'show'],
      ['winget', 'install'],
    ],
  )
  assert.deepEqual(calls[1].slice(0, 5), ['winget', 'show', '--id', 'Microsoft.VisualStudioCode', '-e'])
  assert.deepEqual(calls[2].slice(0, 6), ['winget', 'install', '--id', 'Microsoft.VisualStudioCode', '-e', '--accept-package-agreements'])
  assert.deepEqual(done, { installed: 'Microsoft.VisualStudioCode', version: '1.95.3', publisher: 'Microsoft Corporation' })
})

/** `winget show` for a package, its publisher by id. */
const showFor = (publishers) => (args) => {
  const id = args[args.indexOf('--id') + 1]
  return [`Found ${id} [${id}]`, 'Version: 1.0', `Publisher: ${publishers[id]}`].join('\n')
}

test('a winget name matching no package exactly installs nothing and lists the hits with publishers', async () => {
  const publishers = { 'Microsoft.VisualStudioCode': 'Microsoft Corporation', 'Microsoft.VisualStudioCode.Insiders': 'Microsoft Corporation' }
  const { exec, calls } = fakeExec({ search: SEARCH, show: showFor(publishers) })
  const installer = createInstaller({ exec, platform: 'win32' })
  await assert.rejects(installer.install({ name: 'vscode', publisher: 'Microsoft Corporation' }), (error) => {
    assert.ok(error instanceof Refused)
    assert.match(error.message, /nothing was installed/)
    assert.match(error.message, /Visual Studio Code \(id Microsoft\.VisualStudioCode, published by Microsoft Corporation\)/)
    assert.match(error.message, /VS Code Insiders \(id Microsoft\.VisualStudioCode\.Insiders, published by Microsoft Corporation\)/)
    return true
  })
  assert.deepEqual(installs(calls), [])
  const none = createInstaller({ exec: fakeExec({ search: 'No package found matching input criteria.' }).exec, platform: 'win32' })
  await assert.rejects(none.install({ name: 'zzz' }), /Nothing called zzz/)
})

test('a lone winget hit with another id and name is not installed', async () => {
  // winget search matched "notepad" on a tag; the one hit is someone else's program.
  const LONE = [row('Name', 'Id', 'Version', 'Match', 'Source'), '-'.repeat(90), row('Notes Plus Plus', 'Evil.NotesPlus', '6.6.6', 'Tag: notepad', 'winget')].join('\n')
  const { exec, calls } = fakeExec({ search: LONE, show: showFor({ 'Evil.NotesPlus': 'Evil Software Ltd' }) })
  const installer = createInstaller({ exec, platform: 'win32' })
  await assert.rejects(installer.install({ name: 'notepad', publisher: 'Evil Software Ltd' }), /No program is called exactly notepad.*Notes Plus Plus \(id Evil\.NotesPlus, published by Evil Software Ltd\)/)
  assert.deepEqual(installs(calls), [])
  assert.equal(choose([{ name: 'Notes Plus Plus', id: 'Evil.NotesPlus' }], 'notepad'), undefined)
  // Its exact id, or its exact name in any case, is a match.
  assert.equal(choose([{ name: 'Notes Plus Plus', id: 'Evil.NotesPlus' }], 'evil.notesplus').id, 'Evil.NotesPlus')
  assert.equal(choose([{ name: 'Notes Plus Plus', id: 'Evil.NotesPlus' }], 'NOTES PLUS PLUS').id, 'Evil.NotesPlus')
})

test('the publisher is in the approved call before anything is installed', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH, show: SHOW, install: 'ok' })
  const installer = createInstaller({ exec, platform: 'win32' })
  // Without a publisher: nothing installed, and the answer says who publishes it.
  await assert.rejects(installer.install({ name: 'Microsoft.VisualStudioCode' }), (error) => {
    assert.match(error.message, /^Nothing was installed yet\. Visual Studio Code \(Microsoft\.VisualStudioCode\) 1\.95\.3 is published by Microsoft Corporation\./)
    assert.match(error.message, /publisher "Microsoft Corporation"/)
    return true
  })
  // With someone else's name: nothing installed either.
  await assert.rejects(installer.install({ name: 'Microsoft.VisualStudioCode', publisher: 'Microsoft' }), /The publisher given, Microsoft, is not it/)
  assert.deepEqual(installs(calls), [])
  // With the publisher the owner saw: installed.
  const done = await installer.install({ name: 'Microsoft.VisualStudioCode', publisher: ' Microsoft  Corporation ' })
  assert.equal(done.publisher, 'Microsoft Corporation')
  assert.equal(installs(calls).length, 1)
  // A package whose publisher cannot be found is never installed.
  const unknown = fakeExec({ search: SEARCH, show: 'Found Visual Studio Code [Microsoft.VisualStudioCode]\nVersion: 1.95.3', install: 'ok' })
  await assert.rejects(createInstaller({ exec: unknown.exec, platform: 'win32' }).install({ name: 'Microsoft.VisualStudioCode', publisher: 'unknown' }), /could not find out who publishes/)
  assert.deepEqual(installs(unknown.calls), [])
})

test('winget tables and show output are read by column', () => {
  const rows = parseWingetTable(SEARCH)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { name: 'Visual Studio Code', id: 'Microsoft.VisualStudioCode', version: '1.95.3', source: 'winget' })
  assert.equal(choose(rows, 'microsoft.visualstudiocode').id, 'Microsoft.VisualStudioCode')
  assert.deepEqual(parseWingetShow(SHOW), { publisher: 'Microsoft Corporation', version: '1.95.3', name: undefined })
})

test('brew looks the formula up, then installs it by name', async () => {
  const info = JSON.stringify({ formulae: [{ name: 'wget', full_name: 'wget', versions: { stable: '1.24.5' }, tap: 'homebrew/core', homepage: 'https://www.gnu.org/software/wget/' }], casks: [] })
  const { exec, calls } = fakeExec({ info })
  const brew = BREW_PLACES[0]
  const installer = createInstaller({ exec, platform: 'darwin', brew: () => brew })
  await assert.rejects(installer.install({ name: 'wget' }), /Nothing was installed yet\. wget 1\.24\.5 \(https:\/\/www\.gnu\.org\/software\/wget\/\) is published by homebrew\/core\./)
  assert.deepEqual(installs(calls), [])
  const done = await installer.install({ name: 'wget', publisher: 'homebrew/core' })
  assert.deepEqual(calls.slice(-2), [
    [brew, 'info', '--json=v2', 'wget'],
    [brew, 'install', 'wget'],
  ])
  assert.equal(done.version, '1.24.5')
  assert.equal(done.publisher, 'homebrew/core')
  await assert.rejects(installer.install({ name: '--force evil' }), /not a Homebrew name/)
  // Where brew is looked for, built from parts: /opt/homebrew/bin/brew and /usr/local/bin/brew.
  assert.deepEqual(
    BREW_PLACES.map((p) => p.split(sep).join('/')),
    ['', ''].map((_, i) => ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'][i].split(sep).join('/')),
  )
})

test('installs on any other system are refused in a plain sentence, without running anything', async () => {
  const { exec, calls } = fakeExec({})
  for (const source of [undefined, 'brew', 'winget']) {
    await assert.rejects(createInstaller({ exec, platform: 'linux' }).install({ name: 'wget', source, publisher: 'x' }), /^Error: Installing programs is not supported on this computer’s system \(linux\)/)
    await assert.rejects(createInstaller({ exec, platform: 'freebsd' }).search({ name: 'wget', source }), /not supported/)
  }
  assert.deepEqual(calls, [])
})

// --- watching --------------------------------------------------------------------------------

test('watch_pid_finishes_notice', SLOW, async () => {
  const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  await until(() => Number.isInteger(child.pid))
  const watches = createWatches()
  const watch = watches.pid(child.pid, { says: 'The backup' })
  assert.match(watch, /^w_[0-9a-f]{12}$/)
  await watches.poll()
  assert.deepEqual(watches.noticeItems(), [])
  child.kill()
  assert.equal(await until(async () => (await watches.poll(), watches.noticeItems().length === 1)), true)
  const [item] = watches.noticeItems()
  assert.equal(item.key, `shell-runner:${watch}`)
  assert.equal(item.urgency, 'normal')
  assert.match(item.text, /^The backup finished/)
  assert.throws(() => watches.pid(child.pid), /No process/)
})

test('a command run with watch: true finishes as a notice with its exit code', async () => {
  let finish
  const done = new Promise((resolve) => (finish = resolve))
  const watches = createWatches()
  const started = []
  const shell = createShell({ roots: async () => [], watches, start: (job) => (started.push(job), { pid: 1, done, kill: async () => {} }) })
  const { watch } = await shell.run({ command: 'npm run build', watch: true, says: 'The build' })
  assert.equal(started[0].timeoutMs, undefined, 'a background command has no timeout')
  assert.deepEqual(watches.noticeItems(), [])
  finish({ exit: 2, stdout: 'secret output', stderr: '' })
  await done
  await new Promise((r) => setTimeout(r, 0))
  const items = watches.noticeItems()
  assert.deepEqual(items, [{ key: `shell-runner:${watch}`, text: 'The build finished (exit 2)', why: 'A job you asked me to watch has finished.', urgency: 'normal' }])
  // The read-only path may watch too, under its own rule.
  await assert.rejects(shell.run({ command: 'rm x', watch: true }, { readonly: true }), Refused)
})

test('watch_file_quiet_60s', async () => {
  let t = 1_000_000
  let size = 10
  const watches = createWatches({ now: () => t, statFile: async () => ({ size }) })
  const watch = await watches.file('/logs/build.log', { says: 'The export' })
  t += 30_000
  size = 50 // it grew: the quiet minute starts again
  await watches.poll()
  t += QUIET_MS - 1
  await watches.poll()
  assert.deepEqual(watches.noticeItems(), [], 'not yet a full minute without growth')
  t += 1
  await watches.poll()
  const items = watches.noticeItems()
  assert.equal(items.length, 1)
  assert.equal(items[0].key, `shell-runner:${watch}`)
  assert.equal(items[0].text, 'The export finished')
  // A day later it is no longer a notice.
  t += 24 * 60 * 60 * 1000
  assert.deepEqual(watches.noticeItems(), [])
})

test('a file watch finishes on a line matching done_when', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p423-log-'))
  const log = join(base, 'job.log')
  writeFileSync(log, 'starting\n')
  let t = 0
  const watches = createWatches({ now: () => t })
  await watches.file(log, { doneWhen: 'ALL DONE' })
  writeFileSync(log, 'starting\nstep 1\n', { flag: 'w' })
  t += 1000
  await watches.poll()
  assert.deepEqual(watches.noticeItems(), [])
  writeFileSync(log, 'starting\nstep 1\nALL DONE in 3s\n')
  t += 1000
  await watches.poll()
  assert.deepEqual(
    watches.noticeItems().map((i) => i.text),
    ['job.log finished'],
  )
  await assert.rejects(watches.file(log, { doneWhen: '(' }), /not a valid regular expression/)
})

test('a done_when line past the first MiB of new output is still seen', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p423-big-'))
  const log = join(base, 'big.log')
  writeFileSync(log, 'start\n')
  let t = 0
  const watches = createWatches({ now: () => t })
  await watches.file(log, { doneWhen: '^ALL DONE$' })
  // Half again as much as one poll reads, then the line, written at once.
  const filler = 'x'.repeat(99) + '\n'
  writeFileSync(log, 'start\n' + filler.repeat(Math.ceil((MOST_READ * 1.5) / filler.length)) + 'ALL DONE\n')
  t += 1000
  await watches.poll()
  assert.deepEqual(watches.noticeItems(), [], 'one poll reads only the first MiB')
  // Nothing more is written; the next poll reads on from where the last stopped.
  t += 1000
  await watches.poll()
  assert.deepEqual(
    watches.noticeItems().map((i) => i.text),
    ['big.log finished'],
  )
})

test('a UTF-8 character cut by a read is decoded whole', async () => {
  let t = 0
  const content = Buffer.from('start\nnaïve ✓ done\n', 'utf8')
  let size = 6
  const reads = []
  const watches = createWatches({
    now: () => t,
    statFile: async () => ({ size }),
    // Hand out at most 9 bytes a time, which cuts the ï and the ✓ in two.
    readFile: async (_path, from, to) => (reads.push([from, to]), content.subarray(from, Math.min(to, from + 9))),
  })
  await watches.file('/logs/x.log', { doneWhen: 'naïve ✓ done' })
  size = content.length
  for (let i = 0; i < 4 && watches.noticeItems().length === 0; i++) {
    t += 1000
    await watches.poll()
  }
  assert.deepEqual(
    watches.noticeItems().map((i) => i.text),
    ['x.log finished'],
  )
  assert.deepEqual(reads[0], [6, content.length])
  assert.equal(reads[1][0], 15, 'the next read starts where the last one stopped')
})

test('unwatch stops a command watch and ends the command', async () => {
  let killed = 0
  const watches = createWatches()
  const id = watches.command({ done: new Promise(() => {}), kill: async () => void killed++ }, { label: 'x' })
  assert.equal(await watches.unwatch(id), true)
  assert.equal(killed, 1)
  assert.equal(await watches.unwatch(id), false)
})

// --- the plugin as the host sees it ----------------------------------------------------------

test('every provided capability is bound by exactly one tool, with the right annotations', SLOW, async () => {
  const { default: manifest } = await import('../plugin.json', { with: { type: 'json' } })
  await serve(async (ask) => {
    const { tools } = (await ask('tools/list', {})).result
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    const bound = tools.flatMap((tool) => tool._meta?.['alexia/provides'] ?? [])
    assert.deepEqual([...bound].sort(), [...manifest.provides].sort())
    assert.equal(new Set(bound).size, bound.length)

    assert.deepEqual(byName.shell_read.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assert.deepEqual(byName.shell_run.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    assert.deepEqual(byName.software_install.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    assert.equal(byName.software_install.inputSchema.properties.publisher.type, 'string')
    assert.equal(byName.software_search.annotations.readOnlyHint, true)
    assert.equal(byName.job_watch.annotations.readOnlyHint, true)
    assert.equal('command' in byName.job_watch.inputSchema.properties, false, 'job.watch never starts a command')
    assert.equal(byName.shell_run.inputSchema.properties.timeout_s.maximum, 600)

    const call = async (name, args) => (await ask('tools/call', { name, arguments: args })).result
    const refused = await call('shell_read', { command: 'ls; rm -rf ~' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /not a read-only command/)
    const both = await call('job_watch', {})
    assert.equal(both.isError, true)
    assert.deepEqual((await call('notice_items', {})).structuredContent, { items: [] })
  })
})

/** A child that has already finished with `result`. */
function fakeChild(result) {
  return { pid: 1, done: Promise.resolve({ stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false, ...result }), kill: async () => {} }
}

/** The plugin as the host runs it, spoken to over stdio. Only calls that run nothing. */
async function serve(use) {
  const child = spawn(NODE, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
  const answers = new Map()
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop()
    for (const line of lines) {
      const message = JSON.parse(line)
      answers.get(message.id)?.(message)
    }
  })
  let id = 0
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      answers.set(mine, resolve)
      child.once('exit', () => reject(new Error('the plugin stopped')))
      send({ id: mine, method, params })
    })
  try {
    await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    send({ method: 'notifications/initialized' })
    await use(ask)
  } finally {
    child.kill()
  }
}
