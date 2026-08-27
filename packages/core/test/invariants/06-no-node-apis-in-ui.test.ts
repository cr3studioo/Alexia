import { expect, test } from 'vitest'
import { scan } from './_repo.js'

// Defends: the Tauri port stays a port. Everything packages/ui touches has to exist
// inside a webview, so a Node builtin in there is a rewrite scheduled for M5.

const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]

const IMPORTS_A_BUILTIN = new RegExp(
  String.raw`(?:from|import|require\()\s*['"](?:node:\w+|(?:${NODE_BUILTINS.join('|')}))(?:/[\w/]+)?['"]`,
)

test('no-node-apis-in-ui: packages/ui imports no Node builtin', () => {
  const found = scan(['packages/ui/src/**/*.ts', 'packages/ui/src/**/*.tsx'], IMPORTS_A_BUILTIN)
  expect(found, `packages/ui must run in a webview:\n${found.join('\n')}`).toEqual([])
})

test('no-node-apis-in-ui: the check itself catches a builtin', () => {
  // A check that has never seen a violation is a comment. These are the violations.
  expect(`import { readFileSync } from 'node:fs'`).toMatch(IMPORTS_A_BUILTIN)
  expect(`import { readFile } from 'node:fs/promises'`).toMatch(IMPORTS_A_BUILTIN)
  expect(`const os = require('os')`).toMatch(IMPORTS_A_BUILTIN)
  expect(`import { join } from 'path'`).toMatch(IMPORTS_A_BUILTIN)

  expect(`import { useState } from 'react'`).not.toMatch(IMPORTS_A_BUILTIN)
  expect(`import { join } from 'pathe'`).not.toMatch(IMPORTS_A_BUILTIN)
  expect(`import { render } from './paths.js'`).not.toMatch(IMPORTS_A_BUILTIN)
})
