// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * `plugin.json` v1 — the file core reads **before the plugin process exists**.
 *
 * The document this implements is `docs/spec/manifest.md`. Where the two disagree, the
 * document is the brief and this file is the bug.
 *
 * Two layers on purpose:
 *
 * - {@link ManifestShape} is plain structure, and is what `z.toJSONSchema` turns into the
 *   editor-facing JSON Schema. Nothing in it needs to look at another field.
 * - {@link Manifest} adds the cross-field rules a JSON Schema cannot express. Core
 *   validates with this one.
 */

/** The Alexia contract revisions core speaks. Not MCP's — see `mcp_protocol`. */
export const ALEXIA_PROTOCOL_MIN = 1
export const ALEXIA_PROTOCOL_MAX = 1

/**
 * The two MCP revisions core speaks, in preference order (D55, corrected by D57).
 *
 * `2025-11-25` is first because it is the one an Alexia plugin is built on: it is what the
 * reference SDK still treats as latest, and it is the last revision where a server may send
 * its host a request — which is the entire `alexia/*` layer. `2026-07-28` is accepted for
 * MCP servers that speak only it; on that revision the `alexia/*` layer is unavailable.
 */
export const MCP_REVISIONS = ['2025-11-25', '2026-07-28'] as const
/** What an Alexia plugin declares, and what `@alexia/sdk` serves. */
export const MCP_PINNED = MCP_REVISIONS[0]

/** Lowercase, hyphen-separated, and it must match the folder name. Mirrors agentskills.io. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** Dotted namespaces, LSP and MCP style: `voice.transcribe`, `fs.own_dir`. */
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
/**
 * A plain identifier: a setting key, a table name, a column name. SQLite-safe, so core can
 * build `p_<namespace>_<table>` without quoting and without parsing. Shared with the wire
 * schemas in `methods.ts` — one rule, written once.
 */
export const IDENT = /^[a-z][a-z0-9_]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Shape only. Whether core *accepts* a revision is a separate check with a readable refusal. */
const MCP_REVISION = /^\d{4}-\d{2}-\d{2}$/

const id = z.string().min(1).max(64).regex(ID, 'lowercase letters, digits and hyphens only')

const setting = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  z.object({
    // Never carries a default and never appears in a log or an export: core keeps the
    // value in the OS keychain and hands it back only to the plugin that declared it.
    type: z.literal('password'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal('number'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('toggle'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    default: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('choice'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    options: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal('multi-choice'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    options: z.array(z.string().min(1)).min(1),
    default: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('path'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    kind: z.enum(['file', 'dir']),
    // No default: an absolute path baked into a manifest is wrong on someone else's machine.
  }),
  z.object({
    // Read-only. The plugin drives it; core renders whatever it last wrote.
    type: z.literal('status'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal('progress'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
  }),
  z.object({
    // A button. Pressing it calls one of the plugin's own tools with no arguments.
    type: z.literal('action'),
    key: z.string().regex(IDENT),
    label: z.string().min(1),
    hint: z.string().optional(),
    tool: z.string().min(1),
  }),
])

export const ManifestShape = z
  .object({
    /** Editors read this to find the schema. Core ignores it. */
    $schema: z.string().optional(),

    manifest_version: z.literal(1),

    id,
    name: z.string().min(1).max(64),
    summary: z.string().min(1).max(200),
    version: z.string().regex(SEMVER, 'semantic version, e.g. 0.1.0'),
    license: z.string().min(1),

    entry: z
      .object({
        run: z.string().min(1),
        args: z.array(z.string()).optional(),
      })
      .strict(),

    /** Ours. An integer, bumped when the `alexia/*` layer changes. */
    alexia_protocol: z.int().positive(),
    /** MCP's. Pinned by the plugin, negotiated at `server/discover`. */
    mcp_protocol: z.string().regex(MCP_REVISION, 'an MCP revision date, e.g. 2026-07-28'),

    requires: z
      .array(
        z
          .object({
            cap: z.string().regex(CAPABILITY),
            // Not decoration: this sentence is what the user reads when asked to allow it.
            why: z.string().min(1).max(120),
          })
          .strict(),
      )
      .optional(),
    provides: z.array(z.string().regex(CAPABILITY)).optional(),

    settings: z.array(setting).optional(),

    storage: z
      .object({
        namespace: id,
        tables: z.array(z.string().regex(IDENT)).optional(),
        dir: z.boolean().optional(),
      })
      .strict()
      .optional(),

    commands: z
      .array(
        z
          .object({
            name: z.string().regex(ID),
            summary: z.string().min(1).max(120),
          })
          .strict(),
      )
      .optional(),

    /** Paths relative to the plugin folder. They install and purge with the plugin. */
    skills: z.array(z.string().min(1)).optional(),

    /** The cheapest router rung this plugin's work is safe on. */
    min_tier: z.enum(['T0', 'T1', 'T2', 'T3']).optional(),
  })
  // Strict on purpose. A typo'd `provide` that is silently ignored is a plugin that asks
  // for nothing and fails at runtime, which is a far worse morning than a load error.
  .strict()

export type ManifestInput = z.infer<typeof ManifestShape>

const dupes = (xs: string[]): string[] => xs.filter((x, i) => xs.indexOf(x) !== i)

export const Manifest = ManifestShape.superRefine((m, ctx) => {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message })

  // One namespace, one plugin, one thing to drop on purge.
  if (m.storage && m.storage.namespace !== m.id) {
    fail(['storage', 'namespace'], `storage.namespace must equal id ("${m.id}")`)
  }

  if (/^([A-Za-z]:|[\\/])/.test(m.entry.run)) {
    fail(['entry', 'run'], 'entry.run must be a command on PATH or a path relative to the plugin folder')
  }

  m.settings?.forEach((s, i) => {
    if (s.type === 'choice' && s.default !== undefined && !s.options.includes(s.default)) {
      fail(['settings', i, 'default'], `default "${s.default}" is not one of options`)
    }
    if (s.type === 'multi-choice' && s.default) {
      for (const d of s.default) {
        if (!s.options.includes(d)) fail(['settings', i, 'default'], `default "${d}" is not one of options`)
      }
    }
  })

  m.skills?.forEach((p, i) => {
    if (/^([A-Za-z]:|[\\/])/.test(p) || p.split(/[\\/]/).includes('..')) {
      fail(['skills', i], 'a skill path must stay inside the plugin folder')
    }
  })

  for (const [field, names] of [
    ['settings', (m.settings ?? []).map((s) => s.key)],
    ['commands', (m.commands ?? []).map((c) => c.name)],
    ['provides', m.provides ?? []],
    ['requires', (m.requires ?? []).map((r) => r.cap)],
  ] as const) {
    for (const d of new Set(dupes([...names]))) fail([field], `duplicate entry "${d}"`)
  }
})

export type Manifest = z.infer<typeof Manifest>

/** Whether core will load this manifest's declared contract versions, and why not. */
export function versionVerdict(m: Pick<Manifest, 'name' | 'alexia_protocol' | 'mcp_protocol'>):
  | { ok: true }
  | { ok: false; reason: string } {
  if (m.alexia_protocol > ALEXIA_PROTOCOL_MAX) {
    return {
      ok: false,
      reason: `${m.name} needs a newer Alexia.\nUpdate Alexia, or install an earlier version of ${m.name}.`,
    }
  }
  if (m.alexia_protocol < ALEXIA_PROTOCOL_MIN) {
    return {
      ok: false,
      reason: `${m.name} was written for an older version of Alexia and can't load.\nCheck whether ${m.name} has an update.`,
    }
  }
  if (!(MCP_REVISIONS as readonly string[]).includes(m.mcp_protocol)) {
    return { ok: false, reason: mcpRefusal(m.name, m.mcp_protocol) }
  }
  return { ok: true }
}

/**
 * The refusal a person reads when the revisions do not overlap — written once, because it
 * is said twice: from the manifest before spawn, and from `server/discover` after it.
 * `speaks` is what the plugin offered, in its own words.
 */
export function mcpRefusal(name: string, speaks: string): string {
  return (
    `${name} speaks a version of MCP that Alexia doesn't.\n` +
    `Alexia speaks ${MCP_REVISIONS.join(' and ')}; ${name} speaks ${speaks}.`
  )
}
