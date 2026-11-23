import json

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.extract import extract_product
from app.jobs import Blocked, JobRunner
from app.safe_fetch import Fetched, UnsafeUrl
from app.store import Store, sha256

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


def fake_exporter(spec, out):
    render = b"glb-bytes"
    sim = b"{}"
    (out / "render.glb").write_bytes(render)
    (out / "sim.json").write_bytes(sim)
    (out / "manifest.json").write_text(json.dumps({
        "name": spec["name"], "size": spec["size"], "units": "m", "reconstructionMethod": spec["method"],
        "validation": {"status": "passed"},
        "files": {"render": {"path": "render.glb", "sha256": sha256(render)}, "simulation": {"path": "sim.json", "sha256": sha256(sim)}},
    }))


def build(tmp_path, exporter=fake_exporter, sewformer=None):
    store = Store(tmp_path)
    kwargs = {"sewformer": sewformer} if sewformer else {}
    runner = JobRunner(store, exporter=exporter, **kwargs)
    return store, runner, TestClient(main.create_app(store, runner))


def upload(client):
    response = client.post("/imports/upload", files=[("files", ("a.jpg", JPEG, "image/jpeg"))], data={"name": "Tee", "article": "123"})
    assert response.status_code == 200
    return response.json()


def prepare(client, runner, record, **extra):
    response = client.post("/garments/prepare", json={"importId": record["id"], "size": "M", **extra})
    assert response.status_code == 200
    runner.queue.join()
    return client.get(f"/jobs/{response.json()['id']}").json()


def test_template_job_reaches_ready_and_lists_garment(tmp_path):
    _, runner, client = build(tmp_path)
    job = prepare(client, runner, upload(client))
    assert (job["status"], job["stage"]) == ("done", "ready")
    assert [g["id"] for g in client.get("/garments").json()] == [job["garmentId"]]
    assert client.get(f"/garments/{job['garmentId']}/manifest").json()["size"] == "M"


def test_cached_garment_is_not_rebuilt(tmp_path):
    calls = []

    def counting(spec, out):
        calls.append(spec)
        fake_exporter(spec, out)

    _, runner, client = build(tmp_path, counting)
    record = upload(client)
    prepare(client, runner, record)
    second = prepare(client, runner, record)
    assert second["cached"] is True
    assert len(calls) == 1


def test_tampered_asset_is_not_ready(tmp_path):
    store, runner, client = build(tmp_path)
    job = prepare(client, runner, upload(client))
    (store.garment_dir(job["garmentId"]) / "render.glb").write_bytes(b"tampered")
    assert client.get("/garments").json() == []
    assert client.get(f"/garments/{job['garmentId']}/manifest").status_code == 404


def test_exporter_without_valid_files_fails_job(tmp_path):
    def broken(_spec, out):
        (out / "manifest.json").write_text(json.dumps({"units": "m", "validation": {"status": "passed"}, "files": {}}))

    _, runner, client = build(tmp_path, broken)
    job = prepare(client, runner, upload(client))
    assert job["status"] == "failed"
    assert job["stage"] != "ready"
    assert client.get("/garments").json() == []


def test_blocked_sewformer_never_falls_back_silently(tmp_path):
    def blocked(_spec, _out):
        raise Blocked("checkpoint missing")

    exported = []
    _, runner, client = build(tmp_path, lambda s, o: exported.append(s), blocked)
    record = upload(client)
    job = prepare(client, runner, record, method="sewformer", onModelImage=record["images"][0]["id"])
    assert (job["status"], job["blocked"], job["error"]) == ("failed", True, "checkpoint missing")
    assert exported == []


def test_sewformer_requires_on_model_image(tmp_path):
    _, _, client = build(tmp_path)
    record = upload(client)
    assert client.post("/garments/prepare", json={"importId": record["id"], "size": "M", "method": "sewformer"}).status_code == 400


def test_rejects_non_image_upload(tmp_path):
    _, _, client = build(tmp_path)
    response = client.post("/imports/upload", files=[("files", ("a.jpg", b"<script>", "image/jpeg"))])
    assert response.status_code == 400


def test_blocked_site_preserves_url(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "safe_get", lambda url: Fetched(url, 403, "text/html", b"denied"))
    _, _, client = build(tmp_path)
    url = "https://www2.hm.com/nl_nl/productpage.0685816001.html"
    record = client.post("/imports", json={"url": url}).json()
    assert record["status"] == "extraction_failed"
    assert record["url"] == url
    assert record["product"]["article"] == "0685816001"
    assert "403" in record["error"]


def test_unsafe_url_is_rejected(tmp_path, monkeypatch):
    def refuse(_url):
        raise UnsafeUrl("Host resolves to a non-public address")

    monkeypatch.setattr(main, "safe_get", refuse)
    _, _, client = build(tmp_path)
    assert client.post("/imports", json={"url": "https://localhost/"}).status_code == 400


@pytest.mark.parametrize("bad", ["..", "a%2F..", "a.b"])
def test_rejects_path_like_ids(tmp_path, bad):
    _, _, client = build(tmp_path)
    assert client.get(f"/jobs/{bad}").status_code == 404


def test_extracts_json_ld_product_only():
    html = """<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Tee","sku":"42","color":"White",
    "material":"100% cotton","size":["S","M"],"image":["/a.jpg","https://cdn.test/b.jpg","http://cdn.test/c.jpg"]}]}</script>"""
    product = extract_product(html, "https://shop.test/p")
    assert product["name"] == "Tee"
    assert product["sizes"] == ["S", "M"]
    assert product["images"] == ["https://shop.test/a.jpg", "https://cdn.test/b.jpg"]
