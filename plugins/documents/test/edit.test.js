// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { editDocument, NOT_EDITABLE, Refused, zipStored } from '../edit.js'
import { read } from '../read.js'
import { unzip } from '../zip.js'
import { docx, docxParagraph, pdf } from './making.js'

// These run under the repo's vitest and under `node --test` alike.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test')

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))

/** A folder of its own that is opened as the only root, and removed afterwards. */
async function inFolder(run) {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'alexia-edit-')))
  const folder = join(made, 'opened')
  mkdirSync(folder)
  const put = (name, content) => {
    const path = join(folder, name)
    writeFileSync(path, content)
    return path
  }
  const edit = (args, roots = [{ uri: pathToFileURL(folder).href }]) => editDocument(args, { roots: async () => roots })
  try {
    await run({ made, folder, put, edit })
  } finally {
    rmSync(made, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

const refusedWith = (pattern) => (error) => {
  assert.ok(error instanceof Refused, `expected a refusal, got ${String(error)}`)
  assert.match(error.message, pattern)
  return true
}

const documentXml = (path) => unzip(readFileSync(path)).get('word/document.xml').toString('utf8')

const run = (text, properties = '') => `<w:r>${properties}<w:t xml:space="preserve">${text}</w:t></w:r>`
const BOLD = '<w:rPr><w:b/></w:rPr>'
const ITALIC = '<w:rPr><w:i/></w:rPr>'

test('md_replace_copy', () =>
  inFolder(async ({ folder, put, edit }) => {
    const original = '# Rent\r\n\r\nThe rent is 18500.\r\nThe rent is due.\r\n'
    const path = put('lease.md', original)

    const first = await edit({ path, edits: [{ find: 'rent is', replace: 'fee $& is' }] })
    assert.deepEqual(first, { path: join(folder, 'lease (edited).md'), changed: 1 })
    // Only the first occurrence, the replacement taken literally, the line endings kept.
    assert.equal(readFileSync(first.path, 'utf8'), '# Rent\r\n\r\nThe fee $& is 18500.\r\nThe rent is due.\r\n')
    assert.equal(readFileSync(path, 'utf8'), original)

    const every = await edit({
      path,
      edits: [
        { find: 'rent', replace: 'rent rent', all: true },
        // Written with a bare newline against a file that uses CRLF.
        { find: '18500.\nThe', replace: '19000.\nA' },
      ],
    })
    assert.equal(every.changed, 3)
    assert.equal(readFileSync(every.path, 'utf8'), '# Rent\r\n\r\nThe rent rent is 19000.\r\nA rent rent is due.\r\n')
  }))

test('a phrase that is not there changes nothing and writes nothing', () =>
  inFolder(async ({ folder, put, edit }) => {
    const path = put('notes.txt', 'alpha beta\n')
    await assert.rejects(
      edit({ path, in_place: true, edits: [{ find: 'alpha', replace: 'gamma' }, { find: 'delta', replace: 'x' }] }),
      refusedWith(/could not find “delta”.*nothing was changed/),
    )
    assert.equal(readFileSync(path, 'utf8'), 'alpha beta\n')
    assert.deepEqual(readdirSync(folder), ['notes.txt'])
  }))

test('a request that is not exactly one kind of change is refused', () =>
  inFolder(async ({ folder, put, edit }) => {
    const path = put('notes.txt', 'alpha\n')
    for (const args of [
      { path },
      { path, append: { text: 'x' }, edits: [{ find: 'alpha', replace: 'x' }] },
      { path, edits: [] },
      { path, edits: [{ find: '', replace: 'x' }] },
      { path, append: { text: '  ' } },
      { path, append_row: [] },
      { path, append_row: ['x'] },
    ]) {
      await assert.rejects(edit(args), Refused, JSON.stringify(args))
    }
    assert.deepEqual(readdirSync(folder), ['notes.txt'])
  }))

test('a paragraph is appended after one blank line, in the file’s own line endings', () =>
  inFolder(async ({ put, edit }) => {
    for (const [before, after] of [
      ['One.', 'One.\n\nTwo.\nStill two.\n'],
      ['One.\n', 'One.\n\nTwo.\nStill two.\n'],
      ['One.\n\n', 'One.\n\nTwo.\nStill two.\n'],
      ['One.\r\n', 'One.\r\n\r\nTwo.\r\nStill two.\r\n'],
      ['', 'Two.\nStill two.\n'],
    ]) {
      const path = put('page.md', before)
      const done = await edit({ path, in_place: true, append: { text: 'Two.\nStill two.\n' } })
      assert.equal(done.changed, 1)
      assert.equal(readFileSync(path, 'utf8'), after, JSON.stringify(before))
    }
  }))

test('csv_append_row_quotes', () =>
  inFolder(async ({ put, edit }) => {
    const path = put('rent.csv', 'Item,Amount,Note\nRent,18500,')
    const done = await edit({ path, append_row: ['Deposit, once', '37000', 'the "big" one\nsecond line'] })
    assert.equal(done.changed, 1)
    assert.equal(
      readFileSync(done.path, 'utf8'),
      'Item,Amount,Note\nRent,18500,\n"Deposit, once",37000,"the ""big"" one\nsecond line"\n',
    )
    // The reader sees three columns on the new row, which is what the quoting is for.
    assert.match(read(done.path, readFileSync(done.path)).markdown, /\| Deposit, once \| 37000 \|/)

    // Semicolons, found past a heading that holds a comma; a comma is then an ordinary letter.
    const european = put('cena.csv', '"Name, first";Price\r\nA;1\r\n')
    const added = await edit({ path: european, append_row: ['B;C', '18,5'] })
    assert.equal(readFileSync(added.path, 'utf8'), '"Name, first";Price\r\nA;1\r\n"B;C";18,5\r\n')

    const tabbed = put('t.tsv', 'a\tb\n')
    const row = await edit({ path: tabbed, append_row: ['x,y', 'with\ttab'] })
    assert.equal(readFileSync(row.path, 'utf8'), 'a\tb\nx,y\t"with\ttab"\n')

    await assert.rejects(edit({ path, append: { text: 'loose words' } }), refusedWith(/append_row/))
  }))

test('a file keeps its encoding and byte-order mark', () =>
  inFolder(async ({ put, edit }) => {
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Nájem 1\n', 'utf8')])
    const utf8 = put('a.txt', marked)
    await edit({ path: utf8, in_place: true, edits: [{ find: 'Nájem 1', replace: 'Nájem 2' }] })
    assert.deepEqual(
      readFileSync(utf8),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Nájem 2\n', 'utf8')]),
    )

    const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Nájem 1\r\n', 'utf16le')])
    const wide = put('b.txt', little)
    await edit({ path: wide, in_place: true, edits: [{ find: '1', replace: 'žluť' }] })
    assert.deepEqual(
      readFileSync(wide),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Nájem žluť\r\n', 'utf16le')]),
    )

    const big = Buffer.from('x 1\n', 'utf16le').swap16()
    const other = put('c.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), big]))
    await edit({ path: other, in_place: true, edits: [{ find: '1', replace: '2' }] })
    assert.deepEqual(
      readFileSync(other),
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('x 2\n', 'utf16le').swap16()]),
    )
  }))

test('a file in an unnamed code page is not garbled', () =>
  inFolder(async ({ put, edit }) => {
    // `0xE1` alone is not UTF-8: some one-byte code page, and nobody says which.
    const bytes = Buffer.from([0x4e, 0xe1, 0x6a, 0x65, 0x6d, 0x20, 0x31, 0x0a])
    const path = put('old.csv', bytes)
    await edit({ path, in_place: true, edits: [{ find: '1', replace: '2' }] })
    assert.deepEqual(readFileSync(path), Buffer.from([0x4e, 0xe1, 0x6a, 0x65, 0x6d, 0x20, 0x32, 0x0a]))
    await assert.rejects(edit({ path, append_row: ['žluť'] }), refusedWith(/not saved as UTF-8/))

    const binary = put('noise.txt', Buffer.from([0x61, 0x00, 0x62]))
    await assert.rejects(edit({ path: binary, append: { text: 'x' } }), refusedWith(/not text inside/))
  }))

test('docx_replace_in_one_run', () =>
  inFolder(async ({ folder, put, edit }) => {
    const original = docx(
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run('Rent &amp; fees: 18500', BOLD)}</w:p>` +
        docxParagraph('Untouched 18500'),
    )
    const path = put('lease.docx', original)

    const done = await edit({ path, edits: [{ find: '& fees: 18500', replace: '<fees> &amp; 19000' }] })

    assert.deepEqual(done, { path: join(folder, 'lease (edited).docx'), changed: 1 })
    assert.deepEqual(readFileSync(path), original)
    const xml = documentXml(done.path)
    assert.ok(xml.includes(run('Rent &lt;fees&gt; &amp;amp; 19000', BOLD)), xml)
    // The tab stop is a setting rather than a tab, and the second paragraph was not asked for.
    assert.ok(xml.includes('<w:tab w:val="left" w:pos="720"/>'))
    assert.ok(xml.includes(docxParagraph('Untouched 18500')))
    assert.equal(read(done.path, readFileSync(done.path)).markdown, 'Rent <fees> &amp; 19000\n\nUntouched 18500')
    // Every part came across, byte for byte apart from the one that was edited.
    const parts = unzip(readFileSync(done.path))
    assert.deepEqual([...parts.keys()], [...unzip(original).keys()])
    assert.deepEqual(parts.get('[Content_Types].xml'), unzip(original).get('[Content_Types].xml'))

    const every = await edit({ path, edits: [{ find: '18500', replace: '1', all: true }] })
    assert.equal(every.changed, 2)
  }))

test('docx_replace_across_runs', () =>
  inFolder(async ({ put, edit }) => {
    const path = put(
      'letter.docx',
      docx(`<w:p>${run('Dear Mr ', BOLD)}${run('Nov', ITALIC)}<w:proofErr w:type="spellStart"/>${run('ak, hello')}</w:p>`),
    )
    const done = await edit({ path, edits: [{ find: 'Mr Novak', replace: 'Ms Svoboda' }] })
    assert.equal(done.changed, 1)
    const xml = documentXml(done.path)
    // All of it lands in the first run, in that run's formatting; the others keep what is left.
    assert.ok(xml.includes(run('Dear Ms Svoboda', BOLD)), xml)
    assert.ok(xml.includes(`<w:r>${ITALIC}</w:r>`), xml)
    assert.ok(xml.includes(run(', hello')), xml)
    assert.equal(read(done.path, readFileSync(done.path)).markdown, 'Dear Ms Svoboda, hello')
  }))

test('a phrase across tabs and line breaks matches, and puts back what it is given', () =>
  inFolder(async ({ put, edit }) => {
    const path = put(
      'form.docx',
      docx(`<w:p><w:r><w:t>Name:</w:t><w:tab/><w:t>John</w:t><w:br/><w:t>Age</w:t><w:br w:type="page"/><w:t>40</w:t></w:r></w:p>`),
    )
    const done = await edit({ path, edits: [{ find: 'Name:\tJohn\nAge', replace: 'Who:\tJane\nYears' }] })
    assert.ok(
      documentXml(done.path).includes(
        '<w:r><w:t xml:space="preserve">Who:</w:t><w:tab/><w:t xml:space="preserve">Jane</w:t><w:br/>' +
          '<w:t xml:space="preserve">Years</w:t><w:br w:type="page"/><w:t>40</w:t></w:r>',
      ),
      documentXml(done.path),
    )
    // A page break is not a line break: nothing matches across it, and it is never removed.
    await assert.rejects(edit({ path, edits: [{ find: 'Age40', replace: 'x' }] }), Refused)
    await assert.rejects(edit({ path, edits: [{ find: 'Age\n40', replace: 'x' }] }), Refused)
  }))

test('text boxes, deleted text and paragraph boundaries are each kept apart', () =>
  inFolder(async ({ put, edit }) => {
    const box = `<w:r><w:drawing><w:txbxContent>${docxParagraph('inside the box')}</w:txbxContent></w:drawing></w:r>`
    const gone = `<w:del w:id="1"><w:r><w:t>struck out</w:t></w:r></w:del>`
    const path = put('box.docx', docx(`<w:p>${run('before ')}${box}${gone}${run('after')}</w:p>${docxParagraph('next')}`))

    const done = await edit({
      path,
      edits: [
        { find: 'before after', replace: 'joined' },
        { find: 'the box', replace: 'the frame' },
      ],
    })
    assert.equal(done.changed, 2)
    const xml = documentXml(done.path)
    assert.ok(xml.includes(run('joined')), xml)
    assert.ok(xml.includes(run('inside the frame')), xml)
    assert.ok(xml.includes(gone), xml)

    for (const find of ['struck out', 'afternext', 'after\nnext']) {
      await assert.rejects(edit({ path, edits: [{ find, replace: 'x' }] }), refusedWith(/within one paragraph/), find)
    }
  }))

test('a paragraph appended to a Word file goes before the section settings', () =>
  inFolder(async ({ put, edit }) => {
    const section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
    const inner = `<w:p><w:pPr><w:sectPr/></w:pPr>${run('first section')}</w:p>`
    const path = put('a.docx', docx(`${inner}${docxParagraph('Last')}${section}`))
    const done = await edit({ path, append: { text: 'New & improved\nsame paragraph\n\nAnother' } })
    assert.equal(done.changed, 1)
    const xml = documentXml(done.path)
    assert.ok(
      xml.includes(
        `${docxParagraph('Last')}<w:p><w:r><w:t xml:space="preserve">New &amp; improved</w:t><w:br/>` +
          '<w:t xml:space="preserve">same paragraph</w:t></w:r></w:p>' +
          `<w:p><w:r><w:t xml:space="preserve">Another</w:t></w:r></w:p>${section}</w:body>`,
      ),
      xml,
    )

    const bare = put('b.docx', docx(docxParagraph('Only')))
    const added = await edit({ path: bare, append: { text: 'End' } })
    assert.equal(read(added.path, readFileSync(added.path)).markdown, 'Only\n\nEnd')

    const empty = put(
      'c.docx',
      zipStored(new Map([['word/document.xml', Buffer.from('<w:document xmlns:w="x"><w:body/></w:document>')]])),
    )
    const filled = await edit({ path: empty, append: { text: 'Start' } })
    assert.equal(read(filled.path, readFileSync(filled.path)).markdown, 'Start')

    await assert.rejects(edit({ path, append_row: ['x'] }), refusedWith(/CSV or TSV/))
    await assert.rejects(edit({ path, append: { text: 'bell \u0007' } }), refusedWith(/cannot/))
  }))

test('the Word file written is a well-formed archive of stored parts', () => {
  const parts = new Map([
    ['word/document.xml', Buffer.from('<w:document/>')],
    ['word/media/obrázek.bin', Buffer.from([0, 1, 2, 255])],
    ['word/empty/', Buffer.alloc(0)],
  ])
  const bytes = zipStored(parts)
  const back = unzip(bytes)
  assert.deepEqual([...back.keys()], [...parts.keys()])
  for (const [name, body] of parts) assert.deepEqual(Buffer.from(back.get(name)), body, name)

  // What other unzippers check and ours does not: the checksum, in both headers.
  let at = bytes.readUInt32LE(bytes.length - 22 + 16)
  for (const body of parts.values()) {
    const local = bytes.readUInt32LE(at + 42)
    assert.equal(bytes.readUInt32LE(local), 0x04034b50)
    assert.equal(bytes.readUInt16LE(local + 8), 0)
    assert.equal(bytes.readUInt32LE(local + 14), crc32(body))
    assert.equal(bytes.readUInt32LE(at + 16), crc32(body))
    at += 46 + bytes.readUInt16LE(at + 28)
  }
})

test('a Word file with a part that cannot be carried across is left alone', () =>
  inFolder(async ({ folder, put, edit }) => {
    const bytes = docx(docxParagraph('hello'))
    // The first directory entry now claims a compression method nothing here unpacks.
    const listing = bytes.readUInt32LE(bytes.length - 22 + 16)
    bytes.writeUInt16LE(12, listing + 10)
    const path = put('odd.docx', bytes)
    await assert.rejects(edit({ path, edits: [{ find: 'hello', replace: 'x' }] }), refusedWith(/cannot copy faithfully/))

    const fake = put('fake.docx', 'not an archive at all, only words')
    await assert.rejects(edit({ path: fake, append: { text: 'x' } }), refusedWith(/could not be opened/))
    assert.deepEqual(readdirSync(folder).sort(), ['fake.docx', 'odd.docx'])
  }))

test('in_place_overwrites', () =>
  inFolder(async ({ folder, put, edit }) => {
    const text = put('notes.txt', 'old words\n')
    const done = await edit({ path: text, in_place: true, edits: [{ find: 'old', replace: 'new' }] })
    assert.deepEqual(done, { path: text, changed: 1 })
    assert.equal(readFileSync(text, 'utf8'), 'new words\n')

    const word = put('w.docx', docx(docxParagraph('old words')))
    await edit({ path: word, in_place: true, edits: [{ find: 'old', replace: 'new' }] })
    assert.equal(read(word, readFileSync(word)).markdown, 'new words')
    // No copy and no temporary file left beside them.
    assert.deepEqual(readdirSync(folder).sort(), ['notes.txt', 'w.docx'])

    const locked = put('locked.txt', 'old\n')
    chmodSync(locked, 0o444)
    try {
      await assert.rejects(
        edit({ path: locked, in_place: true, edits: [{ find: 'old', replace: 'new' }] }),
        refusedWith(/read-only/),
      )
      assert.equal(readFileSync(locked, 'utf8'), 'old\n')
    } finally {
      chmodSync(locked, 0o644)
    }
  }))

test('copy_names_increment', () =>
  inFolder(async ({ folder, put, edit }) => {
    const path = put('plan.v2.md', 'a\n')
    // Somebody's own file already has the first name, and must stay theirs.
    put('plan.v2 (edited).md', 'mine\n')
    const names = []
    for (let n = 0; n < 2; n += 1) {
      names.push(basename((await edit({ path, edits: [{ find: 'a', replace: 'b' }] })).path))
    }
    assert.deepEqual(names, ['plan.v2 (edited 2).md', 'plan.v2 (edited 3).md'])
    assert.equal(readFileSync(join(folder, 'plan.v2 (edited).md'), 'utf8'), 'mine\n')

    // Asked for at once, they still take a name each.
    const together = await Promise.all([0, 1, 2].map(() => edit({ path, append: { text: 'c' } })))
    assert.equal(new Set(together.map((done) => done.path)).size, 3)
  }))

test('pdf_refused', () =>
  inFolder(async ({ folder, put, edit }) => {
    const files = [
      put('invoice.pdf', pdf([{ text: 'Total 12', x: 72, y: 700 }])),
      put('book.xlsx', 'x'),
      put('data.json', '{"a":1}'),
      put('photo.png', 'x'),
      put('noextension', 'x'),
    ]
    for (const path of files) {
      await assert.rejects(edit({ path, edits: [{ find: 'x', replace: 'y' }] }), (error) => {
        assert.ok(error instanceof Refused)
        assert.equal(error.message, NOT_EDITABLE)
        return true
      })
    }
    assert.equal(readdirSync(folder).length, files.length)
  }))

test('outside_roots_refused', () =>
  inFolder(async ({ made, folder, put, edit }) => {
    const secret = join(made, 'secret.txt')
    writeFileSync(secret, 'private\n')
    // A folder whose name only begins like the root's.
    mkdirSync(`${folder}-more`)
    const neighbour = join(`${folder}-more`, 'n.txt')
    writeFileSync(neighbour, 'private\n')
    // A link inside the root that leads out of it. A junction needs no special right on Windows.
    mkdirSync(join(made, 'elsewhere'))
    writeFileSync(join(made, 'elsewhere', 'far.txt'), 'private\n')
    symlinkSync(join(made, 'elsewhere'), join(folder, 'door'), 'junction')

    const change = { edits: [{ find: 'private', replace: 'public' }] }
    for (const path of [
      secret,
      neighbour,
      `${folder}/../secret.txt`,
      join(folder, 'door', 'far.txt'),
      join(folder, 'missing.txt'),
    ]) {
      for (const in_place of [false, true]) {
        await assert.rejects(edit({ path, in_place, ...change }), refusedWith(/outside the folders/), path)
      }
    }
    await assert.rejects(edit({ path: 'notes.txt', ...change }), refusedWith(/full path/))
    const inside = put('in.txt', 'private\n')
    await assert.rejects(edit({ path: inside, ...change }, []), refusedWith(/No folder has been opened/))

    assert.equal(readFileSync(secret, 'utf8'), 'private\n')
    assert.equal(readFileSync(neighbour, 'utf8'), 'private\n')
    assert.deepEqual(readdirSync(join(made, 'elsewhere')), ['far.txt'])
    assert.deepEqual(readdirSync(made).sort(), ['elsewhere', 'opened', 'opened-more', 'secret.txt'])
    assert.deepEqual(readdirSync(`${folder}-more`), ['n.txt'])
  }))

/**
 * The plugin as the host sees it: started as its entry point and spoken to over stdio, with
 * `roots/list` answered and every other request it makes left unanswered.
 */
async function wired(roots, use) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ALEXIA_PLUGIN_DIR: dir },
  })
  let said = ''
  child.stderr.on('data', (chunk) => (said += String(chunk)))
  const waiting = new Map()
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'roots/list') send({ id: message.id, result: { roots } })
    // A request from the plugin has its own ids, so only answers are matched to ours.
    else if (message.method === undefined) waiting.get(message.id)?.resolve(message)
  })
  child.on('exit', () => {
    for (const { reject } of waiting.values()) reject(new Error(`the plugin stopped: ${said}`))
  })
  let id = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1
      waiting.set(id, { resolve, reject })
      send({ id, method, params })
    })
  try {
    await ask('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { roots: {} },
      clientInfo: { name: 'test', version: '1' },
    })
    send({ method: 'notifications/initialized' })
    await use(ask)
  } finally {
    child.kill()
  }
}

test('every_declared_capability_is_bound_once', { timeout: 60_000 }, () =>
  wired([], async (ask) => {
    const { tools } = (await ask('tools/list', {})).result
    const bound = tools.flatMap((tool) => (tool._meta?.['alexia/provides'] ?? []).map((cap) => ({ cap, tool })))
    // Sorted lists rather than sets, so a capability bound twice fails too.
    assert.deepEqual(bound.map(({ cap }) => cap).sort(), [...manifest.provides].sort())
    assert.ok(manifest.requires.some((one) => one.cap === 'fs.write_scoped' && one.why !== ''))
    const editing = bound.find(({ cap }) => cap === 'document.edit').tool
    assert.equal(editing.annotations.destructiveHint, true)
    assert.equal(editing.annotations.readOnlyHint, false)
    assert.equal(editing.annotations.openWorldHint, false)
    assert.match(editing.description, /By default it writes a copy/)
  }),
)

test('the tool edits inside the roots the host lists, and says why when it does not', { timeout: 60_000 }, () =>
  inFolder(async ({ made, folder, put }) => {
    const path = put('notes.txt', 'old\n')
    const outside = join(made, 'outside.txt')
    writeFileSync(outside, 'old\n')
    await wired([{ uri: pathToFileURL(folder).href, name: 'opened' }], async (ask) => {
      const call = async (args) => (await ask('tools/call', { name: 'edit', arguments: args })).result
      const edits = [{ find: 'old', replace: 'new' }]

      const done = await call({ path, edits })
      assert.notEqual(done.isError, true, JSON.stringify(done))
      assert.deepEqual(done.structuredContent, { path: join(folder, 'notes (edited).txt'), changed: 1 })
      assert.equal(readFileSync(done.structuredContent.path, 'utf8'), 'new\n')

      const refused = await call({ path: outside, edits, in_place: true })
      assert.equal(refused.isError, true)
      assert.match(refused.content[0].text, /outside the folders/)
      assert.equal(readFileSync(outside, 'utf8'), 'old\n')
    })
  }),
)
