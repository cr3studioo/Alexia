// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { listRequest, mapMessage, messageText, stripHtml } from '../mail.js'
import { fakeGoogle, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service } = await import('../index.js')

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url')

/** `messages.get?format=metadata`, written by hand. */
const meta = (id, unread) => ({
  id,
  threadId: `t-${id}`,
  labelIds: unread ? ['UNREAD', 'INBOX'] : ['INBOX'],
  snippet: 'Your order &amp; receipt',
  internalDate: '1898000000000',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Shop <shop@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: `Order ${id}` },
      { name: 'Date', value: 'Mon, 22 Feb 2030 10:00:00 +0000' },
    ],
  },
})

const full = {
  id: 'm1',
  threadId: 't-m1',
  labelIds: ['UNREAD'],
  snippet: 'snippet',
  payload: {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hello <b>there</b></p>') } }],
      },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'att1', size: 10 } },
    ],
  },
}

describe('mail', () => {
  test('list_never_calls_modify', async () => {
    const google = fakeGoogle((url) => {
      const u = new URL(url)
      if (!u.hostname.startsWith('gmail')) return undefined
      if (u.pathname.endsWith('/messages')) return { status: 200, json: { messages: [{ id: 'm1', threadId: 't-m1' }, { id: 'm2', threadId: 't-m2' }, { id: 'gone', threadId: 'x' }], resultSizeEstimate: 3 } }
      if (u.pathname.endsWith('/m1')) return { status: 200, json: u.searchParams.get('format') === 'full' ? full : meta('m1', true) }
      if (u.pathname.endsWith('/m2')) return { status: 200, json: meta('m2', false) }
      return undefined // 'gone' is a 404: deleted between list and fetch
    })
    const svc = service({ ...settingsOf(google), keep: async () => {}, fetch: google.fetch })

    const listed = await svc.mailList({ query: 'is:unread', since: '2030-02-01T00:00:00Z', limit: 5 })
    expect(listed.isError).toBeUndefined()
    expect(listed.structuredContent.messages).toEqual([
      { id: 'm1', threadId: 't-m1', from: 'Shop <shop@example.com>', to: 'me@example.com', subject: 'Order m1', snippet: 'Your order & receipt', at: 1898000000000, unread: true, labels: ['UNREAD', 'INBOX'] },
      { id: 'm2', threadId: 't-m2', from: 'Shop <shop@example.com>', to: 'me@example.com', subject: 'Order m2', snippet: 'Your order & receipt', at: 1898000000000, unread: false, labels: ['INBOX'] },
    ])
    const read = await svc.mailRead({ id: 'm1' })
    expect(read.structuredContent).toEqual({ text: 'Hello there' })

    const gmail = google.calls.filter((c) => c.url.includes('gmail.googleapis.com'))
    expect(gmail.length).toBe(5)
    for (const c of gmail) {
      expect(c.method).toBe('GET')
      expect(c.body).toBeUndefined()
      expect(c.url).not.toMatch(/modify|trash|batch|untrash|send|drafts/)
    }
    const list = new URL(gmail[0].url)
    expect(list.searchParams.get('q')).toBe(`is:unread after:${Date.parse('2030-02-01T00:00:00Z') / 1000}`)
    expect(list.searchParams.get('maxResults')).toBe('5')
    expect(new URL(gmail[1].url).searchParams.get('format')).toBe('metadata')
    expect(new URL(gmail.at(-1).url).searchParams.get('format')).toBe('full')

    expect(new URL(listRequest({ limit: 500 }).url).searchParams.get('maxResults')).toBe('50')
    expect((await svc.mailRead({ id: '../../modify' })).isError).toBe(true)
  })

  test('html_stripped', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      '<script>alert("x")</script><!-- hidden --><h1>Invoice</h1><p>Total:&nbsp;100&nbsp;K&#269; &amp; tax</p>' +
      '<ul><li>One</li><li>Two</li></ul>Line<br>break &lt;ok&gt; &#x2713;</body></html>'
    expect(stripHtml(html)).toBe('Invoice\nTotal: 100 Kč & tax\n- One\n- Two\nLine\nbreak <ok> ✓')

    // Plain text wins when both are there; the attachment is never read as body.
    const both = {
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Plain\r\nversion') } },
          { mimeType: 'text/html', body: { data: b64('<p>HTML version</p>') } },
        ],
      },
    }
    expect(messageText(both)).toBe('Plain\nversion')
    expect(messageText(full)).toBe('Hello there')
    expect(messageText({ snippet: 'Only a snippet &amp; more', payload: { mimeType: 'text/html' } })).toBe('Only a snippet & more')
    expect(mapMessage({ id: 'x', payload: { headers: [] } })).toMatchObject({ from: '', subject: '', unread: false, labels: [] })
  })
})
