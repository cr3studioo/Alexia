// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { decideInputs, decideOutput, decideRequest, MESSAGES } from './policy/rules.js'

/** Storage keys are plain lowercase words; ids are hashed into one. */
const key = (prefix, id) => `${prefix}_${createHash('sha256').update(String(id)).digest('hex').slice(0, 32)}`

/**
 * Policy checks around one edit: before anything is rendered, and before anything is shown.
 *
 * This orchestrates; it does not judge. Evidence comes from evaluated providers, decisions from
 * `policy/rules.js`, and every decision is recorded with the evidence it rested on — ratings and
 * age categories, never pictures, embeddings or the request's words.
 *
 * **A block is remembered**, keyed by conversation and the exact bytes involved, so the same
 * pictures cannot be sent round through `generate`, a saved workflow or another tool to get the
 * answer this one refused. Those paths ask {@link Safety.isBlocked} before they run.
 */

export class PolicyBlock extends Error {
  constructor(reason) {
    super(MESSAGES[reason] ?? 'This edit was not made.')
    this.code = reason
  }
}

/**
 * `provider` is one evidence provider (see `policy/providers.js`), or null when none is set up.
 * `store` keeps decisions and blocks: `{ get(key), set(key, value) }`.
 */
export function safety({ provider, store, now = Date.now }) {
  const usable = provider && provider.evaluation && provider.evaluation.reportId
  const record = async (runId, stage, decision, evidence) => {
    const at = key('edit_policy', runId)
    const before = (await store.get(at)) ?? { stages: [] }
    before.stages.push({ stage, at: now(), decision: decision.decision, reason: decision.reason, rating: decision.rating, evidence, provider: usable ? { id: provider.id, version: provider.version, report: provider.evaluation.reportId } : null })
    await store.set(at, before)
  }
  const summary = (e) => e && { status: e.status, rating: e.rating, ages: e.people?.map((p) => p.age) ?? null }
  const block = async (conversationId, hashes, reason) => {
    const at = key('edit_blocked', conversationId)
    const before = (await store.get(at)) ?? {}
    for (const h of hashes) before[h] = reason
    await store.set(at, before)
  }

  /**
   * Remembered refusals of these exact pictures. In adult mode a refusal that was only about the
   * content limit or consent does not follow them; one about a possible minor always does.
   */
  const isBlocked = async (conversationId, hashes, { adult = false } = {}) => {
    const blocked = (await store.get(key('edit_blocked', conversationId))) ?? {}
    return hashes.some((h) => Object.hasOwn(blocked, h) && (!adult || blocked[h] === 'age_uncertain'))
  }

  return {
    /**
     * Request text and every selected picture, before any upload. Resolves to the decision;
     * a block is also remembered against those pictures.
     */
    async checkInputs({ runId, conversationId, request, hint, images, adult = false }, signal) {
      if (!usable) {
        const d = { decision: 'blocked', reason: 'policy_unavailable', rating: null }
        await record(runId, 'inputs', d, null)
        return d
      }
      if (await isBlocked(conversationId, images.map((i) => i.sha256), { adult })) {
        const d = { decision: 'blocked', reason: 'input_blocked', rating: null }
        await record(runId, 'inputs', d, null)
        return d
      }
      const text = await provider.assessText(request, signal)
      const mode = { adult }
      const requestDecision = decideRequest({ hint, text, mode })
      const assessed = []
      if (requestDecision.decision === 'allowed') {
        for (const image of images) assessed.push(await provider.assessImage(image, signal))
      }
      const d = decideInputs({ request: requestDecision, images: assessed, hint, mode })
      await record(runId, 'inputs', d, { text: summary(text), images: assessed.map(summary) })
      if (d.decision === 'blocked' && d.reason !== 'policy_unavailable') await block(conversationId, images.map((i) => i.sha256), d.reason)
      return d
    },

    /** The final picture, on its own evidence. A blocked output is never shown. */
    async checkOutput({ runId, conversationId, inputs, output, adult = false }, signal) {
      if (!usable) {
        const d = { decision: 'blocked', reason: 'policy_unavailable', rating: null }
        await record(runId, 'output', d, null)
        return d
      }
      const evidence = await provider.assessImage(output, signal)
      const d = decideOutput({ inputs, output: evidence, mode: { adult } })
      await record(runId, 'output', d, { output: summary(evidence) })
      if (d.decision === 'blocked' && d.reason !== 'policy_unavailable') await block(conversationId, [output.sha256], d.reason)
      return d
    },

    /** For every other picture path: has this conversation already been refused these bytes? */
    isBlocked,

    decisions: async (runId) => (await store.get(key('edit_policy', runId))) ?? { stages: [] },

    /** Conversation deletion: the remembered blocks go with it. */
    async forget(conversationId, runIds = []) {
      await store.set(key('edit_blocked', conversationId), {})
      for (const runId of runIds) await store.set(key('edit_policy', runId), { stages: [] })
    },
  }
}
