// SPDX-License-Identifier: AGPL-3.0-only
import { MCP_REVISIONS } from '@alexia/protocol'
import { Client, type Tool } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORE } from './secrets.js'
import type { Store } from './store.js'

/**
 * MCP compatibility mode (M3-6) — the payoff from choosing MCP as the wire.
 *
 * There are on the order of ten thousand MCP servers in the official registry. Any of them
 * can be a tool source here on the day it is written, because core is already an MCP client
 * speaking a pinned revision. What such a server does not have is a manifest — so core
 * synthesises the smallest honest one: no settings, no storage, no capabilities, and a
 * summary that says in plain words what this is.
 *
 * **Everything from one of these is treated as destructive until a person says otherwise.**
 * That is MCP's own guidance, not caution invented here: annotations are hints from the
 * server, and a server nobody reviewed has not earned the benefit of them. The permission
 * gate reads `reviewed: false` and stops asking whether a tool called itself read-only.
 *
 * The server is **probed before a folder exists**. Two things come out of that: the wire
 * revision it actually speaks, which is what the synthesised manifest has to declare
 * honestly, and the fact that it starts at all — so a typo'd command fails here, with the
 * error the operating system gave, rather than as a broken row in the library.
 */

/** The kv key holding every id that arrived this way. Membership is what `reviewed` reads. */
const KEY = 'mcp_servers'

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export interface ServerSpec {
  /** The folder name, and the prefix on every tool it contributes. */
  id: string
  /** What the library calls it. Its id if nothing better was given. */
  name?: string
  run: string
  args?: string[]
}

export interface Probed {
  /** The MCP revisions it offered, intersected with the ones core speaks. */
  speaks: string
  tools: { name: string; description?: string }[]
}

/**
 * Start it once, ask it what it is, stop it.
 *
 * A throwaway connection with no `alexia/*` handlers on it, because a server that has not
 * been added yet has no id to scope them to — and because the thing being answered here is
 * only *does this start, and what does it speak*.
 */
export async function probe(spec: ServerSpec, timeoutMs = 20_000): Promise<Probed> {
  const transport = new StdioClientTransport({
    command: spec.run,
    args: spec.args,
    env: getDefaultEnvironment(),
    stderr: 'pipe',
  })
  const client = new Client(
    { name: 'Alexia', version: '0.1.0' },
    {
      capabilities: {},
      supportedProtocolVersions: [...MCP_REVISIONS],
      versionNegotiation: { mode: 'auto' },
    },
  )
  try {
    await client.connect(transport, { timeout: timeoutMs })
    const offered = client.getDiscoverResult()?.supportedVersions ?? [
      client.getNegotiatedProtocolVersion() ?? '',
    ]
    const speaks = MCP_REVISIONS.find((revision) => offered.includes(revision))
    if (!speaks) {
      throw new Error(
        `it speaks ${offered.join(', ') || 'no version Alexia recognises'}; Alexia speaks ${MCP_REVISIONS.join(' and ')}`,
      )
    }
    const tools: Tool[] = await client.listTools().then((r) => r.tools, () => [])
    return {
      speaks,
      tools: tools.map((tool) => ({ name: tool.name, ...(tool.description !== undefined && { description: tool.description }) })),
    }
  } finally {
    await transport.close().catch(() => undefined)
  }
}

/**
 * The synthesised manifest.
 *
 * Every field is either structural or a sentence a person reads, and the summary is the
 * sentence: **MCP server. Not an Alexia plugin. Not reviewed by us.** It is written into
 * the manifest rather than added by the screen so that it travels with the folder — the
 * library, the settings pane and anything else that ever reads a manifest all say it.
 */
export const synthesise = (spec: ServerSpec, speaks: string): Record<string, unknown> => ({
  manifest_version: 1,
  id: spec.id,
  name: spec.name?.trim() || spec.id,
  summary: 'MCP server. Not an Alexia plugin. Not reviewed by us.',
  version: '0.0.0',
  license: 'unknown',
  entry: { run: spec.run, ...(spec.args?.length && { args: spec.args }) },
  alexia_protocol: 1,
  mcp_protocol: speaks,
})

export interface Added {
  id: string
  speaks: string
  tools: number
}

/**
 * Add one. Probed, then written, in that order and for the same reason `install` validates
 * a folder where it stands: a folder that would not work must never appear in the directory
 * core watches.
 */
export async function addServer(
  spec: ServerSpec,
  options: { store: Store; pluginsDir: string },
): Promise<Added | { why: string }> {
  const id = spec.id.trim()
  if (!ID.test(id)) return { why: `“${id}” is not a usable name — lowercase letters, digits and hyphens.` }
  const dir = join(options.pluginsDir, id)
  if (existsSync(dir)) return { why: `Something called “${id}” is already installed.` }
  if (!spec.run.trim()) return { why: 'There is no command to run.' }

  let found: Probed
  try {
    found = await probe(spec)
  } catch (error) {
    return { why: `${id} did not start: ${error instanceof Error ? error.message : String(error)}` }
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(synthesise(spec, found.speaks), null, 2)}\n`)
  remember(options.store, id)
  // Installed, not enabled. The screen has still to show what this is before it runs.
  return { id, speaks: found.speaks, tools: found.tools.length }
}

/** Every id that arrived through compatibility mode. The gate reads this and nothing else. */
export function unreviewed(store: Store): Set<string> {
  const said = store.kvGet(CORE, KEY)
  return new Set(Array.isArray(said) ? said.filter((id): id is string => typeof id === 'string') : [])
}

function remember(store: Store, id: string): void {
  const known = unreviewed(store)
  known.add(id)
  store.kvSet(CORE, KEY, [...known].sort())
}

/**
 * A person vouching for one, deliberately, after reading what it does.
 *
 * The only way out of *everything is destructive*, and it is a decision with a name on it
 * rather than a default that erodes. ponytail: no per-tool vouching — the unit is the
 * server, because that is the unit somebody actually decided to trust.
 */
export function markReviewed(store: Store, id: string): void {
  const known = unreviewed(store)
  known.delete(id)
  store.kvSet(CORE, KEY, [...known].sort())
}
