// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readOnly } from '../classify.js'
import { choose, createInstaller, parseWingetShow, parseWingetTable } from '../install.js'
import { MAX_OUTPUT, minimalEnv, shellInvocation, startProcess } from '../proc.js'
import { createShell, Refused } from '../shell.js'
import { createWatches, QUIET_MS } from '../watch.js'
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
  assert.equal(readOnly('git diff HEAD').command, 'git diff --no-ext-diff --no-textconv HEAD')
  assert.equal(readOnly('git status').command, 'git status')
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
  const shell = createShell({ roots: async () => [], start: (job) => (started.push(job), fakeChild({ exit: 0 })), platform: 'darwin', env: { PATH: '/bin' } })
  await shell.run({ command: 'git diff', shell: 'zsh' }, { readonly: true })
  assert.deepEqual(started[0].args, ['-c', 'git diff --no-ext-diff --no-textconv'])
  assert.equal(started[0].env.GIT_CONFIG_KEY_0, 'core.fsmonitor')
  assert.equal(started[0].env.GIT_CONFIG_VALUE_0, 'false')
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

test('winget_id_resolved_before_install', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH, show: SHOW, install: 'Successfully installed' })
  const installer = createInstaller({ exec, platform: 'win32' })
  const done = await installer.install({ name: 'Visual Studio Code' })
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

test('an ambiguous winget name installs nothing and lists the choices', async () => {
  const { exec, calls } = fakeExec({ search: SEARCH })
  const installer = createInstaller({ exec, platform: 'win32' })
  await assert.rejects(installer.install({ name: 'vscode' }), /Several programs match vscode: .*Microsoft\.VisualStudioCode\b/)
  assert.equal(
    calls.some((c) => c[1] === 'install'),
    false,
  )
  const none = createInstaller({ exec: fakeExec({ search: 'No package found matching input criteria.' }).exec, platform: 'win32' })
  await assert.rejects(none.install({ name: 'zzz' }), /Nothing called zzz/)
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
  const installer = createInstaller({ exec, platform: 'darwin', brew: () => '/opt/homebrew/bin/brew' })
  const done = await installer.install({ name: 'wget' })
  assert.deepEqual(calls, [
    ['/opt/homebrew/bin/brew', 'info', '--json=v2', 'wget'],
    ['/opt/homebrew/bin/brew', 'install', 'wget'],
  ])
  assert.equal(done.version, '1.24.5')
  assert.match(done.publisher, /homebrew\/core/)
  await assert.rejects(installer.install({ name: '--force evil' }), /not a Homebrew name/)
  await assert.rejects(createInstaller({ exec, platform: 'linux' }).install({ name: 'x' }), /can’t install/)
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
    const canInstall = process.platform === 'win32' || process.platform === 'darwin'
    const expected = canInstall ? manifest.provides : manifest.provides.filter((c) => c !== 'software.install')
    assert.deepEqual([...bound].sort(), [...expected].sort())
    assert.equal(new Set(bound).size, bound.length)

    assert.deepEqual(byName.shell_read.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assert.deepEqual(byName.shell_run.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    assert.deepEqual(byName.software_install.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true })
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
