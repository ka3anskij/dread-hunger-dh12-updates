from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def version_from_bytes(data: bytes) -> str:
    return str(json.loads(data.decode("utf-8"))["version"])


current = version_from_bytes(Path("stable.json").read_bytes())
try:
    previous_bytes = subprocess.check_output(["git", "show", "HEAD^:stable.json"], stderr=subprocess.DEVNULL)
    previous = version_from_bytes(previous_bytes)
except (subprocess.CalledProcessError, FileNotFoundError, KeyError, json.JSONDecodeError):
    previous = ""

changed = current != previous
output = os.environ.get("GITHUB_OUTPUT")
if output:
    with open(output, "a", encoding="utf-8") as stream:
        stream.write(f"changed={'true' if changed else 'false'}\n")
        stream.write(f"version={current}\n")
print(f"Hideout version: {previous or '(none)'} -> {current}; changed={changed}")
