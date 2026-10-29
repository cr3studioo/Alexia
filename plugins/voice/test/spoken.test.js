// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { REPLY_MODES, aloud, replyMode, speaksReply } from '../spoken.js'

/**
 * *Answer out loud*: when an answer is read out without anybody asking, and what is read.
 */

test('the default is to answer the way the question came in', () => {
  expect(replyMode({})).toBe('mirror')
  expect(replyMode({ speak_replies: 'sometimes' })).toBe('mirror')
  for (const mode of REPLY_MODES) expect(replyMode({ speak_replies: mode })).toBe(mode)
})

test('spoken questions get spoken answers, typed ones do not, unless the person chose otherwise', () => {
  expect(speaksReply('mirror', { heard: true })).toBe(true)
  expect(speaksReply('mirror', { heard: false })).toBe(false)
  expect(speaksReply('always', { heard: false })).toBe(true)
  expect(speaksReply('never', { heard: true })).toBe(false)
})

test('an answer the model already said out loud is not said a second time', () => {
  expect(speaksReply('always', { heard: true, spoke: true })).toBe(false)
  expect(speaksReply('mirror', { heard: true, spoke: true })).toBe(false)
})

test('Markdown is made into something worth hearing', () => {
  const said = aloud(
    '## Plan\n\n- **First** check the [docs](https://example.com/docs)\n- Run `pnpm test`\n\n```ts\nconst x = 1\n```\nSee https://example.com too.',
  )
  expect(said).not.toMatch(/[#*`[\]]/)
  expect(said).toContain('First check the docs')
  expect(said).toContain('Run pnpm test')
  expect(said).toContain('There is some code on the screen.')
  expect(said).not.toContain('const x')
  expect(said).toContain('See a link on the screen too.')
})

test('the manifest offers the three choices this file knows, and provides the capability core hands answers to', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8'))
  const setting = manifest.settings.find((one) => one.key === 'speak_replies')
  expect(setting.options.map((one) => one.value)).toEqual(REPLY_MODES)
  expect(setting.default).toBe(replyMode({}))
  expect(manifest.provides).toContain('reply.finished')
})
