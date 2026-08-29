// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { Env } from '../src/d1.js'
import { handle } from '../src/index.js'
import { sqliteD1 } from './sqlite-d1.js'

// M3-1. The registry is a list with a revoke button, so what is tested is the list, the
// button, and the fact that nobody but the token holder can press either.

const TOKEN = 'a-long-enough-admin-token'
const env = (): Env => ({ DB: sqliteD1(), ADMIN_TOKEN: TOKEN })

const at = (path: string, init?: RequestInit): Request =>
  new Request(`https://registry.example${path}`, init)

const post = (path: string, body: unknown, token = TOKEN): Request =>
  at(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const ENTRY = {
  id: 'weather',
  name: 'Weather',
  summary: 'Tells you whether to take a coat.',
  version: '0.1.0',
  license: 'Apache-2.0',
  url: 'https://example.invalid/weather-0.1.0.tgz',
  sha256: 'a'.repeat(64),
  alexia_protocol: 1,
  mcp_protocol: '2025-11-25',
  requires: [{ cap: 'net.request', why: 'to ask a forecast service' }],
  provides: ['weather.forecast'],
}

test('submit, list, read one', async () => {
  const e = env()
  expect((await handle(post('/v0/admin/plugins', ENTRY), e)).status).toBe(200)

  const list = (await (await handle(at('/v0/plugins'), e)).json()) as { plugins: (typeof ENTRY)[] }
  expect(list.plugins).toHaveLength(1)
  // The JSON columns come back as arrays, not as the text they are stored as — the client
  // draws the consent walkthrough from `requires` before anything is downloaded.
  expect(list.plugins[0]?.requires).toEqual([{ cap: 'net.request', why: 'to ask a forecast service' }])
  expect(list.plugins[0]?.provides).toEqual(['weather.forecast'])

  const one = await handle(at('/v0/plugins/weather'), e)
  expect(one.status).toBe(200)
  expect(((await one.json()) as { sha256: string }).sha256).toBe('a'.repeat(64))
})

test('revoke: gone now, with the reason, and off the list', async () => {
  const e = env()
  await handle(post('/v0/admin/plugins', ENTRY), e)
  await handle(post('/v0/admin/plugins/weather/revoke', { reason: 'it read the whole home directory' }), e)

  const one = await handle(at('/v0/plugins/weather'), e)
  // 410 and not 404. It existed, it is gone on purpose, and the reason is the whole point.
  expect(one.status).toBe(410)
  expect(await one.json()).toMatchObject({ reason: 'it read the whole home directory' })
  expect(one.headers.get('cache-control')).toBe('no-store')

  const list = (await (await handle(at('/v0/plugins'), e)).json()) as { plugins: unknown[] }
  expect(list.plugins).toEqual([])

  // And the half that reaches somebody who already installed it.
  const pulled = await handle(at('/v0/revoked'), e)
  expect(pulled.headers.get('cache-control')).toBe('no-store')
  expect((await pulled.json()) as { plugins: { id: string }[] }).toMatchObject({
    plugins: [{ id: 'weather', revoked_reason: 'it read the whole home directory' }],
  })
})

test('publishing again un-revokes, so a pulled id is not dead forever', async () => {
  const e = env()
  await handle(post('/v0/admin/plugins', ENTRY), e)
  await handle(post('/v0/admin/plugins/weather/revoke', { reason: 'bad' }), e)
  await handle(post('/v0/admin/plugins', { ...ENTRY, version: '0.1.1' }), e)

  const one = await handle(at('/v0/plugins/weather'), e)
  expect(one.status).toBe(200)
  expect(((await one.json()) as { version: string }).version).toBe('0.1.1')
})

test('nobody writes without the token, and a registry with no token configured writes nothing', async () => {
  const e = env()
  expect((await handle(post('/v0/admin/plugins', ENTRY, 'wrong'), e)).status).toBe(401)
  expect((await handle(at('/v0/admin/plugins', { method: 'POST', body: '{}' }), e)).status).toBe(401)

  const unconfigured: Env = { DB: sqliteD1() }
  expect((await handle(post('/v0/admin/plugins', ENTRY), unconfigured)).status).toBe(401)
})

test('a submission is held to the shape a client has to trust', async () => {
  const e = env()
  const refuses = async (patch: Record<string, unknown>): Promise<string> => {
    const response = await handle(post('/v0/admin/plugins', { ...ENTRY, ...patch }), e)
    expect(response.status).toBe(400)
    return ((await response.json()) as { error: string }).error
  }
  expect(await refuses({ id: 'Weather' })).toMatch(/lowercase/)
  expect(await refuses({ version: 'latest' })).toMatch(/semantic/)
  expect(await refuses({ sha256: 'short' })).toMatch(/64 hex/)
  // http, not https. The bytes are fetched from wherever this points.
  expect(await refuses({ url: 'http://example.invalid/x.tgz' })).toMatch(/https/)
})

test('skills are a separate list, and revoke the same way', async () => {
  const e = env()
  const skill = {
    id: 'sorting-downloads',
    name: 'sorting-downloads',
    description: 'How to tidy a downloads folder without losing anything.',
    url: 'https://example.invalid/sorting-downloads.tgz',
    sha256: 'b'.repeat(64),
  }
  expect((await handle(post('/v0/admin/skills', skill), e)).status).toBe(200)
  expect(((await (await handle(at('/v0/skills'), e)).json()) as { skills: unknown[] }).skills).toHaveLength(1)

  await handle(post('/v0/admin/skills/sorting-downloads/revoke', { reason: 'it advised rm -rf' }), e)
  expect(((await (await handle(at('/v0/skills'), e)).json()) as { skills: unknown[] }).skills).toEqual([])
})

// The registry can also be a folder of static files (`scripts/publish.mjs`), where
// `/v0/plugins` cannot be both the list and the directory holding each entry. The client
// therefore asks for `.json`, and this Worker has to answer that spelling too — otherwise
// pointing Alexia at a deployed registry instead of a static one would 404 on every path.
test('the .json spelling reaches the same routes', async () => {
  const e = env()
  expect((await handle(post('/v0/admin/plugins', ENTRY), e)).status).toBe(200)

  const list = (await (await handle(at('/v0/plugins.json'), e)).json()) as { plugins: (typeof ENTRY)[] }
  expect(list.plugins).toHaveLength(1)

  const one = (await (await handle(at('/v0/plugins/weather.json'), e)).json()) as typeof ENTRY
  expect(one.id).toBe('weather')

  expect((await handle(at('/v0/skills.json'), e)).status).toBe(200)
  expect((await handle(at('/v0/revoked.json'), e)).status).toBe(200)

  // And a revoked plugin still answers 410 through the new spelling, because that is the
  // response `Library.entry` reads a withdrawal reason out of.
  expect((await handle(post('/v0/admin/plugins/weather/revoke', { reason: 'withdrawn' }), e)).status).toBe(200)
  expect((await handle(at('/v0/plugins/weather.json'), e)).status).toBe(410)
})
