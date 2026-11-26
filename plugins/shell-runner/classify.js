// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The read-only classifier: the one door through which a command runs without the owner being
 * asked. **When in doubt it says no** — a refusal here only means the owner is asked first.
 *
 * A command passes when its first word (two for git) is on {@link READ_ONLY} and the whole of it
 * is plain ASCII from a short list of characters. That list leaves out everything either shell
 * uses to start a second command or to compute an argument: `; | & > <`, backticks, `$`, brackets
 * that group or evaluate (`( ) { }`), `@`, `!`, `#`, newlines and every other control character.
 * Anything outside ASCII is refused too, so no Unicode look-alike of those (a full-width `；`,
 * PowerShell's curly quotes and dashes) can slip by.
 */

/** The commands that may run unasked, as the owner would type them. Matched without case. */
export const READ_ONLY = [
  'Get-ChildItem',
  'Get-Content',
  'Get-Process',
  'Get-Service',
  'Test-Path',
  'ls',
  'cat',
  'pwd',
  'whoami',
  'git status',
  'git log',
  'git diff',
  'df',
  'du',
  'ps',
  'uname',
  'which',
  'where',
]

/** Characters a read-only command may contain: letters, digits, a space and plain punctuation. */
const ALLOWED = /^[A-Za-z0-9 ._\-/\\:=,+~*?%'"[\]]*$/

/** What the spec names, said back when one is found (also caught by {@link ALLOWED}). */
const NAMED = [
  [';', 'a ;'],
  ['|', 'a |'],
  ['&', 'an &'],
  ['>', 'a >'],
  ['<', 'a <'],
  ['`', 'a backtick'],
  ['$(', 'a $('],
  ['\n', 'a new line'],
  ['\r', 'a new line'],
]

/** git options that write a file or run another program. */
const GIT_REFUSED = /^--?(output|ext-diff|textconv|open-files-in-pager|exec|upload-pack|receive-pack|config-env|paginate)(=|$)/i

const no = (why) => ({ ok: false, why })

/**
 * Is `command` read-only? `{ ok: true, command, git }` gives the command to run (git commands get
 * `--no-ext-diff --no-textconv` put in, so a repository's own settings cannot start a program);
 * `{ ok: false, why }` says in plain words why it needs asking.
 */
export function readOnly(command) {
  if (typeof command !== 'string') return no('There was no command.')
  for (const [mark, name] of NAMED) {
    if (command.includes(mark)) return no(`It has ${name} in it, which could run something else.`)
  }
  // Checked before trimming: a tab or a stray control character is refused, not stripped.
  if (!ALLOWED.test(command)) return no('It has a character that is not on the read-only list.')
  // Two backslashes start a network path on Windows (\\server\share), and // can too.
  if (command.includes('\\\\')) return no('It names a network path.')
  const words = command.trim().split(/ +/)
  if (words[0] === '') return no('There was no command.')
  if (words.some((w) => w.startsWith('//'))) return no('It names a network path.')
  // -ComputerName (and its prefixes and alias -Cn) points a Get-* cmdlet at another computer.
  if (words.some((w) => /^-c[no]/i.test(w))) return no('It may reach another computer.')

  const first = words[0].toLowerCase()
  const two = words.length > 1 ? `${first} ${words[1].toLowerCase()}` : first
  const listed = READ_ONLY.find((r) => r.toLowerCase() === two || r.toLowerCase() === first)
  if (!listed) return no(`${words[0]} is not on the read-only list.`)
  if (first !== 'git') return { ok: true, command: words.join(' '), git: false }

  if (listed === 'git') return no('Only git status, git log and git diff are read-only.')
  if (words.slice(2).some((w) => GIT_REFUSED.test(w.replace(/^['"]|['"]$/g, '')))) {
    return no('That git option can write a file or run another program.')
  }
  // git status runs no diff driver; log and diff can, so both are switched off explicitly.
  const safety = words[1].toLowerCase() === 'status' ? [] : ['--no-ext-diff', '--no-textconv']
  return { ok: true, command: [words[0], words[1], ...safety, ...words.slice(2)].join(' '), git: true }
}

/**
 * git reads settings from the repository it runs in, and a repository can name a program for
 * git to run (`core.fsmonitor`, `diff.external`, a pager). Given to a read-only git command's
 * environment, these override the repository's own.
 */
export const GIT_SAFE_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'diff.external',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'core.pager',
  GIT_CONFIG_VALUE_2: 'cat',
  GIT_CONFIG_KEY_3: 'core.untrackedCache',
  GIT_CONFIG_VALUE_3: 'false',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
}
