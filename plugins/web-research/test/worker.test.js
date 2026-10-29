// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
const python = ['python3', 'python'].find((command) => spawnSync(command, ['--version']).status === 0)
test.skipIf(!python)('worker retrieval, network isolation, caching and deadlines (offline fixtures)', () => {
  const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_worker.py'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 25_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  expect(run.stderr + run.stdout).toContain('OK')
  expect(run.status, run.stderr).toBe(0)
})
