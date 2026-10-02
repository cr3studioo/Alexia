// SPDX-License-Identifier: AGPL-3.0-only

//! Every default and every limit, in one place. Nothing else in the crate holds a number or a
//! name that somebody might want to change.

use std::time::Duration;

/// The control API's version, reported on the ready line and by `/v1/status`.
pub const PROTOCOL: u32 = 1;

/// What two computers speak to each other. A change to `wire.rs` is a new number here, and an
/// endpoint that does not offer the same one fails the handshake rather than a job.
pub const ALPN: &[u8] = b"alexia/compute/1";

/// Relay servers used when a direct connection is not possible. **Empty**, deliberately: the
/// Alexia-operated services are not provisioned yet (`docs/connectivity-services.md`), and a
/// public third-party relay is not something to send anybody's traffic metadata to by default.
/// With none configured, two computers reach each other directly or not at all.
pub const DEFAULT_RELAY_URLS: &[&str] = &[];

/// The pkarr address-lookup service a paired host's connection hints are published to and
/// resolved from. `None` for the same reason as above. One URL for both directions, so a
/// self-hosted publisher is never paired with a public resolver.
pub const DEFAULT_LOOKUP_URL: Option<&str> = None;

/// The Magic Wormhole mailbox server pairing meets at, as a `ws(s)://` URL. `None`, for the same
/// reason again: there is no Alexia mailbox yet, and the public Magic Wormhole one is not ours
/// to lean on. With none configured a pairing cannot start, and says so (`mailbox_not_configured`).
pub const DEFAULT_MAILBOX_URL: Option<&str> = None;

/// What the mailbox server scopes a pairing by. Another application's codes are not ours, and
/// a change to what is said inside the wormhole is a new name here.
pub const PAIRING_APP_ID: &str = "dev.alexia.pairing.v1";
/// The version of the message exchanged inside the wormhole.
pub const PAIRING_VERSION: u32 = 1;
/// The words after the mailbox number. One attempt at 32 bits.
pub const PAIRING_WORDS: usize = 4;
/// How long a code is good for.
pub const PAIRING_CODE_TTL: Duration = Duration::from_secs(5 * 60);
/// A join, from the request to the proof. It either finds its host waiting or it does not.
pub const PAIRING_JOIN_TIMEOUT: Duration = Duration::from_secs(60);
/// Reaching the mailbox server and being given a number; and saying goodbye to it.
pub const PAIRING_MAILBOX_TIMEOUT: Duration = Duration::from_secs(15);
/// The proof over iroh, from the end of the mailbox exchange to the last byte.
pub const PAIRING_PROOF_TIMEOUT: Duration = Duration::from_secs(30);
/// Between two dials while the other side is still getting ready to be dialled.
pub const PAIRING_REDIAL: Duration = Duration::from_millis(250);
/// After the proof, how long the host waits for the joiner to hang up having read the last byte.
pub const PAIRING_LINGER: Duration = Duration::from_secs(5);
/// Pairings in progress at once, and settled ones still remembered.
pub const PAIRINGS_MAX: usize = 4;
pub const PAIRINGS_KEPT: usize = 16;
/// A display name, core's opaque payload as JSON, and the whole message that carries them.
pub const PAIRING_NAME_MAX: usize = 128;
pub const PAIRING_PAYLOAD_MAX: usize = 1024;
pub const PAIRING_MESSAGE_MAX: usize = 4 * 1024;
pub const PAIRING_NONCE: usize = 32;
pub const PAIRING_TAG: usize = 32;

/// The per-launch secret. Read once and removed from the environment before anything else runs.
pub const ENV_SECRET: &str = "ALEXIA_CONNECT_SECRET";
/// Comma-separated relay URLs. Set but empty means no relay at all.
pub const ENV_RELAY_URLS: &str = "ALEXIA_CONNECT_RELAY_URLS";
/// The address-lookup URL. Set but empty means none.
pub const ENV_LOOKUP_URL: &str = "ALEXIA_CONNECT_LOOKUP_URL";
/// The mailbox server's URL. Set but empty means none.
pub const ENV_MAILBOX_URL: &str = "ALEXIA_CONNECT_MAILBOX_URL";
/// The keychain service the endpoint key lives under, whole.
pub const ENV_KEYCHAIN: &str = "ALEXIA_CONNECT_KEYCHAIN";
/// **Debug builds only**, and ignored by a release build: set to `1`, the endpoint key is made
/// in memory and the keychain is not touched, so tests can start the binary on a machine with
/// no keychain. The identity is a new one on every launch.
pub const ENV_EPHEMERAL: &str = "ALEXIA_CONNECT_EPHEMERAL_KEY";
/// **Debug builds only**, like the one above: set to `1`, a pairing also offers this computer's
/// loopback addresses as hints, so two sidecars on one machine can pair with no network at all.
pub const ENV_LOOPBACK_HINTS: &str = "ALEXIA_CONNECT_LOOPBACK_HINTS";
/// `off`, `error`, `warn`, `info` (the default) or `debug`.
pub const ENV_LOG: &str = "ALEXIA_CONNECT_LOG";

/// Not `dev.alexia.app`: that is the shell's vault, which reads any entry core names. A key
/// under a service the vault cannot name is one core cannot ask for.
pub const KEYCHAIN_SERVICE: &str = "dev.alexia.connect";
pub const KEYCHAIN_ACCOUNT: &str = "endpoint-key";

/// The shortest secret accepted. 32 bytes as hex is 64.
pub const SECRET_MIN: usize = 32;

/// The framed head on a stream: a method, a path and a few headers.
pub const HEAD_MAX: usize = 16 * 1024;
/// How long the other side has to send it.
pub const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// A control request's JSON body.
pub const CONTROL_BODY_MAX: usize = 64 * 1024;
/// A request line and headers on the loopback port, from first byte to last.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections to the loopback port at once.
pub const CONTROL_CONNECTIONS_MAX: usize = 256;
/// A path with its query, on the bridge and on the wire.
pub const PATH_MAX: usize = 2048;
pub const OPERATIONS_MAX: usize = 64;
pub const ALLOWLIST_MAX: usize = 64;
pub const HINT_ADDRESSES_MAX: usize = 16;

/// Jobs and artifacts in flight with one peer. Each is a stream; the next one waits.
pub const STREAMS_MAX: u32 = 64;
/// What one stream may hold unread, what a connection may, and what may sit unsent. These three
/// are the whole of the buffering between two computers; past them the writer waits.
pub const STREAM_WINDOW: u32 = 1024 * 1024;
pub const CONNECTION_WINDOW: u32 = 8 * 1024 * 1024;
pub const SEND_WINDOW: u64 = 8 * 1024 * 1024;
/// The largest piece read off a stream at a time.
pub const CHUNK_MAX: usize = 64 * 1024;

/// Silence for this long and the peer is Offline. iroh's own keep-alive is well inside it.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
/// Reaching the host service is a loopback connect: it is there or it is not.
pub const HOST_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Events held for a subscriber that is not reading. One that falls further behind is told so.
pub const EVENTS_MAX: usize = 64;
pub const EVENTS_KEEPALIVE: Duration = Duration::from_secs(15);

/// Why a connection was closed, as the QUIC application code.
pub const CLOSE_NORMAL: u32 = 0;
pub const CLOSE_NOT_PAIRED: u32 = 1;
pub const CLOSE_REVOKED: u32 = 2;
pub const CLOSE_SHUTDOWN: u32 = 3;

/// Why a stream was reset.
pub const RESET_CANCELLED: u32 = 1;

/// Headers carried across, each way. A list of what goes, not of what does not: the bridge's
/// own `authorization` is the per-launch secret and must never leave this computer.
pub const REQUEST_HEADERS: &[&str] = &["content-type", "content-length", "accept"];
pub const RESPONSE_HEADERS: &[&str] = &["content-type", "content-length", "cache-control"];
/// Besides those, anything under this prefix — the compute protocol's own.
pub const HEADER_PREFIX: &str = "x-alexia-";
/// Set by the forwarder to the endpoint that asked, and never taken from the wire.
pub const HEADER_PEER: &str = "x-alexia-peer";
/// On every response this process wrote itself, so core can tell it from the host service's.
pub const HEADER_ERROR: &str = "x-alexia-connect-error";
