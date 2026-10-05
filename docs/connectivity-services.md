# Connectivity services

Alexia uses a Magic Wormhole mailbox for initial pairing and an iroh relay when a direct
encrypted connection is unavailable. The deployment files in [`connect-services/`](../connect-services/)
build `magic-wormhole-mailbox-server` 0.8.0 and `iroh-relay` 1.3.0, matching the initial
iroh 1.3.0 transport pin. They contain no live Alexia service addresses: release defaults
must be provisioned, measured and approved before shipping.

These services are **separate from the plugin registry in `registry/` and must stay separate**.
Use different processes, deployment credentials, storage, monitoring and lifecycle management.
The registry distributes and revokes plugins; it does not pair computers, route compute
traffic, store device trust or authorize a remote job. Connectivity must not acquire a
dependency on the registry backend.

**Hosting costs belong to whoever operates the services**, including bandwidth, machines,
domains, certificates, monitoring and abuse response. Self-hosting does not transfer those
costs to Alexia or to the upstream projects.

## Without any server: Tailscale

None of these services is needed to pair two computers or to reach one from somewhere else.
With no mailbox configured, Alexia pairs directly: the computer that computes shows four words
and announces itself; the one you talk to finds it — on the same network, or over Tailscale —
and the code is exchanged between the two. Settings has a *Reach your other computer from
anywhere* card that installs Tailscale (from Tailscale's own download), starts it and opens its
sign-in; both computers signed in to one Tailscale account are on one private network.

Each computer tells its transport its Tailscale address, so a pairing's hints include it, and
the computer you talk to adds a paired computer's Tailscale address to its saved hints when it
finds it there. iroh tries every address it knows and keeps the best that answers: direct at
home, Tailscale's when apart. Nothing is switched by hand, and traffic stays end-to-end
encrypted by iroh either way.

## What the operator can see

| Service | Visible information | Information it cannot decrypt or authorize |
| --- | --- | --- |
| Mailbox | Client IP/port, application identifier, numeric nameplate (the number in a code), random side/mailbox IDs, public PAKE handshake material, protocol phases, ciphertext sizes, timing and connection outcomes. Active state is held in SQLite. | The four secret words, the derived pairing key, encrypted identity exchange and pairing payload. It never carries Alexia compute prompts or outputs. |
| iroh relay | Source network addresses, authenticated endpoint public identities, routing destinations, encrypted QUIC packets, traffic sizes/timing and connection/error counters. | Endpoint private keys and end-to-end encrypted prompts, outputs, artifacts and authenticated application operations. Relay access is not Alexia job authorization. |
| Address lookup (separate dependency) | Endpoint public identity, signed connection hints such as a relay URL, publication/look-up timing and requester IP. Public IP hints are visible if clients explicitly publish them. | Private identity keys, pairing secrets and compute payloads. A valid signed hint identifies its publisher; it does not grant access. |

These boundaries assume Alexia's authenticated, encrypted protocols. Mailbox control
messages and the PAKE handshake are not themselves all ciphertext. The number in a pairing
code is rendezvous metadata; its secret word portion never goes to the server in plaintext.
Encrypted messages remain opaque to a mailbox operator. See the upstream
[mailbox protocol](https://magic-wormhole.readthedocs.io/en/latest/server-protocol.html) and
[iroh 1.3.0 transport documentation](https://docs.rs/iroh/1.3.0/iroh/).

The Alexia pairing application identifier is **`dev.alexia.pairing.v1`**, supplied by both
clients in the Wormhole `bind.appid` message. This is a namespace, not a password. The
mailbox CLI has no application-ID allowlist or `--appid` switch: a dedicated Alexia
instance and DNS name isolate deployment and state, but a hostile client can still bind a
different app ID. Do not claim namespace enforcement. For stricter admission use a
protocol-aware gateway that validates `bind.appid` before forwarding; ordinary HTTP
reverse proxies cannot inspect this WebSocket message. The upstream
[mailbox implementation](https://github.com/magic-wormhole/magic-wormhole-mailbox-server)
and [Magic Wormhole overview](https://magic-wormhole.readthedocs.io/en/latest/welcome.html)
describe the mailbox's role. No Wormhole transit/file-transfer relay is needed here;
iroh carries compute traffic after pairing.

## Pointing Alexia at a self-hosted service

Configure both computers consistently using these settings:

| Setting label | Example value | Purpose |
| --- | --- | --- |
| **mailbox URL** | `wss://mailbox.example.org/v1` | WebSocket rendezvous for initial internet-code pairing. The `/v1` path is required. |
| **relay URL** | `https://relay.example.org/` | iroh relay base URL; do not enter `/relay` or `/healthz` as the setting value. |
| **address-lookup URL** | `https://lookup.example.org/pkarr` | Compatible pkarr HTTP publication and resolution base URL. This is not the transport relay URL. |

**TODO — setting key names:** replace this line with the actual persisted/API keys once
the settings worker defines them; these are descriptive labels, not implementation keys.
The environment file configures servers and the example proxy; it does not set desktop
Alexia preferences. Never put a pairing code, endpoint private key or token in these URLs.

Initial internet-code pairing requires a reachable mailbox, including when the two
unpaired computers happen to share a LAN. Already-paired computers can connect directly
on an **offline LAN**, using their saved identities and current local connection hints,
without contacting the mailbox, relay or public address lookup. LAN discovery is only a
connection hint and **never authorization**: authenticate the endpoint identity against
the paired-device allowlist before accepting any compute operation. Spoofed LAN
announcements must not create or replace trust. Direct connectivity still depends on local
firewall rules and a usable route; multicast discovery can fail across VLANs.

## Build and configure the two-service stack

Run these examples from the repository root on the operator's Docker host. They are
deployment instructions, not evidence that this checkout has been deployed.

```sh
cp connect-services/.env.example connect-services/.env
# Edit connect-services/.env with the hostnames, certificate paths and capacity limits.
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml config --quiet
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml build
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml up -d
```

The complete runtime and proxy variable list is in `.env.example`. Release pins are fixed
in the Dockerfiles and `mailbox-requirements.txt`; change them only with a reviewed update.
Recheck the published pins without building or deploying with
`python3 connect-services/verify_pins.py` (requires internet access).
The mailbox dependency lock pins all 22 Python packages and accepts only PyPI-hashed binary
wheels. The relay uses `cargo install --version '=1.3.0' --locked --features server`, using
the crate's published dependency lock. Base image tags **and manifest digests** are fixed.
Use Linux amd64 or arm64 hosts; other base-image architectures are not validated targets.

The containers run as UID/GID 10001, with read-only roots, dropped capabilities, process,
memory and CPU limits. The mailbox's 64 MiB `/state` tmpfs holds active SQLite state and is
not backed up. Stopping/recreating it loses active pairing exchanges; issue a fresh code
after a restart. No user trust is stored here. The relay is stateless, and its generated
TOML config lives in `/tmp`. Neither container needs a secret or a mounted TLS key.

## TLS and reverse proxy

Both backends speak plain HTTP **only on trusted internal paths**. Default published
ports bind to host loopback: mailbox 4000, relay 3340, relay metrics 9090. Keep the metrics
port loopback-only. Do not change `CONNECT_BIND_ADDRESS` to a public interface. The supplied
proxy renderer rejects non-loopback upstream addresses. On another machine or in another
container, use a protected private network and explicitly adapt the proxy configuration;
that container's loopback is not the Docker host.

Provide DNS and trusted certificates for two separate public hostnames. Terminate WSS/HTTPS
with an operator-managed Nginx on the Docker host. Obtain/renew certificates using the
operator's existing TLS process; do not add keys to this repository or the Docker build
context. The build context allowlist excludes `.env` and all certificate files.

```sh
python3 connect-services/render_proxy.py connect-services/.env > connect-services/nginx.conf
# On the proxy host, after supplying certificates at the configured paths:
sudo nginx -t -c "$PWD/connect-services/nginx.conf"
```

The full configuration template includes TLS, per-IP/global connection limits, handshake
request limits, a private `/nginx_status` listener, and metadata-free operational access
logs. Merge it into an existing proxy deliberately; it is not an automatic installation.
Reload only after `nginx -t` passes. The example exposes TCP 443 plus TCP 80 for HTTPS
redirects and the relay's HTTP `/generate_204` captive-portal probe. Certificate issuance
may require its own challenge route; add that through the operator's TLS process.

Preserve HTTP/1.1 upgrade headers on `/v1` and `/relay`, including WebSocket and iroh's
upgraded streams. Disable response buffering and avoid caching these routes. The 90-second
proxy idle timeout accommodates protocol keepalives. IP quotas assume a directly connected
proxy; behind another load balancer, configure trusted `real_ip` sources before using
`$binary_remote_addr`. Never trust arbitrary client-supplied forwarding headers.

QUIC address discovery (`enable_quic_addr_discovery`) is disabled in this stack. It is an
optional NAT traversal aid, distinct from publishing paired-host hints via address lookup.
No UDP port is exposed, and an HTTP proxy cannot carry QAD UDP. To enable it later, configure
the relay's real `[tls]` certificate options and `tls.quic_bind_addr`, expose that UDP port,
and add UDP abuse controls; validate the changed deployment separately. See the
[relay self-host guide](https://docs.iroh.computer/iroh-services/relays/self-hosted) and
[1.3.0 CLI configuration source](https://docs.rs/crate/iroh-relay/1.3.0/source/src/main.rs).

## Limits and abuse controls

| Concern | Real server option or behavior | Deployment rule and limitation |
| --- | --- | --- |
| Mailbox pairing attempts | `handle_claim` allows one `claim` per WebSocket; `CrowdedError` rejects more than two distinct sides in a mailbox. No configurable attempts-per-IP/per-code rate or five-minute expiry option exists. | Nginx `limit_req_zone`/`limit_req` on `/v1`: 10 HTTP upgrade requests/minute/IP with burst 5. This bounds connection churn, not messages on an already-upgraded socket or one attempt per code. |
| Mailbox connections | `--websocket-protocol-option=maxConnections=128` sets Autobahn's global WebSocket connection cap. | Nginx `limit_conn` also allows 8 active requests/IP and 128 per mailbox hostname. It counts upgraded connections after request headers are read; slow header reads are bounded by `client_header_timeout`, not this quota. |
| Mailbox message sizes | `--websocket-protocol-option=maxFramePayloadSize=65536` and `maxMessagePayloadSize=65536`. | 64 KiB per WebSocket frame and reassembled message, including JSON/hex overhead; usable ciphertext is smaller. Nginx `client_max_body_size` only bounds HTTP request bodies and does **not** limit upgraded WebSocket frames. |
| Mailbox stale/idle connections | `openHandshakeTimeout=5`, `autoPingInterval=30`, `autoPingTimeout=10`, through the same CLI option. | Ping responsiveness is not a pairing deadline. Upstream prunes inactive mailboxes older than 11 minutes on a five-minute scan, and connected listeners keep mailboxes alive. |
| Mailbox message count/rate | No per-mailbox queued-message count or WebSocket command-rate CLI option. | 64 MiB state tmpfs plus the Compose resource bounds contain storage growth; alert before saturation. A frame-aware gateway is required for per-socket command quotas; Nginx HTTP limits cannot supply them. |
| Relay bandwidth | `[limits.client.rx] bytes_per_second=10485760`, `max_burst_bytes=20971520`. | 10 MiB/s steady receive rate and 20 MiB burst per **connection**, not per endpoint/IP; opening more connections can multiply bandwidth. Monitor limited traffic and combine with proxy caps. |
| Relay connection attempts/count | `limits.accept_conn_limit` and `limits.accept_conn_burst` deserialize but are **not implemented** in 1.3.0; setting them has no effect. No CLI concurrent-connection cap. | Nginx: 60 requests/minute/IP, burst 20, 16 active requests/IP and 1024 per relay hostname. Keep the backend inaccessible from outside the trusted network so callers cannot bypass the proxy. |
| Relay admission | `access = "everyone"` or `access.allowlist = [endpoint IDs]`; also supports `access.denylist`, `access.shared_token`, `access.http.url`. | Empty `RELAY_ALLOWED_ENDPOINT_IDS` means a public relay. For a private relay supply the public identities of **both** computers, including endpoints that must complete identity proof during pairing. This controls relay use, not compute permissions. |
| Relay frame bounds | Compiled protocol `MAX_PACKET_SIZE=65536`, `MAX_FRAME_SIZE=1048576`; no TOML override. | Do not invent a message-size setting or treat HTTP body limits as relay frame limits. The generated rate-limit burst must be at least 1 MiB. |

The client's code policy remains required: four random words, five-minute expiry, one
pairing attempt, and invalidation on success, authentication failure, cancellation or
expiry. Proxy request limits cannot enforce these cryptographic per-code rules. Do not
expose production defaults until the application tests prove them. Large NATs may need
higher IP quotas; raise them with capacity and abuse measurements, not by disabling limits.
For an internet-facing host, also bound pre-HTTP socket/SYN traffic with the operator's
firewall or load balancer; HTTP connection quotas do not cover incomplete TLS handshakes.

Options were checked against the released mailbox
[CLI source](https://github.com/magic-wormhole/magic-wormhole-mailbox-server/blob/0.8.0/src/wormhole_mailbox_server/server_tap.py),
[WebSocket handlers](https://github.com/magic-wormhole/magic-wormhole-mailbox-server/blob/0.8.0/src/wormhole_mailbox_server/server_websocket.py),
[Autobahn 26.7.1 source](https://github.com/crossbario/autobahn-python/blob/v26.7.1/autobahn/websocket/protocol.py),
[iroh 1.3.0 limits](https://docs.rs/iroh-relay/1.3.0/iroh_relay/server/struct.Limits.html),
[relay protocol source](https://docs.rs/crate/iroh-relay/1.3.0/source/src/protos/relay.rs), and
Nginx's [request](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) and
[connection](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html) limit modules.

## Logging and retention

The shipped configuration retains **no upstream service logs**. `run_service.py` redirects
both stdout and stderr to `/dev/null` before launching either server, the relay gets
`RUST_LOG=off`, and Compose uses the `none` logging driver. Thus application prompts,
outputs, pairing words, decrypted bootstrap messages, malformed client input and even
ciphertext cannot enter stored service logs. Startup validation errors contain only known
configuration field names, never their values. Health-check failures print only `unhealthy`.

Mailbox `--blur-usage=3600` suppresses normal HTTP/request logging and rounds optional usage
timestamps. Listing is left on: Alexia's pairing client asks the server for its open numbers
before it joins, and with `--disallow-list` every join fails as an unknown code (found by
pairing two real sidecars through the real server). A listing shows only which short numbers
are open, never the words or anything sent. We omit `--usage-db` and
`--log-fd`, so no historical SQLite usage DB or JSON usage log is created. **Blurring alone
does not remove upstream pruning logs**, which can include random mailbox IDs and app IDs;
this is why streams are discarded. The active channel DB still contains rendezvous state,
public handshake material and encrypted bootstrap messages until closure/pruning. It is
ephemeral, is not a log, and must not be scraped or copied into diagnostics.

Without suppression, upstream mailbox logs can include HTTP access/IP/port, app ID,
nameplate creation and pruning identifiers; optional usage records include timestamps,
client versions, waiting/total durations and outcome categories. Relay normal logs include
listener addresses and operational errors; debug/trace spans can include remote addresses,
endpoint IDs, configuration and packet diagnostics. Keep debug/trace off. The services
cannot decrypt legitimate compute traffic, but metadata and arbitrary malformed input
still deserve protection. Packet capture, proxy body/frame tracing and third-party
request recording must remain disabled.

The proxy logs only configured hostname, HTTP status, request duration, response byte
count, `$limit_req_status` and `$limit_conn_status`; error logs are disabled to avoid
unfiltered request diagnostics. It logs no IP, URI/query, authorization header, code,
endpoint ID or body. Rotate this aggregate operations log with a short operator-defined
retention (for example seven days); never enable the default combined access log for these
vhosts. Metrics carry counters, not payloads. Disabling service diagnostics is a deliberate
tradeoff: use health, container state, proxy results and metrics for diagnosis.

## Address lookup is a separate dependency

The two-service stack does **not** provide address lookup. In iroh 1.3.0,
`PkarrPublisher` publishes signed endpoint hints and `PkarrResolver` resolves them over
HTTP PUT/GET. Both must use the configured address-lookup base URL; changing only the
publisher while leaving DNS or another resolver on a public default produces mismatches.
Do not keep an implicit public fallback when the operator selected self-hosted lookup.
Publish relay hints by default (`AddrFilter::relay_only()`), and do not publish private
LAN addresses, pairing records, roles, prompts or outputs. See
[iroh's pkarr implementation](https://docs.rs/iroh/1.3.0/iroh/address_lookup/pkarr/index.html).

Address lookup **can be self-hosted** with `iroh-dns-server` 1.3.0, which exposes `/pkarr`
GET/PUT plus optional DNS/DNS-over-HTTPS. It is a third, independently operated service,
outside this Compose deployment. The version exists on crates.io. For a separate host:

```sh
cargo install iroh-dns-server --version '=1.3.0' --locked
# Adapt the upstream config.prod.toml: real DNS origin, public address, SOA/NS,
# data_dir, certificate domain/contact, and pkarr_put_rate_limit = "smart".
iroh-dns-server --config /etc/iroh-dns-server/config.toml
```

Use the upstream [1.3.0 production configuration](https://docs.rs/crate/iroh-dns-server/1.3.0/source/config.prod.toml)
and [README](https://docs.rs/crate/iroh-dns-server/1.3.0/source/README.md), rather than
starting its localhost/self-signed defaults publicly. Configure trusted HTTPS on `/pkarr`,
rate-limit both GET and PUT at the edge, protect its data and metrics, and apply the same
no-payload/no-identifier logging policy. Native DNS requires port 53 UDP/TCP and domain
delegation; HTTP-only `PkarrResolver` clients do not need public DNS delegation. Keep
`mainline.enabled = false` unless publication into the public DHT is an explicit operator
decision. This document verifies the package and options, not an address-lookup deployment
or Alexia's eventual settings wiring.

## Monitoring and health commands

After deployment, run on the Docker host (substitute ports/hosts if changed):

```sh
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml ps
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml exec -T mailbox python /app/healthcheck.py mailbox
docker compose --env-file connect-services/.env -f connect-services/docker-compose.yml exec -T relay python /app/healthcheck.py relay
curl --noproxy '*' --fail --max-time 5 http://127.0.0.1:4000/
curl --noproxy '*' --fail --max-time 5 http://127.0.0.1:3340/healthz
curl --noproxy '*' --fail --max-time 5 http://127.0.0.1:9090/metrics
curl --noproxy '*' --fail --max-time 5 http://127.0.0.1:8081/nginx_status
curl --fail --max-time 10 https://mailbox.example.org/
curl --fail --max-time 10 https://relay.example.org/healthz
```

Mailbox `/` returns `Wormhole Relay`; it is an HTTP availability probe, not proof of a
working WebSocket exchange or pairing authentication. The mailbox exposes no Prometheus
endpoint. Keep the optional usage DB disabled; use proxy upgrade successes/failures and
the application's sanitized aggregate pairing outcomes instead. Relay `/healthz` returns
JSON with `status`, `version` and `git_hash` (a crates.io build may report `unknown`);
the container probe requires status `ok` and version `1.3.0`.

The relay's private Prometheus `/metrics` exposes these counters in the `relayserver`
group (Prometheus counter names end in `_total`):

- `bytes_sent`, `bytes_recv`: relay bandwidth; alert on sustained capacity/budget usage.
- `accepts`, `disconnects`: connection churn; their difference estimates live relay clients.
- `http_connections`, `http_connections_closed`, `http_connections_errored`: transport health.
- `send_packets_dropped`: unreachable recipients/write failures; not all queue-full drops.
- `bytes_rx_ratelimited_total`, `conns_rx_ratelimited_total`: bytes/connections affected by RX limits.
- `unique_client_keys`: unusual identity growth can indicate abuse; it is a count, not a key list.

Use the actual emitted names when configuring the scraper; do not assume another release's
prefixes. The `other_packets_*` and `unknown_frames` fields are currently unused and must
not underpin alerts. See the [1.3.0 metrics definitions](https://docs.rs/crate/iroh-relay/1.3.0/source/src/server/metrics.rs).
Use rates/deltas for counters, detect process restarts, and monitor container restarts/OOM,
CPU, RSS and mailbox tmpfs fullness alongside certificates/DNS and externally probed
availability. Nginx `/nginx_status` gives aggregate active/read/write/wait connections;
the sanitized proxy log supplies `429`, `5xx`, `REJECTED` and upgrade `101` counts.
Upgraded-request log records appear at connection close, so they are not live-connection
gauges. Alert when normal users hit abuse limits and tune without retaining user identifiers.

Add synthetic, short-lived WebSocket welcome probes and an authenticated two-endpoint
relay test from another network. HTTP health alone cannot prove relay routing, direct
holepunching or end-to-end pairing. Publish only availability/latency/counts from those
probes, never their code, message body or endpoint identifiers.

## Pre-release validation of deployed defaults

- [ ] Provision real Alexia mailbox/relay/lookup defaults; verify DNS, trusted TLS, certificate
  renewal and independent monitoring. Example hostnames are not shipping defaults.
- [ ] Build pinned images on Linux amd64 and arm64, verify the effective versions, and review
  dependency/security updates before general release. Verify Nginx syntax on the actual host.
- [ ] Confirm backend/metrics/status listeners are unreachable externally, logs have only the
  documented fields, and no client secrets or payloads enter logs during success/failure tests.
- [ ] Pair clean Windows and macOS machines over the internet using `dev.alexia.pairing.v1`;
  prove identity possession before storing trust. Confirm code expiry, one-attempt invalidation,
  cancellation, replay rejection, concurrent attempts and fresh-code recovery after a restart.
- [ ] Exercise malformed/oversized fragmented WebSocket messages, global/per-IP connection
  caps, handshake flooding, long-lived socket flooding and state exhaustion. Check rejection
  signals, health recovery and tolerable limits for users behind shared NATs.
- [ ] Force relay transport between two authenticated endpoints, transfer/stream real jobs,
  verify relay RX limit metrics and public/private admission policy, and measure bandwidth,
  latency and operating cost. Test direct internet paths independently.
- [ ] Publish/resolve a signed host hint on the configured lookup service, change networks,
  and verify reconnection without accidental public lookup fallback or leaked private LAN IPs.
- [ ] Disconnect internet on already-paired machines and connect directly over LAN; reject an
  unpaired or spoofed-discovery peer. Confirm revocation closes active connections/jobs.
- [ ] Test mailbox, relay and lookup outages, DNS failure, host sleep, network changes and
  service restarts. Existing direct jobs must not depend on mailbox availability.
- [ ] Record real two-machine results, monitoring/abuse ownership and cost ownership before
  declaring the deployed defaults ready. File validation is not deployment validation.

## Pin verification and current limits of verification

Verified existing on **2026-10-02**, by successful package-index/registry responses:

| Pin | Evidence |
| --- | --- |
| `magic-wormhole-mailbox-server==0.8.0` | [PyPI release JSON](https://pypi.org/pypi/magic-wormhole-mailbox-server/0.8.0/json); inspected the released source distribution and checked the wheel hash. |
| All 21 transitive packages in `mailbox-requirements.txt` | Each pinned PyPI version JSON returned artifacts; all accepted SHA-256 hashes were copied from those responses. Hash-checked Linux/Python 3.12 dependency resolution passed for amd64 and arm64. |
| `iroh-relay=1.3.0` | [crates.io version API](https://crates.io/api/v1/crates/iroh-relay/1.3.0); released archive contains `Cargo.lock`, server binary feature and the documented options. |
| `iroh=1.3.0`, optional `iroh-dns-server=1.3.0` | [iroh API](https://crates.io/api/v1/crates/iroh/1.3.0), [DNS server API](https://crates.io/api/v1/crates/iroh-dns-server/1.3.0); inspected their released source archives. |
| `python:3.12.11-slim-bookworm` | Docker Hub Registry V2 manifest HTTP 200, digest `sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7`; manifest includes Linux amd64/arm64. |
| `rust:1.91.1-bookworm` | Docker Hub Registry V2 manifest HTTP 200, digest `sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33`; manifest includes Linux amd64/arm64. Meets relay minimum Rust 1.91. |

`docker compose -f connect-services/docker-compose.yml config` and validation using
`.env.example` passed locally. Proxy rendering, Python syntax/configuration checks and
package/hash resolution were checked without deployment. **Not verified here:** image
builds, native binary linking/startup, real Nginx `-t` (Nginx is unavailable), live TLS,
public endpoints, address-lookup deployment, two-machine behavior and deployed load/abuse
tests. No container was started, no account was created, and nothing was deployed.
Every selected top-level/image/Python dependency version pin was verified to exist; the
individual transitive Cargo.lock packages were not separately audited against their indexes.
