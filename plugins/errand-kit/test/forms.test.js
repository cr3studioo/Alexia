// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, expect, test } from 'vitest'
import { fillForm, filledPath, listFields, NO_FIELDS, Refused, scoped } from '../forms.js'

const base = mkdtempSync(join(tmpdir(), 'errand-forms-'))
const root = realpathSync(base)
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A small form made here, so the fixture is the code under test's own kind of PDF. */
async function makeForm(path) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 400])
  const form = doc.getForm()
  form.createTextField('full_name').addToPage(page, { x: 20, y: 340, width: 200, height: 20 })
  form.createTextField('city').addToPage(page, { x: 20, y: 300, width: 200, height: 20 })
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 260, width: 15, height: 15 })
  const pick = form.createDropdown('country')
  pick.addOptions(['Norway', 'Sweden'])
  pick.addToPage(page, { x: 20, y: 220, width: 100, height: 20 })
  writeFileSync(path, await doc.save())
}

async function makeFlat(path) {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  writeFileSync(path, await doc.save())
}

test('lists_fields_of_generated_form', async () => {
  const path = join(root, 'list.pdf')
  await makeForm(path)
  const fields = await listFields(path)
  expect(fields.map((one) => [one.name, one.type])).toEqual([
    ['full_name', 'text'],
    ['city', 'text'],
    ['agree', 'checkbox'],
    ['country', 'dropdown'],
  ])
  expect(fields.find((one) => one.name === 'country').options).toEqual(['Norway', 'Sweden'])
  expect(fields.find((one) => one.name === 'full_name').value).toBe('')
  expect(fields.find((one) => one.name === 'agree').value).toBe(false)
})

test('fills_and_saves_beside_never_overwrites', async () => {
  const path = join(root, 'tax.pdf')
  await makeForm(path)
  const before = readFileSync(path)

  const first = await fillForm(path, { full_name: 'Ada Lovelace', agree: true, country: 'Norway', nope: 'x' })
  expect(first.fillable).toBe(true)
  expect(first.path).toBe(join(root, 'tax (filled).pdf'))
  expect(first.unknown).toEqual(['nope'])
  expect(first.empty).toEqual(['city'])
  // The original is untouched.
  expect(readFileSync(path).equals(before)).toBe(true)

  const filled = await listFields(first.path)
  expect(filled.find((one) => one.name === 'full_name').value).toBe('Ada Lovelace')
  expect(filled.find((one) => one.name === 'agree').value).toBe(true)
  expect(filled.find((one) => one.name === 'country').value).toEqual(['Norway'])

  // A second fill clashes and gets " (2)"; the first copy is left alone.
  const firstBytes = readFileSync(first.path)
  const second = await fillForm(path, { full_name: 'Someone Else' })
  expect(second.path).toBe(join(root, 'tax (filled) (2).pdf'))
  expect(readFileSync(first.path).equals(firstBytes)).toBe(true)
  const third = await fillForm(path, {})
  expect(third.path).toBe(join(root, 'tax (filled) (3).pdf'))
  expect(existsSync(third.path)).toBe(true)

  // A value that is not one of the options is refused and writes nothing.
  await expect(fillForm(path, { country: 'Atlantis' })).rejects.toBeInstanceOf(Refused)
  expect(existsSync(join(root, 'tax (filled) (4).pdf'))).toBe(false)
})

test('flat_pdf_says_no_fields', async () => {
  const path = join(root, 'flat.pdf')
  await makeFlat(path)
  expect(await listFields(path)).toEqual([])
  const result = await fillForm(path, { a: 'b' })
  expect(result).toEqual({ fillable: false })
  expect(NO_FIELDS).toBe('This form has no fillable fields; I can list what it asks for instead.')
  expect(existsSync(join(root, 'flat (filled).pdf'))).toBe(false)
})

test('outside_roots_refused', async () => {
  const inside = join(root, 'inside')
  const outside = mkdtempSync(join(tmpdir(), 'errand-outside-'))
  mkdirSync(inside, { recursive: true })
  try {
    const a = join(inside, 'a.pdf')
    const b = join(outside, 'b.pdf')
    await makeForm(a)
    await makeForm(b)
    expect(await scoped(a, [inside])).toBe(realpathSync(a))
    // The MCP shape: { uri: 'file:///…' }.
    expect(await scoped(a, [{ uri: new URL(`file:///${inside.replace(/\\/g, '/')}`).href }])).toBe(realpathSync(a))
    await expect(scoped(b, [inside])).rejects.toThrow(/outside the folders/)
    await expect(scoped(b, [])).rejects.toThrow(/outside the folders/)
    // A way back out through `..` does not count.
    await expect(scoped(join(inside, '..', '..', 'x', 'b.pdf'), [inside])).rejects.toBeInstanceOf(Refused)
    // Not a PDF, and not there.
    writeFileSync(join(inside, 'n.txt'), 'x')
    await expect(scoped(join(inside, 'n.txt'), [inside])).rejects.toThrow(/PDF/)
    await expect(scoped(join(inside, 'missing.pdf'), [inside])).rejects.toThrow(/not there/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('filled_path_counts_up', () => {
  const taken = new Set([join('d', 'f (filled).pdf'), join('d', 'f (filled) (2).pdf')])
  expect(filledPath(join('d', 'f.pdf'), (p) => taken.has(p))).toBe(join('d', 'f (filled) (3).pdf'))
})
