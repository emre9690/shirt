import copy

import pytest

from app.sewformer_adapter import fit_template_params, normalize_prediction


def square(size=40):
    return {
        "translation": [0, 0, 0], "rotation": [0, 0, 0],
        "vertices": [[0, 0], [size, 0], [size, size], [0, size]],
        "edges": [
            {"endpoints": [0, 1]}, {"endpoints": [1, 2], "curvature": [0.5, 0.25]},
            {"endpoints": [2, 3]}, {"endpoints": [3, 0]},
        ],
    }


def tee():
    names = ["top_front", "top_back", "sleeve_lf", "sleeve_lb", "sleeve_rf", "sleeve_rb"]
    return {
        "properties": {"units_in_meter": 100, "curvature_coords": "relative"},
        "pattern": {
            "panels": {name: square() for name in names},
            "stitches": [
                [{"panel": "top_front", "edge": 1}, {"panel": "top_back", "edge": 3}],
                [{"panel": "sleeve_lf", "edge": 1}, {"panel": "sleeve_lb", "edge": 3}],
            ],
        },
    }


def test_valid_tee_converts_units_and_flags_missing_neckband():
    out = normalize_prediction(tee())
    assert out["errors"] == []
    assert out["isTShirt"] is True
    front = next(p for p in out["panels"] if p["id"] == "top_front")
    assert front["edges"][0]["points"][-1] == [0.4, 0.0]
    assert any("neckband" in w for w in out["warnings"])


def test_curve_matches_sewfactory_control_point():
    front = next(p for p in normalize_prediction(tee())["panels"] if p["id"] == "top_front")
    curve = front["edges"][1]["points"]
    # Edge (40,0)->(40,40), control = start + 0.5*edge + 0.25*left normal (-40,0) = (30,20).
    # The quadratic midpoint is 0.25*a + 0.5*c + 0.25*b = (35,20) cm.
    middle = curve[len(curve) // 2]
    assert abs(middle[0] - 0.35) < 1e-9
    assert abs(middle[1] - 0.20) < 1e-9


def test_does_not_mutate_raw_prediction():
    raw = tee()
    before = copy.deepcopy(raw)
    normalize_prediction(raw)
    assert raw == before


def test_rejects_dress_prediction():
    raw = tee()
    raw["pattern"]["panels"]["skirt_front"] = square()
    raw["pattern"]["stitches"].append([{"panel": "top_front", "edge": 0}, {"panel": "skirt_front", "edge": 2}])
    out = normalize_prediction(raw)
    assert out["isTShirt"] is False
    assert any("skirt_front" in e for e in out["errors"])


def test_separate_trousers_do_not_block_the_shirt():
    raw = tee()
    raw["pattern"]["panels"]["pant_front_left"] = square()
    raw["pattern"]["panels"]["wb_front"] = square()
    raw["pattern"]["stitches"].append([{"panel": "pant_front_left", "edge": 0}, {"panel": "wb_front", "edge": 2}])
    out = normalize_prediction(raw)
    assert out["errors"] == []
    assert out["isTShirt"] is True
    assert any("pant_front_left" in w for w in out["warnings"])


def shirt_prediction():
    # Geometry in the shape of the real prediction for an on-model T-shirt photo, in cm.
    def panel(vertices):
        count = len(vertices)
        return {"translation": [0, 0, 0], "rotation": [0, 0, 0], "vertices": vertices,
                "edges": [{"endpoints": [n, (n + 1) % count]} for n in range(count)]}

    front = [[0, 0], [67.6, 0.4], [55.3, 38.9], [51.9, 58.4], [39.9, 58.3], [34, 52.1], [27.7, 59.5], [15.5, 59.2], [12.4, 38.3]]
    back = [[0, 0], [68.3, 0.2], [56.1, 38.9], [52.4, 58.6], [40.8, 58.3], [27.4, 58.6], [16.8, 58.4], [13.2, 38.8]]
    sleeve = [[0, 0], [20, 0], [20, 18], [0, 18]]
    panels = {"top_front": panel(front), "top_back": panel(back)}
    for name in ("sleeve_lf", "sleeve_lb", "sleeve_rf", "sleeve_rb"):
        panels[name] = panel(sleeve)
    stitch = lambda a, ea, b, eb: [{"panel": a, "edge": ea}, {"panel": b, "edge": eb}]
    return {
        "properties": {"units_in_meter": 100, "curvature_coords": "relative"},
        "pattern": {"panels": panels, "stitches": [
            stitch("top_front", 2, "sleeve_lf", 1), stitch("top_back", 6, "sleeve_lb", 1),
            stitch("top_front", 7, "sleeve_rf", 1), stitch("top_back", 2, "sleeve_rb", 1),
        ]},
    }


def test_fit_uses_predicted_ratios_at_published_size():
    fit = fit_template_params(normalize_prediction(shirt_prediction()), 0.55, 0.71)
    params = fit["params"]
    assert 0.44 < params["shoulderWidth"] < 0.50
    assert 0.13 <= params["neckWidth"] <= 0.22
    assert 0.05 <= params["neckDepthFront"] <= 0.12
    assert 0.18 <= params["armholeDepth"] <= 0.32
    assert fit["sleeveSamples"] == 4


def test_fit_keeps_size_dependence():
    normalized = normalize_prediction(shirt_prediction())
    small = fit_template_params(normalized, 0.47, 0.68)["params"]["shoulderWidth"]
    large = fit_template_params(normalized, 0.67, 0.75)["params"]["shoulderWidth"]
    assert large > small + 0.1


def test_fit_reports_clamped_values():
    raw = shirt_prediction()
    raw["pattern"]["panels"]["top_front"]["vertices"][5] = [34, 20]
    fit = fit_template_params(normalize_prediction(raw), 0.55, 0.71)
    assert any("neckDepthFront" in c for c in fit["clamped"]) or fit["params"]["neckDepthFront"] <= 0.12


def test_fit_refuses_non_tshirt():
    raw = shirt_prediction()
    del raw["pattern"]["panels"]["sleeve_rb"]
    with pytest.raises(ValueError):
        fit_template_params(normalize_prediction(raw), 0.55, 0.71)


def test_rejects_missing_sleeve():
    raw = tee()
    del raw["pattern"]["panels"]["sleeve_rb"]
    out = normalize_prediction(raw)
    assert out["isTShirt"] is False


def test_rejects_open_edge_loop():
    raw = tee()
    raw["pattern"]["panels"]["top_front"]["edges"][2]["endpoints"] = [3, 2]
    assert any("not closed" in e for e in normalize_prediction(raw)["errors"])


def test_rejects_stitch_to_missing_edge():
    raw = tee()
    raw["pattern"]["stitches"].append([{"panel": "top_front", "edge": 99}, {"panel": "top_back", "edge": 0}])
    assert any("missing edge" in e for e in normalize_prediction(raw)["errors"])


def test_rejects_edge_sewn_twice():
    raw = tee()
    raw["pattern"]["stitches"].append([{"panel": "top_front", "edge": 1}, {"panel": "top_back", "edge": 0}])
    assert any("sewn twice" in e for e in normalize_prediction(raw)["errors"])


def test_rejects_missing_units():
    raw = tee()
    raw["properties"] = {}
    assert normalize_prediction(raw)["errors"] == ["Prediction has no valid units"]
