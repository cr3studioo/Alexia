// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * Running one child: its environment, how a shell is started, its output kept to a size, and its
 * whole process tree killed on timeout or cancel.
 *
 * **Output is never logged.** A command's output can hold anything, a password included; it goes
 * back to the caller and nowhere else.
 */

/** Each of stdout and stderr is kept to this many bytes. */
export const MAX_OUTPUT = 64 * 1024

/** The names a child keeps from this process's environment, matched without case on Windows. */
const KEEP = {
  win32: ['PATH', 'PATHEXT', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive'],
  other: ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG'],
}

/**
 * The environment a command gets: PATH, the home folder, the temp folder and the language, and
 * on Windows the few names Windows itself needs to start a program (SystemRoot, windir, ComSpec,
 * PATHEXT). Nothing else: no `ALEXIA_*`, no secret, nothing this plugin was given.
 */
export function minimalEnv(env = process.env, platform = process.platform) {
  const keep = platform === 'win32' ? KEEP.win32 : KEEP.other
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    const wanted = platform === 'win32' ? keep.find((k) => k.toUpperCase() === name.toUpperCase()) : keep.find((k) => k === name)
    if (wanted && !(wanted in out)) out[wanted] = value
  }
  return out
}

/** What an installer needs on top, on Windows: where programs and per-user data go. None is a secret. */
const INSTALLER_EXTRA = ['LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'USERNAME', 'USERDOMAIN', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']

/** {@link minimalEnv} and, on Windows, the folders an installer writes to. */
export function installerEnv(env = process.env, platform = process.platform) {
  const out = minimalEnv(env, platform)
  if (platform !== 'win32') return out
  for (const [name, value] of Object.entries(env)) {
    const wanted = INSTALLER_EXTRA.find((k) => k.toUpperCase() === name.toUpperCase())
    if (wanted && typeof value === 'string' && !(wanted in out)) out[wanted] = value
  }
  return out
}

/** The shell used when none is named. */
export const defaultShell = (platform = process.platform) => (platform === 'win32' ? 'powershell' : platform === 'darwin' ? 'zsh' : 'bash')

export const SHELLS = ['powershell', 'zsh', 'bash']

/**
 * How to start `shell` on `command`: `{ file, args }`.
 *
 * PowerShell gets the script as `-EncodedCommand` (UTF-16LE, base64), so no quote or backslash in
 * it is ever reinterpreted by Windows' argument rules. The script asks for UTF-8 output and turns
 * the outcome into an exit code: a native program's own, or 1 when the last cmdlet failed.
 */
export function shellInvocation(shell, command) {
  if (shell === 'powershell') {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$global:LASTEXITCODE = 0',
      command,
      'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded] }
  }
  if (shell === 'zsh' || shell === 'bash') return { file: shell, args: ['-c', command] }
  throw new Error(`unknown shell ${shell}`)
}

/**
 * Kill `pid` and everything it started. On Windows `taskkill /T` walks the tree; elsewhere the
 * child leads its own process group (it was started `detached`), and the group is killed.
 * Resolves once the kill was sent; never rejects.
 */
export function killTree(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve()
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => resolve())
      killer.on('close', () => resolve())
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  return Promise.resolve()
}

/** Keeps the first {@link MAX_OUTPUT} bytes of a stream and counts the rest. */
function collector(limit) {
  const parts = []
  let kept = 0
  let dropped = 0
  return {
    add(chunk) {
      const room = limit - kept
      if (room > 0) {
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        parts.push(part)
        kept += part.length
      }
      dropped += Math.max(0, chunk.length - Math.max(0, room))
    },
    text() {
      const body = Buffer.concat(parts).toString('utf8')
      return dropped > 0 ? `${body}\n[cut: ${dropped} more bytes were not kept; at most ${limit / 1024} KiB is]` : body
    },
    get cut() {
      return dropped > 0
    },
  }
}

/**
 * Start `file args` and collect what it prints.
 *
 * - `timeoutMs` (optional): the tree is killed when it runs longer; `timedOut` says so.
 * - `signal` (optional): aborting it kills the tree; `cancelled` says so.
 * - `onOutput(stream, text)` (optional): each piece of output as it arrives, for progress.
 *
 * `done` resolves (never rejects) with `{ exit, stdout, stderr, truncated, timedOut, cancelled,
 * error }`. `exit` is `null` when the program could not start or was killed; `error` is then the
 * error's code (`ENOENT`), never its message.
 */
export function startProcess({ file, args = [], cwd, env, timeoutMs, signal, onOutput, limit = MAX_OUTPUT, platform = process.platform }) {
  const out = collector(limit)
  const err = collector(limit)
  let timedOut = false
  let cancelled = false
  let child
  try {
    child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group elsewhere, so the whole tree can be killed at once.
      detached: platform !== 'win32',
    })
  } catch (error) {
    const done = Promise.resolve({ exit: null, stdout: '', stderr: '', truncated: false, timedOut, cancelled, error: error?.code ?? 'EINVAL' })
    return { pid: undefined, done, kill: () => Promise.resolve() }
  }

  const kill = () => killTree(child.pid, platform)
  const take = (collect, name) => (chunk) => {
    collect.add(chunk)
    if (onOutput) {
      try {
        onOutput(name, chunk.toString('utf8'))
      } catch {
        // A listener's failure is not the command's.
      }
    }
  }
  child.stdout.on('data', take(out, 'stdout'))
  child.stderr.on('data', take(err, 'stderr'))

  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ?
      setTimeout(() => {
        timedOut = true
        void kill()
      }, timeoutMs)
    : undefined
  const onAbort = () => {
    cancelled = true
    void kill()
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const done = new Promise((resolve) => {
    let error
    child.on('error', (e) => {
      error = e?.code ?? 'EFAIL'
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        exit: timedOut || cancelled || error ? null : code,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.cut || err.cut,
        timedOut,
        cancelled,
        ...(error && { error }),
      })
    })
  })
  return { pid: child.pid, done, kill }
}
