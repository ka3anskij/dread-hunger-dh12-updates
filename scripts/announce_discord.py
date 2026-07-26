from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def multipart(payload: dict[str, object], image: Path) -> tuple[bytes, str]:
    boundary = "----HideoutBoundary" + secrets.token_hex(16)
    newline = b"\r\n"
    chunks: list[bytes] = []

    def field(headers: list[str], body: bytes) -> None:
        chunks.append((f"--{boundary}\r\n" + "\r\n".join(headers) + "\r\n\r\n").encode())
        chunks.append(body)
        chunks.append(newline)

    field(
        ['Content-Disposition: form-data; name="payload_json"'],
        json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    mime = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
    field(
        [
            f'Content-Disposition: form-data; name="files[0]"; filename="{image.name}"',
            f"Content-Type: {mime}",
        ],
        image.read_bytes(),
    )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Post a Hideout release announcement to Discord")
    parser.add_argument("--version", required=True)
    parser.add_argument("--notes", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    args = parser.parse_args()

    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook:
        print("DISCORD_WEBHOOK_URL is not configured; announcement skipped.")
        return 0
    if not args.notes.is_file() or not args.image.is_file():
        raise FileNotFoundError("Release notes or announcement image is missing")

    notes = args.notes.read_text(encoding="utf-8").strip()
    if len(notes) > 3900:
        notes = notes[:3897].rstrip() + "..."

    payload = {
        "username": "Hideout Updates",
        "allowed_mentions": {"parse": []},
        "attachments": [{"id": 0, "filename": args.image.name, "description": f"Hideout {args.version}"}],
        "embeds": [
            {
                "title": f"Hideout {args.version}",
                "description": notes,
                "color": 0x4F8FB3,
                "image": {"url": f"attachment://{args.image.name}"},
                "footer": {"text": "Hideout • стабильный канал"},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        ],
    }
    body, content_type = multipart(payload, args.image)
    separator = "&" if "?" in webhook else "?"
    request = urllib.request.Request(
        webhook + separator + "wait=true",
        data=body,
        headers={"Content-Type": content_type, "User-Agent": "Hideout-Release-Announcer/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"Discord returned HTTP {response.status}")
            print(f"Discord announcement sent for Hideout {args.version}.")
            return 0
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"Discord webhook failed: HTTP {error.code}: {detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
