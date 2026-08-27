// SPDX-License-Identifier: Apache-2.0
export * from './plugin.js'
export * from './log.js'
export * from './manifest.js'

// Re-exported so a plugin needs one dependency, not two: this is how you turn a JSON Schema
// into the tool input schema `tool()` wants.
export { fromJsonSchema } from '@modelcontextprotocol/server'
