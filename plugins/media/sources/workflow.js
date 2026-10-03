// SPDX-License-Identifier: AGPL-3.0-only
import { isApi } from '../workflows.js'
import { customNodeTypes } from './nodes.js'

export function formatOf(doc) {
  if (isApi(doc)) return 'api'
  if (Array.isArray(doc?.nodes) && doc.nodes.length > 0 && doc.nodes.every((node) => typeof node?.type === 'string')) return 'editor'
  throw new Error('That attachment is not a ComfyUI API graph or editor workflow.')
}

const FILES = /\.(?:safetensors|ckpt|sft|pt|pth|bin|gguf|onnx)$/i
const FOLDERS = { ckpt_name: 'checkpoints', unet_name: 'diffusion_models', lora_name: 'loras', vae_name: 'vae', clip_name: 'text_encoders', clip_name1: 'text_encoders', clip_name2: 'text_encoders', control_net_name: 'controlnet', model_name: undefined }

/** Filenames are facts, download URLs are not inferred. Newer editor nodes embed model descriptors. */
export function modelsOf(workflow) {
  const found = new Map()
  const take = (model) => {
    if (typeof model?.name !== 'string' || !model.name) return
    found.set(`${model.folder ?? ''}:${model.name}`, { ...found.get(`${model.folder ?? ''}:${model.name}`), ...model })
  }
  if (Array.isArray(workflow?.nodes)) {
    for (const node of workflow.nodes) {
      for (const model of Array.isArray(node?.properties?.models) ? node.properties.models : []) {
        take({ name: model?.name, ...(typeof model?.url === 'string' && model.url.startsWith('https://') && { url: model.url }), ...(typeof model?.directory === 'string' && { folder: model.directory }), ...(Number.isFinite(model?.bytes) && model.bytes > 0 && { bytes: model.bytes }) })
      }
      // Widget positions differ between packs. A filename can be listed without guessing its folder.
      for (const value of Array.isArray(node?.widgets_values) ? node.widgets_values : []) {
        if (typeof value === 'string' && FILES.test(value) && ![...found.values()].some((model) => model.name === value)) take({ name: value })
      }
    }
  } else {
    for (const node of Object.values(workflow ?? {})) {
      for (const [key, value] of Object.entries(node?.inputs ?? {})) {
        if (Object.hasOwn(FOLDERS, key) && typeof value === 'string' && FILES.test(value)) {
          take({ name: value, ...(FOLDERS[key] && { folder: FOLDERS[key] }) })
        }
      }
    }
  }
  return [...found.values()]
}

export function fetched(workflow, about) {
  return { workflow, format: formatOf(workflow), ...about, nodes: customNodeTypes(workflow), models: modelsOf(workflow) }
}
