// SPDX-License-Identifier: Apache-2.0
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { IDENT } from './manifest.js'

/**
 * The `alexia/*` layer — five method families, and nothing else. Everything MCP covers is
 * MCP; this is the remainder. `docs/spec/wire-protocol.md` §6 and `storage.md` are the
 * documents; a test diffs every `alexia/…` name in them against the table at the bottom.
 *
 * All of these are called **plugin → core**, so every params schema is an untrusted input
 * and core parses before it does anything. The one exception is
 * {@link SETTINGS_CHANGED}, which core sends downward.
 *
 * Params objects strip unknown keys rather than rejecting them: `_meta` rides along on
 * every request (see `meta.ts`) and MCP may add more.
 */

/** Only `_meta`, which is stripped along with anything else unrecognised. */
const OnlyMeta = z.object({})

const ident = z.string().regex(IDENT)

/** A bound parameter. Nothing a plugin sends is ever concatenated into SQL. */
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * One operator per column, and strict, so `{ gtee: 5 }` is a load error rather than a
 * `where` clause that quietly matched everything.
 */
const Operator = z
  .object({
    eq: Scalar.optional(),
    ne: Scalar.optional(),
    lt: Scalar.optional(),
    lte: Scalar.optional(),
    gt: Scalar.optional(),
    gte: Scalar.optional(),
    in: z.array(Scalar).optional(),
    like: z.string().optional(),
    isNull: z.literal(true).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length === 1, 'exactly one operator per column')

/** Keys are columns, values a literal (equals) or one operator. Multiple keys are AND. */
export const Where = z.record(ident, z.union([Scalar, Operator]))
export type Where = z.infer<typeof Where>

/** A row on the way in. Objects and arrays are stored as JSON text. */
const Row = z.record(ident, z.json())

/** A row on the way out. Core wrote it, and a raw query may alias a column anything. */
const ResultRow = z.record(z.string(), z.json())

const table = z.object({ table: ident })
/** `{}` is not a `where`. Deleting everything costs one explicit keystroke — see below. */
const filled = (w: Record<string, unknown>) => Object.keys(w).length > 0

/** Small values that do not deserve a table. Anything larger belongs in one, or in a file. */
export const KV_MAX_BYTES = 65536
const kvValue = z
  .json()
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v)) <= KV_MAX_BYTES,
    `a kv value must be at most ${KV_MAX_BYTES} bytes of JSON`,
  )

/**
 * MCP's `CallToolResult`, passed through unread. Loose on purpose: MCP owns this shape and
 * grows it, and Alexia re-reading it would be Alexia reinterpreting MCP.
 */
export const CallToolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional(),
})

export type CallToolResult = z.infer<typeof CallToolResult>

export const HostInfo = z.object({
  platform: z.string(),
  arch: z.string(),
  alexiaVersion: z.string(),
  alexiaProtocol: z.int().positive(),
  /**
   * What the user renamed Alexia to. Use it in anything the user reads. It is data, never
   * code — never compare it to a name.
   */
  displayName: z.string().min(1),
  /** `local` means the model runs on this machine. It does not mean nothing left it. */
  privacyMode: z.enum(['local', 'combined', 'cloud']),
  paths: z.object({
    /** Yours, purged with you, and the only directory you may assume. Needs `fs.own_dir`. */
    ownDir: z.string().optional(),
    cacheDir: z.string(),
  }),
  locale: z.string(),
})

export type HostInfo = z.infer<typeof HostInfo>

/** Core → plugin, when the user edits a setting while you are running. Only what changed. */
export const SETTINGS_CHANGED = 'alexia/settings/changed'
export const SettingsChanged = z.object({ changed: z.record(ident, z.json()) })

/**
 * Every `alexia/*` request, its params and its result. A supervisor dispatches off this
 * table, which is why it is one object and not twelve exported pairs.
 */
export const ALEXIA_METHODS = {
  'alexia/settings/get': {
    params: OnlyMeta,
    // Every key you declared, with the user's value or your default. A `password` comes
    // back as the real secret, read from the keychain now — do not cache it, do not log it.
    result: z.object({ settings: z.record(ident, z.json()) }),
  },

  /**
   * Write one of your own `status` settings, and nothing else.
   *
   * `ui-schema.md` says a `status` widget is "read-only — the plugin drives it at runtime by
   * writing to its own settings value", and until M2-1 there was no method that could. This
   * is it, and the narrowness is the point: a plugin may write a `status`, which is its own
   * read-only report of itself, and may not write a `toggle` the user set. A plugin that can
   * quietly undo a person's decision is a plugin that has to be trusted rather than read, and
   * the whole design is the other way round.
   *
   * Core remembers the value while you are not running, which is what makes the settings
   * screen honest before your first spawn.
   */
  'alexia/settings/set': {
    params: z.object({ key: ident, value: kvValue }),
    result: OnlyMeta,
  },

  'alexia/storage/insert': {
    params: table.extend({ row: Row }),
    result: z.object({ rowid: z.number() }),
  },
  'alexia/storage/select': {
    params: table.extend({
      where: Where.optional(),
      order: z.array(z.tuple([ident, z.enum(['asc', 'desc'])])).optional(),
      limit: z.int().positive().optional(),
      offset: z.int().nonnegative().optional(),
    }),
    result: z.object({ rows: z.array(ResultRow) }),
  },
  'alexia/storage/update': {
    params: table.extend({ set: Row, where: Where.refine(filled, 'update needs a where') }),
    result: z.object({ changed: z.number() }),
  },
  'alexia/storage/delete': {
    // The oldest bug in the world, prevented by one keystroke: a whole table goes only
    // when the caller says `all` and means it.
    params: table
      .extend({ where: Where.optional(), all: z.literal(true).optional() })
      .refine(
        (p) => (p.all === true) !== filled(p.where ?? {}),
        'delete takes either a non-empty where or all: true',
      ),
    result: z.object({ deleted: z.number() }),
  },
  'alexia/storage/count': {
    params: table.extend({ where: Where.optional() }),
    result: z.object({ count: z.number() }),
  },

  'alexia/storage/kv/get': {
    params: z.object({ key: ident }),
    result: z.object({ value: z.json().optional() }),
  },
  'alexia/storage/kv/set': {
    params: z.object({ key: ident, value: kvValue }),
    result: OnlyMeta,
  },
  'alexia/storage/kv/delete': {
    params: z.object({ key: ident }),
    result: OnlyMeta,
  },
  'alexia/storage/raw': {
    params: z.object({ sql: z.string().min(1), params: z.array(Scalar).optional() }),
    result: z.object({ rows: z.array(ResultRow) }),
  },

  'alexia/capability/call': {
    // By capability name, never by plugin id. The result does not say who answered and
    // there is no way to ask: that is the invariant, in code.
    params: z.object({ cap: z.string().min(1), arguments: z.record(z.string(), z.json()).optional() }),
    result: CallToolResult,
  },

  'alexia/host/info': { params: OnlyMeta, result: HostInfo },
} as const

export type AlexiaMethod = keyof typeof ALEXIA_METHODS
export type AlexiaParams<M extends AlexiaMethod> = z.infer<(typeof ALEXIA_METHODS)[M]['params']>
export type AlexiaResult<M extends AlexiaMethod> = z.infer<(typeof ALEXIA_METHODS)[M]['result']>

export const isAlexiaMethod = (m: string): m is AlexiaMethod => m in ALEXIA_METHODS
