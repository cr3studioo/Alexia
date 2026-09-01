---
name: picture-prompts
description: How to ask for a picture on this machine — which installed model suits the
  request, how to write for it, and when to reuse the last one. Use before calling anything
  that provides image.generate, or before run_workflow.
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

## Saying *again*

When the person says *again*, *same but bigger*, *that one at night* — pass `again: true`.
**The seed was rolled inside the plugin and was never in this conversation**, so without that
flag you cannot reproduce the picture you are being asked to change; you would get a
different one that merely matches the new words. Anything you do name still wins, so
`again: true` with a new size is exactly *same picture, bigger*.

## When the quick path is not enough

`generate` is one plain pipeline. A request needing a reference image, a pose, a specific
character, a LoRA, an upscale, video or speech wants `run_workflow` instead — call
`workflows` to see what this machine has and what fields each one takes. The fields are named
by whoever built the workflow, so read them rather than guessing.
