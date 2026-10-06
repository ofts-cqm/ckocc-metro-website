#!/usr/bin/env python3
"""Validate map bytes and the recorded base using only Python's standard library.

Run this trusted script from the protected base checkout. The candidate checkout
is read as data; no files or code from its branch are executed.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import zlib

PATHS = {"maps/network.json", "maps/network.png", "maps/manifest.json"}
MAX_JSON, MAX_PNG, MAX_PIXELS, MAX_AXIS = 2 * 1024**2, 20 * 1024**2, 200_000_000, 24_576


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(root, name, maximum):
    path = root / name
    require(not path.is_symlink() and not path.parent.is_symlink(), f"Symlinks are forbidden: {name}")
    require(path.resolve().is_relative_to(root.resolve()), f"File escapes candidate directory: {name}")
    require(path.is_file() and 0 < path.stat().st_size <= maximum, f"Missing or oversize file: {name}")
    return path.read_bytes()


def document(raw):
    data = json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    require(isinstance(data, dict) and data.get("version") == 80, "Expected an RMP v80 document")
    for key in ("graph", "mapStyle", "svgViewBoxMin"):
        require(isinstance(data.get(key), dict), f"Missing object: {key}")
    require(type(data.get("svgViewBoxZoom")) in (int, float) and math.isfinite(data["svgViewBoxZoom"]) and data["svgViewBoxZoom"] > 0, "Invalid viewport zoom")
    require(all(type(data["svgViewBoxMin"].get(k)) in (int, float) and math.isfinite(data["svgViewBoxMin"][k]) for k in ("x", "y")), "Invalid viewport origin")
    require(type(data.get("mapEnabled")) is bool and isinstance(data.get("images"), list), "Invalid RMP envelope")
    graph = data["graph"]
    require(all(isinstance(graph.get(k), dict) for k in ("options", "attributes")), "Invalid graph metadata")
    require(all(isinstance(graph.get(k), list) for k in ("nodes", "edges")), "Invalid graph arrays")
    ids, edge_ids = set(), set()
    for node in graph["nodes"]:
        require(isinstance(node, dict) and isinstance(node.get("key"), str), "Invalid node")
        require(node["key"] and node["key"] not in ids, "Missing or duplicate node ID")
        attrs = node.get("attributes")
        require(isinstance(attrs, dict) and isinstance(attrs.get("type"), str), "Invalid node attributes")
        require(all(type(attrs.get(k)) in (int, float) and math.isfinite(attrs[k]) for k in ("x", "y")), "Invalid node coordinates")
        ids.add(node["key"])
    for edge in graph["edges"]:
        require(isinstance(edge, dict) and isinstance(edge.get("key"), str), "Invalid edge")
        require(edge["key"] and edge["key"] not in edge_ids, "Missing or duplicate edge ID")
        require(edge.get("source") in ids and edge.get("target") in ids, "Dangling edge")
        require(isinstance(edge.get("attributes"), dict), "Invalid edge attributes")
        edge_ids.add(edge["key"])


def png(raw):
    require(raw[:8] == b"\x89PNG\r\n\x1a\n", "Invalid PNG signature")
    offset, chunks, idat, dimensions = 8, [], [], None
    while offset < len(raw):
        require(offset + 12 <= len(raw), "Truncated PNG")
        size = struct.unpack_from(">I", raw, offset)[0]
        require(size <= len(raw) - offset - 12, "Truncated PNG chunk")
        tag = raw[offset + 4:offset + 8]
        payload = raw[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", raw, offset + 8 + size)[0]
        require(zlib.crc32(tag + payload) & 0xffffffff == crc, "PNG CRC mismatch")
        require(tag not in (b"acTL", b"fcTL", b"fdAT"), "Animated PNG is unsupported")
        if not chunks:
            require(tag == b"IHDR" and size == 13, "Missing PNG header")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            require(0 < width <= MAX_AXIS and 0 < height <= MAX_AXIS and width * height <= MAX_PIXELS, "PNG dimensions exceed limits")
            require(compression == 0 and filtering == 0 and interlace in (0, 1), "Invalid PNG encoding")
            allowed = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            require(color in allowed and depth in allowed[color], "Invalid PNG color format")
            dimensions = (width, height)
        elif tag == b"IHDR":
            raise ValueError("Duplicate PNG header")
        if tag == b"IDAT":
            require(not idat or chunks[-1] == b"IDAT", "Noncontiguous PNG image data")
            idat.append(payload)
        chunks.append(tag)
        offset += size + 12
        if tag == b"IEND":
            require(size == 0 and offset == len(raw), "Invalid PNG end")
            break
    require(chunks and chunks[-1] == b"IEND" and idat, "Incomplete PNG")
    require(color != 3 or b"PLTE" in chunks, "Missing PNG palette")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if interlace == 0 else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    rows = []
    for x, y, dx, dy in passes:
        cols, count = max(0, (width - x + dx - 1) // dx), max(0, (height - y + dy - 1) // dy)
        if cols and count:
            rows.extend([1 + (cols * channels * depth + 7) // 8] * count)
    row, remaining = 0, 0

    def consume(output):
        nonlocal row, remaining
        pos = 0
        while pos < len(output):
            if remaining == 0:
                require(row < len(rows), "PNG decompressed size exceeds dimensions")
                require(output[pos] <= 4, "Invalid PNG row filter")
                remaining = rows[row]
                row += 1
            take = min(remaining, len(output) - pos)
            remaining -= take
            pos += take

    decoder = zlib.decompressobj()
    for part in idat:
        pending = part
        while pending:
            consume(decoder.decompress(pending, 64 * 1024))
            pending = decoder.unconsumed_tail
    require(decoder.eof and not decoder.unused_data, "Incomplete or extra PNG compressed stream")
    require(row == len(rows) and remaining == 0, "PNG decompressed size differs from dimensions")
    return dimensions


def validate(root):
    raw_json, raw_png = read(root, "maps/network.json", MAX_JSON), read(root, "maps/network.png", MAX_PNG)
    manifest = json.loads(read(root, "maps/manifest.json", 32 * 1024).decode("utf-8"))
    document(raw_json)
    width, height = png(raw_png)
    require(manifest.get("schema_version") == 1 and manifest.get("editor") == {"id": "rail-map-painter", "document_version": 80}, "Invalid manifest version/editor")
    hashes = {}
    for kind, raw in (("json", raw_json), ("png", raw_png)):
        row = manifest["files"][kind]
        hashes[kind] = hashlib.sha256(raw).hexdigest()
        require(row["path"] == f"maps/network.{kind}" and row["bytes"] == len(raw) and row["sha256"] == hashes[kind], f"Manifest {kind} mismatch")
    require(manifest["files"]["png"]["width"] == width and manifest["files"]["png"]["height"] == height, "Manifest dimensions mismatch")
    revision = "sha256:" + hashlib.sha256((hashes["json"] + "\n" + hashes["png"] + "\n").encode()).hexdigest()
    require(manifest["map_revision"] == revision, "Manifest revision mismatch")
    require(isinstance(manifest.get("selected_issue_numbers"), list) and all(type(n) is int and n > 0 for n in manifest["selected_issue_numbers"]), "Invalid selected issues")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--allow-maintenance", action="store_true", help="Administrator changes outside maps; map safety checks still apply")
    args = parser.parse_args()
    candidate = validate(args.candidate)
    if args.base:
        base = validate(args.base)
        base_sha = subprocess.check_output(["git", "-C", str(args.base), "rev-parse", "HEAD"], text=True).strip()
        # Both commits are available in the candidate checkout after workflow fetch.
        changed = set(filter(None, subprocess.check_output(["git", "-C", str(args.candidate), "diff", "--name-only", "-z", f"{base_sha}...HEAD"], text=True).split("\0")))
        require(args.allow_maintenance or changed <= PATHS, "Map submission changes forbidden paths")
        map_changed = bool(changed & PATHS)
        if map_changed:
            require(candidate["base_map_revision"] == base["map_revision"], "Map is stale: reconcile with current main and regenerate the manifest")
            recorded = candidate.get("base_commit_sha")
            require(isinstance(recorded, str) and re.fullmatch(r"[a-f0-9]{40}", recorded), "Missing base commit")
            ancestor = subprocess.run(["git", "-C", str(args.candidate), "merge-base", "--is-ancestor", recorded, base_sha], capture_output=True)
            require(ancestor.returncode == 0, "Recorded base commit is not on the approved branch")
            # Check the recorded commit itself rather than trusting only a claimed revision.
            old_manifest = json.loads(subprocess.check_output(["git", "-C", str(args.candidate), "show", recorded + ":maps/manifest.json"]))
            require(old_manifest["map_revision"] == candidate["base_map_revision"], "Recorded base commit/revision mismatch")
            require(candidate["map_revision"] != base["map_revision"], "Map update is a no-op")
    print("Map bytes, PNG scanlines, manifest, and applicable base checks passed.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError, zlib.error, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Map validation failed: {error}")
