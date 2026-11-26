// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createInk, commandLine, glide, GLIDE_MS, HIDE_MS, IDLE_MS, QUIT_MS, REPLY_MS, STEP_MS } from '../ink.js'
import { macos, SCRIPT as MAC_SCRIPT } from '../macos.js'
import { startProcess } from '../run.js'
import { MAX_SHAPES, MAX_TEXT, MAX_TTL_MS, DEFAULT_TTL_MS, parseCursor, parseDraw } from '../shapes.js'
import { CANNOT, register } from '../tools.js'
import { windows, SCRIPT as WINDOWS_SCRIPT } from '../windows.js'
import { assert, fakeClock, fakeOverlay, fakePlugin, settle, slowTest, test } from './harness.js'
import { live } from './live.js'

const BACKEND = { command: 'overlay', args: ['--fake'] }
const BOX = { kind: 'box', x: 10, y: 20, w: 300, h: 40 }

function ready(options) {
  const overlay = fakeOverlay(options)
  const clock = fakeClock()
  const warned = []
  const ink = createInk({ backend: BACKEND, start: overlay.start, timers: clock, warn: (why) => warned.push(why) })
  const plugin = fakePlugin()
  register(plugin, ink)
  const call = (name, args) => plugin.tools.get(name).handler(args, {})
  return { overlay, clock, ink, warned, call }
}

const draw = (ink, ttlMs = DEFAULT_TTL_MS) => ink.draw({ ...parseDraw({ shapes: [BOX] }), ttlMs })

test('shapes_validated', async () => {
  const good = parseDraw({
    shapes: [
      { kind: 'box', x: 10.4, y: 20.6, w: 300, h: 40, color: '#0f0' },
      { kind: 'arrow', x: -1900, y: 5, to: { x: 40, y: 60 }, color: 'Blue' },
      { kind: 'text', x: 1, y: 2, text: '  Click\n\there\u0007 ' },
      { kind: 'dot', x: 3, y: 4, w: 9000, color: 'white' },
    ],
  })
  assert.deepEqual(good.shapes, [
    { kind: 'box', x: 10, y: 21, color: '#00FF00', on: '#000000', w: 300, h: 40 },
    { kind: 'arrow', x: -1900, y: 5, color: '#007AFF', on: '#FFFFFF', to: { x: 40, y: 60 } },
    { kind: 'text', x: 1, y: 2, color: '#FF3B30', on: '#FFFFFF', text: 'Click here' },
    { kind: 'dot', x: 3, y: 4, color: '#FFFFFF', on: '#000000', w: 400 },
  ])
  assert.equal(parseDraw({ shapes: [{ kind: 'dot', x: 0, y: 0 }] }).shapes[0].w, 18)
  const long = parseDraw({ shapes: [{ kind: 'text', x: 0, y: 0, text: '😀'.repeat(900) }] }).shapes[0].text
  assert.equal([...long].length, MAX_TEXT)
  assert.ok(long.endsWith('…'))

  const bad = [
    undefined,
    {},
    { shapes: [] },
    { shapes: 'box' },
    { shapes: Array(MAX_SHAPES + 1).fill(BOX) },
    { shapes: [null] },
    { shapes: [{ ...BOX, kind: 'circle' }] },
    { shapes: [{ ...BOX, x: '10' }] },
    { shapes: [{ ...BOX, y: Number.NaN }] },
    { shapes: [{ ...BOX, x: 1e9 }] },
    { shapes: [{ ...BOX, w: 0 }] },
    { shapes: [{ ...BOX, h: undefined }] },
    { shapes: [{ ...BOX, color: 'url(x)' }] },
    { shapes: [{ ...BOX, color: 7 }] },
    { shapes: [{ ...BOX, text: 5 }] },
    { shapes: [{ kind: 'arrow', x: 0, y: 0 }] },
    { shapes: [{ kind: 'arrow', x: 0, y: 0, to: { x: 5 } }] },
    { shapes: [{ kind: 'arrow', x: 5, y: 5, to: { x: 5, y: 5 } }] },
    { shapes: [{ kind: 'text', x: 0, y: 0 }] },
    { shapes: [{ kind: 'text', x: 0, y: 0, text: ' \n ' }] },
    { shapes: [{ kind: 'dot', x: 0, y: 0, w: -3 }] },
    { shapes: [BOX, { kind: 'box', x: 0, y: 0 }] },
  ]
  for (const args of bad) {
    const read = parseDraw(args)
    assert.equal(typeof read.error, 'string', JSON.stringify(args))
    assert.equal(read.shapes, undefined)
  }
  assert.match(parseDraw({ shapes: [BOX, { kind: 'box', x: 0, y: 0 }] }).error, /^Shape 2: /)

  // A refused drawing starts nothing and reaches no overlay.
  const { overlay, call } = ready()
  const refused = await call('screen_draw', { shapes: [BOX, { kind: 'box', x: 0, y: 0 }] })
  assert.equal(refused.isError, true)
  assert.equal(overlay.started.length, 0)

  assert.deepEqual(parseCursor({ x: 1.6, y: 2 }), { x: 2, y: 2, label: 'Alexia' })
  assert.equal(parseCursor({ x: 1, y: 2, label: '  ' }).label, 'Alexia')
  assert.equal([...parseCursor({ x: 1, y: 2, label: 'a'.repeat(100) }).label].length, 40)
  for (const args of [undefined, {}, { x: 1 }, { x: '1', y: 2 }, { x: 1, y: Infinity }, { x: 1, y: 2, label: 3 }]) {
    assert.equal(typeof parseCursor(args).error, 'string', JSON.stringify(args))
    assert.equal((await ready().call('cursor_show', args ?? {})).isError, true)
  }
})

test('ttl_capped', async () => {
  const ttl = (ttl_ms) => parseDraw({ shapes: [BOX], ttl_ms })
  assert.equal(DEFAULT_TTL_MS, 8_000)
  assert.equal(MAX_TTL_MS, 60_000)
  assert.equal(ttl(undefined).ttlMs, 8_000)
  assert.equal(ttl(1_500).ttlMs, 1_500)
  assert.equal(ttl(60_000).ttlMs, 60_000)
  assert.equal(ttl(60_001).ttlMs, 60_000)
  assert.equal(ttl(Number.MAX_SAFE_INTEGER).ttlMs, 60_000)
  assert.equal(ttl(Infinity).ttlMs, 60_000)
  for (const wrong of [0, -5, Number.NaN, '9000']) assert.match(ttl(wrong).error, /ttl_ms/)

  const { overlay, call } = ready()
  const answer = await call('screen_draw', { shapes: [BOX], ttl_ms: 3_600_000 })
  assert.equal(overlay.started[0].commands()[0].ttl_ms, 60_000)
  assert.match(answer.content[0].text, /for 60 s/)
})

test('commands_are_json_lines', async () => {
  const { overlay, call } = ready()
  const drawn = await call('screen_draw', {
    shapes: [{ kind: 'text', x: 1, y: 2, text: 'Uložit   "teď" 😀\r\n{"cmd":"quit"}' }, BOX],
  })
  assert.deepEqual(drawn.structuredContent, { drawn: 2 })
  assert.deepEqual((await call('cursor_show', { x: 5, y: 6, label: 'Žofie' })).structuredContent, {})
  assert.deepEqual((await call('screen_clear')).structuredContent, {})

  assert.equal(overlay.started.length, 1, 'one long-lived process takes every command')
  const [one] = overlay.started
  assert.equal(one.command, 'overlay')
  assert.deepEqual(one.args, ['--fake'])
  for (const line of one.written) {
    assert.match(line, /^[\x20-\x7e]+$/, 'one line of plain ASCII')
    assert.equal(typeof JSON.parse(line), 'object')
  }
  const [first, second, third] = one.commands()
  assert.deepEqual([first.cmd, second.cmd, third.cmd], ['draw', 'cursor', 'clear'])
  assert.equal(new Set([first.id, second.id, third.id]).size, 3)
  assert.equal(first.shapes[0].text, 'Uložit   "teď" 😀 {"cmd":"quit"}')
  assert.equal(second.label, 'Žofie')
  assert.deepEqual(second.path, [[5, 6]])
  assert.equal(second.step_ms, STEP_MS)
  assert.equal(second.hide_ms, HIDE_MS)
  assert.equal(JSON.parse(commandLine({ text: 'é😀\u007f' })).text, 'é😀\u007f')
})

test('overlay_exits_when_idle', async () => {
  assert.equal(IDLE_MS, 60_000)
  const { overlay, clock, ink } = ready()
  await clock.advance(10 * IDLE_MS)
  assert.equal(overlay.started.length, 0, 'nothing runs until something is drawn')

  await draw(ink, 8_000)
  const [first] = overlay.started
  await clock.advance(8_000 + IDLE_MS - 1)
  assert.equal(first.exited, false)
  await clock.advance(1)
  assert.deepEqual(first.commands().at(-1), { cmd: 'quit' })
  assert.equal(first.closed, true)
  assert.equal(first.exited, true)
  assert.equal(ink.running(), undefined)
  await clock.advance(QUIT_MS)
  assert.equal(first.killed, false, 'one that leaves when asked is not killed')

  // The next drawing starts another.
  await draw(ink, 60_000)
  assert.equal(overlay.started.length, 2)
  const second = overlay.started[1]
  // A shorter drawing, or her cursor, never cuts a longer one short.
  await clock.advance(1_000)
  await draw(ink, 1_000)
  await ink.cursor({ x: 1, y: 1, label: 'Alexia' })
  await clock.advance(59_000 + IDLE_MS - 1)
  assert.equal(second.exited, false)
  await clock.advance(1)
  assert.equal(second.exited, true)

  // Her cursor counts as something on screen until it hides.
  await ink.cursor({ x: 2, y: 2, label: 'Alexia' })
  const third = overlay.started[2]
  await clock.advance(HIDE_MS + IDLE_MS - 1)
  assert.equal(third.exited, false)
  await clock.advance(1)
  assert.equal(third.exited, true)

  // Clearing empties the screen, so the minute starts then.
  await draw(ink, 60_000)
  const fourth = overlay.started[3]
  await clock.advance(5_000)
  await ink.clear()
  await clock.advance(IDLE_MS - 1)
  assert.equal(fourth.exited, false)
  await clock.advance(1)
  assert.equal(fourth.exited, true)
})

test('an overlay that ignores quit is killed', async () => {
  const { overlay, clock, ink } = ready({ stubborn: true })
  await draw(ink, 1_000)
  await clock.advance(1_000 + IDLE_MS)
  const [one] = overlay.started
  assert.equal(one.closed, true)
  await clock.advance(QUIT_MS - 1)
  assert.equal(one.killed, false)
  await clock.advance(1)
  assert.equal(one.killed, true)
})

test('the overlay is never let go while it still owes an answer', async () => {
  const { overlay, clock, ink } = ready({ silent: true })
  const first = draw(ink, 1)
  const [one] = overlay.started
  one.say({ ready: true })
  one.say({ id: one.commands()[0].id, ok: true })
  await first
  await clock.advance(IDLE_MS - 1_000)
  const second = draw(ink, 1)
  await clock.advance(5_000)
  assert.equal(one.exited, false)
  one.say('not JSON: something a library printed')
  one.say({ id: 999, ok: true })
  one.say({ id: one.commands()[1].id, ok: true })
  await second
  assert.equal(overlay.started.length, 1)
  await clock.advance(1 + IDLE_MS)
  assert.equal(one.commands().at(-1).cmd, 'quit')
})

test('clearing an empty screen starts nothing', async () => {
  const { overlay, call } = ready()
  assert.deepEqual((await call('screen_clear')).structuredContent, {})
  assert.equal(overlay.started.length, 0)
})

test('an overlay that does not start is one plain sentence, and the next call tries again', async () => {
  const { overlay, call, warned } = ready({ silent: true })
  const asked = call('screen_draw', { shapes: [{ ...BOX, text: 'secret words' }] })
  overlay.started[0].die(1, 'ScriptContainedMaliciousContent')
  const answer = await asked
  assert.equal(answer.isError, true)
  assert.equal(answer.content[0].text, CANNOT)
  assert.match(warned[0], /did not start \(exit 1: ScriptContainedMaliciousContent\)/)
  assert.ok(!warned.join().includes('secret words'))

  const again = call('cursor_show', { x: 1, y: 1 })
  const second = overlay.started[1]
  second.say({ ready: true })
  second.say({ id: second.commands()[0].id, ok: true })
  assert.deepEqual((await again).structuredContent, {})
})

test('an overlay that never answers is killed, and one that refuses is reported', async () => {
  const { overlay, clock, ink, call } = ready({ silent: true })
  const asked = call('screen_draw', { shapes: [BOX] })
  await clock.advance(REPLY_MS - 1)
  assert.equal(overlay.started[0].killed, false)
  await clock.advance(1)
  assert.equal((await asked).content[0].text, CANNOT)
  assert.equal(overlay.started[0].killed, true)

  const refused = call('screen_draw', { shapes: [BOX] })
  const second = overlay.started[1]
  second.say({ ready: true })
  second.say({ id: second.commands()[0].id, ok: false, error: 'RuntimeException' })
  assert.equal((await refused).isError, true)
  assert.equal(second.killed, false, 'one refusal does not lose what is already drawn')
  assert.deepEqual(ink.running(), { ready: true })
})

test('an overlay that dies is replaced on the next drawing', async () => {
  const { overlay, ink } = ready()
  await draw(ink)
  overlay.started[0].die(1)
  await settle()
  assert.equal(ink.running(), undefined)
  await draw(ink)
  assert.equal(overlay.started.length, 2)
})

test('close lets the overlay go and tells whoever was waiting', async () => {
  const { overlay, ink } = ready({ silent: true })
  const waiting = draw(ink)
  const turnedAway = assert.rejects(waiting, /closed/)
  ink.close()
  await turnedAway
  assert.equal(overlay.started[0].closed, true)
  assert.equal(overlay.started[0].commands().at(-1).cmd, 'quit')
  ink.close()
})

test('cursor_glide_steps', async () => {
  assert.equal(GLIDE_MS, 150)
  const path = glide([0, 100], [200, 0])
  assert.equal(path.length, GLIDE_MS / STEP_MS + 1)
  assert.equal((path.length - 1) * STEP_MS, 150, 'the glide takes 150 ms')
  assert.deepEqual(path[0], [0, 100])
  assert.deepEqual(path.at(-1), [200, 0])
  const strides = path.slice(1).map((spot, at) => spot[0] - path[at][0])
  assert.ok(strides.every((stride) => stride > 0), 'always onwards, never past')
  assert.ok(strides[0] < strides[4] && strides.at(-1) < strides[4], 'slow at both ends')
  for (let at = 1; at < path.length; at++) assert.ok(path[at][1] <= path[at - 1][1])
  assert.deepEqual(glide(undefined, [7, 8]), [[7, 8]])
  assert.deepEqual(glide([7, 8], [7, 8]), [[7, 8]])

  const { overlay, clock, ink } = ready()
  await ink.cursor({ x: 100, y: 100, label: 'Alexia' })
  await ink.cursor({ x: 400, y: 250, label: 'Alexia' })
  const [first, second] = overlay.started[0].commands()
  assert.deepEqual(first.path, [[100, 100]], 'with nowhere to come from it appears')
  assert.deepEqual(second.path, glide([100, 100], [400, 250]))
  // Where it was is remembered after the overlay has gone.
  await clock.advance(HIDE_MS + IDLE_MS)
  await ink.cursor({ x: 0, y: 0, label: 'Alexia' })
  assert.deepEqual(overlay.started[1].commands()[0].path, glide([400, 250], [0, 0]))
})

test('the bound capabilities are exactly what the manifest provides', async () => {
  const { default: manifest } = await import('../plugin.json', { with: { type: 'json' } })
  const plugin = fakePlugin()
  register(plugin, createInk({ backend: BACKEND, start: fakeOverlay().start }))
  const bound = [...plugin.tools.values()].flatMap((one) => one.config._meta['alexia/provides'])
  assert.deepEqual(bound, manifest.provides)
  for (const [name, { config }] of plugin.tools) {
    assert.equal(config._meta['alexia/provides'].length, 1, name)
    assert.deepEqual(config.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, name)
  }
})

test('where nothing can draw, no capability is bound and the tools say so', async () => {
  const plugin = fakePlugin()
  register(plugin, undefined)
  for (const [name, { config, handler }] of plugin.tools) {
    assert.deepEqual(config._meta, {}, name)
    const answer = await handler({ shapes: [BOX], x: 1, y: 1 }, {})
    assert.equal(answer.isError, true, name)
    assert.equal(answer.content[0].text, CANNOT)
  }
})

test('both backends run a constant script, with nothing drawn written into it', () => {
  const win = windows()
  assert.match(win.command, /powershell\.exe$/)
  assert.equal(win.args.at(-1), WINDOWS_SCRIPT)
  assert.ok(win.args.includes('-STA'))
  // TRANSPARENT | LAYERED | TOOLWINDOW | NOACTIVATE, so it takes no click and no focus.
  assert.equal(0x20 | 0x80000 | 0x80 | 0x08000000, 0x080800a0)
  assert.ok(WINDOWS_SCRIPT.includes('0x080800A0'))
  const mac = macos()
  assert.equal(mac.command, '/usr/bin/osascript')
  assert.equal(mac.args.at(-1), MAC_SCRIPT)
  assert.ok(MAC_SCRIPT.includes('setIgnoresMouseEvents(true)'))
  // The Mac script is JavaScript, so it can at least be parsed anywhere.
  assert.doesNotThrow(() => new Function(MAC_SCRIPT))
})

if (process.platform === 'win32') {
  slowTest('the Windows overlay script parses', () => {
    const { command } = windows()
    const check =
      '$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:ALEXIA_SCRIPT, [ref]$null, [ref]$errors); ' +
      'foreach ($e in $errors) { $e.Message }; exit $errors.Count'
    const run = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', check], {
      env: { ...process.env, ALEXIA_SCRIPT: WINDOWS_SCRIPT },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
  })
}

slowTest('over stdio the plugin serves its three tools and refuses a bad drawing', async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const child = spawn(process.execPath, ['index.js'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ALEXIA_PLUGIN_DIR: dir },
  })
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === undefined) waiting.get(message.id)?.(message)
  })
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}
`)
  let last = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      waiting.set(++last, resolve)
      child.once('exit', (code) => reject(new Error(`the plugin stopped (${code})`)))
      send({ id: last, method, params })
    })
  try {
    await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    send({ method: 'notifications/initialized' })
    const { tools } = (await ask('tools/list', {})).result
    assert.deepEqual(tools.map((tool) => tool.name), ['screen_draw', 'screen_clear', 'cursor_show'])
    const can = process.platform === 'win32' || process.platform === 'darwin'
    assert.deepEqual(
      tools.flatMap((tool) => tool._meta?.['alexia/provides'] ?? []),
      can ? ['screen.draw', 'screen.clear', 'cursor.show'] : [],
    )
    // None of these draws anything, so no overlay is started on the machine running the tests.
    const call = async (name, args) => (await ask('tools/call', { name, arguments: args })).result
    const refused = await call('screen_draw', { shapes: [{ kind: 'box', x: 1, y: 2 }] })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /needs w and h/)
    if (can) assert.deepEqual((await call('screen_clear', {})).structuredContent, {})
    // Core going away ends the plugin.
    const gone = new Promise((resolve) => child.once('exit', resolve))
    child.stdin.end()
    assert.equal(await gone, 0)
  } finally {
    child.kill()
  }
})

slowTest('a helper process is written lines, read by lines, and quits when its stdin ends', async () => {
  const heard = []
  const echo =
    "process.stdin.on('data', (d) => { for (const l of String(d).split('\\n')) if (l) console.log('got ' + l) });" +
    "process.stdin.on('end', () => { console.error('first'); console.error('last words'); process.exit(3) })"
  const helper = startProcess(process.execPath, ['-e', echo], { onLine: (line) => heard.push(line) })
  helper.send('one')
  helper.send('two')
  helper.close()
  helper.send('too late')
  assert.deepEqual(await helper.exit, { code: 3, said: 'last words' })
  assert.deepEqual(heard, ['got one', 'got two'])

  const missing = startProcess('no-such-program-anywhere', [], { onLine: () => {} })
  missing.send('anything')
  assert.equal((await missing.exit).code, null)
})

live()
