// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The image editor's half of the wire**, as the shell sees it.
 *
 * Browser copies of the contract shapes (`@alexia/protocol`'s `image-editor.ts`): the shell has
 * no Node and no bundler, so it never imports core or the protocol package — it states the
 * fields it reads and nothing more. Every call names the conversation; core checks it exists and
 * the plugin checks everything else again. Nothing here ever holds a filesystem path: pictures
 * arrive as bytes from `/api/editor/picture`, and the editor's own files by share token.
 */

export interface Dimensions { width: number; height: number }
export interface SourceVersion {
  versionId: string
  attachmentId: string
  conversationId: string
  dimensions: Dimensions
  sha256: string
  origin: 'original' | 'approved_result' | 'deterministic_transform'
  parentVersionId: string | null
}
export interface Mask { id: string; artifactId: string; sourceVersionId: string; dimensions: Dimensions; sha256: string; coverage: number; featherPixels: number }
export interface RegionNote {
  id: string
  sourceVersionId: string
  point: { x: number; y: number }
  instruction: string
  enabled: boolean
  reviewed: boolean
  stale: boolean
  mask: Mask | null
}
export type Operation = 'image_edit' | 'inpaint' | 'remove_fill' | 'crop' | 'resize' | 'erase_alpha'
export type Transform =
  | { kind: 'crop'; rect: { x: number; y: number; width: number; height: number } }
  | { kind: 'resize'; dimensions: Dimensions; fit: 'fit' | 'fill'; background: string }
  | { kind: 'erase_alpha'; maskId: string }
export interface Settings { dimensions: Dimensions; preset: string | null; steps: number | null; changeAmount: number | null; seed: number | null }
export interface Draft {
  id: string
  revision: number
  conversationId: string
  source: SourceVersion
  referenceIds: string[]
  referenceRoles?: { attachmentId: string; roles: string[] }[]
  instruction: string
  regions: RegionNote[]
  operation: Operation
  transform: Transform | null
  profile: { id: string; version: string } | null
  settings: Settings
  variantCount: 1 | 2 | 4
}
export interface Profile {
  selection: { id: string; version: string }
  name: string
  uncensored: boolean
  operations: Operation[]
  jobVersions: ('1.1' | '1.2')[]
  maxInputs: number
  destination: { kind: 'interaction' } | { kind: 'paired'; hostId: string; displayName: string }
  availability: 'available' | 'needs_installation' | 'unverified' | 'incompatible' | 'offline'
  reason: string | null
  evidenceId: string | null
  measuredMemory: { gpuBytes: number; hostBytes: number } | null
  dimensions: Dimensions[]
  controls: { presets: string[]; steps: { min: number; max: number; default: number } | null; changeAmount: unknown; seed: { min: number; max: number } }
  batchSize: 1
}
export type RunState = 'received' | 'planning' | 'validating' | 'checking_inputs' | 'queued' | 'rendering' | 'checking_output' | 'completed'
  | 'needs_clarification' | 'unsupported' | 'blocked' | 'failed' | 'cancelled'
export interface Candidate {
  /** The failure's own words, when there are any. */
  detail?: string
  id: string
  batchId: string
  runId: string
  attemptId: string
  slot: number
  seed: number
  passSeeds: number[]
  state: RunState
  reason: string | null
  outputVersionId: string | null
}
export interface Batch {
  id: string
  draftId: string
  sourceVersionId: string
  variantCount: 1 | 2 | 4
  state: 'active' | 'completed' | 'partial' | 'failed' | 'cancelled'
  candidates: Candidate[]
}
export interface Version { source: SourceVersion; batchId: string | null; candidateId: string | null; favorite: boolean; createdAt: number }
export interface Picture { id: string; label: string; displayName: string; mime: string; dimensions: Dimensions; bytes: number; sha256: string }
export type EditorEvent =
  | { type: 'candidate'; sequence: number; candidate: Candidate }
  | { type: 'clarification'; sequence: number; draftId: string; question: string }
  | { type: 'cleanup'; sequence: number }
export interface CommandResult { draft: Draft | null; batch: Batch | null; exports: { artifactId: string; name: string; mime: string; url: string }[] }

export class EditorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface EditorApi {
  readonly conversationId: string
  call<T>(call: string, body?: Record<string, unknown>): Promise<T>
  command(command: Record<string, unknown>): Promise<CommandResult>
  picture(attachmentId: string): Promise<Blob>
  file(url: string): Promise<Blob>
  upload(name: string, blob: Blob, normalizedFrom?: string): Promise<Picture>
  forget(): Promise<{ local: string; remote: { hostId: string; state: string }[] }>
  /** What the picture computer is doing now, or nothing when it cannot be asked. Never throws. */
  work(): Promise<Work | undefined>
}

/** The picture computer's running job, as the editor shows it: words and a fraction, no prompt. */
export interface Work {
  id: string
  /** What the job is for, as the computer names it — a capability such as `image.edit`. */
  label: string
  startedAt?: number
  message?: string
  done: number
  total?: number
  waiting: number
}

export function editorApi(token: string, conversationId: string, fetcher: typeof fetch = fetch): EditorApi {
  const headers = { 'content-type': 'application/json', 'x-alexia-token': token }
  const read = async <T>(answered: Response): Promise<T> => {
    const said = (await answered.json().catch(() => ({}))) as { ok?: boolean; code?: string; said?: string } & T
    if (!answered.ok || said.ok === false) throw new EditorError(said.code ?? 'render_failed', said.said ?? 'The editor could not do that.')
    return said
  }
  const bytes = async (path: string): Promise<Blob> => {
    const answered = await fetcher(path, { headers: { 'x-alexia-token': token } })
    if (!answered.ok) throw new EditorError('attachment_unavailable', 'That picture is not available any more.')
    return answered.blob()
  }
  const api: EditorApi = {
    conversationId,
    call: async <T>(call: string, body: Record<string, unknown> = {}) =>
      read<T>(await fetcher('/api/editor', { method: 'POST', headers, body: JSON.stringify({ ...body, call, conversationId }) })),
    command: (command) => api.call<CommandResult>('command', { command, ...(typeof command.type === 'string' && { action: command.type }) }),
    picture: (attachmentId) => bytes(`/api/editor/picture?conversation=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(attachmentId)}`),
    file: (url) => {
      if (!url.startsWith('/api/editor/file?')) throw new EditorError('attachment_unavailable', 'That is not one of the editor’s files.')
      return bytes(url)
    },
    upload: async (name, blob, normalizedFrom) => {
      const data = await base64(blob)
      const said = await read<{ picture: Picture }>(await fetcher('/api/editor/upload', {
        method: 'POST', headers, body: JSON.stringify({ conversationId, name, data, ...(normalizedFrom !== undefined && { normalizedFrom }) }),
      }))
      return said.picture
    },
    work: async () => {
      try {
        const answered = await fetcher('/api/compute/queue', { headers: { 'x-alexia-token': token } })
        if (!answered.ok) return undefined
        const { queue } = (await answered.json()) as { queue?: { running?: { id?: string; label?: string; startedAt?: number; progress?: { progress: number; total?: number; message?: string } }; waiting?: unknown[] } }
        if (!queue?.running) return undefined
        const p = queue.running.progress
        return {
          id: queue.running.id ?? '', label: queue.running.label ?? '', ...(queue.running.startedAt !== undefined && { startedAt: queue.running.startedAt }),
          done: p?.progress ?? 0, ...(p?.total !== undefined && { total: p.total }), ...(p?.message !== undefined && { message: p.message }), waiting: queue.waiting?.length ?? 0 }
      } catch {
        return undefined
      }
    },
    forget: async () => (await read<{ receipt: { local: string; remote: { hostId: string; state: string }[] } }>(
      await fetcher('/api/editor/forget', { method: 'POST', headers, body: JSON.stringify({ conversationId, confirm: true }) }),
    )).receipt,
  }
  return api
}

export async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** Plain words for the reason codes core and the plugin answer with. */
export const REASONS: Record<string, string> = {
  profile_unavailable: 'The chosen model cannot be used right now.',
  settings_incompatible: 'These settings do not fit the chosen model.',
  policy_unavailable: 'The safety checks this edit needs are not available on this computer.',
  output_blocked: 'The result did not pass the safety check and was discarded.',
  input_blocked: 'This request or one of its pictures is outside what the editor makes.',
  age_uncertain: 'A person here could not be confirmed as an adult.',
  consent_missing: 'Edits like this to a real person need their recorded consent.',
  out_of_memory: 'The graphics card ran out of memory.',
  timeout: 'It took too long and was stopped.',
  render_failed: 'The picture program could not make it.',
  cancelled: 'Cancelled.',
  revoked: 'The pictures it used were deleted.',
  reconciliation_required: 'Alexia restarted while this was being made. Retry it to make it again.',
  planner_unavailable: 'No model on this computer can read pictures. Add one under Local models.',
  planner_invalid: 'The request could not be understood. Try saying it another way.',
  unsupported_server: 'Editing needs Alexia’s own copy of the picture program.',
}
export const reasonText = (code: string | null | undefined): string => (code ? (REASONS[code] ?? code.replaceAll('_', ' ')) : '')
