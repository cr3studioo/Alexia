import { expect, test } from 'vitest'
import { scan, shippedSource } from './_repo.js'

// Defends: Windows first, portable by discipline. An absolute path baked into a string
// is the cheapest way to make the Ubuntu CI job — and every user who is not you — fail.

const ABSOLUTE_PATH_LITERAL = new RegExp(
  [
    /['"`][A-Za-z]:[\\/]/, //                          "C:\  or  "C:/
    /['"`]\/(?:home|Users|tmp|var|etc|opt)\//, //      "/home/…
    /['"`]~\//, //                                     "~/.alexia
    /%(?:APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES)%/,
    /\$(?:HOME|APPDATA)\b/,
  ]
    .map((r) => r.source)
    .join('|'),
)

// A separator inside a string literal, glued to something else. `join()` and `resolve()`
// exist precisely so this never has to be written by hand.
const HAND_BUILT_SEPARATOR = new RegExp(
  [
    /['"`][^'"`\n]*\\\\[^'"`\n]*['"`]\s*\+/, //  "a\b" + …
    /\+\s*['"`]\\\\/, //                         … + "\"
  ]
    .map((r) => r.source)
    .join('|'),
)

test('no-hardcoded-paths: no absolute path literals in shipped source', () => {
  const found = scan(shippedSource, ABSOLUTE_PATH_LITERAL)
  expect(
    found,
    `use the paths alexia/host/info hands you, not a literal:\n${found.join('\n')}`,
  ).toEqual([])
})

test('no-hardcoded-paths: no hand-built path separators', () => {
  const found = scan(shippedSource, HAND_BUILT_SEPARATOR)
  expect(found, `use node:path join/resolve:\n${found.join('\n')}`).toEqual([])
})

test('no-hardcoded-paths: the checks themselves catch a real path', () => {
  // A check that has never seen a violation is a comment. These are the violations.
  expect(String.raw`const p = "C:\\Users\\vacla\\alexia"`).toMatch(ABSOLUTE_PATH_LITERAL)
  expect(`const p = '/home/user/.alexia'`).toMatch(ABSOLUTE_PATH_LITERAL)
  expect('const p = "~/.alexia"').toMatch(ABSOLUTE_PATH_LITERAL)
  expect('const p = "%APPDATA%/alexia"').toMatch(ABSOLUTE_PATH_LITERAL)
  expect(String.raw`const p = dir + "\\" + name`).toMatch(HAND_BUILT_SEPARATOR)

  const good = `const p = join(hostInfo.dataDir, 'alexia.db')`
  expect(good).not.toMatch(ABSOLUTE_PATH_LITERAL)
  expect(good).not.toMatch(HAND_BUILT_SEPARATOR)
})
