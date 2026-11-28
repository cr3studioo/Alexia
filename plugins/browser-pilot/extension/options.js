// SPDX-License-Identifier: AGPL-3.0-only
/* global chrome, document */
/** The options page: the code and port the owner pastes, the act switch, the status line. */
const $ = (id) => document.getElementById(id)

async function load() {
  const { token, port, act } = await chrome.storage.local.get(['token', 'port', 'act'])
  if (token) $('token').placeholder = 'A code is saved. Paste a new one to replace it.'
  if (Number.isInteger(port)) $('port').value = String(port)
  $('act').checked = act === true
  const { status } = await chrome.storage.session.get('status')
  $('status').textContent = status ?? 'Not connected.'
}

$('setup').addEventListener('submit', async (event) => {
  event.preventDefault()
  const token = $('token').value.trim()
  const port = Number($('port').value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return void ($('status').textContent = 'The port is a number from Alexia’s Browser settings.')
  await chrome.storage.local.set(token ? { token, port } : { port })
  $('token').value = ''
  await load()
})

$('act').addEventListener('change', () => chrome.storage.local.set({ act: $('act').checked }))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.status) $('status').textContent = changes.status.newValue ?? 'Not connected.'
})

void load()
