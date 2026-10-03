// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/**
 * **Asking `nvidia-smi`, the one way both callers ask it.**
 *
 * On a Windows PC with an RTX card and a working driver, `nvidia-smi` answered in a terminal and
 * not inside Alexia: the shell hands core a short list of environment variables (`main.rs`
 * `passes`), and the runtime probe narrowed that again to three. So the probe gets what Windows
 * programs expect to find (the Program Files folders as well as `Path` and `SystemRoot`), the
 * command is also tried by its full path in the driver's two usual homes, and the wait is long
 * enough for a driver that wakes its card first. A probe that still fails says why, instead of
 * being read as "no GPU" in silence.
 */
export async function nvidiaSmi(args: readonly string[], options: { platform?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string } | { error: string }> {
  const env = process.env
  const windows = (options.platform ?? process.platform) === 'win32'
  const drive = env.SystemDrive ?? env.HOMEDRIVE
  const programs = env.ProgramW6432 ?? env.ProgramFiles ?? (drive ? join(`${drive}\\`, 'Program Files') : undefined)
  const commands = windows
    ? ['nvidia-smi', ...[env.SystemRoot && join(env.SystemRoot, 'System32', 'nvidia-smi.exe'), programs && join(programs, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')].filter((one): one is string => Boolean(one))]
    : ['nvidia-smi']
  const passed: NodeJS.ProcessEnv = { PATH: env.PATH }
  if (windows) {
    for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramW6432', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP']) {
      if (env[name] !== undefined) passed[name] = env[name]
    }
    if (programs !== undefined && passed.ProgramFiles === undefined) passed.ProgramFiles = programs
  }
  const failures: string[] = []
  for (const command of commands) {
    try {
      const { stdout } = await execute(command, [...args], { timeout: options.timeout ?? 10_000, maxBuffer: 1024 * 1024, windowsHide: true, env: passed, ...(options.signal && { signal: options.signal }) })
      if (stdout.trim()) return { stdout }
      failures.push(`${command}: no output`)
    } catch (error) {
      options.signal?.throwIfAborted()
      failures.push(`${command}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return { error: failures.join('; ') }
}
