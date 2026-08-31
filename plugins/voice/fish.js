// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * The second engine: a voice cloned from a clip, and expression (M7-4).
 *
 * **Why there is a second engine at all**, and it is a measurement rather than a preference.
 * The predecessor's local clone path loaded a model into this machine's 8 GB of VRAM on
 * every call — 10–30 s of load plus roughly 10 s per twenty words, measured 2026-08-13, so
 * a 500-character reply took two minutes to arrive. Piper is fast and cannot clone; the
 * local cloner clones and is unusable. A cloud call has no model to load, returns Ogg/Opus
 * natively — which is what a Telegram voice bubble wants (M7-5) — and is the only one of the
 * three that can be told *how* to say something.
 *
 * **M2-4's refusal is not overturned, it is priced.** That task refused a cloud vendor as
 * the *default*, and it still is: Piper speaks unless somebody has picked a cloned voice,
 * and picking one is the yes. What this costs is stated on the screen rather than buried —
 * a key, an account, and words leaving this machine to be spoken.
 *
 * **No dependency.** `fetch`, `FormData` and `Blob` are Node's own, and one HTTP client does
 * not justify an ask.
 *
 * **What is verified and what is not.** The synthesis and listing shapes are the ones the
 * predecessor ran live against a real key on 2026-08-13; `s2.1-pro-free` is pinned because
 * the vendor's own default is paid and answers 402 on an account with no API credit, which
 * was the difference between this working and not working at all. **The clone-creation call
 * below has not been run against the live API from this repo** — there is no key on this
 * machine — so it is written from the published shape and says so. First run with a real key
 * is where it gets confirmed, and the failure is a readable message rather than a mystery.
 */

/**
 * Where the API is.
 *
 * An object rather than a string for the reason `OLLAMA` is one in core: it is the single
 * seam, and a test pointing it at a stub is the only way to check a request shape without a
 * key and somebody's money. Nothing in the product ever writes to it.
 */
export const HOST = { at: 'https://api.fish.audio' }

/**
 * The model family, pinned rather than left to the vendor's default, for two reasons.
 *
 * The default is paid and returns 402 on an account with no API credit — billed separately
 * from platform credit — and `-free` is the same S2 family with none needed. And **the
 * marker syntax differs by family**: S2 takes `[marker]`, the legacy S1 takes `(marker)`.
 * `expression.js` emits square brackets, so the two must not drift apart silently.
 */
export const MODEL = 's2.1-pro-free'

/** How a cloned voice is named in this plugin's own list. Everything else is a Piper stem. */
export const PREFIX = 'cloud:'

export const idOf = (voice) => (voice.startsWith(PREFIX) ? voice.slice(PREFIX.length) || undefined : undefined)

/** What Telegram wants (M7-5). `wav` is what the local engine makes, so it stays the default. */
export const FORMATS = ['wav', 'mp3', 'opus']

/**
 * One call, with the vendor's own explanation kept and the key never in it.
 *
 * A person debugging a dead voice note needs the cause, and the cause is usually the
 * sentence the API sent back — but a key that reaches a log line is a key in a bug report.
 */
async function call(path, { key, method = 'GET', body, headers = {}, signal }) {
  let response
  try {
    response = await fetch(`${HOST.at}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...headers },
      ...(body !== undefined && { body }),
      ...(signal && { signal }),
    })
  } catch (error) {
    throw new Error(`fish.audio is unreachable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  if (!response.ok) {
    const said = await response.text().catch(() => '')
    let detail = said.slice(0, 300)
    try {
      const payload = JSON.parse(said)
      detail = String(payload.message ?? payload.detail ?? detail)
    } catch {
      // Not JSON. The raw body is still the most useful thing there is.
    }
    throw new Error(`fish.audio said ${response.status}${detail ? `: ${detail.split(key).join('<key>')}` : ''}`)
  }
  return response
}

/**
 * A voice cloned from one clip and its transcript.
 *
 * Fifteen seconds is the ask; the length is the caller's business and the vendor's, not
 * this file's. The transcript goes with it because a cloner told what was said produces a
 * better voice than one guessing.
 */
export async function clone(key, { name, wav, transcript, signal }) {
  const form = new FormData()
  form.set('title', name)
  form.set('type', 'tts')
  form.set('train_mode', 'fast')
  // Private. A voice of somebody's own is not something to publish on their behalf, and a
  // default that did would be the worst kind of surprise.
  form.set('visibility', 'private')
  form.set('texts', transcript)
  form.set('voices', new Blob([await readFile(wav)]), basename(wav))

  const response = await call('/model', { key, method: 'POST', body: form, signal })
  const made = (await response.json().catch(() => ({})))
  const id = String(made._id ?? made.id ?? '')
  if (!id) throw new Error('fish.audio made a voice but did not say which one, so there is nothing to select.')
  return { id, name: String(made.title ?? name) }
}

/**
 * One page of the vendor's catalogue, in this plugin's own shape.
 *
 * The same endpoint answers *my voices* and *everyone's*; what differs is the query, so it
 * is one function rather than two that would drift.
 */
async function listing(key, query, signal) {
  const response = await call(`/model?${query}`, { key, signal })
  const payload = await response.json().catch(() => ({}))
  return (Array.isArray(payload.items) ? payload.items : [])
    // A model still training is listed and cannot speak, so offering one would be offering a
    // voice that fails at the moment somebody uses it.
    .filter((item) => item && (item.state === undefined || item.state === 'trained'))
    .map((item) => ({
      id: String(item._id ?? ''),
      name: String(item.title ?? '(untitled)'),
      tags: (Array.isArray(item.tags) ? item.tags : []).map(String),
      likes: Number(item.like_count) || 0,
      by: String(item.author?.nickname ?? ''),
    }))
    .filter((one) => one.id !== '')
}

/** The voices on this account — the ones cloning put there. */
export const mine = (key, signal) => listing(key, 'self=true&page_size=100', signal)

/**
 * The voices everybody else published (M7-4 left this out, and the predecessor had it).
 *
 * **Filtering is not optional in practice.** The catalogue is mostly not English — the
 * predecessor sampled 300 live models and found 41% — so an unfiltered search answers with
 * Spanish and Russian voices and reads as a bug rather than as breadth. That is why the
 * panel defaults the language filter to on rather than to everything.
 *
 * **Tag casing matters and is fixed here rather than asked of the caller.** The vendor's
 * real tags are lowercase and hyphenated (`character-voice`), confirmed by the same sample;
 * a filter sending `Character Voice` matches nothing, which looks like an empty catalogue
 * instead of a mistake.
 */
export async function search(key, { text, tags = [], languages = [], count = 5, signal } = {}) {
  const query = new URLSearchParams([
    ['page_size', String(Math.max(1, Math.min(50, Number(count) || 5)))],
    ['page_number', '1'],
    ['sort_by', 'score'],
    ...(text ? [['title', text]] : []),
    ...tags.map((tag) => ['tag', String(tag).trim().toLowerCase()]),
    ...languages.map((one) => ['language', String(one).trim().toLowerCase()]),
  ])
  return listing(key, String(query), signal)
}

export async function remove(key, id, signal) {
  await call(`/model/${encodeURIComponent(id)}`, { key, method: 'DELETE', signal })
}

/**
 * Text in, audio bytes out.
 *
 * `text` may carry `[marker]` tags and they are **passed through untouched**. Inventing or
 * stripping one here would make `expression.js` impossible to debug — filtering is that
 * file's job and only that file's.
 */
export async function say(key, { text, id, format = 'wav', signal }) {
  const response = await call('/v1/tts', {
    key,
    method: 'POST',
    // The family goes in a header rather than the body. That is the vendor's own shape.
    headers: { 'content-type': 'application/json', model: MODEL },
    body: JSON.stringify({ text, reference_id: id, format }),
    signal,
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('fish.audio returned no audio at all.')
  return bytes
}
