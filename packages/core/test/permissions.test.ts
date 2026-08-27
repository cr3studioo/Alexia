// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  boundaryAck,
  heard,
  lifts,
  neverTouch,
  rootsOf,
  rule,
  within,
  type Ask,
  type Scope,
} from '../src/permissions.js'

// The three layers, in the order they are checked, and the one that has no appeal.

const dataDir = join(homedir(), 'AppData', 'Local', 'Alexia')
const work = join(homedir(), 'work')

const scope = (over: Partial<Scope> = {}): Scope => ({
  mode: 'risky',
  roots: [work],
  dataDir,
  ...over,
})

const reading: Ask = { tool: 'notes__read', annotations: { readOnlyHint: true }, paths: [join(work, 'a.txt')] }
const writing: Ask = { tool: 'notes__write', annotations: { destructiveHint: true }, paths: [join(work, 'a.txt')] }

test('read-only runs in the default mode; anything else waits', () => {
  expect(rule(reading, scope())).toEqual({ verdict: 'run' })

  const asked = rule(writing, scope())
  expect(asked.verdict).toBe('ask')
  expect(asked.verdict === 'ask' && asked.why).toContain('changes or deletes')
})

test('each mode does what its own sentence says', () => {
  // Ask me every time: every call waits, including a read.
  expect(rule(reading, scope({ mode: 'every-time' })).verdict).toBe('ask')

  // Watch and warn: it runs, and the checker is the thing that stops it (M15-4).
  expect(rule(writing, scope({ mode: 'watch' })).verdict).toBe('run')

  // Full trust: no prompts.
  expect(rule(writing, scope({ mode: 'full-trust' })).verdict).toBe('run')
})

test('the never-touch list survives Full trust, which is the one rule with no exceptions', () => {
  const keys: Ask = {
    tool: 'files__read',
    annotations: { readOnlyHint: true },
    paths: [join(homedir(), '.ssh', 'id_ed25519')],
  }

  for (const mode of ['risky', 'every-time', 'watch', 'full-trust'] as const) {
    const ruling = rule(keys, scope({ mode, everywhere: true }))
    expect(ruling.verdict, `mode ${mode}`).toBe('blocked')
    expect(ruling.verdict === 'blocked' && ruling.why).toContain('never-touch list')
  }
})

test('Alexia’s own database is on the list, because of what is in it', () => {
  expect(neverTouch(join(dataDir, 'alexia.db'), dataDir)).toBe(true)
  expect(neverTouch(join(work, 'notes.txt'), dataDir)).toBe(false)
})

test('a sibling folder with a shared prefix is not inside anything', () => {
  // The bug this check exists to not have: startsWith would call these the same tree.
  expect(within(join(homedir(), 'work'), join(homedir(), 'work-notes'))).toBe(false)
  expect(within(join(homedir(), 'work'), join(homedir(), 'work', 'notes'))).toBe(true)
  // And `..` cannot walk out of scope and back in through a longer path.
  expect(within(work, join(work, '..', '.ssh'))).toBe(false)
})

test('a path outside the chosen folders is asked about, not assumed', () => {
  const elsewhere: Ask = { ...reading, paths: [join(homedir(), 'Desktop', 'taxes.pdf')] }
  const ruling = rule(elsewhere, scope())
  expect(ruling.verdict).toBe('ask')
  expect(ruling.verdict === 'ask' && ruling.why).toContain('outside the folders you chose')

  // Everywhere was chosen deliberately and warned about, so it does not ask again.
  expect(rule(elsewhere, scope({ everywhere: true })).verdict).toBe('run')
})

test('an unreviewed server gets no benefit of the doubt from its own annotations', () => {
  // MCP compatibility mode (M3-6): the annotations are a hint from a process nobody read.
  const claimed: Ask = { ...reading, reviewed: false }
  expect(rule(claimed, scope()).verdict).toBe('ask')
  expect(rule(claimed, scope({ mode: 'risky', boundaries: [{ said: 'never delete anything', blocks: 'destructive', at: 0 }] })).verdict).toBe('blocked')
})

test('a spoken boundary blocks, quotes the user back, and says how to lift it', () => {
  const boundary = heard('please don’t delete anything in there')
  expect(boundary).toMatchObject({ blocks: 'destructive' })

  const ruling = rule(writing, scope({ boundaries: boundary ? [boundary] : [] }))
  expect(ruling.verdict).toBe('blocked')
  // Their sentence, not core's paraphrase of it.
  expect(ruling.verdict === 'blocked' && ruling.why).toContain('don’t delete anything')
  expect(ruling.verdict === 'blocked' && ruling.why).toContain('lift it')

  // It holds in Full trust too — it is the user's own instruction, not a mode.
  expect(rule(writing, scope({ mode: 'full-trust', boundaries: boundary ? [boundary] : [] })).verdict).toBe('blocked')

  // And a read still runs: "don't delete" is not "don't do anything".
  expect(rule(reading, scope({ boundaries: boundary ? [boundary] : [] })).verdict).toBe('run')
})

test('the acknowledgement says it is a default and not a guarantee', () => {
  const boundary = heard('never delete anything')!
  // Invariant 8 territory: the promise made here is exactly the one that can be kept.
  expect(boundaryAck(boundary)).toContain('not something the operating system enforces')
})

test('lifting is heard too, and ordinary sentences are not boundaries', () => {
  expect(lifts('ok you can delete it')).toBe(true)
  expect(lifts('forget that rule')).toBe(true)

  expect(heard('what did you delete yesterday')).toBeUndefined()
  expect(heard('summarise my notes')).toBeUndefined()
  expect(lifts('what did you change')).toBe(false)
})

test('roots are the folders chosen, as file URIs, and Everywhere invents none', () => {
  const roots = rootsOf(scope())
  expect(roots).toHaveLength(1)
  expect(roots[0]?.uri.startsWith('file:///')).toBe(true)
  expect(roots[0]?.name).toBe('work')

  // Everywhere is not expressible as a root, and telling a plugin it has `/` would be a lie.
  expect(rootsOf(scope({ everywhere: true }))).toHaveLength(1)

  // A forbidden folder cannot be handed to a plugin even if it got into the list.
  expect(rootsOf(scope({ roots: [join(homedir(), '.ssh'), work] }))).toHaveLength(1)
})

test('the list is built from this machine, not from path literals', () => {
  const root = parse(homedir()).root
  const system = process.platform === 'win32' ? (process.env.SystemRoot ?? join(root, 'Windows')) : join(root, 'etc')
  expect(neverTouch(join(resolve(system), 'anything'), dataDir)).toBe(true)
})
