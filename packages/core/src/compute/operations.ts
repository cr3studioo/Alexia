// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { Store } from '../store.js'
import type { Controller } from './controller.js'
import type { RemoteJobs } from './jobs.js'
import { ARTIFACT_ARG } from './protocol.js'
import { selectedHost } from './target.js'
import { fetchArtifact, upload } from './transfer.js'
import { ComputeError, THIS_HOST, type ArtifactRef, type JobProgress } from './types.js'

/** Replace approved input paths wherever they occur; the caller's arguments stay untouched. */
function staged(value: unknown, inputs: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return inputs.has(value) ? { [ARTIFACT_ARG]: inputs.get(value)! } : value
  if (Array.isArray(value)) return value.map((item) => staged(item, inputs))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, staged(item, inputs)]))
  return value
}

function localResult(result: CallToolResult): { text?: string; files: string[] } {
  const content = result.content.flatMap((item) => item.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n')
  if (result.isError) throw new ComputeError('worker-failure', content || 'The compute operation failed.')
  const structured = result.structuredContent as { text?: unknown; files?: unknown } | undefined
  const text = typeof structured?.text === 'string' ? structured.text : content || undefined
  const files = structured?.files ?? []
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) throw new ComputeError('worker-failure', 'The compute operation returned unreadable files.')
  return { ...(text !== undefined && { text }), files: files as string[] }
}

/** A capability runs on the chosen host, with no fallback when that host cannot serve it. */
export class Operations {
  constructor(private readonly options: {
    store: Pick<Store, 'kvGet' | 'kvSet'>
    jobs: RemoteJobs
    controller: Controller
    local: (cap: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>
  }) {}

  async run(request: { cap: string; args: Record<string, unknown>; inputs: { name: string; path: string; mime: string }[]; toDir: string },
    io: { signal?: AbortSignal; onProgress?(progress: JobProgress): void }): Promise<{ text?: string; files: string[] }> {
    if (io.signal?.aborted) throw new ComputeError('cancelled', 'The compute operation was cancelled.')
    const hostId = selectedHost(this.options.store)
    if (hostId === THIS_HOST) return localResult(await this.options.local(request.cap, request.args, io.signal))
    const { controller, jobs } = this.options
    await controller.ensure(hostId, io.signal)
    const capability = controller.view(hostId)?.inventory?.capabilities.find((one) => one.cap === request.cap)
    if (!capability?.ready) throw new ComputeError('setup-required', 'That computer is not ready to run this capability.')
    const jobId = randomUUID()
    const inputs = new Map<string, string>()
    const ids: string[] = []
    for (const file of request.inputs) {
      const artifact = await upload(controller, hostId, jobId, file, io.signal)
      inputs.set(file.path, artifact.id)
      ids.push(artifact.id)
    }
    let text: string | undefined
    const outputs = new Map<string, ArtifactRef>()
    const final = await jobs.run(hostId, {
      jobId, cap: request.cap, arguments: staged(request.args, inputs) as Record<string, unknown>, inputs: ids,
    }, { onEvent: (event) => {
      if (event.type === 'progress') io.onProgress?.(event.progress)
      if (event.type !== 'output') return
      if (event.output.type === 'text') text = (text ?? '') + event.output.text
      else if (event.output.type === 'artifact') outputs.set(event.output.artifact.id, event.output.artifact)
    } }, io.signal)
    if (final.state !== 'succeeded') {
      const failure = final.failure ?? { code: final.state === 'cancelled' ? 'cancelled' : final.state === 'interrupted' ? 'interrupted' : 'worker-failure', message: 'The compute operation did not finish.' }
      throw new ComputeError(failure.code, failure.message)
    }
    for (const artifact of final.artifacts ?? []) outputs.set(artifact.id, artifact)
    const files: string[] = []
    for (const artifact of outputs.values()) {
      if (artifact.jobId !== jobId) throw new ComputeError('refused', 'That computer returned a file from a different job.')
      files.push(await fetchArtifact(controller, hostId, artifact, request.toDir, io.signal))
    }
    return { ...(text !== undefined && { text }), files }
  }
}
