import copy

from app.sewformer_adapter import normalize_prediction


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
    out = normalize_prediction(raw)
    assert out["isTShirt"] is False
    assert any("skirt_front" in e for e in out["errors"])


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
