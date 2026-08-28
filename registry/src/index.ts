// SPDX-License-Identifier: AGPL-3.0-only
import type { D1Database, Env } from './d1.js'

/**
 * The registry (M3-1). A read API over a table, plus an admin path for one person.
 *
 * **It is a list with a revoke button**, and the revoke button is why this is a backend
 * rather than a git-hosted JSON index. Submissions are accepted early, so a plugin that
 * turns out to be malicious has to become unavailable *now* — not whenever every client
 * next re-fetches a file from a CDN.
 *
 * What is deliberately not here: search ranking, ratings, download charts, analytics,
 * accounts. Every one of them is a product growing out of a list, and none of them is
 * needed to say *here is a plugin, here is its checksum, here is what it asked for*.
 *
 * ponytail: no framework. Hono was the plan and it earns its place at about a dozen
 * routes; this has seven and a router of one regex. Add it the day the route table stops
 * fitting on a screen.
 */

/** The bytes are somewhere else. The registry says where, and what they must hash to. */
export interface PluginEntry {
  id: string
  name: string
  summary: string
  version: string
  license: string
  author?: string
  url: string
  sha256: string
  /** Detached ed25519 over the sha256 hex, base64. Absent is shown, never assumed fine. */
  signature?: string
  alexia_protocol: number
  mcp_protocol: string
  /** The author's own sentences. The walkthrough is drawn from these before any download. */
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
  updated_at: number
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A desktop client, a browser, a curl. Read is public; write is the token below.
      'access-control-allow-origin': '*',
      // Five minutes: long enough that a library screen is cheap, short enough that a
      // revocation reaches everyone the same afternoon. `/v0/revoked` is never cached.
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
    },
  })

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * A submission, held to the shape a client will have to trust. Hand-written rather than
 * validated by a library because this file is deployed on its own and a validator is the
 * only thing it would import — a registry that pulls half a runtime in to check nine
 * fields has the ratio wrong.
 */
function badPlugin(row: Partial<PluginEntry>): string | undefined {
  if (typeof row.id !== 'string' || !ID.test(row.id)) return 'id must be lowercase and hyphen-separated'
  if (typeof row.name !== 'string' || row.name === '') return 'name is required'
  if (typeof row.summary !== 'string' || row.summary === '') return 'summary is required'
  if (typeof row.version !== 'string' || !SEMVER.test(row.version)) return 'version must be semantic'
  if (typeof row.license !== 'string' || row.license === '') return 'license is required'
  if (typeof row.url !== 'string' || !row.url.startsWith('https://')) return 'url must be https'
  if (typeof row.sha256 !== 'string' || !HEX64.test(row.sha256)) return 'sha256 must be 64 hex characters'
  if (typeof row.alexia_protocol !== 'number') return 'alexia_protocol is required'
  if (typeof row.mcp_protocol !== 'string') return 'mcp_protocol is required'
  return undefined
}

function badSkill(row: Partial<SkillEntry>): string | undefined {
  if (typeof row.id !== 'string' || !ID.test(row.id)) return 'id must be lowercase and hyphen-separated'
  if (typeof row.name !== 'string' || !ID.test(row.name)) return 'name must be lowercase and hyphen-separated'
  if (typeof row.description !== 'string' || row.description === '') return 'description is required'
  if (typeof row.url !== 'string' || !row.url.startsWith('https://')) return 'url must be https'
  if (typeof row.sha256 !== 'string' || !HEX64.test(row.sha256)) return 'sha256 must be 64 hex characters'
  return undefined
}

/** JSON columns come back as text. One place turns them back, so no caller has to remember. */
const asPlugin = (row: Record<string, unknown>): PluginEntry => ({
  ...(row as unknown as PluginEntry),
  requires: JSON.parse(String(row.requires ?? '[]')) as PluginEntry['requires'],
  provides: JSON.parse(String(row.provides ?? '[]')) as string[],
  ...(row.author == null && { author: undefined }),
  ...(row.signature == null && { signature: undefined }),
})

/**
 * Nothing is written without it, and a deploy with no token configured writes nothing at
 * all. Compared over its whole length rather than short-circuiting on the first byte —
 * this is a bearer token on a public URL, and there is no reason to leak its prefix in a
 * timing curve.
 */
function admin(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN
  if (!expected) return false
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (given.length !== expected.length) return false
  let same = 0
  for (let i = 0; i < expected.length; i++) same |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return same === 0
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const db: D1Database = env.DB

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      },
    })
  }

  // ---- read ---------------------------------------------------------------------------

  if (request.method === 'GET' && path === '/v0/plugins') {
    const { results } = await db.prepare('SELECT * FROM plugins WHERE revoked_at IS NULL ORDER BY name').all()
    return json({ plugins: results.map(asPlugin) })
  }

  if (request.method === 'GET' && path === '/v0/skills') {
    const { results } = await db.prepare('SELECT * FROM skills WHERE revoked_at IS NULL ORDER BY name').all()
    return json({ skills: results })
  }

  /**
   * What has been pulled, for a client that already installed it.
   *
   * The listing above simply stops showing a revoked plugin, which is right for somebody
   * browsing and useless to the person who has it on disk. This is the other half, and it
   * is never cached: the whole value of a revocation is that it is not five minutes late.
   */
  if (request.method === 'GET' && path === '/v0/revoked') {
    const [plugins, skills] = await Promise.all([
      db.prepare('SELECT id, revoked_at, revoked_reason FROM plugins WHERE revoked_at IS NOT NULL').all(),
      db.prepare('SELECT id, revoked_at, revoked_reason FROM skills WHERE revoked_at IS NOT NULL').all(),
    ])
    return new Response(JSON.stringify({ plugins: plugins.results, skills: skills.results }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    })
  }

  const one = /^\/v0\/plugins\/([a-z][a-z0-9-]*)$/.exec(path)
  if (request.method === 'GET' && one) {
    const row = await db.prepare('SELECT * FROM plugins WHERE id = ?').bind(one[1]).first()
    if (!row) return json({ error: 'no such plugin' }, 404)
    // 410 rather than 404: it existed, it is gone on purpose, and the reason is the point.
    if (row.revoked_at != null) {
      return json({ error: 'revoked', reason: row.revoked_reason ?? 'withdrawn' }, 410)
    }
    return json(asPlugin(row))
  }

  // ---- write, one person --------------------------------------------------------------

  if (request.method === 'POST' && (path === '/v0/admin/plugins' || path === '/v0/admin/skills')) {
    if (!admin(request, env)) return json({ error: 'not for you' }, 401)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const now = Date.now()

    if (path === '/v0/admin/skills') {
      const row = body as unknown as SkillEntry
      const wrong = badSkill(row)
      if (wrong) return json({ error: wrong }, 400)
      await db
        .prepare(
          'INSERT INTO skills (id, name, description, license, author, url, sha256, signature, updated_at)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
            ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,' +
            ' license = excluded.license, author = excluded.author, url = excluded.url,' +
            ' sha256 = excluded.sha256, signature = excluded.signature, updated_at = excluded.updated_at,' +
            ' revoked_at = NULL, revoked_reason = NULL',
        )
        .bind(
          row.id, row.name, row.description, row.license ?? null, row.author ?? null,
          row.url, row.sha256, row.signature ?? null, now,
        )
        .run()
      return json({ ok: true, id: row.id })
    }

    const row = body as unknown as PluginEntry
    const wrong = badPlugin(row)
    if (wrong) return json({ error: wrong }, 400)
    await db
      .prepare(
        'INSERT INTO plugins (id, name, summary, version, license, author, url, sha256, signature,' +
          ' alexia_protocol, mcp_protocol, requires, provides, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT (id) DO UPDATE SET name = excluded.name, summary = excluded.summary,' +
          ' version = excluded.version, license = excluded.license, author = excluded.author,' +
          ' url = excluded.url, sha256 = excluded.sha256, signature = excluded.signature,' +
          ' alexia_protocol = excluded.alexia_protocol, mcp_protocol = excluded.mcp_protocol,' +
          ' requires = excluded.requires, provides = excluded.provides, updated_at = excluded.updated_at,' +
          // An update un-revokes: publishing a fixed version is how a pulled plugin comes
          // back, and the alternative is a permanently dead id.
          ' revoked_at = NULL, revoked_reason = NULL',
      )
      .bind(
        row.id, row.name, row.summary, row.version, row.license, row.author ?? null,
        row.url, row.sha256, row.signature ?? null, row.alexia_protocol, row.mcp_protocol,
        JSON.stringify(row.requires ?? []), JSON.stringify(row.provides ?? []), now,
      )
      .run()
    return json({ ok: true, id: row.id })
  }

  const revoke = /^\/v0\/admin\/(plugins|skills)\/([a-z][a-z0-9-]*)\/revoke$/.exec(path)
  if (request.method === 'POST' && revoke) {
    if (!admin(request, env)) return json({ error: 'not for you' }, 401)
    const { reason } = (await request.json().catch(() => ({}))) as { reason?: string }
    // The row stays. A revocation whose record is deleted is a revocation nobody can be
    // told about, and `/v0/revoked` is the whole reason the row is worth keeping.
    await db
      .prepare(
        `UPDATE ${revoke[1] === 'plugins' ? 'plugins' : 'skills'} SET revoked_at = ?, revoked_reason = ? WHERE id = ?`,
      )
      .bind(Date.now(), reason ?? 'withdrawn', revoke[2])
      .run()
    return json({ ok: true, id: revoke[2], reason: reason ?? 'withdrawn' })
  }

  return json({ error: 'no such route' }, 404)
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
}
