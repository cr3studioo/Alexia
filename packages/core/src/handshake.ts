// SPDX-License-Identifier: AGPL-3.0-only
import { mcpRefusal, MCP_REVISIONS, versionVerdict, type Manifest } from '@alexia/protocol'

/**
 * The two version checks, in the order they happen. `docs/spec/wire-protocol.md` §3.3.
 *
 * Check two — ours, an integer — reads the manifest and runs **before spawn**, so a plugin
 * written for a newer Alexia never gets a process. Check one — MCP's — needs the plugin's
 * answer to `server/discover`, so it runs after. Both live here because the refusal is the
 * same shape either way: no, and here is the sentence the user reads.
 */
export type Negotiated = { ok: true; mcp: string } | { ok: false; reason: string }

/** What core declares about itself. The plugin's `supportedVersions` is intersected with it. */
export type PluginVersions = Pick<Manifest, 'name' | 'alexia_protocol' | 'mcp_protocol'>

export function negotiate(plugin: PluginVersions, supportedVersions: readonly string[]): Negotiated {
  const verdict = versionVerdict(plugin)
  if (!verdict.ok) return verdict

  // The manifest is a claim about a process that did not exist yet. This is where it is
  // confirmed: a plugin that declared one revision and serves another is a plugin whose
  // manifest core cannot trust about anything else either.
  if (!supportedVersions.includes(plugin.mcp_protocol)) {
    return { ok: false, reason: mcpRefusal(plugin.name, supportedVersions.join(', ')) }
  }

  // In our preference order, not the plugin's: `2025-11-25` first, because that is where a
  // plugin can call back into core at all. See MCP_REVISIONS.
  const mcp = MCP_REVISIONS.find((r) => supportedVersions.includes(r))
  if (!mcp) return { ok: false, reason: mcpRefusal(plugin.name, supportedVersions.join(', ')) }
  return { ok: true, mcp }
}
