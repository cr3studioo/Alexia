// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { EXTENSIONS, extensionOf, fold, inside, INSTALLERS, realRoots, refuse } from './files.js'
import { runHelper, runPowerShell } from './run.js'

/**
 * Tidying one folder, in two steps: propose a plan, which moves nothing, then carry out that very
 * plan. Only the files lying directly in the folder are moved, each into a subfolder of it.
 * Folders, hidden files, links and anything younger than a day are never touched, and no move ever
 * replaces a file.
 *
 * Every move is written to the table `moves` before it is made, so it can be undone.
 */

export const DAY_MS = 24 * 60 * 60 * 1000
export const INSTALLER_AGE_MS = 30 * DAY_MS
export const PLAN_LIFE_MS = 60 * 60 * 1000
export const OLD_INSTALLERS = 'Old installers'

const BY_TYPE = [
  { extensions: EXTENSIONS.document, into: 'Documents', why: 'A document' },
  { extensions: EXTENSIONS.image, into: 'Images', why: 'An image' },
  { extensions: EXTENSIONS.archive, into: 'Archives', why: 'An archive' },
]

const NO_PLAN = 'I have no such plan. Ask me to tidy the folder again, then approve the new plan.'

/** Where a file of this name and age goes, or null when it stays. */
export function rule(name, age) {
  if (age < DAY_MS) return null
  const ext = extensionOf(name)
  if (INSTALLERS.includes(ext)) {
    return age > INSTALLER_AGE_MS ? { into: OLD_INSTALLERS, why: 'An installer older than 30 days' } : null
  }
  const type = BY_TYPE.find((one) => one.extensions.includes(ext))
  return type ? { into: type.into, why: type.why } : null
}

/**
 * How long a file has been as it is here: since it was last written or arrived, whichever is later.
 * A copy keeps its old writing time, and the creation time says when it came.
 */
const ageOf = (info, now) => now - Math.max(Number(info.mtimeMs), Number(info.birthtimeMs) || 0)

/** What is at `path` itself (a link is not followed), or null when nothing is there. */
const look = (path) =>
  lstat(path, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })

/** `name (2).ext`; a `.tar.gz` stays whole. */
function numbered(name, n) {
  if (n === 1) return name
  const ending = /(\.tar\.[a-z0-9]+|(?<=.)\.[^.]*)$/i.exec(name)?.[0] ?? ''
  return `${name.slice(0, name.length - ending.length)} (${String(n)})${ending}`
}

/** Dot files, and the lock files office programs keep beside an open document. */
const hiddenByName = (name) => name.startsWith('.') || name.startsWith('~$')

/** Constant. Reads a folder's path and prints the names of what is hidden or a system file in it. */
export const HIDDEN_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $folder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
  $unseen = [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System
  foreach ($entry in (New-Object IO.DirectoryInfo $folder).GetFileSystemInfos()) {
    if (($entry.Attributes -band $unseen) -ne 0) {
      [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($entry.Name)))
    }
  }
  [Console]::Out.WriteLine('done')
} catch {
  exit 1
}
`

/**
 * The names in `folder` the system marks hidden, which a name alone does not show. Refuses when it
 * cannot tell: a plan made without knowing could move a hidden file.
 */
export async function hiddenIn(folder, { platform = process.platform, run = runHelper } = {}) {
  const cannot = () => refuse('I could not check which files in that folder are hidden, so I left it alone.')
  if (platform === 'win32') {
    const names = await runPowerShell(HIDDEN_SCRIPT, folder, { run })
    if (names === null) throw cannot()
    return new Set(names)
  }
  if (platform === 'darwin') {
    const { code, out, cut } = await run('/usr/bin/find', [folder, '-mindepth', '1', '-maxdepth', '1', '-flags', '+hidden', '-print0'])
    if (code !== 0 || cut) throw cannot()
    return new Set(out.toString('utf8').split('\0').filter(Boolean).map((path) => basename(path)))
  }
  // Elsewhere a leading dot is all there is to being hidden.
  return new Set()
}

/** The moves for the files lying in `dir`, in name order. Reads only. */
export async function planMoves(dir, { hidden, now }) {
  const unseen = await hidden(dir)
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  const folders = new Map()
  const moves = []
  /** A subfolder can take files when it is a real folder, or nothing is there yet. */
  const usable = async (into) => {
    if (!folders.has(into)) {
      const info = await look(join(dir, into))
      folders.set(into, info === null || info.isDirectory())
    }
    return folders.get(into)
  }
  const taken = new Set()
  for (const name of names) {
    if (hiddenByName(name) || unseen.has(name)) continue
    const info = await look(join(dir, name))
    if (!info?.isFile()) continue
    const goes = rule(name, ageOf(info, now))
    // Tidying the subfolder itself must not nest another of the same name in it.
    if (!goes || fold(basename(dir)) === fold(goes.into) || !(await usable(goes.into))) continue
    let target
    for (let n = 1; target === undefined; n += 1) {
      const candidate = join(dir, goes.into, numbered(name, n))
      // Without case on both counts: Windows and a usual Mac disk keep one of `A.txt` and `a.txt`.
      if (!taken.has(candidate.toLowerCase()) && (await look(candidate)) === null) target = candidate
    }
    taken.add(target.toLowerCase())
    moves.push({ from: join(dir, name), to: target, why: goes.why, size: Number(info.size), mtime: Math.trunc(Number(info.mtimeMs)) })
  }
  return moves
}

/**
 * Move a file without ever replacing one: the new name is first taken by an empty file, which fails
 * when anything is there, and the file then moves over it. False when it could not move (the name
 * is taken, the file is gone or in use); the file is then where it was.
 */
export async function moveWithoutReplacing(from, to) {
  try {
    await (await open(to, 'wx')).close()
  } catch {
    return false
  }
  try {
    await rename(from, to)
    return true
  } catch {
    await unlink(to).catch(() => {})
    return false
  }
}

/** Run one job after another, so two calls never move files at the same time. */
function oneAtATime() {
  let tail = Promise.resolve()
  return (job) => {
    const run = tail.then(job)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.roots   the owner's roots (`roots/list`), asked each time
 * @param {import('@alexia/sdk').Storage} deps.store   tables `plans` and `moves`
 * @param {(folder: string) => Promise<Set<string>>} [deps.hidden]
 * @param {() => number} [deps.now]
 */
export function createTidy({ roots, store, hidden = hiddenIn, now = Date.now }) {
  const inTurn = oneAtATime()

  /** The real path of a folder inside the owner's roots, or a refusal. */
  async function allowed(folder) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw refuse('I need the full path of the folder.')
    const open = await realRoots(roots)
    if (open.length === 0) throw refuse('No folder has been opened on this computer, so there is nothing I may tidy.')
    const real = await realpath(resolve(folder)).catch(() => {
      throw refuse('That folder is not there, or it is outside the folders opened on this computer.')
    })
    if (!open.some((root) => inside(real, root))) throw refuse('That folder is outside the folders opened on this computer.')
    if (!(await look(real))?.isDirectory()) throw refuse('That is not a folder.')
    return real
  }

  /** The subfolder a file moves into, made if need be. False when something else has the name. */
  async function ready(folder) {
    await mkdir(folder).catch((error) => {
      if (error?.code !== 'EEXIST') throw error
    })
    // A link or a junction is not taken: it could lead anywhere.
    return (await look(folder))?.isDirectory() === true
  }

  async function carryOut(move, seq, planId, unseen) {
    const { from, to } = move
    const info = await look(from)
    // Only the file that was proposed: still a plain file, unchanged, old enough and in view.
    if (!info?.isFile() || Number(info.size) !== move.size || Math.trunc(Number(info.mtimeMs)) !== move.mtime) return false
    if (unseen.has(basename(from)) || !rule(basename(from), ageOf(info, now()))) return false
    if (!(await ready(dirname(to)))) return false
    const record = { plan_id: planId, seq }
    // Written first, so a stop in the middle still leaves a way back.
    await store.insert('moves', {
      ...record,
      src: from,
      dst: to,
      ino: String(info.ino),
      size: move.size,
      mtime: move.mtime,
      state: 'moving',
      at: now(),
    })
    if (!(await moveWithoutReplacing(from, to))) {
      await store.delete('moves', record)
      return false
    }
    // The file has moved whether or not this can be noted; `moving` is undone like `moved`.
    await store.update('moves', { state: 'moved' }, record).catch(() => {})
    return true
  }

  async function putBack(record, open) {
    const info = await look(record.dst)
    if (!info?.isFile()) return false
    // The file that was moved: the same one on the disk, or (where a disk renumbers) unchanged.
    const unchanged = Number(info.size) === record.size && Math.trunc(Number(info.mtimeMs)) === record.mtime
    if (String(info.ino) !== record.ino && !unchanged) return false
    // Both folders as they are now, so a link planted since cannot carry the file out of the roots.
    for (const folder of [dirname(record.src), dirname(record.dst)]) {
      const real = await realpath(folder).catch(() => null)
      if (real === null || fold(real) !== fold(folder) || !open.some((root) => inside(real, root))) return false
    }
    return moveWithoutReplacing(record.dst, record.src)
  }

  return {
    /** `folder.tidy {folder}`: what would move. Nothing moves. */
    async propose(folder) {
      const dir = await allowed(folder)
      const moves = await planMoves(dir, { hidden, now: now() })
      const planId = randomBytes(8).toString('hex')
      // Plans too old to carry out are not kept.
      await store.delete('plans', { applied_at: 0, made_at: { lt: now() - PLAN_LIFE_MS } })
      await store.insert('plans', { plan_id: planId, folder: dir, moves: JSON.stringify(moves), made_at: now(), applied_at: 0 })
      return { plan_id: planId, moves: moves.map(({ from, to, why }) => ({ from, to, why })) }
    },

    /** `folder.tidy {folder, apply}`: carry out that plan, once, within an hour of proposing it. */
    apply: (folder, planId) =>
      inTurn(async () => {
        const dir = await allowed(folder)
        if (typeof planId !== 'string' || planId === '') throw refuse(NO_PLAN)
        const [plan] = await store.select('plans', { where: { plan_id: planId }, limit: 1 })
        if (!plan) throw refuse(NO_PLAN)
        if (fold(plan.folder) !== fold(dir)) throw refuse('That plan is for another folder, so nothing was moved.')
        if (plan.applied_at !== 0) throw refuse('That plan was already carried out. Ask me to tidy the folder again for a new one.')
        if (now() - plan.made_at > PLAN_LIFE_MS) {
          throw refuse('That plan is more than an hour old. Ask me to tidy the folder again, then approve the new plan.')
        }
        const unseen = await hidden(dir)
        // Marked before the first move: a plan is never run a second time, however this one ends.
        await store.update('plans', { applied_at: now() }, { plan_id: planId })
        let moved = 0
        let skipped = 0
        for (const [seq, move] of JSON.parse(plan.moves).entries()) {
          const done = await carryOut(move, seq, planId, unseen).catch(() => false)
          if (done) moved += 1
          else skipped += 1
        }
        return { moved, skipped }
      }),

    /** `folder.tidy_undo`: move back what that plan moved. What cannot go back stays, and can be tried again. */
    undo: (planId) =>
      inTurn(async () => {
        if (typeof planId !== 'string' || planId === '') throw refuse('Say which plan to undo.')
        const records = (await store.select('moves', { where: { plan_id: planId }, order: [['seq', 'desc']] })).filter(
          (record) => record.state !== 'undone',
        )
        if (records.length === 0) throw refuse('There is nothing to undo for that plan.')
        const open = await realRoots(roots)
        let moved = 0
        let skipped = 0
        for (const record of records) {
          if (await putBack(record, open).catch(() => false)) {
            moved += 1
            await store.update('moves', { state: 'undone' }, { plan_id: planId, seq: record.seq })
          } else skipped += 1
        }
        return { moved, skipped }
      }),
  }
}
