// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { AttachmentCallContext, AttachmentDescriptor, CleanupReceipt } from '@alexia/protocol'
import type { Store } from '../store.js'
import { ImageRefused, inspect, type ImageMime } from './images.js'

/**
 * **Pictures that stay with their conversation** (A02).
 *
 * Until now a picture lived for one call: written, read into a `data:` URL, deleted. Editing
 * needs the opposite — the same picture across a clarification, a reload and four versions — so
 * an attachment here is a durable, opaque record: a file under `uploads/<conversation>/` named by
 * its id, a label (`image_3`) the person and the model both see, and the facts about it.
 *
 * **A conversation can only reach its own pictures.** Every lookup takes the conversation and
 * checks it; a label is resolved against that conversation's records, not by number; another
 * conversation's ids resolve to nothing. Files are opened only after their real path is checked
 * to be inside this conversation's folder and to be a plain file, not a link.
 *
 * **A lease is what a job runs against**: one immutable, ordered selection, authorized once.
 * Revoking the conversation's pictures ends every lease in the same transaction that marks the
 * pictures gone — before any file is touched — so a job that checks its lease at publication
 * cannot publish after a deletion began.
 */

const EXT: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const opaque = (prefix: string): string => `${prefix}_${randomBytes(12).toString('base64url')}`

export class AttachmentError extends Error {
  constructor(readonly code: 'context_required' | 'attachment_unavailable' | 'selection_mismatch' | 'input_limit', message: string) {
    super(message)
  }
}

interface Row {
  id: string
  session_id: number
  ordinal: number
  label: string
  display_name: string
  mime: ImageMime
  width: number
  height: number
  bytes: number
  sha256: string
  file: string
  origin: string
  state: 'live' | 'revoked'
  created_at: number
}

export type Origin = 'upload' | 'normalized' | 'approved_result' | 'deterministic_transform'

export class Attachments {
  readonly #store: Store
  readonly #root: string
  readonly #now: () => number

  constructor(store: Store, dataDir: string, now: () => number = Date.now) {
    this.#store = store
    this.#root = join(dataDir, 'uploads')
    this.#now = now
  }

  /** Where one conversation's pictures live. Never derived from anything a person or model wrote. */
  folder(conversationId: string): string {
    return join(this.#root, String(session(conversationId)))
  }

  /**
   * Keep a picture that arrived. The bytes are checked and their metadata removed before
   * anything is written; the label is the conversation's next, never a reused one.
   */
  ingest(conversationId: string, upload: { name: string; bytes: Buffer }, origin: Origin = 'upload'): AttachmentDescriptor {
    const id = session(conversationId)
    let seen
    try {
      seen = inspect(upload.bytes)
    } catch (error) {
      if (error instanceof ImageRefused) throw new AttachmentError('attachment_unavailable', `${upload.name}: ${error.message}`)
      throw error
    }
    const attachmentId = opaque('att')
    const file = `${attachmentId}.${EXT[seen.mime]}`
    mkdirSync(this.folder(conversationId), { recursive: true })
    writeFileSync(join(this.folder(conversationId), file), seen.bytes)
    const sha256 = createHash('sha256').update(seen.bytes).digest('hex')
    try {
      this.#store.transaction(() => {
        const [{ image_ordinal: before }] = this.#store.attachmentsSql<{ image_ordinal: number }>('SELECT image_ordinal FROM sessions WHERE id = ?', id) as [{ image_ordinal: number }]
        if (before === undefined) throw new AttachmentError('context_required', 'That conversation does not exist.')
        const ordinal = before + 1
        this.#store.attachmentsRun('UPDATE sessions SET image_ordinal = ? WHERE id = ?', ordinal, id)
        this.#store.attachmentsRun(
          'INSERT INTO attachments (id, session_id, ordinal, label, display_name, mime, width, height, bytes, sha256, file, origin, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          attachmentId, id, ordinal, `image_${ordinal}`, displayName(upload.name), seen.mime, seen.width, seen.height, seen.bytes.length, sha256, file, origin, 'live', this.#now(),
        )
      })
    } catch (error) {
      // The row is the commit: a file without one is an orphan, removed now rather than at the next sweep.
      rmSync(join(this.folder(conversationId), file), { force: true })
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('context_required', 'That conversation does not exist.')
    }
    return this.describe(conversationId, attachmentId)
  }

  /** A picture another part of Alexia made for this conversation — an approved edit, a crop. */
  register(conversationId: string, path: string, origin: Origin, name = 'edited.png'): AttachmentDescriptor {
    return this.ingest(conversationId, { name, bytes: readFileSync(path) }, origin)
  }

  /** The live pictures of a conversation, in the order they arrived. */
  list(conversationId: string): AttachmentDescriptor[] {
    return this.#rows(conversationId).filter((r) => r.state === 'live').map(descriptor)
  }

  describe(conversationId: string, attachmentId: string): AttachmentDescriptor {
    const row = this.#row(conversationId, attachmentId)
    if (!row || row.state !== 'live') throw new AttachmentError('attachment_unavailable', 'That picture is not in this conversation any more.')
    return descriptor(row)
  }

  /** The bytes of one of this conversation's pictures, for showing it in the editor. */
  bytes(conversationId: string, attachmentId: string): { mime: string; bytes: Buffer } {
    const row = this.#row(conversationId, attachmentId)
    if (!row || row.state !== 'live') throw new AttachmentError('attachment_unavailable', 'That picture is not in this conversation any more.')
    return { mime: row.mime, bytes: readFileSync(this.#path(conversationId, row)) }
  }

  /**
   * **One authorized selection**, by the labels the person and the model see. Labels are looked
   * up in this conversation's records — `image_7, image_9` is as valid as `image_1, image_2` —
   * and anything not there is a refusal naming it, never a guess.
   */
  resolve(conversationId: string, labels: readonly string[], requestId = opaque('req')): AttachmentCallContext {
    const rows = this.#rows(conversationId)
    const picked = labels.map((label) => {
      const row = rows.find((r) => r.label === label)
      if (!row) throw new AttachmentError('selection_mismatch', `There is no ${label.replace('_', ' ')} in this conversation.`)
      return row
    })
    return this.#lease(conversationId, picked, requestId)
  }

  /** The same, by attachment id — the editor's path, which holds ids rather than labels. */
  lease(conversationId: string, ids: readonly string[], requestId = opaque('req')): AttachmentCallContext {
    const rows = this.#rows(conversationId)
    const picked = ids.map((id) => {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new AttachmentError('attachment_unavailable', 'A picture this needs is not in this conversation any more.')
      return row
    })
    return this.#lease(conversationId, picked, requestId)
  }

  #lease(conversationId: string, picked: Row[], requestId: string): AttachmentCallContext {
    if (picked.length === 0) throw new AttachmentError('selection_mismatch', 'Select a picture first.')
    if (new Set(picked.map((r) => r.id)).size !== picked.length) throw new AttachmentError('selection_mismatch', 'The same picture is selected twice.')
    for (const r of picked) if (r.state !== 'live') throw new AttachmentError('attachment_unavailable', `${r.label.replace('_', ' ')} has been deleted.`)
    const attachments = picked.map((r) => ({ ...descriptor(r), path: this.#path(conversationId, r) }))
    const leaseId = opaque('lease')
    this.#store.attachmentsRun(
      'INSERT INTO attachment_leases (id, session_id, attachment_ids, state, created_at) VALUES (?, ?, ?, ?, ?)',
      leaseId, session(conversationId), JSON.stringify(picked.map((r) => r.id)), 'live', this.#now(),
    )
    return { version: '1', conversationId, requestId, selectionId: opaque('sel'), leaseId, attachments }
  }

  release(leaseId: string): void {
    this.#store.attachmentsRun("UPDATE attachment_leases SET state = 'released' WHERE id = ? AND state = 'live'", leaseId)
  }

  /** A lease is live while it was not released or revoked and every picture in it still is. */
  isLive(leaseId: string): boolean {
    const [lease] = this.#store.attachmentsSql<{ state: string; attachment_ids: string }>('SELECT state, attachment_ids FROM attachment_leases WHERE id = ?', leaseId)
    if (!lease || lease.state !== 'live') return false
    const ids = JSON.parse(lease.attachment_ids) as string[]
    const live = this.#store.attachmentsSql<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments WHERE state = 'live' AND id IN (${ids.map(() => '?').join(',')})`, ...ids,
    )[0]?.n
    return live === ids.length
  }

  /**
   * **Step one of deletion: nothing can use these pictures any more.** Every picture and lease is
   * marked in one transaction; the files are untouched until {@link cleanup}.
   */
  revoke(conversationId: string): void {
    const id = session(conversationId)
    this.#store.transaction(() => {
      this.#store.attachmentsRun("UPDATE attachments SET state = 'revoked' WHERE session_id = ?", id)
      this.#store.attachmentsRun("UPDATE attachment_leases SET state = 'revoked' WHERE session_id = ? AND state = 'live'", id)
    })
  }

  /**
   * **Step two: the bytes go**, from the folder and from the conversation's messages, and the
   * records with them. Idempotent, so a cleanup interrupted by a crash finishes on the next call.
   */
  cleanup(conversationId: string, revocationId: string): CleanupReceipt {
    const id = session(conversationId)
    let local: 'complete' | 'failed' = 'complete'
    try {
      this.#store.scrubImages(id)
      rmSync(this.folder(conversationId), { recursive: true, force: true, maxRetries: 3 })
      this.#store.attachmentsRun("DELETE FROM attachments WHERE session_id = ? AND state = 'revoked'", id)
      this.#store.attachmentsRun("DELETE FROM attachment_leases WHERE session_id = ? AND state != 'live'", id)
    } catch {
      local = 'failed'
    }
    return { revocationId, local, remote: [] }
  }

  /**
   * After a restart, or a write that failed half-way: files with no live record, folders of
   * conversations that are gone, and revoked records whose cleanup never finished. Returns how
   * many files went.
   */
  collect(): number {
    let removed = 0
    if (!existsSync(this.#root)) return 0
    const sessions = new Set(this.#store.attachmentsSql<{ id: number }>('SELECT id FROM sessions').map((r) => String(r.id)))
    for (const folder of readdirSync(this.#root)) {
      const at = join(this.#root, folder)
      if (!/^\d+$/.test(folder) || !sessions.has(folder)) {
        // A conversation that is gone, or a folder named by something else: the uploads root
        // holds core's files only (the old one-call temporaries are cleared at read time).
        if (/^\d+$/.test(folder)) {
          rmSync(at, { recursive: true, force: true })
          removed++
        }
        continue
      }
      const live = new Set(this.#rows(folder).filter((r) => r.state === 'live').map((r) => r.file))
      for (const name of readdirSync(at)) {
        if (!live.has(name)) {
          rmSync(join(at, name), { recursive: true, force: true })
          removed++
        }
      }
      if (this.#rows(folder).some((r) => r.state === 'revoked')) this.cleanup(folder, opaque('rev'))
    }
    return removed
  }

  #rows(conversationId: string): Row[] {
    return this.#store.attachmentsSql<Row>('SELECT * FROM attachments WHERE session_id = ? ORDER BY ordinal', session(conversationId))
  }

  #row(conversationId: string, attachmentId: string): Row | undefined {
    return this.#store.attachmentsSql<Row>('SELECT * FROM attachments WHERE session_id = ? AND id = ?', session(conversationId), attachmentId)[0]
  }

  /** The file, checked: inside this conversation's folder, really, and a plain file. */
  #path(conversationId: string, row: Row): string {
    const folder = this.folder(conversationId)
    const path = join(folder, row.file)
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('link')
      const real = realpathSync(path)
      if (!real.startsWith(realpathSync(folder) + sep)) throw new Error('outside')
      return real
    } catch {
      throw new AttachmentError('attachment_unavailable', `${row.label.replace('_', ' ')} cannot be read any more.`)
    }
  }
}

function session(conversationId: string): number {
  const n = Number(conversationId)
  if (!/^\d+$/.test(String(conversationId)) || !Number.isSafeInteger(n)) throw new AttachmentError('context_required', 'A conversation is needed for pictures.')
  return n
}

function descriptor(r: Row): AttachmentDescriptor {
  return { id: r.id, label: r.label, displayName: r.display_name, mime: r.mime, dimensions: { width: r.width, height: r.height }, bytes: r.bytes, sha256: r.sha256 }
}

function displayName(name: string): string {
  const last = String(name).split(/[\\/]/).pop() ?? ''
  const clean = [...last].filter((c) => (c.codePointAt(0) ?? 0) > 31).join('').trim().slice(-200)
  return clean === '' ? 'picture' : clean
}
