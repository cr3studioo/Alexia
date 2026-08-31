// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_CAPABILITIES } from '@alexia/protocol'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { Store } from '../src/store.js'
import { stage } from './staged.js'

/**
 * **A second plugin makes the first one's refusal stop being true — and taking it away puts
 * the refusal back, word for word.**
 *
 * `plugins/documents` reads a text layer and refuses a scan, in a sentence naming what is
 * missing. `plugins/ocr` is what was missing. The two never learn about each other: one
 * declares `image.ocr` in `requires`, the other `provides` it, and core resolves the name.
 *
 * This is invariant 4 in the direction nobody usually tests it. The famous version is *delete
 * the provider and the consumer keeps running*, which `vanisher` covers. This is the sharper
 * half: **delete the provider and the consumer goes back to the exact sentence it shipped
 * with**, rather than to a degraded one, a stack trace, or an empty answer. The two suites
 * below are the same plugin with and without a neighbour, and the assertion is that the
 * second one's output is unchanged from the day before the neighbour existed.
 */

const store = new Store(':memory:')
const files = mkdtempSync(join(tmpdir(), 'alexia-ocr-'))
const data = () => mkdtempSync(join(tmpdir(), 'alexia-ocr-data-'))

/** The same plugin, twice: once with something that reads pictures, once without. */
const withOcr = new Plugins({ dir: stage('documents', 'ocr'), store, dataDir: data() })
const alone = new Plugins({ dir: stage('documents'), store: new Store(':memory:'), dataDir: data() })
for (const set of [withOcr, alone]) {
  set.load()
  for (const id of set.ids) set.enable(id)
}

afterAll(async () => {
  await Promise.all([withOcr.stop(), alone.stop()])
  store.close()
  rmSync(files, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const textOf = (answered: { content: { type: string; text?: string }[] }): string =>
  answered.content
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n')
    .trim()

/** The scan a browser printed, copied where a plugin can open it. */
const scanned = ((): string => {
  const from = join(import.meta.dirname, '..', '..', '..', 'plugins', 'documents', 'test', 'scanned-page.pdf')
  const path = join(files, 'statement.pdf')
  writeFileSync(path, readFileSync(from))
  return path
})()

test('with nothing that reads pictures, a scan is refused in the words it always used', async () => {
  const answered = await alone.capability(CORE_CAPABILITIES.extract, { file: scanned })
  expect(answered.isError).toBe(true)
  // Not softened, not rephrased, and not a failure: it names which wall this is and what
  // would get past it. This is the sentence a machine with no OCR plugin still gets.
  expect(textOf(answered)).toMatch(/no text layer — it is a picture of a document/)
  expect(textOf(answered)).toMatch(/needs OCR/)
}, 30_000)

test('with one installed, the same scan comes back as what it says', async () => {
  const answered = await withOcr.capability(CORE_CAPABILITIES.extract, { file: scanned })

  if (process.platform === 'win32') {
    // The whole chain, across two plugin processes and a capability name: the text layer
    // refused, the page pulled out of the PDF as the JPEG it already was, handed over as
    // bytes because it was never a file, recognised, and sorted back into reading order.
    expect(answered.isError ?? false).toBe(false)
    expect(textOf(answered)).toMatch(/NORTHWIND TRADING/)
    expect(textOf(answered)).toMatch(/Closing balance\s+659\.50/)
    // The two-column line, still one line. Unsorted, the engine returns the period five
    // lines from the account it belongs to, and nothing anywhere would say so.
    expect(textOf(answered)).toMatch(/Account 88213\s+Period March 2026/)
  } else {
    // Windows only so far, and that is a sentence rather than a silence.
    expect(answered.isError).toBe(true)
    expect(textOf(answered)).toContain(process.platform)
  }
}, 60_000)

test('a picture reaches whatever reads pictures, by name, with no plugin named anywhere', async () => {
  const answered = await withOcr.capability('image.ocr', { file: scanned })
  // A PDF is not a picture, so this is the reader's own refusal rather than a crash — and
  // the point of the call is that it resolved at all. No caller here said `ocr`.
  expect(answered.isError).toBe(true)
  expect(Object.keys(answered)).not.toContain('provider')
}, 60_000)

test('nothing provides it on the machine without it, and that is a clean answer', async () => {
  // `-32050`, which `plugins/documents` reads as *this machine has no OCR* and turns back
  // into its own sentence rather than passing a protocol error to a person.
  await expect(alone.capability('image.ocr', { file: scanned })).rejects.toThrow(/nothing enabled provides/)
})
