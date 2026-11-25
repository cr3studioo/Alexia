// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { findEta, findParcels, furtherAlong, parcelState, parseParcels } from '../parcels.js'

// Invented text and invented numbers, one per carrier.
const FIXTURES = [
  ['Zásilkovna', 'Vaše zásilka Z1234567890 je na cestě k výdejnímu místu.', 'Z1234567890'],
  ['PPL', 'PPL: your parcel is shipped. Tracking number: 40012345678', '40012345678'],
  ['DPD', 'DPD balík číslo 15501234567890 byl předán dopravci.', '15501234567890'],
  ['GLS', 'GLS shipment. Parcel number 12345678901 will arrive soon.', '12345678901'],
  ['Česká pošta', 'Balík Česká pošta, podací číslo DR1234567890 byl odeslán.', 'DR1234567890'],
  ['Česká pošta', 'Zásilka RR123456789CZ je podána.', 'RR123456789CZ'],
  ['DHL', 'DHL Express: tracking number 1234567890 has shipped.', '1234567890'],
  ['UPS', 'UPS tracking 1Z999AA10123456784 is in transit.', '1Z999AA10123456784'],
  ['FedEx', 'FedEx tracking number 123456789012 shipped today.', '123456789012'],
  ['Amazon', 'Your Amazon package TBA123456789012 has shipped.', 'TBA123456789012'],
]

test.each(FIXTURES)('finds a %s number', (carrier, text, number) => {
  expect(findParcels(text)).toEqual([{ carrier, number }])
})

test('a bare long number with no carrier or tracking word is not a parcel', () => {
  expect(findParcels('Call me on 420123456789 tomorrow.')).toEqual([])
  expect(findParcels('DPD says hello. Invoice 15501234567890 attached.')).toEqual([])
})

test('the same number twice is one parcel', () => {
  expect(findParcels('UPS 1Z999AA10123456784 … again 1Z999AA10123456784')).toHaveLength(1)
})

test.each([
  ['Your order has shipped.', 'shipped'],
  ['Parcel is out for delivery.', 'out_for_delivery'],
  ['Your parcel was delivered at 10:14.', 'delivered'],
  ['It will be delivered on Friday.', undefined],
  ['Balík jsme odeslali.', 'shipped'],
  ['Zásilka je na cestě.', 'shipped'],
  ['Dnes doručujeme vaši zásilku.', 'out_for_delivery'],
  ['Zásilka byla doručena.', 'delivered'],
  ['Zásilka čeká k doručení v pátek.', undefined],
  ['Balík byl převzat příjemcem.', 'delivered'],
])('state words: %s', (text, state) => {
  expect(parcelState(text)).toBe(state)
})

test('parseParcels carries the state and the eta from the same mail', () => {
  const [p] = parseParcels('PPL tracking number 40012345678 shipped. Expected delivery on 2026-09-03.')
  expect(p).toEqual({ carrier: 'PPL', number: '40012345678', state: 'shipped', eta: '2026-09-03' })
})

test('eta: Czech date, and an impossible one is dropped', () => {
  expect(findEta('Doručení očekáváme 3. 9. 2026.')).toBe('2026-09-03')
  expect(findEta('Expected 2026-02-31')).toBeUndefined()
})

test('a parcel never goes backwards', () => {
  expect(furtherAlong('delivered', 'shipped')).toBe(true)
  expect(furtherAlong('shipped', 'delivered')).toBe(false)
  expect(furtherAlong('shipped', 'shipped')).toBe(false)
})
