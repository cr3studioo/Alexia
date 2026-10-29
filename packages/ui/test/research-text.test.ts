// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { interestingWords } from '../src/research-text.js'

test('visual word picks use actual interesting terms, favor the topic, and avoid repeated boilerplate', () => {
  const words = ['the', 'because', 'compressor', 'however', 'refrigerant', 'efficiency', 'compressor', 'temperature', 'another']
  const selected = interestingWords(words, 'compressor refrigerant', 'source-1').map((i) => words[i])
  expect(selected.some((word) => word === 'compressor' || word === 'refrigerant')).toBe(true)
  expect(new Set(selected).size).toBe(selected.length)
  for (const word of selected) expect(['compressor', 'refrigerant', 'efficiency', 'temperature']).toContain(word)
})

test('repeated generic terms and already-picked words give way to more distinctive words', () => {
  const words = ['system', 'heating', 'refrigeration', 'compressor', 'insulation', 'efficiency']
  const selected = interestingWords(words, 'heating system', 'source-2', { frequency: new Map([['system', 100], ['heating', 100]]), excluded: new Set(['efficiency']) }).map((i) => words[i])
  expect(selected).toEqual(expect.arrayContaining(['refrigeration', 'compressor', 'insulation']))
})

test('word choices stay stable for the same run but vary across runs', () => {
  const words = ['refrigerant', 'compressor', 'inverter', 'climate', 'insulation', 'efficiency', 'electricity', 'radiators', 'cooling', 'heating']
  const select = (seed: string): string => interestingWords(words, 'heat pumps', seed).join(',')
  expect(select('run-1')).toBe(select('run-1'))
  expect(new Set(Array.from({ length: 12 }, (_, i) => select(`run-${i}`))).size).toBeGreaterThan(1)
})
