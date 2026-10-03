// SPDX-License-Identifier: AGPL-3.0-only
import { civitai } from './civitai.js'
import { github } from './github.js'

/** Optional keys come from the caller's secret store; public endpoints work anonymously. */
export function createSources({ fetch = globalThis.fetch, civitaiApiKey, githubToken } = {}) {
  return [civitai({ fetch, apiKey: civitaiApiKey }), github({ fetch, token: githubToken })]
}

/** The source id plus entry id is its identity; titles are never used to select downloads. */
export const sources = createSources()
