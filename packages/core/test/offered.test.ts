// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { mimeOf, Offers, openable } from '../src/offered.js'
import { serve, type Serving } from '../src/serve.js'
import { memorySecrets } from '../src/secrets.js'
import { outcomeOf } from '../src/tooling.js'
import { noPolling } from './staged.js'

/**
 * **A file a tool made, on its way back to the person who asked for it.**
 *
 * The upload half has `attach.ts` and this is the mirror. What it has to get right is
 * narrower than it looks, and it is all in one sentence: **no route ever accepts a path.**
 * The shell is handed an opaque id and can ask for exactly the files some tool offered during
 * this run of core, so there is no traversal to defend against — not because the input is
 * validated, but because the input is a map key and is never joined to anything.
 *
 * The tests below are the three seams: what core reads out of an MCP result, what the
 * registry will and will not name, and what the route does with an id nobody gave it.
 */

const files = mkdtempSync(join(tmpdir(), 'alexia-offered-'))
const wrote = (name: string, content = 'hello'): string => {
  const path = join(files, name)
  writeFileSync(path, content)
  return path
}

/** MCP's own block. `name` is required by the spec, so it is required here too. */
const linkTo = (path: string, extra: Record<string, unknown> = {}) => ({
  type: 'resource_link' as const,
  uri: pathToFileURL(path).href,
  name: basename(path),
  ...extra,
})

test('a resource_link becomes a file the shell can have and a name the model can read', () => {
  const path = wrote('report.pdf', 'not really a pdf')
  const outcome = outcomeOf({
    content: [{ type: 'text', text: 'Made it.' }, linkTo(path, { mimeType: 'application/pdf' })],
  })

  // What the model gets. `Message.content` is a string, so the bytes were never going to
  // reach it — a name it can refer to is the whole of what is useful there.
  expect(outcome.text).toBe('Made it.\n[file: report.pdf]')
  expect(outcome.files).toHaveLength(1)
  expect(outcome.files?.[0]).toMatchObject({ name: 'report.pdf', path, mime: 'application/pdf', bytes: 16 })
})

test('a file the tool named but did not write is said out loud, and not offered', () => {
  // The failure worth designing for: a tool that reports success and wrote nothing. Offering
  // a row with a Save button behind it would put the discovery at the moment of the press,
  // which is the worst place for it.
  const outcome = outcomeOf({ content: [linkTo(join(files, 'never-written.pdf'))] })
  expect(outcome.files).toBeUndefined()
  expect(outcome.text).toContain('not written')
})

test('a link to somewhere that is not this machine is left as text', () => {
  // `resource_link` can point at anything with a URI. What this feature is for is the case
  // that had no answer at all — a file, on this disk — and an https address is a link, which
  // the answer text already carries.
  const outcome = outcomeOf({
    content: [{ type: 'text', text: 'See https://example.com/x.pdf' }, { type: 'resource_link', uri: 'https://example.com/x.pdf', name: 'x.pdf' }],
  })
  expect(outcome.files).toBeUndefined()
})

test('a tool that returned only text is exactly what it was before any of this', () => {
  // The regression that would matter most, because it is every other tool in the repo.
  const outcome = outcomeOf({ content: [{ type: 'text', text: 'Done.' }] })
  expect(outcome).toEqual({ ok: true, text: 'Done.' })
  expect('files' in outcome).toBe(false)
})

test('a folder offered as a file is not a file', () => {
  const dir = join(files, 'a-folder')
  mkdirSync(dir, { recursive: true })
  expect(outcomeOf({ content: [linkTo(dir)] }).files).toBeUndefined()
})

test('a block with no name at all is still given one', () => {
  // Off-spec input on purpose — MCP requires `name`, which is why this needs a cast to
  // express. A plugin that omits it is a plugin with a bug, and core's answer is the file's
  // own name rather than a row labelled `undefined`.
  const path = wrote('unnamed.txt')
  const outcome = outcomeOf({
    content: [{ type: 'resource_link', uri: pathToFileURL(path).href } as unknown as { type: 'text'; text: string }],
  })
  expect(outcome.files?.[0]?.name).toBe('unnamed.txt')
})

test('the registry names a file only by an id it made up', () => {
  const offers = new Offers()
  const path = wrote('kept.txt')
  const [one] = offers.keep([{ name: 'kept.txt', path, bytes: 5, mime: 'text/plain' }])

  expect(offers.get(one!.id)?.path).toBe(path)
  // The id is not derived from anything. A path-derived id would leak the path to whatever
  // saw a URL, for no gain at all.
  expect(one!.id).not.toContain('kept')
  expect(one!.id).toMatch(/^[0-9a-f]{32}$/)

  // And the whole of the defence: the only string that resolves to a file is one this made.
  for (const wrong of [path, '../../../etc/passwd', '', 'undefined', 42, null, undefined]) {
    expect(offers.get(wrong)).toBeUndefined()
  }
})

test('two files with the same name are two files', () => {
  const offers = new Offers()
  const kept = offers.keep([
    { name: 'chart.png', path: wrote('chart-1.png'), bytes: 5, mime: 'image/png' },
    { name: 'chart.png', path: wrote('chart-2.png'), bytes: 5, mime: 'image/png' },
  ])
  expect(kept[0]!.id).not.toBe(kept[1]!.id)
  expect(offers.get(kept[0]!.id)?.path).not.toBe(offers.get(kept[1]!.id)?.path)
})

test('what Open will and will not hand to the operating system', () => {
  for (const name of ['report.pdf', 'chart.png', 'notes.md', 'book.epub', 'data.csv', 'archive.zip']) {
    expect(openable(name), name).toBe(true)
  }
  // The escalation this stops: a plugin with no `proc.spawn` writes one of these, offers it,
  // and a person's press on a button labelled Open is what runs it.
  for (const name of ['invoice.pdf.bat', 'setup.exe', 'run.ps1', 'thing.cmd', 'go.sh', 'x.vbs', 'a.lnk', 'b.msi', 'c.js']) {
    expect(openable(name), name).toBe(false)
  }
})

test('the type is the one a browser needs, and the fallback is honest', () => {
  expect(mimeOf('a.png')).toBe('image/png')
  expect(mimeOf('a.PDF')).toBe('application/pdf')
  expect(mimeOf('a.wat')).toBe('application/octet-stream')
  expect(mimeOf('noextension')).toBe('application/octet-stream')
})

// ---- and over the wire, because a rule that only holds in a unit test holds nowhere -------

const root = mkdtempSync(join(tmpdir(), 'alexia-offered-core-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  secrets: memorySecrets(),
})

afterAll(() => {
  alexia.close()
  rmSync(files, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('an id nothing offered is a 404, whatever it is a path to', async () => {
  // Every one of these is a real file or a real traversal attempt, and none of them is a key
  // in the map. There is no check here that could be got wrong, which is the point.
  for (const id of [wrote('secret.txt'), '../../../../etc/passwd', 'C:\\Windows\\System32\\config\\SAM', 'x']) {
    const answered = await fetch(new URL(`/api/file?id=${encodeURIComponent(id)}`, alexia.url), {
      headers: { 'x-alexia-token': alexia.token },
    })
    expect(answered.status, id).toBe(404)
  }
})

test('the route needs the session token like every other one', async () => {
  expect((await fetch(new URL('/api/file?id=x', alexia.url))).status).toBe(403)
})

test('opening is refused without the confirm the wire contract asks for', async () => {
  // `guard.ts` classifies open as `confirm`, so it is refused before the handler runs — and
  // therefore before anything could be spawned. That ordering is the reason this is safe to
  // assert against a real server.
  const answered = await fetch(new URL('/api/file', alexia.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
    body: JSON.stringify({ id: 'anything', action: 'open' }),
  })
  expect(answered.status).toBe(409)
  expect(((await answered.json()) as { said: string }).said).toContain('registered for it')
})
