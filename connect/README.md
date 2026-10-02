# alexia-connect

The native transport between two paired computers: a small Rust sidecar that holds an
[iroh](https://docs.rs/iroh/1.3.0/iroh/) endpoint (pinned to exactly **1.3.0**) and moves bytes.

It does four things and no more — **encrypted connectivity**, the **endpoint identity**,
**pairing cryptography** ([Pairing](#pairing)) and **stream forwarding**.
Scheduling, permissions, setup and worker policy are core's, in TypeScript. If a decision turns
up in this crate, it is in the wrong place.

It is a standalone crate: not part of `src-tauri`, not in the pnpm workspace.

```sh
cargo build   --manifest-path connect/Cargo.toml
cargo test    --manifest-path connect/Cargo.toml
cargo build   --manifest-path connect/Cargo.toml --release   # target/release/alexia-connect
```

This document is the contract with the TypeScript client. Everything a client needs is here;
nothing in it should have to be read out of the Rust.

- [Launching](#launching)
- [The control API](#the-control-api)
- [The bridge](#the-bridge)
- [Events](#events)
- [Errors](#errors)
- [The host service's side](#the-host-services-side)
- [What crosses between two computers](#what-crosses-between-two-computers)
- [Limits](#limits)
- [Identity and the keychain](#identity-and-the-keychain)
- [Pairing](#pairing)
- [Logging](#logging)
- [Not exercised by tests](#not-exercised-by-tests)

## Launching

Start the binary with no arguments. Arguments are ignored; **nothing secret is ever read from
the command line**.

### The secret

Every launch gets a fresh secret from its parent, and every request to the loopback port must
carry it. Give it one of two ways:

| How | Detail |
| --- | --- |
| stdin (preferred) | The **first line** of stdin, ended by `\n`. Used when `ALEXIA_CONNECT_SECRET` is not set. |
| environment | `ALEXIA_CONNECT_SECRET`. Takes precedence. Removed from the process's environment before anything else starts. |

The secret must be at least **32 characters**, all visible ASCII (`0x21`–`0x7e`, no spaces). 32
random bytes as hex is the expected form. It is held in memory only and never logged.

### Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `ALEXIA_CONNECT_SECRET` | The per-launch secret (see above). | read from stdin |
| `ALEXIA_CONNECT_RELAY_URLS` | Comma-separated iroh relay base URLs. Set but empty = no relay. | none configured |
| `ALEXIA_CONNECT_LOOKUP_URL` | pkarr address-lookup base URL, e.g. `https://lookup.example.org/pkarr`. Set but empty = none. | none configured |
| `ALEXIA_CONNECT_MAILBOX_URL` | The Magic Wormhole mailbox server pairing meets at, a `ws(s)://` URL. Set but empty = none. | none configured |
| `ALEXIA_CONNECT_KEYCHAIN` | The keychain service name the endpoint key is stored under, whole. | `dev.alexia.connect` |
| `ALEXIA_CONNECT_LOG` | `off`, `error`, `warn`, `info`, `debug`. | `info` |
| `ALEXIA_CONNECT_LOOPBACK_HINTS` | **Debug builds only** (ignored by a release build). `1` = a pairing also offers this computer's loopback addresses as hints, so two sidecars on one machine can pair with no network. | unset |
| `ALEXIA_CONNECT_EPHEMERAL_KEY` | **Debug builds only** (ignored by a release build). `1` = make the key in memory and do not touch the keychain, for tests. A new identity every launch. | unset |

The relay, lookup and mailbox defaults live in `src/constants.rs` (`DEFAULT_RELAY_URLS`,
`DEFAULT_LOOKUP_URL`, `DEFAULT_MAILBOX_URL`) and are **empty**: no Alexia-operated services are
provisioned yet (`docs/connectivity-services.md`), and no third party's are used in their place.
Until the first two are set — there, by these variables, or by
[`PUT /v1/network`](#put-v1network) — two computers reach each other directly, using the hints
core supplies, or not at all. Until the mailbox is set — there, by its variable, or by
[`PUT /v1/pairing/mailbox`](#put-v1pairingmailbox) — nothing can be paired.

### The ready line

The process writes **exactly one line** to stdout, then nothing more, ever. Parse it as JSON;
do not rely on key order.

Started:

```json
{"ready":true,"protocol":1,"port":57733,"endpointId":"c14bca74d242c6a9ff51d037acd044d419f00a2ff27e891f82dffb3a015037a9"}
```

| Field | |
| --- | --- |
| `protocol` | The control API version described here: `1`. |
| `port` | The loopback port. The API is at `http://127.0.0.1:{port}`. It is chosen by the system at each launch. |
| `endpointId` | This computer's public endpoint id. |

Not started — the process then exits with status `1`:

```json
{"ready":false,"error":{"code":"keychain_failed","message":"…"}}
```

| `code` | |
| --- | --- |
| `secret_missing` | No secret, or one that is too short or not visible ASCII. |
| `config_invalid` | A relay or lookup URL in the environment is not an `http(s)` URL, or the mailbox URL is not a `ws(s)` URL. |
| `keychain_failed` | The endpoint key could not be read from or written to the OS keychain. |
| `bind_failed` | The endpoint or the loopback port could not be opened. |

### Stopping

**Keep stdin open for as long as the sidecar should run.** When stdin reaches end-of-file the
process closes every connection and exits `0` — so a parent that dies takes its sidecar with it.
(With the secret in the environment and stdin at `/dev/null`, it therefore exits at once.)
`POST /v1/shutdown` does the same.

### State after a launch

Nothing is remembered between launches except the endpoint key. A fresh process has an **empty
allowlist** (it accepts nobody), **no host service** (it forwards nothing) and no hints. Core
supplies all three after every start, in this order:

1. `PUT /v1/allowlist` — who is paired.
2. `PUT /v1/peers/{id}/hints` for each — where to find them. (Refused for an id not on the allowlist.)
3. On a compute host: `PUT /v1/host` — what may be asked for.
4. `GET /v1/events` — to follow connection state.

## The control API

HTTP/1.1 on `127.0.0.1:{port}`. Bodies are JSON (`content-type: application/json`), at most
64 KiB. Unknown fields in a request body are an error, not ignored.

**Authentication.** Every request — control, bridge, and events — must send

```
Authorization: Bearer <secret>
```

A request without it, or with any other value, gets `401` with code `unauthorized`, whatever
its path: the secret is checked before the path is looked at.

**Endpoint ids** are 64 lowercase hexadecimal characters, everywhere, in both directions.

**Responses** are `200` with a JSON body on success. Every failure is a JSON error body and an
`x-alexia-connect-error` header (see [Errors](#errors)).

| Method and path | Purpose |
| --- | --- |
| `GET /v1/status` | Who this is, how it is configured. |
| `GET /v1/peers` | Each paired computer and how it is reached. |
| `GET /v1/events` | The same, as a stream of changes. |
| `PUT /v1/allowlist` | Replace the list of paired endpoints. |
| `DELETE /v1/allowlist/{endpointId}` | Revoke one. |
| `PUT /v1/peers/{endpointId}/hints` | Say where a paired endpoint may be found. |
| `POST /v1/peers/{endpointId}/connect` | Connect now rather than at the first request. |
| `PUT /v1/host` | Register the host service and its operations. |
| `DELETE /v1/host` | Stop forwarding. |
| `PUT /v1/network` | Change relay and lookup services. |
| `GET /v1/pairing`, `PUT /v1/pairing/mailbox`, `POST /v1/pairing/host`, `POST /v1/pairing/join`, `GET`/`DELETE /v1/pairing/{pairingId}` | Pairing. See [Pairing](#pairing). |
| `POST /v1/shutdown` | Close everything and exit. |
| `ANY /bridge/{endpointId}/…` | A request to a paired computer. See [The bridge](#the-bridge). |

Anything else is `404 not_found`.

### `GET /v1/status`

```json
{
  "protocol": 1,
  "version": "0.1.0",
  "endpointId": "c14b…37a9",
  "relayUrl": null,
  "directAddresses": ["192.168.1.20:57835"],
  "boundAddresses": ["0.0.0.0:57835", "[::]:52203"],
  "network": { "relayUrls": [], "lookupUrl": null },
  "host": { "port": 41234, "operations": [{ "name": "chat", "method": "POST", "path": "/v1/chat/completions" }] },
  "allowlist": ["9f2e…01bc"]
}
```

| Field | |
| --- | --- |
| `relayUrl` | This endpoint's home relay, or `null` if none is configured or reached yet. |
| `directAddresses` | `ip:port` addresses this endpoint currently believes it can be reached at. May be empty, and changes with the network. |
| `boundAddresses` | The local UDP sockets. |
| `network` | The relay and lookup services in use. |
| `host` | The registered host service, or `null`. Its secret is never included. |
| `allowlist` | The paired endpoint ids, sorted. |

`endpointId`, `relayUrl` and `directAddresses` are what a pairing exchange would hand the other
computer as its hints. There is **no** request that returns the private key.

### `GET /v1/peers`

```json
{ "peers": [{ "endpointId": "9f2e…01bc", "status": "direct" }] }
```

One entry for every endpoint on the allowlist, sorted by id. `status` is one of:

| `status` | |
| --- | --- |
| `direct` | Connected, and traffic is going straight to the other computer. |
| `relayed` | Connected, and traffic is going through a relay (still end-to-end encrypted). |
| `offline` | No open connection. |

A connection is opened on demand, by the first bridge request or by `connect`; a paired
computer nobody has talked to yet is `offline`, which is not the same as unreachable. A
connection with no traffic for 15 seconds is closed and the peer becomes `offline`; iroh's
keep-alive holds an idle but healthy one open. `direct`/`relayed` follows the path QUIC has
selected, and can change either way while a connection is up.

### `PUT /v1/allowlist`

```json
{ "endpointIds": ["9f2e…01bc"] }
```

Makes the allowlist **exactly** this list (at most 64). Idempotent. Every endpoint that was on
it and no longer is, is revoked as below.

```json
{ "endpointIds": ["9f2e…01bc"], "revoked": [] }
```

`400 bad_request` if any id is not an endpoint id; nothing is changed in that case.

### `DELETE /v1/allowlist/{endpointId}`

Revokes one endpoint. Before the response is sent:

- it is off the allowlist;
- every open connection with it, in either direction, is closed, which resets every stream on
  it — jobs in flight end with a broken response on the interaction side and a dropped
  connection at the host service;
- its hints are forgotten;
- a `peer` event with `offline` is emitted if it was connected.

```json
{ "revoked": true }
```

`revoked` is `false` if it was not on the allowlist. A revoked endpoint that tries again is
refused at the handshake.

### `PUT /v1/peers/{endpointId}/hints`

```json
{ "relayUrl": "https://relay.example.org/", "directAddresses": ["192.168.1.20:57835"] }
```

Both fields are optional; `relayUrl` may be `null`. `directAddresses` are `ip:port` (IPv6 as
`[addr]:port`), at most 16. **Replaces** any earlier hints for that endpoint. Returns
`{ "ok": true }`.

Hints come from wherever core has them: the pairing record, the last known address, LAN
discovery. **A hint is never authorization.** It is accepted only for an endpoint already on
the allowlist (`403 peer_not_allowed` otherwise), and whatever answers at a hinted address must
still prove, in the handshake, that it holds that endpoint's private key. This is also how two
paired computers connect on an offline LAN: with a direct-address hint and no relay or lookup
service at all.

### `POST /v1/peers/{endpointId}/connect`

No body. Uses the open connection if there is one, otherwise dials (up to 15 seconds).

```json
{ "endpointId": "9f2e…01bc", "status": "direct" }
```

Errors: `403 peer_not_allowed`, `502 peer_unreachable`. If the other computer does not have
this one on *its* allowlist, the dial can succeed and the connection be closed a moment later:
this call may then return a status that an `offline` event immediately corrects, and the first
bridge request reports `peer_rejected`.

### `PUT /v1/host`

Only a compute host calls this.

```json
{
  "port": 41234,
  "secret": "…",
  "operations": [
    { "name": "chat", "method": "POST", "path": "/v1/chat/completions" },
    { "name": "artifact", "method": "GET", "path": "/v1/artifacts/:id" }
  ]
}
```

| Field | |
| --- | --- |
| `port` | The host service's port on `127.0.0.1`. There is no host field: the forwarder cannot be pointed anywhere but this computer's loopback. |
| `secret` | Optional. Sent to the host service as `Authorization: Bearer <secret>` on every forwarded request. Visible ASCII. |
| `operations` | At most 64. The complete list of what a paired computer may ask for. |

An operation:

| Field | |
| --- | --- |
| `name` | For logs. 1–64 of `a-z 0-9 . _ -`. |
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. |
| `path` | Starts with `/`. Each segment is literal (`A-Z a-z 0-9 . _ ~ -`, not `.` or `..`) or `:name`, which matches exactly one such segment of a request, up to 128 characters. No wildcards, no query. |

A request matches an operation when the method is equal and the path — up to any `?` —
matches segment for segment. A query string is allowed on any operation and is passed to the
host service untouched. Percent-escapes, empty segments and trailing slashes never match.

Replaces any earlier registration whole. Returns the [status](#get-v1status) object.
`400 bad_request` if anything is malformed; the earlier registration then stands.

### `DELETE /v1/host`

Forgets the host service. Requests from paired computers are answered `host_unavailable` until
it is registered again. Streams already being forwarded run to their end. Returns the status
object.

### `PUT /v1/network`

```json
{ "relayUrls": ["https://relay.example.org/"], "lookupUrl": "https://lookup.example.org/pkarr" }
```

`relayUrls` is required (may be `[]` for none); `lookupUrl` may be `null` or omitted for none.
Both must be `http` or `https` URLs. The one lookup URL is used for publishing **and**
resolving, so a self-hosted publisher is never left beside a public resolver; only the relay
URL is published, never LAN addresses.

This **replaces the endpoint**: same identity, new sockets. Every connection is closed, every
job in flight is broken, and peers reconnect on the next request. Call it when idle. The
allowlist, hints and host registration are kept. Returns the status object.

Errors: `400 bad_request` (not a URL), `502 network_failed` (the new endpoint could not be
opened; the old one is untouched).

### `POST /v1/shutdown`

Returns `{ "ok": true }`, then closes every connection and exits `0`. A pairing still `waiting`
is cancelled.

## The bridge

```
ANY /bridge/{endpointId}/{path…}[?query]
```

is `{path…}[?query]` on the compute service of the paired computer `{endpointId}`. Point the
existing provider client at

```
baseURL = http://127.0.0.1:{port}/bridge/{endpointId}/v1
apiKey  = <the per-launch secret>
```

and it works as against any other OpenAI-compatible server, streaming included: the response
body is passed through as it arrives, so an SSE parser sees events when the host produced them.

- **One request is one QUIC stream.** Jobs and artifacts never share a stream; a slow or stuck
  one does not delay another. At most 64 are open with one peer; the 65th waits for one to end.
- **The connection is opened on demand** and reused. The first request to a peer may take up to
  15 seconds to fail with `peer_unreachable`.
- **A loopback URL is not proof of where inference runs.** It runs on the other computer.
- **Request headers carried across:** `content-type`, `content-length`, `accept`, and any
  header starting `x-alexia-` except `x-alexia-peer`. Nothing else — in particular the
  `Authorization` header carrying the per-launch secret stays on this computer.
- **Response headers carried back:** `content-type`, `content-length`, `cache-control`, and any
  `x-alexia-` header.
- **The status code** is the host service's own.

### Telling the sidecar's answers from the host service's

A response written by a sidecar rather than by the host service always has the header
`x-alexia-connect-error: <code>` and the [error body](#errors). A response without that header
came from the host service, whatever its status.

### Cancellation

**To cancel a job, abort the HTTP request** (close the connection). The QUIC stream is reset,
the other sidecar drops its connection to the host service, and the host service sees its
caller disconnect. This works before the first byte of the response as well as in the middle
of it. There is no cancel request.

In the other direction, a job that ends badly — the host service fails mid-response, the
connection is lost, the peer is revoked — **breaks the HTTP response** rather than ending it:
the client sees a body error (an incomplete chunked response), never a short body that looks
complete.

### Backpressure

Nothing is buffered without bound anywhere on the path. Each hop reads the next piece only when
the previous one has been accepted downstream, so a reader that slows down slows the host
service's writes. Between the two computers the buffering is QUIC's flow-control windows
([Limits](#limits)); on each loopback side it is the socket buffers.

## Events

`GET /v1/events` is a `text/event-stream` that stays open. Three events, all JSON in `data:`
— `snapshot` and `peer` here, and `pairing`, described under
[The `pairing` event](#the-pairing-event). A client should ignore an event name it does not know.

```
event: snapshot
data: {"peers":[{"endpointId":"9f2e…01bc","status":"offline"}]}

event: peer
data: {"endpointId":"9f2e…01bc","status":"direct"}

```

| Event | |
| --- | --- |
| `snapshot` | Every paired endpoint and its status — the same as `GET /v1/peers`. Always the first event. **Replace** everything known with it. It is sent again if the subscriber fell more than 64 events behind, in place of the changes it missed. |
| `peer` | One endpoint's status changed. Also sent with `offline` for an endpoint that has just been revoked and is no longer in `/v1/peers`. |

A comment line `: keepalive` is sent after 15 seconds of silence. Subscribing and then reading
the first `snapshot` cannot miss a change; calling `/v1/peers` and then subscribing can.

## Errors

```json
{ "error": { "code": "peer_unreachable", "message": "the other computer could not be reached" } }
```

Switch on `code` (also in the `x-alexia-connect-error` header). `message` is for a log, not
for a person, and may change.

| `code` | HTTP | Where | Meaning |
| --- | --- | --- | --- |
| `unauthorized` | 401 | all | No secret, or the wrong one. |
| `not_found` | 404 | control | No such request. |
| `bad_request` | 400 | all | Malformed id, JSON, URL, address or path; unknown field; over a count limit. |
| `payload_too_large` | 413 | control | Request body over 64 KiB. |
| `peer_not_allowed` | 403 | bridge, `hints`, `connect` | That endpoint is not on **this** computer's allowlist. |
| `peer_rejected` | 403 | bridge | The **other** computer does not have this one on its allowlist, or has revoked it. |
| `peer_unreachable` | 502 | bridge, `connect` | Could not connect, or the connection was lost before the response began. |
| `operation_not_registered` | 403 | bridge | The other computer does not offer that method and path. Its host service was not contacted. |
| `host_unavailable` | 503 | bridge | The other computer has no host service registered, or it did not accept the connection. |
| `stream_failed` | 502 | bridge | The other computer ended the request without a valid answer. |
| `network_failed` | 502 | `PUT /v1/network` | The endpoint could not be reopened with the new services. |
| `mailbox_not_configured` | 503 | `pairing/host`, `pairing/join` | No mailbox server is set. |
| `already_paired` | 409 | `pairing/host`, `pairing/join` | `exclusive` is true and the allowlist is not empty. |
| `pairing_limit` | 429 | `pairing/host`, `pairing/join` | Four pairings are already in progress. |
| `pairing_mailbox_failed` | 502 | `pairing/host` | The mailbox server could not be reached. |

The codes a *pairing* fails with (`pairing_expired` and the rest) are not HTTP errors; they are
in the pairing's own `error`, listed under [The pairing object](#the-pairing-object).

None of these are retried by the sidecar, and a job is never resubmitted by it.

## The host service's side

What the dedicated host service on a compute host should expect from the forwarder:

- Plain HTTP/1.1 on `127.0.0.1:{port}`, **one TCP connection per request**, never reused.
- `Host: 127.0.0.1:{port}`.
- `x-alexia-peer: <endpoint id>` — who asked. Set by the forwarder from the authenticated
  connection; a value sent by the other computer is discarded.
- `Authorization: Bearer <secret>` if a `secret` was registered. The service should require
  it: the port is reachable by any local process, and this is how it knows the forwarder.
- The carried request headers listed under [The bridge](#the-bridge); a request with no body
  arrives with no body.
- **The connection closing before the response is complete means the caller cancelled** (or
  was revoked, or went offline). Stop the job.
- Only registered operations ever arrive, and only from allowlisted endpoints. Both checks
  happen before the connection is opened.

## What crosses between two computers

For whoever changes the Rust; a TypeScript client never sees this. ALPN `alexia/compute/1`.
Connections are refused at the handshake unless the remote endpoint id is on the allowlist —
incoming and outgoing — and the allowlist is checked again on every stream. Unidirectional
streams are not accepted. Each bidirectional stream is one request:

```
→ u32 big-endian length | {"method","path","headers":[[name,value]…],"body":bool} | body … FIN
← u32 big-endian length | {"status","headers"} or {"error":{"code","message"}}   | body … FIN
```

A head is at most 16 KiB and must arrive within 10 seconds. A stream ended by reset instead
of FIN is a cancelled or failed body. Connection close codes: `0` normal, `1` not paired,
`2` revoked, `3` shutdown.

## Limits

All in `src/constants.rs`.

| | |
| --- | --- |
| Control request body | 64 KiB |
| Loopback connections at once | 256 |
| Request headers must arrive within | 10 s |
| Path and query on the bridge | 2048 bytes |
| Allowlist | 64 endpoints |
| Operations | 64 |
| Direct-address hints per peer | 16 |
| Concurrent streams per connection | 64 |
| QUIC stream receive window | 1 MiB |
| QUIC connection receive window | 8 MiB |
| QUIC send window | 8 MiB |
| Idle timeout | 15 s |
| Dial timeout | 15 s |
| Host service connect timeout | 5 s |
| Events held for a slow subscriber | 64 |

## Identity and the keychain

The endpoint's private key is generated on first launch and stored in the OS keychain
(`keyring` 4.2, as `src-tauri`) under service `dev.alexia.connect`, account `endpoint-key`.
The keychain trusts the program that made an entry, so the key answers to this binary and not
to core, which is a program that runs any script.

- The service is deliberately **not** `dev.alexia.app`, the shell vault's: the vault reads any
  entry core names, and this one must be out of its reach.
- A build compiled with `ALEXIA_KEYCHAIN=<name>` (as `pnpm app:dev` sets for Alexia Dev) uses
  service `<name>.connect`, so a dev build never shares the real app's identity.
  `ALEXIA_CONNECT_KEYCHAIN` at run time names the service whole and wins over both.
- A stored key that cannot be parsed is a **startup error** (`keychain_failed`), never replaced:
  a new key is a new identity, and every paired computer would stop trusting this one.
- There is no API request, log line or error that contains the key.

## Pairing

Two computers that have never met agree on each other's endpoint identity with a short code
that one shows and the other types. The bootstrap is Magic Wormhole's authenticated mailbox
exchange (SPAKE2 over a rendezvous server, application id `dev.alexia.pairing.v1`); the proof
that each side really holds the identity it named is done over iroh, under an ALPN of its own
(`alexia/pairing/1`). The sidecar does the cryptography and reports a proven peer. **It does
not pair anybody**: core persists the record and puts the id on the allowlist.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/pairing` | The mailbox in use and every pairing this launch still remembers. |
| `PUT /v1/pairing/mailbox` | Set or clear the mailbox server. |
| `POST /v1/pairing/host` | Open a pairing. Returns the code to show. |
| `POST /v1/pairing/join` | Join a pairing by the code somebody typed. |
| `GET /v1/pairing/{pairingId}` | One pairing's state; with `?wait=true`, held until it settles. |
| `DELETE /v1/pairing/{pairingId}` | Cancel it. |

and one event on [`GET /v1/events`](#events): `pairing`.

### The flow

1. Computer A: `POST /v1/pairing/host` → `{ pairingId, code, expiresAt }`. A person reads `code`.
2. Computer B: `POST /v1/pairing/join` with that code → `{ pairingId, expiresAt }`.
3. Each side learns the outcome **once**, as a [pairing object](#the-pairing-object) whose
   `state` is `paired` or `failed`: from the `pairing` event, or from
   `GET /v1/pairing/{pairingId}?wait=true`. Both carry the same object; use either.
4. On `paired`, core writes its pairing record, then `PUT /v1/allowlist` with the peer's
   `endpointId` included, then `PUT /v1/peers/{id}/hints` with `peer.hints` as given. Nothing
   is on the allowlist until core does this; the two computers cannot exchange compute traffic
   before both have.

`paired` is reported only after the possession proof below has succeeded **in both
directions**. A pairing that reaches `failed` reports no peer at all.

### The code

`<mailbox number>-<word>-<word>-<word>-<word>`, for example `7-crossover-clockwork-guitarist-tonic`:
a decimal number the mailbox server allocated, and four lowercase words drawn at random from the
PGP word list, 256 choices each (32 bits, which is enough only because of the one-attempt rule).

- **Five minutes.** `expiresAt` is five minutes after the code was issued. A hosted pairing that
  is not `paired` by then is `failed` with `pairing_expired`.
- **One attempt.** The first joiner to arrive is the attempt. If it had the wrong words the
  hosted pairing is `failed` with `pairing_wrong_code`; nobody else may try that code.
- **Dead after anything.** Success, authentication failure, cancellation, expiry and every
  other failure all end the same way on the computer that issued the code: its half of the key
  exchange is destroyed, and without it nothing can be completed under that code by anybody. A
  later join with that code is `failed` — with `pairing_code_unknown` when the mailbox server
  has let go of the number (always after a success; after a wrong code, because the number has
  had its two computers), and otherwise with `pairing_timeout`, because the server still holds
  the number for a while but nobody is behind it (see
  [What the wormhole crate does not give](#what-the-wormhole-crate-does-not-give)). A failed
  attempt needs a fresh `POST /v1/pairing/host`.
- The code is in the response to `POST /v1/pairing/host` and **nowhere else**: not in the
  pairing object, not in an event, not in `GET /v1/pairing`, not in a log line.

### The mailbox server

A Magic Wormhole mailbox (rendezvous) server, as a `ws://` or `wss://` URL including its path,
e.g. `wss://mailbox.example.org/v1`. It comes from, in order: `PUT /v1/pairing/mailbox`, the
environment variable `ALEXIA_CONNECT_MAILBOX_URL` (set but empty = none), `DEFAULT_MAILBOX_URL`
in `src/constants.rs`. That default is **empty**, like the relay's: no Alexia mailbox service
is provisioned yet, and the public Magic Wormhole server is not used in its place. With none
configured, `host` and `join` answer `503 mailbox_not_configured`. Both computers must use the
same server. The server must leave the protocol's `list` request enabled: a join asks whether
its number is open before claiming it, and a server that answers with an empty list makes every
join `pairing_code_unknown`.

`wss://` uses the operating system's TLS and trust store (Secure Transport on macOS, SChannel on
Windows; OpenSSL on Linux, which a build there needs installed).

An invalid `ALEXIA_CONNECT_MAILBOX_URL` at launch is the ready line's `config_invalid`.

### `GET /v1/pairing`

```json
{ "mailboxUrl": "wss://mailbox.example.org/v1", "pairings": [ { "pairingId": "…", "role": "host", "state": "waiting", "expiresAt": 1790950000000 } ] }
```

`mailboxUrl` is `null` when none is configured. `pairings` are [pairing objects](#the-pairing-object),
oldest first: every one still `waiting`, and the last 16 that settled.

### `PUT /v1/pairing/mailbox`

```json
{ "url": "wss://mailbox.example.org/v1" }
```

`url` is required (leaving it out is `400 bad_request`) and may be `null` for none. Applies to pairings started afterwards; one in
progress keeps the server it began on. Nothing else is touched (the endpoint is not rebound).
Returns `{ "mailboxUrl": "wss://mailbox.example.org/v1" }`. `400 bad_request` if it is not a
`ws`/`wss` URL; the earlier setting then stands.

### `POST /v1/pairing/host`

```json
{ "name": "Studio PC", "payload": { "role": "compute", "platform": "win32", "appVersion": "2.4.0" }, "exclusive": true }
```

| Field | |
| --- | --- |
| `name` | Required. This computer's display name, shown on the other one. 1–128 bytes of UTF-8, no control characters. |
| `payload` | Optional, default `null`. Any JSON value, at most **1024 bytes** when serialized. Carried to the other computer inside the authenticated channel and handed to its core untouched; the sidecar does not read it. |
| `exclusive` | Optional, default **`true`**. When true the pairing is refused with `already_paired` while the allowlist is not empty. This is the "one controller per compute host" rule: core, which owns the rule, leaves it true on a compute host and unpairs (`DELETE /v1/allowlist/{id}`) before hosting again. A computer that may have several peers sends `false`. |

The sidecar reaches the mailbox server and has a number allocated **before** it answers, so
this request can take up to 15 seconds.

```json
{ "pairingId": "b3f1c2a49d5e6f70", "code": "7-crossover-clockwork-guitarist-tonic", "expiresAt": 1790950000000 }
```

| Field | |
| --- | --- |
| `pairingId` | 16 lowercase hex characters. Names this pairing in everything below. It is not secret and is not the code. |
| `code` | What a person reads to the other computer. |
| `expiresAt` | Milliseconds since the Unix epoch. |

Errors: `400 bad_request`, `503 mailbox_not_configured`, `409 already_paired`,
`429 pairing_limit` (four pairings are already in progress), `502 pairing_mailbox_failed`
(the server could not be reached, or refused). No pairing exists after an error.

### `POST /v1/pairing/join`

```json
{ "code": "7-crossover-clockwork-guitarist-tonic", "name": "Vaclav's MacBook", "payload": { "role": "interaction", "platform": "darwin", "appVersion": "2.4.0" }, "exclusive": false }
```

`name` and `payload` as above. `exclusive` is optional and defaults to **`false`** here. `code`
is trimmed and lowercased, and must then be a number, a hyphen, and four hyphen-separated
words of `a-z` (`400 bad_request` otherwise, and no attempt is made — a typo that is not even
shaped like a code does not burn the host's code).

Answers at once, before the mailbox is contacted:

```json
{ "pairingId": "0a7d19e2c4b85f31", "expiresAt": 1790949760000 }
```

`expiresAt` here is this attempt's own deadline, **60 seconds** from now: a join either
completes or fails within it (`pairing_timeout`). It is not the code's expiry, which only the
hosting computer knows.

Errors: `400 bad_request`, `503 mailbox_not_configured`, `409 already_paired`,
`429 pairing_limit`. Everything that goes wrong after that is the pairing's `failed` state,
not an HTTP error.

### `GET /v1/pairing/{pairingId}`

Returns the [pairing object](#the-pairing-object) as it is now. With `?wait=true` the response
is held until `state` is no longer `waiting`, then sent; a pairing always settles (a host's by
`expiresAt`, a join's within 60 seconds), so the wait is bounded. Aborting the request does
**not** cancel the pairing. `404 not_found` for an id this launch never issued or has forgotten
(only the last 16 settled pairings are kept).

### `DELETE /v1/pairing/{pairingId}`

Cancels a `waiting` pairing: whatever it was doing stops, its connection to the mailbox and its
pairing connection are dropped, the code is dead, and the pairing becomes `failed` with
`pairing_cancelled` (the event is emitted before the response is sent). The other computer, if
it had arrived, sees `pairing_timeout` or `pairing_proof_failed`, depending on how far it had
got.

```json
{ "cancelled": true }
```

`cancelled` is `false` if it had already settled — the outcome it settled with stands, and a
`paired` result that raced a cancel must still be handled (core should not allowlist it).
`404 not_found` for an unknown id.

### The pairing object

Waiting:

```json
{ "pairingId": "b3f1c2a49d5e6f70", "role": "host", "state": "waiting", "expiresAt": 1790950000000 }
```

Paired:

```json
{
  "pairingId": "b3f1c2a49d5e6f70",
  "role": "host",
  "state": "paired",
  "expiresAt": 1790950000000,
  "peer": {
    "endpointId": "9f2e…01bc",
    "name": "Vaclav's MacBook",
    "payload": { "role": "interaction", "platform": "darwin", "appVersion": "2.4.0" },
    "hints": { "relayUrl": null, "directAddresses": ["192.168.1.20:57835"] }
  }
}
```

Failed:

```json
{ "pairingId": "b3f1c2a49d5e6f70", "role": "host", "state": "failed", "expiresAt": 1790950000000, "error": { "code": "pairing_expired", "message": "…" } }
```

| Field | |
| --- | --- |
| `role` | `host` (this computer issued the code) or `join`. |
| `state` | `waiting`, then exactly one of `paired` or `failed`, which never changes again. |
| `peer` | Only when `paired`. `endpointId` is the identity the other computer **proved** it holds. `name` and `payload` are what its core sent, unverified beyond having come through the authenticated channel — text to show, not to trust. `hints` has exactly the shape `PUT /v1/peers/{id}/hints` takes. |
| `error` | Only when `failed`. Switch on `code`. |

Why a pairing failed (`error.code`):

| `code` | On | Meaning | A client's three-way mapping |
| --- | --- | --- | --- |
| `pairing_expired` | host | Five minutes passed without a proven peer. | expired |
| `pairing_cancelled` | both | `DELETE /v1/pairing/{id}`, or the sidecar is shutting down. | cancelled |
| `pairing_code_unknown` | join | The mailbox has no open pairing under that number, or two computers have already used it: never issued, already used, or (once the server has let go of it) cancelled or expired. | refused |
| `pairing_wrong_code` | both | The words did not match (the key exchange failed to authenticate). On the host this is the one attempt, spent. | refused |
| `pairing_proof_failed` | both | The other computer did not prove, over iroh, that it holds the endpoint identity it named — or could not be reached to try. | refused |
| `pairing_peer_invalid` | both | The other side sent something that is not this protocol: malformed, oversized, a different version, or its own id. | refused |
| `pairing_mailbox_failed` | both | The mailbox server could not be reached, dropped the connection, or refused. | refused |
| `pairing_timeout` | join | The attempt did not finish within its 60 seconds — typically a code that was cancelled or has expired, whose host is no longer there. | refused (or expired) |
| `already_paired` | both | `exclusive` was true and the allowlist became non-empty while this pairing was in progress. The other computer may by then have been told `paired`: it proved itself, and was then not wanted. Core's own refusal covers it. | refused |

### The `pairing` event

On `GET /v1/events`, beside `snapshot` and `peer`:

```
event: pairing
data: {"pairingId":"b3f1c2a49d5e6f70","role":"host","state":"paired","expiresAt":1790950000000,"peer":{…}}

```

`data` is a [pairing object](#the-pairing-object). It is emitted **once per pairing, when it
settles** (`paired` or `failed`) — never for `waiting`, and never containing the code. It is
not replayed in a `snapshot`: a subscriber that connected late, or fell behind, reads
`GET /v1/pairing/{pairingId}`.

### Error codes this section adds

HTTP errors, in the usual [error body](#errors):

| `code` | HTTP | Where | Meaning |
| --- | --- | --- | --- |
| `mailbox_not_configured` | 503 | `host`, `join` | No mailbox server is set. |
| `already_paired` | 409 | `host`, `join` | `exclusive` is true and the allowlist is not empty. Unpair first. |
| `pairing_limit` | 429 | `host`, `join` | Four pairings are already `waiting`. |
| `pairing_mailbox_failed` | 502 | `host` | The mailbox server could not be reached or would not allocate a number. |

### What is exchanged, and the proof

For whoever changes the Rust. The bootstrap is the `magic-wormhole` crate, pinned to exactly
**0.8.1**, with its transit and file-transfer features off: the mailbox connection, SPAKE2 and
the encrypted `version` exchange are its code, not this crate's. Each side's message rides in
that `version` exchange as the wormhole's `app_versions`, so it is encrypted and authenticated
by the key the code produced, and a side with the wrong words never reads it:

```json
{ "alexia": 1, "hello": "{\"endpointId\":\"…64 hex…\",\"name\":\"…\",\"payload\":…,\"hints\":{\"relayUrl\":null,\"directAddresses\":[]}}" }
```

`hello` is JSON carried as a string — at most 4 KiB — so that both sides hash the same bytes.
A `hello` that is too long, names the reader's own id, or breaks any limit core's own requests
are held to, is `pairing_peer_invalid`. The mailbox is then closed. Neither side trusts the
`endpointId` it read yet.

The joiner dials the host's `endpointId` over iroh with ALPN `alexia/pairing/1`, at the hinted
addresses, retrying every 250 ms while the host is still getting ready; the host accepts that
ALPN **only** from the endpoint id a pairing in progress has just been told, once, and
everything else under it is refused at the handshake (`transport::Gate`). iroh's handshake
authenticates both endpoint ids, so a connection that completes is each side holding the key
for the id the other dialled or expected. On one bidirectional stream they then bind that
connection to this pairing, with `K` = the wormhole session key's subkey for purpose
`alexia/pairing/1/proof` and `T` = SHA-256 over `len(hello) | hello` for the host's `hello`
and then the joiner's (lengths as 32-bit big-endian):

```
joiner → host   nonce_j (32 bytes)
host → joiner   nonce_h (32 bytes) | HMAC-SHA256(K, "host" | T | host id | joiner id | nonce_j | nonce_h)
joiner → host   HMAC-SHA256(K, "join" | T | joiner id | host id | nonce_j | nonce_h)
host → joiner   0x01
```

where each id is the 32-byte key **iroh authenticated on this connection**, not the one read
from a message. A side that advertised an id it does not hold cannot complete the handshake as
that id; one that relays the messages of another pairing does not know `K`. The whole proof
must finish within 30 seconds. Only then is `paired` reported, and the pairing connection is
closed. It is never counted as a paired connection: compute traffic still needs core to put the
id on the allowlist.

The endpoint's private key is used in place by the endpoint. Pairing adds no request that
returns it.

### What the wormhole crate does not give

Using the crate rather than a hand-written client has costs, and they are here rather than
hidden:

- **A code that dies without a peer is not released at the server.** The crate can only say
  goodbye to a mailbox once the exchange has completed. On cancel, expiry or a wrong code this
  process drops its connection, which destroys its half of the exchange — that is what makes
  the code dead — but the server keeps the number claimed until it prunes it. The plan's
  server-side limits (attempts, expiry) belong to the mailbox service, `connect-services/`.
- **No size limit on what the mailbox server sends.** The crate's WebSocket accepts messages
  up to its library's default (64 MiB). This crate limits what it *accepts as a pairing
  message* (4 KiB, after decryption) and every proof read is a fixed length, but it cannot
  bound the frame the crate reads first. A mailbox server is therefore trusted not to flood.
- **A mailbox server can ask for work.** The crate answers a server's hashcash demand,
  whatever its size, before the 15-second limit can interrupt it.
- **It logs pairing messages** at `debug`. They are never printed: see [Logging](#logging).
- **TLS is the platform's**, not the `rustls` iroh uses: the crate's own `tls` feature does not
  compile at this version, so `native-tls` is the one enabled.
- **Licence.** `magic-wormhole` is EUPL-1.2; this crate is AGPL-3.0-only. The EUPL names the
  AGPL as a compatible licence, but that is the owner's call to confirm before a release.

### Limits

| | |
| --- | --- |
| Code lifetime | 5 minutes |
| A join attempt, start to finish | 60 s |
| Reaching the mailbox server | 15 s |
| The possession proof | 30 s |
| Pairings `waiting` at once | 4 |
| Settled pairings remembered | 16 |
| `name` | 128 bytes |
| `payload`, serialized | 1024 bytes |
| One pairing message inside the wormhole | 4 KiB |
| Retry of the proof's dial | every 250 ms |

LAN discovery (mDNS) is **not** implemented here. If core or a later change discovers a paired
computer's LAN address, it is supplied as a hint.

## Logging

To stderr, this crate's own lines only — iroh's and the wormhole crate's are filtered out
(`alexia_connect::logged`). What is logged: the port, shortened endpoint ids (the first ten hex
characters), operation names, status changes, counts and status codes, a pairing's id, role
and the code it failed with, and at `debug` iroh's own error text for a dial that failed. What
never is: the secret, the host service's secret, any key, header values, paths or queries,
payload bytes, a pairing code or any part of one, the mailbox number, and anything said inside
a pairing.

## Not exercised by tests

`cargo test` runs eight in-process integration tests of the transport (`tests/transport.rs`)
and nine of pairing (`tests/pairing.rs`) over real iroh endpoints on one machine, plus unit
tests. The transport tests cover: forwarding and streaming back for an allowlisted peer,
concurrent independent streams, backpressure reaching the host service, cancellation before
and after the first byte, rejection of a non-allowlisted peer, of an unregistered operation and
of a call without the secret, revocation closing a live connection, events, and a network
change keeping the identity.

The pairing tests run the real `magic-wormhole` client against a mailbox **stub** written in
the test (a WebSocket server implementing `bind`, `list`, `allocate`, `claim`, `release`,
`open`, `add` and `close`). They cover: a pairing end to end, including the possession proof
over iroh and core then allowlisting and connecting; a wrong code failing both sides and
spending the code; a used code; expiry (with a 1.5-second lifetime in place of five minutes);
cancellation of a hosted pairing and of a join; three pairings at once at one mailbox, two of
them on one computer, each finding its own peer; a joiner and a host that each name an identity
they do not hold; a host that names nobody, another protocol version, and an oversized message;
the mailbox server dropping every connection; every refusal with its code; the one-controller
rule before a pairing and during one; and that no code, and no line of the wormhole crate's,
reaches a log captured through the binary's own filter at `trace`.

They do **not** cover, and nothing here should be read as evidence for:

- **A real mailbox server.** No deployed `magic-wormhole-mailbox-server`, the public one or an
  Alexia one, has been spoken to. The stub was written from the client's own source, so a
  disagreement between that client and a real server would not show here. In particular the
  server's `crowded`, pruning and `list` behaviour are assumed, not observed.
- **`wss://`.** Every test mailbox is `ws://` on loopback. TLS to a mailbox is not exercised.
- **Pairing across a network, or between two machines.** Both ends of every pairing are in one
  process and prove themselves over loopback addresses (a test-only setting adds them to the
  hints). Pairing through a relay, across NATs, or with a five-minute wait is untested.
- **The full five-minute lifetime and the 60-second join limit**, at their real lengths.
- **A hashcash demand**, a slow or hostile mailbox server, and reconnecting to one.
- **Relay fallback.** No relay is configured in any test; every connection is direct. The
  `relayed` status and a direct↔relayed change have never been observed.
- **Address lookup.** The pkarr publisher and resolver are wired but never contacted.
- **Real NAT traversal**, hole punching, or any path between two machines. Everything runs
  over loopback on one computer.
- **Network changes, sleep, and the 15-second idle timeout** turning a peer `offline`.
- **The keychain.** Tests use in-memory keys; only the key's encoding is unit-tested. Reading,
  writing and persistence across launches, and the Windows and Linux stores, are untested.
- **Windows.** Built and run on macOS (arm64) only.
- **Performance** against the plan's throughput and latency targets.
- **`cargo clippy`** was not run: the component is not installed in this toolchain.
