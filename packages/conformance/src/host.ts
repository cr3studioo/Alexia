// SPDX-License-Identifier: Apache-2.0
import {
  ALEXIA_METHODS,
  ErrorCode,
  type AlexiaMethod,
  type HostInfo,
  type Manifest,
} from '@alexia/protocol'
import { ProtocolError, type StandardSchemaV1 } from '@modelcontextprotocol/client'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A throwaway Alexia, just real enough to be conformed against.
 *
 * The suite cannot import core — everything a plugin author installs is Apache-2.0 and
 * depends only on the contract, and `.dependency-cruiser.mjs` enforces that — so the
 * `alexia/*` layer is answered here, from the same schema table core answers it from.
 *
 * It is deliberately **stricter than core in one direction and weaker in another**: every
 * namespace rule is enforced exactly as `storage.md` writes it, and nothing is persisted
 * beyond the run. That is the right trade for a checker. What it is proving is not that a
 * plugin's data survives — it is that everything a plugin writes goes through the contract
 * and therefore lands somewhere a purge can find.
 */

/** Everything the plugin touched, which is the whole of what a purge would have to remove. */
export interface Touched {
  /** `table -> rows`, in declaration order, so an undeclared table is a refusal not a row. */
  tables: Map<string, Record<string, unknown>[]>
  kv: Map<string, unknown>
  settings: Map<string, unknown>
  /** Capability names it asked for that nothing answered. Degrading well is about these. */
  unanswered: string[]
}

export interface FakeHostOptions {
  manifest: Manifest
  /** The plugin's own directory. Created, watched, and diffed after the run. */
  ownDir: string
  /** Answer `alexia/capability/call`, or leave absent so every capability is unavailable. */
  capability?(cap: string, args?: Record<string, unknown>): Promise<unknown>
}

export interface FakeHost {
  touched: Touched
  /** One handler per `alexia/*` method, ready to hand to an MCP client. */
  handlers: [AlexiaMethod, { params: StandardSchemaV1; result: StandardSchemaV1 }, (params: unknown) => Promise<unknown> | unknown][]
}

const fail = (code: number, message: string): never => {
  throw new ProtocolError(code, message)
}

export function fakeHost(options: FakeHostOptions): FakeHost {
  const { manifest } = options
  mkdirSync(options.ownDir, { recursive: true })

  const touched: Touched = { tables: new Map(), kv: new Map(), settings: new Map(), unanswered: [] }

  /** The namespace rule, in one place. A table you did not declare is not yours. */
  const rows = (name: string): Record<string, unknown>[] => {
    if (!manifest.storage?.tables?.includes(name)) {
      return fail(ErrorCode.STORAGE_OUT_OF_NAMESPACE, `${manifest.id} did not declare a table called "${name}"`)
    }
    let held = touched.tables.get(name)
    if (!held) touched.tables.set(name, (held = []))
    return held
  }

  /**
   * The `where` grammar, matched rather than compiled — there is no SQL here, and a hundred
   * rows in a checker is a lot. Only the operators the wire schema defines.
   */
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([column, condition]) => {
      const held = row[column]
      if (condition === null || typeof condition !== 'object') return held === condition
      const [op, value] = Object.entries(condition)[0] as [string, unknown]
      switch (op) {
        case 'eq': return held === value
        case 'ne': return held !== value
        case 'lt': return Number(held) < Number(value)
        case 'lte': return Number(held) <= Number(value)
        case 'gt': return Number(held) > Number(value)
        case 'gte': return Number(held) >= Number(value)
        case 'in': return Array.isArray(value) && value.includes(held)
        case 'like': return new RegExp(`^${String(value).replace(/%/g, '.*').replace(/_/g, '.')}$`).test(String(held))
        case 'isNull': return held === null || held === undefined
        default: return false
      }
    })

  /**
   * Both screens, because a plugin reading its own values back does not know which one a
   * widget was declared on — and core does not either (D86). A harness that only knew about
   * `settings` would hand `undefined` to a plugin that reads a box on its own panel, and
   * pass it, and the same plugin would work in the product. A test bench disagreeing with
   * the thing it stands in for is worse than no bench.
   */
  const declaredWidgets = [...(manifest.settings ?? []), ...(manifest.panel?.widgets ?? [])]

  const settings = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {}
    for (const declared of declaredWidgets) {
      // A `password` has no default and nobody has typed one, which is the honest state of
      // a plugin nobody has configured — and the state its first run has to survive.
      if (declared.type === 'password') continue
      const held = touched.settings.get(declared.key)
      const value = held ?? ('default' in declared ? declared.default : undefined)
      if (value !== undefined) values[declared.key] = value
    }
    return values
  }

  const info = (): HostInfo => ({
    platform: process.platform,
    arch: process.arch,
    alexiaVersion: '0.0.0-conformance',
    alexiaProtocol: manifest.alexia_protocol,
    displayName: 'Alexia',
    privacyMode: 'combined',
    paths: {
      ...(manifest.requires?.some((r) => r.cap === 'fs.own_dir') && { ownDir: options.ownDir }),
      cacheDir: join(options.ownDir, 'cache'),
    },
    locale: 'en-GB',
  })

  const answer = async (method: AlexiaMethod, raw: unknown): Promise<unknown> => {
    const p = raw as Record<string, unknown>
    switch (method) {
      case 'alexia/settings/get':
        return { settings: settings() }

      case 'alexia/settings/set': {
        const declared = declaredWidgets.find((s) => s.key === p.key)
        // The narrowness is the design: a plugin reports itself, and never rewrites an
        // answer the user gave. Core refuses the same way, in the same words.
        if (!declared) {
          return fail(ErrorCode.SETTING_UNKNOWN, `${manifest.id} did not declare "${String(p.key)}"`)
        }
        if (declared.type !== 'status') {
          return fail(ErrorCode.INVALID_PARAMS, `${manifest.id} may only write its own status settings`)
        }
        touched.settings.set(String(p.key), p.value)
        return {}
      }

      case 'alexia/host/info':
        return info()

      case 'alexia/capability/call': {
        const cap = String(p.cap)
        if (!manifest.requires?.some((r) => r.cap === cap)) {
          return fail(ErrorCode.CAPABILITY_NOT_PERMITTED, `${manifest.id} did not ask for ${cap} in requires[]`)
        }
        const answered = options.capability
        if (!answered) {
          touched.unanswered.push(cap)
          return fail(ErrorCode.CAPABILITY_NOT_AVAILABLE, `nothing enabled provides ${cap}`)
        }
        return answered(cap, p.arguments as Record<string, unknown> | undefined)
      }

      case 'alexia/storage/insert': {
        const held = rows(String(p.table))
        held.push(p.row as Record<string, unknown>)
        return { rowid: held.length }
      }
      case 'alexia/storage/select': {
        const found = rows(String(p.table)).filter((row) => matches(row, p.where as Record<string, unknown>))
        const limit = typeof p.limit === 'number' ? p.limit : undefined
        const offset = typeof p.offset === 'number' ? p.offset : 0
        return { rows: found.slice(offset, limit === undefined ? undefined : offset + limit) }
      }
      case 'alexia/storage/update': {
        const found = rows(String(p.table)).filter((row) => matches(row, p.where as Record<string, unknown>))
        for (const row of found) Object.assign(row, p.set)
        return { changed: found.length }
      }
      case 'alexia/storage/delete': {
        const held = rows(String(p.table))
        const before = held.length
        const keep = p.all === true ? [] : held.filter((row) => !matches(row, p.where as Record<string, unknown>))
        touched.tables.set(String(p.table), keep)
        return { deleted: before - keep.length }
      }
      case 'alexia/storage/count':
        return { count: rows(String(p.table)).filter((row) => matches(row, p.where as Record<string, unknown>)).length }

      case 'alexia/storage/kv/get':
        return { value: touched.kv.get(String(p.key)) }
      case 'alexia/storage/kv/set':
        touched.kv.set(String(p.key), p.value)
        return {}
      case 'alexia/storage/kv/delete':
        touched.kv.delete(String(p.key))
        return {}

      case 'alexia/storage/raw':
        // Core refuses it too, and a plugin that needs it is a plugin that will not install.
        return fail(ErrorCode.STORAGE_OUT_OF_NAMESPACE, 'raw SQL is not available yet')

      default:
        return fail(ErrorCode.METHOD_NOT_FOUND, `${method} is not an Alexia method`)
    }
  }

  const table = Object.entries(ALEXIA_METHODS) as [
    AlexiaMethod,
    { params: StandardSchemaV1; result: StandardSchemaV1 },
  ][]

  return {
    touched,
    handlers: table.map(([method, schemas]) => [method, schemas, (params: unknown) => answer(method, params)]),
  }
}
