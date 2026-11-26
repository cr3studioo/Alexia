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

/**
 * A network path: two slashes or backslashes in any mix (Windows reads `/` as `\`), which start a
 * UNC path at the beginning of an argument, after a quote, or after the `:` `=` `,` PowerShell
 * uses to glue a value to a parameter or to list several; and `\??\`, Windows' own spelling of
 * one. A doubled slash means nothing a read-only command needs, so it is refused anywhere.
 */
const NETWORK = /[\\/][\\/]|[\\/]\?\?[\\/]/

/**
 * git options that write a file, run another program, check a signature (which runs gpg), go into
 * a submodule (whose own settings were not looked at) or undo one of the safety options put in.
 * Matched on the option's name and on any shortening of it, since git accepts a long option cut
 * short as long as it stays unique.
 */
const GIT_REFUSED = [
  'output',
  'ext-diff',
  'textconv',
  'open-files-in-pager',
  'exec',
  'upload-pack',
  'receive-pack',
  'config-env',
  'paginate',
  'show-signature',
  'submodule',
  'recurse-submodules',
  'ignore-submodules',
  'git-dir',
  'work-tree',
  'attr-source',
]

/** Is `word` (its quotes taken off) one of {@link GIT_REFUSED}, or short for one? */
function gitRefused(word) {
  const m = /^(--?)([A-Za-z][A-Za-z0-9-]*)/.exec(word)
  if (!m) return false
  const name = m[2].toLowerCase()
  // A single dash is a short option (-p, -n 5): only a long option may be shortened.
  if (m[1] === '-') return GIT_REFUSED.some((refused) => name.startsWith(refused))
  return GIT_REFUSED.some((refused) => refused.startsWith(name) || name.startsWith(refused))
}

const no = (why) => ({ ok: false, why })

/**
 * Is `command` read-only? `{ ok: true, command, git }` gives the command to run (git commands get
 * `--no-pager`, `--ignore-submodules=all` and, for log and diff, `--no-ext-diff --no-textconv`
 * put in, so a repository's own settings cannot start a program); `{ ok: false, why }` says in
 * plain words why it needs asking.
 */
export function readOnly(command) {
  if (typeof command !== 'string') return no('There was no command.')
  for (const [mark, name] of NAMED) {
    if (command.includes(mark)) return no(`It has ${name} in it, which could run something else.`)
  }
  // Checked before trimming: a tab or a stray control character is refused, not stripped.
  if (!ALLOWED.test(command)) return no('It has a character that is not on the read-only list.')
  if (NETWORK.test(command)) return no('It names a network path, which could reach another computer.')
  const words = command.trim().split(/ +/)
  if (words[0] === '') return no('There was no command.')
  // -ComputerName (and its prefixes and alias -Cn) points a Get-* cmdlet at another computer.
  if (words.some((w) => /^['"]*-c[no]/i.test(w))) return no('It may reach another computer.')

  const first = words[0].toLowerCase()
  const two = words.length > 1 ? `${first} ${words[1].toLowerCase()}` : first
  const listed = READ_ONLY.find((r) => r.toLowerCase() === two || r.toLowerCase() === first)
  if (!listed) return no(`${words[0]} is not on the read-only list.`)
  if (first !== 'git') return { ok: true, command: words.join(' '), git: false }

  if (listed === 'git') return no('Only git status, git log and git diff are read-only.')
  if (words.slice(2).some((w) => gitRefused(w.replace(/^['"]+|['"]+$/g, '')))) {
    return no('That git option can write a file, run another program or check a signature.')
  }
  // %G… in a format asks git to check each commit's signature, which runs gpg.
  if (command.includes('%G')) return no('That format checks signatures, which runs another program.')
  const sub = words[1].toLowerCase()
  const safety = ['--ignore-submodules=all', ...(sub === 'status' ? [] : ['--no-ext-diff', '--no-textconv'])]
  return { ok: true, command: [words[0], '--no-pager', words[1], ...safety, ...words.slice(2)].join(' '), git: true }
}

/**
 * The settings by which a repository can make git run a program, and what they are set to. They
 * reach git through its environment (`GIT_CONFIG_KEY_n`), which outranks every settings file, the
 * repository's own `.git/config` included. The signature programs are pointed at git itself,
 * which only answers that it does not know gpg's options; signatures are not checked anyway.
 */
export const GIT_SAFE_CONFIG = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.untrackedCache', 'false'],
  ['diff.external', ''],
  ['diff.ignoreSubmodules', 'all'],
  ['diff.submodule', 'short'],
  ['status.submoduleSummary', 'false'],
  ['submodule.recurse', 'false'],
  ['log.showSignature', 'false'],
  ['format.pretty', 'medium'],
  ['gpg.program', 'git'],
  ['gpg.openpgp.program', 'git'],
  ['gpg.ssh.program', 'git'],
  ['gpg.x509.program', 'git'],
]

/** The most settings handed to git; a repository naming more drivers than this is refused. */
export const MOST_GIT_SETTINGS = 200

/**
 * The settings a repository names that could run a program, read from `git config --list -z`
 * (each entry `key`, a new line, the value, a NUL), each with the value that switches it off:
 * every filter driver (`clean`, `smudge`, `process`, which git status and diff run), every diff
 * driver (`textconv`, `command`) and every named format (`pretty.<name>`, which could ask for a
 * signature check).
 */
export function gitDriverSettings(listing) {
  const out = []
  for (const entry of String(listing ?? '').split('\0')) {
    const key = entry.split('\n', 1)[0].trim()
    let m
    if ((m = /^filter\..+\.(clean|smudge|process|required)$/i.exec(key))) out.push([key, m[1].toLowerCase() === 'required' ? 'false' : ''])
    else if (/^diff\..+\.(textconv|command)$/i.test(key)) out.push([key, ''])
    else if (/^pretty\..+$/i.test(key)) out.push([key, 'medium'])
  }
  return out
}

/**
 * What a read-only git command gets on top of the minimal environment: no system settings, no
 * pager, no optional locks (git status would otherwise rewrite the index), no fetching of missing
 * objects, and {@link GIT_SAFE_CONFIG} plus `extra` (from {@link gitDriverSettings}).
 */
export function gitSafeEnv(extra = []) {
  const settings = [...GIT_SAFE_CONFIG, ...extra]
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
  }
  settings.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return env
}

/** {@link gitSafeEnv} with nothing extra. */
export const GIT_SAFE_ENV = gitSafeEnv()
