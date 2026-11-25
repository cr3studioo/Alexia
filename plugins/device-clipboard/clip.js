// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * The clipboard of this computer, read and written through the programs the OS already has.
 *
 * Everything takes a `run` function — `(command, args, { input, signal }) → { code, stdout, stderr }` —
 * so the tests inject a fake and nothing here needs a desktop. The real one is `runCommand`.
 *
 * **Clipboard text is private.** Nothing in this file logs it, and an error message never
 * quotes it. Text travels to the helper on stdin, never in argv: argv is visible to every
 * process on the machine and has a length limit, stdin has neither problem.
 */

export const MAX_TEXT_BYTES = 100 * 1024
const TIMEOUT_MS = 20_000

/** Windows' own PowerShell, by absolute path, so a PATH entry cannot stand in for it. */
function powershell() {
  const root = process.env.SystemRoot
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

/** The real command runner. Hidden window, a time limit, never throws on a non-zero exit. */
export function runCommand(command, args, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'utf8'))
  })
}

/** What an error says about the helper, never about the clipboard's contents. */
function failed(what, result) {
  const last = String(result.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200)
  return new Error(`${what} failed${last ? `: ${last}` : ` (exit ${String(result.code)})`}`)
}

// --- Windows ----------------------------------------------------------------------------

/**
 * One script that says what is on the clipboard.
 *
 * `Get-Clipboard` cannot see the flags a password manager sets, so this asks WinForms, which
 * can: `ExcludeClipboardContentFromMonitorProcessing` present means "do not record this", and
 * `CanIncludeInClipboardHistory` present with a first byte of 0 means the same. When either is
 * there the text is not read at all. Output is one line of JSON with the text in base64, so no
 * code page and no newline can change it. WinForms needs a single-threaded apartment, hence -STA.
 */
const WIN_READ = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$c = [System.Windows.Forms.Clipboard]
$sensitive = $false
if ($c::ContainsData('ExcludeClipboardContentFromMonitorProcessing')) { $sensitive = $true }
if ($c::ContainsData('CanIncludeInClipboardHistory')) {
  $d = $c::GetData('CanIncludeInClipboardHistory')
  if ($d -is [System.IO.MemoryStream]) { $b = $d.ToArray(); if ($b.Length -gt 0 -and $b[0] -eq 0) { $sensitive = $true } }
}
$kind = 'none'
if ($c::ContainsText()) { $kind = 'text' } elseif ($c::ContainsImage()) { $kind = 'image' } elseif ($c::ContainsFileDropList()) { $kind = 'files' }
$text = ''
if ($kind -eq 'text' -and -not $sensitive) {
  $t = Get-Clipboard -Raw
  if ($null -ne $t) { $text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)) }
}
@{ kind = $kind; sensitive = $sensitive; text = $text } | ConvertTo-Json -Compress
`

/** Text arrives on stdin as base64 UTF-8; an empty string clears the clipboard. */
const WIN_WRITE = `
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd().Trim()
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))
if ($t -eq '') { Set-Clipboard -Value $null } else { Set-Clipboard -Value $t }
`

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command']

const windows = (run) => ({
  async read(signal) {
    const result = await run(powershell(), [...PS_ARGS, WIN_READ], { signal })
    if (result.code !== 0) throw failed('Reading the clipboard', result)
    return shape(result.stdout)
  },
  async write(text, signal) {
    const input = Buffer.from(text, 'utf8').toString('base64')
    const result = await run(powershell(), [...PS_ARGS, WIN_WRITE], { input, signal })
    if (result.code !== 0) throw failed('Setting the clipboard', result)
  },
})

/** Parse the Windows script's one line of JSON into the shape every backend returns. */
function shape(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    throw new Error('Reading the clipboard failed: unreadable answer')
  }
  const kind = ['text', 'image', 'files'].includes(parsed?.kind) ? parsed.kind : 'none'
  const sensitive = parsed?.sensitive === true
  const text =
    kind === 'text' && !sensitive && typeof parsed.text === 'string' ?
      Buffer.from(parsed.text, 'base64').toString('utf8')
    : undefined
  return { kind, sensitive, text }
}

// --- macOS ------------------------------------------------------------------------------

/** The pasteboard's type names, as JSON. Concealed and transient types are how apps say "secret". */
const MAC_TYPES = `
ObjC.import('AppKit');
const types = ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.types) || [];
JSON.stringify(types);
`

const macos = (run) => ({
  async read(signal) {
    const listed = await run('osascript', ['-l', 'JavaScript', '-e', MAC_TYPES], { signal })
    if (listed.code !== 0) throw failed('Reading the clipboard', listed)
    let types
    try {
      types = JSON.parse(listed.stdout.trim() || '[]')
    } catch {
      throw new Error('Reading the clipboard failed: unreadable answer')
    }
    if (!Array.isArray(types)) types = []
    const has = (...names) => names.some((n) => types.includes(n))
    const sensitive = has('org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType')
    const kind =
      has('public.utf8-plain-text', 'NSStringPboardType', 'public.plain-text') ? 'text'
      : has('public.png', 'public.tiff', 'public.jpeg') ? 'image'
      : has('public.file-url', 'NSFilenamesPboardType') ? 'files'
      : 'none'
    if (kind !== 'text' || sensitive) return { kind, sensitive, text: undefined }
    const got = await run('pbpaste', [], { signal })
    if (got.code !== 0) throw failed('Reading the clipboard', got)
    return { kind, sensitive, text: got.stdout }
  },
  async write(text, signal) {
    const result = await run('pbcopy', [], { input: text, signal })
    if (result.code !== 0) throw failed('Setting the clipboard', result)
  },
})

/** The backend for a platform, or `undefined` where there is none. */
export function clipboardFor(platform = process.platform, run = runCommand) {
  if (platform === 'win32') return windows(run)
  if (platform === 'darwin') return macos(run)
  return undefined
}
