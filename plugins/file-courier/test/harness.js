// SPDX-License-Identifier: AGPL-3.0-only
// These tests run under `node --test` and under the repo's vitest alike: one `test`, and node's own assert.
const runner = process.env.VITEST ? await import('vitest') : await import('node:test')
export const test = runner.test
export { default as assert } from 'node:assert/strict'
