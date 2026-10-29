// SPDX-License-Identifier: AGPL-3.0-only
export const DAY = 86400000
export const TYPES = {
  HKWorkoutTypeIdentifier: 'workout',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'active_energy',
  HKQuantityTypeIdentifierAppleExerciseTime: 'exercise_minutes',
  HKQuantityTypeIdentifierRestingHeartRate: 'resting_heart_rate',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'hrv',
}
export const METRICS = Object.values(TYPES)
export const EVENT_TYPES = ['workout.ended', 'place.arrived', 'place.left', 'location.snapshot']
export function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp')
  return Date.parse(value)
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) throw new Error('Invalid identifier')
  return value
}
function finite(value, min = 0, max = 1e9) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid measurement')
  return value
}
export function eventOf(raw, device, places, now = Date.now()) {
  if (raw?.schemaVersion !== 1 || raw.deviceId !== device || !device || !EVENT_TYPES.includes(raw.type)) throw new Error('Unknown event schema, device or type')
  const at = timestamp(raw.occurredAt)
  if (at > now + 300000) throw new Error('Event is in the future')
  const payload = raw.payload ?? {}
  const place = ['place.arrived', 'place.left'].includes(raw.type) ? identifier(payload.placeId) : null
  if (place && !Object.hasOwn(places, place)) throw new Error('Unknown place')
  if (typeof raw.eventId !== 'string' || !/^[a-zA-Z0-9_.:, \u00a0\u202f-]{1,200}$/.test(raw.eventId)) throw new Error('Invalid event identifier')
  const result = { id: raw.eventId, type: raw.type, at, place }
  if (raw.type === 'location.snapshot' && payload.latitude !== undefined) {
    const coordinate = (value) => typeof value === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(',', '.')) : value
    result.coordinates = { latitude: finite(coordinate(payload.latitude), -90, 90), longitude: finite(coordinate(payload.longitude), -180, 180) }
  }
  return result
}
export function healthOf(raw) {
  if (raw?.schemaVersion !== 1) throw new Error('Unsupported Hozz schema; expected v1')
  const metric = TYPES[raw.type]
  if (!metric) return null // Explicitly excluded categories never enter storage.
  if (raw.kind === 'typeCoverage') return {
    coverage: metric, at: timestamp(raw.observedAt), complete: raw.complete === true && raw.state === 'anchorClosed',
    // Exporter-supplied text: keep only a bounded identifier such as 'draining'.
    state: typeof raw.state === 'string' && /^[A-Za-z]{1,40}$/.test(raw.state) ? raw.state : null,
  }
  const id = identifier(raw.canonicalId)
  if (raw.sourceRecord?.store !== 'apple.healthkit' || raw.sourceRecord?.id !== raw.id || id !== `apple.healthkit:${identifier(raw.id)}`) throw new Error('Invalid Health identity')
  const version = finite(raw.recordVersion, 1)
  if (!Number.isInteger(version)) throw new Error('Invalid record version')
  if (raw.kind === 'deletion') return { id, metric, version, deleted: true }
  const start = timestamp(raw.startDate), end = timestamp(raw.endDate)
  if (end < start || end - start > 31 * DAY) throw new Error('Invalid interval')
  const product = String(raw.source?.productType ?? raw.device?.model ?? '')
  const source = identifier(raw.source?.bundleIdentifier)
  const rank = /^Watch/i.test(product) ? 0 : /^iPhone/i.test(product) ? 1 : 2
  const result = { id, metric, version, start, end, source, rank, deleted: false }
  if (metric === 'workout') {
    if (raw.kind !== 'workout') throw new Error('Invalid workout')
    result.value = finite(raw.duration)
    result.activity = finite(raw.activityType, 1, 10000)
    result.unit = 's'
  } else if (metric === 'sleep') {
    if (raw.kind !== 'category' || ![0, 1, 2, 3, 4, 5].includes(raw.value)) throw new Error('Unsupported sleep stage')
    result.value = raw.value
    result.unit = 'stage'
  } else {
    if (raw.kind !== 'quantity') throw new Error('Invalid quantity')
    const conversions = {
      steps: { count: [1, 'count'] }, active_energy: { kcal: [1, 'kcal'], kJ: [1 / 4.184, 'kcal'] },
      exercise_minutes: { min: [1, 'min'], s: [1 / 60, 'min'] },
      resting_heart_rate: { 'count/min': [1, 'bpm'] }, hrv: { ms: [1, 'ms'], s: [1000, 'ms'] },
    }
    const conversion = conversions[metric]?.[raw.quantity?.unit]
    if (!conversion) throw new Error('Unsupported unit')
    result.value = finite(raw.quantity.value) * conversion[0]
    result.unit = conversion[1]
  }
  return result
}
export function decodeHealth(text) {
  const trimmed = text.trim()
  const rows = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  if (!Array.isArray(rows) || rows.length > 50000) throw new Error('Invalid or oversized batch')
  return rows.map(healthOf).filter(Boolean)
}
export function placesOf(text = '{}') {
  const value = JSON.parse(text)
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 50) throw new Error('Places must be an object')
  for (const [id, name] of Object.entries(value)) {
    identifier(id)
    if (typeof name !== 'string' || !/^[\p{L}\p{N} .'-]{1,40}$/u.test(name)) throw new Error('Use short place labels without instructions or addresses')
  }
  return value
}
