// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { dialogRequest, macos, SCRIPT as MAC_SCRIPT } from '../macos.js'
import { ANSWER_MS, createNotifier, MAX_LEFT_OPEN, parseNotice, START_MS } from '../notify.js'
import { startProcess } from '../run.js'
import { SCRIPT as WIN_SCRIPT, toastXml, windows } from '../windows.js'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A parsed notice, so every test starts from what the tool itself would build. */
function notice(args = {}) {
  const parsed = parseNotice({ title: 'A title', text: 'Some text', urgency: 'normal', ...args })
  assert.equal(parsed.error, undefined)
  return parsed.notice
}

const two = [
  { label: 'Yes', data: 'ask:1:yes' },
  { label: 'No', data: 'ask:1:no' },
]

/** A clock that moves only when told to. */
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      timers.set(next, { at: now + ms, fn })
      return next++
    },
    clearTimeout: (id) => void timers.delete(id),
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now || !timers.delete(id)) continue
        timer.fn()
      }
    },
    get pending() {
      return timers.size
    },
  }
}

/** Helpers that never run: each records how it was started and says what the test tells it to. */
function fakeStart() {
  const started = []
  const start = (command, args, { input, onLine }) => {
    let end
    const helper = {
      command,
      args,
      input,
      killed: false,
      released: false,
      exit: new Promise((resolve) => (end = resolve)),
      say: (line) => onLine(JSON.stringify(line)),
      raw: onLine,
      end: (code = 0) => end({ code }),
      kill() {
        helper.killed = true
        end({ code: null })
      },
      release() {
        helper.released = true
      },
    }
    started.push(helper)
    return helper
  }
  return { start, started }
}

function rig(backend, options = {}) {
  const clock = fakeClock()
  const fake = fakeStart()
  const notifier = createNotifier({ backend, start: fake.start, clock, ...options })
  return { clock, started: fake.started, notifier }
}

/** Resolves to `'waiting'` when the promise has not settled after the microtasks have run. */
const stateOf = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 0, 'waiting'))])

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const request = (plan) => JSON.parse(Buffer.from(plan.input, 'base64').toString('utf8'))

const UNESCAPE = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const unescaped = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => UNESCAPE[entity])

const HOSTILE = `He said "hi" & 'bye' <now> ’; Remove-Item C:\\nothing; ‘ $(whoami) \`n '@ "@ </text><action content="x"/>`

// --- Windows ------------------------------------------------------------------------------

test('windows_script_escapes_quotes', () => {
  const plan = windows.plan(notice({ title: HOSTILE, text: `${HOSTILE}\nsecond line`, buttons: [{ label: `O'K "<&>`, data: 'only-the-data-7f3' }] }), { answerMs: ANSWER_MS })
  // The code is the same constant whatever the notice says: nothing of it is in the arguments.
  assert.equal(plan.args.at(-1), WIN_SCRIPT)
  assert.ok(!plan.args.join(' ').includes('Remove-Item'))
  // It travels as base64, so no quote or code page can touch it on the way.
  assert.match(plan.input, /^[A-Za-z0-9+/]+=*$/)

  const { xml } = request(plan)
  // Escaped into the XML: the only elements are the ones the toast itself is made of.
  assert.deepEqual(
    [...xml.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]),
    ['toast', 'visual', 'binding', 'text', 'text', 'text', 'text', 'binding', 'visual', 'actions', 'action', 'actions', 'audio', 'toast'],
  )
  const texts = [...xml.matchAll(/<text>([\s\S]*?)<\/text>/g)].map((m) => unescaped(m[1]))
  assert.equal(texts[0], notice({ title: HOSTILE }).title)
  assert.equal(texts[1], `${HOSTILE}\nsecond line`)
  assert.equal(unescaped(/<action content="([^"]*)"/.exec(xml)[1]), `O'K "<&>`)
  // A button's data is never part of the toast.
  assert.ok(!xml.includes('only-the-data-7f3'))
})

test('windows drops characters XML cannot hold and cuts a long notice to size', () => {
  const xml = toastXml(notice({ title: 'a\u0000b\u0007c\uD800d\uFFFFe 🙂', text: '🙂'.repeat(3000) }))
  assert.ok(xml.includes('<text>abcde 🙂</text>'))
  assert.ok(Buffer.byteLength(xml, 'utf8') < 5000)
  assert.ok(xml.isWellFormed())
})

test('windows toast has the buttons, the reply box, and sound only when urgent', () => {
  const asking = toastXml(notice({ buttons: two, reply: true, urgency: 'urgent' }))
  assert.ok(asking.includes('<input id="reply" type="text"'))
  assert.deepEqual(
    [...asking.matchAll(/arguments="([^"]+)"/g)].map((m) => m[1]),
    ['b0', 'b1', 'send'],
  )
  assert.ok(asking.includes('ms-winsoundevent:Notification.Default'))
  assert.ok(asking.includes('scenario="reminder"'))
  assert.ok(!asking.includes('ask:1:yes'))

  for (const urgency of ['low', 'normal', 'high']) assert.ok(toastXml(notice({ urgency })).includes('<audio silent="true"/>'))
  const plain = toastXml(notice())
  assert.ok(!plain.includes('<actions>') && !plain.includes('scenario'))
})

test('windows waits for an answer only when one was asked for, and tags a notice by its id', () => {
  const plain = windows.plan(notice(), { answerMs: ANSWER_MS })
  assert.equal(plain.asks, false)
  assert.equal(request(plain).waitMs, 0)
  assert.equal(request(plain).tag, '')

  const asking = windows.plan(notice({ reply: true, id: 'commitments:12'.repeat(10) }), { answerMs: ANSWER_MS })
  assert.equal(asking.asks, true)
  assert.ok(request(asking).waitMs > ANSWER_MS)
  assert.match(request(asking).tag, /^[0-9a-f]{32}$/)
  assert.equal(request(windows.plan(notice({ id: 'a' }), { answerMs: 1 })).tag, request(windows.plan(notice({ id: 'a' }), { answerMs: 1 })).tag)
  assert.match(WIN_SCRIPT, /ToastNotificationManager/)
  assert.match(WIN_SCRIPT, /toast\.Activated \+=/)
})

test('a pressed button returns its data and a sent reply returns its text', async () => {
  const text = 'tomorrow — “at nine” 🙂'
  for (const [line, answer] of [
    [{ action: 'b1', text: '' }, { data: 'ask:1:no' }],
    [{ action: 'b0', text: base64(text) }, { data: 'ask:1:yes', text }],
    [{ action: 'send', text: base64(text) }, { text }],
    [{ action: 'send', text: '' }, null],
    [{ action: 'body', text: base64(text) }, null],
    [{ action: 'close' }, null],
  ]) {
    const { notifier, started, clock } = rig(windows)
    const result = notifier.show(notice({ buttons: two, reply: true }))
    started[0].say({ shown: true })
    started[0].say(line)
    started[0].end(0)
    assert.deepEqual(await result, { shown: true, answer })
    assert.equal(clock.pending, 0)
  }
})

test('a plain windows notice is shown once its helper ends well', async () => {
  const { notifier, started } = rig(windows)
  const result = notifier.show(notice())
  started[0].say({ shown: true })
  assert.equal(await stateOf(result), 'waiting')
  started[0].end(0)
  assert.deepEqual(await result, { shown: true })
})

test('a notice that could not be shown says so', async () => {
  for (const drive of [
    (h) => h.say({ failed: 'disabled' }),
    (h) => h.end(1),
    (h) => h.end(0),
    (h) => {
      h.say({ shown: true })
      h.end(1)
    },
    (h) => {
      h.raw('not json')
      h.raw('null')
      h.end(1)
    },
  ]) {
    const { notifier, started } = rig(windows)
    const result = notifier.show(notice({ buttons: two }))
    drive(started[0])
    const got = await result
    assert.equal(got.shown, false)
    assert.equal('answer' in got, false)
  }
  const broken = createNotifier({
    backend: windows,
    start: () => {
      throw new Error('spawn EPERM')
    },
  })
  assert.equal((await broken.show(notice())).shown, false)
})

test('a helper that never puts the notice up is stopped', async () => {
  const { notifier, started, clock } = rig(windows)
  const result = notifier.show(notice({ buttons: two }))
  clock.advance(START_MS - 1)
  assert.equal(await stateOf(result), 'waiting')
  clock.advance(1)
  assert.deepEqual(await result, { shown: false, reason: 'too slow' })
  assert.equal(started[0].killed, true)
})

// --- Waiting ------------------------------------------------------------------------------

test('answer_or_null_after_timeout', async () => {
  // Answered inside the minute.
  const early = rig(windows)
  const answered = early.notifier.show(notice({ buttons: two }))
  early.started[0].say({ shown: true })
  early.clock.advance(ANSWER_MS - 1)
  early.started[0].say({ action: 'b0', text: '' })
  assert.deepEqual(await answered, { shown: true, answer: { data: 'ask:1:yes' } })

  // Not answered: the minute counts from when the notice went up, not from when the call began.
  const late = rig(windows)
  const unanswered = late.notifier.show(notice({ reply: true }))
  late.clock.advance(START_MS - 1)
  late.started[0].say({ shown: true })
  late.clock.advance(ANSWER_MS - 1)
  assert.equal(await stateOf(unanswered), 'waiting')
  late.clock.advance(1)
  assert.deepEqual(await unanswered, { shown: true, answer: null })
  // The toast is Windows' to keep, so the helper is not.
  assert.equal(late.started[0].killed, true)
  // A click after that is nothing.
  late.started[0].say({ action: 'send', text: base64('too late') })
  assert.deepEqual(await unanswered, { shown: true, answer: null })

  // On a Mac the dialog lives in the helper, so it is left running and the notice stays.
  const mac = rig(macos)
  const staying = mac.notifier.show(notice({ buttons: two }))
  mac.started[0].say({ shown: true })
  mac.clock.advance(ANSWER_MS)
  assert.deepEqual(await staying, { shown: true, answer: null })
  assert.equal(mac.started[0].killed, false)
  assert.equal(mac.started[0].released, true)
})

test('a newer notice with the same id replaces the earlier one', async () => {
  const { notifier, started, clock } = rig(macos)
  const first = notifier.show(notice({ id: 'a', buttons: two }))
  started[0].say({ shown: true })
  const second = notifier.show(notice({ id: 'a', buttons: two }))
  assert.deepEqual(await first, { shown: true, answer: null })
  assert.equal(started[0].killed, true)

  // The same for one already given up on and still on screen.
  started[1].say({ shown: true })
  clock.advance(ANSWER_MS)
  await second
  const other = notifier.show(notice({ id: 'b', buttons: two }))
  assert.equal(started[1].killed, false)
  const third = notifier.show(notice({ id: 'a', buttons: two }))
  assert.equal(started[1].killed, true)
  assert.equal(started[2].killed, false)
  for (const helper of [started[2], started[3]]) {
    helper.say({ shown: true })
    helper.say({ action: 'b0', text: '' })
  }
  await Promise.all([other, third])
})

test('only so many unanswered dialogs are left on screen', async () => {
  const { notifier, started, clock } = rig(macos)
  for (let n = 0; n <= MAX_LEFT_OPEN; n++) {
    const result = notifier.show(notice({ buttons: two }))
    started[n].say({ shown: true })
    clock.advance(ANSWER_MS)
    await result
  }
  assert.deepEqual(
    started.map((h) => h.killed),
    [true, ...Array(MAX_LEFT_OPEN).fill(false)],
  )
})

test('a cancelled call closes its helper', async () => {
  const { notifier, started, clock } = rig(macos)
  const stop = new AbortController()
  const result = notifier.show(notice({ buttons: two }), { signal: stop.signal })
  started[0].say({ shown: true })
  stop.abort()
  assert.deepEqual(await result, { shown: true, answer: null })
  assert.equal(started[0].killed, true)
  assert.equal(clock.pending, 0)

  assert.equal((await notifier.show(notice(), { signal: stop.signal })).shown, false)
  assert.equal(started.length, 1)
})

// --- macOS --------------------------------------------------------------------------------

/**
 * The real script, run here with the few Apple things it touches standing in. `dialog` answers
 * `displayDialog`; what was asked of the system and what was printed come back.
 */
function runMacScript(plan, dialog = () => ({})) {
  const asked = []
  const printed = []
  const $ = (text) => ({ dataUsingEncoding: () => text })
  $.NSUTF8StringEncoding = 4
  $.NSFileHandle = {
    fileHandleWithStandardInput: { readDataToEndOfFile: plan.input },
    fileHandleWithStandardOutput: { writeData: (text) => printed.push(JSON.parse(text)) },
  }
  $.NSString = { alloc: { initWithDataEncoding: (data) => data } }
  const app = {
    displayNotification: (text, options) => asked.push(['notification', text, options]),
    beep: () => asked.push(['beep']),
    displayDialog: (text, options) => {
      asked.push(['dialog', text, options])
      return dialog(options)
    },
  }
  const sandbox = { $, ObjC: { import: () => {}, unwrap: (value) => value }, Application: { currentApplication: () => app } }
  // Through JSON, so what the sandbox built compares equal to what is written here.
  vm.runInNewContext(`${MAC_SCRIPT}\nrun()`, sandbox)
  return { asked: JSON.parse(JSON.stringify(asked)), printed }
}

test('mac_dialog_for_buttons', () => {
  const plan = macos.plan(notice({ title: HOSTILE, text: HOSTILE, buttons: two, urgency: 'high' }))
  assert.equal(plan.command, '/usr/bin/osascript')
  assert.deepEqual(plan.args, ['-l', 'JavaScript', '-e', MAC_SCRIPT])
  assert.ok(!plan.args.join(' ').includes('whoami'))
  assert.equal(plan.asks, true)
  assert.equal(plan.stays, true)

  const { asked, printed } = runMacScript(plan, () => ({ buttonReturned: 'No', textReturned: undefined }))
  assert.deepEqual(asked, [['dialog', HOSTILE, { withTitle: notice({ title: HOSTILE }).title, buttons: ['Close', 'Yes', 'No'] }]])
  assert.deepEqual(printed, [{ shown: true }, { action: 'b1' }])
})

test('mac dialog with a reply box has a default answer and a button that sends it', () => {
  const plan = macos.plan(notice({ reply: true, urgency: 'urgent' }))
  const { asked, printed } = runMacScript(plan, () => ({ buttonReturned: 'Reply', textReturned: 'on my way' }))
  assert.deepEqual(asked, [
    ['beep'],
    ['dialog', 'Some text', { withTitle: 'A title', buttons: ['Close', 'Reply'], defaultAnswer: '', defaultButton: 'Reply' }],
  ])
  assert.deepEqual(printed, [{ shown: true }, { action: 'send', text: 'on my way' }])
})

test('mac buttons stay three, and the owner’s come first', () => {
  const three = [...two, { label: 'Later', data: 'later' }]
  const full = dialogRequest(notice({ buttons: three, reply: true }))
  assert.deepEqual(full.buttons, ['Yes', 'No', 'Later'])
  assert.deepEqual(full.actions, ['b0', 'b1', 'b2'])
  assert.equal(full.defaultButton, undefined)

  const withReply = dialogRequest(notice({ buttons: two, reply: true }))
  assert.deepEqual(withReply.buttons, ['Yes', 'No', 'Reply'])
  assert.deepEqual(withReply.actions, ['b0', 'b1', 'send'])

  const clash = dialogRequest(notice({ buttons: [{ label: 'reply', data: '1' }], reply: true }))
  assert.deepEqual(clash.buttons, ['Close', 'reply', 'Send'])
  assert.deepEqual(clash.actions, ['close', 'b0', 'send'])
  const closes = dialogRequest(notice({ buttons: [{ label: 'Close', data: '1' }] }))
  assert.deepEqual(closes.buttons, ['Dismiss', 'Close'])
})

test('mac reads Cancel and Escape as the button of that name, else as closed', () => {
  const cancelled = () => {
    throw Object.assign(new Error('User canceled.'), { errorNumber: -128 })
  }
  const named = macos.plan(notice({ buttons: [{ label: 'Go', data: 'go' }, { label: 'Cancel', data: 'stop' }] }))
  assert.deepEqual(runMacScript(named, cancelled).printed, [{ shown: true }, { action: 'b1' }])
  const unnamed = macos.plan(notice({ reply: true }))
  assert.deepEqual(runMacScript(unnamed, cancelled).printed, [{ shown: true }, { action: 'close' }])
  assert.throws(() =>
    runMacScript(unnamed, () => {
      throw Object.assign(new Error('No user interaction allowed.'), { errorNumber: -1713 })
    }),
  )
})

test('mac_notification_for_plain', () => {
  const plan = macos.plan(notice({ text: HOSTILE }))
  assert.equal(plan.asks, false)
  assert.equal(plan.stays, false)
  assert.ok(!plan.args.join(' ').includes('whoami'))
  assert.deepEqual(runMacScript(plan), {
    asked: [['notification', HOSTILE, { withTitle: 'A title' }]],
    printed: [{ shown: true }],
  })
  assert.deepEqual(runMacScript(macos.plan(notice({ urgency: 'urgent' }))).asked, [
    ['notification', 'Some text', { withTitle: 'A title', soundName: 'default' }],
  ])
})

test('mac never shows a low-urgency notice as a dialog', async () => {
  const quiet = notice({ urgency: 'low', buttons: two, reply: true })
  const plan = macos.plan(quiet)
  assert.equal(plan.asks, false)
  assert.deepEqual(runMacScript(plan).asked, [['notification', 'Some text', { withTitle: 'A title' }]])

  // Nothing can answer it, so the call does not wait the minute.
  const { notifier, started, clock } = rig(macos)
  const result = notifier.show(quiet)
  started[0].say({ shown: true })
  started[0].end(0)
  assert.deepEqual(await result, { shown: true, answer: null })
  assert.equal(clock.pending, 0)
})

// --- The tool -----------------------------------------------------------------------------

test('at_most_three_buttons', () => {
  const button = (n) => ({ label: `B${String(n)}`, data: String(n) })
  assert.equal(parseNotice({ title: 't', text: 'x', buttons: [1, 2, 3].map(button) }).notice.buttons.length, 3)
  const four = parseNotice({ title: 'secret title', text: 'x', buttons: [1, 2, 3, 4].map(button) })
  assert.equal(four.notice, undefined)
  assert.match(four.error, /three buttons/)
  assert.ok(!four.error.includes('secret title'))
})

test('arguments that make no notification are refused', () => {
  for (const args of [
    {},
    { title: 'only a title' },
    { title: ' ', text: '\n' },
    { title: 't', text: 'x', urgency: 'now' },
    { title: 't', text: 'x', reply: 'yes' },
    { title: 't', text: 'x', buttons: 'Yes' },
    { title: 't', text: 'x', buttons: [{ label: 'Yes' }] },
    { title: 't', text: 'x', buttons: [{ label: ' ', data: 'y' }] },
    { title: 't', text: 'x', buttons: [{ label: 'Yes', data: '1' }, { label: 'yes', data: '2' }] },
    { title: 't', text: 'x', id: '' },
  ]) {
    assert.equal(typeof parseNotice(args).error, 'string', JSON.stringify(args))
  }
  assert.equal(parseNotice({ title: 't', text: 'x' }).notice.urgency, 'normal')
})

/** The plugin as the host runs it, spoken to over stdio. Only calls that show nothing. */
async function serve(use) {
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
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

test('the tool binds notify.show and refuses a fourth button', { timeout: 60_000 }, async () => {
  await serve(async (ask) => {
    const [tool] = (await ask('tools/list', {})).result.tools
    assert.equal(tool.name, 'notify_show')
    const here = process.platform === 'win32' || process.platform === 'darwin'
    assert.deepEqual(tool._meta?.['alexia/provides'], here ? ['notify.show'] : undefined)
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false })
    assert.equal(tool.inputSchema.properties.buttons.maxItems, 3)

    const buttons = [1, 2, 3, 4].map((n) => ({ label: String(n), data: String(n) }))
    const refused = await ask('tools/call', { name: 'notify_show', arguments: { title: 't', text: 'x', buttons } })
    assert.equal(refused.result.isError, true)
  })
})

// --- The real helpers ---------------------------------------------------------------------

test('the runner passes stdin and returns each line, the unfinished last one too', { timeout: 60_000 }, async () => {
  const lines = []
  const helper = startProcess(process.execPath, ['-e', "process.stdin.on('data', d => { process.stderr.write('x'); process.stdout.write(d + '\\n\\nlast') })"], {
    input: 'tomorrow — 🙂',
    onLine: (line) => lines.push(line),
  })
  assert.deepEqual(await helper.exit, { code: 0 })
  assert.deepEqual(lines, ['tomorrow — 🙂', 'last'])

  const missing = startProcess(join(dir, 'no-such-program'), [], { input: '', onLine: () => {} })
  assert.equal((await missing.exit).code === 0, false)
})

const onWindows = process.platform === 'win32' ? false : 'needs Windows PowerShell'

test('windows PowerShell parses the script and reads the XML back as written', { skip: onWindows, timeout: 90_000 }, () => {
  const wanted = notice({ title: HOSTILE, text: `${HOSTILE} — 🙂`, buttons: [{ label: `O'K "<&>`, data: 'd' }], reply: true })
  const plan = windows.plan(wanted, { answerMs: ANSWER_MS })
  // Parses the real script (nothing in it runs) and loads the real XML. Nothing is shown.
  const check = `
    $given = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $errors = $null
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($given.script))
    $null = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$errors)
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($given.request)) | ConvertFrom-Json
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml([string]$request.xml)
    $read = @($xml.GetElementsByTagName('text') | ForEach-Object { $_.InnerText }) + @($xml.GetElementsByTagName('action') | ForEach-Object { $_.GetAttribute('content') })
    @{ errors = @($errors).Count; read = @($read | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }) } | ConvertTo-Json -Compress
  `
  const result = spawnSync(plan.command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', check], {
    input: JSON.stringify({ script: base64(WIN_SCRIPT), request: plan.input }),
    encoding: 'utf8',
    timeout: 80_000,
  })
  assert.equal(result.status, 0, result.stderr)
  const got = JSON.parse(result.stdout.trim())
  assert.equal(got.errors, 0)
  assert.deepEqual(
    got.read.map((value) => Buffer.from(value, 'base64').toString('utf8')),
    [wanted.title, wanted.text, `O'K "<&>`, 'Send'],
  )
})

/**
 * Against the real notifications of the machine it runs on. It puts two on screen, so it only
 * runs when asked: `ALEXIA_LIVE=1 node --test plugins/device-notify/test`. Pressing nothing
 * is expected; whatever is pressed on the second one is accepted.
 */
const backend = { win32: windows, darwin: macos }[process.platform]
const live = process.env.ALEXIA_LIVE === '1' && backend !== undefined

test('live: a real notification goes up, and one with buttons waits for an answer', { skip: !live && 'set ALEXIA_LIVE=1 on a Windows or macOS desktop', timeout: 120_000 }, async () => {
  const notifier = createNotifier({ backend, start: startProcess, answerMs: 8_000 })
  const plain = await notifier.show(notice({ title: 'Alexia live test', text: `A plain notice — “quoted” 'too' 🙂` }))
  assert.deepEqual(plain, { shown: true })

  const id = `live-${String(Date.now())}`
  const asked = await notifier.show(notice({ title: 'Alexia live test', text: 'Press a button, or nothing.', buttons: two, reply: true, id }))
  assert.equal(asked.shown, true)
  assert.ok(asked.answer === null || typeof asked.answer.data === 'string' || typeof asked.answer.text === 'string')
  // A Mac dialog is left on screen after the wait; a notice with the same id closes it again.
  assert.deepEqual(await notifier.show(notice({ title: 'Alexia live test', text: 'Done.', id })), { shown: true })
})
