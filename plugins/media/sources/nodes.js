// SPDX-License-Identifier: AGPL-3.0-only
import builtInNames from './data/builtins.json' with { type: 'json' }
import extensionMap from './data/extension-node-map.json' with { type: 'json' }
import provenance from './data/provenance.json' with { type: 'json' }
import { json } from './http.js'

export const MAPPING = Object.freeze({ ...provenance })
export const BUILTINS = Object.freeze([...builtInNames])
const CORE_REPOSITORIES = new Set(['https://github.com/comfyanonymous/ComfyUI', 'https://github.com/Comfy-Org/ComfyUI'])
const API = 'https://api.comfy.org'
const repoOf = (url) => String(url ?? '').replace(/\.git$|\/$/g, '').toLowerCase()

/** Frontend subgraphs are containers. Resolve their actual nodes, including nested definitions. */
function allNodes(workflow) {
  if (!Array.isArray(workflow?.nodes)) return Object.values(workflow ?? {}).filter((node) => typeof node?.class_type === 'string')
  const definitions = new Map((workflow.definitions?.subgraphs ?? []).map((graph) => [graph.id, graph]))
  const seen = new Set()
  const nodes = []
  function walk(graph) {
    if (seen.has(graph)) return
    seen.add(graph)
    for (const node of graph.nodes ?? []) {
      const subgraph = definitions.get(node.type)
      if (subgraph) walk(subgraph)
      else nodes.push(node)
    }
  }
  walk(workflow)
  return nodes
}

/** `builtins` may be the rendering runtime's core-only class list, for releases newer than the snapshot. */
export function customNodeTypes(workflow, { builtins = BUILTINS } = {}) {
  const core = new Set([...builtins, 'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'GraphInput', 'GraphOutput'])
  return [...new Set(allNodes(workflow).map((node) => node.class_type ?? node.type))]
    .filter((type) => typeof type === 'string' && type !== '' && !core.has(type)).sort()
}

function candidates(type, mapping) {
  const found = Object.entries(mapping).filter(([repository, record]) => {
    if (CORE_REPOSITORIES.has(repository)) return false
    if (record[0]?.includes(type)) return true
    if (!record[1]?.nodename_pattern) return false
    try { return new RegExp(record[1].nodename_pattern).test(type) } catch { return false }
  })
  const preempted = found.filter(([, record]) => record[1]?.preemptions?.includes(type))
  return preempted.length > 0 ? preempted : found
}

/** Only a reviewed Manager GitHub repository is eligible for a commit fallback, never a gist or pip hint. */
function githubRepository(repository) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\.git)?\/?$/.exec(repository)
  return match?.[1].replace(/\.git$/, '')
}

function httpsRepository(repository) {
  try {
    const url = new URL(repository)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export async function resolveNodes(workflow, { signal, fetch = globalThis.fetch, builtins = BUILTINS, mapping = extensionMap, githubToken } = {}) {
  const nodes = customNodeTypes(workflow, { builtins })
  const packs = new Map()
  const unresolved = []
  const hints = allNodes(workflow)
  const get = (url) => json(url, { fetch, signal })

  async function registryPack(record, type) {
    if (!record?.id || (record.status && record.status !== 'NodeStatusActive') || !httpsRepository(record.repository)) throw new Error('The Registry did not return an eligible node repository.')
    const versions = new Set(hints.filter((node) => (node.type ?? node.class_type) === type && node.properties?.cnr_id === record.id)
      .map((node) => node.properties.ver).filter((version) => typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)))
    if (versions.size > 1) throw new Error('The workflow requests conflicting versions of this node pack.')
    const version = [...versions][0] ?? record.latest_version?.version
    if (!version || version === 'latest') throw new Error('The Registry did not identify a pinned node-pack version.')
    const release = await get(`${API}/nodes/${encodeURIComponent(record.id)}/versions/${encodeURIComponent(version)}`)
    if (release.node_id !== record.id || release.version !== version || release.status !== 'NodeVersionStatusActive' || release.deprecated) {
      throw new Error('That node-pack release is missing, deprecated or not active in the Registry.')
    }
    if (!release.downloadUrl || new URL(release.downloadUrl).origin !== 'https://cdn.comfy.org') throw new Error('The Registry release has no official download address.')
    return { id: record.id, name: record.name || record.id, repository: record.repository, registryId: record.id, version, downloadUrl: release.downloadUrl, mapping: 'comfy-registry', ...(record.license && { license: record.license }) }
  }

  async function resolve(type) {
    let record
    try {
      record = await get(`${API}/comfy-nodes/${encodeURIComponent(type)}/node`)
    } catch (error) {
      if (error.status !== 404) throw error
    }
    if (record) return registryPack(record, type)
    const matches = candidates(type, mapping)
    if (matches.length === 0) throw new Error('No custom node pack in the Registry or the pinned Manager mapping provides this class.')
    if (matches.length !== 1) throw new Error(`More than one node pack provides this class: ${matches.map(([url]) => url).join(', ')}`)
    const [repository, [, details]] = matches[0]
    const github = githubRepository(repository)
    if (!github) throw new Error('The Manager entry is not a GitHub node-pack repository.')
    const registered = await get(`${API}/nodes/search?repository_url_search=${encodeURIComponent(repository)}&include_banned=false&limit=100`)
    const exact = (registered.nodes ?? []).filter((record) => repoOf(record.repository) === repoOf(repository))
    if (exact.length > 1) throw new Error('The Registry contains conflicting ids for that repository.')
    if (exact.length === 1) return registryPack(exact[0], type)
    const head = await json(`https://api.github.com/repos/${github}/commits/HEAD`, { fetch, signal, headers: githubToken ? { authorization: `Bearer ${githubToken}` } : {} })
    if (!/^[a-f0-9]{40}$/.test(head.sha ?? '')) throw new Error('GitHub did not identify an exact node-pack commit.')
    return { id: github, name: details?.title_aux || github, repository, commit: head.sha, mapping: `comfyui-manager@${MAPPING.commit}` }
  }

  for (const type of nodes) {
    signal?.throwIfAborted()
    try {
      const pack = await resolve(type)
      const key = `${pack.repository}@${pack.version ?? pack.commit}`
      const previous = packs.get(key)
      const conflicting = [...packs.values()].some((one) => repoOf(one.repository) === repoOf(pack.repository) && (one.version ?? one.commit) !== (pack.version ?? pack.commit))
      if (conflicting) throw new Error('The workflow requires conflicting releases of one node pack.')
      if (previous) previous.nodeTypes.push(type)
      else packs.set(key, { ...pack, nodeTypes: [type] })
    } catch (error) {
      signal?.throwIfAborted()
      unresolved.push({ type, reason: String(error?.message ?? error) })
    }
  }
  return { nodes, packs: [...packs.values()], unresolved }
}
