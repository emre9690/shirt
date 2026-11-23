"""Local preprocessing API. Run with: uv run uvicorn app.main:app --host 127.0.0.1 --port 8765"""
from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .extract import article_from_url, extract_product
from .jobs import JobRunner
from .safe_fetch import FetchFailed, UnsafeUrl, safe_get
from .store import MAX_IMAGE_BYTES, Store

DATA_DIR = Path(os.environ.get("SHIRT_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))


class ImportRequest(BaseModel):
    url: str


class PrepareRequest(BaseModel):
    importId: str
    size: str
    method: str = "procedural-template"
    onModelImage: str | None = None
    garmentImage: str | None = None


def create_app(store: Store | None = None, runner: JobRunner | None = None) -> FastAPI:
    store = store or Store(DATA_DIR)
    runner = runner or JobRunner(store)
    app = FastAPI(title="Shirt preprocess")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )

    def lookup(getter, item_id: str):
        try:
            return getter(item_id)
        except KeyError:
            raise HTTPException(404, "Not found") from None

    @app.post("/imports")
    def create_import(body: ImportRequest) -> dict:
        record = {
            "id": store.new_id(), "url": body.url, "status": "extraction_failed", "error": None,
            "product": {"article": article_from_url(body.url), "source": body.url}, "candidates": [], "images": [],
            "assumptions": [], "retrievedAt": time.time(),
        }
        try:
            page = safe_get(body.url)
            if page.status != 200:
                record["error"] = f"The site returned HTTP {page.status}. Upload product images and dimensions instead."
            else:
                product = extract_product(page.body.decode("utf-8", "replace"), page.url)
                if product is None:
                    record["error"] = "No structured product data was found. Upload product images instead."
                else:
                    record.update(status="imported", product=product, candidates=product["images"])
        except UnsafeUrl as exc:
            raise HTTPException(400, str(exc)) from exc
        except FetchFailed as exc:
            record["error"] = f"{exc}. Upload product images instead."
        store.save_import(record)
        return record

    @app.post("/imports/upload")
    async def upload_import(
        files: list[UploadFile] = File(...),
        name: str = Form("Uploaded T-shirt"),
        article: str = Form("uploaded"),
        url: str = Form(""),
    ) -> dict:
        record = {
            "id": store.new_id(), "url": url or None, "status": "imported", "error": None,
            "product": {"name": name[:120], "article": article[:40], "source": url or "user upload"},
            "candidates": [], "images": [], "assumptions": [], "retrievedAt": time.time(),
        }
        store.save_import(record)
        for upload in files[:12]:
            data = await upload.read(MAX_IMAGE_BYTES + 1)
            try:
                record["images"].append(store.add_image(record["id"], data))
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        store.save_import(record)
        return record

    @app.get("/imports/{import_id}")
    def get_import(import_id: str) -> dict:
        return lookup(store.get_import, import_id)

    @app.post("/garments/prepare")
    def prepare(body: PrepareRequest) -> dict:
        record = lookup(store.get_import, body.importId)
        try:
            return runner.submit(record, body.size, body.method, {"onModel": body.onModelImage, "garment": body.garmentImage})
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str) -> dict:
        return lookup(store.get_job, job_id)

    @app.get("/garments")
    def garments() -> list[dict]:
        return store.list_garments()

    def verified(garment_id: str) -> dict:
        manifest, problems = lookup(store.verify_garment, garment_id)
        if manifest is None or problems:
            raise HTTPException(404, "Garment is not ready")
        return manifest

    @app.get("/garments/{garment_id}/manifest")
    def manifest(garment_id: str) -> dict:
        return verified(garment_id)

    @app.get("/garments/{garment_id}/files/{name}")
    def garment_file(garment_id: str, name: str) -> FileResponse:
        allowed = {Path(entry["path"]).name for entry in verified(garment_id)["files"].values()}
        if name not in allowed:
            raise HTTPException(404, "Not found")
        return FileResponse(store.garment_dir(garment_id) / name)

    return app


app = create_app()
