// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs'
import { Refused } from './shell.js'

/**
 * Installing a program from the platform's own package manager: winget on Windows, Homebrew on a
 * Mac. Every program is started directly with its arguments as a list, never through a shell, so
 * nothing in a program's name is ever read as a command.
 *
 * winget is asked in three steps: `search` finds the package, `show` gives its publisher, and only
 * then `install --id <id> -e`, so what is installed is the exact package the result names.
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

/** Where brew is: an app started from the Dock does not have it on PATH. */
export function brewPath(exists = existsSync) {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => exists(p)) ?? 'brew'
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

/** Pick the one package `name` means, or refuse naming the choices. */
export function choose(rows, name) {
  const want = name.trim().toLowerCase()
  const byId = rows.filter((r) => r.id.toLowerCase() === want)
  if (byId.length === 1) return byId[0]
  const byName = rows.filter((r) => r.name.toLowerCase() === want)
  if (byName.length === 1) return byName[0]
  if (rows.length === 1) return rows[0]
  if (rows.length === 0) throw new Refused(`Nothing called ${name} was found.`)
  const listed = rows
    .slice(0, 10)
    .map((r) => `${r.name} (${r.id})`)
    .join(', ')
  throw new Refused(`Several programs match ${name}: ${listed}. Say which one by its id.`)
}

/**
 * @param {object} deps
 * @param {(file: string, args: string[], opts: { timeoutMs: number, signal?: AbortSignal, onOutput?: Function }) => Promise<{ exit: number|null, stdout: string, stderr: string, error?: string, cancelled?: boolean, timedOut?: boolean }>} deps.exec
 * @param {string} [deps.platform]
 * @param {() => string} [deps.brew]  where brew is
 */
export function createInstaller({ exec, platform = process.platform, brew = () => brewPath() }) {
  function sourceOf(source) {
    const chosen = source ?? defaultSource(platform)
    if (!chosen) throw new Refused('I can’t install programs on that computer.')
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

  /** `{ installed, version, publisher }` once installed. */
  async function install({ name, source } = {}, opts = {}) {
    const from = sourceOf(source)
    const said = nameOf(name)
    if (from === 'winget') {
      const picked = choose(await wingetSearch(said, opts), said)
      if (!WINGET_ID.test(picked.id)) throw new Refused('winget gave an id I will not pass on.')
      const shown = await call('winget', ['show', '--id', picked.id, '-e', ...COMMON], { timeoutMs: LOOKUP_TIMEOUT_MS, ...opts })
      const { publisher, version } = parseWingetShow(shown.stdout)
      const done = await call('winget', ['install', '--id', picked.id, '-e', '--accept-package-agreements', ...COMMON], { timeoutMs: INSTALL_TIMEOUT_MS, ...opts })
      if (done.exit !== 0) throw new Refused(`winget could not install ${picked.id} (exit ${done.exit}).`)
      return { installed: picked.id, version: version ?? picked.version ?? '', publisher: publisher ?? 'unknown' }
    }
    if (!BREW_NAME.test(said)) throw new Refused('That is not a Homebrew name.')
    const info = await brewInfo(said, opts)
    const args = ['install', ...(info.cask ? ['--cask'] : []), said]
    const done = await call(brew(), args, { timeoutMs: INSTALL_TIMEOUT_MS, ...opts })
    if (done.exit !== 0) throw new Refused(`Homebrew could not install ${said} (exit ${done.exit}).`)
    const publisher = info.homepage ? `${info.publisher} (${info.homepage})` : info.publisher
    return { installed: info.name, version: info.version, publisher }
  }

  return { search, install }
}
