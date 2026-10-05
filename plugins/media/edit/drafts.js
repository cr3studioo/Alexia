// SPDX-License-Identifier: AGPL-3.0-only
import { EditorDraft } from '@alexia/sdk'

/**
 * The editor's private records: drafts, versions, batches, candidates and pending questions.
 *
 * **All of it belongs to a conversation.** Every read takes the conversation and checks it, so a
 * draft ID from somewhere else is not a way in. All of it lives in the one `edits` table, keyed
 * by kind and conversation, so deleting a conversation's editing history is one delete — and the
 * files it names are listed by the same query.
 *
 * Note text and masks live here, in the private draft store. Operational run logs never carry
 * them (see `log.js`).
 */

export const TABLE = 'edits'

export class DraftError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function records(storage) {
  const read = async (kind, id, conversation) => {
    const rows = await storage.select(TABLE, { where: { kind, id, conversation }, limit: 1 })
    return rows.length === 0 ? null : JSON.parse(String(rows[0].body))
  }
  const write = async (kind, id, conversation, body, extra = {}) => {
    const set = { body: JSON.stringify(body), ...extra }
    const changed = await storage.update(TABLE, set, { kind, id, conversation })
    if (changed === 0) await storage.insert(TABLE, { kind, id, conversation, ...set })
  }
  const list = async (kind, conversation, where = {}) =>
    (await storage.select(TABLE, { where: { kind, conversation, ...where } })).map((r) => JSON.parse(String(r.body)))

  return {
    read, write, list,

    async draft(id, conversation) {
      const d = await read('draft', id, conversation)
      if (!d) throw new DraftError('context_required', 'That draft is not in this conversation.')
      return d
    },

    /** Saving checks the revision it was based on, so two windows cannot silently overwrite each other. */
    async saveDraft(draft, expectedRevision, conversation) {
      const parsed = EditorDraft.safeParse(draft)
      if (!parsed.success) throw new DraftError('draft_conflict', `The draft is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`)
      if (draft.conversationId !== conversation) throw new DraftError('context_required', 'That draft is not in this conversation.')
      const before = await read('draft', draft.id, conversation)
      const current = before?.revision ?? 0
      if (before && current !== expectedRevision) throw new DraftError('draft_conflict', 'This draft changed somewhere else. Reload it to see the latest.')
      if (!before && expectedRevision !== 0) throw new DraftError('draft_conflict', 'This draft no longer exists.')
      const saved = { ...parsed.data, revision: before ? current + 1 : Math.max(1, draft.revision) }
      await write('draft', draft.id, conversation, saved)
      return saved
    },

    version: (id, conversation) => read('version', id, conversation),
    versions: (conversation) => list('version', conversation),
    saveVersion: (record, conversation) => write('version', record.source.versionId, conversation, record),

    batch: (id, conversation) => read('batch', id, conversation),
    saveBatch: (batch, conversation) => write('batch', batch.id, conversation, batch),
    snapshot: (id, conversation) => read('snapshot', id, conversation),
    saveSnapshot: (snapshot, conversation) => write('snapshot', snapshot.id, conversation, snapshot),

    pending: (draftId, conversation) => read('pending', draftId, conversation),
    savePending: (pending, conversation) => write('pending', pending.draftId, conversation, pending),
    clearPending: (draftId, conversation) => storage.delete(TABLE, { kind: 'pending', id: draftId, conversation }),

    invocation: (id, conversation) => read('invocation', id, conversation),
    saveInvocation: (id, conversation, result) => write('invocation', id, conversation, result),

    /** Monotonic per conversation, persisted, so a reconnecting editor can tell it missed something. */
    async nextSequence(conversation) {
      const at = (await read('sequence', 'seq', conversation)) ?? { n: -1 }
      at.n += 1
      await write('sequence', 'seq', conversation, at)
      return at.n
    },

    /** Every conversation with editing records, for restart recovery. */
    async conversations(kind) {
      const rows = await storage.select(TABLE, { where: { kind } })
      return [...new Set(rows.map((r) => String(r.conversation)))]
    },

    /** One delete for everything this conversation's editing left. */
    forget: (conversation) => storage.delete(TABLE, { conversation }),
  }
}
