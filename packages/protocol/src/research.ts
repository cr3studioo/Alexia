// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

export const RESEARCH_META = 'alexia/research'
/** Host supplied; never a model argument. */
export const CALL_CONTEXT_META = 'alexia/call-context'
const id = z.string().min(1).max(128)
const webUrl = z.string().max(4096).url().refine((s) => {
  const u = new URL(s)
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
})
export const ResearchPassage = z.object({
  id, text: z.string().min(1).max(2500),
  /** Normalized screenshot coordinates, only when the exact passage was located. */
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).optional(),
})
export const ResearchSource = z.object({
  id, url: webUrl, title: z.string().max(1000),
  state: z.enum(['fetching', 'complete', 'unavailable']),
  retrievedAt: z.string().max(64).optional(),
  error: z.string().max(1000).optional(),
  text: z.string().max(6000).optional(),
  preview: z.string().max(4096).optional(),
  passages: z.array(ResearchPassage).max(6).default([]),
})
/** A complete bounded snapshot: reconnecting needs no replay or counter arithmetic. */
export const ResearchUpdate = z.object({
  runId: id, conversationId: id, sequence: z.int().nonnegative(),
  topic: z.string().min(1).max(2000), startedAt: z.number().nonnegative(), elapsedMs: z.number().nonnegative(),
  stage: z.enum(['searching', 'reading', 'writing', 'finished']),
  sources: z.array(ResearchSource).max(12), currentSourceId: id.optional(),
  counters: z.object({ read: z.int().nonnegative(), inProgress: z.int().nonnegative(), failed: z.int().nonnegative() }),
  completion: z.enum(['running', 'complete', 'failed', 'cancelled']),
  report: z.object({ path: z.string().max(4096), name: z.string().max(255) }).optional(),
  gaps: z.array(z.string().max(1000)).max(20).default([]),
})
export type ResearchUpdate = z.infer<typeof ResearchUpdate>
export type ResearchSource = z.infer<typeof ResearchSource>
