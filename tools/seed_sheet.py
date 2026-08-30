#!/usr/bin/env python3
"""
seed_sheet.py — push docs/data/catalog.json into the LabInventory Google
Sheet through the deployed Apps Script `bulkImport` API.

Usage:
    python tools/seed_sheet.py --api-url "https://script.google.com/macros/s/XXX/exec"

The admin password is never taken as a CLI flag with a default. Provide it via:
    - the LABINV_PASSWORD environment variable, or
    - an interactive prompt (hidden input), if the env var isn't set.

It is never written to disk. Progress (which chunks have already been
imported) IS written to disk (tools/.seed_progress.json by default) so a
crashed or interrupted run can be resumed by running the same command again.

Examples:
    python tools/seed_sheet.py --api-url "$API_URL" --dry-run
    LABINV_PASSWORD=secret python tools/seed_sheet.py --api-url "$API_URL"
    python tools/seed_sheet.py --api-url "$API_URL" --reset
"""

import argparse
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_CHUNK_SIZE = 400
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG = REPO_ROOT / "docs" / "data" / "catalog.json"
DEFAULT_PROGRESS_FILE = Path(__file__).resolve().parent / ".seed_progress.json"


def parse_args():
    p = argparse.ArgumentParser(description="Push docs/data/catalog.json into the LabInventory Sheet via bulkImport.")
    p.add_argument("--api-url", required=True, help="The Apps Script /exec URL.")
    p.add_argument("--password", default=None,
                   help="Admin password. Prefer LABINV_PASSWORD env var or the interactive prompt instead of this flag "
                        "(it can leak into shell history).")
    p.add_argument("--catalog", default=str(DEFAULT_CATALOG), help="Path to catalog.json (default: docs/data/catalog.json).")
    p.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help="Parts per bulkImport call (max 400, server-enforced).")
    p.add_argument("--progress-file", default=str(DEFAULT_PROGRESS_FILE), help="Where to track completed chunks for resuming.")
    p.add_argument("--reset", action="store_true", help="Ignore/clear any saved progress and start from chunk 0.")
    p.add_argument("--dry-run", action="store_true", help="Validate and summarize only. No network calls, no login required.")
    return p.parse_args()


def load_catalog(path):
    p = Path(path)
    if not p.exists():
        print(f"ERROR: catalog file not found: {p}", file=sys.stderr)
        sys.exit(1)
    with p.open("r", encoding="utf-8") as f:
        doc = json.load(f)
    parts = doc.get("parts")
    if not isinstance(parts, list):
        print("ERROR: catalog.json has no top-level 'parts' array.", file=sys.stderr)
        sys.exit(1)
    return parts


def validate_parts(parts):
    """Best-effort client-side sanity check. The server is authoritative and
    will silently skip any row still malformed when it actually arrives."""
    problems = 0
    seen_ids = set()
    for i, part in enumerate(parts):
        pid = part.get("partId")
        sku = part.get("sku")
        name = part.get("name")
        if not pid or not sku or not name:
            print(f"  WARNING: part[{i}] missing partId/sku/name — server will skip it: {part}")
            problems += 1
            continue
        if pid in seen_ids:
            print(f"  WARNING: duplicate partId in catalog.json: {pid}")
            problems += 1
        seen_ids.add(pid)
    return problems


def chunk_list(items, size):
    for i in range(0, len(items), size):
        yield i // size, items[i:i + size]


def load_progress(path):
    p = Path(path)
    if not p.exists():
        return {"completed_chunks": []}
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if "completed_chunks" not in data:
            data["completed_chunks"] = []
        return data
    except Exception:
        return {"completed_chunks": []}


def save_progress(path, progress):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2)


def post_json(api_url, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        api_url,
        data=data,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  HTTP {e.code} error body: {body}", file=sys.stderr)
        raise
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        print(f"  ERROR: response was not valid JSON:\n{body[:500]}", file=sys.stderr)
        raise


def login(api_url, password):
    resp = post_json(api_url, {"action": "login", "password": password})
    if not resp.get("ok"):
        print(f"ERROR: login failed — {resp.get('error')}: {resp.get('message')}", file=sys.stderr)
        sys.exit(1)
    return resp["data"]["token"]


def main():
    args = parse_args()

    if args.chunk_size > DEFAULT_CHUNK_SIZE:
        print(f"NOTE: clamping chunk-size to server max of {DEFAULT_CHUNK_SIZE}.")
        args.chunk_size = DEFAULT_CHUNK_SIZE

    parts = load_catalog(args.catalog)
    print(f"Loaded {len(parts)} parts from {args.catalog}")
    problems = validate_parts(parts)
    total_chunks = max(1, (len(parts) + args.chunk_size - 1) // args.chunk_size) if parts else 0

    if args.dry_run:
        print(f"DRY RUN: would send {total_chunks} chunk(s) of up to {args.chunk_size} parts each.")
        if problems:
            print(f"DRY RUN: {problems} row(s) look malformed and would be skipped server-side.")
        print("DRY RUN: no network calls made, no password required.")
        return

    if not parts:
        print("Nothing to import (catalog.json has 0 parts).")
        return

    password = args.password or os.environ.get("LABINV_PASSWORD")
    if not password:
        password = getpass.getpass("Admin password: ")
    if not password:
        print("ERROR: no password provided.", file=sys.stderr)
        sys.exit(1)

    progress = {"completed_chunks": []} if args.reset else load_progress(args.progress_file)
    completed = set(progress.get("completed_chunks", []))

    print("Logging in...")
    token = login(args.api_url, password)
    password = None  # drop the password from memory as soon as we're done with it

    total_inserted = 0
    total_updated = 0

    for idx, chunk in chunk_list(parts, args.chunk_size):
        if idx in completed:
            print(f"Chunk {idx + 1}/{total_chunks}: already done, skipping.")
            continue

        print(f"Chunk {idx + 1}/{total_chunks}: sending {len(chunk)} parts...")
        payload = {"action": "bulkImport", "token": token, "parts": chunk, "mode": "upsert"}

        try:
            resp = post_json(args.api_url, payload)
        except Exception as e:
            print(f"  ERROR sending chunk {idx}: {e}", file=sys.stderr)
            print("  Progress saved. Re-run the same command to resume from this chunk.", file=sys.stderr)
            sys.exit(1)

        if not resp.get("ok") and resp.get("error") == "UNAUTHORIZED":
            print("  Token expired mid-run, re-logging in...")
            password = os.environ.get("LABINV_PASSWORD") or getpass.getpass("Admin password: ")
            token = login(args.api_url, password)
            password = None
            payload["token"] = token
            resp = post_json(args.api_url, payload)

        if not resp.get("ok"):
            print(f"  ERROR: {resp.get('error')}: {resp.get('message')}", file=sys.stderr)
            print("  Progress saved. Re-run the same command to resume from this chunk.", file=sys.stderr)
            sys.exit(1)

        data = resp["data"]
        total_inserted += data.get("inserted", 0)
        total_updated += data.get("updated", 0)
        print(f"  OK: inserted={data.get('inserted')} updated={data.get('updated')}")

        completed.add(idx)
        progress["completed_chunks"] = sorted(completed)
        save_progress(args.progress_file, progress)

        time.sleep(0.3)  # be gentle with the Apps Script quota

    print(f"Done. Total inserted={total_inserted} updated={total_updated} across {total_chunks} chunk(s).")
    print(f"Progress file: {args.progress_file} (safe to delete now that the run is complete).")


if __name__ == "__main__":
    main()
