// SPDX-License-Identifier: AGPL-3.0-only
import { json, matches, WORKFLOW_MAX } from './http.js'
import { fetched } from './workflow.js'

/** Each revision was checked for an explicit repository licence; discovery never broadens this list. */
export const COLLECTIONS = [
  { repository: 'diffustar/comfyui-workflow-collection', commit: '91779af19b6c2675b5e39d5d091d4c2bbdc619e5', license: 'MIT', prefix: 'workflows/', description: 'Diffustar’s ComfyUI experiments and examples.' },
  { repository: 'wyrde/wyrde-comfyui-workflows', commit: '0924119652cca4bfd53684c8ccd6999b30b8bbbb', license: 'MIT', prefix: '', description: 'Wyrde’s community ComfyUI examples (published in 2023; compatibility must be checked on the rendering computer).' },
  { repository: 'comfyanonymous/ComfyUI_examples', commit: 'f9431bb000ce792094ff345446e22cac1ea6cef3', license: 'ComfyUI examples permission grant: https://github.com/comfyanonymous/ComfyUI_examples/blob/f9431bb000ce792094ff345446e22cac1ea6cef3/LICENSE', prefix: '', description: 'ComfyUI’s upstream JSON examples. Image-embedded workflows are not listed.' },
]
const pathUrl = (path) => path.split('/').map(encodeURIComponent).join('/')

export function github({ fetch = globalThis.fetch, token, collections = COLLECTIONS } = {}) {
  const headers = { accept: 'application/vnd.github+json', ...(token && { authorization: `Bearer ${token}` }) }
  const trees = new Map()
  async function tree(collection, signal) {
    const key = `${collection.repository}@${collection.commit}`
    if (trees.has(key)) return trees.get(key)
    const result = await json(`https://api.github.com/repos/${collection.repository}/git/trees/${collection.commit}?recursive=1`, { fetch, signal, headers })
    if (result.truncated || !Array.isArray(result.tree)) throw new Error('GitHub returned an incomplete workflow catalogue.')
    const entries = result.tree.filter((one) => one.type === 'blob' && one.path.startsWith(collection.prefix) && /\.json$/i.test(one.path) && one.size <= WORKFLOW_MAX)
    trees.set(key, entries)
    return entries
  }
  return {
    id: 'github-community',
    name: 'GitHub workflow collections',
    homepage: 'https://github.com/topics/comfyui-workflows',
    async search(query, { task, signal } = {}) {
      const entries = []
      for (const collection of collections) {
        signal?.throwIfAborted()
        for (const file of await tree(collection, signal)) {
          const parts = file.path.replace(/\.json$/i, '').split('/')
          const title = parts.at(-1) === 'workflow' ? parts.at(-2) : parts.at(-1)
          const entry = {
            id: `${collection.repository}@${collection.commit}:${encodeURIComponent(file.path)}`, source: 'github-community',
            title: title.replace(/[-_]+/g, ' '), description: `${collection.description} ${file.path}`,
            tags: parts.flatMap((part) => part.split(/[-_ ]+/)).filter(Boolean),
            url: `https://github.com/${collection.repository}/blob/${collection.commit}/${pathUrl(file.path)}`,
            author: collection.repository.split('/')[0], license: collection.license,
          }
          if (matches(entry, query, task)) entries.push(entry)
        }
      }
      return entries
    },
    async fetch(id, { signal } = {}) {
      const match = /^([^@]+)@([a-f0-9]{40}):(.+)$/.exec(String(id))
      if (!match) throw new Error('That is not a community GitHub workflow id.')
      const [, repository, commit, encodedPath] = match
      const collection = collections.find((one) => one.repository === repository && one.commit === commit)
      if (!collection) throw new Error('That repository revision is not in the licensed workflow collections.')
      const path = decodeURIComponent(encodedPath)
      if (!(await tree(collection, signal)).some((one) => one.path === path)) throw new Error('That file is not in the workflow catalogue.')
      const workflow = await json(`https://raw.githubusercontent.com/${repository}/${commit}/${pathUrl(path)}`, { fetch, signal })
      return fetched(workflow, { url: `https://github.com/${repository}/blob/${commit}/${pathUrl(path)}`, author: repository.split('/')[0], license: collection.license })
    },
  }
}
