"""One local background worker. Expensive subprocesses never run in a request handler."""
from __future__ import annotations

import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

from .sewformer_adapter import check_installation, run_inference
from .store import Store, cache_key

STAGES = ["imported", "images_selected", "pattern_inferred", "mesh_assembled", "asset_validated", "ready"]
TEMPLATE_SIZES = {"XS", "S", "M", "L", "XL", "XXL"}
REPO_ROOT = Path(__file__).resolve().parents[3]
EXPORTER = REPO_ROOT / "tools" / "dist" / "export-garment.mjs"


class Blocked(RuntimeError):
    """A real dependency is missing. The message says exactly what is needed."""


Exporter = Callable[[dict, Path], None]


def node_exporter(spec: dict, out_dir: Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise Blocked("Node.js is not on PATH, so the garment exporter cannot run.")
    if not EXPORTER.exists():
        raise Blocked("Garment exporter is not built. Run: npm run build:tools")
    result = subprocess.run(
        [node, str(EXPORTER), "--size", spec["size"], "--out", str(out_dir), "--name", spec["name"],
         "--article", spec["article"], "--method", spec["method"], "--source", spec.get("source") or ""],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Exporter failed: {result.stderr.strip()[-600:]}")


def sewformer_step(spec: dict, out_dir: Path) -> None:
    """Run the real model and validate it. Never substitutes the template for a failed prediction."""
    missing = check_installation()
    if missing:
        raise Blocked(missing)
    image = spec.get("onModelPath")
    if not image or not Path(image).exists():
        raise Blocked("The selected on-model image is not available.")
    normalized = run_inference(Path(image), out_dir / "sewformer")
    if normalized["errors"]:
        raise RuntimeError("SewFormer prediction rejected: " + "; ".join(normalized["errors"][:6]))
    raise Blocked(
        "SewFormer produced a valid T-shirt pattern, but the bridge from its panels to a simulated "
        "runtime garment is not implemented yet. No garment was created."
    )


class JobRunner:
    def __init__(self, store: Store, exporter: Exporter = node_exporter, sewformer: Exporter = sewformer_step) -> None:
        self.store = store
        self.exporter = exporter
        self.sewformer = sewformer
        self.queue: queue.Queue[str] = queue.Queue()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def submit(self, record: dict, size: str, method: str, selected: dict) -> dict:
        if method not in {"procedural-template", "sewformer"}:
            raise ValueError("Unknown reconstruction method")
        if size not in TEMPLATE_SIZES:
            raise ValueError("Unknown size")
        if method == "sewformer" and not selected.get("onModel"):
            raise ValueError("SewFormer needs a selected on-model image")
        known = {image["id"] for image in record.get("images", [])}
        for image_id in filter(None, selected.values()):
            if image_id not in known:
                raise ValueError(f"Unknown image {image_id}")
        facts = record.get("product") or {}
        article = facts.get("article") or "unknown"
        hashes = [i["sha256"] for i in record.get("images", []) if i["id"] in set(filter(None, selected.values()))]
        garment_id = cache_key(article, facts.get("color") or "", size, method, hashes)
        on_model = next((i for i in record.get("images", []) if i["id"] == selected.get("onModel")), None)
        on_model_path = str(self.store.image_path(record["id"], on_model["file"])) if on_model else None
        job = {
            "id": self.store.new_id(), "garmentId": garment_id, "importId": record["id"], "size": size, "method": method,
            "selected": selected, "stage": "imported", "status": "queued", "error": None, "blocked": False,
            "cached": False, "updatedAt": time.time(),
            "spec": {"size": size, "method": method, "name": facts.get("name") or "T-shirt", "article": article, "source": record.get("url"), "onModelPath": on_model_path},
        }
        _, problems = self.store.verify_garment(garment_id)
        if not problems:
            job.update(stage="ready", status="done", cached=True)
            self.store.save_job(job)
            return job
        self.store.save_job(job)
        self.queue.put(job["id"])
        return job

    def _set(self, job: dict, **changes) -> None:
        job.update(changes, updatedAt=time.time())
        self.store.save_job(job)

    def _loop(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self.run(self.store.get_job(job_id))
            finally:
                self.queue.task_done()

    def run(self, job: dict) -> None:
        final = self.store.garment_dir(job["garmentId"])
        work = final.with_name(f"{final.name}.work")
        try:
            self._set(job, status="running", stage="images_selected")
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            if job["method"] == "sewformer":
                self.sewformer(job["spec"], work)
            self._set(job, stage="pattern_inferred")
            self.exporter(job["spec"], work)
            self._set(job, stage="mesh_assembled")
            shutil.rmtree(final, ignore_errors=True)
            work.rename(final)
            _, problems = self.store.verify_garment(job["garmentId"])
            if problems:
                shutil.rmtree(final, ignore_errors=True)
                raise RuntimeError("Asset validation failed: " + "; ".join(problems))
            self._set(job, stage="asset_validated")
            self._set(job, stage="ready", status="done")
        except Blocked as exc:
            shutil.rmtree(work, ignore_errors=True)
            self._set(job, status="failed", blocked=True, error=str(exc))
        except Exception as exc:  # A failed job must be reported, and must not stop the worker.
            shutil.rmtree(work, ignore_errors=True)
            self._set(job, status="failed", error=str(exc))
