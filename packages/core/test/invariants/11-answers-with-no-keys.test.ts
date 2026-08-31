// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Catalog } from '../../src/catalog.js'
import { usable } from '../../src/pool.js'
import { anonymous, keyOf, PROVIDERS } from '../../src/provider.js'
import { MODES, route, send, type World } from '../../src/router.js'
import { CORE, memorySecrets } from '../../src/secrets.js'
import { serve } from '../../src/serve.js'
import { Store, textOf } from '../../src/store.js'
import { noPolling } from '../staged.js'

/**
 * Defends the promise the whole project rests on: **no keychain entries, no Ollama running,
 * and Alexia still answers.**
 *
 * The sibling of `02-boots-with-no-plugins`. That one says core works with nothing installed;
 * this one says it works with nothing *paid for* and nothing signed up to — which is the
 * sentence the README makes and which, until now, nothing enforced. A claim in a README is a
 * claim; this is the version that goes red.
 *
 * **It really does reach the providers.** Mocking a response here would test the mock: the
 * only thing worth knowing is whether four rows written down in `provider.ts` still answer a
 * stranger with no credentials, and that is a question only the network can be asked. So this
 * one check is allowed to be slow, and is allowed to fail because somebody else's server is
 * down — which is a true thing to learn on the day it happens.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-nokeys-'))
mkdirSync(join(root, 'cache'), { recursive: true })

/** Nothing in it, ever. Every read below asks the same empty store the same question. */
const secrets = memorySecrets()
const store = new Store(':memory:')
const catalog = new Catalog(join(root, 'cache', 'models.json'))

afterAll(() => void store.close())

/** The keyless floor as a running Alexia sees it, with no Ollama and no keys. */
async function floor(): Promise<World> {
  return {
    models: catalog.models,
    // "No Ollama running" is a condition of the check rather than of the machine, so it is
    // stated here. A developer who happens to have Ollama up must not accidentally pass this.
    local: [],
    rungs: await usable(store, secrets),
    // And no allowance, so nothing here can quietly reach across the price line to answer.
    today: { spent: 0, allowance: 0 },
  }
}

test('answers-with-no-keys: nothing is in the keychain', async () => {
  for (const provider of PROVIDERS) {
    expect(await secrets.get(CORE, keyOf(provider)), provider.id).toBeUndefined()
  }
})

test('answers-with-no-keys: there are rungs to stand on before anybody pastes anything', async () => {
  const rungs = await usable(store, secrets)
  // Every row that needs a key is absent, and what is left is the floor.
  expect(rungs.length).toBeGreaterThan(0)
  expect(rungs.every((rung) => anonymous(rung.provider))).toBe(true)
})

test('answers-with-no-keys: the router has somewhere to send a first message', async () => {
  const verdict = route({ messages: [{ role: 'user', content: 'say ok' }] }, { placement: MODES.cloud }, await floor())
  expect(verdict.ok, verdict.ok ? '' : verdict.why).toBe(true)
})

test(
  'answers-with-no-keys: a fresh install returns a completion',
  { timeout: 300_000 },
  async () => {
    // A real poll first, the way `serve()` does at startup — several of these rows carry no
    // written-down models and arrive entirely from their own list.
    await Promise.all(
      PROVIDERS.filter((p) => anonymous(p)).map((p) => catalog.refresh(p).catch(() => undefined)),
    )

    const world = await floor()
    const verdict = route(
      { messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
      { placement: MODES.cloud },
      world,
    )
    expect(verdict.ok, verdict.ok ? '' : verdict.why).toBe(true)
    if (!verdict.ok) return

    // The whole plan, not the first rung. A free floor at two requests a minute will hand out
    // 429s, and walking past them is exactly what `send` is for.
    const answer = await send(
      verdict.choices,
      { messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
      store,
      secrets,
    )

    expect(answer.message.role).toBe('assistant')
    expect(textOf(answer.message).trim().length, `${answer.model.id} answered with nothing`).toBeGreaterThan(0)
    // Free, and it stayed free: a completion that cost money would be a different promise.
    expect(store.spend(0)).toBe(0)
  },
)

test('answers-with-no-keys: take the keyless rows away and the promise is gone', async () => {
  // The other half, and the half that keeps this file honest. A test that passes because
  // *something somewhere* answered would go on passing after somebody deleted the floor.
  const keyed = PROVIDERS.filter((p) => !anonymous(p))
  const without: World = {
    models: catalog.models,
    local: [],
    rungs: await usable(store, secrets, keyed),
    today: { spent: 0, allowance: 0 },
  }

  const verdict = route({ messages: [{ role: 'user', content: 'say ok' }] }, { placement: MODES.cloud }, without)
  expect(verdict.ok).toBe(false)
  if (!verdict.ok) expect(verdict.why).toContain('add a key in settings')
})

/**
 * **The same promise, walked the way a person walks it** (§12.2).
 *
 * Everything above asks the router and the pool directly, which is the right way to find out
 * whether the floor is there. It is not the right way to find out whether anybody can *reach*
 * it: that goes through a first-run screen, a Skip, and a chat box, and a promise that holds
 * in `route()` but not in `/api/chat` is a promise nobody actually gets.
 *
 * So this is the first evening in full — press the button that says *skip*, type one thing,
 * and see whether an answer comes back, with the keychain still empty at the end of it.
 */
test('answers-with-no-keys: skip, then a first message, reaches an answer', { timeout: 300_000 }, async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'alexia-skip-'))
  noPolling(fresh)
  const empty = memorySecrets()
  const alexia = await serve({
    dataDir: fresh,
    uiDir: join(import.meta.dirname, '..', '..', '..', 'ui'),
    secrets: empty,
  })
  const call = (path: string, body: unknown): Promise<Response> =>
    fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  try {
    // Skip is exactly this request: a name, a mode, and no provider — which is what the first
    // run sends when nobody has pasted anything into the key wall.
    expect((await call('/api/setup', { name: 'Alexia', mode: 'cloud' })).status).toBe(200)

    const frames = (await (await call('/api/chat', { text: 'Reply with the single word: ok' })).text())
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as { delta?: string; error?: string })

    // An answer, not a refusal — and the refusal is the thing worth naming when this fails,
    // because it is the sentence a person would have met on their own first evening.
    const said = frames.map((frame) => frame.delta ?? '').join('')
    const wall = frames.find((frame) => frame.error !== undefined)?.error
    expect(said.trim().length, wall ?? 'nothing was said').toBeGreaterThan(0)

    // And nothing was signed up to on the way through.
    for (const provider of PROVIDERS) expect(await empty.get(CORE, keyOf(provider)), provider.id).toBeUndefined()
  } finally {
    await alexia.close()
  }
})
