// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField } from 'pdf-lib'

/**
 * Reading and filling PDF forms over pdf-lib. Local and reversible: a filled copy is written
 * beside the original, never over it, and nothing here sends a form anywhere.
 * Field names and values are returned to the caller but never logged.
 */

export const NO_FIELDS = 'This form has no fillable fields; I can list what it asks for instead.'

export class Refused extends Error {}

const rootPath = (root) => {
  const value = typeof root === 'string' ? root : root?.uri
  if (typeof value !== 'string') return undefined
  return value.startsWith('file:') ? fileURLToPath(value) : value
}

/** The real path of `path`, only if it is a PDF inside one of `roots` (MCP roots). */
export async function scoped(path, roots) {
  const wanted = String(path ?? '').trim()
  if (wanted === '') throw new Refused('Which form? This needs a path.')
  if (extname(wanted).toLowerCase() !== '.pdf') throw new Refused('This only works on PDF files.')
  let real
  try {
    real = await realpath(wanted)
  } catch {
    throw new Refused('That file is not there.')
  }
  for (const root of roots ?? []) {
    const raw = rootPath(root)
    if (raw === undefined) continue
    let base
    try {
      base = await realpath(raw)
    } catch {
      continue
    }
    const tail = relative(base, real)
    if (tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))) return real
  }
  throw new Refused('That file is outside the folders you have opened in Alexia.')
}

function kindOf(field) {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'checkbox'
  if (field instanceof PDFDropdown) return 'dropdown'
  if (field instanceof PDFRadioGroup) return 'radio'
  if (field instanceof PDFOptionList) return 'list'
  if (field instanceof PDFSignature) return 'signature'
  return 'other'
}

function valueOf(field) {
  if (field instanceof PDFTextField) return field.getText() ?? ''
  if (field instanceof PDFCheckBox) return field.isChecked()
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected()
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? ''
  return ''
}

const optionsOf = (field) =>
  field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup ? field.getOptions() : undefined

async function load(path) {
  return PDFDocument.load(await readFile(path), { updateMetadata: false })
}

/** The fillable fields of a PDF: `[{ name, type, options?, value }]`. Empty for a flat one. */
export async function listFields(path) {
  const doc = await load(path)
  return doc.getForm().getFields().map((field) => {
    const options = optionsOf(field)
    return { name: field.getName(), type: kindOf(field), ...(options !== undefined && { options }), value: valueOf(field) }
  })
}

/** `<name> (filled).pdf`, then `(filled) (2)`, `(3)`… the first that does not exist. */
export function filledPath(path, exists = existsSync) {
  const dir = dirname(path)
  const stem = basename(path, extname(path))
  let candidate = join(dir, `${stem} (filled).pdf`)
  for (let n = 2; exists(candidate); n += 1) candidate = join(dir, `${stem} (filled) (${String(n)}).pdf`)
  return candidate
}

function apply(field, value) {
  if (field instanceof PDFTextField) {
    field.setText(String(value))
  } else if (field instanceof PDFCheckBox) {
    const on = value === true || (typeof value === 'string' && /^(true|yes|on|1|x)$/i.test(value.trim()))
    if (on) field.check()
    else field.uncheck()
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const options = field.getOptions()
    const wanted = Array.isArray(value) ? value.map(String) : [String(value)]
    if (!wanted.every((one) => options.includes(one))) throw new Refused(`"${field.getName()}" is one of: ${options.join(', ')}.`)
    field.select(wanted.length === 1 ? wanted[0] : wanted)
  } else if (field instanceof PDFRadioGroup) {
    const options = field.getOptions()
    if (!options.includes(String(value))) throw new Refused(`"${field.getName()}" is one of: ${options.join(', ')}.`)
    field.select(String(value))
  } else {
    throw new Refused(`"${field.getName()}" cannot be filled in.`)
  }
}

const isEmpty = (field) => {
  const value = valueOf(field)
  return Array.isArray(value) ? value.length === 0 : value === '' || value === false
}

/**
 * Fill `values` ({ fieldName: value }) and write a new copy beside `path`. Returns the new
 * path, which names were not found, and which fields are still empty.
 */
export async function fillForm(path, values) {
  const doc = await load(path)
  const form = doc.getForm()
  const fields = form.getFields()
  if (fields.length === 0) return { fillable: false }
  const unknown = []
  for (const [name, value] of Object.entries(values ?? {})) {
    const field = fields.find((one) => one.getName() === name)
    if (field === undefined) unknown.push(name)
    else apply(field, value)
  }
  const target = filledPath(path)
  await writeFile(target, await doc.save(), { flag: 'wx' })
  return {
    fillable: true,
    path: target,
    unknown,
    empty: form.getFields().filter((one) => kindOf(one) !== 'signature' && isEmpty(one)).map((one) => one.getName()),
  }
}
