"""Render the operator-managed Nginx template; never execute .env as shell code."""

import ipaddress
import os
from pathlib import Path
import re
import sys


def render(env_file):
    values = {}
    for line in env_file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    template = Path(__file__).with_name("nginx.conf.template").read_text()
    required = set(re.findall(r"@@([A-Z_]+)@@", template)) - {"CONNECT_UPSTREAM_ADDRESS"}
    required.add("CONNECT_BIND_ADDRESS")
    for key in required:
        values[key] = os.environ.get(key, values.get(key, ""))
        value = values[key]
        if key.endswith("_HOST"):
            valid = re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", value)
        elif key.endswith("_PATH"):
            valid = re.fullmatch(r"/[a-zA-Z0-9_./-]+", value)
        elif key.endswith("_RATE"):
            valid = re.fullmatch(r"[1-9][0-9]*r/[ms]", value)
        elif key == "CONNECT_BIND_ADDRESS":
            try:
                address = ipaddress.ip_address(value)
                valid = address.is_loopback
                values["CONNECT_UPSTREAM_ADDRESS"] = f"[{address}]" if address.version == 6 else str(address)
            except ValueError:
                valid = False
        else:
            valid = value.isascii() and value.isdigit() and 0 < int(value) <= 65535
        if not valid:
            raise ValueError(f"invalid or missing {key}")
    if values["MAILBOX_PUBLIC_HOST"] == values["RELAY_PUBLIC_HOST"]:
        raise ValueError("mailbox and relay require separate hostnames")
    return re.sub(r"@@([A-Z_]+)@@", lambda match: values[match[1]], template)


if __name__ == "__main__":
    try:
        env_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name(".env")
        print(render(env_file), end="")
    except (ValueError, OSError):
        print("Cannot render proxy configuration; check the env file and required values.", file=sys.stderr)
        sys.exit(1)
