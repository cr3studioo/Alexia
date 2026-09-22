// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { bare, stops } from '../slash.js'

// Two patterns, both of which fail quietly when they are wrong: a `/stop` test that is too
// eager swallows an ordinary message, and an `@BotName` suffix left on turns every command
// tapped from the menu into one core has never heard of.

test('stops recognises the command on its own, with a suffix, or with words after it', () => {
  expect(stops('/stop')).toBe(true)
  expect(stops('/stop\n')).toBe(true)
  expect(stops('/STOP')).toBe(true)
  expect(stops('/stop@AlexiaBot')).toBe(true)
  expect(stops('/stop@AlexiaBot please')).toBe(true)
  expect(stops('/stop that')).toBe(true)
})

test('stops leaves alone anything that merely starts with those letters', () => {
  expect(stops('/stopwatch')).toBe(false)
  expect(stops('/stopwatch 5m')).toBe(false)
  expect(stops('stop')).toBe(false)
  expect(stops('please /stop')).toBe(false)
  expect(stops('//stop')).toBe(false)
  expect(stops('')).toBe(false)
  expect(stops(undefined)).toBe(false)
})

test('bare takes the bot name off the command and leaves the rest as typed', () => {
  expect(bare('/status@AlexiaBot')).toBe('/status')
  expect(bare('/new@Alexia_bot')).toBe('/new')
  expect(bare('/remind@AlexiaBot me at 5pm@home')).toBe('/remind me at 5pm@home')
  expect(bare('/HELP@AlexiaBot')).toBe('/HELP')
})

test('bare touches nothing that is not an addressed command', () => {
  expect(bare('/status')).toBe('/status')
  expect(bare('what about bob@example.com?')).toBe('what about bob@example.com?')
  expect(bare('')).toBe('')
  expect(bare(undefined)).toBe('')
})
