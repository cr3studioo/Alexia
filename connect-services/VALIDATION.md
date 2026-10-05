# Task C validation report

Created only `connect-services/**` and `docs/connectivity-services.md`; no existing file was
changed, no deployment/account/container was started, and no Git lifecycle command was run.

## Result

The two-service Compose deployment, pinned Dockerfiles, complete environment example,
hash-locked mailbox dependencies, bounded server options, no-service-log startup wrapper,
health probes, Nginx TLS/abuse template and renderer, pin checker and operator documentation
are ready for review. The coordinator accepted the client application ID
`dev.alexia.pairing.v1`. Address lookup is a separate documented self-hostable dependency.

Native mailbox `maxConnections`, frame and reassembled message limits are supported via
`--websocket-protocol-option`. The mailbox has no configurable per-code/IP attempt quota,
message-count quota or five-minute code deadline; the docs distinguish application policy
from proxy connection/handshake controls. Relay RX token buckets are implemented, but
`accept_conn_limit`/`accept_conn_burst` have no effect in 1.3.0, so the deployment uses proxy
request/per-IP/global connection caps. The documents make these limitations explicit.

## Commands and checks

All final checks passed unless marked not run. Exact shell commands used for the reproducible
external/syntax checks follow:

```sh
docker compose version
# PASS: Docker Compose v5.5.1

docker compose -f connect-services/docker-compose.yml config > /dev/null
# PASS: exact acceptance command, with output redirected only.

docker compose -f connect-services/docker-compose.yml config --quiet
# PASS

docker compose --env-file connect-services/.env.example -f connect-services/docker-compose.yml config --quiet
# PASS

python3 connect-services/render_proxy.py connect-services/.env.example > /dev/null
# PASS: no unresolved template variables; no configuration was installed.

python3 connect-services/verify_pins.py
# PASS: 22 PyPI pins/hashes, 3 crates.io 1.3.0 versions, 2 Docker Hub tags/digests.

python3 -m pip install --dry-run --report /dev/null --ignore-installed --python-version 3.12 --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 --platform manylinux_2_34_x86_64 --implementation cp --only-binary=:all: --require-hashes -r connect-services/mailbox-requirements.txt
# PASS: all 22 Linux amd64 packages resolve as hashed binary wheels; nothing installed.

python3 -m pip install --dry-run --report /dev/null --ignore-installed --python-version 3.12 --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 --platform manylinux_2_34_aarch64 --implementation cp --only-binary=:all: --require-hashes -r connect-services/mailbox-requirements.txt
# PASS: all 22 Linux arm64 packages resolve as hashed binary wheels; nothing installed.

git diff --check -- connect-services docs/connectivity-services.md
# PASS (new files are untracked; a separate Python check verified their whitespace).
```

Additional successful inline Python checks:

- `ast.parse` on every Python helper (no interpreter cache files written).
- `tomllib.loads(run_service.relay_config())` with default public access and two private
  allowlisted public identities; rejected a malformed identity without echoing its value.
- Rejected RX burst smaller than the protocol's 1 MiB maximum frame.
- Verified the generated mailbox command uses actual released server/Autobahn options.
- Parsed both Compose variants; exactly mailbox/relay services, log driver `none`, read-only roots.
- Rendered Nginx and checked placeholder removal, private status binding and rejection of a
  non-loopback upstream address.
- Compared every Compose/proxy configurable placeholder against `.env.example`: complete.
- Mocked readiness responses: accepted mailbox root and relay 1.3.0 health; rejected wrong
  mailbox body and relay version. This validates probe decisions, not live servers.
- Checked every created file for trailing whitespace and embedded PEM private keys.
- Downloaded released source archives into memory to verify option names, unused relay
  accept-limit fields, public handshake/log metadata, metrics and address-lookup behavior.
- GitHub tag API verified mailbox `0.8.0`, Autobahn source version and iroh `v1.3.0` references.

An initial pip dry-run without `--report` was refused by Homebrew's externally-managed Python
policy; adding a dry-run report avoided any installation and passed. An initial Autobahn
25.10.2 candidate existed but lacked the required arm64 binary wheel; it was replaced with
26.7.1, whose pinned dependencies/hash checks pass on both target architectures. These
failures were corrected; neither version nor the failed commands are shipped as defaults.

## Every selected version pin

Verified on 2026-10-02 by live package-index/registry API responses:

| Pin | Verification |
| --- | --- |
| `attrs==26.1.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `autobahn==26.7.1` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `Automat==25.4.16` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `cbor2==6.1.5` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `cffi==2.1.1` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `constantly==23.10.4` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `cryptography==50.0.2` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `hyperlink==21.0.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `idna==3.20` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `Incremental==24.11.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `magic-wormhole-mailbox-server==0.8.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `msgpack==1.2.3` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `packaging==26.3` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `pycparser==3.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `pyOpenSSL==26.4.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `service-identity==26.1.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `setuptools==84.0.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `Twisted==26.4.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `txaio==26.6.1` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `typing_extensions==4.16.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `ujson==6.0.0` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `zope.interface==8.6` | Verified existing; PyPI version JSON and accepted artifact hashes checked. |
| `iroh-relay=1.3.0` | Verified crates.io version and released archive, including Cargo.lock/server feature. |
| `iroh=1.3.0` | Verified crates.io version and released address-lookup source. |
| Optional `iroh-dns-server=1.3.0` | Verified crates.io version and released production config/CLI. |
| `python:3.12.11-slim-bookworm` | Verified Registry V2 HTTP 200 and digest `sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7`; amd64 and arm64 manifests exist. |
| `rust:1.91.1-bookworm` | Verified Registry V2 HTTP 200 and digest `sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33`; amd64 and arm64 manifests exist. |

All explicitly selected package/image version pins are verified-existing. Individual transitive
packages in upstream Cargo.lock were not separately verified/audited against their indexes;
`cargo install --locked` will check them at image build time.

## Files created

- `connect-services/docker-compose.yml`
- `connect-services/Dockerfile.mailbox`
- `connect-services/Dockerfile.relay`
- `connect-services/.env.example`
- `connect-services/.dockerignore`
- `connect-services/.gitignore`
- `connect-services/mailbox-requirements.txt`
- `connect-services/run_service.py`
- `connect-services/healthcheck.py`
- `connect-services/nginx.conf.template`
- `connect-services/render_proxy.py`
- `connect-services/verify_pins.py`
- `connect-services/VALIDATION.md` (this report)
- `docs/connectivity-services.md`

## Left for deployment/integration validation

No image build, native binary linking/startup, real Nginx `-t`, live TLS endpoint, address
lookup deployment, service load/abuse test or two-machine connection test was attempted.
Nginx is not installed locally (`command -v nginx` found no binary). These checks are in the
pre-release checklist and must happen before shipping Alexia-operated defaults. Actual
mailbox/relay/address-lookup setting key names remain the clearly marked TODO requested by
the coordinator; no fictional production addresses were introduced. Core tests were not run
because this task is confined to deployment files/docs; the known baseline failing command
unit test was untouched. The owner/coordinator's unrelated working-tree changes are preserved.
