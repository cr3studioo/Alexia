// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { chat, keyOf, ProviderError, type Provider, type Sign } from '../src/provider.js'
import { KEY_REFUSALS, send, type Phase, type Switch } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

/**
 * **Faster answers, over the real wire**: two models asked at once while somebody waits, a busy
 * first model asked again in place, and none of it leaking a word the person was not meant to see.
 *
 * The clock is a test's — tens of milliseconds where the app has seconds — and every assertion
 * about time is a floor, never a ceiling: a loaded machine makes things later, not earlier.
 */

/**
 * What each model does when asked:
 *
 * - absent — answers `from <model>`.
 * - `hang` — a gateway's keep-alive every 50 ms, and never a word.
 * - `busy` — a 429 that says the host is full, every time.
 * - `busy-then-ok:N` — that 429 N times, then an answer.
 * - `quota-429` — a 429 that says the day is spent, with the header that says so too.
 * - `slow-first:ms` — an answer, that long after being asked.
 * - `reasoning` — thinks out loud first, then answers.
 * - `needs-key` — a keyless provider's 401 for a model that wants a key.
 * - `dies:ms` — that long after being asked, half a sentence, and then the connection drops.
 */
let behave = new Map<string, string>()
/** Every request, in order: which model, when it arrived, and the body as sent. */
const asked: { model: string; at: number; body: Record<string, unknown> }[] = []
/** Requests to a `hang` model whose connection has since closed — cancelled by the client. */
const hungUp: string[] = []
const count = (model: string): number => asked.filter((one) => one.model === model).length

const answer = (model: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: `from ${model}` } }] })}\n\n` +
  `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    const body = JSON.parse(raw) as Record<string, unknown>
    const model = String(body.model)
    asked.push({ model, at: Date.now(), body })
    const how = behave.get(model) ?? 'ok'
    const [kind, arg] = how.split(':')
    const busy = (): void => {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `${model} is temporarily rate-limited upstream. Please retry shortly.` } }))
    }
    if (kind === 'hang') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const ping = setInterval(() => response.write(': OPENROUTER PROCESSING\n\n'), 50)
      response.on('close', () => {
        clearInterval(ping)
        hungUp.push(model)
      })
      return
    }
    if (kind === 'busy') return busy()
    if (kind === 'busy-then-ok' && count(model) <= Number(arg)) return busy()
    if (kind === 'quota-429') {
      response.writeHead(429, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' })
      response.end(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }))
      return
    }
    if (kind === 'needs-key') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'missing_api_key' }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (kind === 'slow-first') {
      setTimeout(() => response.end(answer(model)), Number(arg))
      return
    }
    if (kind === 'dies') {
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half of' } }] })}\n\n`)
        setTimeout(() => response.destroy(), 20)
      }, Number(arg))
      return
    }
    if (kind === 'reasoning') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Let me see.' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Still thinking.' } }] })}\n\n`)
      setTimeout(() => response.end(answer(model)), 30)
      return
    }
    response.end(answer(model))
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => void server.close())

const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: at, rpm: 1000, rpd: 1000 }
const beta: Provider = { id: 'beta', name: 'Beta', baseUrl: at, rpm: 1000, rpd: 1000 }
/** A gateway that gives up on keep-alives in a quarter of a second, rather than in two minutes. */
const impatient: Provider = { id: 'impatient', name: 'Impatient', baseUrl: at, timeoutMs: 250, idleMs: 250, keptAliveMs: 250 }
const dear: Provider = { id: 'dear', name: 'Dear', baseUrl: at, pricing: 'published', timeoutMs: 250, idleMs: 250, keptAliveMs: 250 }
const sticky: Provider = { id: 'sticky', name: 'Sticky', baseUrl: at, stickySessions: true }
/** A keyless floor, asked with no key at all. */
const floor: Provider = { id: 'floor', name: 'Floor', baseUrl: at, auth: 'optional' }
const secrets = memorySecrets()
for (const provider of [alpha, beta, impatient, dear, sticky]) await secrets.set(CORE, keyOf(provider), `sk-${provider.id}`)

const model = (id: string, provider: Provider, over: Partial<Model> = {}): { model: Model; provider: Provider } => ({
  model: {
    id,
    name: id,
    provider: provider.id,
    tier: 'T1',
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: false,
    modality: ['text'],
    nsfwOk: 'unknown',
    trainsOnYourData: 'unknown',
    ...over,
  },
  provider,
})
const paidModel = (id: string, provider: Provider): { model: Model; provider: Provider } =>
  model(id, provider, { tier: 'T2', priceIn: 0.2, priceOut: 0.2 })

const hello = { messages: [{ role: 'user' as const, content: 'hello' }] }

/** Everything the screen would be told, in the order it was told. */
const watching = () => {
  const deltas: string[] = []
  const switches: Switch[] = []
  const phases: Phase[] = []
  return {
    deltas,
    switches,
    phases,
    hooks: {
      onDelta: (text: string) => deltas.push(text),
      onSwitch: (event: Switch) => switches.push(event),
      onPhase: (phase: Phase) => phases.push(phase),
    },
  }
}

/** A fresh record, and a fresh server log. */
const fresh = (how: [string, string][]): Store => {
  behave = new Map(how)
  asked.length = 0
  hungUp.length = 0
  return new Store(':memory:')
}

const until = async (done: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
}

test('a first model that only keeps the line open has the next one asked beside it, and is cancelled without a mark', async () => {
  const store = fresh([['hang/a', 'hang']])
  const screen = watching()
  const started = Date.now()
  const got = await send([model('hang/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 40,
    starWait: 300,
  })
  const took = Date.now() - started

  expect(got.model.id).toBe('ok/b')
  expect(screen.deltas).toEqual(['from ok/b'])
  // Asked once the first had shown nothing for the hedge, not before.
  const backup = asked.find((one) => one.model === 'ok/b')
  expect(backup).toBeDefined()
  expect((backup?.at ?? 0) - started).toBeGreaterThanOrEqual(35)
  // The first model keeps priority until the wait is over, and then the backup's held answer goes.
  expect(took).toBeGreaterThanOrEqual(280)
  expect(screen.switches.map((one) => one.says)).toEqual(['hang/a had not started answering after 1 second — this answer is from ok/b.'])
  expect(screen.phases).toContainEqual({ kind: 'backup', model: 'ok/b', behind: 'hang/a', why: 'slow' })

  // Cancelled — the connection closed — and never recorded: a cancel is not a failure.
  await until(() => hungUp.includes('hang/a'))
  expect(hungUp).toContain('hang/a')
  expect(store.tries().map((one) => [one.model, one.outcome])).toEqual([['ok/b', 'answered']])
  expect(typeof store.tries()[0]?.waited).toBe('number')
  store.close()
})

test('a busy first model that answers inside the wait is the answer, and not one word of the backup reaches the screen', async () => {
  const store = fresh([['busy3/a', 'busy-then-ok:3']])
  const screen = watching()
  const started = Date.now()
  const got = await send([model('busy3/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 20,
    starWait: 2_000,
    retryStep: 10,
  })

  expect(got.model.id).toBe('busy3/a')
  expect(screen.deltas).toEqual(['from busy3/a'])
  expect(screen.switches).toEqual([])
  expect(Date.now() - started).toBeLessThan(2_000)
  // Three busy replies and the one that answered: four requests, one try.
  expect(count('busy3/a')).toBe(4)
  // The backup was really asked, and really answered — into a buffer nobody read.
  expect(count('ok/b')).toBe(1)
  const first = store.tries().filter((one) => one.model === 'busy3/a')
  expect(first.map((one) => one.outcome)).toEqual(['answered'])
  expect(typeof first[0]?.waited).toBe('number')
  // Every request counted against its free tier, the three that were refused included.
  expect(store.requests('alpha').minute).toBe(4)
  store.close()
})

test('a first model that is only slow to start is still the answer when it starts inside the wait', async () => {
  const store = fresh([['slow/a', 'slow-first:120']])
  const screen = watching()
  const got = await send([model('slow/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 20,
    starWait: 2_000,
  })
  expect(got.model.id).toBe('slow/a')
  expect(screen.deltas).toEqual(['from slow/a'])
  expect(count('ok/b')).toBe(1)
  expect(screen.phases).toContainEqual({ kind: 'backup', model: 'ok/b', behind: 'slow/a', why: 'slow' })
  expect(screen.switches).toEqual([])
  store.close()
})

test('a first model that dies partway hands over to the backup whose answer was already held, without asking it again', async () => {
  const store = fresh([['dies/a', 'dies:120']])
  const shown: string[] = []
  const got = await send([model('dies/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    onDelta: (text) => shown.push(text),
    onRestart: () => shown.push('[restart]'),
    onSwitch: (event) => shown.push(`[${event.says}]`),
    hedgeAfter: 20,
    starWait: 2_000,
  })
  expect(got.model.id).toBe('ok/b')
  expect(shown).toEqual(['Half of', '[restart]', '[dies/a stopped answering partway through — this answer is from ok/b.]', 'from ok/b'])
  expect(count('ok/b')).toBe(1)
  store.close()
})

test('a first model still busy when the wait runs out gives way to the backup, and the switch says why', async () => {
  const store = fresh([['busy/a', 'busy']])
  const screen = watching()
  const started = Date.now()
  const got = await send([model('busy/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 20,
    starWait: 300,
    retryStep: 10,
  })

  expect(got.model.id).toBe('ok/b')
  expect(screen.deltas).toEqual(['from ok/b'])
  // Not before the first model had had its wait.
  expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  expect(count('busy/a')).toBeGreaterThan(2)
  expect(screen.switches).toEqual([
    {
      from: ['busy/a'],
      to: 'ok/b',
      reasons: ['busy/a is rate-limited right now'],
      says: 'busy/a is rate-limited right now — this answer is from ok/b.',
    },
  ])
  // One try for the model that was asked again and again: busy, once.
  expect(store.tries().filter((one) => one.model === 'busy/a').map((one) => one.outcome)).toEqual(['busy'])
  store.close()
})

test('a pinned model that is busy a few times answers, and one busy for good stops after twice the wait', async () => {
  const clock = { hedgeAfter: 20, starWait: 300, retryStep: 10 }
  const store = fresh([['busy3/a', 'busy-then-ok:3']])
  const got = await send([model('busy3/a', alpha)], hello, store, secrets, clock)
  expect(got.message.content).toBe('from busy3/a')
  expect(store.tries().map((one) => one.outcome)).toEqual(['answered'])
  store.close()

  const again = fresh([['busy/a', 'busy']])
  const started = Date.now()
  const stop = await send([model('busy/a', alpha)], hello, again, secrets, clock).catch((error: unknown) => error)
  // Longer than one wait: a pin has nothing to fall back to, so it is given two.
  expect(Date.now() - started).toBeGreaterThanOrEqual(450)
  expect(stop).toBeInstanceOf(ProviderError)
  expect((stop as ProviderError).message).toBe('busy/a is rate-limited right now.')
  expect(again.tries().map((one) => one.outcome)).toEqual(['busy'])
  again.close()
})

test('a day spent is not asked again: the next model is asked at once', async () => {
  const store = fresh([['spent/a', 'quota-429']])
  const screen = watching()
  const started = Date.now()
  const got = await send([model('spent/a', alpha), model('ok/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 1_000,
    starWait: 3_000,
    retryStep: 10,
  })
  expect(got.model.id).toBe('ok/b')
  expect(count('spent/a')).toBe(1)
  // No retrying, and no waiting out the first model's priority: it failed for good.
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(screen.phases.filter((one) => one.kind === 'retrying')).toEqual([])
  store.close()
})

test('a paid model is never asked beside another, and a paid first model is never raced', async () => {
  const clock = { hedgeAfter: 20, starWait: 100, retryStep: 10 }
  // A free first model that hangs, with only a paid one behind it: the paid one waits its turn.
  const store = fresh([['hang/a', 'hang']])
  const screen = watching()
  const started = Date.now()
  const got = await send([model('hang/a', impatient), paidModel('paid/b', dear)], { ...hello, maxTokens: 100 }, store, secrets, {
    ...screen.hooks,
    ...clock,
  })
  expect(got.model.id).toBe('paid/b')
  expect((asked.find((one) => one.model === 'paid/b')?.at ?? 0) - started).toBeGreaterThanOrEqual(200)
  expect(screen.phases.filter((one) => one.kind === 'backup')).toEqual([])
  store.close()

  // A paid first model that hangs: nothing free is asked beside it until it has failed.
  const second = fresh([['paid/hang', 'hang']])
  const watched = watching()
  const began = Date.now()
  const answered = await send([paidModel('paid/hang', dear), model('ok/b', beta)], { ...hello, maxTokens: 100 }, second, secrets, {
    ...watched.hooks,
    ...clock,
  })
  expect(answered.model.id).toBe('ok/b')
  expect((asked.find((one) => one.model === 'ok/b')?.at ?? 0) - began).toBeGreaterThanOrEqual(200)
  expect(watched.phases.filter((one) => one.kind === 'backup')).toEqual([])
  second.close()
})

test(`a keyless provider that wants a key for ${String(KEY_REFUSALS)} models in one walk is not asked for a fourth`, async () => {
  const store = fresh([
    ['k/1', 'needs-key'],
    ['k/2', 'needs-key'],
    ['k/3', 'needs-key'],
    ['k/4', 'needs-key'],
  ])
  const got = await send(
    [model('k/1', floor), model('k/2', floor), model('k/3', floor), model('k/4', floor), model('ok/b', beta)],
    hello,
    store,
    secrets,
    { hedgeAfter: 1_000, starWait: 1_000, retryStep: 10 },
  )
  expect(got.model.id).toBe('ok/b')
  expect(asked.map((one) => one.model)).toEqual(['k/1', 'k/2', 'k/3', 'ok/b'])
  // Each of the three is still a fact about its own model, as D165 has it.
  expect(store.tries().filter((one) => one.provider === 'floor').map((one) => one.outcome)).toEqual(['needs-key', 'needs-key', 'needs-key'])
  store.close()
})

test('the daily test and a plugin on its own walk one model at a time, and never ask again', async () => {
  const clock = { hedgeAfter: 20, starWait: 1_000, retryStep: 10 }
  for (const who of [{ source: 'test' as const }, { plugin: 'somebody' }]) {
    const store = fresh([['busy3/a', 'busy-then-ok:3']])
    const screen = watching()
    const got = await send([model('busy3/a', alpha), model('ok/b', beta)], hello, store, secrets, { ...screen.hooks, ...clock, ...who })
    expect(got.model.id).toBe('ok/b')
    expect(asked.map((one) => one.model)).toEqual(['busy3/a', 'ok/b'])
    expect(screen.phases.map((one) => one.kind)).not.toContain('retrying')
    store.close()

    // A first model that hangs is waited out, not raced.
    const again = fresh([['hang/a', 'hang']])
    const started = Date.now()
    const answered = await send([model('hang/a', impatient), model('ok/b', beta)], hello, again, secrets, { ...clock, ...who })
    expect(answered.model.id).toBe('ok/b')
    expect((asked.find((one) => one.model === 'ok/b')?.at ?? 0) - started).toBeGreaterThanOrEqual(200)
    again.close()
  }
})

test('the line under the question follows the walk: asking, asking again, a backup, then writing', async () => {
  const store = fresh([
    ['busy8/a', 'busy-then-ok:8'],
    ['hang/b', 'hang'],
  ])
  const screen = watching()
  await send([model('busy8/a', alpha), model('hang/b', beta)], hello, store, secrets, {
    ...screen.hooks,
    hedgeAfter: 150,
    starWait: 5_000,
    retryStep: 10,
  })
  const firsts = ['asking', 'retrying', 'backup', 'writing'].map((kind) => screen.phases.findIndex((one) => one.kind === kind))
  expect(firsts.every((index) => index >= 0)).toBe(true)
  expect([...firsts].sort((a, b) => a - b)).toEqual(firsts)
  expect(screen.phases[0]).toEqual({ kind: 'asking', model: 'busy8/a' })
  expect(screen.phases).toContainEqual({ kind: 'backup', model: 'hang/b', behind: 'busy8/a', why: 'busy' })
  expect(screen.phases.filter((one) => one.kind === 'retrying').map((one) => (one.kind === 'retrying' ? one.attempt : 0))).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  expect(screen.phases.at(-1)).toEqual({ kind: 'writing', model: 'busy8/a' })
  // The backup lost, and a rung that lost is not a try.
  expect(store.tries().map((one) => one.model)).toEqual(['busy8/a'])
  store.close()
})

test('a model that thinks first is said to be thinking, then writing', async () => {
  const store = fresh([['think/a', 'reasoning']])
  const screen = watching()
  await send([model('think/a', alpha)], hello, store, secrets, screen.hooks)
  expect(screen.phases).toEqual([
    { kind: 'asking', model: 'think/a' },
    { kind: 'thinking', model: 'think/a' },
    { kind: 'writing', model: 'think/a' },
  ])
  store.close()
})

test('chat hears the first sign of each kind once, and a keep-alive is not one', async () => {
  behave = new Map([['think/a', 'reasoning']])
  const signs: Sign[] = []
  const got = await chat(alpha, { model: 'think/a', ...hello }, undefined, secrets, { onSign: (kind) => signs.push(kind) })
  expect(signs).toEqual(['reasoning', 'content'])
  expect(typeof got.waited).toBe('number')

  // Keep-alives for a quarter of a second, then given up on: not one sign.
  behave = new Map([['hang/a', 'hang']])
  const none: Sign[] = []
  await expect(chat(impatient, { model: 'hang/a', ...hello }, undefined, secrets, { onSign: (kind) => none.push(kind) })).rejects.toMatchObject({ trouble: 'kept' })
  expect(none).toEqual([])
})

test('a 429 says which it was: a host busy right now, or an allowance spent', async () => {
  const trouble = async (how: string): Promise<unknown> => {
    behave = new Map([['m', how]])
    return chat(alpha, { model: 'm', ...hello }, undefined, secrets).catch((error: unknown) => (error as ProviderError).trouble)
  }
  expect(await trouble('busy')).toBe('contended')
  expect(await trouble('quota-429')).toBe('quota')

  // After the status line, only the words can say it.
  const frame = (message: string): Server => {
    const alone = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ error: { code: 429, message } })}\n\n`)
    })
    return alone
  }
  for (const [message, kind] of [
    ['Rate limit exceeded: free-models-per-min.', 'quota'],
    ['Provider returned error', 'contended'],
  ] as const) {
    const alone = frame(message)
    await new Promise<void>((resolve) => alone.listen(0, '127.0.0.1', resolve))
    const where: Provider = { ...alpha, baseUrl: `http://127.0.0.1:${(alone.address() as AddressInfo).port}/v1` }
    const error = await chat(where, { model: 'm', ...hello }, undefined, secrets).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ status: 429, trouble: kind })
    alone.close()
  }
})

test('a sticky provider is told which conversation this is, as a stable id that says nothing, and nobody else is told', async () => {
  const store = fresh([])
  const idOf = (): unknown => asked.at(-1)?.body.session_id
  await send([model('s/a', sticky)], hello, store, secrets, { session: 1 })
  const first = idOf()
  await send([model('s/a', sticky)], hello, store, secrets, { session: 1 })
  const again = idOf()
  await send([model('s/a', sticky)], hello, store, secrets, { session: 2 })
  const other = idOf()

  expect(first).toMatch(/^[0-9a-f]{32}$/)
  expect(again).toBe(first)
  expect(other).not.toBe(first)
  // A salt of this machine's own, kept: without it the hash of *1* would be everybody's.
  expect(store.kvGet(CORE, 'session.salt')).toMatch(/^[0-9a-f]{32}$/)

  // Not to a provider that does not read it, and not when there is no conversation.
  await send([model('p/a', alpha)], hello, store, secrets, { session: 1 })
  expect(asked.at(-1)?.body).not.toHaveProperty('session_id')
  await send([model('s/a', sticky)], hello, store, secrets, {})
  expect(asked.at(-1)?.body).not.toHaveProperty('session_id')
  store.close()
})
