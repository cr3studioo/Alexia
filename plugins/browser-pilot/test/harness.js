// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One `test` for both runners: `node --test plugins/browser-pilot/test` (the task's gate) and
 * `pnpm test`, whose vitest project also picks these files up. Assertions are `node:assert`, which
 * both runners accept.
 */
export const { test } = process.env.VITEST ? await import('vitest') : await import('node:test')
export { default as assert } from 'node:assert/strict'
