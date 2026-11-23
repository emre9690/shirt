"""Filesystem store for imports, jobs and validated garment packages."""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from pathlib import Path

PIPELINE_VERSION = "1"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
IMAGE_SIGNATURES = {b"\xff\xd8\xff": ".jpg", b"\x89PNG\r\n\x1a\n": ".png"}
MAX_IMAGE_BYTES = 12 * 1024 * 1024


def image_extension(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    for signature, extension in IMAGE_SIGNATURES.items():
        if data.startswith(signature):
            return extension
    return None


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cache_key(article: str, color: str, size: str, method: str, sources: list[str]) -> str:
    """Stable garment ID. Changing any input or the pipeline version yields a new garment."""
    payload = json.dumps([article, color, size, method, sorted(sources), PIPELINE_VERSION])
    return f"{method}-{size}-{hashlib.sha256(payload.encode()).hexdigest()[:16]}"


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        for name in ("imports", "jobs", "garments"):
            (root / name).mkdir(parents=True, exist_ok=True)

    def _path(self, kind: str, item_id: str) -> Path:
        if not ID_RE.match(item_id):
            raise KeyError(item_id)
        return self.root / kind / item_id

    @staticmethod
    def write_json(path: Path, value: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
        os.replace(temp, path)

    def new_id(self) -> str:
        return uuid.uuid4().hex

    def save_import(self, record: dict) -> None:
        self.write_json(self._path("imports", record["id"]) / "import.json", record)

    def get_import(self, import_id: str) -> dict:
        path = self._path("imports", import_id) / "import.json"
        if not path.exists():
            raise KeyError(import_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def add_image(self, import_id: str, data: bytes) -> dict:
        extension = image_extension(data)
        if extension is None:
            raise ValueError("Only JPEG, PNG or WebP images are accepted")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Image is too large")
        digest = sha256(data)
        folder = self._path("imports", import_id) / "images"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{digest}{extension}").write_bytes(data)
        return {"id": digest[:16], "file": f"{digest}{extension}", "sha256": digest}

    def image_path(self, import_id: str, file_name: str) -> Path:
        path = self._path("imports", import_id) / "images" / Path(file_name).name
        if not path.exists():
            raise KeyError(file_name)
        return path

    def save_job(self, job: dict) -> None:
        self.write_json(self._path("jobs", job["id"]).with_suffix(".json"), job)

    def get_job(self, job_id: str) -> dict:
        path = self._path("jobs", job_id).with_suffix(".json")
        if not path.exists():
            raise KeyError(job_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def garment_dir(self, garment_id: str) -> Path:
        return self._path("garments", garment_id)

    def verify_garment(self, garment_id: str) -> tuple[dict | None, list[str]]:
        """A garment is ready only if its manifest passes and every file matches its hash."""
        folder = self.garment_dir(garment_id)
        manifest_path = folder / "manifest.json"
        if not manifest_path.exists():
            return None, ["manifest.json is missing"]
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None, ["manifest.json is not valid JSON"]
        problems: list[str] = []
        if manifest.get("units") != "m":
            problems.append("Manifest units are not metres")
        if manifest.get("validation", {}).get("status") != "passed":
            problems.append("Manifest validation did not pass")
        files = manifest.get("files", {})
        for required in ("render", "simulation"):
            if required not in files:
                problems.append(f"Manifest has no {required} file")
        for entry in files.values():
            name = Path(entry.get("path", "")).name
            path = folder / name
            if not name or not path.exists():
                problems.append(f"Missing file {name}")
            elif sha256(path.read_bytes()) != entry.get("sha256"):
                problems.append(f"Hash mismatch for {name}")
        return manifest, problems

    def list_garments(self) -> list[dict]:
        out: list[dict] = []
        for folder in sorted((self.root / "garments").iterdir()):
            if not folder.is_dir():
                continue
            manifest, problems = self.verify_garment(folder.name)
            if manifest and not problems:
                out.append({
                    "id": folder.name,
                    "name": manifest.get("name"),
                    "size": manifest.get("size"),
                    "method": manifest.get("reconstructionMethod"),
                    "createdAt": manifest.get("createdAt"),
                })
        return out
