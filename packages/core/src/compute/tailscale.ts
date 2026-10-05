// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * **Tailscale, operated from Alexia** — so two computers that are not on the same network can
 * still reach each other, with no server of Alexia's.
 *
 * Tailscale puts every computer signed in to one account on a private network of their own
 * (`100.x.y.z` addresses). Alexia does not replace it or speak its protocol: it finds the program,
 * installs it from Tailscale's own download when it is missing (the operating system's installer
 * asks for permission, as it would for anything), starts it, opens the one sign-in page, and
 * reads `tailscale status --json` to see which computers are there. The connection between two
 * paired Alexias is still iroh's, end to end encrypted; Tailscale only carries it when they are
 * not on the same network.
 */

export type TailscalePhase = 'not-installed' | 'installing' | 'stopped' | 'needs-login' | 'starting' | 'running' | 'unavailable'

export interface TailscalePeer { name: string; os: string; ips: string[]; online: boolean }
export interface TailscaleState {
  phase: TailscalePhase
  /** A sentence for the screen, in plain words. */
  said: string
  /** This computer on the private network, once signed in. */
  self?: { name: string; ips: string[] }
  peers: TailscalePeer[]
  /** The one page to sign in at, while Tailscale is waiting for it. */
  loginUrl?: string
  /** Where installing could not be done by Alexia, what the person does instead. */
  instructions?: string
}

/** Runs a program and answers its output. A seam, so tests need no Tailscale. */
export type Run = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

export const run: Run = (file, args, timeoutMs) => new Promise((resolve) => {
  // The Mac app's binary is the command line only when it is told so — from a terminal it
  // guesses right, but launched by another app (Alexia) it tries to open its own window instead.
  const env = { ...process.env, TAILSCALE_BE_CLI: '1' }
  execFile(file, [...args], { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
    resolve({ code, stdout: String(stdout), stderr: String(stderr) })
  })
})

/** Windows' Program Files, as the system names it. */
const programFiles = (env: NodeJS.ProcessEnv = process.env): string => env.ProgramFiles ?? win32.join(`${env.SystemDrive ?? 'C:'}${win32.sep}`, 'Program Files')

/**
 * Where the command line lives, by platform: the app's own copy first, then wherever `PATH`
 * says — which is where Homebrew and the Linux packages put it.
 */
export function candidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  // Paths in the target system's own spelling, whatever system is asking.
  const path = platform === 'win32' ? win32 : posix
  const named = platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  const onPath = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== '').map((dir) => path.join(dir, named))
  if (platform === 'darwin') return [path.join(path.sep, 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'), ...onPath]
  if (platform === 'win32') return [path.join(programFiles(env), 'Tailscale', named), ...onPath]
  return onPath
}

/** Tailscale's own installers. Signed by Tailscale; the operating system checks that when it opens them. */
export const INSTALLERS: Partial<Record<NodeJS.Platform, { url: string; file: string }>> = {
  darwin: { url: 'https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg', file: 'Tailscale.pkg' },
  win32: { url: 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe', file: 'tailscale-setup.exe' },
}
const LINUX = 'Install Tailscale with: curl -fsSL https://tailscale.com/install.sh | sh — then press Connect again.'

/** A Tailscale address: IPv4 in 100.64.0.0/10, or IPv6 under fd7a:115c:a1e0::/48. */
export function isTailnet(ip: string): boolean {
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(ip)
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

interface StatusJson {
  BackendState?: string
  AuthURL?: string
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] }
  Peer?: Record<string, { HostName?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[]; Online?: boolean }>
}

/** `tailscale status --json`, in the shape the screen and the link read. */
export function parseStatus(text: string): TailscaleState {
  let said: StatusJson
  try {
    said = JSON.parse(text) as StatusJson
  } catch {
    return { phase: 'unavailable', said: 'Tailscale is installed but did not answer. Open the Tailscale app once, then try again.', peers: [] }
  }
  const name = (one: { HostName?: string; DNSName?: string }): string => String(one.HostName || one.DNSName?.split('.')[0] || 'device').slice(0, 60)
  const ips = (list?: string[]): string[] => (list ?? []).filter((ip) => typeof ip === 'string' && isTailnet(ip)).slice(0, 4)
  const peers = Object.values(said.Peer ?? {}).map((one) => ({ name: name(one), os: String(one.OS ?? ''), ips: ips(one.TailscaleIPs), online: one.Online === true }))
  switch (said.BackendState) {
    case 'Running':
      return {
        phase: 'running', said: `Connected to Tailscale. ${String(peers.filter((p) => p.online).length)} other computer${peers.filter((p) => p.online).length === 1 ? ' is' : 's are'} online on it.`,
        self: { name: name(said.Self ?? {}), ips: ips(said.Self?.TailscaleIPs) }, peers,
      }
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return { phase: 'needs-login', said: 'Tailscale needs you to sign in once.', peers: [], ...(said.AuthURL && /^https:\/\//.test(said.AuthURL) && { loginUrl: said.AuthURL }) }
    case 'Starting':
      return { phase: 'starting', said: 'Tailscale is starting.', peers }
    case 'Stopped':
      return { phase: 'stopped', said: 'Tailscale is installed but switched off.', peers: [] }
    default:
      return { phase: 'stopped', said: 'Tailscale is installed but not running.', peers: [] }
  }
}

export interface TailscaleOptions {
  platform?: NodeJS.Platform
  run?: Run
  /** Where an installer is downloaded to. */
  downloads: string
  fetch?: typeof fetch
  /** Open a file or a page the way the person's computer opens it. */
  open?(target: string): void
  exists?(path: string): boolean
}

/** Open with whatever this computer opens such things with — the browser, the installer. */
export function opener(platform: NodeJS.Platform = process.platform): (target: string) => void {
  return (target) => {
    const [file, args] = platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]]
    spawn(file, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
}

export class Tailscale {
  private readonly platform: NodeJS.Platform
  private readonly run: Run
  private readonly exists: (path: string) => boolean
  private readonly open: (target: string) => void
  private installing: Promise<void> | undefined

  constructor(private readonly options: TailscaleOptions) {
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? run
    this.exists = options.exists ?? existsSync
    this.open = options.open ?? opener(this.platform)
  }

  /** The command line, if Tailscale is installed. */
  cli(): string | undefined {
    return candidates(this.platform).find((path) => this.exists(path))
  }

  async status(): Promise<TailscaleState> {
    const cli = this.cli()
    if (!cli) {
      if (this.installing) return { phase: 'installing', said: 'Installing Tailscale. Follow the installer that opened, then come back here.', peers: [] }
      return {
        phase: 'not-installed', said: 'Tailscale is not installed on this computer.', peers: [],
        ...(!INSTALLERS[this.platform] && { instructions: LINUX }),
      }
    }
    const said = await this.run(cli, ['status', '--json'], 8000)
    // A status that is not running still prints JSON, with a non-zero exit. Read whatever came.
    return parseStatus(said.stdout.trim() || '{}')
  }

  /**
   * Download Tailscale's own installer and open it. The installer — and the operating system's
   * permission prompt — is the person's to click through; this waits for neither.
   */
  async install(): Promise<TailscaleState> {
    if (this.cli()) return this.status()
    const installer = INSTALLERS[this.platform]
    if (!installer) return { phase: 'not-installed', said: 'Alexia cannot install Tailscale on this system by itself.', peers: [], instructions: LINUX }
    this.installing ??= (async () => {
      mkdirSync(this.options.downloads, { recursive: true })
      const to = join(this.options.downloads, installer.file)
      const answered = await (this.options.fetch ?? fetch)(installer.url, { redirect: 'follow' })
      if (!answered.ok || !answered.body) throw new Error(`Tailscale's download answered ${String(answered.status)}.`)
      await pipeline(Readable.fromWeb(answered.body as import('node:stream/web').ReadableStream), createWriteStream(to))
      this.open(to)
    })().finally(() => {
      // Kept as "installing" until the program appears; a failed download can be tried again.
      setTimeout(() => { this.installing = undefined }, 10 * 60_000).unref()
    })
    try {
      await this.installing
    } catch (error) {
      this.installing = undefined
      return { phase: 'not-installed', said: `Tailscale could not be downloaded: ${error instanceof Error ? error.message : String(error)}`, peers: [] }
    }
    return this.status()
  }

  /** Switch it on. On a Mac and on Windows that is the Tailscale app; elsewhere `tailscale up`. */
  async start(): Promise<TailscaleState> {
    const cli = this.cli()
    if (!cli) return this.status()
    if (this.platform === 'darwin') this.open(posix.join(posix.sep, 'Applications', 'Tailscale.app'))
    else if (this.platform === 'win32') {
      const app = win32.join(programFiles(), 'Tailscale', 'tailscale-ipn.exe')
      if (this.exists(app)) this.open(app)
    }
    // `up` on its own asks for nothing when already signed in, and starts the sign-in otherwise.
    void this.run(cli, ['up', '--timeout=5s'], 8000)
    return this.status()
  }

  /**
   * Start signing in, and open the page to do it at. Tailscale signs in with an account the
   * person already has (Google, Microsoft, Apple, GitHub or an email); the same account on both
   * computers is what puts them on one private network.
   */
  async login(): Promise<TailscaleState> {
    const cli = this.cli()
    if (!cli) return this.status()
    // `login` waits for the browser; it is left running and the page is read from the status.
    const child = this.run(cli, ['login', '--timeout=5m'], 6 * 60_000)
    void child
    for (let tries = 0; tries < 20; tries++) {
      const now = await this.status()
      if (now.phase === 'running') return now
      if (now.loginUrl) {
        this.open(now.loginUrl)
        return { ...now, said: 'A page opened in your browser. Sign in there, with the same account on both computers.' }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return this.status()
  }

  /** This computer's private-network addresses, when Tailscale is running. */
  async ips(): Promise<string[]> {
    const now = await this.status().catch(() => undefined)
    return now?.phase === 'running' ? now.self?.ips ?? [] : []
  }
}
