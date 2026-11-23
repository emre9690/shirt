"""Turn a raw SewFormer prediction into the common panel/seam form, or say why it cannot be used."""
from __future__ import annotations

import json
import math
import os
import subprocess
from pathlib import Path

DEFAULT_CHECKOUT = Path(os.environ.get("LOCALAPPDATA", "")) / "shirt-tools" / "sewformer"
CHECKPOINT = "Detr2d-V6-final-dif-ce-focal-schd-agp_checkpoint_37.pth"
RUNNER = Path(__file__).resolve().parents[1] / "sewformer_runner.py"
CURVE_SAMPLES = 12
NON_TSHIRT_PREFIXES = ("skirt_", "pant_", "hood_", "wb_")
SLEEVE_PAIRS = {"+x": ("sleeve_lf", "sleeve_lb"), "-x": ("sleeve_rf", "sleeve_rb")}


def _curve(a: list[float], b: list[float], curvature: list[float] | None, scale: float) -> list[list[float]]:
    if not curvature:
        return [[a[0] * scale, a[1] * scale], [b[0] * scale, b[1] * scale]]
    dx, dy = b[0] - a[0], b[1] - a[1]
    # SewFactory's relative control point: along the edge, then along its left-hand normal.
    cx = a[0] + curvature[0] * dx - curvature[1] * dy
    cy = a[1] + curvature[0] * dy + curvature[1] * dx
    points = []
    for k in range(CURVE_SAMPLES + 1):
        t = k / CURVE_SAMPLES
        s = 1 - t
        points.append([(s * s * a[0] + 2 * s * t * cx + t * t * b[0]) * scale, (s * s * a[1] + 2 * s * t * cy + t * t * b[1]) * scale])
    return points


def normalize_prediction(raw: dict) -> dict:
    """Return panels in metres, seams, errors and warnings. The raw prediction is never altered."""
    errors: list[str] = []
    warnings: list[str] = []
    pattern = raw.get("pattern") or {}
    units = (raw.get("properties") or {}).get("units_in_meter")
    if not isinstance(units, (int, float)) or units <= 0:
        return {"panels": [], "seams": [], "openEdges": [], "errors": ["Prediction has no valid units"], "warnings": [], "isTShirt": False}
    if (raw.get("properties") or {}).get("curvature_coords") != "relative":
        errors.append("Unsupported curvature coordinates")
    scale = 1 / units
    panels: list[dict] = []
    edge_ids: set[tuple[str, int]] = set()
    for name, panel in (pattern.get("panels") or {}).items():
        vertices = panel.get("vertices") or []
        edges = panel.get("edges") or []
        if len(edges) < 3:
            errors.append(f"{name}: fewer than 3 edges")
            continue
        out_edges = []
        for index, edge in enumerate(edges):
            start, end = edge["endpoints"]
            if not (0 <= start < len(vertices) and 0 <= end < len(vertices)):
                errors.append(f"{name}/{index}: endpoint out of range")
                continue
            if edges[(index + 1) % len(edges)]["endpoints"][0] != end:
                errors.append(f"{name}: edge loop is not closed after edge {index}")
            points = _curve(vertices[start], vertices[end], edge.get("curvature"), scale)
            if not all(math.isfinite(v) for p in points for v in p):
                errors.append(f"{name}/{index}: non-finite geometry")
            out_edges.append({"id": str(index), "points": points})
            edge_ids.add((name, index))
        panels.append({"id": name, "edges": out_edges, "translation": panel.get("translation"), "rotation": panel.get("rotation")})

    seams: list[dict] = []
    used: set[tuple[str, int]] = set()
    for stitch in pattern.get("stitches") or []:
        if len(stitch) != 2:
            errors.append("Stitch does not join exactly two edges")
            continue
        a, b = ((side["panel"], side["edge"]) for side in stitch)
        for ref in (a, b):
            if ref not in edge_ids:
                errors.append(f"Stitch references missing edge {ref[0]}/{ref[1]}")
            if ref in used:
                errors.append(f"Edge sewn twice: {ref[0]}/{ref[1]}")
            used.add(ref)
        seams.append({"a": {"panel": a[0], "edge": str(a[1])}, "b": {"panel": b[0], "edge": str(b[1])}})

    names = {p["id"] for p in panels}
    unexpected = sorted(n for n in names if n.startswith(NON_TSHIRT_PREFIXES) or n == "top_front_left")
    missing = [n for n in ("top_front", "top_back") if n not in names]
    missing_sleeves = [side for side, pair in SLEEVE_PAIRS.items() if not set(pair) <= names]
    is_tshirt = not unexpected and not missing and not missing_sleeves
    if unexpected:
        errors.append("Not a T-shirt: predicted " + ", ".join(unexpected))
    if missing:
        errors.append("Not a T-shirt: missing " + ", ".join(missing))
    if missing_sleeves:
        errors.append("Not a T-shirt: incomplete sleeve panels on side " + ", ".join(missing_sleeves))
    if "neckband" not in names:
        warnings.append("SewFormer's panel classes have no neckband, so the ribbed collar is not reconstructed.")
    open_edges = sorted(f"{p}/{e}" for p, e in edge_ids - used)
    if not seams:
        errors.append("Prediction has no seams")
    return {"panels": panels, "seams": seams, "openEdges": open_edges, "errors": errors, "warnings": warnings, "isTShirt": is_tshirt}


def check_installation(checkout: Path = DEFAULT_CHECKOUT) -> str | None:
    """Return the exact missing piece, or None when inference can run."""
    if not (checkout / "Sewformer" / "inference.py").exists():
        return f"SewFormer checkout not found at {checkout}"
    if not (checkout / ".venv" / "Scripts" / "python.exe").exists():
        return f"SewFormer environment not found at {checkout / '.venv'}"
    if not (checkout / "Sewformer" / "assets" / "ckpts" / CHECKPOINT).exists():
        return f"Checkpoint {CHECKPOINT} is missing"
    return None


def run_inference(image: Path, out_dir: Path, checkout: Path = DEFAULT_CHECKOUT) -> dict:
    """Execute the model on one image and return its normalized, validated prediction."""
    python = checkout / ".venv" / "Scripts" / "python.exe"
    result = subprocess.run(
        [str(python), str(RUNNER), "--checkout", str(checkout), "--image", str(image), "--out", str(out_dir)],
        capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0 or "SEWFORMER_OK" not in result.stdout:
        raise RuntimeError(f"SewFormer failed: {(result.stderr or result.stdout).strip()[-600:]}")
    raw = json.loads((out_dir / "raw_prediction.json").read_text(encoding="utf-8"))
    normalized = normalize_prediction(raw)
    normalized["run"] = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
    (out_dir / "normalized_pattern.json").write_text(json.dumps(normalized, indent=2), encoding="utf-8")
    return normalized
