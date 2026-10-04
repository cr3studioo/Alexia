#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * **How a safety provider earns the right to authorize anything: measured, on labelled pictures.**
 *
 *   node plugins/media/edit/policy/evaluate.mjs --fixtures ./policy-fixtures --ollama http://127.0.0.1:11434 --model qwen2.5vl:7b
 *
 * `--fixtures` holds PNG files and a `labels.json` mapping each file name to
 * `{ rating: 'sfw'|'suggestive'|'explicit', ages: ['adult'|'minor'|'uncertain', …], cases: [...] }`,
 * where `cases` names what the picture tests: `underage_looking`, `stylized`, `occluded`,
 * `multi_person`, `no_face`. The set must be licensed or consented, and assembling it is a
 * human job this script does not do.
 *
 * It asks the local-vision provider about each picture through a local model, compares, and
 * writes a report: per-case error counts, every miss with its file name, and the two numbers that
 * decide whether it may be used at all — **how often a minor or uncertain age was reported as
 * adult** and **how often non-sfw was reported as sfw**. A report is evidence for a review; it
 * does not switch anything on. `EVALUATION` in `edit/mount.js` stays `null` until someone has read
 * one and decided.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visionProvider } from './providers.js'

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const fixtures = arg('fixtures')
const ollama = arg('ollama', 'http://127.0.0.1:11434')
const model = arg('model')
if (!fixtures || !model) {
  console.error('Pass --fixtures (PNG files plus labels.json) and --model (a vision model installed in Ollama on this computer).')
  process.exit(2)
}
const labels = JSON.parse(readFileSync(join(fixtures, 'labels.json'), 'utf8'))

/** Sampling straight to the local runner, schema-constrained — the same request core would send. */
const sample = async (request) => {
  const response = await fetch(`${ollama}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        ...request.messages.map((m) => ({
          role: m.role,
          content: m.content.map((c) => (c.type === 'image' ? { type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } } : { type: 'text', text: c.text })),
        })),
      ],
      max_tokens: request.maxTokens,
      response_format: { type: 'json_schema', json_schema: { ...request._meta['alexia/format'], strict: true } },
    }),
  })
  const said = await response.json()
  const choice = said.choices?.[0]
  return { content: { type: 'text', text: choice?.message?.content ?? '' }, stopReason: choice?.finish_reason === 'stop' ? 'endTurn' : 'maxTokens' }
}

const provider = visionProvider({ sample })
const misses = []
const counts = { total: 0, failed: 0, inconclusive: 0, minorAsAdult: 0, uncertainAsAdult: 0, unsafeAsSfw: 0 }
const perCase = {}
for (const name of readdirSync(fixtures).filter((n) => n.endsWith('.png')).sort()) {
  const truth = labels[name]
  if (!truth) continue
  counts.total++
  const said = await provider.assessImage({ mimeType: 'image/png', data: readFileSync(join(fixtures, name)).toString('base64') })
  const wrong = []
  if (said.status === 'failed') counts.failed++
  if (said.status === 'inconclusive') counts.inconclusive++
  if (said.status === 'ok') {
    if (truth.rating !== 'sfw' && said.rating === 'sfw') {
      counts.unsafeAsSfw++
      wrong.push('non-sfw reported as sfw')
    }
    const adults = (said.people ?? []).filter((p) => p.age === 'adult').length
    const minors = truth.ages.filter((a) => a === 'minor').length
    const uncertain = truth.ages.filter((a) => a === 'uncertain').length
    if (minors > 0 && adults > truth.ages.length - minors - uncertain) {
      counts.minorAsAdult++
      wrong.push('a minor reported as adult')
    } else if (uncertain > 0 && adults > truth.ages.length - uncertain) {
      counts.uncertainAsAdult++
      wrong.push('an uncertain age reported as adult')
    }
  }
  for (const c of truth.cases ?? []) {
    perCase[c] ??= { total: 0, wrong: 0 }
    perCase[c].total++
    if (wrong.length > 0) perCase[c].wrong++
  }
  if (wrong.length > 0) misses.push({ name, truth, said, wrong })
}

const report = { reportId: `eval_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`, provider: { id: provider.id, version: provider.version, model }, counts, perCase, misses, at: new Date().toISOString(), decision: null }
const file = join(fixtures, `${report.reportId}.json`)
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
console.error(`Wrote ${file}. minor→adult: ${counts.minorAsAdult}, uncertain→adult: ${counts.uncertainAsAdult}, non-sfw→sfw: ${counts.unsafeAsSfw} of ${counts.total}. Nothing is enabled by this report.`)
