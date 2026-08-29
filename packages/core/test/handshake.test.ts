// SPDX-License-Identifier: AGPL-3.0-only
import { MCP_PINNED, MCP_REVISIONS } from '@alexia/protocol'
import { expect, test } from 'vitest'
import { negotiate } from '../src/handshake.js'

const voice = { name: 'Voice', alexia_protocol: 2, mcp_protocol: MCP_PINNED }

test('both sides on the pin: the newest shared revision wins', () => {
  expect(negotiate(voice, [...MCP_REVISIONS])).toEqual({ ok: true, mcp: MCP_PINNED })
})

test('the newer revision loads too — it just has no alexia/* layer', () => {
  const newer = MCP_REVISIONS[1]
  expect(negotiate({ ...voice, mcp_protocol: newer }, [newer])).toEqual({ ok: true, mcp: newer })
})

test('a plugin that speaks both gets the revision it can call core back on', () => {
  expect(negotiate(voice, [...MCP_REVISIONS])).toEqual({ ok: true, mcp: MCP_PINNED })
})

test('a manifest that claimed a revision the process does not serve is refused', () => {
  // The manifest is a claim about a process that did not exist yet. If it turns out to be
  // wrong here, nothing else it said can be trusted either.
  const v = negotiate({ ...voice, mcp_protocol: '2026-07-28' }, [MCP_PINNED])
  expect(v.ok).toBe(false)
})

test('the manifest check runs first, so a plugin from the future never gets a process', () => {
  const v = negotiate({ ...voice, alexia_protocol: 99 }, [...MCP_REVISIONS])
  expect(v.ok === false && v.reason).toContain('Voice needs a newer Alexia')
})

test('no overlap is refused in the words the spec fixes, naming both sides', () => {
  // The manifest said the right thing and the process said another: still a refusal, and
  // the sentence names what the plugin actually offered, not what it claimed on disk.
  const v = negotiate(voice, ['2024-11-05'])
  expect(v.ok).toBe(false)
  expect(v.ok === false && v.reason).toBe(
    "Voice speaks a version of MCP that Alexia doesn't.\n" +
      'Alexia speaks 2025-11-25 and 2026-07-28; Voice speaks 2024-11-05.',
  )
})
