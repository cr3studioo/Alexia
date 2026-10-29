# SPDX-License-Identifier: AGPL-3.0-only
"""Public-only egress proxy. Resolve once, validate every address, connect to the IP.

Both Scrapling and Chromium use this proxy, including redirects and subresources.
DNS rebinding cannot change the destination between validation and connection.
"""
import asyncio
import ipaddress
from urllib.parse import urlsplit


def public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Only public HTTP(S) URLs without credentials are allowed')
    if parsed.port not in (None, 80, 443):
        raise ValueError('Only public web ports are allowed')
    host = parsed.hostname.rstrip('.').lower()
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal', '.home', '.onion')):
        raise ValueError('Private network targets are not allowed')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError('Private network targets are not allowed')
    return parsed


async def destination(host, port):
    public_url(f'https://[{host}]:{port}' if ':' in host else f'https://{host}:{port}')
    answers = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(host, port, type=1), 2)
    if not answers or any(not ipaddress.ip_address(item[4][0]).is_global for item in answers):
        raise ValueError('Private network resolution refused')
    return answers[0][4][0]


class PublicProxy:
    async def __aenter__(self):
        self.connections = set()
        self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0, limit=65536)
        self.url = f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()
        for task in list(self.connections):
            task.cancel()
        await asyncio.gather(*list(self.connections), return_exceptions=True)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.connections.add(task)
        remote = None
        try:
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            method, target, version = header.split(b'\r\n', 1)[0].decode('ascii').split(' ', 2)
            if method == 'CONNECT':
                parsed = public_url('https://' + target)
            elif method in ('GET', 'HEAD'):
                parsed = public_url(target)
            else:
                raise ValueError('Research is read-only')
            port = parsed.port or (443 if parsed.scheme == 'https' else 80)
            address = await destination(parsed.hostname, port)
            incoming, remote = await asyncio.wait_for(asyncio.open_connection(address, port), 3)
            if method == 'CONNECT':
                writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            else:
                path = parsed.path or '/'
                if parsed.query:
                    path += '?' + parsed.query
                # Do not forward authentication, cookies or proxy hop headers.
                lines = [line for line in header.split(b'\r\n')[1:] if line and not line.lower().startswith((b'proxy-', b'connection:', b'cookie:', b'authorization:', b'host:'))]
                authority = parsed.netloc.encode('ascii')
                remote.write(f'{method} {path} {version}\r\n'.encode('ascii') + b'Host: ' + authority + b'\r\n' + b'\r\n'.join(lines) + b'\r\nConnection: close\r\n\r\n')
                await remote.drain()
            await writer.drain()

            async def pipe(source, sink, cap):
                size = 0
                while data := await source.read(65536):
                    size += len(data)
                    if size > cap:
                        break
                    sink.write(data)
                    await sink.drain()
            # Bound page transfers even if a website ignores its declared content length.
            jobs = [asyncio.create_task(pipe(reader, remote, 4_000_000)), asyncio.create_task(pipe(incoming, writer, 12_000_000))]
            try:
                await asyncio.wait(jobs, timeout=12, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for job in jobs:
                    job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
        except (Exception, asyncio.CancelledError):
            try:
                writer.write(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                await writer.drain()
            except Exception:
                pass
        finally:
            if remote:
                remote.close()
            writer.close()
            self.connections.discard(task)
