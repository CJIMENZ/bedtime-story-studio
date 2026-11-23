#!/usr/bin/env python3
"""Publish a complete Mateo bedtime chapter from a short-lived audio request.

The request JSON only supplies signed audio URLs. GitHub Actions downloads,
joins, validates, and commits a single MP3 plus its episode catalog entry.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUEST_DIR = ROOT / "publication-requests"
CATALOG = ROOT / "docs" / "episodes.json"
AUDIO_DIR = ROOT / "docs" / "audio"


def media_seconds(path: Path) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        text=True,
    ).strip()
    return float(out)


def fetch_audio(url: str, dest: Path) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "elevenlabsusercontent.com":
        raise ValueError("Only signed ElevenLabs content URLs are accepted")
    with urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "MateoStoryPublisher/1.0"}),
        timeout=90,
    ) as response, dest.open("wb") as output:
        shutil.copyfileobj(response, output)
    if dest.stat().st_size < 20_000 or media_seconds(dest) < 20:
        raise ValueError("Downloaded a missing or invalid audio part")


def publish(req_path: Path) -> None:
    req = json.loads(req_path.read_text(encoding="utf-8"))
    episode_id = req["id"]
    if not re.fullmatch(r"chapter-\d{2,}", episode_id):
        raise ValueError("Expected id chapter-NN")
    if req_path.stem != episode_id:
        raise ValueError("Request filename and chapter id must match")
    title = req["title"]
    if not isinstance(title, str) or not title.strip() or len(title) > 160:
        raise ValueError("Invalid chapter title")
    parts = req["parts"]
    if not isinstance(parts, list) or not 2 <= len(parts) <= 8:
        raise ValueError("Expected 2-8 ordered audio-part URLs")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    target = AUDIO_DIR / (episode_id + ".mp3")
    if any(e["id"] == episode_id for e in catalog) or target.exists():
        raise ValueError(f"Episode {episode_id} already exists; no overwrite")

    with tempfile.TemporaryDirectory() as workspace:
        tmp = Path(workspace)
        input_paths = []
        for index, url in enumerate(parts, 1):
            file = tmp / f"part-{index:02}.mp3"
            fetch_audio(url, file)
            input_paths.append(file)
        expected = sum(media_seconds(p) for p in input_paths)
        listing = tmp / "parts.txt"
        listing.write_text(
            "".join(f"file '{p.as_posix()}'\n" for p in input_paths),
            encoding="utf-8",
        )
        temp_output = tmp / (episode_id + ".mp3")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat",
             "-safe", "0", "-i", str(listing), "-c", "copy", str(temp_output)],
            check=True,
        )
        actual = media_seconds(temp_output)
        if not (600 <= actual <= 1800) or abs(expected - actual) > 8:
            raise ValueError(f"Bad merged duration: parts={expected:.1f}s, merged={actual:.1f}s")
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(temp_output), target)
    entry = {
        "id": episode_id,
        "label": "Chapter " + str(int(episode_id.split("-")[1])),
        "title": title,
        "durationSeconds": round(actual),
        "src": f"audio/{episode_id}.mp3",
    }
    first_special = next(
        (i for i, e in enumerate(catalog) if not e["id"].startswith("chapter-")),
        len(catalog),
    )
    catalog.insert(first_special, entry)
    CATALOG.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    req_path.unlink()
    print(f"PUBLISHED {episode_id}: {actual:.2f} seconds, {target.stat().st_size} bytes")


def main() -> None:
    files = sorted(REQUEST_DIR.glob("chapter-*.json"))
    if not files:
        print("No publication requests")
    for req in files:
        publish(req)


if __name__ == "__main__":
    main()
