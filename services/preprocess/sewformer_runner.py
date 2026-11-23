"""Run upstream SewFormer inference on one image. Executes inside SewFormer's isolated venv.

Usage: python sewformer_runner.py --checkout <sewformer repo> --image <file> --out <dir>

Differences from upstream inference.py, all outside the checkout:
- wandb is disabled, so nothing is sent to a cloud service.
- cairosvg is stubbed because the native Cairo DLL is absent on Windows. It only draws PNG previews.
- The model runs in eval mode under no_grad, so repeated runs are deterministic.
"""
import argparse
import collections
import json
import os
import pickle
import shutil
import subprocess
import sys
import time
import types
from pathlib import Path


class _InertTrainingObject:
    """Stands in for the checkpoint's optimizer and scheduler. Inference never uses them."""

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def __setstate__(self, _state) -> None:
        pass


_ALLOWED_GLOBALS = {
    ("collections", "OrderedDict"): collections.OrderedDict,
    ("collections", "defaultdict"): collections.defaultdict,
    ("builtins", "dict"): dict,
    ("__builtin__", "dict"): dict,  # The same type, under its pickle protocol 2 name.
    ("torch.optim.adamw", "AdamW"): _InertTrainingObject,
    ("torch.optim.lr_scheduler", "CosineAnnealingLR"): _InertTrainingObject,
}
_ALLOWED_TORCH = {
    ("torch._utils", "_rebuild_tensor_v2"), ("torch._utils", "_rebuild_parameter"),
    ("torch", "FloatStorage"), ("torch", "DoubleStorage"), ("torch", "LongStorage"),
    ("torch", "IntStorage"), ("torch", "ByteStorage"), ("torch", "BoolStorage"),
}


class _RestrictedUnpickler(pickle.Unpickler):
    """Refuses every global outside the list above, so the file cannot run arbitrary code."""

    def find_class(self, module: str, name: str):
        if (module, name) in _ALLOWED_GLOBALS:
            return _ALLOWED_GLOBALS[(module, name)]
        if (module, name) in _ALLOWED_TORCH:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"Checkpoint references a disallowed global: {module}.{name}")


def restricted_load(torch, file, device):
    restricted = types.ModuleType("restricted_pickle")
    restricted.Unpickler = _RestrictedUnpickler
    restricted.load = lambda f, **kwargs: _RestrictedUnpickler(f, **kwargs).load()
    checkpoint = torch.load(file, map_location=device, pickle_module=restricted, weights_only=False)
    return {"model_state_dict": checkpoint["model_state_dict"]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    checkout = args.checkout.resolve()
    image = args.image.resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    os.environ["WANDB_MODE"] = "disabled"
    os.environ["WANDB_SILENT"] = "true"
    stub = types.ModuleType("cairosvg")
    stub.svg2png = lambda *a, **k: None
    sys.modules["cairosvg"] = stub

    code_dir = checkout / "Sewformer"
    os.chdir(code_dir)
    sys.path.insert(0, str(code_dir))
    sys.path.insert(0, str(checkout / "SewFactory" / "packages"))

    import data
    import torch
    import yaml
    from experiment import ExperimentWrappper
    from inference import load_source_appearance

    started = time.perf_counter()
    config = yaml.safe_load(open("configs/test.yaml", encoding="utf-8"))
    # Upstream's test.yaml omits this key, but ExperimentWrappper requires it.
    config["experiment"]["is_training"] = False
    experiment = ExperimentWrappper(config, "")
    experiment._load_model_from_file = lambda file, device=None: restricted_load(torch, file, device)
    # Upstream's load_detr_dataset omits the constructor's sim_root argument, so build it directly.
    # An empty root means no training data is needed. Only the config and panel classes are used.
    empty_root = out / "empty_dataset"
    empty_root.mkdir(exist_ok=True)
    data_config = dict(config["dataset"], data_folders=[])
    dataset = data.GarmentDetrDataset(str(empty_root), str(empty_root), data_config, gt_caching=False, feature_caching=False)
    model, _, device = experiment.load_detr_model(dataset.config, others=False)
    model.eval()
    tensor, _ = load_source_appearance(str(image))
    with torch.no_grad():
        # Upstream's deepfashion path. Its "real" path selects a 56-edge subset whose indices
        # cannot be mapped back to pattern edges, which loses every seam.
        output = model(tensor.to(device))
    panel_order, _, prediction_image = dataset.save_prediction_single(output, dataname="prediction", save_to=str(out / "upstream"), return_stitches=False)
    spec = Path(prediction_image).parent / "_predicted_single_specification.json"
    if not spec.exists():
        raise RuntimeError(f"Upstream did not write {spec.name}")
    shutil.copy2(spec, out / "raw_prediction.json")
    commit = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    (out / "run.json").write_text(json.dumps({
        "model": "SewFormer", "commit": commit, "checkpoint": Path(config["NN"]["pre-trained"]).name, "device": str(device),
        "deviceName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "torch": torch.__version__, "seconds": round(time.perf_counter() - started, 2), "panelOrder": list(panel_order),
    }, indent=2), encoding="utf-8")
    print("SEWFORMER_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
