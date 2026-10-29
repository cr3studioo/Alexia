// SPDX-License-Identifier: AGPL-3.0-only
/** Native installer smoke test. Downloads into a disposable directory; makes no model calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setup, run } from '../plugins/web-research/setup.js'
import { WorkerClient } from '../plugins/web-research/client.js'
import { bundlePlugin } from './bundle-plugin.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const native = `${process.platform}-${process.arch}`
if (process.env.RESEARCH_EXPECT_PLATFORM) assert.equal(native, process.env.RESEARCH_EXPECT_PLATFORM)
const temporary = await mkdtemp(join(tmpdir(), 'alexia-research-'))
const own = join(temporary, "Research user's data café")
const bundled = join(temporary, 'installed plugin')
const report = { platform: native, node: process.version, passed: false, timings: {} }
let worker
try {
  await mkdir(own, { recursive: true })
  await bundlePlugin(root, 'web-research', bundled)
  let lastProgress = 0
  const started = performance.now()
  const runtime = await setup(own, bundled, {
    signal: AbortSignal.timeout(10 * 60_000),
    progress: (message) => {
      if (performance.now() - lastProgress < 2000) return
      lastProgress = performance.now()
      console.log(message)
    },
  })
  report.timings.coldSetupMs = Math.round(performance.now() - started)
  const warmStarted = performance.now()
  const warm = await setup(own, bundled, { progress: () => assert.fail('Warm setup unexpectedly reinstalled the runtime') })
  assert.equal(warm.python, runtime.python)
  report.timings.warmSetupMs = Math.round(performance.now() - warmStarted)

  const workerStarted = performance.now()
  worker = new WorkerClient(runtime, bundled, own)
  let deadline
  try {
    await Promise.race([
      worker.ready,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Worker did not become ready in 60 seconds')), 60_000) }),
    ])
  } finally { clearTimeout(deadline) }
  report.timings.workerReadyMs = Math.round(performance.now() - workerStarted)

  // Exercise installed native wheels and the downloaded browser without public search or a model.
  await run(runtime.python, ['-c', `
import asyncio, json, platform, sys
from pathlib import Path
import ddgs
import trafilatura
from scrapling.fetchers import AsyncFetcher
from playwright.async_api import async_playwright
assert sys.version_info[:3] == (3, 12, 12), sys.version
async def check():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content('<html><body><article><h1>Research café</h1><p>Native runtime smoke test verifies extraction and isolated browser capture.</p></article></body></html>')
            assert await page.locator('h1').inner_text() == 'Research café'
            assert 'Native runtime smoke test' in trafilatura.extract(await page.content())
            await page.screenshot(path=str(Path(sys.argv[1]) / 'native-smoke.png'))
        finally:
            await browser.close()
asyncio.run(check())
print(json.dumps({'python': platform.python_version(), 'architecture': platform.machine(), 'browser': 'passed', 'extraction': 'passed'}))
`, own], {
    env: { ...runtime.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    signal: AbortSignal.timeout(60_000),
    progress: (message) => console.log(message),
  })
  report.passed = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  if (worker && worker.child.exitCode === null) {
    const exited = once(worker.child, 'exit', { signal: AbortSignal.timeout(10_000) })
    worker.stop()
    try { await exited } catch (error) {
      worker.child.kill('SIGKILL')
      report.passed = false
      report.cleanupError = `Worker shutdown failed: ${error.message}`
      process.exitCode = 1
    }
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.RESEARCH_SMOKE_REPORT) await writeFile(process.env.RESEARCH_SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n')
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
