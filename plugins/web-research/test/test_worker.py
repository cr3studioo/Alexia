# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import network
import worker


class PureTests(unittest.TestCase):
    def test_public_targets_and_canonical_deduplication(self):
        for url in ['file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'https://[::1]/', 'http://192.168.1.1', 'https://user:password@example.org', 'http://example.org:22', 'https://router.local/']:
            with self.assertRaises(ValueError, msg=url):
                network.public_url(url)
        self.assertEqual(worker.canonical('https://EXAMPLE.org/article?utm_source=test&a=1#top'), 'https://example.org/article?a=1')
        rows = [{'href': f'https://one.org/{i}', 'title': 'asyncio evidence'} for i in range(8)]
        rows += [{'href': 'https://one.org/0?utm_source=test'}, {'href': 'https://two.edu/doc', 'title': 'asyncio evidence'}, {'href': 'https://three.gov/doc', 'title': 'asyncio evidence'}]
        selected = worker.candidates('asyncio evidence', rows)
        self.assertEqual(len(selected), 10)
        self.assertGreaterEqual(len({x['host'] for x in selected[:3]}), 3)

    def test_cache_freshness_and_faithful_passages(self):
        with tempfile.TemporaryDirectory() as own:
            cache = worker.Cache(own)
            cache.put('key', {'text': 'evidence'})
            self.assertEqual(cache.get('key', 300), {'text': 'evidence'})
            self.assertIsNone(cache.get('key', 300, fresh=True))
            self.assertIsNone(cache.get('key', -1))
        text = ('An irrelevant passage with enough text to be treated as a complete paragraph.\n\n'
                'The asyncio TaskGroup cancellation rules preserve cancellation counts and context.\n\n'
                'The asyncio TaskGroup cancellation rules preserve cancellation counts and context.')
        chosen = worker.passages('asyncio TaskGroup', text)
        self.assertEqual(len(chosen), 2)
        self.assertTrue(all(p['text'] in text for p in chosen))


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_rebinding_and_mixed_private_answers_are_rejected(self):
        loop = asyncio.get_running_loop()
        answers = [(2, 1, 6, '', ('93.184.216.34', 443)), (2, 1, 6, '', ('127.0.0.1', 443))]
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)):
            with self.assertRaises(ValueError):
                await network.destination('public.example', 443)
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers[:1])):
            self.assertEqual(await network.destination('public.example', 443), '93.184.216.34')

    async def test_redirects_validate_every_hop_before_request(self):
        calls = []
        async def fetch(url, **options):
            calls.append(url)
            return types.SimpleNamespace(status=302, headers={'location': 'http://127.0.0.1/private'})
        fake = types.ModuleType('scrapling.fetchers')
        fake.AsyncFetcher = types.SimpleNamespace(get=fetch)
        with tempfile.TemporaryDirectory() as own, patch.dict(sys.modules, {'scrapling.fetchers': fake}):
            research = worker.Research({'requestId': 'test', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), None, Path(own))
            with self.assertRaises(ValueError):
                await research.http('https://example.org/')
        self.assertEqual(calls, ['https://example.org/'])

    async def test_google_fallback_is_concurrent_and_bounded(self):
        calls = []
        barrier = threading.Barrier(2, timeout=3)
        def search(query, backend, **_):
            calls.append((backend, time.monotonic()))
            if backend == 'google':
                return []
            barrier.wait()
            return [{'href': f'https://{backend}.example/doc', 'title': query}]
        fake = types.ModuleType('ddgs')
        fake.DDGS = lambda **_: types.SimpleNamespace(text=search)
        with tempfile.TemporaryDirectory() as own, patch.dict(sys.modules, {'ddgs': fake}):
            research = worker.Research({'requestId': 'test', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), None, Path(own))
            results = await research.search()
            self.assertEqual(len(results), 2)
            self.assertEqual({name for name, _ in calls}, {'google', 'bing', 'duckduckgo'})
            self.assertTrue(research.gaps)

    async def test_parallel_limits_success_count_and_preview_does_not_gate_evidence(self):
        running = 0
        most = 0
        per_domain = {}
        domain_most = {}
        async def http(url):
            nonlocal running, most
            host = worker.urlsplit(url).hostname
            running += 1
            most = max(most, running)
            per_domain[host] = per_domain.get(host, 0) + 1
            domain_most[host] = max(domain_most.get(host, 0), per_domain[host])
            await asyncio.sleep(.02)
            running -= 1
            per_domain[host] -= 1
            if '/blocked' in url:
                raise ValueError('Website returned HTTP 403')
            return '<html>fixture</html>', url
        def extract(html, url, query):
            return {'title': 'Fixture', 'text': ('Evidence about ' + query + '. ') * 12, 'passages': [{'id': 'P1', 'text': 'Exact fixture passage from ' + url}], 'retrievedAt': '2026-10-19'}
        with tempfile.TemporaryDirectory() as own:
            browser = types.SimpleNamespace(queue_preview=lambda *args: None)
            research = worker.Research({'requestId': 'test', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), browser, Path(own))
            research.http = http
            research.search = AsyncMock(return_value=[{'href': f'https://domain{i % 3}.example/{i}', 'title': 'query'} for i in range(12)])
            events = []
            with patch.object(worker, 'extract', extract), patch.object(worker, 'emit', lambda rid, kind, **value: events.append((kind, value))):
                await research.run()
            self.assertLessEqual(most, 6)
            self.assertGreater(most, 1)
            self.assertTrue(all(v <= 2 for v in domain_most.values()))
            result = next(value for kind, value in events if kind == 'result')
            self.assertEqual(len(result['sources']), 8)
            self.assertLessEqual(len(result['evidence']), 24000)
            self.assertEqual(research.stage, 'writing')

    async def test_source_limit_returns_without_waiting_for_slow_attempts(self):
        async def http(url):
            if int(worker.urlsplit(url).path[1:]) >= 8:
                await asyncio.sleep(10)
            else:
                await asyncio.sleep(.01)
            return 'fixture', url
        def extract(html, url, query):
            return {'title': url, 'text': 'Evidence ' * 30, 'passages': [{'id': 'P1', 'text': 'Evidence from ' + url}], 'retrievedAt': '2026-10-19'}
        with tempfile.TemporaryDirectory() as own:
            research = worker.Research({'requestId': 'limit', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), types.SimpleNamespace(queue_preview=lambda *args: None), Path(own))
            research.http = http
            research.search = AsyncMock(return_value=[{'href': f'https://source{i}.org/{i}'} for i in range(12)])
            with patch.object(worker, 'extract', extract), patch.object(worker, 'emit'), patch.object(worker, 'RETRIEVAL_BUDGET', .5):
                await research.run()
            self.assertEqual(sum(s['state'] == 'complete' for s in research.sources), 8)
            self.assertFalse(any('deadline' in gap for gap in research.gaps))
            self.assertTrue(all(task.done() for task in research.read_tasks))

    async def test_explicit_source_budget_does_not_wait_for_slow_discovery(self):
        discovery_cancelled = asyncio.Event()
        async def search():
            try:
                await asyncio.Event().wait()
            finally:
                discovery_cancelled.set()
        async def http(url):
            return 'fixture', url
        def extract(html, url, query):
            return {'title': url, 'text': 'Evidence ' * 30, 'passages': [{'id': 'P1', 'text': 'Evidence from ' + url}], 'retrievedAt': '2026-10-23'}
        with tempfile.TemporaryDirectory() as own:
            urls = [f'https://source{i}.org/' for i in range(8)]
            research = worker.Research({'requestId': 'explicit', 'query': 'query', 'urls': urls}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), types.SimpleNamespace(queue_preview=lambda *args: None), Path(own))
            research.http = http
            research.search = search
            events = []
            with patch.object(worker, 'extract', extract), patch.object(worker, 'emit', lambda rid, kind, **value: events.append((kind, value))):
                await asyncio.wait_for(research.run(), timeout=1)
            self.assertTrue(discovery_cancelled.is_set())
            result = next(value for kind, value in events if kind == 'result')
            self.assertEqual(len(result['sources']), 8)
            self.assertTrue(all(task.done() for task in research.read_tasks))

    async def test_retrieval_deadline_settles_blocked_attempts(self):
        with tempfile.TemporaryDirectory() as own:
            research = worker.Research({'requestId': 'timeout', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), None, Path(own))
            research.search = AsyncMock(return_value=[{'href': 'https://source.org/'}])
            async def slow(url):
                await asyncio.sleep(10)
            research.http = slow
            with patch.object(worker, 'emit'), patch.object(worker, 'RETRIEVAL_BUDGET', .02):
                await research.run()
            self.assertEqual(research.sources[0]['state'], 'unavailable')
            self.assertTrue(any('deadline' in gap for gap in research.gaps))

    async def test_synthesis_sources_include_only_passages_that_fit_the_evidence_budget(self):
        async def http(url):
            return 'fixture', url
        def extract(html, url, query):
            return {'title': 'A long source title ' * 50, 'text': 'Evidence ' * 30, 'passages': [{'id': f'P{i}', 'text': (f'{url[:30]} paragraph {i} ' + 'evidence ' * 100)[:850]} for i in range(3)], 'retrievedAt': '2026-10-19'}
        with tempfile.TemporaryDirectory() as own:
            research = worker.Research({'requestId': 'budget', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), types.SimpleNamespace(queue_preview=lambda *args: None), Path(own))
            research.http = http
            research.search = AsyncMock(return_value=[{'href': f'https://source{i}.org/' + 'a' * 3000} for i in range(8)])
            events = []
            with patch.object(worker, 'extract', extract), patch.object(worker, 'emit', lambda rid, kind, **value: events.append((kind, value))):
                await research.run()
            result = next(value for kind, value in events if kind == 'result')
            self.assertLessEqual(len(result['evidence']), 24000)
            self.assertLess(len(result['sources']), 8)
            for source in result['sources']:
                for passage in source['passages']:
                    self.assertIn(f"[{source['id']}:{passage['id']}]\n{passage['text']}", result['evidence'])
            self.assertTrue(any('evidence size limit' in gap for gap in result['gaps']))

    async def test_javascript_fallback_reuses_rendered_page_without_waiting_for_capture(self):
        page = types.SimpleNamespace(goto=AsyncMock(), wait_for_timeout=AsyncMock(), content=AsyncMock(return_value='rendered html'))
        context = types.SimpleNamespace(new_page=AsyncMock(return_value=page), close=AsyncMock())
        queued = []
        browser = types.SimpleNamespace(slots=asyncio.Semaphore(2), read_waiters=0, context=AsyncMock(return_value=context), queue_preview=lambda *args: queued.append(args))
        with tempfile.TemporaryDirectory() as own:
            research = worker.Research({'requestId': 'js', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), browser, Path(own))
            research.http = AsyncMock(return_value=('empty shell', 'https://example.org/'))
            def extract(html, url, query):
                if html == 'empty shell':
                    raise ValueError('Insufficient text')
                return {'title': 'JS page', 'text': 'Rendered evidence ' * 20, 'passages': [{'id': 'P1', 'text': 'Rendered evidence'}], 'retrievedAt': '2026-10-19'}
            with patch.object(worker, 'extract', extract), patch.object(worker, 'emit'):
                await research.read({'url': 'https://example.org/', 'host': 'example.org', 'title': 'JS page'}, 0)
            self.assertEqual(research.sources[0]['state'], 'complete')
            self.assertIs(queued[0][2], page)
            self.assertIs(queued[0][3], context)
            context.close.assert_not_called()

    async def test_cancel_settles_attempt_without_success(self):
        with tempfile.TemporaryDirectory() as own:
            research = worker.Research({'requestId': 'cancel', 'query': 'query'}, worker.Cache(own), types.SimpleNamespace(url='http://proxy'), None, Path(own))
            research.http = AsyncMock(side_effect=asyncio.CancelledError())
            with patch.object(worker, 'emit'), self.assertRaises(asyncio.CancelledError):
                await research.read({'url': 'https://example.org/', 'host': 'example.org', 'title': 'source'}, 0)
            self.assertEqual(research.sources[0]['state'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
