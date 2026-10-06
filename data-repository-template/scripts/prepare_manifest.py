#!/usr/bin/env python3
"""Prepare a reviewed map replacement/rollback manifest; never commit, push, or merge."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid

from validate_map import MAX_JSON, MAX_PNG, document, png, read, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--base-commit", required=True, help="Full SHA of the current approved main commit")
    parser.add_argument("--contributor", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--issue", type=int, action="append", default=[])
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.base_commit), "Expected a full base commit SHA")
    require(0 < len(args.contributor.strip()) <= 64 and 0 < len(args.summary.strip()) <= 160, "Invalid contributor or summary length")
    require(len(args.issue) <= 50 and all(n > 0 for n in args.issue), "Invalid selected issues")
    base = json.loads(subprocess.check_output(["git", "-C", str(args.repository), "show", args.base_commit + ":maps/manifest.json"]))
    raw_json = read(args.repository, "maps/network.json", MAX_JSON)
    raw_png = read(args.repository, "maps/network.png", MAX_PNG)
    document(raw_json)
    width, height = png(raw_png)
    json_hash, png_hash = hashlib.sha256(raw_json).hexdigest(), hashlib.sha256(raw_png).hexdigest()
    revision = "sha256:" + hashlib.sha256((json_hash + "\n" + png_hash + "\n").encode()).hexdigest()
    require(revision != base["map_revision"], "The selected pair is unchanged from the base")
    manifest = {
        "schema_version": 1,
        "editor": {"id": "rail-map-painter", "document_version": 80},
        "map_revision": revision,
        "base_map_revision": base["map_revision"],
        "base_commit_sha": args.base_commit,
        "operation_id": "manual-" + str(uuid.uuid4()),
        "contributor_display_name": args.contributor.strip(),
        "summary": args.summary.strip(),
        "selected_issue_numbers": sorted(set(args.issue)),
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "files": {
            "json": {"path": "maps/network.json", "sha256": json_hash, "bytes": len(raw_json)},
            "png": {"path": "maps/network.png", "sha256": png_hash, "bytes": len(raw_png), "width": width, "height": height},
        },
    }
    target = args.repository / "maps/manifest.json"
    require(not target.is_symlink() and target.resolve().is_relative_to(args.repository.resolve()), "Invalid manifest path")
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Prepared maps/manifest.json. Review all three files, then open a PR; no Git changes were submitted.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Manifest preparation failed: {error}")
