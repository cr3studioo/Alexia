// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createWatcher, diffSummary, isNoiseLine, sha1 } from '../watch.js'
import { WatchError } from '../fetch.js'

const NOW = Date.parse('2026-11-25T07:00:00Z')

/** A watcher over a table of pages, an in-memory store and no portal. */
function make(settings, pages, extra = {}) {
  const store = new Map()
  const statuses = []
  let clock = NOW
  const watcher = createWatcher({
    fetcher: {
      get: async (url) => {
        const page = pages[url]
        if (page === undefined) throw new WatchError(`${new URL(url).host} answered 404 for ${new URL(url).pathname}.`)
        return { status: 200, text: page, url }
      },
    },
    portal: extra.portal ?? { read: async () => ({ ok: false, idle: true }), notice: async () => [] },
    storage: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
    settings: async () => settings,
    status: (s) => statuses.push(s),
    now: () => clock,
  })
  return { watcher, store, statuses, advance: (ms) => (clock += ms) }
}

const html = (...rows) => `<html><body><main>${rows.map((r) => `<p>${r}</p>`).join('')}</main></body></html>`
const items = async (watcher) => (await watcher.noticeItems()).structuredContent.items

test('change_becomes_notice_item', async () => {
  const url = 'https://school.test/timetable'
  const pages = { [url]: html('Mon 9:00 Math', 'Tue 10:00 Czech') }
  const { watcher, statuses } = make({ pages: url }, pages)
  // The first look only learns the page.
  await watcher.run()
  expect(await items(watcher)).toEqual([])

  pages[url] = html('Mon 9:00 Math', 'Tue 11:00 Czech', 'Fri 8:00 Art')
  const round = await watcher.run()
  expect(round.found).toBe(1)
  const [item] = await items(watcher)
  expect(item.urgency).toBe('normal')
  expect(item.key).toMatch(new RegExp(`^pagewatch:${sha1(url)}:[0-9a-f]{40}$`))
  expect(item.text).toBe('school.test/timetable changed: 2 lines added, 1 line removed.')
  expect(item.why.split('\n')).toEqual(['+ Tue 11:00 Czech', '+ Fri 8:00 Art', '- Tue 10:00 Czech'])
  expect(statuses.at(-1)).toBe('● Watching 1 page or feed.')

  // The same change asked about again is the same item, not a second one.
  await watcher.run()
  expect(await items(watcher)).toHaveLength(1)
})

test('same_text_no_item', async () => {
  const url = 'https://school.test/a'
  const pages = { [url]: html('Nothing new') }
  const { watcher } = make({ pages: url }, pages)
  await watcher.run()
  await watcher.run()
  // Markup around the same words is not a change.
  pages[url] = `<html><body><div class="x">   <main><p>Nothing   new</p></main></div><script>1</script></body></html>`
  const round = await watcher.run()
  expect(round.found).toBe(0)
  expect(await items(watcher)).toEqual([])
})

test('diff_is_at_most_ten_lines', () => {
  const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
  const d = diffSummary(before, after)
  expect(d.shown).toHaveLength(10)
  expect(d.summary).toBe('30 lines added, 30 lines removed')
})

test('page_text_returns_the_main_text_or_a_sentence', async () => {
  const url = 'https://school.test/p'
  const { watcher } = make({}, { [url]: '<html><body><nav>x</nav><p>Hello   there</p></body></html>' })
  const ok = await watcher.pageText({ url })
  expect(ok.structuredContent.text).toBe('Hello there')
  const bad = await watcher.pageText({ url: 'https://school.test/none' })
  expect(bad.isError).toBe(true)
  expect(bad.content[0].text).toBe('school.test answered 404 for /none.')
})

test('feeds_become_low_items_and_a_brief_section', async () => {
  const feed = 'https://news.test/feed.xml'
  const rss = (...titles) =>
    `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><link>https://news.test/${encodeURIComponent(t)}</link><guid>${t}-${i}</guid></item>`).join('')}</channel></rss>`
  const pages = { [feed]: rss('Old story') }
  const { watcher, advance } = make({ feeds: feed, interests: 'rozvrh\nškola' }, pages)
  await watcher.run()
  // The first read tells nobody anything.
  expect(await items(watcher)).toEqual([])

  pages[feed] = rss('Nový rozvrh', 'Weather today', 'Skola zavřena', 'Old story')
  advance(60 * 60_000)
  await watcher.run()
  const found = await items(watcher)
  expect(found.map((i) => i.text)).toEqual(['New: Nový rozvrh', 'New: Skola zavřena'])
  expect(found.every((i) => i.urgency === 'low' && i.key.startsWith(`pagewatch:${sha1(feed)}:`))).toBe(true)

  const morning = (await watcher.briefSection({ kind: 'morning', now: NOW + 2 * 60 * 60_000 })).structuredContent
  expect(morning.text.split('\n')[0]).toBe('From what you follow:')
  expect(morning.text).toContain('Nový rozvrh')
  expect(morning.text).not.toContain('Weather')
  expect((await watcher.briefSection({ kind: 'evening' })).structuredContent.text).toBe('')
})

test('brief_limits_are_five_and_ten', async () => {
  const feed = 'https://news.test/feed.xml'
  const rss = (n) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>Story ${i}</title><guid>s${i}</guid></item>`).join('')}</channel></rss>`
  const pages = { [feed]: rss(0) }
  const { watcher, advance } = make({ feeds: feed }, pages)
  await watcher.run()
  pages[feed] = rss(14)
  advance(60 * 60_000)
  await watcher.run()
  const count = async (kind) => (await watcher.briefSection({ kind, now: NOW + 2 * 60 * 60_000 })).structuredContent.text.split('\n').length - 1
  expect(await count('morning')).toBe(5)
  expect(await count('weekly')).toBe(10)
})

test('a_page_that_cannot_be_read_is_said_once_in_the_status', async () => {
  const { watcher, statuses } = make({ pages: 'https://gone.test/x' }, {})
  const round = await watcher.run()
  expect(round.problems).toEqual(['gone.test answered 404 for /x.'])
  expect(statuses.at(-1)).toBe('▲ gone.test answered 404 for /x.')
  expect(await items(watcher)).toEqual([])
})

test('portal_pages_are_watched_like_pages', async () => {
  let text = 'Math: 1'
  const portal = {
    read: async () => ({ ok: true, pages: [{ url: 'https://portal.test/grades', text }] }),
    notice: async () => [],
  }
  const { watcher } = make({ portal_url: 'https://portal.test/login', portal_user: 'a', portal_password: 'b' }, {}, { portal })
  await watcher.run()
  text = 'Math: 1\nCzech: 2'
  await watcher.run()
  const [item] = await items(watcher)
  expect(item.urgency).toBe('normal')
  expect(item.text).toContain('portal.test/grades changed')
})

test('clocks_and_counters_do_not_raise_a_notice', async () => {
  const url = 'https://portal.test/home'
  const pages = { [url]: html('Grades: Math 1', 'Last login: 25 Nov 2026 07:00', 'Server time 07:00:05', 'Session 41', '3 minutes ago') }
  const { watcher } = make({ pages: url }, pages)
  await watcher.run()
  pages[url] = html('Grades: Math 1', 'Last login: 25 Nov 2026 08:10', 'Server time 08:10:44', 'Session 42', '9 minutes ago')
  expect((await watcher.run()).found).toBe(0)
  expect(await items(watcher)).toEqual([])
  // A real change next to the noise still counts, and the notice talks only about it.
  pages[url] = html('Grades: Math 2', 'Last login: 25 Nov 2026 09:00', 'Server time 09:00:00')
  expect((await watcher.run()).found).toBe(1)
  const [item] = await items(watcher)
  expect(item.why.split('\n')).toEqual(['+ Grades: Math 2', '- Grades: Math 1'])
  expect(item.key).toBe(`pagewatch:${sha1(url)}:${sha1('Grades: Math 2')}`)
})

test('noise_line_filter_keeps_real_lines', () => {
  for (const l of ['10:32', 'Last login: 2026-11-25 07:00', 'Updated 25 Nov 2026', 'Visitors online: 12', 'Session 9', '5 minutes ago', 'Mon 25.11.2026'])
    expect(isNoiseLine(l), l).toBe(true)
  for (const l of ['Mon 9:00 Math', 'Exam on 3 Dec moved to room 4', 'Grades: Math 1', 'Parents meeting 17:00 in the hall'])
    expect(isNoiseLine(l), l).toBe(false)
})
