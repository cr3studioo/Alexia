// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { speaks, voiceMode } from '../reply.js'

// The setting used to be a toggle; now it is a three-way choice, and an old install's
// `voice_notes: true` has to keep meaning what it always meant. That migration, and the six
// combinations of mode and how the question arrived, are the whole of this file's logic.

test('the new setting wins when it is one of the three modes', () => {
  expect(voiceMode({ voice_replies: 'never' })).toBe('never')
  expect(voiceMode({ voice_replies: 'mirror' })).toBe('mirror')
  expect(voiceMode({ voice_replies: 'always' })).toBe('always')
})

test('an old voice_notes: true migrates to always', () => {
  expect(voiceMode({ voice_notes: true })).toBe('always')
})

test('an old voice_notes: false, or nothing at all, is mirror', () => {
  expect(voiceMode({ voice_notes: false })).toBe('mirror')
  expect(voiceMode({})).toBe('mirror')
  expect(voiceMode(undefined)).toBe('mirror')
})

test('a nonsense value for the new setting does not win over the old toggle', () => {
  expect(voiceMode({ voice_replies: 'sometimes', voice_notes: true })).toBe('always')
  expect(voiceMode({ voice_replies: 'sometimes' })).toBe('mirror')
})

test('speaks: always is always, whatever the question was', () => {
  expect(speaks('always', true)).toBe(true)
  expect(speaks('always', false)).toBe(true)
})

test('speaks: never is never, whatever the question was', () => {
  expect(speaks('never', true)).toBe(false)
  expect(speaks('never', false)).toBe(false)
})

test('speaks: mirror matches how the question arrived', () => {
  expect(speaks('mirror', true)).toBe(true)
  expect(speaks('mirror', false)).toBe(false)
})
