// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { ROUTES, refuse, verdictOf, type Verdict } from '../src/guard.js'
import { memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * The check that keeps M6-1 true: every state-changing route is guarded or declared safe
 * with a written reason, and there is no third category.
 *
 * The important half is that it **walks the real routes**. A list of paths maintained beside
 * `serve.ts` would agree with itself forever and say nothing about the file — so the routes
 * are read out of the source, and a handler added tomorrow turns this red without anybody
 * having to remember this file exists. That is the whole difference between a check and a
 * comment.
 *
 * Not an eleventh invariant (D82): the ten are about the plugin contract and what survives a
 * folder being deleted. This is core's own HTTP surface, so it sits here in the unit project
 * and joins `pnpm check` on its own merits.
 */

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'serve.ts'), 'utf8')

/**
 * Every `if` in `serve.ts` that answers a path, as the file actually writes them.
 *
 * The window is *from the path to the opening brace* rather than the rest of the line. One
 * `if` matches two paths — `/api/rows` and `/api/detail` are the same handler — and a
 * line-wise reader consumed the second one inside the first one's match and never saw it.
 * Reading to the brace also survives a condition that wraps.
 */
const handlers = [...source.matchAll(/url\.pathname === '([^']+)'/g)].map((found) => {
  const from = found.index
  const brace = source.indexOf('{', from)
  return {
    path: found[1]!,
    /** Whether that same condition also demands a POST. */
    changes: /request\.method === 'POST'/.test(source.slice(from, brace === -1 ? undefined : brace)),
  }
})

const reason = (verdict: Verdict): string => (verdict.kind === 'confirm' ? verdict.what : verdict.why)

/** Every verdict in the table, flattened, with a name to fail under. */
const verdicts = Object.entries(ROUTES).flatMap(([path, route]) => [
  { where: path, verdict: route.otherwise },
  ...Object.entries(route.acts ?? {}).map(([act, verdict]) => ({ where: `${path} (${act})`, verdict })),
])

test('the scanner is actually reading serve.ts', () => {
  // The failure mode of every source-walking check: a pattern that matches nothing passes
  // silently, forever, and looks exactly like a clean file.
  expect(handlers.length).toBeGreaterThan(12)
  expect(handlers.map((h) => h.path)).toContain('/api/chat')
  expect(handlers.filter((h) => h.changes).length).toBeGreaterThan(10)
})

test('every route core serves is classified, and nothing is classified that it does not serve', () => {
  const served = [...new Set(handlers.map((h) => h.path))].sort()
  const classified = Object.keys(ROUTES).sort()

  // Both directions. Missing means a route nobody has thought about; extra means a rule
  // about a handler that no longer exists, which is the sort of entry people trust.
  expect(served.filter((path) => !(path in ROUTES)), 'add these to ROUTES in guard.ts').toEqual([])
  expect(classified.filter((path) => !served.includes(path)), 'these are not routes any more').toEqual([])
})

test('there is no third category: every verdict is read, safe or confirm, and carries a reason', () => {
  for (const { where, verdict } of verdicts) {
    expect(['read', 'safe', 'confirm'], where).toContain(verdict.kind)
    // A reason per entry, not just a path. An entry nobody can justify in a sentence is an
    // entry that should have been guarded, and the length is what forces the sentence.
    expect(reason(verdict).length, `${where} needs a reason worth reading`).toBeGreaterThan(60)
    expect(reason(verdict).trim(), where).toMatch(/[.!?]$/)
  }
})

test('a route that answers a POST is never declared read-only', () => {
  // The lie this catches is a route that quietly grew a write while its entry still said it
  // only reads — which is exactly how a safe-list rots.
  const lying = handlers.filter((h) => h.changes && verdictOf(h.path)?.kind === 'read')
  expect(lying.map((h) => h.path), 'these change something and are declared read-only').toEqual([])
})

test('purge is guarded and enable is not, on the same endpoint', () => {
  // The narrowing that keeps the guard worth having: a confirm on every lifecycle press
  // would be a confirm nobody reads by the third one.
  expect(verdictOf('/api/plugin', { action: 'enable' })?.kind).toBe('safe')
  expect(verdictOf('/api/plugin', { action: 'disable' })?.kind).toBe('safe')
  expect(verdictOf('/api/plugin', { action: 'delete' })?.kind).toBe('confirm')

  // And the closed side of the door: an action nobody declared is not waved through.
  expect(verdictOf('/api/plugin', { action: 'obliterate' })?.kind).toBe('confirm')
  expect(verdictOf('/api/plugin', {})?.kind).toBe('confirm')
})

test('the fields that narrow the other three endpoints', () => {
  expect(verdictOf('/api/permissions', { mode: 'risky' })?.kind).toBe('safe')
  expect(verdictOf('/api/permissions', { lift: true })?.kind).toBe('confirm')

  expect(verdictOf('/api/library/install', { id: 'voice' })?.kind).toBe('safe')
  expect(verdictOf('/api/library/install', { id: 'voice', update: true })?.kind).toBe('confirm')

  expect(verdictOf('/api/server', { id: 'x', run: 'node' })?.kind).toBe('safe')
  expect(verdictOf('/api/server', { id: 'x', action: 'trust' })?.kind).toBe('confirm')

  expect(verdictOf('/api/learn', {})?.kind).toBe('safe')
  expect(verdictOf('/api/learn', { action: 'edit', name: 'x' })?.kind).toBe('safe')
  expect(verdictOf('/api/learn', { action: 'forget', name: 'x' })?.kind).toBe('confirm')
})

test('refuse says what would have happened, and only for the requests that change things', () => {
  // A read is not the thing this is here to catch.
  expect(refuse('/api/state', 'GET', {})).toBeUndefined()
  expect(refuse('/api/plugin', 'GET', {})).toBeUndefined()

  // ...but asking a read to change something is a refusal with a status of its own.
  expect(refuse('/api/state', 'POST', {})?.status).toBe(405)

  const stopped = refuse('/api/plugin', 'POST', { id: 'voice', action: 'delete' })
  expect(stopped?.status).toBe(409)
  expect(stopped?.confirmable).toBe(true)
  // The sentence names what goes, and says it has not gone.
  expect(stopped?.said).toContain('keychain')
  expect(stopped?.said).toContain('Nothing has happened yet')

  expect(refuse('/api/plugin', 'POST', { id: 'voice', action: 'delete', confirm: true })).toBeUndefined()

  // Fail closed: a path nobody classified does not run, whatever it would have done.
  expect(refuse('/api/nuke', 'POST', {})?.status).toBe(404)
})

// ---- and the same thing over the wire, because a guard that only holds in a unit test is
// a guard that holds nowhere -----------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'alexia-guard-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  secrets: memorySecrets(),
})
afterAll(() => alexia.close())

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(new URL(path, alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify(body),
  })

test('every guarded route refuses a request that did not say so, on the real server', async () => {
  // Walked from the table rather than typed, so a route that becomes destructive later is
  // covered by the same loop. Bodies are deliberately empty: the guard runs before the
  // handler, so none of these reaches anything that could act on them.
  const guarded = verdicts.filter((entry) => entry.verdict.kind === 'confirm')
  expect(guarded.length).toBeGreaterThan(3)

  for (const { where, verdict } of guarded) {
    const [path, act] = where.split(' (')
    const body: Record<string, unknown> =
      act === undefined ? {}
      : act.replace(')', '') === 'lift' ? { lift: true }
      : act.replace(')', '') === 'update' ? { update: true }
      : { action: act.replace(')', '') }

    const answer = await post(path!, body)
    expect(answer.status, where).toBe(409)
    const said = (await answer.json()) as { ok: boolean; said: string; confirm: boolean }
    expect(said.ok, where).toBe(false)
    expect(said.confirm, where).toBe(true)
    expect(said.said, where).toContain(reason(verdict).slice(0, 40))
  }
})

test('a declared-safe route is not made to ask', async () => {
  // The other half of the guarantee. A guard that refused everything would pass every test
  // above and make the product unusable.
  expect((await post('/api/ceilings', { steps: 9 })).status).toBe(200)
  expect((await post('/api/stop', {})).status).toBe(200)
  expect((await post('/api/permissions', { mode: 'watch' })).status).toBe(200)
  expect((await post('/api/plugin', { id: 'nothing', action: 'enable' })).status).toBe(200)
})

test('a body that is not JSON is a refusal rather than a 500', async () => {
  const answer = await fetch(new URL('/api/ceilings', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: '{ steps: 9',
  })
  expect(answer.status).toBe(400)
  expect(((await answer.json()) as { said: string }).said).toContain('not JSON')
})
