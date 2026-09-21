// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CORE_CAPABILITIES } from '@alexia/protocol'

/**
 * ***That wasn't her***, core's half (`plan-personality.md` improvement 10, item 17), and the
 * header chip deferred from improvement 8.
 *
 * The sibling of *Bad answer* and the opposite question. *Bad answer* is about the **model**,
 * and core keeps it: the answer is marked, the model's record carries a press, and the question
 * is asked again without it. This one is about the **personality**, which is a plugin's
 * document — so core hands it over under a capability name, forgets it, and never learns who
 * took it.
 */

/**
 * **Source read for assertions, with its line endings normalised.**
 *
 * Git hands a Windows checkout CRLF, so a pattern that spans a line break matches on the
 * machine it was written on and fails on the first build that mattered — which is exactly what
 * `12-version-in-step.test.ts` warns about in its own comment, and exactly what these tests
 * did. Normalising once here is cheaper than remembering `\r?` in every pattern, and it cannot
 * be forgotten by the next test added to this file.
 */
const source = (...where: string[]): string => readFileSync(join(...where), 'utf8').replace(/\r\n/g, '\n')

const shell = source(import.meta.dirname, '..', '..', 'ui', 'src', 'main.ts')
const serve = source(import.meta.dirname, '..', 'src', 'serve.ts')
const guard = source(import.meta.dirname, '..', 'src', 'guard.ts')
const markup = source(import.meta.dirname, '..', '..', 'ui', 'index.html')

test('the two live in one row, which is the whole reason item 17 built them together', () => {
  // Two rows competing under one bubble is what building them separately produces, and it is
  // the thing `plan_final_v2.md` item 17 exists to prevent.
  const at = shell.indexOf('function answerActions(')
  const body = shell.slice(at, shell.indexOf('\n}', at))
  expect(body).toContain("'Bad answer'")
  expect(body).toContain('notHerButton')
  expect(shell.match(/className = 'message-actions'/g)).toHaveLength(1)
})

test('one asks the question again and the other does not, which is the difference between them', () => {
  // *Bad answer* throws the answer away and asks something else; *That wasn't her* leaves the
  // answer exactly where it is, because it was the right answer in the wrong voice.
  const at = shell.indexOf('function notHerButton(')
  const body = shell.slice(at, shell.indexOf('\n}', at))
  expect(body).not.toContain('again: true')
  expect(body).not.toContain('markBad')
  expect(body).toContain("post('/api/not-her'")
  // The press alone is already a usable fact, so it is sent before the box opens — whoever
  // cannot be bothered to type has already said the useful thing.
  expect(body.indexOf("post('/api/not-her', {})")).toBeGreaterThan(-1)
  expect(body.indexOf("post('/api/not-her', {})")).toBeLessThan(body.indexOf('placeholder'))
  // And what the line under it says depends on whether anything kept it: *Noted* over a mark
  // nobody took was the button lying.
  expect(body).toContain('back.heard !== false')
  expect(body).toContain('that was not noted')
})

test('the button is drawn only when something is listening', () => {
  // The honest version of *there is nothing here this would tell*. An Alexia with no
  // personality plugin has no character an answer could have been out of.
  expect(shell).toMatch(/answerActions\(latest, state\.notHer === true\)/)
  expect(serve).toMatch(/\.\.\.\(await who\(\)\)/)
  // **Listening means bound, not promised.** The manifest lists `persona.not_her` whether or not
  // a personality is in use; the plugin binds it only when one is. Reading the promise drew the
  // button with nobody behind it.
  const at = serve.indexOf('const who = ()')
  const body = serve.slice(at, serve.indexOf('})())', at))
  expect(body).toMatch(/plugins\.offers\(CORE_CAPABILITIES\.notHer\)/)
  expect(CORE_CAPABILITIES.notHer).toBe('persona.not_her')
})

test('who is answering is asked once and kept until a plugin changes what it binds', () => {
  // Read on every state poll, and each answer wakes a plugin to ask — so asked per poll it kept a
  // lazy plugin running for as long as the window was open. Every change arrives as a tool change.
  expect(serve).toMatch(/speaking \?\?= /)
  const at = serve.indexOf('onToolsChanged: () => {')
  expect(serve.slice(at, serve.indexOf('\n    },', at))).toContain('speaking = undefined')
})

test('a line typed after the press lands on the answer that was pressed', () => {
  // The box stays open under its answer while the conversation carries on, so resolving
  // *the latest answer* again when the line arrives filed it against whatever came next.
  const at = serve.indexOf("url.pathname === '/api/not-her'")
  const body = serve.slice(at, serve.indexOf('\n    }\n', at))
  expect(body).toMatch(/line !== undefined && pressed\?\.session === session \? pressed : undefined/)
  expect(body).toMatch(/pressed = pair/)
})

test('core hands the mark over and forgets it, and never fails the press on a plugin', () => {
  const at = serve.indexOf("url.pathname === '/api/not-her'")
  const body = serve.slice(at, serve.indexOf('\n    }', at))
  expect(body).toContain('CORE_CAPABILITIES.notHer')
  // Caught, logged, and the press still says yes: a button that sometimes errors for reasons
  // about a plugin is a button people stop pressing.
  expect(body).toMatch(/\.catch\(\(error: unknown\) => \{/)
  expect(body).toMatch(/ok: true, heard/)
  // Nothing is marked, nothing is deleted, and the model's record is untouched — all three
  // belong to *Bad answer*, which is a different press about a different thing.
  expect(body).not.toContain('markLastAnswerBad')
  expect(body).not.toContain('recordTry')
})

test('the route is classified, and classified as the thing it actually does', () => {
  // `guard.test.ts` holds *every route is classified*; this holds what this one says, because
  // a safe route whose sentence describes a different route is worse than an unclassified one.
  expect(guard).toContain("'/api/not-her'")
  const at = guard.indexOf("'/api/not-her'")
  expect(guard.slice(at, at + 600)).toMatch(/Nothing is deleted, nothing is re-asked/)
})

test('the chip names who is answering, and is absent rather than saying none', () => {
  // Alexia's own voice is not a personality, and a chip permanently on screen saying *none*
  // is a control that is always there saying nothing.
  expect(markup).toContain('id="character"')
  expect(shell).toMatch(/characterChip\.hidden = state\.character === undefined \|\| state\.character === ''/)
  expect(serve).toMatch(/chip\(\),\n\s+plugins\.answers\(CORE_CAPABILITIES\.notHer\)/)
  // **And it is called a character, not a persona** — invariant 1 caught the first name, which
  // was the plugin's. What the shell shows is who is answering; the plugin that supplies it is
  // core's business to resolve and nobody else's to name.
  expect(markup).not.toMatch(/\bpersona\b/)
  expect(shell).not.toMatch(/\bpersona\b/)
  expect(CORE_CAPABILITIES.inUse).toBe('persona.in_use')
})

test('the chip never fails a chat, because it is a label', () => {
  const at = serve.indexOf('async function chip(')
  const body = serve.slice(at, serve.indexOf('\n  }', at))
  // Nothing provides it, nothing is chosen, or whatever does is having a bad day → no chip,
  // and a chat that works. The same shape `personality()` has, for the same reason.
  expect(body).toMatch(/if \(!plugins\.answers\(CORE_CAPABILITIES\.inUse\)\) return undefined/)
  expect(body).toMatch(/catch \{\n\s+return undefined/)
  // And it is bounded, because a header label is not a place to discover a plugin's idea of
  // a short name.
  expect(body).toMatch(/slice\(0, 40\)/)
})
