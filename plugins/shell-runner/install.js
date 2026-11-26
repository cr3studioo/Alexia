// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Refused } from './shell.js'

/**
 * Installing a program from the platform's own package manager: winget on Windows, Homebrew on a
 * Mac. Every program is started directly with its arguments as a list, never through a shell, so
 * nothing in a program's name is ever read as a command.
 *
 * winget is asked in three steps: `search` finds the package, `show` gives its publisher, and only
 * then `install --id <id> -e`, so what is installed is the exact package the result names. Only a
 * package whose id or name is exactly what was asked for is ever installed.
 *
 * **The owner approves the publisher before anything is installed.** An install names the
 * publisher in its own arguments (`publisher`), which is what the owner sees when asked; without
 * it, or when it is not the package's publisher, nothing is installed and the answer says who
 * publishes it, so the install can be asked for again with the publisher in it.
 */

export const SOURCES = ['winget', 'brew']
/** The longest an install may take. */
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000
/** The longest a search or a look-up may take. */
const LOOKUP_TIMEOUT_MS = 120 * 1000

const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const BREW_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+/-]{0,127}$/
const COMMON = ['--accept-source-agreements', '--disable-interactivity']

/** The device's own package manager, or undefined. */
export const defaultSource = (platform = process.platform) => (platform === 'win32' ? 'winget' : platform === 'darwin' ? 'brew' : undefined)

/** Where Homebrew puts brew on Apple silicon and on Intel Macs, built from their parts. */
export const BREW_PLACES = [join(sep, 'opt', 'homebrew', 'bin', 'brew'), join(sep, 'usr', 'local', 'bin', 'brew')]

/** Where brew is: an app started from the Dock does not have it on PATH. */
export function brewPath(exists = existsSync) {
  return BREW_PLACES.find((p) => exists(p)) ?? 'brew'
}

/** The systems installs work on. */
const SUPPORTED = ['win32', 'darwin']

const folded = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** Is `said` the publisher `actual`, ignoring case and spacing? An unknown publisher never is. */
export function samePublisher(said, actual) {
  if (typeof said !== 'string' || typeof actual !== 'string' || actual.trim() === '') return false
  return folded(said) === folded(actual)
}

/** What winget prints after its spinner: the text after the last carriage return of each line. */
const clean = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part.trim() !== '').at(-1) ?? '')

/**
 * The rows of a winget table (`search`, `list`): `[{ name, id, version, source }]`. Columns are
 * found from where the header's words start, since a name can hold spaces.
 */
export function parseWingetTable(text) {
  const lines = clean(text)
  const rule = lines.findIndex((line) => /^-{5,}\s*$/.test(line))
  if (rule < 1) return []
  const header = lines[rule - 1]
  const starts = [...header.matchAll(/\S+/g)].map((m) => m.index)
  if (starts.length < 3) return []
  const rows = []
  for (const line of lines.slice(rule + 1)) {
    if (line.trim() === '') continue
    const cells = starts.map((start, i) => line.slice(start, starts[i + 1] ?? line.length).trim())
    const [name, id, version] = cells
    if (!id || !WINGET_ID.test(id)) continue
    rows.push({ name, id, version, source: cells.at(-1) ?? '' })
  }
  return rows
}

/** `Key: value` lines of `winget show`. */
export function parseWingetShow(text) {
  const out = {}
  for (const line of clean(text)) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line)
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].trim()
  }
  return { publisher: out.publisher || undefined, version: out.version || undefined, name: out.found || undefined }
}

/**
 * The one package whose id, or else whose name, is exactly `name` (without case), or undefined.
 * A lone search hit called something else is not it: winget search also matches on tags,
 * monikers and parts of names.
 */
export function choose(rows, name) {
  const want = name.trim().toLowerCase()
  const byId = rows.filter((r) => r.id.toLowerCase() === want)
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) return undefined
  const byName = rows.filter((r) => r.name.trim().toLowerCase() === want)
  return byName.length === 1 ? byName[0] : undefined
}

/** How many near hits are looked up for their publisher when none matches exactly. */
const MOST_LISTED = 5

/**
 * @param {object} deps
 * @param {(file: string, args: string[], opts: { timeoutMs: number, signal?: AbortSignal, onOutput?: Function }) => Promise<{ exit: number|null, stdout: string, stderr: string, error?: string, cancelled?: boolean, timedOut?: boolean }>} deps.exec
 * @param {string} [deps.platform]
 * @param {() => string} [deps.brew]  where brew is
 */
export function createInstaller({ exec, platform = process.platform, brew = () => brewPath() }) {
  function sourceOf(source) {
    if (!SUPPORTED.includes(platform)) {
      throw new Refused(`Installing programs is not supported on this computer’s system (${platform}), only on Windows (winget) and macOS (Homebrew).`)
    }
    const chosen = source ?? defaultSource(platform)
    if (!SOURCES.includes(chosen)) throw new Refused(`I can install from winget or brew, not ${String(chosen)}.`)
    if (chosen === 'winget' && platform !== 'win32') throw new Refused('winget is only on Windows.')
    if (chosen === 'brew' && platform === 'win32') throw new Refused('Homebrew is not on Windows.')
    return chosen
  }

  function nameOf(name) {
    const said = typeof name === 'string' ? name.trim() : ''
    if (said === '') throw new Refused('There was no program name.')
    // eslint-disable-next-line no-control-regex
    if (said.length > 128 || /[\u0000-\u001f\u007f]/.test(said)) throw new Refused('That is not a program name.')
    return said
  }

  async function call(file, args, opts) {
    const done = await exec(file, args, opts)
    if (done.error === 'ENOENT') throw new Refused(file.endsWith('brew') ? 'Homebrew is not installed on that computer.' : 'winget is not on that computer.')
    if (done.error) throw new Refused(`${file} could not be started (${done.error}).`)
    if (done.cancelled) throw new Refused('Stopped: it was cancelled.')
    if (done.timedOut) throw new Refused('It took too long and was stopped.')
    return done
  }

  async function wingetSearch(name, opts) {
    const done = await call('winget', ['search', name, ...COMMON], { timeoutMs: LOOKUP_TIMEOUT_MS, ...opts })
    return parseWingetTable(done.stdout)
  }

  async function brewInfo(name, opts) {
    const done = await call(brew(), ['info', '--json=v2', name], { timeoutMs: LOOKUP_TIMEOUT_MS, ...opts })
    if (done.exit !== 0) throw new Refused(`Homebrew has nothing called ${name}.`)
    let info
    try {
      info = JSON.parse(done.stdout)
    } catch {
      throw new Refused('Homebrew answered with something I could not read.')
    }
    const formula = info?.formulae?.[0]
    if (formula) return { cask: false, name: formula.full_name ?? formula.name, version: formula.versions?.stable ?? '', publisher: formula.tap ?? 'homebrew/core', homepage: formula.homepage }
    const cask = info?.casks?.[0]
    if (cask) return { cask: true, name: cask.full_token ?? cask.token, version: cask.version ?? '', publisher: cask.tap ?? 'homebrew/cask', homepage: cask.homepage }
    throw new Refused(`Homebrew has nothing called ${name}.`)
  }

  /** `{ results: [{ name, id, version, source }] }`. Changes nothing. */
  async function search({ name, source } = {}, opts = {}) {
    const from = sourceOf(source)
    const said = nameOf(name)
    if (from === 'winget') return { results: (await wingetSearch(said, opts)).slice(0, 25) }
    const done = await call(brew(), ['search', said], { timeoutMs: LOOKUP_TIMEOUT_MS, ...opts })
    const results = String(done.stdout)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('==>') && BREW_NAME.test(l))
      .slice(0, 25)
      .map((id) => ({ name: id, id, version: '', source: 'brew' }))
    return { results }
  }

  async function wingetShow(id, opts) {
    const shown = await call('winget', ['show', '--id', id, '-e', ...COMMON], { timeoutMs: LOOKUP_TIMEOUT_MS, ...opts })
    return parseWingetShow(shown.stdout)
  }

  /** Nothing matched exactly: refuse, naming the near hits and who publishes each. */
  async function noExactMatch(rows, said, opts) {
    if (rows.length === 0) throw new Refused(`Nothing called ${said} was found. Nothing was installed.`)
    const listed = []
    for (const r of rows.slice(0, MOST_LISTED)) {
      const { publisher } = await wingetShow(r.id, opts).catch(() => ({}))
      listed.push(`${r.name} (id ${r.id}, published by ${publisher ?? 'an unknown publisher'})`)
    }
    const more = rows.length > MOST_LISTED ? ` and ${rows.length - MOST_LISTED} more` : ''
    throw new Refused(`No program is called exactly ${said}, so nothing was installed. Found: ${listed.join('; ')}${more}. Ask again with the exact id of the one you mean.`)
  }

  /** Nothing is installed unless the publisher in the approved call is the package's own. */
  function approved(publisher, what, actual) {
    if (samePublisher(publisher, actual)) return
    const who = typeof actual === 'string' && actual.trim() ? actual.trim() : undefined
    if (!who) throw new Refused(`I could not find out who publishes ${what}, so nothing was installed.`)
    const given = typeof publisher === 'string' && publisher.trim() ? ` The publisher given, ${publisher.trim()}, is not it.` : ''
    throw new Refused(`Nothing was installed yet. ${what} is published by ${who}.${given} To install it, ask again with publisher "${who}", so you see who made it before you say yes.`)
  }

  /** `{ installed, version, publisher }` once installed. `publisher` must be the package's own. */
  async function install({ name, source, publisher } = {}, opts = {}) {
    const from = sourceOf(source)
    const said = nameOf(name)
    if (from === 'winget') {
      const rows = await wingetSearch(said, opts)
      const picked = choose(rows, said)
      if (!picked) return noExactMatch(rows, said, opts)
      if (!WINGET_ID.test(picked.id)) throw new Refused('winget gave an id I will not pass on.')
      const shown = await wingetShow(picked.id, opts)
      const version = shown.version
      approved(publisher, `${picked.name} (${picked.id})${version ? ` ${version}` : ''}`, shown.publisher)
      const done = await call('winget', ['install', '--id', picked.id, '-e', '--accept-package-agreements', ...COMMON], { timeoutMs: INSTALL_TIMEOUT_MS, ...opts })
      if (done.exit !== 0) throw new Refused(`winget could not install ${picked.id} (exit ${done.exit}).`)
      return { installed: picked.id, version: version ?? picked.version ?? '', publisher: shown.publisher.trim() }
    }
    if (!BREW_NAME.test(said)) throw new Refused('That is not a Homebrew name.')
    const info = await brewInfo(said, opts)
    approved(publisher, `${info.name}${info.version ? ` ${info.version}` : ''}${info.homepage ? ` (${info.homepage})` : ''}`, info.publisher)
    const args = ['install', ...(info.cask ? ['--cask'] : []), said]
    const done = await call(brew(), args, { timeoutMs: INSTALL_TIMEOUT_MS, ...opts })
    if (done.exit !== 0) throw new Refused(`Homebrew could not install ${said} (exit ${done.exit}).`)
    return { installed: info.name, version: info.version, publisher: info.publisher }
  }

  return { search, install }
}
