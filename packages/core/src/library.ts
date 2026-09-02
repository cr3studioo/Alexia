// SPDX-License-Identifier: AGPL-3.0-only
import {
  ALEXIA_PROTOCOL_MAX,
  ALEXIA_PROTOCOL_MIN,
  APP_VERSION,
  newer,
  versionVerdict,
  withinApp,
} from '@alexia/protocol'
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

/**
 * Where the list comes from (D118).
 *
 * **`github:owner/repo` — the releases of a repository are the shelf.** A plugin version is
 * a GitHub Release: the `.tgz` is an asset on it, and the entry a browser would have read
 * out of a registry index is a fenced ```alexia block in the release body. Publishing is
 * therefore `gh release create`, and there is no index to regenerate, no site to deploy and
 * nothing that can go stale between cutting a release and somebody seeing it — which is the
 * whole reason this replaced the static site: *a developer publishes a release and users see
 * the plugin* is one step or it is not true.
 *
 * The app's own repository is the default because it is the one that exists. Plugin releases
 * are tagged `<id>-v<version>` and app releases `v<version>`; the two never collide because a
 * release is only read as a plugin if it carries the block. Pointing this at a repository of
 * nothing but plugins is one setting away, and that is what a third party publishing on their
 * own account does — {@link url} is a kv entry, so a fork points at its own.
 *
 * **`https://…` still means the static layout**, four JSON files under `/v0/`, which is what
 * `registry/`'s Worker and a GitHub Pages site both serve. Kept rather than deleted: it costs
 * one branch here, it is what a registry serving strangers should go back to — its
 * `/v0/revoked.json` is a kill switch reaching people who already installed something, and
 * GitHub has no equivalent — and it is the only shape that works behind an air gap.
 */
export const DEFAULT_REGISTRY = 'github:cr3studioo/Alexia'

/** `github:owner/repo`. Anything else is read as a base URL for the static layout. */
const GITHUB = /^github:([\w.-]+)\/([\w.-]+)$/

/**
 * How long a read of the shelf is reused.
 *
 * GitHub allows sixty unauthenticated requests an hour from one address, and the Plugins
 * screen re-reads the shelf every time it is opened. Fifteen minutes is the difference
 * between a screen somebody can open repeatedly and one that starts answering 403 on the
 * afternoon they are choosing what to install. The install path asks for a fresh read
 * regardless — see {@link Library.entry}.
 */
const FRESH_MS = 15 * 60 * 1000

/** The block a release body carries, which is the whole of a plugin's metadata. */
const BLOCK = /```alexia\s([\s\S]*?)```/

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
  /** The Alexia builds it runs on. Absent means any — see `withinApp`. */
  min_app?: string
  max_app?: string
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
    const repo = this.#repo()
    const found =
      repo ? (await this.#shelf(repo)).plugins
      : (((await this.#get('/v0/plugins.json')) as { plugins?: Entry[] }).plugins ?? [])
    return found.filter((entry) => ID.test(entry.id) && HEX64.test(entry.sha256))
  }

  async skills(): Promise<SkillEntry[]> {
    const repo = this.#repo()
    const found =
      repo ? (await this.#shelf(repo)).skills
      : (((await this.#get('/v0/skills.json')) as { skills?: SkillEntry[] }).skills ?? [])
    return found.filter((entry) => ID.test(entry.id) && HEX64.test(entry.sha256))
  }

  /**
   * What has been pulled. Asked about what is already on disk, never cached.
   *
   * **A GitHub source has no answer to this and says so by answering nothing.** Withdrawing
   * a plugin there is deleting its release, which stops every future install immediately and
   * reaches nobody who already ran one. That is a real loss against the static registry,
   * whose `/v0/revoked.json` exists for exactly the person who is not currently browsing, and
   * it is the one reason `publishing.md` still names the static layout as the right answer
   * for a registry serving strangers. An empty list is the honest shape of *this source
   * cannot tell you* — the alternative would be a screen implying nothing has been withdrawn.
   */
  async revoked(): Promise<{ plugins: Revocation[]; skills: Revocation[] }> {
    if (this.#repo()) return { plugins: [], skills: [] }
    const body = (await this.#get('/v0/revoked.json')) as { plugins?: Revocation[]; skills?: Revocation[] }
    return { plugins: body.plugins ?? [], skills: body.skills ?? [] }
  }

  /**
   * One entry, fetched afresh at the moment of install.
   *
   * The listing may be fifteen minutes old; a withdrawal may be five seconds old. So the
   * install path asks about this one plugin rather than trusting the row it was drawn from —
   * a fresh read of the releases on a GitHub source, where a deleted release is simply no
   * longer there, and a 410 on a static one, which stops it here with the registry's reason.
   */
  async entry(id: string): Promise<Entry | { revoked: string } | undefined> {
    if (!ID.test(id)) return undefined
    const repo = this.#repo()
    if (repo) return (await this.#shelf(repo, 0)).plugins.find((row) => row.id === id)
    const response = await this.#fetch(new URL(`/v0/plugins/${id}.json`, this.url))
    if (response.status === 410) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string }
      return { revoked: body.reason ?? 'withdrawn' }
    }
    if (!response.ok) return undefined
    return (await response.json()) as Entry
  }

  /**
   * What is installed here that the shelf has a newer version of (M5-4, D118).
   *
   * **This is now the only update path there is.** It used to be one of two: first-party
   * plugins rode along inside the installer and everything else updated on its own schedule.
   * Nothing rides along any more — the installer ships no plugins at all — so every plugin on
   * the machine, ours included, is updated from the same shelf by this method. One path, and
   * a plugin author no longer waits for an Alexia release to ship a fix.
   *
   * **Nothing incompatible is hidden here, it is labelled.** A newer version this build
   * cannot run is exactly the thing a person needs told about — it is the reason to update
   * Alexia — so the verdict travels with the row and the screen decides what to say. Offering
   * it as a press would be offering somebody a working plugin in exchange for a broken one.
   */
  async updates(
    here: readonly { id: string; version: string }[],
  ): Promise<{ id: string; from: string; to: string; entry: Entry; offer: Offer }[]> {
    const available = await this.plugins()
    const found: { id: string; from: string; to: string; entry: Entry; offer: Offer }[] = []
    for (const installed of here) {
      const entry = available.find((row) => row.id === installed.id)
      if (!entry) continue
      if (!newer(entry.version, installed.version)) continue
      const offer = offerable(entry)
      // Written for an Alexia older than this one: not an update, and not news either.
      if (offer === 'stale') continue
      found.push({ id: entry.id, from: installed.version, to: entry.version, entry, offer })
    }
    return found
  }

  /**
   * Install: fetch, check, unpack, and stop.
   *
   * The order is the safety. Nothing is written into the folder core watches until the
   * bytes have hashed to what the registry said they would — an archive that is unpacked
   * first and checked afterwards has already put files on the disk.
   *
   * `replace` is the update path (M5-4). It removes **the install folder and nothing else**
   * — not the namespace, not the settings, not the plugin's own directory and whatever it
   * spent twenty minutes downloading into it. That distinction is the entire difference
   * between updating a plugin and deleting one and installing it again, and it is the
   * reason this is a flag here rather than two calls from the caller.
   */
  async install(
    id: string,
    onProgress?: (done: number, total: number) => void,
    replace = false,
  ): Promise<{ ok: true; id: string; signature: 'verified' | 'unverified' | 'none' } | { ok: false; why: string }> {
    const found = await this.entry(id).catch((error: unknown) => ({ why: String(error) }))
    if (!found) return { ok: false, why: `The registry has no plugin called “${id}”.` }
    if ('why' in found) return { ok: false, why: `The registry could not be reached: ${found.why}` }
    if ('revoked' in found) {
      return { ok: false, why: `${id} has been withdrawn from the registry: ${found.revoked}` }
    }
    // The same gate the shelf and the loader use, asked once more at the moment it matters.
    // A row can sit on a screen while somebody thinks about it, and *this build cannot run
    // that* is a refusal worth having before a download rather than after one.
    const verdict = versionVerdict(found)
    if (!verdict.ok) return { ok: false, why: verdict.reason }

    const to = join(this.options.pluginsDir, found.id)
    if (existsSync(to) && !replace) {
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
      // The old folder goes only now — after the bytes are here, checked and unpacked. An
      // update that removed it first and then failed to download would have taken a working
      // plugin away in exchange for nothing.
      if (replace) rmSync(to, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      cpTree(root, to)
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

  /** `github:owner/repo`, if that is the shape of this source. Undefined means static JSON. */
  #repo(): { owner: string; repo: string } | undefined {
    const said = GITHUB.exec(this.url)
    return said ? { owner: said[1]!, repo: said[2]! } : undefined
  }

  /** The last read of the releases, and which source it was of. See {@link FRESH_MS}. */
  #held?: { source: string; at: number; shelf: Shelf }

  /**
   * The last shelf that arrived, kept across restarts — and handed back when a read fails.
   *
   * **Written after the first real publish rate-limited this machine within the hour.**
   * GitHub allows sixty unauthenticated requests an hour *per address*, and that address is
   * shared with everything else on it: another tool, another session, a second person on the
   * same network. Alexia's own share is four an hour, and it still arrived at a 403 — so a
   * client that treats a failed read as an empty shelf is a Plugins screen that goes blank
   * because somebody else was busy.
   *
   * A day-old list of plugins is very nearly as good as a fresh one: a plugin published this
   * morning is missing until the next read, and everything else works. An empty screen is
   * not nearly as good as anything.
   */
  #remembered(source: string): Shelf | undefined {
    const said = this.options.store.kvGet(CORE, 'shelf')
    if (typeof said !== 'object' || said === null) return undefined
    const kept = said as { source?: string; shelf?: Shelf }
    return kept.source === source ? kept.shelf : undefined
  }

  /**
   * Every release of the repository, read as a shelf.
   *
   * One request for the whole thing, which is what makes a release body the right place for
   * the metadata: an asset holding the same JSON would be a second request per plugin, and
   * thirteen of those on the startup of an app with an hourly quota of sixty is a screen that
   * works in the morning and 403s in the afternoon.
   *
   * ponytail: one page, so the hundredth release is the last one seen. That is a hundred
   * plugin *versions*, not plugins, and the day it binds the answer is `?page=2`.
   */
  async #shelf(repo: { owner: string; repo: string }, maxAge: number = FRESH_MS): Promise<Shelf> {
    const source = `${repo.owner}/${repo.repo}`
    const held = this.#held
    if (held && held.source === source && Date.now() - held.at <= maxAge) return held.shelf
    let shelf: Shelf
    try {
      const response = await this.#fetch(`https://api.github.com/repos/${source}/releases?per_page=100`, {
        // No token, ever. This reads public releases, and a library that wanted a GitHub
        // credential to show somebody a list would be asking for something it does not need.
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Alexia' },
      })
      if (!response.ok) {
        throw new Error(
          response.status === 403 || response.status === 429 ?
            // This message is only ever *read* when there is no remembered shelf to fall back
            // to — a successful fallback shows the list and says nothing. So it must not
            // promise a list below it; there is not one.
            `GitHub is rate-limiting this address (${String(response.status)}). That quota is shared by everything on this network rather than being Alexia's own, and it resets within the hour.`
          : `GitHub answered ${String(response.status)} for ${source}`,
        )
      }
      shelf = readReleases((await response.json()) as Release[])
    } catch (error) {
      // Stale beats empty. Only when there is something to be stale *with* — a first run
      // that has never reached GitHub has nothing to show and says so.
      const kept = this.#remembered(source)
      if (!kept) throw error
      return kept
    }
    this.#held = { source, at: Date.now(), shelf }
    this.options.store.kvSet(CORE, 'shelf', { source, at: Date.now(), shelf })
    return shelf
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

/** What one read of a repository's releases amounts to: two shelves, kept apart. */
interface Shelf {
  plugins: Entry[]
  skills: SkillEntry[]
}

/** As much of GitHub's release JSON as this reads. Everything else on it is ignored. */
interface Release {
  tag_name?: string
  body?: string
  draft?: boolean
  published_at?: string
  assets?: { name: string; browser_download_url: string }[]
}

/**
 * Releases in, shelf out (D118).
 *
 * **The bytes are named by the release, not by the block.** A publisher writes the metadata
 * and Alexia reads the download URL off the attached asset, so the two cannot point in
 * different directions: whatever is offered is on the release that offered it. The checksum
 * is still what the install gates on — that has not changed and is the reason a compromised
 * shelf can lie about what a plugin *is* and cannot silently change what it *does*.
 *
 * A release with no block is not a plugin release. That is what keeps the app's own
 * installers — which live in the same repository and are how Alexia updates itself — from
 * turning up on the Plugins screen as something to install.
 */
function readReleases(releases: Release[]): Shelf {
  const plugins = new Map<string, Entry>()
  // Keyed by id and holding the version beside the entry, because a `SkillEntry` has no
  // version field of its own — a skill is a folder of text, and what it is worth is not
  // versioned the way code is. The release still has one, and it is what picks the winner.
  const skills = new Map<string, { version: string; entry: SkillEntry }>()

  for (const release of releases) {
    if (release.draft === true) continue
    const said = BLOCK.exec(release.body ?? '')
    if (!said) continue
    let block: Record<string, unknown>
    try {
      block = JSON.parse(said[1]!) as Record<string, unknown>
    } catch {
      // Somebody's release notes, malformed or merely not ours. Skipping it silently is
      // right: this is not a publishing tool and the person reading the screen did not write
      // it. `scripts/publish.mjs` is where a mistake in this block is caught.
      continue
    }
    const archive = (release.assets ?? []).find((asset) => asset.name.endsWith('.tgz'))
    if (!archive || typeof block.id !== 'string' || typeof block.version !== 'string') continue
    const at = Date.parse(release.published_at ?? '')
    const common = {
      ...block,
      url: archive.browser_download_url,
      updated_at: Number.isNaN(at) ? 0 : Math.floor(at / 1000),
    }

    if (block.kind === 'skill') {
      const held = skills.get(block.id)
      // Newest wins, and *newest* is the version rather than the date: a release cut to fix
      // last month's notes is not a new version of anything.
      if (!held || newer(block.version, held.version)) {
        skills.set(block.id, { version: block.version, entry: common as unknown as SkillEntry })
      }
      continue
    }
    const held = plugins.get(block.id)
    if (!held || newer(block.version, held.version)) plugins.set(block.id, common as unknown as Entry)
  }
  return { plugins: [...plugins.values()], skills: [...skills.values()].map((held) => held.entry) }
}

/**
 * Whether this build can be offered that (D118).
 *
 * Three answers, and the middle one is the whole point of the field: `newer-app` is a plugin
 * that exists, works, and needs an Alexia this person has not installed yet. Hiding it
 * outright would leave them wondering where it went; offering it would install something
 * that cannot load. So it is counted, and the screen says *two plugins need a newer Alexia*
 * — which is the only sentence that turns a missing plugin into something a person can act
 * on.
 *
 * `stale` is the other direction: written for an Alexia older than this one, and there is
 * nothing anybody with this build can do about it but wait for its author.
 */
export type Offer = 'ok' | 'newer-app' | 'stale'

export function offerable(
  entry: Pick<Entry, 'alexia_protocol'> & { min_app?: string; max_app?: string },
  app: string = APP_VERSION,
): Offer {
  if (entry.min_app !== undefined && newer(entry.min_app, app)) return 'newer-app'
  if (!withinApp(entry, app)) return 'stale'
  if (entry.alexia_protocol > ALEXIA_PROTOCOL_MAX) return 'newer-app'
  if (entry.alexia_protocol < ALEXIA_PROTOCOL_MIN) return 'stale'
  return 'ok'
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
