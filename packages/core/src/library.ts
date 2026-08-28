// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { createHash, verify as verifySignature } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CORE } from './secrets.js'
import type { Store } from './store.js'

/**
 * The library (M3-2) and what makes it safe to use (M3-7).
 *
 * A registry entry is a **name, a URL and a checksum**. The registry holds no bytes, so a
 * compromised registry can point somewhere else but cannot silently change what a plugin
 * is — and the checksum is verified here, against the bytes that actually arrived, before
 * anything is unpacked. A mismatch deletes the download and says so.
 *
 * Three rules the screen depends on, all enforced here rather than there:
 *
 * - **Never auto-enable.** Install writes a folder. Somebody then reads what it asked for,
 *   in its author's own words, and says yes. Those are two separate acts and this file only
 *   ever performs the first.
 * - **What it asked for is shown before the download**, not after — the entry carries
 *   `requires` for exactly that reason.
 * - **A revocation reaches somebody who already installed it.** `/v0/revoked` is the half
 *   of the registry that exists for people who are not currently browsing.
 */

/** Where the list comes from. Overridable in settings, because a fork needs its own. */
export const DEFAULT_REGISTRY = 'https://registry.alexia.dev'

export interface Entry {
  id: string
  name: string
  summary: string
  version: string
  license: string
  author?: string
  url: string
  sha256: string
  signature?: string
  alexia_protocol: number
  mcp_protocol: string
  /** The author's own sentences. Shown before anything is downloaded, never rewritten. */
  requires: { cap: string; why: string }[]
  provides: string[]
  updated_at: number
}

export interface SkillEntry {
  id: string
  name: string
  description: string
  license?: string
  author?: string
  url: string
  sha256: string
  signature?: string
}

export interface Revocation {
  id: string
  revoked_at: number
  revoked_reason: string
}

export interface LibraryOptions {
  store: Store
  /** Where downloads are unpacked to: the same folder `Plugins` watches. */
  pluginsDir: string
  /** Where a marketplace skill lands. Standalone, so deleting it is deleting a folder. */
  skillsDir: string
  /** Overridden in tests. Everything else goes through the real one. */
  fetch?: typeof globalThis.fetch
}

const HEX64 = /^[0-9a-f]{64}$/
/** A registry id is a folder name. Nothing else may be, which is the whole of the check. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export class Library {
  constructor(private readonly options: LibraryOptions) {}

  /** The registry this Alexia talks to. One kv entry, so a fork points at its own. */
  get url(): string {
    const said = this.options.store.kvGet(CORE, 'registry')
    return typeof said === 'string' && said !== '' ? said : DEFAULT_REGISTRY
  }

  set url(to: string) {
    this.options.store.kvSet(CORE, 'registry', to)
  }

  /**
   * The publisher's ed25519 key, in SPKI PEM, if the user has set one.
   *
   * Absent by default and **absent is said out loud** rather than treated as fine: an
   * unverified signature is exactly as good as no signature, and a library that showed a
   * padlock for one would be lying. The checksum gates the install either way.
   */
  get publisherKey(): string | undefined {
    const said = this.options.store.kvGet(CORE, 'registry_key')
    return typeof said === 'string' && said !== '' ? said : undefined
  }

  set publisherKey(pem: string | undefined) {
    this.options.store.kvSet(CORE, 'registry_key', pem ?? '')
  }

  async plugins(): Promise<Entry[]> {
    const body = (await this.#get('/v0/plugins')) as { plugins?: Entry[] }
    return (body.plugins ?? []).filter((entry) => ID.test(entry.id) && HEX64.test(entry.sha256))
  }

  async skills(): Promise<SkillEntry[]> {
    const body = (await this.#get('/v0/skills')) as { skills?: SkillEntry[] }
    return (body.skills ?? []).filter((entry) => ID.test(entry.id) && HEX64.test(entry.sha256))
  }

  /** What has been pulled. Asked about what is already on disk, never cached. */
  async revoked(): Promise<{ plugins: Revocation[]; skills: Revocation[] }> {
    const body = (await this.#get('/v0/revoked')) as { plugins?: Revocation[]; skills?: Revocation[] }
    return { plugins: body.plugins ?? [], skills: body.skills ?? [] }
  }

  /**
   * One entry, fetched afresh at the moment of install.
   *
   * The listing may be five minutes old; a revocation may be five seconds old. So the
   * install path asks about this one plugin rather than trusting the row it was drawn from,
   * and a 410 stops it here with the reason the registry gave.
   */
  async entry(id: string): Promise<Entry | { revoked: string } | undefined> {
    if (!ID.test(id)) return undefined
    const response = await this.#fetch(new URL(`/v0/plugins/${id}`, this.url))
    if (response.status === 410) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string }
      return { revoked: body.reason ?? 'withdrawn' }
    }
    if (!response.ok) return undefined
    return (await response.json()) as Entry
  }

  /**
   * Install: fetch, check, unpack, and stop.
   *
   * The order is the safety. Nothing is written into the folder core watches until the
   * bytes have hashed to what the registry said they would — an archive that is unpacked
   * first and checked afterwards has already put files on the disk.
   */
  async install(
    id: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: true; id: string; signature: 'verified' | 'unverified' | 'none' } | { ok: false; why: string }> {
    const found = await this.entry(id).catch((error: unknown) => ({ why: String(error) }))
    if (!found) return { ok: false, why: `The registry has no plugin called “${id}”.` }
    if ('why' in found) return { ok: false, why: `The registry could not be reached: ${found.why}` }
    if ('revoked' in found) {
      return { ok: false, why: `${id} has been withdrawn from the registry: ${found.revoked}` }
    }
    if (existsSync(join(this.options.pluginsDir, found.id))) {
      return { ok: false, why: `${found.name} is already installed. Delete it first to replace it.` }
    }

    const staging = mkdtempSync(join(tmpdir(), 'alexia-install-'))
    try {
      const archive = join(staging, 'plugin.tgz')
      const digest = await download(this.#fetch.bind(this), found.url, archive, onProgress)
      if (digest !== found.sha256) {
        // The bytes are not the bytes the registry described. There is no benign version of
        // this, so nothing is unpacked and the download goes.
        return {
          ok: false,
          why: `What downloaded is not what the registry described. Expected ${found.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…. Nothing was installed.`,
        }
      }

      const signature = this.#checkSignature(found)
      if (signature === 'bad') {
        return { ok: false, why: `${found.name}’s signature does not match the publisher key you configured. Nothing was installed.` }
      }

      const unpacked = join(staging, 'out')
      mkdirSync(unpacked, { recursive: true })
      await extract(archive, unpacked)

      // An archive is somebody else's tree. The folder that becomes the plugin is the one
      // holding a `plugin.json` — at the root, or one level down, which is how `npm pack`
      // and every `git archive` lay one out.
      const root = holdingManifest(unpacked)
      if (!root) return { ok: false, why: `${found.name}’s download has no plugin.json in it.` }
      const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as { id?: unknown }
      if (manifest.id !== found.id) {
        // The registry row and the manifest disagree about what this is. That is either a
        // mistake or a substitution, and neither one gets a folder.
        return { ok: false, why: `The registry calls it “${found.id}” and its plugin.json calls it “${String(manifest.id)}”.` }
      }

      mkdirSync(this.options.pluginsDir, { recursive: true })
      cpTree(root, join(this.options.pluginsDir, found.id))
      // Installed. Not enabled — nobody has read what it asked for yet, and that reading is
      // the whole of what consent means here.
      return { ok: true, id: found.id, signature: signature === 'verified' ? 'verified' : signature === 'none' ? 'none' : 'unverified' }
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.message : String(error) }
    } finally {
      rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  /**
   * A skill from the marketplace (M3-5).
   *
   * Deliberately the same shape and deliberately a different list. A skill is text the
   * model reads; a plugin is code that runs on this machine. Worst case bad advice against
   * worst case anything the machine can do — so they are two marketplaces, and the
   * difference is visible rather than something a user infers from a badge.
   */
  async installSkill(id: string): Promise<{ ok: true; name: string } | { ok: false; why: string }> {
    const found = (await this.skills()).find((skill) => skill.id === id)
    if (!found) return { ok: false, why: `The registry has no skill called “${id}”.` }
    const to = join(this.options.skillsDir, found.name)
    if (existsSync(to)) return { ok: false, why: `A skill called “${found.name}” is already installed.` }

    const staging = mkdtempSync(join(tmpdir(), 'alexia-skill-'))
    try {
      const archive = join(staging, 'skill.tgz')
      const digest = await download(this.#fetch.bind(this), found.url, archive)
      if (digest !== found.sha256) {
        return { ok: false, why: `What downloaded is not what the registry described. Nothing was installed.` }
      }
      const unpacked = join(staging, 'out')
      mkdirSync(unpacked, { recursive: true })
      await extract(archive, unpacked)
      const root = holding(unpacked, 'SKILL.md')
      if (!root) return { ok: false, why: `${found.name}’s download has no SKILL.md in it.` }
      mkdirSync(this.options.skillsDir, { recursive: true })
      cpTree(root, to)
      return { ok: true, name: found.name }
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.message : String(error) }
    } finally {
      rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }

  /**
   * Signing, and the honest word for what happens without a key.
   *
   * `none` means the entry carries no signature. `unverified` means it carries one and
   * nobody here can check it, which is exactly as much assurance as `none` — so it is
   * reported as its own state rather than folded into either of the others.
   */
  #checkSignature(entry: Entry): 'verified' | 'unverified' | 'none' | 'bad' {
    if (!entry.signature) return 'none'
    const key = this.publisherKey
    if (!key) return 'unverified'
    try {
      // Over the checksum, not over the archive: the checksum is what the install actually
      // gates on, so signing it signs the bytes without anyone having to hold them twice.
      const ok = verifySignature(null, Buffer.from(entry.sha256, 'utf8'), key, Buffer.from(entry.signature, 'base64'))
      return ok ? 'verified' : 'bad'
    } catch {
      return 'bad'
    }
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.url))
    if (!response.ok) throw new Error(`the registry answered ${String(response.status)}`)
    return response.json()
  }

  #fetch(url: URL | string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(url, init)
  }
}

/**
 * One file, streamed to disk, hashed on the way past.
 *
 * Hashed *while streaming* rather than by reading the file back: the archive is up to a few
 * hundred megabytes and holding it twice is the difference between an install and a swap
 * storm on the machine this is written for.
 */
async function download(
  get: (url: string) => Promise<Response>,
  url: string,
  to: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const response = await get(url)
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  let done = 0

  await pipeline(
    async function* () {
      for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
        const bytes = chunk as Uint8Array
        hash.update(bytes)
        done += bytes.byteLength
        onProgress?.(done, total)
        yield bytes
      }
    },
    createWriteStream(to),
  )
  return hash.digest('hex')
}

/**
 * The archiver, and on Windows the *right* one.
 *
 * Windows 10 and later ship bsdtar as `System32\tar.exe`, which reads both tar.gz and zip
 * — so there is no archive parser here and no dependency for one, and that matters more
 * than the line count because such a parser would be reading a file off the internet.
 *
 * What is on `PATH` may not be that tar: Git for Windows puts GNU tar there, which cannot
 * read zip and reads a drive-lettered path as `host:path`. Asking the OS for its own copy
 * removes both problems in one line.
 */
const archiver = (): string => {
  const root = process.env.SystemRoot
  return process.platform === 'win32' && root ? join(root, 'System32', 'tar.exe') : 'tar'
}

export function extract(archive: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn(archiver(), ['-xf', archive, '-C', to], { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    tar.stderr?.on('data', (chunk) => (said += String(chunk)))
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve()
      : reject(new Error(`could not unpack the download: ${said.trim() || `tar exited ${String(code)}`}`)),
    )
  })
}

/** The folder in an unpacked archive holding `file` — at the root, or one level down. */
function holding(dir: string, file: string): string | undefined {
  if (existsSync(join(dir, file))) return dir
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, file))) return join(dir, entry.name)
  }
  return undefined
}

const holdingManifest = (dir: string): string | undefined => holding(dir, 'plugin.json')

/**
 * Copy a tree, refusing anything that is not a file or a directory.
 *
 * `cpSync` would follow a symlink out of the folder, and this tree came off the internet.
 * A symlink in a downloaded archive pointing at somebody's `.ssh` is the oldest archive
 * trick there is, so links are dropped rather than resolved.
 */
function cpTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) cpTree(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
    // Anything else — a symlink, a device, a socket — is not part of a plugin.
  }
}
