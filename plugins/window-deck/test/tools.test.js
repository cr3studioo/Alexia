// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { runProgram } from '../backend.js'
import { createDeck } from '../deck.js'
import { registerTools } from '../tools.js'
import { explain, SCRIPT, windowsBackend } from '../windows.js'
import { assert, fakeDesktop, fakeStorage, row, slowTest, test } from './harness.js'

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))

/** The tools as the plugin registers them, by name. */
function register(deck) {
  const tools = new Map()
  registerTools({ tool: (name, config, handler) => tools.set(name, { config, handler }) }, deck)
  return tools
}

function ready(options) {
  const desk = fakeDesktop(options)
  const deck = createDeck({ backend: windowsBackend({ run: desk.run }), storage: fakeStorage() })
  return { desk, tools: register(deck) }
}

test('every capability the manifest provides is bound to one tool, with its annotations', () => {
  const { tools } = ready()
  const bound = [...tools.values()].flatMap((one) => one.config._meta['alexia/provides'])
  assert.deepEqual(bound, manifest.provides)
  const hints = (name) => tools.get(name).config.annotations
  assert.deepEqual(hints('window_list'), { readOnlyHint: true, openWorldHint: false })
  for (const name of ['window_arrange', 'window_layout_save', 'window_layout_apply']) {
    assert.deepEqual(hints(name), { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, name)
  }
  assert.deepEqual(hints('app_quit'), { readOnlyHint: false, destructiveHint: true, openWorldHint: false })
})

test('the layouts table is declared in the namespace the plugin owns', () => {
  assert.deepEqual(manifest.storage, { namespace: manifest.id, tables: ['layouts'] })
})

test('the tools answer in the shapes the capability contracts give', async () => {
  const { tools } = ready({ windows: [row('1', 'notepad', 'notes', 0, 0, 800, 600)] })
  const context = { mcpReq: {} }
  const listed = await tools.get('window_list').handler(context)
  assert.deepEqual(Object.keys(listed.structuredContent), ['windows', 'monitors'])
  assert.match(listed.content[0].text, /id=1 \| notepad \| “notes” \| 800×600 at 0,0 on monitor 1/)
  const moved = await tools.get('window_arrange').handler({ id: '1', do: 'move', x: 5 }, context)
  assert.deepEqual(moved.structuredContent, {})
  const saved = await tools.get('window_layout_save').handler({ name: 'study' }, context)
  assert.deepEqual(saved.structuredContent, { saved: 'study', windows: 1 })
  const applied = await tools.get('window_layout_apply').handler({ name: 'study' }, context)
  assert.deepEqual(applied.structuredContent, { placed: 1, missing: [] })
  const quit = await tools.get('app_quit').handler({ app: 'notepad' }, context)
  assert.deepEqual(quit.structuredContent, {})
  assert.equal(quit.content[0].text, 'notepad has quit.')
  const wrong = await tools.get('window_arrange').handler({ id: '404', do: 'close' }, context)
  assert.equal(wrong.isError, true)
})

test('on a computer it cannot work on, the tools say so and claim nothing', async () => {
  const tools = register(undefined)
  for (const [name, { config, handler }] of tools) {
    assert.equal(config._meta, undefined, name)
    const answer = await handler({}, {})
    assert.equal(answer.isError, true, name)
    assert.match(answer.content[0].text, /not available/)
  }
})

test('nothing a caller says becomes part of the script', async () => {
  const hostile = `x'; Remove-Item -Recurse C:; ‘’ $(calc) \`n "@\n'@`
  const { desk, tools } = ready({ windows: [row('1', hostile, hostile, 0, 0, 800, 600)] })
  await tools.get('window_layout_save').handler({ name: hostile }, {})
  await tools.get('app_quit').handler({ app: hostile }, {})
  await tools.get('window_layout_apply').handler({ name: hostile, open_missing: true }, {})
  assert.ok(desk.scripts.length >= 3)
  for (const script of desk.scripts) assert.equal(script, SCRIPT)
})

test('the antivirus block is said as a sentence', () => {
  assert.match(explain('x\nFullyQualifiedErrorId : ScriptContainedMaliciousContent'), /antivirus/)
  assert.equal(explain('Stop-Process : denied\nat line 1'), 'Stop-Process : denied')
})

slowTest('the runner keeps a character split across two writes, and reports a failure by its first line', async () => {
  // “é” is two bytes; they are written one at a time with a pause between.
  const split = 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 200)'
  assert.equal(await runProgram(process.execPath, ['-e', split]), 'é')
  const fails = 'process.stderr.write("It broke\\nand more"); process.exit(3)'
  await assert.rejects(runProgram(process.execPath, ['-e', fails]), { message: 'It broke' })
})

slowTest('the runner stops a helper that hangs', async () => {
  await assert.rejects(runProgram(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1500 }), /too long/)
})
