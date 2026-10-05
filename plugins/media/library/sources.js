// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The community half of the library, reached through `sources/` and nothing else.
 *
 * `sources/index.js` is the interface every community source is written against — `{ id, name,
 * homepage, search(query, { task, signal }), fetch(entryId, { signal }) }` — and `sources/nodes.js`
 * says which node packs a workflow needs. This file is the one place the library touches either,
 * so a source added there appears on the library page with nothing changed here, and a test can
 * hand in a double for the whole of it.
 *
 * **Loaded when first asked, and absent is an answer.** A copy of this plugin without the sources
 * folder still draws its library — the official templates and the curated tasks — and says the
 * community search is not there, rather than failing to start.
 */

/** What to call for the packs a fetched workflow needs, whatever `nodes.js` named it. */
const RESOLVERS = ['resolveNodes', 'packsFor', 'resolvePacks', 'resolve']

/** `sources/` as the library uses it: the list, and the resolver if there is one. */
export async function loadSources(load = defaultLoad) {
  const got = await load().catch(() => undefined)
  const sources = Array.isArray(got?.sources) ? got.sources.filter((one) => typeof one?.search === 'function' && typeof one?.fetch === 'function') : []
  const resolver = typeof got?.resolver === 'function' ? got.resolver : undefined
  return { sources, ...(resolver && { resolver }) }
}

async function defaultLoad() {
  const index = await import('../sources/index.js')
  const nodes = await import('../sources/nodes.js').catch(() => ({}))
  const resolver = RESOLVERS.map((name) => nodes[name]).find((one) => typeof one === 'function')
  return { sources: index.sources ?? index.default ?? [], resolver }
}

const text = (said) => String(said ?? '').trim()

/** The id a found entry is installed by. One string, because a row action carries one string. */
export const foundId = (source, entry) => `found:${source}:${entry}`

/** `found:<source>:<entry>` back into its parts, or nothing. The entry id may itself hold colons. */
export function parseFound(id) {
  const said = /^found:([^:]+):(.+)$/.exec(String(id ?? ''))
  return said ? { source: said[1], entry: said[2] } : undefined
}

/**
 * Search every source at once, each with its own deadline, and keep what answered.
 *
 * One slow or broken website must not make the whole search fail — the person asked a question
 * of *the community*, and three answers out of four is an answer. What failed is said by name.
 */
export async function searchAll(sources, query, { task, signal, limit = 24, timeoutMs = 15_000 } = {}) {
  const asked = await Promise.allSettled(
    sources.map(async (source) => {
      const deadline = AbortSignal.timeout(timeoutMs)
      const both = signal ? AbortSignal.any([signal, deadline]) : deadline
      const entries = await source.search(String(query ?? ''), { ...(task && { task }), signal: both })
      return (Array.isArray(entries) ? entries : []).map((entry) => ({
        id: foundId(source.id, text(entry?.id)),
        source: text(source.id),
        sourceName: text(source.name) || text(source.id),
        entry: text(entry?.id),
        title: text(entry?.title ?? entry?.name) || text(entry?.id),
        summary: text(entry?.description ?? entry?.summary),
        author: text(entry?.author),
        url: text(entry?.url ?? entry?.homepage),
        license: text(entry?.license),
      }))
    }),
  )
  const found = asked.flatMap((one) => (one.status === 'fulfilled' ? one.value : [])).filter((one) => one.entry)
  const failed = asked.flatMap((one, index) => (one.status === 'rejected' ? [text(sources[index].name) || text(sources[index].id)] : []))
  return { found: found.slice(0, limit), failed }
}

/**
 * One found workflow, fetched, in the shape the installer takes.
 *
 * `models` come back from a source as `{ name, folder?, url?, bytes? }`; the installer's word for
 * the folder is `directory`, which is the template catalogue's. A model with no address is kept
 * — a list somebody reads should still name it — but nothing can be downloaded for it.
 */
export async function fetchFound({ sources, resolver }, id, { signal } = {}) {
  const which = parseFound(id)
  const source = which && sources.find((one) => text(one.id) === which.source)
  if (!source) throw new Error(`No community source answers for ${String(id)}.`)
  const got = await source.fetch(which.entry, { signal })
  if (!got?.workflow || typeof got.workflow !== 'object') throw new Error(`${text(source.name) || which.source} sent no workflow for that entry.`)
  // `resolveNodes` answers `{ packs, unresolved }`; a bare list of packs is taken as well.
  const resolution = resolver ? await Promise.resolve(resolver(got.workflow, { signal })).catch(() => undefined) : undefined
  const resolved = Array.isArray(resolution) ? resolution : Array.isArray(resolution?.packs) ? resolution.packs : []
  const unresolved = Array.isArray(resolution?.unresolved) ? resolution.unresolved.map((one) => text(one?.type ?? one)) : resolver ? [] : (got.nodes ?? []).map(String)
  return {
    doc: got.workflow,
    format: text(got.format),
    url: text(got.url),
    author: text(got.author),
    license: text(got.license),
    models: (Array.isArray(got.models) ? got.models : [])
      .filter((one) => text(one?.name))
      .map((one) => ({
        name: text(one.name),
        ...(text(one.folder ?? one.directory) && { directory: text(one.folder ?? one.directory) }),
        ...(text(one.url).startsWith('https://') && { url: text(one.url) }),
        ...(Number.isFinite(Number(one.bytes)) && Number(one.bytes) > 0 && { bytes: Number(one.bytes) }),
      })),
    packs: resolved
      .filter((one) => text(one?.name ?? one?.id) && (text(one?.url ?? one?.repository) || text(one?.registryId ?? one?.registry)))
      .map((one) => ({
        // The folder a pack goes in is its registry id where it has one — the name ComfyUI-Manager
        // gives the same pack — and its title otherwise.
        name: text(one.registryId ?? one.registry) || text(one.name ?? one.id),
        ...(text(one.url ?? one.repository) && { url: text(one.url ?? one.repository) }),
        ...(text(one.registryId ?? one.registry) && { registry: text(one.registryId ?? one.registry) }),
        ...(text(one.version) && { version: text(one.version) }),
        ...(text(one.commit) && { commit: text(one.commit) }),
        ...(text(one.downloadUrl).startsWith('https://') && { archive: text(one.downloadUrl) }),
        ...(Array.isArray(one.nodeTypes ?? one.nodes) && { nodes: (one.nodeTypes ?? one.nodes).map(String) }),
      })),
    unresolved,
  }
}
