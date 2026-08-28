// SPDX-License-Identifier: Apache-2.0
import { Manifest } from '@alexia/protocol'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { scaffold, type Answers } from '../src/index.js'

// M3-4. The only thing this scaffold really has to be is *correct*: a first plugin that
// does not load is a first impression nobody recovers from. So the manifest it writes goes
// through the same schema core validates with before it ever spawns a process.

const root = mkdtempSync(join(tmpdir(), 'alexia-scaffold-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const answers: Answers = {
  id: 'coat-check',
  name: 'Coat Check',
  summary: 'Tells you whether to take a coat.',
  tool: 'check_coat',
  license: 'Apache-2.0',
}

test('what it writes validates against the manifest schema core uses', () => {
  const dir = join(root, 'coat-check')
  scaffold(dir, answers)
  const parsed = Manifest.safeParse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  // The rule that catches everybody once: the folder name is the id.
  expect(parsed.success && parsed.data.id).toBe('coat-check')
})

test('the entry point teaches the three rules rather than assuming them', () => {
  const source = readFileSync(join(root, 'coat-check', 'index.js'), 'utf8')
  // No console.log *call* in a file somebody is about to copy from. The comment naming it
  // as the thing not to do is the whole reason the file mentions it at all.
  expect(source).not.toMatch(/^(?!\s*(?:\*|\/\/)).*console\.log\(/m)
  expect(source).toMatch(/stdout is the wire/)
  expect(source).toMatch(/prompt text/)
  expect(source).toMatch(/check_coat/)
})

test('it refuses to overwrite', () => {
  expect(() => scaffold(join(root, 'coat-check'), answers)).toThrow(/already exists/)
})
