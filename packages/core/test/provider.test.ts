// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { chat, keyOf, PROVIDERS, ProviderError, reaching, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'

// A real HTTP server rather than a stubbed `fetch`: what is worth testing here is the
// streaming — frames arriving split at the wrong places, a tool call delivered in
// fragments — and a stub that hands over whole objects tests none of it.

let answer: { status: number; frames: string[]; waitMs?: number } = { status: 200, frames: [] }
// `sent` is the header list itself, not only the value: a test about an *omitted* credential
// cannot be written against a string, because an absent header and an empty one both read
// back as falsy and the whole point is that they are two different requests.
let seen: { body: Record<string, unknown>; auth?: string; sent: string[]; path: string } | undefined

const server: Server = createServer((request: IncomingMessage, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => (body += chunk.toString()))
  request.on('end', () => {
    seen = {
      body: JSON.parse(body) as Record<string, unknown>,
      auth: request.headers.authorization,
      sent: Object.keys(request.headers),
      path: request.url ?? '',
    }
    const reply = (): void => {
      // The client may have given up while this was waiting, which is exactly what the tests
      // that ask it to wait are checking.
      if (response.destroyed) return
      if (answer.status !== 200) {
        response.writeHead(answer.status, { 'content-type': 'text/plain' })
        response.end('rate limited, try later')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Written as one string and cut at arbitrary points, which is what a socket does to it.
      const wire = answer.frames.map((f) => `data: ${f}\n\n`).join('')
      for (let at = 0; at < wire.length; at += 17) response.write(wire.slice(at, at + 17))
      response.end()
    }
    if (answer.waitMs === undefined) reply()
    else setTimeout(reply, answer.waitMs).unref()
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => void server.close())

const provider: Provider = {
  id: 'test',
  name: 'Test',
  baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
}

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(provider), 'sk-test-key')

test('a streamed answer arrives in pieces and comes back as one message', async () => {
  answer = {
    status: 200,
    frames: [
      JSON.stringify({ model: 'qwen/qwen3-8b:free', choices: [{ delta: { content: 'Six ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'groups.' } }] }),
      JSON.stringify({ usage: { prompt_tokens: 412, completion_tokens: 9 } }),
      '[DONE]',
    ],
  }

  const pieces: string[] = []
  const { message, usage } = await chat(
    provider,
    { model: 'qwen/qwen3-8b:free', messages: [{ role: 'user', content: 'sort my downloads' }] },
    (text) => pieces.push(text),
    secrets,
  )

  expect(pieces).toEqual(['Six ', 'groups.'])
  // The model recorded is the one the provider says answered, which is not always the one
  // that was asked for — and the history keeps what actually ran.
  expect(message).toEqual({ role: 'assistant', content: 'Six groups.', model: 'qwen/qwen3-8b:free' })
  expect(usage).toEqual({ in: 412, out: 9 })
  expect(seen?.auth).toBe('Bearer sk-test-key')
})

test('a tool call streamed in fragments is one call by the end', async () => {
  answer = {
    status: 200,
    frames: [
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fs.list', arguments: '{"pa' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"Down' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'loads"}' } }] } }] }),
      '[DONE]',
    ],
  }

  const { message } = await chat(
    provider,
    {
      model: 'm',
      messages: [
        { role: 'assistant', content: '', calls: [{ id: 'c0', name: 'fs.list', arguments: '{}' }] },
        { role: 'tool', content: '340 files', callId: 'c0' },
      ],
      tools: [{ name: 'fs.list', description: 'List a folder.' }],
    },
    undefined,
    secrets,
  )

  expect(message.calls).toEqual([{ id: 'c1', name: 'fs.list', arguments: '{"path":"Downloads"}' }])

  // And the history went out in the shape an OpenAI-compatible endpoint takes, without the
  // caller having to translate anything.
  expect(seen?.body.messages).toEqual([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'fs.list', arguments: '{}' } }],
    },
    { role: 'tool', content: '340 files', tool_call_id: 'c0' },
  ])
  expect(seen?.body.tools).toEqual([
    {
      type: 'function',
      function: {
        name: 'fs.list',
        description: 'List a folder.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ])
})

test('a provider saying no says which no it was', async () => {
  answer = { status: 429, frames: [] }
  const failed = chat(provider, { model: 'm', messages: [] }, undefined, secrets)
  // The router acts on the number: 429 is the next rung down, 401 is a key to fix.
  await expect(failed).rejects.toBeInstanceOf(ProviderError)
  await expect(failed).rejects.toMatchObject({ status: 429 })
  await expect(failed).rejects.toThrow(/rate limited/)
})

test('a provider with no key is not asked for one on the user behalf', async () => {
  const empty = memorySecrets()
  await expect(chat(provider, { model: 'm', messages: [] }, undefined, empty)).rejects.toMatchObject({
    status: 401,
  })
})

// The four behaviours the new fields buy. Each one is generic: no provider is named in the
// code under test, only in the comment explaining which one forced it to exist.

test('a provider that answers anonymously is sent no authorization header at all', async () => {
  answer = { status: 200, frames: ['[DONE]'] }
  const optional: Provider = { ...provider, id: 'optional-tier', auth: 'optional' }

  await chat(optional, { model: 'm', messages: [] }, undefined, memorySecrets())

  // Absent, not empty — which is why the test reads the header *list* and not its value. A
  // tier that would have answered anonymously reads a blank credential as a wrong one and
  // 403s, so sending nothing is strictly better than sending nothing-shaped.
  expect(seen?.sent).not.toContain('authorization')
  expect(seen?.auth).toBeUndefined()

  // And the same row uses a key the moment the user has one. That is the half a boolean
  // could not say.
  const theirs = memorySecrets()
  await theirs.set(CORE, keyOf(optional), 'sk-theirs')
  await chat(optional, { model: 'm', messages: [] }, undefined, theirs)
  expect(seen?.auth).toBe('Bearer sk-theirs')
})

test('a documented anonymous key stands in, and steps aside for the user own', async () => {
  answer = { status: 200, frames: ['[DONE]'] }
  // The literal lives in the row. An absence is not enough for a provider that publishes a
  // credential everyone is meant to share.
  const queue: Provider = { ...provider, id: 'anon-literal', auth: 'optional', anonymousKey: '0000000000' }

  await chat(queue, { model: 'm', messages: [] }, undefined, memorySecrets())
  expect(seen?.auth).toBe('Bearer 0000000000')

  const theirs = memorySecrets()
  await theirs.set(CORE, keyOf(queue), 'sk-mine')
  await chat(queue, { model: 'm', messages: [] }, undefined, theirs)
  expect(seen?.auth).toBe('Bearer sk-mine')
})

test('a provider that declares its own patience gives up at it, as a rung and not a failure', async () => {
  answer = { status: 200, frames: ['[DONE]'], waitMs: 2_000 }
  const slow: Provider = { ...provider, timeoutMs: 50 }

  const failed = chat(slow, { model: 'm', messages: [] }, undefined, secrets)
  // 504 on purpose: the cascade reads 429 and anything >= 500 as *try the next rung*. A
  // provider that did not answer inside its own declared patience has failed; the rung under
  // it has not, and the user should never learn the difference.
  await expect(failed).rejects.toBeInstanceOf(ProviderError)
  await expect(failed).rejects.toMatchObject({ status: 504 })
})

test('the stop button stops, rather than falling down the ladder', async () => {
  answer = { status: 200, frames: ['[DONE]'], waitMs: 2_000 }
  const slow: Provider = { ...provider, timeoutMs: 5_000 }
  const stop = new AbortController()

  const failed = chat(slow, { model: 'm', messages: [], signal: stop.signal }, undefined, secrets)
  stop.abort()

  // Somebody pressed stop. There is no next rung to try, because there is no longer a
  // question — so this must not arrive dressed as a provider having a moment.
  await expect(failed).rejects.toThrow()
  await expect(failed).rejects.not.toBeInstanceOf(ProviderError)
})

test('a provider that refuses tools has them stripped, for a model nothing has catalogued', async () => {
  answer = { status: 200, frames: ['[DONE]'] }
  const mouth: Provider = { ...provider, tools: false }

  await chat(
    mouth,
    {
      // Discovered live, seconds ago. No catalog entry exists for it, so no per-model
      // `supportsTools` flag exists either — the provider-wide answer is the only one there
      // is, and the backend behind it does not decline a `tools` field, it 500s on it.
      model: 'a-model-nobody-has-catalogued',
      messages: [],
      tools: [{ name: 'fs.list', description: 'List a folder.' }],
    },
    undefined,
    secrets,
  )

  expect(seen?.body.tools).toBeUndefined()
  expect(Object.keys(seen?.body ?? {})).not.toContain('tools')
})

// An account id in the address. One provider shape needs it, and it is a template rather than
// a branch: the alternative is a vendor's name written into the URL-building code, which is
// the one thing this table exists to avoid.

test('an account id in the address is filled from the key, and the token is what is sent', async () => {
  answer = { status: 200, frames: ['[DONE]'] }
  const port = (server.address() as AddressInfo).port
  const templated: Provider = {
    id: 'templated',
    name: 'Templated',
    baseUrl: `http://127.0.0.1:${String(port)}/accounts/{account}/v1`,
  }

  // Split once, on the first colon: an account id cannot contain one and a token may.
  expect(reaching(templated, 'acct-123:sk-secret:with-colons')).toEqual({
    baseUrl: `http://127.0.0.1:${String(port)}/accounts/acct-123/v1`,
    key: 'sk-secret:with-colons',
  })

  const store = memorySecrets()
  await store.set(CORE, keyOf(templated), 'acct-123:sk-secret')
  await chat(templated, { model: 'm', messages: [] }, undefined, store)

  // The id went into the path and never into the header; the token went into the header and
  // never into the path.
  expect(seen?.auth).toBe('Bearer sk-secret')
  expect(seen?.path).toBe('/accounts/acct-123/v1/chat/completions')
})

test('a key that is not two things joined by a colon says which two things', async () => {
  const templated: Provider = { id: 'templated', name: 'Templated', baseUrl: 'https://x/{account}/v1' }
  // Nothing at the far end will ever explain this one, because the request never arrives
  // anywhere real. So it is named here, in the words somebody needs to fix it.
  for (const wrong of ['sk-only-the-token', ':sk-token', 'acct-123:']) {
    expect(() => reaching(templated, wrong)).toThrow(/account_id:api_token/)
  }
  expect(() => reaching(templated, undefined)).toThrow(ProviderError)

  // And a row without the placeholder is untouched by any of it.
  const plain: Provider = { id: 'plain', name: 'Plain', baseUrl: 'https://y/v1' }
  expect(reaching(plain, 'sk-with:a-colon')).toEqual({ baseUrl: 'https://y/v1', key: 'sk-with:a-colon' })
  expect(reaching(plain, undefined)).toEqual({ baseUrl: 'https://y/v1' })
})

// The keyless floor, and the gotchas that are the expensive half of it. Every one of these
// cost somebody a live probe to find out; a row that forgets one fails quietly, in a way that
// looks like Alexia being broken rather than like a provider being particular.

const row = (id: string): Provider => PROVIDERS.find((p) => p.id === id)!

test('the keyless floor says what was discovered about each of its four providers', () => {
  // OVHcloud — better with a key and *worse with a wrong one*: a bad key 403s instead of
  // falling back to anonymous, so the header is omitted rather than blanked.
  expect(row('ovhcloud')).toMatchObject({ auth: 'optional', rpm: 2, verified: '2026-08-30' })
  expect(row('ovhcloud').anonymousKey).toBeUndefined()

  // AI Horde — a published literal rather than an absence, a queue that answers in minutes,
  // and workers that 500 on a `tools` field.
  expect(row('aihorde')).toMatchObject({
    anonymousKey: '0000000000',
    timeoutMs: 120_000,
    tools: false,
  })

  // UncloseAI — any non-empty string is accepted, and is used only to identify the caller.
  expect(row('uncloseai').anonymousKey).toBeTruthy()

  // Kilo — the list is not under the version prefix, and it is the one row in the table where
  // somebody has read the terms and the answer was bad.
  expect(row('kilo-gateway')).toMatchObject({ models: '/../models', trainsOnYourData: 'yes' })
  expect(String(new URL(row('kilo-gateway').baseUrl + row('kilo-gateway').models!))).toBe(
    'https://api.kilo.ai/api/gateway/models',
  )

  // And the one answer nobody may guess: unknown everywhere it has not actually been read.
  for (const id of ['ovhcloud', 'aihorde', 'uncloseai']) {
    expect(row(id).trainsOnYourData, id).toBe('unknown')
  }
})

test('what goes on the wire is a plain string, which is the shape the fussiest backend takes', async () => {
  answer = { status: 200, frames: ['[DONE]'] }
  await chat(
    provider,
    { model: 'm', messages: [{ role: 'user', content: 'sort my downloads' }] },
    undefined,
    secrets,
  )

  // One facade in this table 500s on a single-text-part content array and implements only the
  // plain form. Nothing here has to opt into that: `Message.content` is a string, so there is
  // no path that could produce the other shape — and this is the test that keeps it true.
  const [first] = seen?.body.messages as { content: unknown }[]
  expect(typeof first?.content).toBe('string')
})

// The seven with a published budget. Each of these gotchas cost a live probe; each one, got
// wrong, fails in a way that reads as Alexia being broken.

test('the paid-tier-adjacent rows carry what §6.6 discovered about each of them', () => {
  // LLM7 — settled by probe, not by picking a source. And no placeholder key: on this
  // provider a placeholder is read as a *wrong* key, which is worse than none.
  expect(row('llm7')).toMatchObject({ auth: 'optional', rpm: 20 })
  expect(row('llm7').anonymousKey).toBeUndefined()

  // Cloudflare — the account id is in the path, which is what the template is for.
  expect(row('cloudflare-ai').baseUrl).toContain('{account}')
  expect(row('cloudflare-ai')).toMatchObject({ timeoutMs: 60_000, rpd: 150 })

  // Ollama Cloud — not keyless, whatever an earlier extraction said, and its list is not
  // under the version prefix.
  expect(row('ollama-cloud')).toMatchObject({ auth: 'required', timeoutMs: 120_000 })
  expect(String(new URL(row('ollama-cloud').baseUrl + row('ollama-cloud').models!))).toBe(
    'https://ollama.com/api/tags',
  )

  // Z.ai — the OpenAI-compatible path, never the Anthropic one another catalogue uses.
  expect(row('zai').baseUrl).toBe('https://api.z.ai/api/paas/v4')
  expect(row('zai').baseUrl).not.toContain('anthropic')
  // And the console is named, so a key minted at the other one does not merely look bad.
  expect(row('zai').name).toContain('console')

  // Cohere — the compatibility path, and a budget counted in calls.
  expect(row('cohere').baseUrl).toContain('/compatibility/v1')
  expect(row('cohere').baseUrl).not.toContain('/v2')
  expect(row('cohere').callsPerMonth).toBe(1_000)

  // Nara — no list fetched, because most of the published one is credit-gated.
  expect(row('nara').models).toBeUndefined()

  // Kilo is in both tiers and appears once. The only difference the second tier makes to it
  // is that a key raises the ceiling, which `auth: optional` already says.
  expect(PROVIDERS.filter((p) => p.id === 'kilo-gateway')).toHaveLength(1)
})

test('every row records where it came from and when it was last checked', () => {
  // These endpoints die monthly. A copied table with no date on it goes stale in silence, and
  // the failure looks like a bug in Alexia rather than like a provider that moved.
  for (const provider of PROVIDERS) {
    expect(provider.verified, provider.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
  expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length)
})

// The clean-terms cluster. Two quirks, and both of them are a row value rather than a branch.

test('the clean-terms cluster carries its two quirks as row values', async () => {
  // Agnes reasons before it answers — 20 seconds to the first token on a one-word completion —
  // so the default patience would call a working provider dead.
  expect(row('agnes').timeoutMs).toBe(60_000)

  // Navy wants to know who is calling, and here that is a condition rather than a courtesy.
  expect(row('navy').headers).toMatchObject({ 'User-Agent': expect.stringContaining('Alexia') })

  // Five rows, all of them ToS-`ok`, all of them wanting a key.
  const cluster = ['aion', 'agnes', 'requesty', 'sealion', 'navy']
  for (const id of cluster) expect(row(id).auth, id).toBe('required')

  // And the header a row declares actually reaches the wire, which is the half a table
  // cannot prove about itself.
  answer = { status: 200, frames: ['[DONE]'] }
  const wants: Provider = { ...provider, headers: { 'User-Agent': 'Alexia (+test)' } }
  await chat(wants, { model: 'm', messages: [] }, undefined, secrets)
  expect(seen?.sent).toContain('user-agent')
})
