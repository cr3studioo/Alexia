// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, inflateRawSync } from 'node:zlib'
import { WORKFLOW_MAX } from './http.js'
import { formatOf } from './workflow.js'

/** Read JSON members in memory, never extract an archive into the runtime or execute its files. */
export function workflowsInZip(bytes) {
  const bad = () => { throw new Error('That workflow ZIP is corrupt or uses an unsupported archive format.') }
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) bad()
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  if (count > 100 || at + bytes.readUInt32LE(end + 12) > end) bad()
  let total = 0
  const found = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) bad()
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const checksum = bytes.readUInt32LE(at + 16)
    const compressed = bytes.readUInt32LE(at + 20)
    const size = bytes.readUInt32LE(at + 24)
    const length = bytes.readUInt16LE(at + 28)
    const next = at + 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
    const local = bytes.readUInt32LE(at + 42)
    if (next > end) bad()
    const name = bytes.subarray(at + 46, at + 46 + length).toString('utf8')
    at = next
    if (!name.toLowerCase().endsWith('.json')) continue
    if (flags & 1 || ![0, 8].includes(method) || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) bad()
    total += size
    if (total > WORKFLOW_MAX) throw new Error('That workflow ZIP expands beyond the workflow size limit.')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressed > bytes.length) bad()
    const member = bytes.subarray(start, start + compressed)
    const decoded = method === 8 ? inflateRawSync(member, { maxOutputLength: WORKFLOW_MAX }) : member
    if (decoded.length !== size || crc32(decoded) !== checksum) bad()
    let workflow
    try {
      workflow = JSON.parse(decoded.toString('utf8'))
      formatOf(workflow)
    } catch {
      continue // Manifests and settings JSON beside a graph are not workflows.
    }
    found.push({ name, workflow })
  }
  return found
}
