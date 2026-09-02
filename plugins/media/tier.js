// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which model this machine should be given, and where it goes.
 *
 * **The tier is read from the graphics card rather than asked about**, because the person this
 * plugin is written for does not know how much VRAM they have and should not have to. A wrong
 * answer is not an error message either — it is a picture that takes four minutes, or a card
 * that runs out halfway and returns something black.
 *
 * The tiers are named for what they can hold *while working*, not for the size of the file. A
 * checkpoint has to fit alongside its own working set, the text encoders and the decode.
 */

/**
 * The three rungs.
 *
 * **`high` is not simply *better*, and the table must not pretend otherwise.** A Flux-class model
 * on a twelve-gigabyte card is slower per picture than SDXL on the same card, and somebody who
 * asked for pictures and got a slideshow will not blame the tier. `mid` is the default for that
 * reason and not because it is the middle.
 */
export const TIERS = [
  {
    name: 'small',
    vram: 0,
    label: 'SD 1.5',
    file: 'v1-5-pruned-emaonly-fp16.safetensors',
    url: 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
    bytes: 2_132_625_432,
    licence: 'CreativeML Open RAIL-M',
    size: 512,
  },
  {
    name: 'mid',
    vram: 6e9,
    label: 'SDXL',
    file: 'sd_xl_base_1.0.safetensors',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    bytes: 6_938_078_334,
    licence: 'CreativeML Open RAIL++-M',
    size: 768,
  },
  {
    name: 'high',
    vram: 12e9,
    label: 'SDXL',
    file: 'sd_xl_base_1.0.safetensors',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    bytes: 6_938_078_334,
    licence: 'CreativeML Open RAIL++-M',
    size: 1024,
    // **`high` deliberately fetches the same model as `mid` and only paints bigger.** The
    // obvious candidate is a Flux-class model, and it is not here because its licence is
    // non-commercial — downloading one on somebody's behalf is accepting that on their behalf,
    // which is a decision a person has to make rather than a number this file reads off a card.
    // Until somebody chooses it, a bigger canvas is an honest use of a bigger card.
    note: 'a larger canvas rather than a larger model — see the licence note in tier.js',
  },
]

/** What the card can hold, from `/system_stats`, or nothing when there is no card to ask about. */
export function vram(machine) {
  const card = (machine?.devices ?? []).find((one) => one?.type === 'cuda' || one?.type === 'mps')
  const total = Number(card?.vram_total)
  return Number.isFinite(total) && total > 0 ? { total, name: String(card?.name ?? '').split(':')[0].trim(), type: card.type } : undefined
}

/**
 * The rung for a card of this size. No card at all is `undefined` rather than `small` — those
 * are different answers and only one of them means *this will work, slowly*.
 */
export function tier(total) {
  if (!Number.isFinite(Number(total)) || Number(total) <= 0) return undefined
  return [...TIERS].reverse().find((one) => Number(total) >= one.vram) ?? TIERS[0]
}

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

/**
 * What the card says, in a sentence somebody can act on, *before* they press anything.
 *
 * The rule this exists for: **a plugin card states its size and its setup time before it is
 * pressed.** A progress bar that starts after somebody has committed to a download they were
 * not told about is the failure the whole five-minute setup ceiling exists to prevent.
 */
export function reading(machine, installed = []) {
  const card = vram(machine)
  if (!card) {
    return {
      ok: false,
      tier: undefined,
      said:
        'No graphics card was found, so pictures would take minutes each rather than seconds. ' +
        'Making them through a service instead is coming — Alexia has no way to connect one yet.',
    }
  }
  const rung = tier(card.total)
  if (installed.length > 0) {
    return {
      ok: true,
      tier: rung,
      download: undefined,
      said: `${card.name}, ${gb(card.total)}. ${installed.length} model${installed.length === 1 ? '' : 's'} already installed, so there is nothing to download.`,
    }
  }
  return {
    ok: true,
    tier: rung,
    download: rung,
    said:
      `${card.name}, ${gb(card.total)} — enough for ${rung.label}. ` +
      `Alexia will download it: ${gb(rung.bytes)}, licensed ${rung.licence}.`,
  }
}
