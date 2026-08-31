// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_CAPABILITIES } from '@alexia/protocol'
import { afterAll, expect, test } from 'vitest'
import { Plugins } from '../src/plugins.js'
import { Store } from '../src/store.js'
import { stage } from './staged.js'

/**
 * **File in, markdown out, across the wire** — the answer to *not every model can read a
 * document*, which is the answer already given to *not every model can hear*.
 *
 * What this proves that the plugin's own suite cannot: the capability is resolved **by name**,
 * the reading crosses a process boundary, and the refusal for a picture crosses it as a
 * refusal rather than as an empty string. Nothing here names a plugin except the staging line,
 * which is what every test in this folder does to get one on disk.
 */

const dir = stage('documents')
const files = mkdtempSync(join(tmpdir(), 'alexia-documents-'))
const store = new Store(':memory:')
const plugins = new Plugins({ dir, store, dataDir: mkdtempSync(join(tmpdir(), 'alexia-documents-data-')) })
plugins.load()
// Installed is files on disk; enabled is a person having said yes (M2-5).
for (const id of plugins.ids) plugins.enable(id)

afterAll(async () => {
  await plugins.stop()
  store.close()
  rmSync(files, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const wrote = (name: string, bytes: Buffer | string): string => {
  const path = join(files, name)
  writeFileSync(path, bytes)
  return path
}

const textOf = (answered: { content: { type: string; text?: string }[] }): string =>
  answered.content
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n')
    .trim()

test('a document read by capability name, with core never learning who answered', async () => {
  const file = wrote('rent.csv', 'Item,Amount\nRent,18500\nDeposit,37000\n')
  const answered = await plugins.capability(CORE_CAPABILITIES.extract, { file })
  expect(answered.isError ?? false).toBe(false)
  expect(textOf(answered)).toBe(
    '| Item | Amount |\n| --- | --- |\n| Rent | 18500 |\n| Deposit | 37000 |',
  )
  // There is no `provider` field on that result and no method to ask for one. A second
  // extractor offering the same name is a drop-in, and this is what makes that true.
  expect(Object.keys(answered)).not.toContain('provider')
})

test('a picture is refused across the wire as a refusal, not as an empty answer', async () => {
  // The failure this whole shape is designed against: an extractor that returns nothing for a
  // screenshot has not failed as far as any caller can tell, and the model then answers
  // confidently about a document nobody read.
  const png = wrote('screenshot.png', Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\n'), Buffer.alloc(64)]))
  const answered = await plugins.capability(CORE_CAPABILITIES.extract, { file: png })
  expect(answered.isError).toBe(true)
  expect(textOf(answered)).toMatch(/picture/)
  // And it names both of the jobs it is not doing, because they have different answers.
  expect(textOf(answered)).toMatch(/OCR/)
})

test('a file that is not there says so in a sentence somebody can act on', async () => {
  const answered = await plugins.capability(CORE_CAPABILITIES.extract, { file: join(files, 'nowhere.pdf') })
  expect(answered.isError).toBe(true)
  expect(textOf(answered)).toMatch(/There is no file at/)
})
