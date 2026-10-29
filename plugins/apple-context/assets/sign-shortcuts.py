#!/usr/bin/env python3
"""Sign unconfigured templates on macOS and retain portable text-encoded assets."""
import base64
import subprocess
import tempfile
from pathlib import Path
root = Path(__file__).parent / 'shortcuts'
with tempfile.TemporaryDirectory(prefix='alexia-sign-') as directory:
    for source in sorted(root.glob('*.unsigned.shortcut')):
        signed = Path(directory) / source.name.replace('.unsigned.shortcut', '.shortcut')
        subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', str(source.resolve()), '--output', str(signed)], check=True, timeout=60)
        data = signed.read_bytes()
        if len(data) <= source.stat().st_size:
            raise RuntimeError('Signing did not produce a complete artifact')
        target = source.with_name(source.name.replace('.unsigned.shortcut', '.signed.b64'))
        target.write_text(base64.b64encode(data).decode('ascii') + '\n')
        print('Saved ' + target.name, flush=True)
