// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { chat, keyOf, ProviderError, type Provider } from '../src/provider.js'
import { CORE, memorySecrets } from '../src/secrets.js'

// A real HTTP server rather than a stubbed `fetch`: what is worth testing here is the
// streaming — frames arriving split at the wrong places, a tool call delivered in
// fragments — and a stub that hands over whole objects tests none of it.

let answer: { status: number; frames: string[] } = { status: 200, frames: [] }
let seen: { body: Record<string, unknown>; auth?: string } | undefined

const server: Server = createServer((request: IncomingMessage, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => (body += chunk.toString()))
  request.on('end', () => {
    seen = { body: JSON.parse(body) as Record<string, unknown>, auth: request.headers.authorization }
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
