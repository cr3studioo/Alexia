// SPDX-License-Identifier: AGPL-3.0-only
import { bytes, json, matches, plain, WORKFLOW_MAX } from './http.js'
import { fetched } from './workflow.js'
import { workflowsInZip } from './zip.js'

const API = 'https://civitai.com/api/v1'
const attachable = (file) => /\.(?:json|zip)$/i.test(file?.name ?? '') && Number(file?.sizeKB) * 1024 <= WORKFLOW_MAX
const entryId = (model, version, file) => `${model.id}:${version.id}:${file.id}`

/** Preserve the creator's permission flags verbatim; these are not an SPDX licence. */
function licenseOf(model) {
  if (typeof model?.license === 'string') return model.license
  const keys = ['allowNoCredit', 'allowCommercialUse', 'allowDerivatives', 'allowDifferentLicense']
  const permissions = Object.fromEntries(keys.filter((key) => Object.hasOwn(model, key)).map((key) => [key, model[key]]))
  return Object.keys(permissions).length > 0 ? `Civitai permissions: ${JSON.stringify(permissions)}` : undefined
}

export function civitai({ fetch = globalThis.fetch, apiKey } = {}) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  const read = (url, signal) => json(url, { fetch, signal, headers, max: 8_000_000 })
  return {
    id: 'civitai',
    name: 'Civitai workflows',
    homepage: 'https://civitai.com',
    async search(query, { task, signal } = {}) {
      const url = new URL(`${API}/models`)
      url.searchParams.set('types', 'Workflows')
      url.searchParams.set('nsfw', 'false')
      url.searchParams.set('limit', '20')
      if (String(query ?? '').trim()) url.searchParams.set('query', String(query).trim())
      if (task) url.searchParams.set('tag', task)
      const result = await read(url, signal)
      if (!Array.isArray(result?.items)) throw new Error('Civitai returned no workflow catalogue.')
      return result.items.filter((model) => model.type === 'Workflows' && model.nsfw !== true).flatMap((model) => {
        const version = model.modelVersions?.[0]
        if (!version) return []
        return (version.files ?? []).filter(attachable).map((file) => {
          const entry = {
            id: entryId(model, version, file), source: 'civitai', title: `${model.name} — ${version.name}`,
            description: plain(model.description), tags: Array.isArray(model.tags) ? model.tags.filter((tag) => typeof tag === 'string') : [],
            url: `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,
            ...(model.creator?.username && { author: model.creator.username }),
            ...(licenseOf(model) && { license: licenseOf(model) }),
            ...(version.images?.find((image) => image.nsfwLevel <= 1)?.url && { previewUrl: version.images.find((image) => image.nsfwLevel <= 1).url }),
          }
          return entry
        })
      }).filter((entry) => !task || matches(entry, '', task))
    },
    async fetch(id, { signal } = {}) {
      const matched = /^(\d+):(\d+):(\d+)(?::(.+))?$/.exec(String(id))
      if (!matched) throw new Error('That is not a Civitai workflow attachment id.')
      const [, modelId, versionId, fileId, member] = matched
      const model = await read(`${API}/models/${modelId}`, signal)
      if (String(model.id) !== modelId || model.type !== 'Workflows') throw new Error('That Civitai entry is not a workflow.')
      const version = model.modelVersions?.find((one) => String(one.id) === versionId)
      const file = version?.files?.find((one) => String(one.id) === fileId)
      if (!file || !attachable(file)) throw new Error('That Civitai workflow attachment is missing, unsupported or too large.')
      const url = new URL(file.downloadUrl)
      if (url.origin !== 'https://civitai.com' || url.pathname !== `/api/download/models/${versionId}`) {
        throw new Error('Civitai returned an unexpected workflow download address.')
      }
      const body = await bytes(url, { fetch, signal, headers })
      let workflow
      if (/\.zip$/i.test(file.name)) {
        const choices = workflowsInZip(body)
        const wanted = member === undefined ? undefined : decodeURIComponent(member)
        const chosen = wanted ? choices.find((one) => one.name === wanted) : choices.length === 1 ? choices[0] : undefined
        if (!chosen) {
          if (choices.length === 0) throw new Error('That Civitai ZIP contains no ComfyUI workflow JSON.')
          throw new Error(`Choose a workflow inside that ZIP: ${choices.map((one) => `${modelId}:${versionId}:${fileId}:${encodeURIComponent(one.name)}`).join(', ')}`)
        }
        workflow = chosen.workflow
      } else {
        if (member !== undefined) throw new Error('That Civitai attachment is JSON, not an archive.')
        try { workflow = JSON.parse(body.toString('utf8')) } catch { throw new Error('That Civitai attachment is not JSON.') }
      }
      return fetched(workflow, {
        url: `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`,
        ...(model.creator?.username && { author: model.creator.username }),
        ...(licenseOf(model) && { license: licenseOf(model) }),
      })
    },
  }
}
