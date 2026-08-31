// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import type { Model } from '../src/catalog.js'
import { keyOf, type Provider } from '../src/provider.js'
import { redact, redactText, summarise } from '../src/redact.js'
import { send, type Choice } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { files, shippedSource } from './invariants/_repo.js'

/**
 * M7-1. The half that matters is the last two tests: **there is one door out of this repo
 * and it redacts.** Everything above them is the patterns, written down twice — once as a
 * table and once as the behaviour somebody would notice breaking.
 *
 * Not an eleventh invariant, for the reason M6-1 gave (D82): the ten are about the plugin
 * contract and what survives a folder being deleted. This is a property of core's own
 * dispatch, so it sits in the unit project and joins `pnpm check` on its own merits.
 */

// ---- exclusions 1 and 2 -------------------------------------------------------------------

test('a credential goes and the sentence around it stays', () => {
  // The value goes; the variable's *name* stays, because the first rule to match a
  // recognisable key eats the value and leaves it. That is deliberate rather than tolerated:
  // `OPENROUTER_API_KEY` is not a credential, it is which provider he uses, and exclusion 3
  // allows that.
  const said = redactText('put OPENROUTER_API_KEY=sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e in .env and restart')
  expect(said.text).toBe('put OPENROUTER_API_KEY=[redacted] in .env and restart')
  expect(said.kinds).toEqual(['api key'])

  // Nothing recognisable in the value, so the whole assignment goes — and the prefixed env
  // var is the shape a word boundary silently missed for a month, because `_` is a word
  // character and there is no boundary inside `DEPLOY_PASSWORD`.
  const bare = redactText('DEPLOY_PASSWORD=correcthorsebattery')
  expect(bare.text).toBe('[redacted]')
  expect(bare.kinds).toEqual(['env assignment'])

  // The same bug from the other end, found by M7-3's test rather than by this one: the
  // keyword is in the *middle*, and a pattern demanding `=` right after it sees nothing.
  expect(redactText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY').text).toBe('[redacted]')
  expect(redactText('set GITHUB_TOKEN_FOR_CI = abcdefghijklmnop').text).toBe('set [redacted]')

  for (const shape of [
    'sk-ant-api03-Zm9vYmFyYmF6cXV4Y29ycmdl',
    'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghijkl',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g',
    '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    expect(redactText(`here it is: ${shape}`).text, shape).toBe('here it is: [redacted]')
  }
})

test('where he is goes, and the city he lives in does not', () => {
  expect(redactText('meet me at 12 Baker Street at six').text).toBe('meet me at [redacted] at six')
  expect(redactText('the shift is at Hauptstraße 12 from 17:00').text).toBe('the shift is at [redacted] from 17:00')
  expect(redactText('it is on ulice Dlouhá 5 upstairs').text).toBe('it is on [redacted] upstairs')
  expect(redactText('pin is 50.0755, 14.4378 exactly').text).toBe('pin is [redacted] exactly')
  expect(redactText('Praha 110 00 is the office').text).toBe('[redacted] is the office')

  // A venue name carries no street number and survives every pattern above. The key stays
  // so the model can still see there was a place; the value is what says which one.
  expect(redactText('{"summary":"shift","location":"Café Slavia"}').text).toBe(
    '{"summary":"shift","location":"[redacted]"}',
  )

  // Exclusion 3, and the whole reason the quote is in redact.ts. Broadening this is the
  // failure mode, so it gets a test rather than a comment.
  for (const kept of [
    'I live in Prague and study at CTU FEL',
    'he is relocating to Prague in September',
    'he never finishes anything he starts on a Friday',
    'the plugin registry is at 3 in the morning again',
  ]) {
    expect(redactText(kept).text, kept).toBe(kept)
  }
})

test('a tool call argument is a payload too', () => {
  const { messages, kinds } = redact([
    { role: 'user', content: 'book it' },
    {
      role: 'assistant',
      content: '',
      calls: [{ id: '1', name: 'maps.route', arguments: '{"to":"12 Baker Street","key":"sk-or-v1-abcdefghijklmnop"}' }],
    },
  ])
  expect(messages[1]?.calls?.[0]?.arguments).toBe('{"to":"[redacted]","key":"[redacted]"}')
  expect(summarise(kinds)).toBe('api key×1, street×1')
})

// ---- and the half that actually sends -----------------------------------------------------

const sentBodies: { model: string; messages: { content: string }[] }[] = []
const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    sentBodies.push(JSON.parse(raw) as (typeof sentBodies)[number])
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`)
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const store = new Store(':memory:')
afterAll(() => {
  server.close()
  store.close()
})

const provider: Provider = {
  id: 'somewhere',
  name: 'Somewhere',
  baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`,
}
const model = (tier: Model['tier']): Model => ({
  id: `m/${tier}`,
  name: `Model ${tier}`,
  provider: provider.id,
  tier,
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: false,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
})

/** One payload carrying all three, in one sentence, so it is obvious what survived. */
const PAYLOAD =
  'set OPENROUTER_API_KEY=sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e then meet me at 12 Baker Street, ' +
  'and remember I always run late.'

async function through(tier: Model['tier']): Promise<{ arrived: string; notes: string[] }> {
  const secrets = memorySecrets()
  await secrets.set(CORE, keyOf(provider), 'sk-test')
  const notes: string[] = []
  sentBodies.length = 0
  const choice: Choice = { model: model(tier), provider }
  // A bound on the reply: this walks the paid tiers too, and `send` will not bill without one.
  await send([choice], { messages: [{ role: 'user', content: PAYLOAD }], maxTokens: 200 }, store, secrets, {
    onNote: (line) => notes.push(line),
  })
  return { arrived: sentBodies[0]?.messages[0]?.content ?? '', notes }
}

test('none of the three reach a third party, and the sentence around them does', async () => {
  const { arrived, notes } = await through('T1')

  expect(arrived).not.toContain('sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e')
  expect(arrived).not.toContain('12 Baker Street')
  // Exclusion 3 arrives whole. If this line ever goes red, read redact.ts before "fixing" it.
  expect(arrived).toContain('and remember I always run late.')

  // It says what it did, and never what it took.
  expect(notes).toEqual(['Stripped before sending to Model T1: api key×1, street×1.'])
  expect(notes[0]).not.toContain('Baker')
})

test('a model on this machine gets the payload whole', async () => {
  const { arrived, notes } = await through('T0')
  expect(arrived).toBe(PAYLOAD)
  expect(notes).toEqual([])
})

// ---- the check that keeps it ---------------------------------------------------------------

test('there is no redaction-free path to a third-party provider', async () => {
  // Every tier that is not this machine, driven for real. A future `T4`, or a tier quietly
  // exempted, fails here rather than in somebody's training corpus.
  for (const tier of ['T1', 'T2', 'T3'] as const) {
    const { arrived } = await through(tier)
    expect(arrived, tier).not.toContain('sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e')
    expect(arrived, tier).not.toContain('12 Baker Street')
  }
})

test('and there is only one door for it to guard', () => {
  // The behavioural test above proves `send` redacts. This proves `send` is the only way
  // out: a second module calling `chat()` would be a second door, and this one is shut.
  const callers = files(shippedSource)
    .filter((f) => /^import .*\bchat\b.*from '.*provider\.js'/m.test(f.text))
    .map((f) => f.path)
  expect(callers, 'route everything through send() in router.ts, which redacts first').toEqual([
    'packages/core/src/router.ts',
  ])

  // The glob matching nothing would pass silently, forever, and look exactly like this.
  expect(files(shippedSource).map((f) => f.path)).toContain('packages/core/src/router.ts')
})
