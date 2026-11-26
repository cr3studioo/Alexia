// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inside } from '../files.js'
import { runHelper, runPowerShell } from '../run.js'
import {
  createFinder,
  macBackend,
  mdfindArgs,
  pathOfItemUrl,
  systemIndexQueries,
  windowsBackend,
  words,
} from '../search.js'
import { createTidy, DAY_MS, hiddenIn, moveWithoutReplacing, PLAN_LIFE_MS, rule } from '../tidy.js'
import { assert, memoryStorage, test } from './harness.js'

const HOUR_MS = 60 * 60 * 1000

/** A fresh temporary area, with its real path, removed afterwards. */
async function area(run) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'finder-')))
  try {
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Write a file and say when it was last changed. */
async function put(path, { text = basename(path), changed } = {}) {
  await writeFile(path, text)
  if (changed !== undefined) await utimes(path, new Date(changed), new Date(changed))
  return path
}

/**
 * A tidier over a folder `Downloads` inside the one opened folder, with a clock the test holds.
 * The clock starts 40 days on, so every file made now counts as 40 days old unless said otherwise.
 */
async function setup(base, { hidden = async () => new Set(), open = true } = {}) {
  const root = join(base, 'opened')
  const folder = join(root, 'Downloads')
  await mkdir(folder, { recursive: true })
  const store = memoryStorage()
  const clock = { now: Date.now() + 40 * DAY_MS }
  const opened = { list: open ? [pathToFileURL(root).href] : [] }
  const tidy = createTidy({ roots: async () => opened.list, store, hidden, now: () => clock.now })
  /** Make a file in the folder that was last changed `days` before the test's clock. */
  const make = (name, days = 5, text) => put(join(folder, name), { changed: clock.now - days * DAY_MS, text })
  return { root, folder, store, clock, opened, tidy, make }
}

/** Every file under `folder`, as relative paths with forward slashes, sorted. */
async function tree(folder) {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
}

const refused = (pattern) => ({ message: pattern })

// ---- search ----

/** The SQL with every string literal taken out, and the literals, read the way SQL reads them. */
function takeApart(sql) {
  const literals = []
  const skeleton = sql.replace(/'((?:[^']|'')*)'/g, (_, body) => {
    literals.push(body.replaceAll("''", "'"))
    return '?'
  })
  assert.ok(!skeleton.includes("'"), `an unclosed quote in: ${sql}`)
  return { skeleton, literals }
}

test('search_query_is_escaped', () => {
  const hostile = [
    `lease' OR '1'='1`,
    `"lease") OR CONTAINS(*, "password`,
    `x'; DROP TABLE SystemIndex; --`,
    `lease') AND SCOPE='file:C:/`,
    `100% *.* [a-z] \\ ""* NEAR() ’quoted’ \u0000 \n; $(calc) \`whoami\``,
  ]
  const folder = "C:\\Users\\o'brien\\Mine') OR SCOPE='file:"
  for (const query of hostile) {
    const terms = words(query)
    for (const term of terms) assert.match(term, /^[\p{L}\p{M}\p{N}'._-]+$/u, term)
    const built = systemIndexQueries({ words: terms, kind: 'document', scopes: [folder], after: Date.UTC(2026, 2, 1) })
    // The same shape as for harmless words, as many of them: nothing a query holds becomes SQL.
    const harmless = systemIndexQueries({
      words: terms.map((_, n) => `w${String(n)}`),
      kind: 'document',
      scopes: ['C:\\plain'],
      after: Date.UTC(2026, 2, 1),
    })
    for (const [at, sql] of built.entries()) {
      const { skeleton, literals } = takeApart(sql)
      assert.equal(skeleton, takeApart(harmless[at]).skeleton)
      // The folder arrives whole, as one value.
      assert.equal(literals[0], "file:C:/Users/o'brien/Mine') OR SCOPE='file:")
      // A search phrase is one quoted term: no quote of its own can end it.
      for (const phrase of literals.filter((one) => one.startsWith('"'))) assert.match(phrase, /^"[^"]+\*"$/)
    }
  }
  const [contains, freetext] = systemIndexQueries({ words: words("o'brien lease"), scopes: ['C:\\a'], after: Date.UTC(2026, 2, 1) })
  assert.equal(
    contains,
    `SELECT TOP 200 System.ItemUrl FROM SystemIndex WHERE (SCOPE='file:C:/a') AND System.DateModified >= '2026-03-01 00:00:00' ` +
      `AND CONTAINS(*, '"o''brien*"') AND CONTAINS(*, '"lease*"') ORDER BY System.DateModified DESC`,
  )
  assert.match(freetext, /AND FREETEXT\(\*, 'o''brien lease'\) ORDER BY System\.Search\.Rank DESC$/)
  // Everywhere is every file the index has, and nothing that is not a file (mail, history).
  assert.match(systemIndexQueries({ words: ['a'], scopes: null })[0], /WHERE \(SCOPE='file:'\) AND/)
  assert.match(systemIndexQueries({ words: ['a'], kind: 'folder', scopes: null })[0], /System\.ItemType = 'Directory'/)
  assert.throws(() => systemIndexQueries({ words: ['a'], scopes: [] }))
})

test('words keeps letters of any language and bounds how much is asked', () => {
  assert.deepEqual(words('Smlouva o nájmu – jaro_2026.pdf'), ['Smlouva', 'o', 'nájmu', 'jaro_2026.pdf'])
  assert.deepEqual(words(' "\'()*% '), [])
  assert.equal(words(Array.from({ length: 50 }, (_, n) => `w${String(n)}`).join(' ')).length, 12)
  assert.equal(words('a'.repeat(500))[0].length, 64)
})

test('mdfind_args', () => {
  assert.deepEqual(mdfindArgs({ words: ['lease', 'flat'], folder: '/home folder/Papers', after: Date.UTC(2026, 2, 1) }), [
    '-0',
    '-onlyin',
    '/home folder/Papers',
    '(kMDItemFSName == "*lease*"cd || kMDItemTextContent == "lease*"cd) && ' +
      '(kMDItemFSName == "*flat*"cd || kMDItemTextContent == "flat*"cd) && ' +
      'kMDItemFSContentChangeDate >= $time.iso(2026-03-01T00:00:00Z)',
  ])
  const everywhere = mdfindArgs({ words: ['cat'], kind: 'audio', folder: null })
  assert.equal(everywhere.length, 2)
  assert.ok(!everywhere.includes('-onlyin'))
  assert.match(everywhere[1], /&& \(kMDItemFSName == "\*\.mp3"c \|\| kMDItemFSName == "\*\.m4a"c/)
  assert.match(mdfindArgs({ words: ['cat'], kind: 'folder', folder: null })[1], /kMDItemContentType == "public\.folder"$/)
  // Even a word that skipped `words` cannot close its string.
  assert.ok(mdfindArgs({ words: ['a" || kMDItemFSName == "*'], folder: null })[1].startsWith('(kMDItemFSName == "*a || kMDItemFSName == *"cd'))
})

test('the mac search runs once for each folder and drops a half path', async () => {
  const runs = []
  const find = macBackend({
    run: async (command, args) => {
      runs.push([command, args[2]])
      return { code: 0, out: Buffer.from(`${args[2]}/a\0${args[2]}/b c\0${args[2]}/hal`), cut: false }
    },
  })
  assert.deepEqual(await find({ words: ['a'], scopes: ['/one', '/two'] }), ['/one/a', '/one/b c', '/two/a', '/two/b c'])
  assert.deepEqual(runs, [
    ['/usr/bin/mdfind', '/one'],
    ['/usr/bin/mdfind', '/two'],
  ])
  const broken = macBackend({ run: async () => ({ code: 1, out: Buffer.alloc(0), cut: false }) })
  await assert.rejects(broken({ words: ['a'], scopes: null }), refused(/did not answer/))
})

test('the windows search sends the queries on stdin and reads paths back', async () => {
  let sent
  const b64 = (text) => Buffer.from(text).toString('base64')
  const find = windowsBackend({
    run: async (command, args, { input }) => {
      sent = { command, args, input }
      const out = [b64('file:C:/Users/x/Nájem (1).pdf'), b64('mapi://mail/1'), 'done', ''].join('\r\n')
      return { code: 0, out: Buffer.from(out), cut: false }
    },
  })
  assert.deepEqual(await find({ words: ['secretword'], scopes: ['C:\\Users\\x'] }), ['C:\\Users\\x\\Nájem (1).pdf'])
  assert.equal(sent.command, 'powershell.exe')
  // Nothing searched for is on the command line, where another program could read it.
  assert.ok(!sent.args.join(' ').includes('secretword'))
  assert.match(Buffer.from(sent.input, 'base64').toString(), /secretword/)
  assert.equal(pathOfItemUrl('mapi://x'), undefined)
  for (const reply of [{ code: 1, out: Buffer.from('') }, { code: 0, out: Buffer.from(b64('file:C:/a')) }, { code: null, out: Buffer.from('done') }]) {
    const failing = windowsBackend({ run: async () => reply })
    await assert.rejects(failing({ words: ['a'], scopes: null }), refused(/did not answer/))
  }
})

test('results_outside_roots_dropped', async () => {
  await area(async (base) => {
    const root = join(base, 'work')
    const beside = join(base, 'work-notes')
    for (const dir of [root, join(root, 'sub'), join(root, '..cache'), beside]) await mkdir(dir)
    const at = Date.UTC(2026, 3, 1)
    const kept = await put(join(root, 'sub', 'lease.pdf'), { changed: at + 3000 })
    const dotted = await put(join(root, '..cache', 'lease.txt'), { changed: at + 2000 })
    const folder = join(root, 'sub')
    await utimes(folder, new Date(at), new Date(at))
    const outside = await put(join(beside, 'lease.pdf'), { changed: at + 5000 })
    // A way out through a link inside the root (a junction, which any Windows account may make).
    await symlink(beside, join(root, 'door'), 'junction')
    const index = [kept, outside, join(root, '..', 'work-notes', 'lease.pdf'), join(root, 'door', 'lease.pdf'), dotted, folder, join(root, 'gone.pdf'), 'relative.pdf', kept]
    let asked
    const finder = createFinder({
      roots: async () => [pathToFileURL(root).href],
      find: async (query) => {
        asked = query
        return index
      },
    })
    const { items } = await finder.search({ query: 'lease' })
    assert.deepEqual(
      items.map((item) => item.path),
      [kept, dotted, folder],
    )
    assert.deepEqual(items[0], { path: kept, name: 'lease.pdf', modified: at + 3000, size: 'lease.pdf'.length })
    assert.deepEqual(asked.scopes, [root])

    // The other filters hold whatever the index says.
    const only = async (args) => (await finder.search({ query: 'lease', ...args })).items.map((item) => item.path)
    assert.deepEqual(await only({ kind: 'document' }), [kept, dotted])
    assert.deepEqual(await only({ kind: 'folder' }), [folder])
    assert.deepEqual(await only({ modified_after: new Date(at + 2500).toISOString() }), [kept])
    assert.deepEqual(await only({ limit: 1 }), [kept])
    // A folder narrows the search and its results.
    assert.deepEqual(await only({ folder: join(root, 'sub') }), [kept, folder])
    assert.deepEqual(asked.scopes, [folder])
    await assert.rejects(finder.search({ query: 'lease', folder: beside }), refused(/outside the folders/))
    await assert.rejects(finder.search({ query: 'lease', folder: join(root, 'door') }), refused(/outside the folders/))

    const closed = createFinder({ roots: async () => [], find: async () => index })
    await assert.rejects(closed.search({ query: 'lease' }), refused(/No folder has been opened/))
    const failing = createFinder({ roots: async () => Promise.reject(new Error('no roots')), find: async () => index })
    await assert.rejects(failing.search({ query: 'lease' }), refused(/No folder has been opened/))

    // Only when the scope is Everywhere is nothing outside the roots dropped.
    const everywhere = createFinder({ roots: async () => [], find: async () => [outside, kept], everywhere: async () => true })
    assert.deepEqual(
      (await everywhere.search({ query: 'lease' })).items.map((item) => item.path),
      [outside, kept],
    )
  })
})

test('a search with bad arguments is refused before the index is asked', async () => {
  const finder = createFinder({ roots: async () => [tmpdir()], find: async () => assert.fail('the index was asked') })
  for (const [args, pattern] of [
    [{}, /what to look for/],
    [{ query: ' "*" ' }, /at least one word/],
    [{ query: 'a', kind: 'program' }, /kind must be one of/],
    [{ query: 'a', limit: 51 }, /1 to 50/],
    [{ query: 'a', limit: 0 }, /1 to 50/],
    [{ query: 'a', modified_after: 'last spring' }, /year-month-day/],
    [{ query: 'a', modified_after: '2026-13-01' }, /year-month-day/],
    [{ query: 'a', folder: 'Documents' }, /full path/],
  ]) {
    await assert.rejects(finder.search(args), refused(pattern), JSON.stringify(args))
  }
})

test('a helper that hangs or says too much is stopped', { timeout: 60_000 }, async () => {
  const hung = await runHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 })
  assert.equal(hung.code, null)
  const loud = await runHelper(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000)'], {
    maxBytes: 100,
    timeoutMs: 30_000,
  })
  assert.equal(loud.cut, true)
  assert.equal(loud.out.length, 100)
  assert.equal((await runHelper('no-such-program-here', [])).code, null)
  const stop = new AbortController()
  const cancelled = runHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: stop.signal })
  stop.abort()
  assert.equal((await cancelled).code, null)
})

// ---- tidy ----

test('the rules: installers by age, three types, nothing young', () => {
  const into = (name, days) => rule(name, days * DAY_MS)?.into ?? null
  assert.equal(into('setup.EXE', 31), 'Old installers')
  assert.equal(into('app.dmg', 45), 'Old installers')
  assert.equal(into('setup.msi', 29), null)
  assert.equal(into('lease.PDF', 2), 'Documents')
  assert.equal(into('cat.jpeg', 2), 'Images')
  assert.equal(into('photos.tar.gz', 2), 'Archives')
  assert.equal(into('lease.pdf', 0.9), null)
  for (const name of ['film.mp4', 'server.key', 'notes', 'script.js', 'page.crdownload']) assert.equal(into(name, 90), null, name)
})

test('plan_is_deterministic', async () => {
  await area(async (base) => {
    const t = await setup(base)
    for (const name of ['zebra.png', 'lease.pdf', 'Backup.zip', 'film.mp4']) await t.make(name)
    await t.make('old-setup.exe', 35)
    await t.make('new-setup.exe', 10)
    // Names already taken in the subfolders: the plan goes round them, the same way each time.
    await mkdir(join(t.folder, 'Documents'))
    await put(join(t.folder, 'Documents', 'lease.pdf'))
    await put(join(t.folder, 'Documents', 'lease (2).pdf'))
    await mkdir(join(t.folder, 'Archives'))
    await put(join(t.folder, 'Archives', 'Backup.zip'))
    const before = await tree(t.folder)

    const first = await t.tidy.propose(t.folder)
    const second = await t.tidy.propose(t.folder)
    assert.deepEqual(second.moves, first.moves)
    assert.notEqual(second.plan_id, first.plan_id)
    const at = (...parts) => join(t.folder, ...parts)
    assert.deepEqual(first.moves, [
      { from: at('Backup.zip'), to: at('Archives', 'Backup (2).zip'), why: 'An archive' },
      { from: at('lease.pdf'), to: at('Documents', 'lease (3).pdf'), why: 'A document' },
      { from: at('old-setup.exe'), to: at('Old installers', 'old-setup.exe'), why: 'An installer older than 30 days' },
      { from: at('zebra.png'), to: at('Images', 'zebra.png'), why: 'An image' },
    ])
    // Proposing is only proposing.
    assert.deepEqual(await tree(t.folder), before)
    assert.ok(!existsSync(at('Images')))
  })
})

test('apply_only_known_plan', async () => {
  await area(async (base) => {
    const t = await setup(base)
    await t.make('lease.pdf')
    const other = join(t.root, 'Other')
    await mkdir(other)
    const nothing = async () => assert.deepEqual(await tree(t.folder), ['lease.pdf'])

    await assert.rejects(t.tidy.apply(t.folder, 'deadbeef'), refused(/no such plan/))
    const plan = await t.tidy.propose(t.folder)
    await assert.rejects(t.tidy.apply(t.folder, `${plan.plan_id}x`), refused(/no such plan/))
    await assert.rejects(t.tidy.apply(t.folder, ''), refused(/no such plan/))
    await assert.rejects(t.tidy.apply(other, plan.plan_id), refused(/another folder/))
    await nothing()

    t.clock.now += PLAN_LIFE_MS + 1
    await assert.rejects(t.tidy.apply(t.folder, plan.plan_id), refused(/more than an hour old/))
    await nothing()

    const fresh = await t.tidy.propose(t.folder)
    // The expired plan was dropped when the next one was made.
    assert.deepEqual(
      t.store.tables.plans.map((row) => row.plan_id),
      [fresh.plan_id],
    )
    t.clock.now += PLAN_LIFE_MS
    t.opened.list = []
    await assert.rejects(t.tidy.apply(t.folder, fresh.plan_id), refused(/No folder has been opened/))
    t.opened.list = [pathToFileURL(other).href]
    await assert.rejects(t.tidy.apply(t.folder, fresh.plan_id), refused(/outside the folders/))
    await nothing()
    t.opened.list = [pathToFileURL(t.root).href]
    // Two at once: one carries it out, the other finds it done.
    const both = await Promise.allSettled([t.tidy.apply(t.folder, fresh.plan_id), t.tidy.apply(t.folder, fresh.plan_id)])
    assert.deepEqual(both[0].value, { moved: 1, skipped: 0 })
    assert.match(both[1].reason.message, /already carried out/)
    assert.deepEqual(await tree(t.folder), ['Documents/lease.pdf'])
  })
})

test('apply moves only what was proposed, as it was proposed, and replaces nothing', async () => {
  await area(async (base) => {
    const hidden = new Set()
    const t = await setup(base, { hidden: async () => hidden })
    for (const name of ['changed.pdf', 'gone.pdf', 'taken.pdf', 'turned-hidden.pdf', 'fine.pdf', 'pic.png', 'pack.zip']) await t.make(name)
    const plan = await t.tidy.propose(t.folder)
    assert.equal(plan.moves.length, 7)

    await t.make('changed.pdf', 3, 'a longer text than before')
    await rm(join(t.folder, 'gone.pdf'))
    await mkdir(join(t.folder, 'Documents'))
    await put(join(t.folder, 'Documents', 'taken.pdf'), { text: 'somebody else' })
    hidden.add('turned-hidden.pdf')
    // A file where a subfolder should be, and a link out of the folder where another should be.
    await put(join(t.folder, 'Archives'))
    const elsewhere = join(base, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, join(t.folder, 'Images'), 'junction')
    // Something that arrived after the plan stays out of it.
    await t.make('late.pdf')

    assert.deepEqual(await t.tidy.apply(t.folder, plan.plan_id), { moved: 1, skipped: 6 })
    assert.deepEqual(await readdir(elsewhere), [])
    assert.equal(await readFile(join(t.folder, 'Documents', 'taken.pdf'), 'utf8'), 'somebody else')
    assert.equal(await readFile(join(t.folder, 'taken.pdf'), 'utf8'), 'taken.pdf')
    for (const stays of ['changed.pdf', 'turned-hidden.pdf', 'late.pdf', 'pic.png', 'pack.zip']) assert.ok(existsSync(join(t.folder, stays)), stays)
    assert.ok(existsSync(join(t.folder, 'Documents', 'fine.pdf')))
    // Only the move that happened is in the log.
    assert.deepEqual(
      t.store.tables.moves.map((row) => [basename(row.src), row.state]),
      [['fine.pdf', 'moved']],
    )
    // A new plan goes round the link and the file in the way.
    assert.deepEqual(
      (await t.tidy.propose(t.folder)).moves.map((move) => basename(move.from)),
      ['changed.pdf', 'late.pdf', 'taken.pdf'],
    )
  })
})

test('a move never replaces a file', async () => {
  await area(async (base) => {
    const from = await put(join(base, 'a'), { text: 'a' })
    const to = await put(join(base, 'b'), { text: 'b' })
    assert.equal(await moveWithoutReplacing(from, to), false)
    assert.equal(await readFile(to, 'utf8'), 'b')
    assert.equal(await readFile(from, 'utf8'), 'a')
    assert.equal(await moveWithoutReplacing(join(base, 'missing'), join(base, 'c')), false)
    // The name taken for a move that failed is given back.
    assert.ok(!existsSync(join(base, 'c')))
    assert.equal(await moveWithoutReplacing(from, join(base, 'c')), true)
    assert.equal(await readFile(join(base, 'c'), 'utf8'), 'a')
  })
})

test('undo_restores', async () => {
  await area(async (base) => {
    const t = await setup(base)
    await t.make('lease.pdf', 5, 'lease')
    await t.make('cat.png', 5, 'cat')
    await t.make('setup.exe', 40, 'setup')
    const before = await tree(t.folder)
    const plan = await t.tidy.propose(t.folder)
    await assert.rejects(t.tidy.undo(plan.plan_id), refused(/nothing to undo/))
    assert.deepEqual(await t.tidy.apply(t.folder, plan.plan_id), { moved: 3, skipped: 0 })
    assert.deepEqual(await tree(t.folder), ['Documents/lease.pdf', 'Images/cat.png', 'Old installers/setup.exe'])

    // The log is what undo goes by, long after the plan could no longer be carried out.
    t.clock.now += 10 * DAY_MS
    assert.deepEqual(await t.tidy.undo(plan.plan_id), { moved: 3, skipped: 0 })
    assert.deepEqual(await tree(t.folder), before)
    assert.equal(await readFile(join(t.folder, 'lease.pdf'), 'utf8'), 'lease')
    await assert.rejects(t.tidy.undo(plan.plan_id), refused(/nothing to undo/))
    await assert.rejects(t.tidy.undo('deadbeef'), refused(/nothing to undo/))
    await assert.rejects(t.tidy.apply(t.folder, plan.plan_id), refused(/already carried out|no such plan|more than an hour/))
  })
})

test('undo leaves what it did not move and what has no way back, and can be tried again', async () => {
  await area(async (base) => {
    const t = await setup(base)
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) await t.make(name, 5, name)
    const plan = await t.tidy.propose(t.folder)
    await t.tidy.apply(t.folder, plan.plan_id)
    const moved = (name) => join(t.folder, 'Documents', name)
    // a: its old name is taken. b: another file has taken its place. c: deleted.
    await put(join(t.folder, 'a.pdf'), { text: 'new a' })
    await rename(moved('b.pdf'), join(base, 'kept-b'))
    await put(moved('b.pdf'), { text: 'a different b altogether' })
    await rm(moved('c.pdf'))

    assert.deepEqual(await t.tidy.undo(plan.plan_id), { moved: 1, skipped: 3 })
    assert.equal(await readFile(join(t.folder, 'a.pdf'), 'utf8'), 'new a')
    assert.equal(await readFile(moved('a.pdf'), 'utf8'), 'a.pdf')
    assert.ok(!existsSync(join(t.folder, 'b.pdf')))
    assert.equal(await readFile(join(t.folder, 'd.pdf'), 'utf8'), 'd.pdf')

    await rm(join(t.folder, 'a.pdf'))
    assert.deepEqual(await t.tidy.undo(plan.plan_id), { moved: 1, skipped: 2 })
    assert.equal(await readFile(join(t.folder, 'a.pdf'), 'utf8'), 'a.pdf')

    // Once the folder is no longer open, nothing in it is moved.
    t.opened.list = []
    assert.deepEqual(await t.tidy.undo(plan.plan_id), { moved: 0, skipped: 2 })
  })
})

test('a move that stopped half way can still be undone', async () => {
  await area(async (base) => {
    const t = await setup(base)
    await t.make('lease.pdf')
    const plan = await t.tidy.propose(t.folder)
    // Storage fails after the file moved: the row written beforehand stays.
    const update = t.store.update
    t.store.update = async (name, ...rest) => {
      if (name === 'moves') throw new Error('storage is gone')
      return update(name, ...rest)
    }
    assert.deepEqual(await t.tidy.apply(t.folder, plan.plan_id), { moved: 1, skipped: 0 })
    assert.deepEqual(await tree(t.folder), ['Documents/lease.pdf'])
    assert.deepEqual(
      t.store.tables.moves.map((row) => row.state),
      ['moving'],
    )
    t.store.update = update
    assert.deepEqual(await t.tidy.undo(plan.plan_id), { moved: 1, skipped: 0 })
    assert.deepEqual(await tree(t.folder), ['lease.pdf'])
  })
})

test('young_files_untouched', async () => {
  await area(async (base) => {
    const t = await setup(base)
    const make = (name, age) => put(join(t.folder, name), { changed: t.clock.now - age })
    await make('this-hour.pdf', HOUR_MS)
    await make('almost-a-day.png', DAY_MS - 60_000)
    await make('a-day.zip', DAY_MS + 60_000)
    await make('recent-setup.exe', 30 * DAY_MS - 60_000)
    const plan = await t.tidy.propose(t.folder)
    assert.deepEqual(
      plan.moves.map((move) => basename(move.from)),
      ['a-day.zip'],
    )

    // A file that only just arrived, carrying an old writing time (a copy, an unpacked archive).
    t.clock.now = Date.now() + HOUR_MS
    const arrived = await put(join(t.folder, 'copied.pdf'), { changed: Date.UTC(2020, 0, 1) })
    const names = (await t.tidy.propose(t.folder)).moves.map((move) => basename(move.from))
    // macOS moves the creation time back with the writing time; there it does count as old.
    if (process.platform !== 'darwin') assert.ok(!names.includes(basename(arrived)), names.join())

    // One written again between the plan and its approval stays.
    t.clock.now = Date.now() + 40 * DAY_MS
    await make('draft.pdf', 3 * DAY_MS)
    const next = await t.tidy.propose(t.folder)
    await make('draft.pdf', HOUR_MS)
    await t.tidy.apply(t.folder, next.plan_id)
    assert.ok(existsSync(join(t.folder, 'draft.pdf')))
  })
})

test('folders, hidden files and links are never touched', async () => {
  await area(async (base) => {
    const t = await setup(base, { hidden: async () => new Set(['secret.pdf']) })
    for (const name of ['secret.pdf', '.hidden.pdf', '~$lease.docx', 'seen.pdf']) await t.make(name)
    // Folders whose names look like files to be moved, with files of their own.
    for (const name of ['report.pdf.d', 'album.zip', 'Projects']) await mkdir(join(t.folder, name))
    await put(join(t.folder, 'Projects', 'inside.pdf'), { changed: t.clock.now - 5 * DAY_MS })
    await symlink(join(t.folder, 'Projects'), join(t.folder, 'shortcut.pdf'), 'junction')
    assert.deepEqual(
      (await t.tidy.propose(t.folder)).moves.map((move) => basename(move.from)),
      ['seen.pdf'],
    )
    // Tidying a subfolder of the kind does not nest another inside it.
    const documents = join(t.folder, 'Documents')
    await mkdir(documents)
    await put(join(documents, 'old.pdf'), { changed: t.clock.now - 5 * DAY_MS })
    assert.deepEqual((await t.tidy.propose(documents)).moves, [])
  })
})

test('a folder that cannot be checked or is not allowed is left alone', async () => {
  await area(async (base) => {
    const blind = await setup(base, { hidden: (folder) => hiddenIn(folder, { platform: 'win32', run: async () => ({ code: 1, out: Buffer.alloc(0) }) }) })
    await blind.make('lease.pdf')
    await assert.rejects(blind.tidy.propose(blind.folder), refused(/which files in that folder are hidden/))
    await assert.rejects(blind.tidy.propose(base), refused(/outside the folders/))
    await assert.rejects(blind.tidy.propose(join(blind.folder, '..', '..')), refused(/outside the folders/))
    await assert.rejects(blind.tidy.propose(join(blind.folder, 'lease.pdf')), refused(/not a folder/))
    await assert.rejects(blind.tidy.propose(join(blind.folder, 'missing')), refused(/not there/))
    await assert.rejects(blind.tidy.propose('Downloads'), refused(/full path/))
    const door = join(blind.root, 'door')
    await symlink(base, door, 'junction')
    await assert.rejects(blind.tidy.propose(door), refused(/outside the folders/))
    const mac = await hiddenIn('/f', { platform: 'darwin', run: async () => ({ code: 0, out: Buffer.from('/f/a b\0/f/c\0'), cut: false }) })
    assert.deepEqual([...mac], ['a b', 'c'])
  })
})

const marksHidden = process.platform === 'win32' || process.platform === 'darwin'

test('the system tells which files are hidden', { timeout: 60_000, skip: !marksHidden }, async () => {
  await area(async (base) => {
    const odd = join(base, "o'brien’s [stuff] $(x)")
    await mkdir(odd)
    const secret = await put(join(odd, 'tajné “účty”.pdf'))
    await put(join(odd, 'seen.pdf'))
    if (process.platform === 'win32') execFileSync('attrib.exe', ['+h', secret])
    else execFileSync('/usr/bin/chflags', ['hidden', secret])
    assert.deepEqual([...(await hiddenIn(odd))], [basename(secret)])
    await assert.rejects(hiddenIn(join(base, 'missing')), refused(/hidden/))
  })
})

test('the real PowerShell reads its input as data', { timeout: 60_000, skip: process.platform !== 'win32' }, async () => {
  const echo = `
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
'done'
`
  const hostile = `'; exit 7 # " $(exit 8) ‘’“” příliš`
  assert.deepEqual(await runPowerShell(echo, hostile), [hostile])
})

// ---- against the real index of this computer ----

const live = process.env.ALEXIA_LIVE === '1' && marksHidden

test('live: the real search index answers, hostile words and all', { skip: !live && 'set ALEXIA_LIVE=1 on Windows or macOS', timeout: 120_000 }, async () => {
  const home = await realpath(homedir())
  const find = process.platform === 'win32' ? windowsBackend() : macBackend()
  const finder = createFinder({ roots: async () => [home], find })
  for (const args of [
    { query: 'a', limit: 5 },
    { query: 'a', kind: 'folder', limit: 5 },
    { query: 'e', kind: 'document', modified_after: '2000-01-01', limit: 5 },
    { query: `x'; DROP TABLE "SystemIndex") OR SCOPE='file:' --`, folder: home },
    { query: 'qzxqzxqzx-nothing-has-this-name', folder: home },
  ]) {
    const { items } = await finder.search(args)
    assert.ok(items.length <= (args.limit ?? 20))
    for (const item of items) assert.ok(inside(item.path, home), 'a result outside the home folder')
    // A broad word finds something on any computer that has been used.
    if (args.query === 'a') assert.ok(items.length > 0, JSON.stringify(args))
  }
})
