// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Editing profiles under evaluation. **None of these is verified, and none can run.**
 *
 * Each one is a complete description of what Step 0 must measure: the files (by the names their
 * publisher uses, with size and hash left empty until they are checked), the graph, and the
 * settings range. A candidate is promoted by copying it to a verified profile with real hashes,
 * the recorded benchmark and the prompt syntax the benchmark confirmed — never by editing the
 * status here.
 *
 * The graph uses ComfyUI's built-in Qwen-Image-Edit nodes. `TextEncodeQwenImageEditPlus` takes
 * up to three pictures, which is why the editor's limit is three including the target.
 */

const QWEN_EDIT_GRAPH = {
  nodes: {
    1: { class_type: 'UNETLoader', inputs: { unet_name: '', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: '', type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: '' } },
    4: { class_type: 'LoadImage', inputs: { image: '' } },
    5: { class_type: 'LoadImage', inputs: { image: '' } },
    6: { class_type: 'LoadImage', inputs: { image: '' } },
    7: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: '', image1: ['4', 0], image2: ['5', 0], image3: ['6', 0] } },
    8: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: '', image1: ['4', 0] } },
    9: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    10: { class_type: 'CFGNorm', inputs: { model: ['9', 0], strength: 1 } },
    11: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'disabled' } },
    12: { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } },
    13: { class_type: 'KSampler', inputs: { model: ['10', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['12', 0], seed: 0, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    14: { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
    15: { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: 'alexia-edit' } },
  },
  output: '15',
  artifacts: [
    { node: '1', input: 'unet_name', artifact: 'diffusion' },
    { node: '2', input: 'clip_name', artifact: 'text_encoder' },
    { node: '3', input: 'vae_name', artifact: 'vae' },
  ],
  bindings: [
    { node: '4', input: 'image', from: 'image:1' },
    { node: '5', input: 'image', from: 'image:2' },
    { node: '6', input: 'image', from: 'image:3' },
    { node: '7', input: 'prompt', from: 'prompt' },
    { node: '11', input: 'width', from: 'width' },
    { node: '11', input: 'height', from: 'height' },
    { node: '13', input: 'seed', from: 'seed' },
    { node: '13', input: 'steps', from: 'steps' },
  ],
}

/**
 * The same graph with the diffusion model loaded from a 4-bit GGUF by ComfyUI-GGUF's
 * `UnetLoaderGGUF` (city96/ComfyUI-GGUF) — the realistic chance of fitting an 8 GB card. The
 * text encoder stays the fp8 file and is expected to be offloaded; whether the whole application
 * fits 8 GB / 16 GB is exactly what Step 0 must measure.
 */
const QWEN_EDIT_GGUF_GRAPH = {
  ...QWEN_EDIT_GRAPH,
  nodes: { ...QWEN_EDIT_GRAPH.nodes, 1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '' } } },
}

export const CANDIDATES = [
  {
    id: 'qwen-image-edit-2509',
    version: 'candidate-1',
    name: 'Qwen Image Edit 2509',
    status: 'candidate',
    uncensored: false,
    operations: ['image_edit'],
    jobVersions: ['1.1'],
    maxInputs: 3,
    // The syntax the official template uses; Step 0 confirms it before a profile may rely on it.
    prompt: { slot: 'Picture {n}' },
    artifacts: [
      { id: 'diffusion', folder: 'diffusion_models', filename: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors', bytes: null, sha256: null, url: null, license: null },
      { id: 'text_encoder', folder: 'text_encoders', filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', bytes: null, sha256: null, url: null, license: null },
      { id: 'vae', folder: 'vae', filename: 'qwen_image_vae.safetensors', bytes: null, sha256: null, url: null, license: null },
    ],
    nodes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'TextEncodeQwenImageEditPlus', 'ModelSamplingAuraFlow', 'CFGNorm', 'ImageScale', 'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage'],
    graph: QWEN_EDIT_GRAPH,
    settings: {
      dimensions: [{ width: 1024, height: 1024 }, { width: 832, height: 1216 }, { width: 1216, height: 832 }],
      steps: { min: 4, max: 40, default: 20 },
      presets: [],
      seed: { min: 0, max: 2 ** 32 - 1 },
    },
    launchArgs: [],
    evidence: null,
  },
  {
    id: 'qwen-image-edit-2509-q4',
    version: 'candidate-1',
    name: 'Qwen Image Edit 2509 (small, 4-bit)',
    status: 'candidate',
    uncensored: false,
    operations: ['image_edit'],
    jobVersions: ['1.1'],
    maxInputs: 3,
    prompt: { slot: 'Picture {n}' },
    artifacts: [
      // QuantStack/Qwen-Image-Edit-2509-GGUF; size and hash recorded by the Step 0 harness.
      { id: 'diffusion', folder: 'diffusion_models', filename: 'Qwen-Image-Edit-2509-Q4_K_M.gguf', bytes: null, sha256: null, url: null, license: null },
      { id: 'text_encoder', folder: 'text_encoders', filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', bytes: null, sha256: null, url: null, license: null },
      { id: 'vae', folder: 'vae', filename: 'qwen_image_vae.safetensors', bytes: null, sha256: null, url: null, license: null },
    ],
    nodes: ['UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'LoadImage', 'TextEncodeQwenImageEditPlus', 'ModelSamplingAuraFlow', 'CFGNorm', 'ImageScale', 'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage'],
    graph: QWEN_EDIT_GGUF_GRAPH,
    settings: {
      dimensions: [{ width: 1024, height: 1024 }, { width: 832, height: 1216 }, { width: 1216, height: 832 }],
      steps: { min: 4, max: 40, default: 20 },
      presets: [],
      seed: { min: 0, max: 2 ** 32 - 1 },
    },
    launchArgs: [],
    evidence: null,
  },
]
