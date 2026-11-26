// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { BATCH, CLEAN_MS, createCare, pick } from '../care.js'
import { DELETE_LOGIN_ITEM, readDisks, readOpen, readUpdates } from '../macos.js'
import { LATE_MS } from '../power.js'
import { runProgram } from '../run.js'
import { oldFiles, safeTemp } from '../temp.js'
import { CARE, DELETE, environment, rundll, shell, shutdownExe, THEME } from '../windows.js'
import { assert, fakeClock, fakeRunner, ready, register, slowTest, test } from './harness.js'
import './live.js'

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
const DAY = 24 * 60 * 60 * 1000

/** A folder of this test's own inside the temp folder, removed afterwards. */
async function inFolder(work) {
  const folder = mkdtempSync(join(tmpdir(), 'pc-care-test-'))
  try {
    await work(folder)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** Write `path` and date its last change `at`. */
function dated(path, text, at) {
  writeFileSync(path, text)
  utimesSync(path, new Date(at), new Date(at))
}

const failed = (result, pattern) => {
  assert.equal(result.isError, true, JSON.stringify(result))
  assert.match(result.content[0].text, pattern)
}

test('every capability the manifest provides is bound to exactly one tool, with its annotations', () => {
  const { tools } = ready()
  const bound = [...tools.values()].flatMap((one) => one.config._meta?.['alexia/provides'] ?? [])
  assert.deepEqual([...bound].sort(), [...manifest.provides].sort())
  assert.equal(new Set(bound).size, bound.length)
  const hints = (name) => tools.get(name).config.annotations
  assert.deepEqual(hints('system_get'), { readOnlyHint: true, openWorldHint: false })
  assert.deepEqual(hints('system_set'), { readOnlyHint: false, destructiveHint: false, openWorldHint: false })
  assert.deepEqual(hints('system_care'), { readOnlyHint: false, destructiveHint: true, openWorldHint: false })
  assert.deepEqual(hints('power_do'), { readOnlyHint: false, destructiveHint: true, openWorldHint: false })
  assert.deepEqual(hints('power_cancel'), { readOnlyHint: false, destructiveHint: false, openWorldHint: false })
  assert.equal(tools.get('power_cancel').config._meta, undefined)
})

test('the plugin stays running, so a waiting power action is not lost to an idle stop', () => {
  assert.equal(manifest.lifetime, 'resident')
})

test('volume_bounds', async () => {
  const { call, calls } = ready({ answer: ({ question }) => ({ volume: question.value ?? 40, mute: false, brightness: question.value }) })
  for (const what of ['volume', 'brightness']) {
    for (const value of [-1, 101, 1000, Number.NaN, Number.POSITIVE_INFINITY, '50', true, undefined]) {
      failed(await call('system_set', { what, value }), /0 to 100/)
    }
  }
  assert.equal(calls.length, 0, 'a value out of bounds reaches nothing')

  for (const [value, sent] of [[0, 0], [100, 100], [49.6, 50]]) {
    const done = await call('system_set', { what: 'volume', value })
    assert.deepEqual(done.structuredContent, { what: 'volume', value: sent })
    assert.deepEqual(calls.at(-1).question, { do: 'volume_set', value: sent })
  }
  assert.deepEqual((await call('system_set', { what: 'brightness', value: 70 })).structuredContent, { what: 'brightness', value: 70 })
  assert.deepEqual(calls.at(-1).question, { do: 'brightness_set', value: 70 })
  const read = await call('system_get', { what: 'volume' })
  assert.deepEqual(read.structuredContent, { what: 'volume', value: 40 })
  assert.equal(read.content[0].text, 'Volume is 40%.')
  assert.deepEqual(calls.at(-1).question, { do: 'audio' })

  // On or off settings take a boolean and nothing like one.
  const before = calls.length
  for (const value of [1, 0, 'true', undefined]) failed(await call('system_set', { what: 'mute', value }), /true \(on\) or false/)
  failed(await call('system_set', { what: 'wallpaper', value: true }), /not “wallpaper”/)
  assert.equal(calls.length, before)
  assert.deepEqual((await call('system_set', { what: 'mute', value: true })).structuredContent, { what: 'mute', value: false })
  assert.deepEqual(calls.at(-1).question, { do: 'mute_set', value: true })
})

test('dark_mode_registry_value', async () => {
  let light = 1
  const { call, calls } = ready({
    answer: ({ question }) => {
      if (question.do === 'dark_set') light = question.light
      return { light }
    },
  })
  const on = await call('system_set', { what: 'dark_mode', value: true })
  assert.deepEqual(calls.at(-1).question, { do: 'dark_set', light: 0 })
  assert.deepEqual(on.structuredContent, { what: 'dark_mode', value: true })
  assert.equal(on.content[0].text, 'Dark mode is on.')
  const off = await call('system_set', { what: 'dark_mode', value: false })
  assert.deepEqual(calls.at(-1).question, { do: 'dark_set', light: 1 })
  assert.deepEqual(off.structuredContent, { what: 'dark_mode', value: false })
  for (const [stored, dark] of [[0, true], [1, false], [null, false]]) {
    light = stored
    assert.equal((await call('system_get', { what: 'dark_mode' })).structuredContent.value, dark, String(stored))
    assert.deepEqual(calls.at(-1).question, { do: 'dark' })
  }
  assert.equal(calls.at(-1).args.at(-1), THEME)
  assert.ok(THEME.includes('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'))
  assert.match(THEME, /'AppsUseLightTheme', 'SystemUsesLightTheme'/)
  assert.match(THEME, /-PropertyType DWord -Value \(\[int\]\$ask\.light\)/)
})

test('a value travels beside the script, never inside it', async () => {
  const name = `'; Stop-Computer -Force; '`
  const { call, calls } = ready({
    answer: ({ question }) =>
      question.do === 'startup' ? { items: [{ name, command: 'x', where: 'this user', enabled: true }] } : { disabled: true },
  })
  await call('system_care', { check: 'startup', disable: name })
  for (const one of calls) {
    assert.equal(one.file, shell())
    assert.deepEqual(one.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    assert.equal(one.args.at(-1), CARE)
  }
  assert.equal(calls.at(-1).question.name, name)
})

slowTest('temp_apply_only_old', () =>
  inFolder(async (folder) => {
    const root = join(folder, 'temp')
    const outside = join(folder, 'outside')
    mkdirSync(join(root, 'deep', 'deeper'), { recursive: true })
    mkdirSync(outside)
    // The clock stands 30 days ahead, so a file made now is old unless it is dated otherwise.
    const clock = fakeClock(Date.now() + 30 * DAY)
    writeFileSync(join(root, 'old.log'), '12345')
    writeFileSync(join(root, 'deep', 'deeper', 'old.bin'), '123')
    writeFileSync(join(root, 'held.tmp'), '1234567')
    dated(join(root, 'eight-days.txt'), '1', clock.now() - 8 * DAY)
    dated(join(root, 'six-days.txt'), 'new', clock.now() - 6 * DAY)
    dated(join(root, 'deep', 'today.txt'), 'new', clock.now())
    writeFileSync(join(outside, 'precious.txt'), 'not temp')
    symlinkSync(outside, join(root, 'link'), 'junction')

    const { call, calls } = ready({
      temp: root,
      home: join(folder, 'home'),
      clock,
      // Stands where the delete script is: it deletes what it is given, except the file in use.
      answer: ({ question }) => ({
        deleted: question.files.flatMap((path, index) => {
          if (basename(path) === 'held.tmp') return []
          unlinkSync(path)
          return [index]
        }),
      }),
    })

    const looked = await call('system_care', { check: 'temp' })
    assert.equal(calls.length, 0, 'only looking starts nothing')
    assert.match(looked.structuredContent.report, /^4 files .* older than 7 days, 16 bytes in all/)
    assert.equal(looked.structuredContent.freed_bytes, undefined)
    assert.ok(existsSync(join(root, 'old.log')))

    const done = await call('system_care', { check: 'temp', apply: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args.at(-1), DELETE)
    assert.deepEqual(calls[0].question.files.map((path) => basename(path)).sort(), ['eight-days.txt', 'held.tmp', 'old.bin', 'old.log'])
    assert.equal(done.structuredContent.freed_bytes, 9)
    assert.match(done.structuredContent.report, /^Deleted 3 files .* freed 9 bytes\. 1 file stayed/)
    for (const kept of [['six-days.txt'], ['deep', 'today.txt'], ['held.tmp'], ['link', 'precious.txt']]) {
      assert.ok(existsSync(join(root, ...kept)), kept.join('/'))
    }
    assert.ok(existsSync(join(outside, 'precious.txt')))
    assert.ok(existsSync(join(root, 'deep', 'deeper')), 'folders are left in place')
  }),
)

slowTest('a file changed long ago but only just created is not old', () =>
  inFolder(async (folder) => {
    const path = join(folder, 'unpacked.txt')
    dated(path, 'x', Date.now() - 30 * DAY)
    // macOS pulls the creation date back with the modification date; Windows keeps it.
    const createdLately = Date.now() - lstatSync(path).birthtimeMs < 7 * DAY
    if (process.platform === 'win32') assert.equal(createdLately, true)
    const { files } = await oldFiles(folder)
    assert.equal(files.length, createdLately ? 0 : 1)
  }),
)

slowTest('a long clean-up goes in batches, stops in time, and says what is left', () =>
  inFolder(async (folder) => {
    const total = BATCH + 3
    const root = join(folder, 'temp')
    mkdirSync(root)
    for (let i = 0; i < total; i++) writeFileSync(join(root, `${String(i)}.tmp`), 'x')
    const ahead = Date.now() + 30 * DAY
    let at = ahead
    let slow = 0
    const batches = []
    const backend = {
      deleteUnused: async (files) => {
        batches.push(files.length)
        at += slow
        return files
      },
    }
    const care = createCare({ backend, temp: root, home: join(folder, 'home'), now: () => at })
    assert.equal((await care.care({ check: 'temp', apply: true })).data.freed_bytes, total)
    assert.deepEqual(batches, [BATCH, 3])
    batches.length = 0
    at = ahead
    slow = CLEAN_MS + 1
    const stopped = await care.care({ check: 'temp', apply: true })
    assert.deepEqual(batches, [BATCH])
    assert.match(stopped.text, /ask again for the other 3\./)
  }),
)

slowTest('a temp folder that is not one is left alone', () =>
  inFolder(async (folder) => {
    const home = join(folder, 'home')
    const windows = join(folder, 'Windows')
    mkdirSync(join(home, 'Temp'), { recursive: true })
    mkdirSync(join(windows, 'Temp'), { recursive: true })
    const where = { home, system: windows }
    for (const wrong of [parse(folder).root, home, folder, join(windows, 'Temp'), homedir()]) {
      await assert.rejects(safeTemp(wrong, where), /left it alone/, wrong)
    }
    assert.equal(basename(await safeTemp(join(home, 'Temp'), where)), 'Temp')
    const { call, calls } = ready({ temp: home, home })
    failed(await call('system_care', { check: 'temp', apply: true }), /left it alone/)
    assert.equal(calls.length, 0)
  }),
)

const STARTUP = [
  { name: 'OneDrive', command: 'onedrive.exe', where: 'this user', enabled: true },
  { name: 'Updater', command: 'a.exe', where: 'this user', enabled: true },
  { name: 'Updater', command: 'b.exe', where: 'all users', enabled: true },
  { name: 'Chat.lnk', command: 'c:\\Chat.lnk', where: 'this user, Startup folder', enabled: true },
  { name: 'Quiet', command: 'q.exe', where: 'all users', enabled: false },
]

test('startup_disable_one', async () => {
  const { call, calls } = ready({
    answer: ({ question }) => (question.do === 'startup' ? { items: STARTUP } : { disabled: true }),
  })
  const writes = () => calls.filter((one) => one.question.do === 'startup_disable').map((one) => one.question)

  const listed = await call('system_care', { check: 'startup' })
  assert.equal(listed.structuredContent.items.length, STARTUP.length)
  assert.match(listed.content[0].text, /OneDrive \(this user\): on/)
  assert.match(listed.content[0].text, /Quiet \(all users\): off/)
  assert.deepEqual(writes(), [])

  const done = await call('system_care', { check: 'startup', disable: 'onedrive' })
  assert.deepEqual(writes(), [{ do: 'startup_disable', name: 'OneDrive', where: 'this user' }])
  assert.match(done.content[0].text, /OneDrive will no longer start/)
  assert.deepEqual(done.structuredContent.items, ['OneDrive (this user)'])

  // Two of a name: nothing is touched until one is chosen.
  failed(await call('system_care', { check: 'startup', disable: 'Updater' }), /Updater \(this user\); Updater \(all users\)/)
  assert.equal(writes().length, 1)
  await call('system_care', { check: 'startup', disable: 'Updater (all users)' })
  assert.deepEqual(writes().at(-1), { do: 'startup_disable', name: 'Updater', where: 'all users' })
  await call('system_care', { check: 'startup', disable: 'Chat' })
  assert.deepEqual(writes().at(-1), { do: 'startup_disable', name: 'Chat.lnk', where: 'this user, Startup folder' })

  const already = await call('system_care', { check: 'startup', disable: 'Quiet' })
  assert.match(already.content[0].text, /already switched off/)
  failed(await call('system_care', { check: 'startup', disable: 'Nothing' }), /Nothing that starts/)
  failed(await call('system_care', { check: 'startup', disable: '  ' }), /which startup item/)
  failed(await call('system_care', { check: 'startup', apply: true }), /Only the temp check/)
  failed(await call('system_care', { check: 'disk', disable: 'OneDrive' }), /Only a startup item/)
  assert.equal(writes().length, 3)
  assert.throws(() => pick([], 'x'), /Nothing that starts/)
})

test('a startup item Windows will not switch off is a failure, in its words', async () => {
  const { call } = ready({
    answer: ({ question }) => (question.do === 'startup' ? { items: STARTUP } : { refused: 'Windows needs an administrator.' }),
  })
  failed(await call('system_care', { check: 'startup', disable: 'OneDrive' }), /needs an administrator/)
  const unchanged = ready({ answer: ({ question }) => (question.do === 'startup' ? { items: STARTUP } : { disabled: false }) })
  failed(await unchanged.call('system_care', { check: 'startup', disable: 'OneDrive' }), /did not switch OneDrive off/)
})

slowTest('on a Mac, one launch agent or one login item is switched off', () =>
  inFolder(async (home) => {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    for (const name of ['com.example.sync.plist', 'com.example.off.plist']) {
      writeFileSync(join(home, 'Library', 'LaunchAgents', name), '')
    }
    const { call, calls } = ready({
      platform: 'darwin',
      home,
      answer: ({ file, args }) => {
        if (file.endsWith('osascript')) return 'Music Helper\t/Applications/Helper.app'
        if (file.endsWith('plutil')) return basename(args.at(-1), '.plist')
        if (args[0] === 'print-disabled') return 'disabled services = {\n\t"com.example.off" => disabled\n\t"com.example.sync" => enabled\n}'
        return ''
      },
    })
    const listed = await call('system_care', { check: 'startup' })
    assert.deepEqual(listed.structuredContent.items, [
      'Music Helper (login item): on',
      'com.example.off (launch agent): off',
      'com.example.sync (launch agent): on',
    ])
    const writes = () => calls.filter((one) => one.args[0] === 'disable' || one.args[1] === DELETE_LOGIN_ITEM)
    assert.deepEqual(writes(), [])
    await call('system_care', { check: 'startup', disable: 'com.example.sync' })
    assert.deepEqual(writes().map((one) => one.args), [['disable', 'gui/501/com.example.sync']])
    const removed = await call('system_care', { check: 'startup', disable: 'Music Helper' })
    assert.match(removed.content[0].text, /add \/Applications\/Helper\.app/)
    assert.equal(writes().length, 2)
    assert.deepEqual(writes()[1].args, ['-e', DELETE_LOGIN_ITEM, 'Music Helper'])
    assert.match(DELETE_LOGIN_ITEM, /delete login item \(item 1 of argv\)/)
  }),
)

test('PowerShell is given the Windows folders a plugin’s short environment leaves out', async () => {
  const short = environment({ SYSTEMDRIVE: 'D:', SYSTEMROOT: 'D:\\Windows', PATH: 'p' })
  assert.deepEqual(short, {
    SYSTEMDRIVE: 'D:',
    SYSTEMROOT: 'D:\\Windows',
    PATH: 'p',
    ProgramData: 'D:\\ProgramData',
    ALLUSERSPROFILE: 'D:\\ProgramData',
    windir: 'D:\\Windows',
  })
  // What is already there is kept, however its name is cased.
  const own = environment({ PROGRAMDATA: 'E:\\Data', AllUsersProfile: 'E:\\All', WINDIR: 'E:\\W' })
  assert.deepEqual(own, { PROGRAMDATA: 'E:\\Data', AllUsersProfile: 'E:\\All', WINDIR: 'E:\\W' })
  const { call, calls } = ready({ answer: () => ({ updates: [] }) })
  await call('system_care', { check: 'updates' })
  assert.ok(Object.keys(calls[0].options.env).some((name) => name.toUpperCase() === 'PROGRAMDATA'))
})

test('updates are reported and never installed', async () => {
  const { call, calls } = ready({ answer: () => ({ updates: ['Security Update (KB1)', 'Driver'] }) })
  const found = await call('system_care', { check: 'updates' })
  assert.match(found.content[0].text, /^2 updates are waiting \(I have not installed anything\)/)
  assert.deepEqual(found.structuredContent.items, ['Security Update (KB1)', 'Driver'])
  assert.deepEqual(calls[0].question, { do: 'updates' })
  failed(await call('system_care', { check: 'updates', apply: true }), /never install/)
  assert.equal(calls.length, 1)
  assert.doesNotMatch(CARE, /CreateUpdateInstaller|CreateUpdateDownloader|\.Install\(|\.Download\(/)
  const none = ready({ answer: () => ({ updates: [] }) })
  assert.equal((await none.call('system_care', { check: 'updates' })).content[0].text, 'No updates are waiting.')
})

test('disk space is said in sizes a person reads', async () => {
  const { call } = ready({ answer: () => ({ disks: [{ name: 'C:', label: 'System', size: 1000 * 1024 ** 3, free: 250 * 1024 ** 3 }] }) })
  const found = await call('system_care', { check: 'disk' })
  assert.equal(found.structuredContent.report, 'C: (System): 250.0 GB free of 1000.0 GB, 25% free')
  assert.equal(found.structuredContent.check, 'disk')
  failed(await ready({ answer: () => 'not json' }).call('system_care', { check: 'disk' }), /unreadable/)
})

test('power_actions_scripts', async () => {
  const expected = {
    lock: [rundll(), ['user32.dll,LockWorkStation']],
    restart: [shutdownExe(), ['/r', '/t', '0']],
    shutdown: [shutdownExe(), ['/s', '/t', '0']],
  }
  for (const [action, [file, args]] of Object.entries(expected)) {
    const { call, calls, clock } = ready()
    const asked = await call('power_do', { action })
    assert.equal(asked.structuredContent.action, action)
    if (action !== 'lock') {
      assert.equal(calls.length, 0, `${action} waits`)
      assert.equal(asked.structuredContent.at, clock.now() + 60_000)
      assert.match(asked.content[0].text, /in 60 s\. Say cancel/)
      await clock.advance(59_999)
      assert.equal(calls.length, 0)
      await clock.advance(1)
    }
    assert.deepEqual(calls.map((one) => [one.file, one.args]), [[file, args]], action)
    assert.ok(!args.includes('/f'), 'nothing is forced closed')
  }

  const asleep = ready({ answer: () => ({ ok: true }) })
  await asleep.call('power_do', { action: 'sleep' })
  assert.equal(asleep.calls.length, 0, 'the answer goes out before the computer sleeps')
  await asleep.clock.advance(5_000)
  assert.equal(asleep.calls[0].file, shell())
  assert.deepEqual(asleep.calls[0].question, { do: 'sleep' })
  assert.match(asleep.calls[0].args.at(-1), /SetSuspendState\(\[System\.Windows\.Forms\.PowerState\]::Suspend, \$false, \$false\)/)

  const scripts = {
    lock: /keystroke "q" using \{control down, command down\}/,
    sleep: /to sleep$/,
    restart: /to restart$/,
    shutdown: /to shut down$/,
  }
  for (const [action, script] of Object.entries(scripts)) {
    const mac = ready({ platform: 'darwin' })
    await mac.call('power_do', { action })
    await mac.clock.advance(60_000)
    assert.equal(mac.calls.length, 1, action)
    assert.equal(mac.calls[0].file, '/usr/bin/osascript')
    assert.equal(mac.calls[0].args[0], '-e')
    assert.match(mac.calls[0].args[1], script)
  }
})

test('power_cancel', async () => {
  const { call, calls, clock } = ready()
  const asked = await call('power_do', { action: 'shutdown', in_s: 600 })
  assert.match(asked.content[0].text, /^Shutting down in 10 minutes\./)
  assert.equal(asked.structuredContent.at, clock.now() + 600_000)
  const cancelled = await call('power_cancel')
  assert.deepEqual(cancelled.structuredContent, { cancelled: true, action: 'shutdown' })
  assert.equal(clock.waiting.size, 0)
  await clock.advance(700_000)
  assert.equal(calls.length, 0)
  assert.deepEqual((await call('power_cancel')).structuredContent, { cancelled: false })

  // A restart asked for sooner than a minute still gets its warning.
  const soon = await call('power_do', { action: 'restart', in_s: 5 })
  assert.match(soon.content[0].text, /in 60 s\. I always give a minute’s warning\./)
  assert.equal(soon.structuredContent.at, clock.now() + 60_000)
  // One thing waits at a time, and cancelling stops the newer one too.
  const instead = await call('power_do', { action: 'sleep', in_s: 600 })
  assert.match(instead.content[0].text, /replaces the restart/)
  assert.equal(clock.waiting.size, 1)
  // Locking now leaves what is waiting alone.
  await call('power_do', { action: 'lock' })
  assert.equal(calls.length, 1)
  assert.equal(clock.waiting.size, 1)
  assert.deepEqual((await call('power_cancel')).structuredContent, { cancelled: true, action: 'sleep' })
  await clock.advance(700_000)
  assert.equal(calls.length, 1)

  const later = await call('power_do', { action: 'lock', in_s: 30 })
  assert.match(later.content[0].text, /^Locking in 30 s\./)
  await call('power_cancel')
  await clock.advance(31_000)
  assert.equal(calls.length, 1)

  for (const in_s of [-1, 1.5, 86_401, '60']) failed(await call('power_do', { action: 'sleep', in_s }), /whole number of seconds/)
  failed(await call('power_do', { action: 'hibernate' }), /not “hibernate”/)
  assert.equal(clock.waiting.size, 0)
})

test('a power action the computer slept through is dropped, and a failed one is logged', async () => {
  const slept = ready()
  await slept.call('power_do', { action: 'shutdown' })
  await slept.clock.advance(60_000 + LATE_MS + 1)
  assert.equal(slept.calls.length, 0)
  assert.match(slept.logged[0], /shutdown was dropped/)
  assert.deepEqual((await slept.call('power_cancel')).structuredContent, { cancelled: false })

  const refused = ready({
    answer: () => {
      throw new Error('Access is denied.')
    },
  })
  await refused.call('power_do', { action: 'restart' })
  await refused.clock.advance(60_000)
  assert.deepEqual(refused.logged, ['the restart failed: Access is denied.'])
  failed(await refused.call('power_do', { action: 'lock' }), /Access is denied/)
})

test('unsupported_says_so', async () => {
  const windows = ready({ answer: () => ({ refused: 'This screen does not let the computer change its brightness.' }) })
  for (const [name, args] of [['system_get', { what: 'focus' }], ['system_set', { what: 'focus', value: true }]]) {
    failed(await windows.call(name, args), /does not let a program turn Focus assist/)
  }
  assert.equal(windows.calls.length, 0)
  failed(await windows.call('system_set', { what: 'brightness', value: 10 }), /does not let the computer change its brightness/)

  const mac = ready({ platform: 'darwin', answer: () => 'missing value\nmissing value' })
  failed(await mac.call('system_get', { what: 'focus' }), /Do Not Disturb/)
  failed(await mac.call('system_set', { what: 'focus', value: false }), /Do Not Disturb/)
  failed(await mac.call('system_get', { what: 'brightness' }), /brightness/)
  failed(await mac.call('system_set', { what: 'brightness', value: 50 }), /brightness/)
  assert.equal(mac.calls.length, 0)
  failed(await mac.call('system_set', { what: 'volume', value: 50 }), /no volume the Mac can change/)

  const nowhere = register(undefined)
  const asked = {
    system_get: { what: 'volume' },
    system_set: { what: 'volume', value: 1 },
    system_care: { check: 'disk' },
    power_do: { action: 'lock' },
    power_cancel: undefined,
  }
  for (const [name, args] of Object.entries(asked)) {
    failed(await nowhere.call(name, args), /not available on/)
    assert.equal(nowhere.tools.get(name).config._meta, undefined, name)
  }
})

test('on a Mac, settings go to osascript with their values in argv', async () => {
  const { call, calls } = ready({
    platform: 'darwin',
    answer: ({ args }) => (args[1].includes('dark mode') ? 'true' : '35\nfalse'),
  })
  assert.equal((await call('system_set', { what: 'volume', value: 35 })).structuredContent.value, 35)
  assert.deepEqual(calls.at(-1).args.slice(2), ['volume', '35'])
  assert.equal((await call('system_get', { what: 'mute' })).structuredContent.value, false)
  assert.deepEqual(calls.at(-1).args.slice(2), ['read'])
  assert.equal((await call('system_set', { what: 'dark_mode', value: true })).structuredContent.value, true)
  assert.deepEqual(calls.at(-1).args.slice(2), ['true'])
  assert.equal((await call('system_get', { what: 'dark_mode' })).structuredContent.value, true)
  assert.equal(calls.at(-1).args.length, 2)
})

test('what a Mac’s tools print is read', () => {
  const df = [
    'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1  971350180  10000000 500000000     3%    /',
    '/dev/disk3s5    971350180 400000000 500000000    45%    /System/Volumes/Data',
    '/dev/disk3s6    971350180   2000000 500000000     1%    /System/Volumes/VM',
    '/dev/disk4s1      1000000    400000    600000    40%    /Volumes/My Stick',
  ].join('\n')
  assert.deepEqual(readDisks(df), [
    { name: 'This Mac', label: '', size: 971350180 * 1024, free: 500000000 * 1024 },
    { name: '/Volumes/My Stick', label: '', size: 1000000 * 1024, free: 600000 * 1024 },
  ])
  const listed = 'Software Update found the following:\n* Label: macOS 15.2-24C101\n\tTitle: macOS Sequoia 15.2, Version: 15.2, Size: 1K,\n* Safari-18'
  assert.deepEqual(readUpdates(listed), ['macOS Sequoia 15.2', 'Safari-18'])
  assert.deepEqual(readUpdates('Finding available software\nNo new software available.'), [])
  assert.throws(() => readUpdates('Finding available software'), /did not answer/)
  assert.deepEqual([...readOpen('p1\nfcwd\nD0x10\ni42\nf3\ni7\nf4\nD0x10\ni43')], ['16:42', '16:43'])
})

slowTest('on a Mac, an open file stays, and nothing goes when open files are unknown', () =>
  inFolder(async (folder) => {
    const root = join(folder, 'temp')
    mkdirSync(root)
    for (const name of ['free.tmp', 'open.tmp']) writeFileSync(join(root, name), 'abc')
    const clock = fakeClock(Date.now() + 30 * DAY)
    let listing = ''
    const mac = ready({ platform: 'darwin', temp: root, home: join(folder, 'home'), clock, answer: () => listing })
    failed(await mac.call('system_care', { check: 'temp', apply: true }), /nothing was deleted/)
    assert.ok(existsSync(join(root, 'free.tmp')))
    const open = lstatSync(join(root, 'open.tmp'), { bigint: true })
    listing = `p99\nf3\nD0x${open.dev.toString(16)}\ni${String(open.ino)}`
    const done = await mac.call('system_care', { check: 'temp', apply: true })
    assert.equal(done.structuredContent.freed_bytes, 3)
    assert.equal(existsSync(join(root, 'free.tmp')), false)
    assert.ok(existsSync(join(root, 'open.tmp')))
    assert.equal(mac.calls.at(-1).file, '/usr/sbin/lsof')
  }),
)

slowTest('the runner passes input in and brings output back, and says why a program failed', async () => {
  const node = (code, options) => runProgram(process.execPath, ['-e', code], options)
  const echo = 'process.stdin.pipe(process.stdout)'
  assert.equal((await node(echo, { input: 'příliš žluťoučký' })).stdout, 'příliš žluťoučký')
  await assert.rejects(node('console.error("first\\nsecond"); process.exit(3)'), /^Error: first$/)
  assert.equal((await node('console.log("some"); process.exit(1)', { okCodes: [0, 1] })).stdout, 'some')
  await assert.rejects(node('setInterval(() => {}, 1000)', { timeout: 500 }), /took too long/)
  // A fake runner answers in the same shape.
  assert.deepEqual(await fakeRunner(() => 'x').run('f', []), { stdout: 'x', stderr: '' })
})
