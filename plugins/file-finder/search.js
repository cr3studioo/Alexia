// SPDX-License-Identifier: AGPL-3.0-only
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { EXTENSIONS, extensionOf, inside, realRoots, refuse } from './files.js'
import { runHelper, runPowerShell } from './run.js'

/**
 * File search through the index the operating system already keeps: Windows Search on Windows,
 * Spotlight (`mdfind`) on macOS. Nothing here walks the disk or keeps an index of its own.
 *
 * **Both queries are languages, and what is searched for comes from a model that may have read a
 * hostile file name.** So only letters, digits and a few joining marks ever reach a query, and
 * every value in the SQL is a quoted literal. A folder's path, which cannot be cut down that way,
 * only ever appears inside such a literal.
 */

export const KINDS = ['document', 'image', 'video', 'audio', 'archive', 'folder']
export const DEFAULT_LIMIT = 20
export const MOST_LIMIT = 50
/** How many paths the index is asked for, so that enough are left after the checks. */
export const MOST_CANDIDATES = 200
/** `mdfind` has no limit of its own and answers in no order, so more of its paths are looked at. */
const MOST_MAC_CANDIDATES = 2000
const MOST_WORDS = 12
const MOST_WORD = 64

const NOT_AVAILABLE = 'The file search of this computer did not answer. Its search indexing may be switched off.'
const NO_ROOTS = 'No folder has been opened on this computer, so there is nowhere I may search.'
const OUTSIDE = 'That folder is outside the folders opened on this computer.'

/**
 * The words of a query: runs of letters and digits, which may be joined by `'`, `.`, `_` or `-`.
 * Quotes, brackets, wildcards and every other mark are left behind.
 */
export function words(query) {
  const found = String(query)
    .normalize('NFC')
    .match(/[\p{L}\p{M}\p{N}]+(?:['._-][\p{L}\p{M}\p{N}]+)*/gu)
  return [...new Set((found ?? []).map((word) => word.slice(0, MOST_WORD)))].slice(0, MOST_WORDS)
}

/** One SQL string literal: the only way a value enters the SystemIndex query. */
export const sqlLiteral = (text) => `'${String(text).replaceAll("'", "''")}'`

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/**
 * The SystemIndex queries, to be tried in order until one finds something: every word, then (by
 * `FREETEXT`) the words as loose text. `scopes` are folders; null searches every indexed file.
 */
export function systemIndexQueries({ words: terms, kind, scopes, after, top = MOST_CANDIDATES }) {
  const where = []
  const places = scopes === null ? ['file:'] : scopes.map((folder) => `file:${folder.replaceAll('\\', '/')}`)
  // An empty scope list would mean no SCOPE at all, which is the opposite of nowhere.
  if (places.length === 0) throw new Error('a search needs a folder')
  where.push(`(${places.map((place) => `SCOPE=${sqlLiteral(place)}`).join(' OR ')})`)
  if (kind === 'folder') where.push("System.ItemType = 'Directory'")
  else if (kind) where.push(`(${EXTENSIONS[kind].map((ext) => `System.FileExtension = ${sqlLiteral(`.${ext}`)}`).join(' OR ')})`)
  if (after !== undefined) where.push(`System.DateModified >= ${sqlLiteral(sqlTime(after))}`)

  const count = Math.trunc(Number(top))
  const select = (match, order) =>
    `SELECT TOP ${String(count)} System.ItemUrl FROM SystemIndex WHERE ${[...where, ...match].join(' AND ')} ORDER BY ${order} DESC`
  // `words` has already removed every double quote, so a term cannot end its own phrase.
  const every = terms.map((word) => `CONTAINS(*, ${sqlLiteral(`"${word.replaceAll('"', '')}*"`)})`)
  return [
    select(every, 'System.DateModified'),
    select([`FREETEXT(*, ${sqlLiteral(terms.join(' '))})`], 'System.Search.Rank'),
  ]
}

/** The arguments for one `mdfind` run. `folder` null searches everywhere. Paths come NUL-separated. */
export function mdfindArgs({ words: terms, kind, folder, after }) {
  const clauses = terms.map((word) => {
    const safe = word.replace(/["\\*]/g, '')
    return `(kMDItemFSName == "*${safe}*"cd || kMDItemTextContent == "${safe}*"cd)`
  })
  if (kind === 'folder') clauses.push('kMDItemContentType == "public.folder"')
  else if (kind) clauses.push(`(${EXTENSIONS[kind].map((ext) => `kMDItemFSName == "*.${ext}"c`).join(' || ')})`)
  if (after !== undefined) {
    clauses.push(`kMDItemFSContentChangeDate >= $time.iso(${new Date(after).toISOString().slice(0, 19)}Z)`)
  }
  return ['-0', ...(folder === null ? [] : ['-onlyin', folder]), clauses.join(' && ')]
}

/** Constant. Reads a JSON list of queries and prints the address of every row of the first that has any. */
export const SEARCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $given = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
  $queries = ConvertFrom-Json $given
  $connection = New-Object -ComObject ADODB.Connection
  $connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  foreach ($sql in $queries) {
    $rows = $connection.Execute($sql)
    $found = 0
    while (-not $rows.EOF) {
      $url = [string]$rows.Fields.Item('System.ItemUrl').Value
      [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url)))
      $found++
      $rows.MoveNext()
    }
    $rows.Close()
    if ($found -gt 0) { break }
  }
  $connection.Close()
  [Console]::Out.WriteLine('done')
} catch {
  exit 1
}
`

/** `file:C:/Users/x/a b.pdf`, as the index writes it (nothing is percent-encoded), as a Windows path. */
export function pathOfItemUrl(url) {
  return /^file:/i.test(url) ? url.slice('file:'.length).replaceAll('/', '\\') : undefined
}

export function windowsBackend(options = {}) {
  return async ({ scopes, signal, ...query }) => {
    const queries = systemIndexQueries({ ...query, scopes })
    const urls = await runPowerShell(SEARCH_SCRIPT, JSON.stringify(queries), { ...options, signal })
    if (urls === null) throw refuse(NOT_AVAILABLE)
    return urls.map(pathOfItemUrl).filter((path) => path !== undefined)
  }
}

export function macBackend({ run = runHelper } = {}) {
  return async ({ scopes, signal, ...query }) => {
    // One run for each folder: each keeps its own `-onlyin`.
    const found = await Promise.all(
      (scopes ?? [null]).map(async (folder) => {
        const { code, out, cut } = await run('/usr/bin/mdfind', mdfindArgs({ ...query, folder }), { signal })
        if (code !== 0 && !cut) throw refuse(NOT_AVAILABLE)
        const paths = out.toString('utf8').split('\0')
        // What follows the last NUL is nothing, or half a path when the output was cut.
        paths.pop()
        return paths
      }),
    )
    return found.flat().slice(0, MOST_MAC_CANDIDATES)
  }
}

/** The search of this computer's index, or undefined where there is none. */
export function backendFor(platform = process.platform) {
  if (platform === 'win32') return windowsBackend()
  if (platform === 'darwin') return macBackend()
  return undefined
}

function checked({ query, kind, folder, modified_after: modifiedAfter, limit }) {
  if (typeof query !== 'string') throw refuse('Say what to look for.')
  const terms = words(query)
  if (terms.length === 0) throw refuse('Give me at least one word or number to look for.')
  if (kind !== undefined && !KINDS.includes(kind)) throw refuse(`The kind must be one of: ${KINDS.join(', ')}.`)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MOST_LIMIT)) {
    throw refuse(`The limit must be a whole number from 1 to ${String(MOST_LIMIT)}.`)
  }
  let after
  if (modifiedAfter !== undefined) {
    after = typeof modifiedAfter === 'string' && /^\d{4}-\d{2}-\d{2}($|T)/.test(modifiedAfter) ? Date.parse(modifiedAfter) : NaN
    if (Number.isNaN(after)) throw refuse('Give the date as year-month-day, for example 2026-03-01.')
  }
  if (folder !== undefined && folder !== '' && (typeof folder !== 'string' || !isAbsolute(folder))) {
    throw refuse('I need the full path of the folder.')
  }
  return { terms, kind, after, folder: folder || undefined, limit: limit ?? DEFAULT_LIMIT }
}

/** What the disk says about one path the index named, or null when it must not be answered with. */
async function look(path, { roots, everywhere, kind, after }) {
  if (!isAbsolute(path)) return null
  try {
    // The real path, so a link inside a root cannot show what lies outside it.
    const real = await realpath(resolve(path))
    if (!everywhere && !roots.some((root) => inside(real, root))) return null
    const info = await stat(real)
    if (kind === 'folder' ? !info.isDirectory() : kind && !(info.isFile() && EXTENSIONS[kind].includes(extensionOf(real)))) return null
    if (after !== undefined && info.mtimeMs < after) return null
    return { path: real, name: basename(real), modified: Math.trunc(info.mtimeMs), size: info.isDirectory() ? 0 : info.size }
  } catch {
    // The index can be behind the disk: what is gone is not a result.
    return null
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.roots       the owner's roots (`roots/list`), asked each time
 * @param {(query: object) => Promise<string[]>} deps.find   the index of this computer
 * @param {() => Promise<boolean>} [deps.everywhere]  whether the owner's scope is Everywhere; false
 *        when left out, because MCP roots have no way to say it
 */
export function createFinder({ roots, find, everywhere = async () => false }) {
  return {
    /** `file.search`: newest first. */
    async search(args, { signal } = {}) {
      const { terms, kind, after, folder, limit } = checked(args)
      const anywhere = (await everywhere()) === true
      const open = await realRoots(roots)
      if (!anywhere && open.length === 0) throw refuse(NO_ROOTS)

      let scopes = anywhere ? null : open
      if (folder !== undefined) {
        const real = await realpath(resolve(folder)).catch(() => {
          throw refuse('That folder is not there.')
        })
        if (!anywhere && !open.some((root) => inside(real, root))) throw refuse(OUTSIDE)
        scopes = [real]
      }

      const candidates = await find({ words: terms, kind, scopes, after, signal })
      const within = { roots: scopes ?? [], everywhere: scopes === null, kind, after }
      const items = new Map()
      for (let at = 0; at < candidates.length; at += 32) {
        for (const item of await Promise.all(candidates.slice(at, at + 32).map((path) => look(path, within)))) {
          if (item) items.set(item.path, item)
        }
      }
      return { items: [...items.values()].sort((a, b) => b.modified - a.modified || (a.path < b.path ? -1 : 1)).slice(0, limit) }
    },
  }
}
