// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { chain, due, relative, REVIEW_AFTER, rewrite, rewritePrompt, stale, timeBound, valid } from '../garden.js'
import { profile } from '../profile.js'

/**
 * Truth over time: which notes still hold, which are due a check, and what the gardener may
 * and may not do about them. It never decides a note is false — every test here is about the
 * one thing it may do (make relative time absolute) and the checks on that.
 */

const DAY = 24 * 60 * 60 * 1000

test('half a year before a time-bound note is checked', () => {
  expect(REVIEW_AFTER).toBe(180 * DAY)
})

test('valid is never closed; rows older than the column are valid', () => {
  expect(valid({})).toBe(true)
  expect(valid({ invalid_at: null })).toBe(true)
  expect(valid({ invalid_at: 5 })).toBe(false)
  expect(valid({ invalid_at: '5' })).toBe(false)
  expect(stale({ stale_since: null })).toBe(false)
  expect(stale({ stale_since: 9 })).toBe(true)
  expect(timeBound({ time_bound: 1 })).toBe(true)
  expect(timeBound({})).toBe(false)
})

test('due: valid notes whose review has passed, oldest due first, and nothing else', () => {
  const rows = [
    { rowid: 1, review_at: 50 },
    { rowid: 2, review_at: 10 },
    { rowid: 3, review_at: 500 },
    { rowid: 4, review_at: 10, invalid_at: 20 },
    { rowid: 5 },
    { rowid: 6, review_at: null },
  ]
  expect(due(rows, 100).map((row) => row.rowid)).toEqual([2, 1])
  expect(due([], 100)).toEqual([])
})

test('relative time, in English and Czech, with or without the accents', () => {
  for (const text of [
    'He is currently working at Rohlik.',
    'He is a first-year student at ČVUT FEL.',
    'He is in his second year at university.',
    'This year he is learning Japanese.',
    'He is 25 years old.',
    'He moved to Brno recently.',
    'Letos začal studovat na ČVUT.',
    'Teď bydlí v Brně.',
    'Momentálně pracuje na diplomce.',
    'Je v prvním ročníku.',
    'Je prvák na FELu.',
    'Je mu 25 let.',
  ]) {
    expect(relative(text), text).toBe(true)
  }
  for (const text of [
    'He started at ČVUT FEL in September 2026.',
    'His name is Vaclav.',
    'He knows how to snowboard.',
    'He prefers answers in Czech.',
    'Bydlí v Praze od roku 2020.',
    // A name, not the Czech *now*: only *teď* with its accent counts.
    'His friend Ted studies in Brno.',
    'Ted bydli v Brne.',
  ]) {
    expect(relative(text), text).toBe(false)
  }
})

test('the rewrite prompt says when the note was written and asks for KEEP rather than a guess', () => {
  const asked = rewritePrompt({ text: 'He is a first-year student at ČVUT FEL.', at: Date.UTC(2026, 8, 23) })
  expect(asked).toContain('written on 2026-09-23')
  expect(asked).toContain('He is a first-year student at ČVUT FEL.')
  expect(asked).toContain('KEEP')
})

test('a rewrite is believed only if it stays on the subject and stops being relative', () => {
  const original = 'He is a first-year student at ČVUT FEL.'
  // The good one, wrapped the way small models wrap things.
  expect(rewrite(original, '"He started studying at ČVUT FEL in September 2026."\n')).toBe(
    'He started studying at ČVUT FEL in September 2026.',
  )
  // Declined, empty, or unchanged: keep the note.
  expect(rewrite(original, 'KEEP')).toBeNull()
  expect(rewrite(original, '')).toBeNull()
  expect(rewrite(original, original)).toBeNull()
  // Still relative: no gain, so no rewrite.
  expect(rewrite(original, 'He is currently a student at ČVUT FEL.')).toBeNull()
  // Off the subject: a model inventing a sentence does not get to replace a true one.
  expect(rewrite(original, 'His dog is called Bruno.')).toBeNull()
  // Much longer than the note is a rewrite that added things.
  expect(rewrite(original, `He started at ČVUT FEL in 2026 ${'and did many other things '.repeat(20)}.`)).toBeNull()
})

test('chain: every version of a note, both ways along replaced_by and across branches, oldest first', () => {
  const rows = [
    { rowid: 1, at: 10, text: 'He lives in Prague.', invalid_at: 20, replaced_by: 2 },
    { rowid: 2, at: 20, text: 'He lives in Brno.', invalid_at: 30, replaced_by: 4 },
    { rowid: 3, at: 25, text: 'He lives near Brno.', invalid_at: 30, replaced_by: 4 },
    { rowid: 4, at: 30, text: 'He lives in Ostrava.' },
    { rowid: 5, at: 30, text: 'Unrelated.' },
  ]
  const ids = (from) => chain(rows, from).map((row) => row.rowid)
  expect(ids(4)).toEqual([1, 2, 3, 4])
  // From the oldest, the newest comes too — what forgetting needs.
  expect(ids(1)).toEqual([1, 2, 3, 4])
  expect(ids(5)).toEqual([5])
  expect(ids(99)).toEqual([])
  // A loop written by a bug does not hang it.
  expect(chain([{ rowid: 1, replaced_by: 2 }, { rowid: 2, replaced_by: 1 }], 1)).toHaveLength(2)
})

test('the profile never carries a note that is no longer true, and keeps one that may be out of date', () => {
  const rows = [
    { text: 'He lives in Prague.', pinned: 1, source: 'stated', at: 1, invalid_at: 2, replaced_by: 2 },
    { text: 'He lives in Brno.', pinned: 1, source: 'stated', at: 2, stale_since: 3 },
  ]
  expect(profile(rows)).toBe('- He lives in Brno.')
})
