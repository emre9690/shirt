import type { PreparedGarment } from '../runtime';
import { TryOnSession } from '../runtime';
import { bodyCapsules, type BodyPose, type BodyProfile } from '../tracking/body';
import type { Capsule } from './xpbd';
import type { WorkerRequest, WorkerResult } from './worker';

/** Runs the cloth off the main thread, falling back to the main thread if workers are unavailable. */
export class PhysicsClient {
  x: Float32Array;
  readonly n: number;
  capsules: Capsule[] = [];
  ready = false;
  strain = 0;
  refits = 0;
  stepMs = 0;
  mode: 'worker' | 'main thread' = 'worker';
  private worker: Worker | null = null;
  private local: TryOnSession | null = null;
  private busy = false;
  private pose: BodyPose | null = null;
  private lost = false;
  private dt = 0;

  constructor(garment: PreparedGarment, private profile: BodyProfile) {
    this.x = garment.mesh.positions.slice();
    this.n = this.x.length / 3;
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => this.receive(event.data);
      this.worker.onerror = () => this.useMainThread(garment);
      this.send({ type: 'init', garment, profile });
    } catch {
      this.useMainThread(garment);
    }
  }

  private useMainThread(garment: PreparedGarment): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.mode = 'main thread';
    this.local = new TryOnSession(garment, this.profile);
  }

  private send(message: WorkerRequest): void {
    this.worker?.postMessage(message);
  }

  private receive(result: WorkerResult): void {
    this.busy = false;
    this.x = result.x;
    this.strain = result.strain;
    this.refits = result.refits;
    this.stepMs = result.stepMs;
    if (result.placed) this.ready = true;
  }

  updatePose(pose: BodyPose): void {
    this.pose = pose;
    this.capsules = bodyCapsules(pose, this.profile);
  }

  markTrackingLost(): void {
    this.lost = true;
    this.pose = null;
    this.ready = false;
  }

  /** Queue elapsed time. If the worker is still busy it is delivered with the next step. */
  step(dt: number): void {
    this.dt += dt;
    if (this.local) {
      const started = performance.now();
      if (this.lost) this.local.markTrackingLost();
      if (this.pose) this.local.updatePose(this.pose);
      if (this.pose || this.ready) {
        this.local.step(this.dt);
        this.ready = true;
      }
      this.x = this.local.solver.x;
      this.strain = this.local.solver.maxStrain();
      this.refits = this.local.refits;
      this.stepMs = performance.now() - started;
    } else {
      if (this.busy) return;
      this.busy = true;
      this.send({ type: 'step', pose: this.pose, dt: Math.min(this.dt, 0.1), lost: this.lost });
    }
    this.dt = 0;
    this.pose = null;
    this.lost = false;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
