---
name: picture-prompts
description: How to ask for a picture on this machine — which installed model suits the
  request, how to write for it, and when to reuse the last one. Use before calling anything
  that provides image.generate, or before run_workflow or pick_workflow.
license: AGPL-3.0-only
---

The model does most of the work. Your job is to pick the right one and write the way it
expects to be written to.

## Which model

**Never name a model from memory.** The checkpoints installed here are whatever this person
downloaded, and a name that is not on the machine is refused rather than substituted. Call
`models` to see what there is, and match on any part of a filename.

Two families behave completely differently and the words in the request tell you which:

- **Anime, illustration, manga, character art** — an anime checkpoint. These are usually
  Illustrious, Pony or NoobAI derivatives, and their names say so.
- **Photo, portrait, realistic, cinematic, product shot** — a photographic checkpoint.
  Names tend to carry *realistic*, *photo* or *cyber*.

**When the request implies neither, do not name a model at all.** Swapping checkpoints costs
ten to twenty seconds of loading, so leaving it out uses whatever is already warm — which is
the right trade for *make me a picture of a castle*. Name one only when the style is the
point.

## How to write the prompt

**Match the model's family, because they were trained on different things.**

- **Anime checkpoints want tags**, comma-separated, roughly most-important first:
  `1girl, solo, silver hair, red coat, snowy street, night, cinematic lighting`. Quality tags
  at the front (`masterpiece, best quality`) are conventional and help. Prose confuses them.
- **Photographic checkpoints want a sentence.** Subject, setting, lighting, lens, mood:
  *a weathered fisherman mending nets on a stone pier, overcast morning light, shallow depth
  of field*. Tag soup makes them produce something flat.

**Say what the picture shows, not what you want the viewer to feel.** *Melancholy* is not
something a diffusion model can draw; *rain on an empty platform, one figure under a single
lamp* is.

**The negative is for artefacts, not for absence.** `blurry, watermark, extra fingers, text`
belongs there. *No cars* mostly does not work — describe the scene you do want instead.

## Size and speed

The default is fast on purpose, so the first picture arrives in seconds. Turn it up when the
person asks for it — *better*, *bigger*, *more detail* — and not before. Portrait and
landscape are worth setting when the subject implies one; a portrait at `768×1152` is better
than a square one cropped in somebody's head.

## Settings from the conversation

**What the person sets is kept.** *Make it wider*, *more steps*, *use the anime model* — pass
that one value (`width`, `steps`, `model` on `generate`; the field by name in `values` on
`run_workflow`) and it stays set for that workflow on every picture after, until they change it.
Do not re-send settings they gave earlier; the plugin already has them. When they say *back to
normal* or *reset the size*, call `reset_workflow` (with `fields` for just some).

**A plain request uses the workflow and model used last.** Do not name a workflow or model
unless the person did. If what was used last is gone, the result says so — tell them.

**Every result lists the settings and the seed it actually used.** Read them from there rather
than guessing: *what seed was that?* and *same settings, but a cat* are answered from it.

## Pictures to start from

When the person attaches a picture or points at one and wants it changed, restyled or used as a
reference, pass its path in `images`. On `generate` it is redrawn from that picture; `strength`
is *how much to change* — about 0.3 for a light touch-up, the 0.6 default for a restyle, 0.8 and
up to keep only the composition. On `run_workflow` pictures fill the workflow's picture fields
in order (or by field name in `values`). Only ever pass a path the person gave you.

## Saying *again*

When the person says *again*, *same seed*, *same but bigger*, *that one at night* — pass `again: true` (on `generate` or `run_workflow`).
Without that flag a new seed is rolled, and you would get a different picture that merely
matches the new words. The last result names its seed, so `seed` works too. Anything you do name still wins, so
`again: true` with a new size is exactly *same picture, bigger*.

## When the quick path is not enough

`generate` is one plain pipeline. A request needing a pose, a specific
character, a LoRA, an upscale, video or speech wants `run_workflow` instead — call
`workflows` to see what this machine has and what fields each one takes. The fields are named
by whoever built the workflow, so read them rather than guessing.

## A task rather than a picture

*Remove the background*, *upscale this*, *fix her face*, *make it look like this painting*,
*read this aloud*, *say it in my voice*, *make this photo move* — call `pick_workflow` with the
person's own words first. It answers the installed workflow to run with `run_workflow`, or, when
none is installed, which one would do it, its download size and whether it fits the graphics card.
Say that size to the person and ask before calling `install_workflow` with `confirmed: true`;
never install without a yes. On a paired computer, installing puts it on that computer's setup
list, where the person presses Install. If no task matches, `find_workflow` searches everything
ComfyUI ships and `search_community` searches community sources.

Only clone a voice with its owner's agreement.
