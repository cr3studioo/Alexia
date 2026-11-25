// SPDX-License-Identifier: AGPL-3.0-only
import { clipboardFor, MAX_TEXT_BYTES } from '../clip.js'
import { createHistory, MAX_ROWS, sha256 } from '../history.js'
import { createWatcher } from '../watch.js'
import { assert, test } from './harness.js'

/** The plugin's table, in memory, with the operators the history uses. */
function memory() {
  let rows = []
  let rowid = 0
  const matches = (row, where) =>
    Object.entries(where).every(([key, want]) => {
      if (want !== null && typeof want === 'object') {
        if ('lt' in want) return row[key] < want.lt
        if ('in' in want) return want.in.includes(row[key])
        throw new Error('operator not faked')
      }
      return row[key] === want
    })
  return {
    rows: () => rows,
    insert: async (_table, row) => (rows.push({ ...row, rowid: ++rowid }), rowid),
    select: async (_table, q = {}) => {
      let out = rows.filter((r) => matches(r, q.where ?? {}))
      for (const [key, dir] of [...(q.order ?? [])].reverse()) out = [...out].sort((a, b) => (dir === 'asc' ? 1 : -1) * (a[key] - b[key]))
      return out.slice(0, q.limit ?? out.length).map((r) => ({ ...r }))
    },
    update: async (_table, set, where) => {
      const hit = rows.filter((r) => matches(r, where))
      for (const r of hit) Object.assign(r, set)
      return hit.length
    },
    delete: async (_table, where) => {
      const before = rows.length
      rows = 'all' in where ? [] : rows.filter((r) => !matches(r, where))
      return before - rows.length
    },
    count: async () => rows.length,
  }
}

/** A runner that records every call and answers from a script. */
function runner(answer) {
  const calls = []
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input })
    return { code: 0, stdout: '', stderr: '', ...(await answer({ command, args, input: options.input })) }
  }
  return { run, calls }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const winLine = (o) => JSON.stringify({ kind: 'text', sensitive: false, text: '', ...o })

test('get_set_round_trip', async () => {
  for (const platform of ['win32', 'darwin']) {
    let held = ''
    const { run, calls } = runner(({ command, input, args }) => {
      if (platform === 'win32') {
        if (input !== undefined) {
          held = Buffer.from(input, 'base64').toString('utf8')
          return {}
        }
        return { stdout: winLine({ text: b64(held) }) }
      }
      if (command === 'pbcopy') {
        held = input
        return {}
      }
      if (command === 'pbpaste') return { stdout: held }
      assert.equal(command, 'osascript')
      assert.ok(args.includes('JavaScript'))
      return { stdout: JSON.stringify(['public.utf8-plain-text']) }
    })
    const clip = clipboardFor(platform, run)
    const text = 'héllo “wörld” 🙂\nline two'
    await clip.write(text)
    const seen = await clip.read()
    assert.deepEqual(seen, { kind: 'text', sensitive: false, text })
    assert.ok(calls.length >= 2, platform)
  }
})

test('sensitive_is_skipped_and_flagged', async () => {
  // Windows: the script reports the flag; the text is never in the answer.
  const win = clipboardFor('win32', runner(() => ({ stdout: winLine({ sensitive: true, text: b64('hunter2') }) })).run)
  assert.deepEqual(await win.read(), { kind: 'text', sensitive: true, text: undefined })

  // macOS: a concealed type means pbpaste is never even run.
  for (const type of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType']) {
    const { run, calls } = runner(({ command }) => ({
      stdout: command === 'osascript' ? JSON.stringify(['public.utf8-plain-text', type]) : 'hunter2',
    }))
    const seen = await clipboardFor('darwin', run).read()
    assert.deepEqual(seen, { kind: 'text', sensitive: true, text: undefined })
    assert.ok(!calls.some((c) => c.command === 'pbpaste'))
  }

  // And the watcher keeps it out of the history.
  const store = memory()
  const history = createHistory({ storage: store })
  const clip = { read: async () => ({ kind: 'text', sensitive: true, text: undefined }) }
  const watcher = createWatcher({ clip, history, settings: async () => ({ history: true, keep_days: '7' }) })
  assert.equal(await watcher.tick(), 'sensitive')
  assert.equal(store.rows().length, 0)
})

test('images and files report their kind without content', async () => {
  const win = clipboardFor('win32', runner(() => ({ stdout: winLine({ kind: 'image', text: b64('x') }) })).run)
  assert.deepEqual(await win.read(), { kind: 'image', sensitive: false, text: undefined })
  const mac = clipboardFor('darwin', runner(() => ({ stdout: JSON.stringify(['public.file-url']) })).run)
  assert.deepEqual(await mac.read(), { kind: 'files', sensitive: false, text: undefined })
})

test('history_dedupes_and_prunes', async () => {
  let clock = 1_000_000_000_000
  const DAY = 86_400_000
  const store = memory()
  const history = createHistory({ storage: store, now: () => clock })

  assert.equal(await history.record('first', '7'), true)
  clock += 1000
  assert.equal(await history.record('second', '7'), true)
  clock += 1000
  // The same text again does not add a row; it moves to the top.
  assert.equal(await history.record('first', '7'), true)
  assert.equal(store.rows().length, 2)
  assert.deepEqual((await history.list()).map((i) => i.text), ['first', 'second'])
  assert.equal(store.rows()[0].sha256, sha256('first'))

  // Too big, empty and blank text are not kept.
  assert.equal(await history.record('x'.repeat(MAX_TEXT_BYTES + 1), '7'), false)
  assert.equal(await history.record('', '7'), false)
  assert.equal(await history.record('   \n', '7'), false)
  assert.equal((await history.record('x'.repeat(MAX_TEXT_BYTES), '7')), true)
  assert.equal(store.rows().length, 3)

  // Older than keep_days goes; a shorter window takes more.
  clock += 2 * DAY
  await history.record('fresh', '7')
  assert.equal(store.rows().length, 4)
  clock += 1
  await history.record('fresher', '1')
  assert.deepEqual((await history.list()).map((i) => i.text), ['fresher', 'fresh'])

  // The cap: 500 rows at most, oldest first out.
  for (let n = 0; n < MAX_ROWS + 20; n++) {
    clock += 1
    await history.record(`row ${String(n)}`, '30')
  }
  assert.equal(store.rows().length, MAX_ROWS)
  const newest = await history.list({ limit: 1 })
  assert.equal(newest[0].text, `row ${String(MAX_ROWS + 19)}`)
  assert.ok(!store.rows().some((r) => r.text === 'row 0'))

  // Search ignores case, and clearing empties it.
  assert.equal((await history.list({ query: 'ROW 519' })).length, 1)
  await history.clear()
  assert.equal(store.rows().length, 0)
})

test('the watcher stores a copy once, however long it stays on the clipboard', async () => {
  const store = memory()
  const history = createHistory({ storage: store })
  let now = { kind: 'text', sensitive: false, text: 'one' }
  const watcher = createWatcher({ clip: { read: async () => now }, history, settings: async () => ({ history: true, keep_days: '7' }) })
  assert.equal(await watcher.tick(), 'stored')
  assert.equal(await watcher.tick(), 'same')
  now = { kind: 'image', sensitive: false }
  assert.equal(await watcher.tick(), 'not-text')
  now = { kind: 'text', sensitive: false, text: 'two' }
  assert.equal(await watcher.tick(), 'stored')
  assert.equal(store.rows().length, 2)
})

test('history_off_stores_nothing', async () => {
  const store = memory()
  const history = createHistory({ storage: store })
  let looked = 0
  const clip = {
    read: async () => {
      looked++
      return { kind: 'text', sensitive: false, text: 'secret plans' }
    },
  }
  const watcher = createWatcher({ clip, history, settings: async () => ({ history: false, keep_days: '7' }) })
  assert.equal(await watcher.tick(), 'off')
  assert.equal(store.rows().length, 0)
  assert.equal(looked, 0, 'with history off the clipboard is not even read')
})

test('long_text_goes_by_stdin', async () => {
  const long = 'a "quoted" line with $dollars and `ticks`\n'.repeat(5000) // ~200 KB, far past an argv limit
  for (const platform of ['win32', 'darwin']) {
    const { run, calls } = runner(() => ({}))
    await clipboardFor(platform, run).write(long)
    assert.equal(calls.length, 1)
    const [call] = calls
    const argv = call.args.join('\n')
    assert.ok(!argv.includes('quoted'), 'the text is not in argv')
    assert.ok(argv.length < 5000, 'argv stays small')
    assert.ok(call.input !== undefined)
    const sent = platform === 'win32' ? Buffer.from(call.input, 'base64').toString('utf8') : call.input
    assert.equal(sent, long)
  }
})

test('a platform with no backend has no clipboard', () => {
  assert.equal(clipboardFor('linux', runner(() => ({})).run), undefined)
})

test('a failing helper is an error that does not quote the clipboard', async () => {
  const { run } = runner(() => ({ code: 1, stderr: 'boom happened\n' }))
  await assert.rejects(clipboardFor('darwin', run).write('private words'), (error) => /Setting the clipboard failed: boom happened/.test(error.message) && !error.message.includes('private'))
})
