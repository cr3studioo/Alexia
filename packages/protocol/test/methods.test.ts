// SPDX-License-Identifier: Apache-2.0
import { readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ALEXIA_METHODS,
  ErrorCode,
  PERMISSIONS,
  PROVIDES_META,
  TOOLS_META,
  isAlexiaMethod,
  KV_MAX_BYTES,
  SETTINGS_CHANGED,
  type AlexiaMethod,
} from '../src/index.js'

const specDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'spec')
const specs = globSync('*.md', { cwd: specDir })
  .map((f) => readFileSync(join(specDir, f), 'utf8'))
  .join('\n')

const parse = <M extends AlexiaMethod>(m: M, params: unknown) =>
  ALEXIA_METHODS[m].params.safeParse(params)

// The specs are the brief and this package is the implementation. These two tests are the
// only thing stopping the brief from becoming decoration: a method or a code that appears
// in one and not the other fails the build on the day it is written, not at M2.
describe('the specs and the code say the same thing', () => {
  test('every alexia/… name in the specs is a method this package defines', () => {
    // The lookbehind keeps `@alexia/protocol` out of it — a package, not a method.
    const named = [...specs.matchAll(/(?<!@)alexia\/[a-z/]+/g)]
      .map((m) => m[0])
      .filter((n) => !n.endsWith('/'))
    expect(named.length).toBeGreaterThan(8) // the scanner is actually reading the specs
    // Three of them are not methods: one notification core sends down, and two `_meta` keys.
    const known = [SETTINGS_CHANGED, PROVIDES_META, TOOLS_META] as string[]
    const unknown = [...new Set(named)].filter((n) => !isAlexiaMethod(n) && !known.includes(n))
    expect(unknown, 'documented but not implemented').toEqual([])
  })

  test('every error code in the specs has the same name and number here', () => {
    const rows = [...specs.matchAll(/`(-32\d{3})`\s*(?:\|\s*)?`([A-Z_]+)`/g)]
    expect(rows.length).toBeGreaterThan(5)
    const wrong = rows
      .map(([, code, name]) => ({ code: Number(code), name: name as keyof typeof ErrorCode }))
      .filter(({ code, name }) => ErrorCode[name] !== code)
    expect(wrong, 'documented with a different number, or not at all').toEqual([])
  })
})

test('the permission registry in the document is the one in the code', () => {
  // The list is closed on purpose: a plugin cannot widen what it may ask for by inventing a
  // name. That is only true while the document and the constant agree, so this compares
  // them exactly — the section between the two headings, in order.
  const doc = readFileSync(join(specDir, 'capabilities.md'), 'utf8')
  const registry = doc.slice(doc.indexOf('## The permission registry'), doc.indexOf('## The service registry'))
  const named = [...registry.matchAll(/^\| `([a-z][a-z._]*)` \|/gm)].map((m) => m[1])
  expect(named).toEqual([...PERMISSIONS])
})

describe('the where grammar', () => {
  test('a literal means equals, and one operator is one operator', () => {
    expect(parse('alexia/storage/count', { table: 't', where: { at: 1, name: 'x' } }).success).toBe(true)
    expect(parse('alexia/storage/count', { table: 't', where: { at: { gte: 1 } } }).success).toBe(true)
  })

  test('a misspelled operator is refused, not silently matched', () => {
    // `{ gtee: 5 }` accepted as an empty clause would quietly match every row.
    expect(parse('alexia/storage/count', { table: 't', where: { at: { gtee: 5 } } }).success).toBe(false)
    expect(parse('alexia/storage/count', { table: 't', where: { at: { gt: 1, lt: 9 } } }).success).toBe(false)
  })

  test('a column name that is not an identifier never reaches the SQL builder', () => {
    expect(parse('alexia/storage/count', { table: 't', where: { 'a; drop table t': 1 } }).success).toBe(false)
    expect(parse('alexia/storage/insert', { table: 'a-b', row: { x: 1 } }).success).toBe(false)
  })
})

describe('delete', () => {
  test('an empty where is not a delete-everything', () => {
    expect(parse('alexia/storage/delete', { table: 't', where: {} }).success).toBe(false)
    expect(parse('alexia/storage/delete', { table: 't' }).success).toBe(false)
  })

  test('the whole table goes only when the caller says so', () => {
    expect(parse('alexia/storage/delete', { table: 't', all: true }).success).toBe(true)
    // Both at once is a caller that has not decided which it meant.
    expect(parse('alexia/storage/delete', { table: 't', all: true, where: { x: 1 } }).success).toBe(false)
  })

  test('update always needs a where', () => {
    expect(parse('alexia/storage/update', { table: 't', set: { x: 1 }, where: {} }).success).toBe(false)
    expect(parse('alexia/storage/update', { table: 't', set: { x: 1 }, where: { rowid: 4 } }).success).toBe(true)
  })
})

test('a kv value larger than the cap is refused', () => {
  expect(parse('alexia/storage/kv/set', { key: 'k', value: { a: 'x'.repeat(100) } }).success).toBe(true)
  expect(parse('alexia/storage/kv/set', { key: 'k', value: 'x'.repeat(KV_MAX_BYTES) }).success).toBe(false)
})

test('params carry _meta without being rejected for it', () => {
  const r = parse('alexia/host/info', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })
  expect(r.success).toBe(true)
})

test('a capability call names a capability, and hands back MCP untouched', () => {
  expect(parse('alexia/capability/call', { cap: 'voice.speak', arguments: { text: 'Done.' } }).success).toBe(true)
  // A capability, never a plugin id — and the caller may not aim one at a plugin either.
  expect(parse('alexia/capability/call', { cap: '' }).success).toBe(false)

  // Loose on purpose: MCP owns CallToolResult and grows it. A key we have never heard of
  // survives the round trip rather than being quietly dropped on the way to the plugin.
  const result = { content: [{ type: 'text', text: 'spoken', annotations: { audience: ['user'] } }], isError: false }
  expect(ALEXIA_METHODS['alexia/capability/call'].result.parse(result)).toEqual(result)
})
