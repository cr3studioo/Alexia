// SPDX-License-Identifier: AGPL-3.0-only
/** Code validates references and exact quotes before any generated words are delivered. */
export function synthesis(text, sources) {
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  const byId = new Map(sources.map((s) => [s.id, s]))
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim() || parsed.answer.length > 2500 || !Array.isArray(parsed.findings) || !parsed.findings.length || parsed.findings.length > 12) throw new Error('The model did not return a bounded research answer')
  const known = (id) => { if (!byId.has(id)) throw new Error(`Unresolved citation: ${id}`); return byId.get(id) }
  const quoted = (value, selected = sources) => {
    for (const match of value.matchAll(/[“"]([^”"\n]{12,})[”"]/g)) {
      if (!selected.some((s) => s.passages.some((p) => p.text.includes(match[1])))) throw new Error('A quoted passage did not match the evidence')
    }
  }
  const references = [...parsed.answer.matchAll(/\[(S\d+)\]/g)].map((m) => m[1])
  references.forEach(known)
  if (references.length) quoted(parsed.answer)
  let omittedQuotes = false
  const verifiedQuotes = new Map()
  for (const finding of parsed.findings) {
    if (typeof finding.text !== 'string' || !finding.text.trim() || finding.text.length > 4000 || !Array.isArray(finding.citations) || !finding.citations.length) throw new Error('A finding has no supporting citations')
    const cited = finding.citations.map(known)
    quoted(finding.text, cited)
    for (const match of finding.text.matchAll(/\[(S\d+)\]/g)) known(match[1])
    const quotes = []
    for (const quote of finding.quotes ?? []) {
      const source = byId.get(quote?.sourceId)
      if (source && finding.citations.includes(source.id) && typeof quote.text === 'string' && quote.text.trim() && source.passages.some((p) => p.id === quote.passageId && p.text.includes(quote.text))) quotes.push(quote)
      else omittedQuotes = true
    }
    verifiedQuotes.set(finding, quotes)
  }
  if (parsed.gaps !== undefined && (!Array.isArray(parsed.gaps) || parsed.gaps.some((g) => typeof g !== 'string' || g.length > 1500))) throw new Error('Invalid evidence gaps')
  const link = (id) => `[${id}](${known(id).url})`
  const linked = (text) => text.replace(/\[(S\d+)\]/g, (_, id) => link(id))
  let answer = linked(parsed.answer)
  if (!references.length) {
    // Never assign citations to uncited model prose. Compose the chat answer from the
    // findings whose own references and quotations were validated above instead.
    const selected = []
    for (const finding of parsed.findings) {
      const part = `${linked(finding.text)} ${[...new Set(finding.citations)].map(link).join(' ')}`
      if ([...selected, part].join('\n\n').length <= 2400) selected.push(part)
      if (selected.length === 3) break
    }
    if (!selected.length) throw new Error('The model returned no bounded, cited summary findings')
    answer = selected.join('\n\n')
  }
  if (answer.length > 3900) throw new Error('The sourced answer exceeds the final-result limit')
  const findings = parsed.findings.map((f) => `${f.text} ${[...new Set(f.citations)].map(link).join(' ')}${verifiedQuotes.get(f).map((q) => `\n\n> ${q.text}\n\n${link(q.sourceId)}`).join('')}`).join('\n\n')
  return { answer, findings, gaps: [...(parsed.gaps ?? []), ...(omittedQuotes ? ['Proposed quotations that could not be matched to their cited evidence were omitted.'] : [])] }
}

export function markdown(question, result, sources, gaps) {
  return `# Research: ${question}\n\n## Question\n\n${question}\n\n## Findings\n\n${result.findings}\n\n## Disagreements and gaps\n\n${[...gaps, ...result.gaps].map((g) => '- ' + g).join('\n') || 'No additional disagreements were identified in the selected evidence. Coverage is limited to the sources below.'}\n\n## Sources\n\n${sources.map((s) => `- [${s.id}] [${s.title}](${s.url}) — retrieved ${s.retrievedAt}`).join('\n')}\n`
}
