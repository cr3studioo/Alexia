import { expect, test } from 'vitest'
import { files, scan, shippedSource } from './_repo.js'

// Defends: Alexia.md, "/local and Telegram contradict each other". Local mode means the
// model runs on your machine. It does not mean your words stay there — Telegram alone
// disproves that. One tooltip claiming more breaks a promise the whole project rests on,
// so the claim is a test rather than a habit.

const OVERCLAIM = new RegExp(
  [
    String.raw`n(?:othing|o data|o text|o audio)[^.!?\n]{0,30}\b(?:ever\s+)?leaves\b`,
    String.raw`\bnever\s+leaves\b`,
    String.raw`\bstays?\s+(?:entirely\s+|completely\s+|fully\s+)?on\s+(?:your|this)\s+(?:computer|machine|device|pc)`,
    String.raw`\b(?:completely|totally|fully|entirely|100%)\s+(?:private|offline|local|secure|anonymous)`,
    String.raw`\bnothing\s+is\s+(?:sent|uploaded|shared|transmitted)`,
    String.raw`\bno\s+data\s+is\s+(?:sent|uploaded|shared|collected)`,
    String.raw`\byour\s+data\s+never\b`,
    String.raw`\b(?:total|complete|absolute)\s+privacy\b`,
  ].join('|'),
  'i',
)

// README.md is the first user-facing string anyone reads, so it is held to the same rule.
const USER_FACING = [...shippedSource, 'README.md']

test('no-overclaiming-strings: nothing claims more privacy than Alexia delivers', () => {
  const found = scan(USER_FACING, OVERCLAIM)
  expect(
    found,
    `say what actually happens — the model runs here — and nothing more:\n${found.join('\n')}`,
  ).toEqual([])
})

test('no-overclaiming-strings: the check itself catches the tooltip', () => {
  // The exact sentence Alexia.md names as the one that breaks the promise.
  expect('Nothing leaves your computer.').toMatch(OVERCLAIM)
  expect('Your voice never leaves this machine').toMatch(OVERCLAIM)
  expect('Local mode is completely private').toMatch(OVERCLAIM)
  expect('No data is sent anywhere').toMatch(OVERCLAIM)
  expect('Everything stays on your device').toMatch(OVERCLAIM)

  // What Alexia is allowed to say instead: what actually happens.
  expect('Local mode: the model runs on your machine.').not.toMatch(OVERCLAIM)
  expect('This conversation crossed Telegram servers.').not.toMatch(OVERCLAIM)
})

test('no-overclaiming-strings: the scanner is actually reading files', () => {
  // Guards the worst failure mode of every check in this folder: a glob that matches
  // nothing passes silently, forever, and looks exactly like a clean repo.
  expect(files(USER_FACING).map((f) => f.path)).toContain('README.md')
})
