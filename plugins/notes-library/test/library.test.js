// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createLibrary, foldersOf, MOST_CHARS } from '../library.js'
import { at, fakeFs, fakeTable } from './fake.js'

const LONG = ' It goes on for a while so that it is longer than two hundred characters and a summary is wanted for it, which means the model is asked.'.repeat(2)

/** A tiny "meaning": which topic words a text has, as a vector. */
const TOPICS = ['scholarship', 'recipe', 'invoice']
const vectorOf = (text) => {
  const low = String(text).toLowerCase()
  const v = TOPICS.map((t) => (low.includes(t) ? 1 : 0))
  return v.some((n) => n > 0) ? v : [0.01, 0.01, 0.01]
}

function setup({ files = {}, settings = {}, roots = [at('home')], extract = true, embed = true, status } = {}) {
  const fs = fakeFs(files)
  const table = fakeTable()
  const calls = { sample: 0, embed: 0, extract: [] }
  const library = createLibrary({
    fs,
    real: async (p) => p,
    roots: async () => roots,
    settings: async () => ({ folders: at('home', 'docs'), ...settings }),
    storage: table,
    status: async (s) => status?.(s),
    now: () => new Date(2026, 10, 25, 10, 2).getTime(),
    embed: async (texts) => {
      calls.embed += 1
      return embed ? texts.map(vectorOf) : null
    },
    sample: async () => {
      calls.sample += 1
      return 'A document about something. It has a second sentence. And a third one. And a fourth.'
    },
    canExtract: async () => extract,
    extract: async (path) => {
      calls.extract.push(path)
      return `Extracted text of ${path}`
    },
  })
  return { library, fs, table, calls }
}

test('only_changed_files_reread', async () => {
  const { library, fs, table, calls } = setup({
    files: {
      [at('home', 'docs', 'a.md')]: { text: `# A\n${LONG}`, mtime: 1000 },
      [at('home', 'docs', 'b.txt')]: { text: `B${LONG}`, mtime: 1000 },
      [at('home', 'docs', 'c.md')]: { text: 'tiny', mtime: 1000 },
    },
  })
  const first = await library.reindex()
  expect(first.read).toBe(3)
  expect(fs.reads.length).toBe(3)
  expect(calls.sample).toBe(2) // c.md is under 200 characters: its text is its summary

  fs.reads.length = 0
  const again = await library.reindex()
  expect(again.read).toBe(0)
  expect(again.kept).toBe(3)
  expect(fs.reads).toEqual([]) // same size and time: not even opened

  // A new date but the same bytes: opened and hashed, but not summarised or embedded again.
  fs.set(at('home', 'docs', 'a.md'), { text: `# A\n${LONG}`, mtime: 2000 })
  const sampled = calls.sample
  const touched = await library.reindex()
  expect(touched.read).toBe(0)
  expect(fs.reads).toEqual([at('home', 'docs', 'a.md')])
  expect(calls.sample).toBe(sampled)
  expect(table.rows.find((r) => r.path === at('home', 'docs', 'a.md')).mtime).toBe(2000)

  // Real change: re-summarised. And a deleted file leaves the table.
  fs.set(at('home', 'docs', 'b.txt'), { text: `Changed${LONG}`, mtime: 3000 })
  fs.delete(at('home', 'docs', 'c.md'))
  const changed = await library.reindex()
  expect(changed.read).toBe(1)
  expect(changed.removed).toBe(1)
  expect(calls.sample).toBe(sampled + 1)
  expect(table.rows.map((r) => r.path).sort()).toEqual([at('home', 'docs', 'a.md'), at('home', 'docs', 'b.txt')].sort())
})

test('a short file is its own summary and a long one gets at most three sentences', async () => {
  const { library, table } = setup({
    files: { [at('home', 'docs', 's.md')]: { text: 'Short note.' }, [at('home', 'docs', 'l.md')]: { text: LONG } },
  })
  await library.reindex()
  expect(table.rows.find((r) => r.path.endsWith('s.md')).summary).toBe('Short note.')
  expect(table.rows.find((r) => r.path.endsWith('l.md')).summary).toBe('A document about something. It has a second sentence. And a third one.')
})

test('outside_roots_refused: a folder outside the roots is never read, and the status says so', async () => {
  const lines = []
  const { library, fs } = setup({
    files: { [at('elsewhere', 'secret.md')]: { text: 'private' }, [at('home', 'docs', 'ok.md')]: { text: 'fine' } },
    settings: { folders: `${at('elsewhere')}\n${at('home', 'docs')}` },
    status: (s) => lines.push(s),
  })
  const done = await library.reindex()
  expect(done.refused).toEqual([at('elsewhere')])
  expect(fs.reads).toEqual([at('home', 'docs', 'ok.md')])
  expect(lines.at(-1)).toContain('outside the folders you opened')
  const opened = await library.open(at('elsewhere', 'secret.md'))
  expect(opened.error).toMatch(/not in the folders you chose/)
})

test('find_by_meaning_with_fake_embed', async () => {
  const { library } = setup({
    files: {
      [at('home', 'docs', 'letter.md')]: { text: `# Letter from the foundation\nYour scholarship was approved.${LONG}` },
      [at('home', 'docs', 'pasta.md')]: { text: `# Dinner\nA recipe for pasta.${LONG}` },
      [at('home', 'docs', 'bill.txt')]: { text: `An invoice for March.${LONG}` },
    },
  })
  await library.reindex()
  const found = await library.find('scholarship papers', 3)
  expect(found.meaning).toBe(true)
  expect(found.results[0].path).toBe(at('home', 'docs', 'letter.md'))
  expect(found.results[0].why).toContain('meaning')
  expect(found.results.map((r) => r.title)).not.toContain('Dinner')
  // Words alone would not have found this: the question shares none with the file's words.
  const other = await library.find('invoice', 1)
  expect(other.results[0].path).toBe(at('home', 'docs', 'bill.txt'))
})

test('with nothing to embed, files are found by their words and it says so', async () => {
  const lines = []
  const { library } = setup({
    embed: false,
    files: { [at('home', 'docs', 'letter.md')]: { text: '# Scholarship letter\nApproved.' } },
    status: (s) => lines.push(s),
  })
  await library.reindex()
  const found = await library.find('scholarship', 5)
  expect(found.meaning).toBe(false)
  expect(found.results.length).toBe(1)
  expect(found.results[0].why).toContain('scholarship')
  expect(lines.at(-1)).toContain('words only')
})

test('no_extract_provider_reads_text_only', async () => {
  const lines = []
  const { library, table, calls } = setup({
    extract: false,
    files: {
      [at('home', 'docs', 'note.md')]: { text: 'a note' },
      [at('home', 'docs', 'form.pdf')]: { text: '%PDF fake' },
      [at('home', 'docs', 'cv.docx')]: { text: 'PK fake' },
    },
    status: (s) => lines.push(s),
  })
  const done = await library.reindex()
  expect(done.read).toBe(1)
  expect(table.rows.map((r) => r.path)).toEqual([at('home', 'docs', 'note.md')])
  expect(calls.extract).toEqual([])
  expect(lines.at(-1)).toContain('nothing here can read')
  const refused = await library.open(at('home', 'docs', 'form.pdf'))
  expect(refused.error).toMatch(/nothing here can/)
})

test('with an extractor, a PDF is read through it, and read_document cuts at 20 000 characters', async () => {
  const { library, table, calls, fs } = setup({
    files: { [at('home', 'docs', 'form.pdf')]: { text: '%PDF fake' }, [at('home', 'docs', 'big.txt')]: { text: 'x'.repeat(MOST_CHARS + 500) } },
  })
  await library.reindex()
  expect(calls.extract).toEqual([at('home', 'docs', 'form.pdf')])
  expect(table.rows.find((r) => r.path.endsWith('form.pdf')).summary).toContain('Extracted text')
  const big = await library.open(at('home', 'docs', 'big.txt'))
  expect(big.text.length).toBe(MOST_CHARS)
  expect(big.cut).toBe(true)
  const pdf = await library.open(at('home', 'docs', 'form.pdf'))
  expect(pdf.text).toContain('Extracted text')
  expect(fs.reads).not.toContain(at('home', 'docs', 'form.pdf') + '.never')
})

test('notes: tags and links are kept, filtered by tag, and the notes folder narrows it', async () => {
  const { library, table } = setup({
    settings: { folders: at('home', 'docs'), notes_folder: at('home', 'vault') },
    files: {
      [at('home', 'vault', 'idea.md')]: { text: '# Idea\n#project/alpha links to [[Plan]] and [[Other|x]]' },
      [at('home', 'vault', 'plan.md')]: { text: '# Plan\n#work' },
      [at('home', 'vault', '.obsidian', 'app.md')]: { text: '#nope' },
      [at('home', 'docs', 'plain.md')]: { text: '# Plain\n#project/alpha' },
    },
  })
  await library.reindex()
  const row = table.rows.find((r) => r.path.endsWith('idea.md'))
  expect(JSON.parse(row.tags)).toEqual(['project/alpha'])
  expect(JSON.parse(row.links)).toEqual(['Plan', 'Other'])
  const tagged = await library.notes('#project')
  expect(tagged.map((n) => n.title)).toEqual(['Idea']) // plain.md is outside the notes folder
  expect((await library.notes()).map((n) => n.title)).toEqual(['Idea', 'Plan'])
})

test('a folder that cannot be listed does not make its files vanish', async () => {
  const { library, fs, table } = setup({ files: { [at('home', 'docs', 'a.md')]: { text: 'a' } } })
  await library.reindex()
  const real = fs.readdir
  fs.readdir = async () => Promise.reject(new Error('EIO'))
  const done = await library.reindex()
  expect(done.removed).toBe(0)
  expect(table.rows.length).toBe(1)
  fs.readdir = real
})

test('status line reads "● N files from M folders, last read HH:MM"', async () => {
  const lines = []
  const { library } = setup({
    files: { [at('home', 'docs', 'a.md')]: { text: 'a' }, [at('home', 'docs', 'b.md')]: { text: 'b' } },
    status: (s) => lines.push(s),
  })
  await library.reindex()
  expect(lines.at(-1)).toMatch(/^● 2 files from 1 folder, last read 10:02/)
})

test('folders are one per line, quotes and blanks removed', () => {
  expect(foldersOf('"C:\\a b"\n\n  /x/y  ;/z')).toEqual(['C:\\a b', '/x/y', '/z'])
})
