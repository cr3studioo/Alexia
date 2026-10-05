"""Read-only verification of published package pins, hashes and base-image digests."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request


def fetch(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response), response.headers


def verify_python(block):
    name, version, rest = block
    release, _ = fetch(f"https://pypi.org/pypi/{name}/{version}/json")
    hashes = set(re.findall(r"--hash=sha256:([0-9a-f]{64})", rest))
    available = {item["digests"]["sha256"] for item in release["urls"] if not item["yanked"]}
    if release["info"]["version"] != version or not hashes or not hashes <= available:
        raise ValueError(f"pin or hash mismatch for {name}=={version}")
    return f"VERIFIED PyPI {name}=={version} ({len(hashes)} artifact hashes)"


def main():
    root = Path(__file__).resolve().parent
    requirements = (root / "mailbox-requirements.txt").read_text()
    blocks = re.findall(r"^([A-Za-z0-9_.-]+)==([^\s]+)(.*?)(?=^[A-Za-z0-9_.-]+==|\Z)", requirements, re.M | re.S)
    with ThreadPoolExecutor(max_workers=6) as executor:
        for result in executor.map(verify_python, blocks):
            print(result)
    for package in ["iroh", "iroh-relay", "iroh-dns-server"]:
        release, _ = fetch(f"https://crates.io/api/v1/crates/{package}/1.3.0")
        if release["version"]["num"] != "1.3.0" or release["version"]["yanked"]:
            raise ValueError(f"missing or yanked {package} 1.3.0")
        print(f"VERIFIED crates.io {package}=1.3.0 ({release['version']['checksum']})")
    pins = set()
    for path in root.glob("Dockerfile.*"):
        pins.update(re.findall(r"^FROM ([^:@\s]+):([^@\s]+)@(sha256:[0-9a-f]{64})", path.read_text(), re.M))
    for image, tag, digest in sorted(pins):
        repository = image if "/" in image else f"library/{image}"
        scope = urllib.parse.quote(f"repository:{repository}:pull")
        auth, _ = fetch(f"https://auth.docker.io/token?service=registry.docker.io&scope={scope}")
        manifest, headers = fetch(
            f"https://registry-1.docker.io/v2/{repository}/manifests/{tag}",
            {"Authorization": f"Bearer {auth['token']}", "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json"},
        )
        platforms = {(item.get("platform", {}).get("os"), item.get("platform", {}).get("architecture")) for item in manifest.get("manifests", [])}
        if headers.get("Docker-Content-Digest") != digest or not {("linux", "amd64"), ("linux", "arm64")} <= platforms:
            raise ValueError(f"digest or architecture mismatch for {image}:{tag}")
        print(f"VERIFIED Docker Hub {image}:{tag}@{digest} (linux/amd64, linux/arm64)")


if __name__ == "__main__":
    main()
