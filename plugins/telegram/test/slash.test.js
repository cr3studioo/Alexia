// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { bare, isCommand, panels, stops } from '../slash.js'

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

/**
 * The routing decision (D195).
 *
 * This end and core have to agree about what a command is, and the failure when they do not
 * is silent: a line core would have answered as a question, sent down the command path, comes
 * back without history, without being written into the conversation, and capped at a few
 * hundred tokens. Every near-miss below is a line somebody could actually type.
 */

test('isCommand agrees with core about the ordinary commands', () => {
  expect(isCommand('/help')).toBe(true)
  expect(isCommand('/new')).toBe(true)
  expect(isCommand('/cheap')).toBe(true)
  expect(isCommand('/HELP')).toBe(true)
  expect(isCommand('/help me')).toBe(true)
  expect(isCommand('  /help  ')).toBe(true)
  // Namespaced and hyphenated, which is what a plugin's own command looks like.
  expect(isCommand('/commitments.due')).toBe(true)
  expect(isCommand('/new-chat')).toBe(true)
})

test('isCommand refuses what core refuses, so those go down the answer path', () => {
  // A digit after the slash: core reads this as a question, and so must this end.
  expect(isCommand('/2fa reset the code')).toBe(false)
  // Punctuation glued to the name, with no space before the end.
  expect(isCommand('/help!')).toBe(false)
  expect(isCommand('/help?')).toBe(false)
  // A path, which is the other thing a slash starts.
  expect(isCommand('/usr/local/bin')).toBe(false)
  expect(isCommand('//stop')).toBe(false)
  expect(isCommand('/')).toBe(false)
})

test('isCommand refuses anything with a newline in it, because core does', () => {
  // A wrapped prompt that happens to begin with a slash is a question, not a command.
  expect(isCommand('/help\nand also tell me the time')).toBe(false)
})

test('isCommand is false for ordinary words and for nothing at all', () => {
  expect(isCommand('hello')).toBe(false)
  expect(isCommand('')).toBe(false)
  expect(isCommand('   ')).toBe(false)
  expect(isCommand(undefined)).toBe(false)
})

test('bare and isCommand are used in that order, which is what makes a menu tap work', () => {
  // `/status@AlexiaBot` is not a command until the suffix comes off — the `@` is not in
  // core's pattern, so asking in the other order routes a tapped menu entry to the model.
  expect(isCommand('/status@AlexiaBot')).toBe(false)
  expect(isCommand(bare('/status@AlexiaBot'))).toBe(true)
})

/**
 * `/panel` (D196) — the other command core has never heard of, and held to the same
 * whole-word test for the same reason: one that is slightly too eager is a command that eats
 * an ordinary message, and this one would eat it and reply with a keyboard button.
 */

test('panels recognises the command on its own, with a suffix, or with words after it', () => {
  expect(panels('/panel')).toBe(true)
  expect(panels('/PANEL')).toBe(true)
  expect(panels('/panel\n')).toBe(true)
  expect(panels('/panel@AlexiaBot')).toBe(true)
  expect(panels('/panel please')).toBe(true)
})

test('panels leaves alone anything that merely starts with those letters', () => {
  expect(panels('/panels of the jury')).toBe(false)
  expect(panels('/panelling')).toBe(false)
  expect(panels('panel')).toBe(false)
  expect(panels('open the /panel')).toBe(false)
  expect(panels('')).toBe(false)
  expect(panels(undefined)).toBe(false)
})

test('the two Telegram-only commands do not answer for each other', () => {
  expect(stops('/panel')).toBe(false)
  expect(panels('/stop')).toBe(false)
})
