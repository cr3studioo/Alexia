"""Probe HTTP readiness without printing response data or rendezvous metadata."""

import json
import sys
import urllib.request


def main():
    service = sys.argv[1]
    url = "http://127.0.0.1:4000/" if service == "mailbox" else "http://127.0.0.1:3340/healthz"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=3) as response:
        body = response.read(4096)
        if response.status != 200:
            return 1
    if service == "mailbox":
        return 0 if body == b"Wormhole Relay\n" else 1
    health = json.loads(body)
    return 0 if health.get("status") == "ok" and health.get("version") == "1.3.0" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("unhealthy", file=sys.stderr)
        sys.exit(1)
