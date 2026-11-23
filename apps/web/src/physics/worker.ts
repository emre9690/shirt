import { TryOnSession, type PreparedGarment } from '../runtime';
import type { BodyPose, BodyProfile } from '../tracking/body';

export type WorkerRequest =
  | { type: 'init'; garment: PreparedGarment; profile: BodyProfile }
  | { type: 'step'; pose: BodyPose | null; dt: number; lost: boolean };

export interface WorkerResult {
  x: Float32Array;
  strain: number;
  refits: number;
  stepMs: number;
  placed: boolean;
}

let session: TryOnSession | null = null;
let placed = false;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    session = new TryOnSession(message.garment, message.profile);
    placed = false;
    return;
  }
  if (!session) return;
  const started = performance.now();
  if (message.lost) {
    session.markTrackingLost();
    placed = false;
  }
  if (message.pose) {
    session.updatePose(message.pose);
    placed = true;
  }
  if (placed) session.step(message.dt);
  const x = session.solver.x.slice();
  const result: WorkerResult = { x, strain: session.solver.maxStrain(), refits: session.refits, stepMs: performance.now() - started, placed };
  (self as unknown as { postMessage(value: unknown, transfer: Transferable[]): void }).postMessage(result, [x.buffer]);
};
