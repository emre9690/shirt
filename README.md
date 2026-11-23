# Live Shirt Try-On

A research prototype that puts a simulated 3D T-shirt on your live camera feed. Camera frames stay in the browser. See [docs/STATUS.md](docs/STATUS.md) for what works, what is approximate, and what is unfinished.

## Run it

Requires Node 26, [uv](https://docs.astral.sh/uv/), and a browser with WebGL2 and camera access. Tested on Windows 11 with Chromium.

```powershell
npm install
npm run assets        # self-hosts the MediaPipe runtime and pose model
npm run build:tools   # builds the garment exporter
npm run dev           # http://127.0.0.1:5173
```

The built-in shirt works with only the commands above. To import garments, start the preparation service in a second terminal, with Node on `PATH`:

```powershell
cd services/preprocess
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8765
```

## Use it

1. Choose a size and enter your height.
2. Click **Start camera** and stand back so your head and hips are visible.
3. Wear a close-fitting top. The virtual shirt cannot hide clothing that extends past it.

**Synthetic demo** exercises the physics and rendering without a camera. The **Developer panel** shows timings, the cloth wireframe, and the collision body.

## Optional: SewFormer

SewFormer runs once per garment, never during the live view. It needs its own Python 3.10 environment. The app looks for it in `%LOCALAPPDATA%\shirt-tools\sewformer`:

```powershell
$s = "$env:LOCALAPPDATA\shirt-tools\sewformer"
git clone https://github.com/sail-sg/sewformer.git $s
git -C $s checkout 281202a70d36eab81c9c4aca173b7e9461a22372
uv venv --python 3.10 "$s\.venv"
uv pip install --python "$s\.venv\Scripts\python.exe" torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$s\.venv\Scripts\python.exe" matplotlib sparsemax numpy requests scipy wandb protobuf svglib svgwrite entmax numba pytz cairosvg opencv-python pyyaml pillow psutil wmi scikit-learn
```

Download `Detr2d-V6-final-dif-ce-focal-schd-agp_checkpoint_37.pth` from <https://huggingface.co/liulj/sewformer> into `$s\Sewformer\assets\ckpts`. In the app, upload a photo of a person wearing the shirt and choose **Prepare with SewFormer**.

## Test it

```powershell
npm test
npm run typecheck
cd services/preprocess; uv run pytest
blender --background --factory-startup --python tools/blender/validate_glb.py -- <render.glb>
```

## Layout

| Path | Purpose |
| --- | --- |
| `apps/web` | Camera mirror, pose tracking, cloth physics, rendering |
| `packages/garment-schema` | Shared pattern, mesh assembly, validation, package format |
| `services/preprocess` | URL import, background jobs, SewFormer adapter |
| `tools` | Garment exporter and Blender validation |
| `tests` | Geometry, physics, tracking, and package tests |
