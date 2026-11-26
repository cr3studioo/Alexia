// SPDX-License-Identifier: AGPL-3.0-only
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitDriverSettings, gitSafeEnv, MOST_GIT_SETTINGS, readOnly } from './classify.js'
import { defaultShell, minimalEnv, SHELLS, shellInvocation, startProcess } from './proc.js'

/** The longest a command may run while the caller waits, in seconds. */
export const MOST_TIMEOUT_S = 600
/** How long a command runs when no timeout is given, in seconds. */
export const DEFAULT_TIMEOUT_S = 120

/** A refusal: a sentence for the owner, never a stack. */
export class Refused extends Error {}

/** Root URIs (`file://...`) or plain paths, as plain absolute paths. Anything else is dropped. */
export function rootPaths(roots) {
  const out = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const raw = typeof root === 'string' ? root : root?.uri
    if (typeof raw !== 'string' || raw === '') continue
    try {
      out.push(raw.startsWith('file:') ? fileURLToPath(raw) : raw)
    } catch {
      // Not a path on this machine.
    }
  }
  return out.filter((one) => isAbsolute(one))
}

const fold = (path, platform) => (platform === 'win32' ? path.toLowerCase() : path)

/** Is `path` the folder `root` or inside it? Both already resolved. */
export function inside(path, root, platform = process.platform) {
  const rel = relative(fold(root, platform), fold(path, platform))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Runs commands for the tools.
 *
 * @param {object} deps
 * @param {() => Promise<unknown[]>} deps.roots  the owner's roots (`roots/list`), asked each time
 * @param {typeof startProcess} [deps.start]     starts a child; a test can fake it
 * @param {object} [deps.watches]                where `watch: true` hands a running command
 * @param {Record<string,string|undefined>} [deps.env]  this process's environment
 * @param {string} [deps.platform]
 * @param {(cwd: string, env: Record<string,string>) => Promise<string>} [deps.gitConfig]
 *   `git config --list -z` run in `cwd`; a test can fake it
 */
export function createShell({ roots, start = startProcess, watches, env = process.env, platform = process.platform, gitConfig }) {
  const listGitConfig = gitConfig ?? ((cwd, childEnv) => readGitConfig({ cwd, env: childEnv, start, platform }))

  /** The owner's roots as real paths, asked now: the owner may change them at any time. */
  async function openRoots() {
    const listed = await Promise.resolve()
      .then(roots)
      .catch(() => [])
    const open = []
    for (const root of rootPaths(listed)) open.push(await realpath(root).catch(() => resolve(root)))
    return open
  }

  /** The real path of `path` when it is inside a root and is a folder (`dir`) or a file. */
  async function within(path, { dir }) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Refused(dir ? 'The folder to run in must be a full path.' : 'The file must be a full path.')
    const open = await openRoots()
    if (open.length === 0) throw new Refused('No folder has been opened on this computer, so I cannot reach anything in it.')
    let real
    try {
      real = await realpath(path)
      const is = await stat(real)
      if (dir ? !is.isDirectory() : !is.isFile()) throw new Error('wrong kind')
    } catch {
      throw new Refused(dir ? 'That folder is not there.' : 'That file is not there.')
    }
    if (!open.some((root) => inside(real, root, platform))) {
      throw new Refused(dir ? 'That folder is outside the folders you opened, so I will not run anything there.' : 'That file is outside the folders you opened.')
    }
    return real
  }

  /** The folder a command runs in: the one asked for, which must be inside a root, or home. */
  async function folder(cwd) {
    if (cwd === undefined || cwd === null || cwd === '') return homedir()
    return within(cwd, { dir: true })
  }

  /**
   * The git environment for a read-only command in `cwd`: the fixed safe settings, and every
   * filter, diff driver and named format the repository's settings name, switched off. Those names
   * are the repository's own choice, so they are read first, by git itself (`git config` runs
   * nothing), with the same environment the command will get.
   */
  async function gitLockedDown(cwd, childEnv) {
    let listing
    try {
      listing = await listGitConfig(cwd, { ...childEnv, ...gitSafeEnv() })
    } catch (error) {
      if (error instanceof Refused) throw error
      throw new Refused('I could not read the git settings here, so I will not run git unasked.')
    }
    const extra = gitDriverSettings(listing)
    if (extra.length > MOST_GIT_SETTINGS) throw new Refused('This repository names too many git drivers to check, so I will not run git here unasked.')
    return gitSafeEnv(extra)
  }

  /**
   * Check the arguments and work out what to start. `readonly` is true for `shell_read`, which
   * refuses anything the classifier does not pass.
   */
  async function prepare(args, { readonly }) {
    const command = typeof args?.command === 'string' ? args.command : ''
    if (command.trim() === '') throw new Refused('There was no command to run.')
    const shell = args?.shell ?? defaultShell(platform)
    if (!SHELLS.includes(shell)) throw new Refused(`I can run PowerShell, zsh or bash, not ${String(shell)}.`)
    let timeout = DEFAULT_TIMEOUT_S
    if (args?.timeout_s !== undefined && args?.timeout_s !== null) {
      timeout = Number(args.timeout_s)
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > MOST_TIMEOUT_S) throw new Refused(`timeout_s must be a whole number from 1 to ${MOST_TIMEOUT_S}.`)
    }
    let run = command
    let childEnv = minimalEnv(env, platform)
    let git = false
    if (readonly) {
      const said = readOnly(command)
      if (!said.ok) throw new Refused(`That is not a read-only command, so it has to be asked about: ${said.why} Use shell_run instead.`)
      run = said.command
      git = said.git
    }
    const cwd = await folder(args?.cwd)
    if (git) childEnv = { ...childEnv, ...(await gitLockedDown(cwd, childEnv)) }
    return { ...shellInvocation(shell, run), cwd, env: childEnv, timeoutMs: timeout * 1000, shell }
  }

  /**
   * Run a command and wait for it: `{ exit, stdout, stderr, truncated }`, or with `watch: true`,
   * `{ watch }` at once and the finish later as a notice.
   */
  async function run(args, { readonly = false, signal, onOutput } = {}) {
    const job = await prepare(args, { readonly })
    if (args?.watch === true) {
      if (!watches) throw new Refused('I can’t keep an eye on jobs on that computer.')
      const says = typeof args.says === 'string' && args.says.trim() ? args.says.trim() : undefined
      // In the background there is no timeout and no caller to cancel: job_unwatch stops it.
      const child = start({ file: job.file, args: job.args, cwd: job.cwd, env: job.env, platform })
      const watch = watches.command(child, { says, label: label(args.command) })
      return { watch }
    }
    const child = start({ file: job.file, args: job.args, cwd: job.cwd, env: job.env, timeoutMs: job.timeoutMs, signal, onOutput, platform })
    const done = await child.done
    if (done.error === 'ENOENT') throw new Refused(`${job.shell} is not on that computer.`)
    if (done.error) throw new Refused(`The command could not be started (${done.error}).`)
    if (done.cancelled) throw new Refused('Stopped: the command was cancelled, and everything it started was ended.')
    if (done.timedOut) {
      return {
        exit: null,
        stdout: done.stdout,
        stderr: done.stderr,
        truncated: done.truncated,
        timedOut: true,
      }
    }
    return { exit: done.exit, stdout: done.stdout, stderr: done.stderr, truncated: done.truncated }
  }

  return { run, prepare, folder, file: (path) => within(path, { dir: false }) }
}

/** How a command is named in its notice: its first line, kept short. */
export function label(command) {
  const line = String(command ?? '').trim().split(/\r?\n/)[0]
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/** `git config --list -z` in `cwd`, started directly (no shell) with `env`: its output, or a refusal. */
export async function readGitConfig({ cwd, env, start = startProcess, platform = process.platform }) {
  const done = await start({ file: 'git', args: ['config', '--list', '-z'], cwd, env, timeoutMs: 30_000, platform }).done
  if (done.error === 'ENOENT') throw new Refused('git is not on that computer.')
  if (done.exit !== 0 || done.truncated) throw new Refused('I could not read the git settings here, so I will not run git unasked.')
  return done.stdout
}
