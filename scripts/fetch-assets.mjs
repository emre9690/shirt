// Self-hosts the MediaPipe runtime and pose model so the live app makes no third-party requests.
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'apps/web/public');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const modelPath = join(pub, 'models/pose_landmarker_full.task');

await mkdir(join(pub, 'mediapipe'), { recursive: true });
await mkdir(dirname(modelPath), { recursive: true });
await cp(join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), join(pub, 'mediapipe/wasm'), { recursive: true });

const exists = await stat(modelPath).then((s) => s.size > 0, () => false);
if (!exists) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  await writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
}
console.log(`assets ready, model bytes: ${(await stat(modelPath)).size}`);
