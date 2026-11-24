// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parcels, read out of shipping mail. Pure: text in, parcels out. No carrier is ever called —
 * the mail already says where the parcel is, and asking a carrier would tell it who the owner is.
 */

/** Words that usually sit right before a tracking number, in English and Czech. */
const BEFORE =
  '(?:tracking|track|parcel|package|shipment|waybill|consignment|reference|number|no\\.|č\\.|číslo|čísla|zásilk[\\p{L}]*|balík[\\p{L}]*|sledov[\\p{L}]*|podací)'

/** Numbers whose shape names the carrier on its own. */
const SHAPED = [
  ['UPS', /(?<![A-Z0-9])1Z[0-9A-Z]{16}(?![A-Z0-9])/g],
  ['Amazon', /(?<![A-Z0-9])TBA\d{9,12}(?!\d)/g],
  ['Zásilkovna', /(?<![A-Z0-9])Z\d{10}(?!\d)/g],
  ['DHL', /(?<![A-Z0-9])JJD\d{18,20}(?!\d)/g],
  ['Česká pošta', /(?<![A-Z0-9])(?:[A-Z]{2}\d{9}CZ|DR\d{9,10})(?![A-Z0-9])/g],
]

/** Carriers whose numbers are plain digits: they count only beside the carrier's name and a tracking word. */
const PLAIN = [
  ['PPL', /\bPPL\b/i, [11]],
  ['DPD', /\bDPD\b/i, [14]],
  ['GLS', /\bGLS\b/i, [11, 12]],
  ['DHL', /\bDHL\b/i, [10, 11]],
  ['FedEx', /\bfedex\b/i, [12, 15]],
]

/** Every tracking number in the text, once each. Returns `{ carrier, number }[]`. */
export function findParcels(text) {
  const body = String(text ?? '')
  const found = []
  const add = (carrier, number) => {
    if (!found.some((f) => f.carrier === carrier && f.number === number)) found.push({ carrier, number })
  }
  for (const [carrier, pattern] of SHAPED) {
    for (const m of body.matchAll(pattern)) add(carrier, m[0])
  }
  const named = PLAIN.filter(([, name]) => name.test(body))
  if (named.length > 0) {
    const after = new RegExp(`${BEFORE}[^\\d\\n]{0,30}?(\\d{10,15})(?!\\d)`, 'giu')
    for (const m of body.matchAll(after)) {
      const hit = named.find(([, , lengths]) => lengths.includes(m[1].length))
      if (hit) add(hit[0], m[1])
    }
  }
  return found
}

/** Text that says it is not yet so: "will be delivered" is not "delivered". */
const FUTURE = /\b(?:will be|to be|going to be|shall be) delivered\b|\bbude doručen[\p{L}]*|\bbudou doručen[\p{L}]*/giu

const OUT =
  /out for delivery|on its way to you today|delivery today|dnes doru[čc]|k doručení dnes|na cestě k vám|doručujeme dnes|vyjel(?:a|o)? k vám|rozvoz/iu
const DELIVERED =
  /\bdelivered\b|\bdoručen(?:o|a|y|é|ý)?(?![\p{L}])|\bdoručil[\p{L}]*|\bpřevzal[\p{L}]*|\bpřevzat[\p{L}]*|\bvyzvednut[\p{L}]*|\bpicked up\b|\bcollected\b/iu
const SHIPPED =
  /\bshipped\b|\bdispatched\b|\bin transit\b|\bon its way\b|\bodesl[\p{L}]*|\bexpedov[\p{L}]*|\bpředán[\p{L}]* dopravci|\bna cestě(?![\p{L}])|\bpodán[\p{L}]*/iu

/** `'out_for_delivery'`, `'delivered'`, `'shipped'`, or undefined when the text says none. */
export function parcelState(text) {
  const body = String(text ?? '').replace(FUTURE, ' ')
  if (OUT.test(body)) return 'out_for_delivery'
  if (DELIVERED.test(body)) return 'delivered'
  if (SHIPPED.test(body)) return 'shipped'
  return undefined
}

/** `YYYY-MM-DD` for a real calendar date, else undefined. */
const iso = (y, m, d) => {
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
    ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : undefined
}

/** The expected delivery day, when the mail names one after a word that means so. */
export function findEta(text) {
  const m =
    /(?:eta|expected|estimated|delivery (?:on|by)|arriv\w*|doručen[\p{L}]*|doručíme|očekáván[\p{L}]*|předpokládan[\p{L}]*)[^\d\n]{0,30}?(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}))/iu.exec(
      String(text ?? ''),
    )
  if (!m) return undefined
  return m[1] !== undefined ? iso(+m[1], +m[2], +m[3]) : iso(+m[6], +m[5], +m[4])
}

/** Everything one mail says about parcels: each number, with the state and eta the text gives. */
export function parseParcels(text) {
  const state = parcelState(text)
  const eta = findEta(text)
  return findParcels(text).map((p) => ({ ...p, state: state ?? 'shipped', ...(eta !== undefined && { eta }) }))
}

const RANK = { shipped: 1, out_for_delivery: 2, delivered: 3 }

/** A parcel never goes backwards: a late "shipped" mail must not undo "delivered". */
export const furtherAlong = (next, current) => (RANK[next] ?? 0) > (RANK[current] ?? 0)
