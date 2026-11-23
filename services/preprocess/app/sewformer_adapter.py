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
    # Photos show whole outfits, so separate garments such as trousers are allowed.
    # Anything sewn to the top, as in a dress or hoodie, means the top is not a T-shirt.
    shirt_panels = {"top_front", "top_back", *SLEEVE_PAIRS["+x"], *SLEEVE_PAIRS["-x"]}
    attached = sorted({
        side["panel"] for seam in seams for side in (seam["a"], seam["b"])
        if side["panel"] not in shirt_panels and ({seam["a"]["panel"], seam["b"]["panel"]} & shirt_panels)
    })
    unexpected = sorted(set(attached) | {n for n in names if n.startswith("hood_") or n == "top_front_left"})
    other_garments = sorted(names - shirt_panels - set(unexpected))
    if other_garments:
        warnings.append("Ignored separate garment panels: " + ", ".join(other_garments))
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


def _panel(normalized: dict, name: str) -> dict:
    return next(p for p in normalized["panels"] if p["id"] == name)


def _body_features(panel: dict) -> dict:
    """Measure a front or back panel from its corners and neckline curve, in predicted metres."""
    corners = [edge["points"][0] for edge in panel["edges"]]
    ys = [p[1] for p in corners]
    bottom, height = min(ys), max(ys) - min(ys)
    if height <= 0:
        raise ValueError(f"{panel['id']}: panel has no height")
    top = sorted((p for p in corners if p[1] > bottom + 0.8 * height), key=lambda p: p[0])
    if len(top) < 4:
        raise ValueError(f"{panel['id']}: could not find shoulders and neckline")
    hem = sorted(corners, key=lambda p: p[1])[:2]
    middle = [p for p in corners if p not in top and p not in hem]
    if len(middle) < 2:
        raise ValueError(f"{panel['id']}: could not find both underarm points")
    chest = max(p[0] for p in middle) - min(p[0] for p in middle)
    shoulder_y = (top[0][1] + top[-1][1]) / 2
    neck_left, neck_right = top[1], top[-2]
    neck_y = (neck_left[1] + neck_right[1]) / 2
    curve = [q for edge in panel["edges"] for q in edge["points"] if neck_left[0] < q[0] < neck_right[0] and q[1] > bottom + 0.6 * height]
    lowest_neck = min((q[1] for q in curve), default=neck_y)
    return {
        "height": height,
        "chest": chest,
        "shoulder": top[-1][0] - top[0][0],
        "neckWidth": neck_right[0] - neck_left[0],
        "neckDepth": max(0.0, neck_y - lowest_neck),
        "armhole": shoulder_y - sum(p[1] for p in middle) / len(middle),
    }


def _sleeve_features(normalized: dict) -> dict:
    """Average length and cuff width of the sleeve halves, using seams to find each cuff."""
    lengths, cuffs = [], []
    for pair in SLEEVE_PAIRS.values():
        for name in pair:
            panel = _panel(normalized, name)
            if len(panel["edges"]) != 4:
                continue
            armhole = next((
                int(side["edge"]) for seam in normalized["seams"] for side, other in ((seam["a"], seam["b"]), (seam["b"], seam["a"]))
                if side["panel"] == name and other["panel"] in ("top_front", "top_back")
            ), None)
            if armhole is None:
                continue
            cuff = panel["edges"][(armhole + 2) % 4]["points"]
            root = panel["edges"][armhole]["points"]
            middle = lambda points: [(points[0][0] + points[-1][0]) / 2, (points[0][1] + points[-1][1]) / 2]
            cuff_mid, root_mid = middle(cuff), middle(root)
            lengths.append(math.dist(cuff_mid, root_mid))
            cuffs.append(math.dist(cuff[0], cuff[-1]))
    if len(lengths) < 2:
        raise ValueError("Could not identify sleeve cuffs from the predicted seams")
    return {"length": sum(lengths) / len(lengths), "cuff": sum(cuffs) / len(cuffs), "samples": len(lengths)}


# Plausible limits for an adult short-sleeved T-shirt, in metres. Predictions outside are clamped and reported.
FIT_LIMITS = {
    "shoulderWidth": (0.34, 0.62), "neckWidth": (0.13, 0.22), "neckDepthFront": (0.05, 0.12),
    "neckDepthBack": (0.01, 0.04), "armholeDepth": (0.18, 0.32), "sleeveLength": (0.14, 0.30), "sleeveOpening": (0.15, 0.27),
}


def fit_template_params(normalized: dict, published_width_m: float, published_length_m: float) -> dict:
    """
    Convert predicted proportions into garment dimensions at the published size.
    SewFormer's absolute scale is not trusted, so only its ratios are used. The result is a
    SewFormer-guided template, not a direct reconstruction of the predicted panels.
    """
    if not normalized.get("isTShirt"):
        raise ValueError("Prediction is not a T-shirt")
    front = _body_features(_panel(normalized, "top_front"))
    back = _body_features(_panel(normalized, "top_back"))
    sleeve = _sleeve_features(normalized)
    chest = (front["chest"] + back["chest"]) / 2
    height = (front["height"] + back["height"]) / 2
    if chest <= 0:
        raise ValueError("Predicted chest width is not positive")
    width_scale = published_width_m / chest
    length_scale = published_length_m / height
    raw = {
        "shoulderWidth": (front["shoulder"] + back["shoulder"]) / 2 * width_scale,
        "neckWidth": (front["neckWidth"] + back["neckWidth"]) / 2 * width_scale,
        "neckDepthFront": front["neckDepth"] * length_scale,
        "neckDepthBack": back["neckDepth"] * length_scale,
        "armholeDepth": (front["armhole"] + back["armhole"]) / 2 * length_scale,
        "sleeveLength": sleeve["length"] * length_scale,
        "sleeveOpening": sleeve["cuff"] * width_scale,
    }
    params, clamped = {}, []
    for key, value in raw.items():
        low, high = FIT_LIMITS[key]
        params[key] = round(min(high, max(low, value)), 4)
        if params[key] != round(value, 4):
            clamped.append(f"{key}: predicted {value:.3f} m, limited to {params[key]:.3f} m")
    return {"params": params, "predicted": {k: round(v, 4) for k, v in raw.items()}, "clamped": clamped, "sleeveSamples": sleeve["samples"]}


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
