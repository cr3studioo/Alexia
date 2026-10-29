// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { DAY, decodeHealth, eventOf, METRICS } from './schema.js'
import { daily, weekly, dateKey, workoutPattern, latestSleep, pieces } from './summary.js'
export const hash = (text) => createHash('sha256').update(text).digest('hex')
export class ContextStore {
  constructor(path, { now = () => Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone, preferences = {} } = {}) {
    dateKey(0, zone)
    this.now = now; this.zone = zone; this.preferences = preferences
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, metric TEXT, version INTEGER, start REAL, end REAL, body TEXT, tombstone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS coverage(metric TEXT PRIMARY KEY, at REAL, complete INTEGER);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at REAL, type TEXT, body TEXT, received REAL);
      CREATE TABLE IF NOT EXISTS batches(hash TEXT PRIMARY KEY, at REAL);
      CREATE TABLE IF NOT EXISTS summaries(day TEXT, metric TEXT, body TEXT, PRIMARY KEY(day,metric));
      CREATE TABLE IF NOT EXISTS suppressed(id INTEGER PRIMARY KEY, start REAL, end REAL, metric TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE INDEX IF NOT EXISTS record_dates ON records(start,end);
      CREATE INDEX IF NOT EXISTS event_dates ON events(at);`)
    if (!this.db.prepare('PRAGMA table_info(records)').all().some((column) => column.name === 'tombstone')) {
      this.db.exec('ALTER TABLE records ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0; UPDATE records SET tombstone=1 WHERE body IS NULL')
    }
    if (!this.db.prepare('PRAGMA table_info(coverage)').all().some((column) => column.name === 'state')) this.db.exec('ALTER TABLE coverage ADD COLUMN state TEXT')
  }
  close() { this.db.close() }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)) }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined }
  blocked(start, end, metric) {
    return !!this.db.prepare("SELECT 1 FROM suppressed WHERE (metric=? OR metric='all') AND start<=? AND end>=? LIMIT 1").get(metric, end, start)
  }
  ingestHealth(text) {
    const digest = hash(text)
    if (this.db.prepare('SELECT 1 FROM batches WHERE hash=?').get(digest)) return { status: 'duplicate' }
    const rows = decodeHealth(text)
    if (!rows.length) return { status: 'accepted', records: 0 }
    return this.transaction(() => {
      const cutoff = this.now() - 365 * DAY
      let accepted = 0
      const dirty = new Set()
      for (const r of rows) {
        if (r.coverage) {
          this.db.prepare('INSERT INTO coverage(metric,at,complete,state) VALUES (?,?,?,?) ON CONFLICT(metric) DO UPDATE SET at=excluded.at,complete=excluded.complete,state=excluded.state WHERE excluded.at>coverage.at').run(r.coverage, r.at, Number(r.complete), r.state)
          continue
        }
        const old = this.db.prepare('SELECT * FROM records WHERE id=?').get(r.id)
        if (old && old.version >= r.version) continue
        if (!r.deleted && (r.start > this.now() + 300000 || this.blocked(r.start, r.end, r.metric))) continue
        if (!r.deleted && r.end < cutoff && !old) continue
        // An archived summary must not retain a corrected/deleted source record.
        for (const record of [old, r]) {
          if (record?.start != null && record?.end != null) for (const [day] of pieces(record.start, record.end, this.zone)) dirty.add(`${day}/${record.metric}`)
        }
        if (old) {
          this.db.prepare("DELETE FROM summaries WHERE EXISTS(SELECT 1 FROM json_each(json_extract(body,'$.ids')) WHERE value=?)").run(r.id)
        }
        this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?)').run(r.id, r.metric, r.version, r.start ?? old?.start ?? null, r.end ?? old?.end ?? null, r.deleted || r.end < cutoff ? null : JSON.stringify(r), Number(r.deleted))
        accepted++
      }
      this.rebuild(dirty)
      this.db.prepare('INSERT INTO batches VALUES (?,?)').run(digest, this.now())
      this.set('lastHealthReceived', this.now())
      return { status: 'accepted', records: accepted }
    })
  }
  ingestEvent(raw, device, places) {
    const event = eventOf(raw, device, places, this.now())
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id)) return { status: 'duplicate' }
      if (this.blocked(event.at, event.at, 'events')) return { status: 'suppressed' }
      if (event.at < this.now() - 365 * DAY) return { status: 'expired' }
      if (event.at < this.now() - DAY) delete event.coordinates
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(event.id, event.at, event.type, JSON.stringify(event), this.now())
      this.set('lastEventReceived', this.now())
      return { status: 'accepted' }
    })
  }
  rows() { return this.db.prepare('SELECT body FROM records WHERE body IS NOT NULL').all().map((r) => JSON.parse(r.body)) }
  rebuild(dirty) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO summaries VALUES (?,?,?)')
    if (dirty) {
      for (const key of dirty) {
        const [day, metric] = key.split('/')
        const noon = Date.parse(`${day}T12:00:00Z`)
        const rows = this.db.prepare('SELECT body FROM records WHERE body IS NOT NULL AND start<=? AND end>=?').all(noon + 2 * DAY, noon - 2 * DAY).map((r) => JSON.parse(r.body))
        // Only affected days are recalculated; archived unaffected days remain intact.
        this.db.prepare('DELETE FROM summaries WHERE day=? AND metric=?').run(day, metric)
        for (const row of daily(rows, this.zone, this.preferences).filter((r) => r.day === day && r.metric === metric)) insert.run(row.day, row.metric, JSON.stringify(row))
      }
    } else {
      const cutoffDay = dateKey(this.now() - 365 * DAY, this.zone)
      this.db.prepare('DELETE FROM summaries WHERE day>=?').run(cutoffDay)
      for (const row of daily(this.rows(), this.zone, this.preferences)) insert.run(row.day, row.metric, JSON.stringify(row))
    }
    const workouts = this.db.prepare("SELECT body FROM records WHERE metric='workout' AND body IS NOT NULL").all().map((r) => JSON.parse(r.body))
    const chosen = new Set(daily(workouts, this.zone, this.preferences).flatMap((r) => r.ids))
    this.set('pattern', workoutPattern(workouts.filter((r) => chosen.has(r.id)), this.zone))
  }
  maintain() {
    this.transaction(() => {
      this.db.prepare('UPDATE records SET body=NULL WHERE end<?').run(this.now() - 365 * DAY)
      this.db.prepare('DELETE FROM events WHERE at<?').run(this.now() - 365 * DAY)
      const rows = this.db.prepare("SELECT id,body FROM events WHERE type='location.snapshot' AND at<?").all(this.now() - DAY)
      for (const row of rows) { const event = JSON.parse(row.body); delete event.coordinates; this.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event), row.id) }
      this.db.prepare('DELETE FROM batches WHERE at<?').run(this.now() - 30 * DAY)
    })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  summaries(from = '0000-01-01', through = '9999-12-31', metric) {
    const rows = this.db.prepare('SELECT body FROM summaries WHERE day>=? AND day<=? ORDER BY day DESC').all(from, through).map((r) => JSON.parse(r.body))
    return rows.filter((r) => !metric || r.metric === metric).map((r) => ({ day: r.day, metric: r.metric, value: r.value, unit: r.unit, samples: r.samples, ...(r.workouts !== undefined && { workouts: r.workouts }) }))
  }
  trends({ from, through, metric, interval = 'day' } = {}) {
    const rows = this.summaries(from, through, metric)
    return { rows: (interval === 'week' ? weekly(rows) : rows).slice(0, 400), pattern: metric === 'workout' ? this.get('pattern') : undefined, coverage: this.coverage(), note: 'Observed records only; missing measurements are unknown. Sleep is elapsed sleep allocated by local calendar day. Comparisons are descriptive, not causal.' }
  }
  coverage() {
    return this.db.prepare('SELECT metric,at,complete,state FROM coverage ORDER BY metric').all().map((r) => ({
      metric: r.metric, observedAt: new Date(r.at).toISOString(), complete: !!r.complete,
      ...(r.state && { state: r.state }),
      // Without Health permission nothing arrives, which must not read as "no activity".
      ...(/^authorization/.test(r.state ?? '') && { note: 'Not shared by the iPhone exporter; Health permission for this category is missing.' }),
    }))
  }
  workouts(from = 0, through = this.now(), limit = 100) {
    return this.db.prepare("SELECT body FROM records WHERE metric='workout' AND body IS NOT NULL AND start>=? AND start<=? ORDER BY start DESC LIMIT ?").all(from, through, limit).map((row) => JSON.parse(row.body)).map((r) => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), durationMinutes: Math.round(r.value / 60), activityType: r.activity }))
  }
  events(places, from = 0, through = this.now()) {
    return this.db.prepare('SELECT body FROM events WHERE at>=? AND at<=? ORDER BY at DESC LIMIT 100').all(from, through).map(({ body }) => {
      const e = JSON.parse(body)
      return { type: e.type, occurredAt: new Date(e.at).toISOString(), ...(e.place && { place: places[e.place] ?? 'Previously configured place' }), ...(e.type === 'workout.ended' && { details: this.workoutMatch(e.at) }) }
    })
  }
  workoutMatch(at) {
    const rows = this.db.prepare("SELECT body FROM records WHERE metric='workout' AND body IS NOT NULL AND end BETWEEN ? AND ?").all(at - 5 * 60000, at + 5 * 60000)
    return rows.length === 1 ? 'available' : rows.length > 1 ? 'ambiguous' : 'pending'
  }
  recent(places) {
    const now = this.now(), events = this.events(places, now - 2 * DAY)
    const lastPlace = events.find((e) => e.type.startsWith('place.'))
    const lastWorkout = events.find((e) => e.type === 'workout.ended' && Date.parse(e.occurredAt) >= now - 2 * 3600000)
    return {
      asOf: new Date(now).toISOString(),
      ...(lastWorkout && { workoutEvent: lastWorkout }),
      latestReceivedWorkout: this.workouts(0, now, 1)[0] ?? null,
      place: lastPlace ? { ...lastPlace, state: lastPlace.type === 'place.left' ? 'departed; current place unknown' : now - Date.parse(lastPlace.occurredAt) > 2 * 3600000 ? 'last reported; current place unknown' : 'recently reported arrival' } : null,
      today: this.summaries(dateKey(now, this.zone), dateKey(now, this.zone)),
      sleep: latestSleep(this.db.prepare("SELECT body FROM records WHERE metric='sleep' AND body IS NOT NULL AND end>=?").all(now - 3 * DAY).map((r) => JSON.parse(r.body)), now, this.preferences.sleep),
      lastHealthReceived: this.get('lastHealthReceived') ? new Date(this.get('lastHealthReceived')).toISOString() : null,
      coverage: this.coverage(),
    }
  }
  forget(start, end, metric = 'all') {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || ![...METRICS, 'events', 'all'].includes(metric)) throw new Error('Invalid forgetting range')
    this.transaction(() => {
      this.db.prepare('INSERT INTO suppressed(start,end,metric) VALUES (?,?,?)').run(start, end, metric)
      this.db.prepare("UPDATE records SET body=NULL WHERE start<=? AND end>=? AND (metric=? OR ?='all')").run(end, start, metric, metric)
      this.db.prepare("DELETE FROM summaries WHERE day<=? AND day>=? AND (metric=? OR ?='all')").run(dateKey(end, this.zone), dateKey(start, this.zone), metric, metric)
      if (metric === 'all' || metric === 'events') this.db.prepare('DELETE FROM events WHERE at BETWEEN ? AND ?').run(start, end)
      this.rebuild()
    })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  allowReimport() {
    this.transaction(() => { this.db.exec("DELETE FROM records WHERE body IS NULL AND tombstone=0 AND EXISTS (SELECT 1 FROM suppressed WHERE (suppressed.metric=records.metric OR suppressed.metric='all') AND suppressed.start<=records.end AND suppressed.end>=records.start); DELETE FROM suppressed; DELETE FROM batches;"); this.set('allowReimportAt', this.now()) })
  }
}
