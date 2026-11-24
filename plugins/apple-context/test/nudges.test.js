// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { noticeItems, weeklyLines, nights, hm } from '../nudges.js'

// Synthetic data only, never real readings.
const ZONE = 'UTC'
const TODAY = '2026-10-23'
const HOUR = 3600000
const at = (day, hour) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR
const shift = (day, by) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86400000).toISOString().slice(0, 10)
/** A night that ends at 07:00 on `day` and lasts `hours`. */
const night = (day, hours, id = day) => ({ id, metric: 'sleep', value: 1, source: 'watch', rank: 0, start: at(day, 7) - hours * HOUR, end: at(day, 7) })
const sum = (day, metric, value, extra = {}) => ({ day, metric, value, unit: metric === 'workout' ? 'min' : 'bpm', samples: 1, ...extra })
/** `count` days of resting heart rate ending at `last`, `value(i)` for i days before it. */
const heart = (last, count, value) => Array.from({ length: count }, (_, i) => sum(shift(last, -i), 'resting_heart_rate', value(i)))
const run = (over = {}) => noticeItems({ today: TODAY, zone: ZONE, config: {}, records: [], days: [], ...over })

test('two_short_nights', () => {
  const records = [night(shift(TODAY, -1), 5 + 10 / 60), night(TODAY, 5 + 40 / 60)]
  const [item, ...rest] = run({ records })
  expect(rest).toEqual([])
  expect(item).toEqual({ key: `health:sleep:${TODAY}`, text: 'Two short nights: 5 h 10 and 5 h 40.', why: 'From your sleep data.', urgency: 'low' })
  // A night that crosses midnight is one night, not two part-days.
  expect(nights([{ ...night(TODAY, 8), start: at(TODAY, -1) }], ZONE).map((n) => n.hours)).toEqual([8])
  expect(hm(6 + 5 / 60)).toBe('6 h 05')
})

test('one_short_night_is_nothing', () => {
  expect(run({ records: [night(shift(TODAY, -1), 7.5), night(TODAY, 5)] })).toEqual([])
  expect(run({ records: [night(shift(TODAY, -1), 5), night(TODAY, 7.5)] })).toEqual([])
  // Two short nights that are not consecutive are not "in a row".
  expect(run({ records: [night(shift(TODAY, -2), 5), night(TODAY, 5)] })).toEqual([])
  // The limit is a setting.
  expect(run({ records: [night(shift(TODAY, -1), 6.5), night(TODAY, 6.8)], config: { sleep_hours: 7 } })).toHaveLength(1)
})

test('rest_days_reached', () => {
  const days = (last) => [sum(last, 'workout', 40, { workouts: 1 }), sum(TODAY, 'steps', 4000)]
  // 2026-10-18 is a Sunday, five days before 2026-10-23.
  const [item] = run({ days: days('2026-10-18') })
  expect(item).toEqual({ key: 'health:activity:2026-10-18', text: 'No workout since Sunday.', why: 'From your workouts.', urgency: 'low' })
  expect(run({ days: days('2026-10-19') })).toEqual([])
  expect(run({ days: days('2026-10-19'), config: { rest_days: 4 } })).toHaveLength(1)
  // Past a week the date is named too, so the weekday is not ambiguous.
  expect(run({ days: [sum('2026-10-14', 'workout', 30), sum(TODAY, 'steps', 100)] })[0].text).toBe('No workout since Wednesday 2026-10-14.')
})

test('heart_nudge_fires_on_a_rise_and_heart_is_on_by_default', () => {
  // 3 recent days at 66 against 27 days at 55: median 55, rise 11. No config at all: on.
  const high = [...heart(TODAY, 3, () => 66), ...heart(shift(TODAY, -3), 27, () => 55)]
  const [item, ...rest] = run({ days: high })
  expect(rest).toEqual([])
  expect(item).toEqual({ key: `health:heart:${TODAY}`, text: 'Resting heart rate is higher than usual this week.', why: 'Compared with your last 30 days.', urgency: 'low' })
  // A rise of 9 is not enough.
  expect(run({ days: [...heart(TODAY, 3, () => 64), ...heart(shift(TODAY, -3), 27, () => 55)] })).toEqual([])
  // Too little history says nothing.
  expect(run({ days: heart(TODAY, 5, (i) => (i < 3 ? 80 : 55)) })).toEqual([])
})

test('heart_on_by_default_and_off_when_switched_off', () => {
  const high = [...heart(TODAY, 3, () => 66), ...heart(shift(TODAY, -3), 27, () => 55)]
  expect(run({ days: high, config: { nudge_heart: false } })).toEqual([])
})

test('stale_data_says_nothing', () => {
  const old = shift(TODAY, -3)
  expect(run({ records: [night(shift(old, -1), 5), night(old, 5)] })).toEqual([])
  expect(run({ days: [sum(shift(TODAY, -9), 'workout', 30), sum(old, 'steps', 100)] })).toEqual([])
  expect(run({ days: [...heart(old, 3, () => 70), ...heart(shift(old, -3), 27, () => 55)] })).toEqual([])
  // Nothing at all.
  expect(run()).toEqual([])
  // A workout older than the limit with no recent feed is missing data, not inactivity.
  expect(run({ days: [sum(shift(TODAY, -9), 'workout', 30)] })).toEqual([])
})

test('switched_off_kind_silent', () => {
  const input = {
    records: [night(shift(TODAY, -1), 5), night(TODAY, 5)],
    days: [sum('2026-10-10', 'workout', 30), sum(TODAY, 'steps', 100), ...heart(TODAY, 3, () => 70), ...heart(shift(TODAY, -3), 27, () => 55)],
  }
  expect(run(input).map((i) => i.key.split(':')[1]).sort()).toEqual(['activity', 'heart', 'sleep'])
  expect(run({ ...input, config: { nudge_sleep: false } }).map((i) => i.key.split(':')[1]).sort()).toEqual(['activity', 'heart'])
  expect(run({ ...input, config: { nudge_activity: false } }).map((i) => i.key.split(':')[1]).sort()).toEqual(['heart', 'sleep'])
  expect(run({ ...input, config: { nudge_heart: false } }).map((i) => i.key.split(':')[1]).sort()).toEqual(['activity', 'sleep'])
  expect(run({ ...input, config: { nudge_sleep: false, nudge_activity: false, nudge_heart: false } })).toEqual([])
  // The weekly section follows the same switches.
  const all = weeklyLines({ today: TODAY, zone: ZONE, config: {}, ...input })
  expect(all.map((l) => l.split(':')[0])).toEqual(['Sleep', 'Workouts', 'Resting heart rate'])
  expect(weeklyLines({ today: TODAY, zone: ZONE, config: { nudge_sleep: false, nudge_heart: false }, ...input })).toEqual(['Workouts: 0 this week.'])
  expect(all[0]).toBe('Sleep: 5 h 00 on average over 2 nights, 2 under 6 h 00.')
})

test('keys_by_day', () => {
  const next = shift(TODAY, 1)
  const records = [night(shift(TODAY, -1), 5), night(TODAY, 5)]
  const [first] = run({ records })
  expect(first.key).toBe(`health:sleep:${TODAY}`)
  // The same observation tomorrow keeps its key, so the scheduler dedupes it; a new night makes a new key.
  expect(noticeItems({ today: next, zone: ZONE, config: {}, records, days: [] })[0].key).toBe(first.key)
  const [later] = noticeItems({ today: next, zone: ZONE, config: {}, records: [...records, night(next, 4.5)], days: [] })
  expect(later.key).toBe(`health:sleep:${next}`)
  expect(run({ days: [sum('2026-10-16', 'workout', 30), sum(TODAY, 'steps', 1)] })[0].key).toBe('health:activity:2026-10-16')
})

test('sleep_source_is_chosen_per_night_not_across_history', () => {
  const phone = (day, hours) => ({ ...night(day, hours, `p${day}`), source: 'iphone', rank: 1 })
  const records = [night('2026-06-01', 8), phone(shift(TODAY, -1), 5), phone(TODAY, 5)]
  const [item] = run({ records })
  expect(item.key).toBe(`health:sleep:${TODAY}`)
  expect(run({ records: records.slice(1) })).toEqual(run({ records }))
  expect(weeklyLines({ today: TODAY, zone: ZONE, config: {}, records })[0]).toMatch(/over 2 nights/)
})
