// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * The per-request envelope. Under MCP `2026-07-28` there is no `initialize`: the negotiated
 * version, who is calling and what they can do for *this* request all travel in
 * `params._meta`, on every request, in both directions.
 *
 * Capabilities are per-request and **must not be remembered between requests** — core
 * withdraws `sampling` when the user switches to a privacy mode that forbids it, and a
 * plugin that cached the last one would leak a prompt it was told not to send.
 */
export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
  logLevel: 'io.modelcontextprotocol/logLevel',
} as const

/**
 * What either side reads off an incoming `params._meta`. Loose because MCP owns this bag
 * and adds keys to it; everything not listed here is passed over, not rejected.
 */
export const RequestMeta = z.looseObject({
  [META.protocolVersion]: z.string().optional(),
  [META.clientCapabilities]: z.looseObject({}).optional(),
  [META.clientInfo]: z.looseObject({ name: z.string(), version: z.string() }).optional(),
  /** Present when the caller wants `notifications/progress`. Echo it verbatim. */
  progressToken: z.union([z.string(), z.number()]).optional(),
})

export type RequestMeta = z.infer<typeof RequestMeta>

/**
 * What a plugin answers `server/discover` with — the only part core reads.
 *
 * ponytail: our own loose shape rather than MCP's full one, because the MCP client lands
 * at M0-2 and this is needed to write the version check. Swap it for the client's parsed
 * result when that arrives.
 */
export const DiscoverResult = z.looseObject({
  supportedVersions: z.array(z.string()).min(1),
  capabilities: z.looseObject({}).optional(),
  /** Guidance for the model, not the user. Core puts it in the system prompt. */
  instructions: z.string().optional(),
})

export type DiscoverResult = z.infer<typeof DiscoverResult>
