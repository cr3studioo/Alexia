// SPDX-License-Identifier: AGPL-3.0-only
import type { Point } from './research-spider.js'

export interface Letter extends Point { left: number; top: number; width: number; height: number; text: string }
export interface ReadingWord { id: string; text: string; passage: HTMLElement; letters: Letter[]; font: string; interesting: boolean }
export interface WordStep { word: ReadingWord; first: Letter; last: Letter; jump: boolean; pick: boolean }
const stops = new Set('about after again also another because before being between could during every following however information might other should source their there these things those through under using which while would article provide different how what when where work works research'.split(' '))
const hash = (text: string): number => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0)!, 16777619); return (n >>> 0) / 4294967296 }

/** Varied, topic-aware visual picks. This never ranks evidence or creates citations. */
export function interestingWords(words: string[], topic: string, seed: string, context: { frequency?: ReadonlyMap<string, number>; excluded?: ReadonlySet<string> } = {}): number[] {
  const terms = new Set(topic.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  return words.map((word, index) => {
    const term = word.toLocaleLowerCase()
    const acronym = word.length >= 2 && /\p{L}/u.test(word) && word === word.toLocaleUpperCase()
    const eligible = !stops.has(term) && !context.excluded?.has(term) && word.length <= 28 && (word.length >= 5 || acronym)
    return { index, term, score: eligible ? hash(`${seed}:${index}:${word}`) * 2 + Math.min(word.length, 16) / 8 + (terms.has(term) ? 1 : 0) - Math.log2(context.frequency?.get(term) ?? 1) * .65 : -1 }
  }).filter((w) => w.score >= 0).sort((a, b) => b.score - a.score).filter((w, i, all) => all.findIndex((p) => p.term === w.term) === i).slice(0, 3).map((w) => w.index)
}

/** Actual rendered character boxes in preview-content coordinates; scrolling needs no remeasure. */
export class ReadingText {
  readonly words: ReadingWord[] = []
  readonly letters: Letter[] = []
  readonly steps: WordStep[] = []
  constructor(preview: HTMLElement, topic: string, seed: string) {
    const origin = preview.getBoundingClientRect()
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const passages = [...preview.querySelectorAll<HTMLElement>('.research-marker:not(.research-page-marker)')]
    const frequency = new Map<string, number>()
    const selected = new Set<string>()
    for (const part of segmenter.segment(passages.map((p) => p.textContent).join(' '))) if (part.isWordLike) {
      const word = part.segment.toLocaleLowerCase(); frequency.set(word, (frequency.get(word) ?? 0) + 1)
    }
    for (const passage of passages) {
      const node = passage.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE) continue
      const text = node.textContent ?? ''
      const measured: ReadingWord[] = []
      const range = document.createRange()
      const style = getComputedStyle(passage)
      const font = style.font || `${style.fontSize} ${style.fontFamily}`
      // Bound layout work independently of retrieval and of the evidence document size.
      for (const part of segmenter.segment(text.slice(0, 600))) {
        if (!part.isWordLike) continue
        const word: ReadingWord = { id: `${passage.dataset.passage}:${part.index}`, text: part.segment, passage, letters: [], font, interesting: false }
        for (const c of characters.segment(part.segment)) {
          range.setStart(node, part.index + c.index); range.setEnd(node, part.index + c.index + c.segment.length)
          const box = range.getBoundingClientRect()
          if (!box.width || !box.height) continue
          const left = box.left - origin.left + preview.scrollLeft
          const top = box.top - origin.top + preview.scrollTop
          const letter = { x: left + box.width / 2, y: top + box.height * .42, left, top, width: box.width, height: box.height, text: c.segment }
          word.letters.push(letter); this.letters.push(letter)
        }
        if (word.letters.length) measured.push(word)
      }
      range.detach()
      const picks = interestingWords(measured.map((w) => w.text), topic, `${seed}:${passage.dataset.passage}`, { frequency, excluded: selected })
      // A short contiguous reading window walks the intervening characters too.
      const start = Math.max(0, (picks[0] ?? 0) - 4)
      const window = measured.slice(start, start + 11)
      const chosen = interestingWords(window.map((w) => w.text), topic, `${seed}:${passage.dataset.passage}:window`, { frequency, excluded: selected })
      for (const i of chosen) { window[i]!.interesting = true; selected.add(window[i]!.text.toLocaleLowerCase()) }
      let before: Letter | undefined
      for (const word of window) {
        this.words.push(word)
        const lines: Letter[][] = []
        for (const letter of word.letters) {
          if (!lines.length || Math.abs(lines.at(-1)![0]!.top - letter.top) > letter.height / 2) lines.push([])
          lines.at(-1)!.push(letter)
        }
        for (const [i, line] of lines.entries()) {
          const first = line[0]!; const last = line.at(-1)!
          const gap = !before || Math.abs(before.top - first.top) > first.height / 2 || Math.max(first.left - (before.left + before.width), before.left - (first.left + first.width)) > 1.5
          this.steps.push({ word, first, last, jump: gap, pick: word.interesting && i === lines.length - 1 })
          before = last
        }
      }
    }
  }
}
