// SPDX-License-Identifier: Apache-2.0

/**
 * Every error code that crosses the wire. `docs/spec/wire-protocol.md` §8 is the document,
 * this is the enforcement, and a test diffs the two so they cannot drift.
 *
 * `-32050`…`-32059` is Alexia's block. MCP holds `-32020`…`-32022`; the rest of that range
 * is theirs to fill and we leave it alone.
 */
export const ErrorCode = {
  // JSON-RPC 2.0.
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // MCP's.
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,

  // Ours.
  CAPABILITY_NOT_AVAILABLE: -32050,
  CAPABILITY_NOT_PERMITTED: -32051,
  STORAGE_OUT_OF_NAMESPACE: -32052,
  SETTING_UNKNOWN: -32053,
  DENIED_BY_USER: -32054,
  CAP_EXCEEDED: -32055,
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
