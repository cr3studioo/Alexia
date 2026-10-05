// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The library by what somebody wants done, rather than by what a workflow is called.
 *
 * **Nobody asks for *utility_birefnet_remove_background*.** They ask to remove the background of
 * a photo, and the catalogue ComfyUI ships answers to its own names — 580 of them on the install
 * this was written against, more than half calling a paid service. So this is the short list in
 * the other direction: a handful of named tasks, each pointing at the concrete workflows that do
 * it, with what each needs and whether it fits the card most people paired a computer for.
 *
 * **Every entry was checked against what exists on 2026-10-03, not remembered.** The official
 * ones are names in ComfyUI's own template index (`comfyui_workflow_templates`, read off a v0.38
 * install), with the download total that index states. The community ones are node packs looked
 * up in the Comfy registry (`api.comfy.org/nodes/<id>`) and on GitHub, pinned to the version
 * published that day — a newer version is a decision made in this file, not something an install
 * picks up on its own. Where the registry has no version (facerestore_cf), the pin is a commit.
 *
 * **`fits8gb` is a claim about an 8 GB NVIDIA card, and `note` says how sure it is.** ComfyUI
 * moves what does not fit into system memory and carries on, so *fits* here means *runs at a
 * speed somebody would wait for* — not *loads without an error*, which nearly everything does.
 * Only BiRefNet and the plain resize were measured; the rest are read off the model sizes and
 * say so. `vram` is the working set in bytes, the number compared with the card that renders.
 */

const GB = 1e9

/**
 * The tasks, in the order the library shows them.
 *
 * A workflow is `{ id, source, title, … }`. `source: 'official'` is a ComfyUI template by its
 * catalogue name; its models are read out of the template itself at install time, and `bytes`
 * is the index's own total. `source: 'community'` is a workflow from outside ComfyUI: `url` is
 * the file, `search` is what the community sources are asked when there is no file, and
 * `models` and `packs` are what it needs, each pinned.
 */
export const TASKS = [
  {
    id: 'background',
    title: 'Background remover / changer',
    summary: 'Cut the subject out of a photo, or put it somewhere else.',
    says: ['background', 'the background', 'remove the background', 'change the background', 'replace the background', 'cut out', 'cutout', 'transparent', 'remove bg', 'backdrop'],
    output: 'image',
    workflows: [
      {
        id: 'utility_birefnet_remove_background',
        source: 'official',
        title: 'Remove Background: BiRefNet',
        bytes: 430_000_000,
        vram: 2 * GB,
        fits8gb: true,
        note: 'Measured: a few seconds a picture on an 8 GB card. Removes the background; it does not paint a new one.',
      },
      {
        id: 'image_flux2_klein_image_edit_4b_distilled',
        source: 'official',
        title: 'Flux.2 [Klein] 4B Distilled: Image Edit',
        bytes: 12_460_000_000,
        vram: 7.5 * GB,
        fits8gb: true,
        note: 'To change the background rather than remove it: “put her on a beach”. Tight on 8 GB — the text encoder is kept in system memory. Estimated, not measured.',
      },
      {
        id: 'image_qwen_image_2_1_background_removal',
        source: 'official',
        title: 'Remove Background: Qwen Image 2.1',
        bytes: 21_370_000_000,
        vram: 20 * GB,
        fits8gb: false,
        note: 'Better on hair and glass, and a 20 GB model: on an 8 GB card it would page through system memory for minutes a picture.',
      },
    ],
  },
  {
    id: 'upscale',
    title: 'Upscaler',
    summary: 'Make a picture bigger and sharper.',
    says: ['upscale', 'upscaler', 'bigger', 'higher resolution', 'enlarge', 'sharpen', 'hi-res', 'hires', '4k', 'super resolution'],
    output: 'image',
    workflows: [
      {
        id: 'utility_seedvr2_3b_int8_upscale_image',
        source: 'official',
        title: 'Image Upscale: SeedVR2 3B Int8',
        bytes: 3_970_000_000,
        vram: 6 * GB,
        fits8gb: true,
        note: 'Adds real detail. Encodes and decodes in tiles, which is what keeps it inside 8 GB. Estimated, not measured.',
      },
      {
        id: 'utility_interpolation_image_upscale',
        source: 'official',
        title: 'Image Upscale: Traditional Interpolation',
        bytes: 0,
        vram: 0,
        fits8gb: true,
        note: 'Measured: instant, no model. A plain resize — bigger, not sharper.',
      },
      {
        id: 'utility_seedvr2_7b_int8_upscale_image',
        source: 'official',
        title: 'Image Upscale: SeedVR2 7B Int8',
        bytes: 8_800_000_000,
        vram: 10 * GB,
        fits8gb: false,
        note: 'The larger SeedVR2. Its model alone is bigger than an 8 GB card.',
      },
    ],
  },
  {
    id: 'edit',
    title: 'Image edit (by instruction)',
    summary: 'Change a picture by saying what to change: “make it winter”, “remove the man on the left”.',
    says: ['edit', 'change the', 'make it', 'replace', 'remove the', 'add a', 'turn it into', 'instruction'],
    output: 'image',
    workflows: [
      {
        id: 'image_flux2_klein_image_edit_4b_distilled',
        source: 'official',
        title: 'Flux.2 [Klein] 4B Distilled: Image Edit',
        bytes: 12_460_000_000,
        vram: 7.5 * GB,
        fits8gb: true,
        note: 'The one that fits: a 4B model in fp8, with its text encoder kept in system memory. Tight on 8 GB. Estimated, not measured.',
      },
      {
        id: 'flux_kontext_dev_basic',
        source: 'official',
        title: 'Flux Kontext Dev Image Edit',
        bytes: 17_610_000_000,
        vram: 14 * GB,
        fits8gb: false,
        note: 'A 12 GB model even in fp8. Runs on 8 GB only by paging, at minutes a picture. Licence is non-commercial.',
      },
      {
        id: 'image_qwen_image_edit_2509',
        source: 'official',
        title: 'Qwen Image Edit 2509',
        bytes: 31_780_000_000,
        vram: 22 * GB,
        fits8gb: false,
        note: 'The strongest editor in the catalogue, and a 20 GB model.',
      },
    ],
  },
  {
    id: 'inpaint',
    title: 'Inpaint',
    summary: 'Repaint one part of a picture — a masked area — and leave the rest alone.',
    says: ['inpaint', 'inpainting', 'repaint', 'fill in', 'mask', 'fix this part', 'paint over'],
    output: 'image',
    workflows: [
      {
        id: 'image_anima_lllite_image_inpainting',
        source: 'official',
        title: 'Anima Lllite: Image Inpainting',
        bytes: 5_800_000_000,
        vram: 6 * GB,
        fits8gb: true,
        note: 'Fits 8 GB. Anima is an illustration model, so photographs come back looking drawn. Estimated, not measured.',
      },
      {
        id: 'flux_fill_inpaint_example',
        source: 'official',
        title: 'Flux.1 Inpaint',
        bytes: 34_140_000_000,
        vram: 24 * GB,
        fits8gb: false,
        note: 'Photographic, and a 23 GB model in fp16. Licence is non-commercial.',
      },
    ],
  },
  {
    id: 'face',
    title: 'Face restore',
    summary: 'Repair blurred or damaged faces in a photo.',
    says: ['face', 'faces', 'restore', 'old photo', 'blurry face', 'codeformer', 'gfpgan'],
    output: 'image',
    workflows: [
      {
        id: 'community:facerestore_cf',
        source: 'community',
        title: 'Face restore: CodeFormer',
        search: 'face restore codeformer',
        vram: 2 * GB,
        fits8gb: true,
        note: 'CodeFormer is small. The pack downloads its face detector by itself the first time it runs. Estimated, not measured.',
        packs: [
          {
            name: 'facerestore_cf',
            url: 'https://github.com/mav-rik/facerestore_cf',
            // No version is published in the Comfy registry, so the pin is the commit.
            commit: 'ff4d7a5c102441d8f058dd6135797ffb57b6c6ad',
            nodes: ['FaceRestoreCFWithModel', 'FaceRestoreModelLoader'],
          },
        ],
        models: [
          {
            name: 'codeformer.pth',
            directory: 'facerestore_models',
            url: 'https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth',
            bytes: 376_637_898,
          },
        ],
      },
    ],
  },
  {
    id: 'style',
    title: 'Style transfer',
    summary: 'Paint a picture in the style of another one.',
    says: ['style', 'in the style of', 'look like', 'stylize', 'stylise', 'style transfer', 'reference image'],
    output: 'image',
    workflows: [
      {
        id: 'community:ipadapter_style_composition',
        source: 'community',
        title: 'IPAdapter Style & Composition (SDXL)',
        url: 'https://raw.githubusercontent.com/cubiq/ComfyUI_IPAdapter_plus/a0f451a5113cf9becb0847b92884cb10cbdec0ef/examples/ipadapter_style_composition.json',
        search: 'ipadapter style composition sdxl',
        vram: 7.5 * GB,
        fits8gb: true,
        note: 'SDXL with IPAdapter Plus. Tight on 8 GB at 1024 pixels; uses the SDXL model Alexia already sets up. Estimated, not measured.',
        packs: [
          {
            name: 'comfyui_ipadapter_plus',
            url: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus',
            registry: 'comfyui_ipadapter_plus',
            version: '2.0.0',
            nodes: ['IPAdapterUnifiedLoader', 'IPAdapterStyleComposition'],
          },
        ],
        models: [
          {
            name: 'ip-adapter-plus_sdxl_vit-h.safetensors',
            directory: 'ipadapter',
            url: 'https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors',
            bytes: 847_517_512,
          },
          {
            // The name the unified loader looks for, which is not the name it is published under.
            name: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
            directory: 'clip_vision',
            url: 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors',
            bytes: 2_528_373_448,
          },
        ],
      },
      {
        id: 'flux1_dev_uso_reference_image_gen',
        source: 'official',
        title: 'Flux.1 Dev USO Reference Image Generation',
        bytes: 18_580_000_000,
        vram: 16 * GB,
        fits8gb: false,
        note: 'Stronger style matching, and a Flux-sized model. Licence is non-commercial.',
      },
    ],
  },
  {
    id: 'speech',
    title: 'Text to speech / voice generation',
    summary: 'Read text aloud in a chosen voice.',
    says: ['read', 'aloud', 'out loud', 'speak', 'speech', 'say this', 'narrate', 'voice over', 'voiceover', 'tts', 'text to speech'],
    output: 'audio',
    workflows: [
      {
        id: 'community:kokoro',
        source: 'community',
        title: 'Kokoro text to speech',
        search: 'kokoro text to speech',
        vram: 1 * GB,
        fits8gb: true,
        note: 'An 82M-parameter voice model that runs on almost anything. Picks from its own voices; it does not copy one. The pack fetches its model (about 350 MB) the first time it speaks.',
        packs: [
          {
            name: 'comfyui-kokoro',
            url: 'https://github.com/stavsap/comfyui-kokoro',
            registry: 'comfyui-kokoro',
            version: '1.1.4',
            nodes: ['KokoroSpeaker', 'KokoroGenerator'],
          },
        ],
        models: [],
      },
      {
        id: 'community:f5_tts',
        source: 'community',
        title: 'F5-TTS',
        url: 'https://raw.githubusercontent.com/niknah/ComfyUI-F5-TTS/a28b6d5ff9185a3383f6e8e9036f786015fc6651/example_workflows/simple_ComfyUI_F5TTS_workflow.json',
        search: 'f5 tts',
        vram: 3 * GB,
        fits8gb: true,
        note: 'Speaks in the manner of a short sample — a calm sample makes a calm voice. The pack fetches its model (about 1.3 GB) the first time it speaks.',
        packs: [
          {
            name: 'comfyui-f5-tts',
            url: 'https://github.com/niknah/ComfyUI-F5-TTS',
            registry: 'comfyui-f5-tts',
            version: '1.0.27',
            nodes: ['F5TTSAudio'],
          },
        ],
        models: [],
      },
    ],
  },
  {
    id: 'clone',
    title: 'Voice cloning',
    summary: 'Speak new words in the voice of a recording somebody gives.',
    says: ['clone', 'cloning', 'my voice', 'their voice', 'sound like', 'imitate', 'in the voice of'],
    output: 'audio',
    workflows: [
      {
        id: 'community:f5_tts',
        source: 'community',
        title: 'F5-TTS',
        url: 'https://raw.githubusercontent.com/niknah/ComfyUI-F5-TTS/a28b6d5ff9185a3383f6e8e9036f786015fc6651/example_workflows/simple_ComfyUI_F5TTS_workflow.json',
        search: 'f5 tts voice clone',
        vram: 3 * GB,
        fits8gb: true,
        note: 'Clones from a few seconds of clean speech and its transcript. Only clone a voice with its owner’s agreement.',
        packs: [
          {
            name: 'comfyui-f5-tts',
            url: 'https://github.com/niknah/ComfyUI-F5-TTS',
            registry: 'comfyui-f5-tts',
            version: '1.0.27',
            nodes: ['F5TTSAudio'],
          },
        ],
        models: [],
      },
    ],
  },
  {
    id: 'video',
    title: 'Image to video',
    summary: 'Turn a still picture into a few seconds of moving video.',
    says: ['video', 'animate', 'animation', 'move', 'moving', 'motion', 'clip', 'bring to life', 'make it move', 'i2v'],
    output: 'video',
    workflows: [
      {
        id: 'video_wan2_2_5B_ti2v',
        source: 'official',
        title: 'Wan 2.2 5B Video Generation',
        bytes: 18_150_000_000,
        vram: 8 * GB,
        fits8gb: true,
        note: 'The video model ComfyUI says runs on 8 GB, by keeping part of it in system memory — so it wants 32 GB of RAM and several minutes a clip. Estimated, not measured.',
      },
      {
        id: 'video_ltx2_i2v_distilled',
        source: 'official',
        title: 'LTX-2 Image to Video (Distilled)',
        bytes: 38_010_000_000,
        vram: 24 * GB,
        fits8gb: false,
        note: 'Faster per second of video and with sound, and a 19B model.',
      },
    ],
  },
]

const lower = (said) => String(said ?? '').toLowerCase()

/** Every workflow the tasks name, once each, with the tasks it serves. */
export function curated(tasks = TASKS) {
  const found = new Map()
  for (const task of tasks) {
    for (const one of task.workflows) {
      const known = found.get(one.id)
      if (known) known.tasks.push(task.id)
      else found.set(one.id, { ...one, tasks: [task.id] })
    }
  }
  return [...found.values()]
}

/** One curated workflow by id. */
export const curatedOne = (id, tasks = TASKS) => curated(tasks).find((one) => one.id === String(id ?? ''))

/** The task an id names — `background` — or its title, loosely. */
export const task = (id, tasks = TASKS) => {
  const want = lower(id).trim()
  return tasks.find((one) => one.id === want) ?? tasks.find((one) => lower(one.title).includes(want) && want !== '')
}

/**
 * Which task somebody's sentence is asking for, best first.
 *
 * Scored on the phrases each task lists, longest first: *remove the background of this photo*
 * says *remove the* (edit) and *background* (background), and the longer, more specific phrase
 * is the one that meant something. A sentence that matches nothing answers nothing rather than
 * the nearest guess — the caller then says what there is, which beats confidently running the
 * wrong workflow on somebody's photo.
 */
export function tasksFor(asked, tasks = TASKS) {
  const said = ` ${lower(asked).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `
  return tasks
    .map((one) => ({
      task: one,
      score: [one.title.toLowerCase(), ...one.says]
        .filter((phrase) => said.includes(` ${phrase.replace(/[^a-z0-9 ]+/g, ' ').trim()} `) || said.includes(` ${phrase} `))
        .reduce((sum, phrase) => sum + phrase.length, 0),
    }))
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((one) => one.task)
}

/**
 * Whether a workflow fits the card that renders.
 *
 * `true` and `false` when the card is known; `undefined` when it is not — no card read yet, or
 * a workflow whose working set nobody stated — because *probably* is not a thing to print as
 * a tick.
 */
export function fits(workflow, card) {
  if (!card || !Number.isFinite(Number(card.total))) return undefined
  if (!Number.isFinite(Number(workflow?.vram))) return undefined
  return Number(workflow.vram) <= Number(card.total)
}
