// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { markdown, synthesis } from '../evidence.js'
const sources = [{ id: 'S1', url: 'https://example.org/', title: 'Primary source', retrievedAt: '2026-10-19', passages: [{ id: 'P1', text: 'The evidence contains an exact phrase with enough surrounding context.' }] }]
const answer = () => ({ answer: 'The finding is supported [S1].', findings: [{ text: 'A supported finding.', citations: ['S1'], quotes: [{ sourceId: 'S1', passageId: 'P1', text: 'an exact phrase' }] }], gaps: ['Only one accessible source.'] })
test('one response yields a sourced answer and Markdown report with matching quotations and retrieval dates', () => {
  const result = synthesis(JSON.stringify(answer()), sources)
  expect(result.answer).toContain('[S1](https://example.org/)')
  const report = markdown('Question', result, sources, ['One site was blocked.'])
  for (const part of ['## Question', '## Findings', '> an exact phrase', '## Disagreements and gaps', 'One site was blocked.', 'Only one accessible source.', '2026-10-19']) expect(report).toContain(part)
})
test('unresolved citations and unfaithful quotes fail closed without a rewriting pass', () => {
  const wrongSource = answer(); wrongSource.answer = 'Unverified [S9].'
  expect(() => synthesis(JSON.stringify(wrongSource), sources)).toThrow('Unresolved citation')
  const inline = answer(); inline.answer = 'It says “a fabricated quote” [S1].'
  expect(() => synthesis(JSON.stringify(inline), sources)).toThrow('quoted passage')
  const unsupported = answer(); unsupported.findings[0].citations = []
  expect(() => synthesis(JSON.stringify(unsupported), sources)).toThrow('supporting citations')
})
test('unverified optional quotes are omitted and disclosed, while cited findings remain available', () => {
  const value = answer()
  value.findings[0].quotes.push({ sourceId: 'S1', passageId: 'P99', text: 'a fabricated quote' })
  value.findings[0].quotes.push({ sourceId: 'S9', passageId: 'P1', text: 'unresolved quote source' })
  const result = synthesis(JSON.stringify(value), sources)
  expect(result.findings).toContain('> an exact phrase')
  expect(result.findings).not.toContain('a fabricated quote')
  expect(result.findings).not.toContain('unresolved quote source')
  expect(result.gaps).toContain('Proposed quotations that could not be matched to their cited evidence were omitted.')
})
test('an uncited concise answer is replaced by validated findings without another model call', () => {
  const value = answer()
  value.answer = 'An unsupported summary claim without citations.'
  const result = synthesis(JSON.stringify(value), sources)
  expect(result.answer).toBe('A supported finding. [S1](https://example.org/)')
  expect(result.answer).not.toContain('unsupported summary claim')
  value.findings[0].citations = ['S9']
  expect(() => synthesis(JSON.stringify(value), sources)).toThrow('Unresolved citation')
})
