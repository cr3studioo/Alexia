// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { classify, gone, inside, kindOf, sha256, sortFolders, walk } from '../scan.js'
import { at, BASE, fakeFs } from './fake.js'

test('kinds: Markdown, text, extractable, and nothing else', () => {
  expect(kindOf('a.MD')).toBe('markdown')
  expect(kindOf('a.txt')).toBe('text')
  expect(kindOf('a.pdf')).toBe('extract')
  expect(kindOf('a.docx')).toBe('extract')
  expect(kindOf('a.png')).toBeUndefined()
  expect(kindOf('Makefile')).toBeUndefined()
})

test('dot_folders_skipped', async () => {
  const fs = fakeFs({
    [at('vault', 'one.md')]: { text: 'one' },
    [at('vault', '.obsidian', 'workspace.md')]: { text: 'config' },
    [at('vault', '.git', 'notes.txt')]: { text: 'git' },
    [at('vault', 'sub', '.trash', 'old.md')]: { text: 'trash' },
    [at('vault', 'sub', 'two.txt')]: { text: 'two' },
    [at('vault', '.hidden.md')]: { text: 'hidden' },
    [at('vault', 'pic.png')]: { text: 'not ours' },
  })
  const found = await walk(fs, at('vault'))
  expect(found.files.map((f) => f.path).sort()).toEqual([at('vault', 'one.md'), at('vault', 'sub', 'two.txt')].sort())
})

test('outside_roots_refused', async () => {
  const roots = [at('docs')]
  expect(inside(at('docs', 'a', 'b.md'), roots)).toBe(true)
  expect(inside(at('docs'), roots)).toBe(true)
  expect(inside(at('docs-other', 'a.md'), roots)).toBe(false)
  expect(inside(at('docs', '..', 'secrets', 'a.md'), roots)).toBe(false)
  expect(inside('relative/path', roots)).toBe(false)
  const { allowed, refused } = await sortFolders([at('docs', 'notes'), at('elsewhere'), 'relative'], roots)
  expect(allowed).toEqual([at('docs', 'notes')])
  expect(refused).toEqual([at('elsewhere'), 'relative'])
})

test('a folder that is a link leading out of the roots is refused', async () => {
  const real = async (p) => (p === at('docs', 'link') ? at('outside') : p)
  const { allowed, refused } = await sortFolders([at('docs', 'link'), at('docs', 'plain')], [at('docs')], real)
  expect(allowed).toEqual([at('docs', 'plain')])
  expect(refused).toEqual([at('docs', 'link')])
})

test('links inside a folder are not followed', async () => {
  const fs = fakeFs({ [at('v', 'a.md')]: { text: 'a' } })
  const base = fs.readdir
  fs.readdir = async (dir) => [...(await base(dir)), { name: 'escape.md', type: 'link' }, { name: 'out', type: 'link' }]
  const found = await walk(fs, at('v'))
  expect(found.files.map((f) => f.path)).toEqual([at('v', 'a.md')])
})

test('classify: unchanged is not opened, touched keeps the row, changed is read', async () => {
  const reads = []
  const readBytes = async (path) => {
    reads.push(path)
    return Buffer.from('hello')
  }
  const file = { path: at('a.md'), kind: 'markdown', size: 5, mtime: 100 }
  expect(await classify(file, { size: 5, mtime: 100, sha256: 'x' }, readBytes)).toEqual({ state: 'unchanged' })
  expect(reads).toEqual([])
  const same = await classify({ ...file, mtime: 200 }, { size: 5, mtime: 100, sha256: sha256(Buffer.from('hello')) }, readBytes)
  expect(same.state).toBe('touched')
  const changed = await classify({ ...file, mtime: 200 }, { size: 5, mtime: 100, sha256: 'old' }, readBytes)
  expect(changed.state).toBe('changed')
  expect((await classify(file, undefined, readBytes)).isNew).toBe(true)
  expect(await classify(file, undefined, async () => Promise.reject(new Error('EACCES')))).toEqual({ state: 'unreadable' })
})

test('gone: a missing file is gone, one under an unlistable folder is kept', () => {
  const known = [{ path: at('a', 'x.md') }, { path: at('a', 'y.md') }, { path: at('b', 'z.md') }]
  const lost = gone(known, [at('a', 'x.md')], [at('b')])
  expect(lost.map((r) => r.path)).toEqual([at('a', 'y.md')])
  expect(BASE).toBeTruthy()
})
