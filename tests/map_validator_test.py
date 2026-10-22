"""Trusted data-repository validator regression: python3 tests/map_validator_test.py."""
import hashlib
import json
from pathlib import Path
import runpy
import struct
import tempfile
import unittest
import zlib

validator = runpy.run_path(str(Path(__file__).resolve().parents[1] / "data-repository-template/scripts/validate_map.py"))


def document(version=82):
    return {"version": version, "mapEnabled": False, "mapStyle": {},
            "svgViewBoxZoom": 100, "svgViewBoxMin": {"x": 0, "y": 0}, "images": [],
            "graph": {"options": {}, "attributes": {}, "nodes": [
                {"key": "a", "attributes": {"type": "station", "x": 0, "y": 0}}], "edges": []}}


def encoded(doc):
    return json.dumps(doc).encode()


def chunk(tag, payload):
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload))


class MapValidatorTests(unittest.TestCase):
    def test_compatible_versions_and_broken_graphs(self):
        for version in (1, 80, 81, 82, 999):
            doc = document(version)
            self.assertEqual(validator["document"](encoded(doc)), version)
            doc["graph"]["edges"] = [{"key": "bad", "source": "a", "target": "missing", "attributes": {}}]
            with self.assertRaises(ValueError):
                validator["document"](encoded(doc))

    def test_invalid_version_metadata(self):
        for version in (0, -1, 1.5, "81", None, True, 9007199254740992):
            with self.assertRaises(ValueError):
                validator["document"](encoded(document(version)))

    def test_manifest_matches_actual_future_document_version(self):
        raw_json = encoded(document())
        raw_png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff")) + chunk(b"IEND", b"")
        hashes = {"json": hashlib.sha256(raw_json).hexdigest(), "png": hashlib.sha256(raw_png).hexdigest()}
        manifest = {"schema_version": 1, "editor": {"id": "rail-map-painter", "document_version": 82},
                    "map_revision": "sha256:" + hashlib.sha256((hashes["json"] + "\n" + hashes["png"] + "\n").encode()).hexdigest(),
                    "selected_issue_numbers": [], "files": {kind: {"path": f"maps/network.{kind}", "sha256": hashes[kind], "bytes": len(raw)} for kind, raw in (("json", raw_json), ("png", raw_png))}}
        manifest["files"]["png"].update(width=1, height=1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "maps").mkdir()
            (root / "maps/network.json").write_bytes(raw_json)
            (root / "maps/network.png").write_bytes(raw_png)
            (root / "maps/manifest.json").write_bytes(encoded(manifest))
            self.assertEqual(validator["validate"](root)["editor"]["document_version"], 82)
            manifest["editor"]["document_version"] = 80
            (root / "maps/manifest.json").write_bytes(encoded(manifest))
            with self.assertRaises(ValueError):
                validator["validate"](root)


if __name__ == "__main__":
    unittest.main()
