// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How big, from which seed, and whether the card can take it.
 *
 * Two small decisions that are easy to get subtly wrong and impossible to notice when they are:
 * a precedence order that silently prefers the wrong number, and a warning that either never
 * fires or fires constantly. Both are arithmetic, so both are here rather than in the entry file
 * where nothing can reach them.
 */

/**
 * Rounded to 64.
 *
 * SDXL's latent space is in units of 8 and its training is in units of 64. A model handed
 * 1000×1000 makes something subtly wrong rather than refusing, which is the worst of both.
 */
export const round64 = (n) => Math.max(256, Math.min(2048, Math.round(Number(n) / 64) * 64))

/**
 * The numbers this picture is made at: what was asked for, then the last one, then the default.
 *
 * **`again` is the whole reason this is not three `??` in a row.** *Same but bigger* is one of
 * the commonest things anybody says about a picture, and it cannot be answered from the
 * conversation: the seed was rolled in here and never said out loud, so a model re-sending the
 * prompt produces a different picture that happens to be bigger. Reading the last run back is
 * the only way that sentence can mean what it says — and anything named in the new call still
 * wins over it, because naming a thing is how you say you meant it.
 */
export function measure({ width, height, seed, again } = {}, last = {}) {
  const before = again === true ? (last ?? {}) : {}
  const asked = Number.isFinite(Number(seed))
  const carried = Number.isFinite(Number(before.seed))
  return {
    width: round64(width ?? before.width ?? 768),
    height: round64(height ?? before.height ?? 768),
    seed:
      asked ? Number(seed)
      : carried ? Number(before.seed)
      : Math.floor(Math.random() * 2 ** 31),
    // Worth saying out loud, because *the same picture again* and *a new picture* look identical
    // in a chat until you notice the first one changed.
    reused: !asked && carried,
  }
}

/**
 * Roughly what a decode of this many pixels wants, on top of a model already resident.
 *
 * **Deliberately rough.** It is deciding whether to say a sentence, not what to allocate, and a
 * precise number here would be a lie about a figure that depends on the model, the sampler and
 * what else is on the card. What it is calibrated against is the failure worth pre-empting: an
 * out-of-memory decode does not always throw — on the fp16 path it returns a **black image**,
 * which costs the whole render and explains nothing.
 */
export const wants = (width, height) => ((width * height) / (1024 * 1024)) * 900_000_000

/**
 * The sentence to say when the card looks too full, or nothing.
 *
 * Nothing is the usual answer, and that is the design: a warning that fires on an ordinary
 * picture is a warning nobody reads by the third time. It offers the smaller size rather than
 * refusing, because refusing decides something the person did not ask to have decided.
 */
export function tight({ width, height }, free) {
  // `typeof`, not `Number(…)`: **`Number(null)` is `0`**, so a card that could not be read would
  // have looked like a card with nothing left on it and warned about every picture.
  if (typeof free !== 'number' || !Number.isFinite(free)) return undefined
  if (free > wants(width, height)) return undefined
  return (
    `Your graphics card has ${(Number(free) / 1e9).toFixed(1)} GB free right now, and ${width}×${height} probably ` +
    'wants more than that — it may fail, or come back black. Something else may be using the card. ' +
    'A smaller size would be safer.'
  )
}
