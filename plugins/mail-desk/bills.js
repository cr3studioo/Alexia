// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bills and renewals. A model reads the text and answers in JSON; this file is the part that
 * does not trust it: the date must be a real calendar day and the amount a real number, or the
 * answer is thrown away and no bill is recorded.
 */

/** Cheap pre-filter, so the model is asked only about mail that could be a bill. */
const BILLISH =
  /invoice|\bbill\b|payment due|amount due|due date|renew|subscription|faktur|splatnost|k úhradě|k uhrazení|platb|obnov|předplatn|vyúčtování/iu

export const looksLikeBill = (subject, text) => BILLISH.test(`${subject ?? ''}\n${String(text ?? '').slice(0, 4000)}`)

/** What the model is asked, with the text it may see (the first 4000 characters). */
export function billPrompt(text, subject = '') {
  return (
    'Is this mail an invoice, a bill or a subscription renewal notice? Answer with one JSON object and nothing else.\n' +
    'If it is not one, answer {"bill":false}. If it is: {"bill":true,"payee":"who is paid","amount":123.45,' +
    '"currency":"CZK","due":"YYYY-MM-DD","recurring":true or false}. "due" is the payment or renewal day.\n\n' +
    `Subject: ${String(subject).slice(0, 200)}\n${String(text ?? '').slice(0, 4000)}`
  )
}

/** `YYYY-MM-DD` that is a real day, else undefined. */
export function realDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return undefined
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const at = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d
    ? m[0]
    : undefined
}

/** A number from `1234.5`, `"1 234,50"` or `"1,234.50"`; undefined for anything else. */
export function realAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  let s = String(value ?? '').replace(/\s/g, '')
  if (!/^\d[\d.,]*$/.test(s)) return undefined
  const comma = s.lastIndexOf(','),
    dot = s.lastIndexOf('.')
  s = comma > dot ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '')
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The model's answer as a bill, or `undefined` when it says no, is not JSON, or fails the checks.
 * Returns `{ payee, amount, currency, due, recurring }`.
 */
export function parseBill(answer) {
  const raw = String(answer ?? '')
  const start = raw.indexOf('{'),
    end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  let json
  try {
    json = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (json === null || typeof json !== 'object' || json.bill !== true) return undefined
  const due = realDay(json.due)
  const amount = realAmount(json.amount)
  if (due === undefined || amount === undefined) return undefined
  const code = String(json.currency ?? '').trim()
  const payee = String(json.payee ?? '').trim().slice(0, 80)
  if (!/^[A-Za-z]{3}$/.test(code) || payee === '') return undefined
  return { payee, amount, currency: code.toUpperCase(), due, recurring: json.recurring === true }
}
