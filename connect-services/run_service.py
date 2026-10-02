"""Validate limits, then run an upstream service without retaining its logs."""

import json
import os
from pathlib import Path
import re
import sys


def positive_integer(name, default, minimum=1):
    raw = os.environ.get(name, str(default))
    if not raw.isascii() or not raw.isdigit():
        raise ValueError(f"{name} must be an integer")
    value = int(raw)
    if not minimum <= value <= 4294967295:
        raise ValueError(f"{name} is outside the supported range")
    return value


def mailbox_command():
    options = {
        "maxConnections": positive_integer("MAILBOX_MAX_CONNECTIONS", 128),
        "maxFramePayloadSize": positive_integer("MAILBOX_MAX_FRAME_BYTES", 65536),
        "maxMessagePayloadSize": positive_integer("MAILBOX_MAX_MESSAGE_BYTES", 65536),
        "openHandshakeTimeout": positive_integer("MAILBOX_HANDSHAKE_SECONDS", 5),
        "autoPingInterval": positive_integer("MAILBOX_PING_SECONDS", 30),
        "autoPingTimeout": positive_integer("MAILBOX_PING_TIMEOUT_SECONDS", 10),
    }
    command = [
        "twist", "wormhole-mailbox",
        "--port=tcp:4000:interface=0.0.0.0",
        "--channel-db=/state/channel.sqlite",
        f"--blur-usage={positive_integer('MAILBOX_BLUR_SECONDS', 3600)}",
    ]
    command.extend(f"--websocket-protocol-option={key}={value}" for key, value in options.items())
    return command


def relay_config():
    rate = positive_integer("RELAY_RX_BYTES_PER_SECOND", 10485760)
    # The relay's maximum frame is 1 MiB; the burst must accommodate that frame.
    burst = positive_integer("RELAY_RX_BURST_BYTES", 20971520, minimum=1048576)
    raw_ids = os.environ.get("RELAY_ALLOWED_ENDPOINT_IDS", "").strip()
    if raw_ids:
        endpoint_ids = [value.strip().lower() for value in raw_ids.split(",")]
        if any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in endpoint_ids):
            raise ValueError("RELAY_ALLOWED_ENDPOINT_IDS must contain 64-digit hex public identities")
        access = f"access.allowlist = {json.dumps(endpoint_ids)}"
    else:
        access = 'access = "everyone"'
    return f"""enable_relay = true
http_bind_addr = "0.0.0.0:3340"
enable_quic_addr_discovery = false
enable_metrics = true
metrics_bind_addr = "0.0.0.0:9090"
{access}

[limits.client.rx]
bytes_per_second = {rate}
max_burst_bytes = {burst}
"""


def main():
    os.umask(0o077)
    if sys.argv[1:] == ["mailbox"]:
        command = mailbox_command()
    elif sys.argv[1:] == ["relay"]:
        config = Path("/tmp/iroh-relay.toml")
        config.write_text(relay_config())
        os.environ["RUST_LOG"] = "off"
        command = ["iroh-relay", "--config-path", str(config)]
    else:
        raise ValueError("select mailbox or relay")
    # Upstream pruning/error logs may contain rendezvous identifiers or client input.
    # Drop both streams before exec, including unhandled exception diagnostics.
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    os.execvp(command[0], command)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(f"Invalid connectivity configuration: {error}", file=sys.stderr)
        sys.exit(1)
