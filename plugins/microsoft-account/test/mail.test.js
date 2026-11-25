// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { addressOf, listRequest, mapMessage, messageText, readRequest, stripHtml } from '../mail.js'
import { fakeMicrosoft, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service } = await import('../index.js')

/** One `messages` entry with the list's `$select`, written by hand. */
const listed = (id, { isRead, folder = 'inbox-id', ...rest } = {}) => ({
  '@odata.etag': 'W/"x"',
  id,
  conversationId: `conv-${id}`,
  subject: `Order ${id}`,
  bodyPreview: 'Your order\r\n  and receipt',
  receivedDateTime: '2030-02-22T10:00:00Z',
  isRead,
  isDraft: false,
  importance: 'normal',
  flag: { flagStatus: 'notFlagged' },
  categories: [],
  parentFolderId: folder,
  inferenceClassification: 'focused',
  from: { emailAddress: { name: 'Shop', address: 'shop@example.com' } },
  toRecipients: [{ emailAddress: { name: 'me@example.com', address: 'me@example.com' } }, { emailAddress: { name: 'Jan', address: 'jan@example.com' } }],
  ...rest,
})

describe('mail', () => {
  test('list_never_patches', async () => {
    const ms = fakeMicrosoft((url) => {
      const u = new URL(url)
      if (u.hostname !== 'graph.microsoft.com') return undefined
      if (u.pathname === '/v1.0/me/mailFolders/inbox') return { status: 200, json: { id: 'inbox-id' } }
      if (u.pathname === '/v1.0/me/mailFolders/sentitems') return { status: 200, json: { id: 'sent-id' } }
      if (u.pathname === '/v1.0/me/messages') {
        return {
          status: 200,
          json: {
            value: [
              listed('AAMk1=', { isRead: false, importance: 'high', categories: ['School'], flag: { flagStatus: 'flagged' } }),
              listed('AAMk2=', { isRead: true, folder: 'sent-id', inferenceClassification: 'other' }),
            ],
          },
        }
      }
      if (u.pathname === `/v1.0/me/messages/${encodeURIComponent('AAMk1=')}`) {
        return { status: 200, json: { id: 'AAMk1=', bodyPreview: 'Hello', body: { contentType: 'html', content: '<p>Hello <b>there</b></p>' } } }
      }
      return undefined
    })
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })

    const list = await svc.mailList({ since: '2030-02-01T00:00:00Z', limit: 5 })
    expect(list.isError).toBeUndefined()
    expect(list.structuredContent.messages).toEqual([
      {
        id: 'AAMk1=',
        threadId: 'conv-AAMk1=',
        from: 'Shop <shop@example.com>',
        to: 'me@example.com, Jan <jan@example.com>',
        subject: 'Order AAMk1=',
        snippet: 'Your order and receipt',
        at: Date.parse('2030-02-22T10:00:00Z'),
        unread: true,
        labels: ['UNREAD', 'INBOX', 'IMPORTANT', 'FLAGGED', 'School'],
      },
      {
        id: 'AAMk2=',
        threadId: 'conv-AAMk2=',
        from: 'Shop <shop@example.com>',
        to: 'me@example.com, Jan <jan@example.com>',
        subject: 'Order AAMk2=',
        snippet: 'Your order and receipt',
        at: Date.parse('2030-02-22T10:00:00Z'),
        unread: false,
        labels: ['SENT', 'OTHER'],
      },
    ])
    const read = await svc.mailRead({ id: 'AAMk1=' })
    expect(read.structuredContent).toEqual({ text: 'Hello there' })
    // Folders are looked up once, not on every list.
    await svc.mailList({})

    const graph = ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'))
    expect(graph.length).toBe(5)
    for (const c of graph) {
      expect(c.method).toBe('GET')
      expect(c.body).toBeUndefined()
      expect(c.url).not.toMatch(/\/(move|copy|send|reply|forward|createReply)\b/)
      // Every request names exactly the fields it wants.
      expect(new URL(c.url).searchParams.get('$select')).toBeTruthy()
    }
    expect(ms.calls.some((c) => c.method !== 'GET' && c.method !== 'POST')).toBe(false)
    expect(ms.calls.filter((c) => c.method === 'POST').every((c) => c.url.startsWith('https://login.microsoftonline.com'))).toBe(true)

    const first = new URL(graph.find((c) => new URL(c.url).pathname === '/v1.0/me/messages').url)
    expect(first.searchParams.get('$filter')).toBe('receivedDateTime ge 2030-02-01T00:00:00.000Z')
    expect(first.searchParams.get('$orderby')).toBe('receivedDateTime desc')
    expect(first.searchParams.get('$top')).toBe('5')
    const body = graph.find((c) => c.url.includes(encodeURIComponent('AAMk1=')))
    expect(body.headers.Prefer).toBe('outlook.body-content-type="text"')

    expect(new URL(listRequest({ limit: 500 }).url).searchParams.get('$top')).toBe('50')
    expect((await svc.mailRead({ id: '../../me/sendMail' })).isError).toBe(true)
    expect(() => readRequest('a.b')).toThrow('not a message id')
  })

  test('a search uses $search, and since is applied to the answer', async () => {
    const req = listRequest({ query: 'from:school "quoted" \\x', since: '2030-02-22T09:00:00Z' })
    const url = new URL(req.url)
    expect(url.searchParams.get('$search')).toBe('"from:school quoted x"')
    // Graph refuses $search with $filter or $orderby on mail.
    expect(url.searchParams.has('$filter')).toBe(false)
    expect(url.searchParams.has('$orderby')).toBe(false)
    expect(req.since).toBe(Date.parse('2030-02-22T09:00:00Z'))

    const ms = fakeMicrosoft((u) => {
      if (u.includes('/mailFolders/')) return { status: 404, json: {} }
      if (u.includes('/me/messages')) return { status: 200, json: { value: [listed('new', { isRead: false, receivedDateTime: '2030-02-22T10:00:00Z' }), listed('old', { isRead: true, receivedDateTime: '2030-02-20T10:00:00Z' })] } }
      return undefined
    })
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const found = await svc.mailList({ query: 'from:school', since: '2030-02-22T09:00:00Z' })
    expect(found.structuredContent.messages.map((m) => m.id)).toEqual(['new'])
    // A folder Graph would not name is no label, and no failure.
    expect(found.structuredContent.messages[0].labels).toEqual(['UNREAD'])
    expect(() => listRequest({ since: 'whenever' })).toThrow('`since`')
  })

  test('html_stripped', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      '<script>alert("x")</script><!-- hidden --><h1>Invoice</h1><p>Total:&nbsp;100&nbsp;K&#269; &amp; tax</p>' +
      '<ul><li>One</li><li>Two</li></ul>Line<br>break &lt;ok&gt; &#x2713;</body></html>'
    expect(stripHtml(html)).toBe('Invoice\nTotal: 100 Kč & tax\n- One\n- Two\nLine\nbreak <ok> ✓')

    expect(messageText({ body: { contentType: 'text', content: 'Plain\r\nversion\r\n\r\n\r\n\r\nend' } })).toBe('Plain\nversion\n\nend')
    expect(messageText({ body: { contentType: 'html', content: html } })).toContain('Total: 100 Kč & tax')
    expect(messageText({ bodyPreview: 'Only a preview', body: { contentType: 'text', content: '' } })).toBe('Only a preview')
    expect(messageText({ body: { contentType: 'text', content: 'x'.repeat(30_000) } })).toHaveLength(20_001)

    expect(addressOf({ emailAddress: { name: 'a@x.cz', address: 'a@x.cz' } })).toBe('a@x.cz')
    expect(addressOf({ emailAddress: { name: 'Only a name' } })).toBe('Only a name')
    expect(mapMessage({ id: 'x' })).toMatchObject({ from: '', to: '', subject: '', unread: false, labels: [], at: 0 })
  })
})
