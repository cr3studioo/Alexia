// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What happened to one run, for reconciliation and reproducibility — never what it was about.
 *
 * A run record carries identifiers, states, timings, versions, digests, seeds, settings, where
 * it rendered, the ComfyUI prompt ID and cleanup status. **It never carries the request, the
 * compiled prompt, note text, pictures, paths or embeddings**: `record()` keeps only the fields
 * listed here and drops anything else it is handed, so a careless caller cannot widen it.
 *
 * Runs live with the conversation's other editing records and are deleted with them.
 */

const KEPT = [
  'runId', 'conversationId', 'batchId', 'childId', 'slot', 'attemptId', 'sourceVersionId', 'operation',
  'inputs', 'masks', 'jobVersion', 'compilerVersion', 'profile', 'manifestSha256', 'graphSha256',
  'seed', 'passSeeds', 'settings', 'destination', 'promptId', 'outputVersionId', 'cleanup', 'invocationId',
]

export const RUN_STATES = ['received', 'planning', 'validating', 'checking_inputs', 'queued', 'rendering', 'checking_output', 'completed',
  'needs_clarification', 'unsupported', 'blocked', 'failed', 'cancelled']

export function runLog(records, now = Date.now) {
  const pick = (facts) => Object.fromEntries(Object.entries(facts).filter(([k]) => KEPT.includes(k)))
  return {
    async start(facts) {
      const run = { ...pick(facts), state: 'received', reason: null, at: now(), phases: [{ state: 'received', at: now() }] }
      await records.write('run', run.runId, run.conversationId, run)
      return run
    },
    async transition(runId, conversationId, state, { reason = null, ...facts } = {}) {
      if (!RUN_STATES.includes(state)) throw new Error(`${state} is not a run state.`)
      const run = await records.read('run', runId, conversationId)
      if (!run) throw new Error('No such run.')
      Object.assign(run, pick(facts), { state, reason })
      run.phases.push({ state, at: now() })
      await records.write('run', runId, conversationId, run)
      return run
    },
    get: (runId, conversationId) => records.read('run', runId, conversationId),
    list: (conversationId) => records.list('run', conversationId),
  }
}
