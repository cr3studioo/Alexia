// SPDX-License-Identifier: Apache-2.0
import { MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { plugin, readManifest } from '../src/index.js'

/** A plugin folder on disk, because that is the only thing the SDK reads. */
function folder(over: Partial<ManifestInput> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-sdk-'))
  const manifest: ManifestInput = {
    manifest_version: 1,
    id: 'hello',
    name: 'Hello',
    summary: 'Answers.',
    version: '0.1.0',
    license: 'Apache-2.0',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 2,
    mcp_protocol: MCP_PINNED,
    ...over,
  }
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  return dir
}

test('a plugin knows its own manifest without repeating it in code', () => {
  const p = plugin({ dir: folder() })
  expect(p.manifest.id).toBe('hello')
  expect(readManifest(folder({ id: 'other', name: 'Other' })).id).toBe('other')
})

test('a manifest that declares the newer MCP revision is refused at start, not at runtime', () => {
  // The alternative is worse than a crash: every alexia/* call dropped on the newer wire
  // era, with nothing in any log saying why. See wire-protocol.md §1.1 and D57.
  expect(() => plugin({ dir: folder({ mcp_protocol: '2026-07-28' }) })).toThrow(/2026-07-28/)
})

test('an invalid manifest fails here rather than halfway through a call', () => {
  expect(() => plugin({ dir: folder({ id: 'Not Valid' }) })).toThrow()
})

/**
 * **Core gone is the plugin gone.** A plugin that has work of its own — a timer, an open poll
 * — used to keep running after core quit, because MCP's stdio transport listens for data and
 * never for the end of it. Telegram lived on for most of a minute that way, still collecting
 * messages, and a quick relaunch had two of it polling one bot.
 *
 * A real process over a real pipe, because the thing being checked is what the operating
 * system does when the other end of that pipe goes away.
 */
test('a plugin exits when core closes its end of the pipe, even with work of its own', async () => {
  const dir = folder()
  const sdk = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'src', 'index.js')).href
  writeFileSync(
    join(dir, 'index.mjs'),
    [
      `import { plugin } from ${JSON.stringify(sdk)}`,
      `const alexia = plugin({ dir: ${JSON.stringify(dir)} })`,
      // What kept Telegram alive: something scheduled that is not the pipe.
      `setInterval(() => {}, 1000)`,
      `await alexia.start()`,
      `process.stderr.write('started\\n')`,
    ].join('\n'),
  )
  const child = spawn(process.execPath, [join(dir, 'index.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    let said = ''
    child.stderr.on('data', (chunk: Buffer) => {
      said += String(chunk)
      if (said.includes('started')) resolve()
    })
    child.on('exit', () => reject(new Error(`the plugin never started: ${said}`)))
  })

  const closed = Date.now()
  child.stdin.end()
  const late = setTimeout(() => child.kill('SIGKILL'), 5000)
  const code = await exited
  clearTimeout(late)
  expect(code, 'still running five seconds after core went').toBe(0)
  expect(Date.now() - closed).toBeLessThan(5000)
})
