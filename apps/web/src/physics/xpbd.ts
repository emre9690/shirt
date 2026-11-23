import type { GarmentMesh } from '@shirt/garment-schema';

export interface Capsule {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number;
  /**
   * Arm capsules only: the `simSleeve` side this arm passes through. It collides with that
   * sleeve and nothing else. KNOWN LIMITATION: body panels do not collide with arms, because
   * loose regular-fit fabric under the arm gets caught across the capsule. Depth occlusion
   * hides the resulting overlap.
   */
  sleeveSide?: 1 | -1;
  /** Ignore contacts nearer the capsule start than this fraction (the armhole region). */
  minT?: number;
  /** False for parts that sit inside the garment and must not cut holes in it when drawn. */
  occludes?: boolean;
}

export interface SolverParams {
  gravity: number;
  /** XPBD compliance in m/N-style units; independent of timestep. */
  stretchCompliance: number;
  bendCompliance: number;
  /** Velocity decay rate, 1/s. */
  damping: number;
  friction: number;
  collisionOffset: number;
  fixedDt: number;
  substeps: number;
  maxStepsPerFrame: number;
  maxSpeed: number;
}

/** Estimated cotton-jersey preset. Not calibrated against a physical fabric test. */
export const ESTIMATED_JERSEY: SolverParams = {
  gravity: 9.81,
  stretchCompliance: 1e-7,
  // Vertex inverse masses are ~1e4 per kg, so compliance must be large for bending to stay soft.
  bendCompliance: 1,
  damping: 1.2,
  friction: 0.35,
  collisionOffset: 0.006,
  fixedDt: 1 / 60,
  substeps: 8,
  maxStepsPerFrame: 3,
  maxSpeed: 12,
};

export interface Attachment {
  index: number;
  x: number; y: number; z: number;
  compliance: number;
}

export class ClothSolver {
  readonly n: number;
  readonly x: Float32Array;
  readonly prev: Float32Array;
  readonly v: Float32Array;
  readonly rest: Float32Array;
  params: SolverParams;
  attachments: Attachment[] = [];
  resets = 0;
  droppedTime = 0;
  private accumulator = 0;
  private fromCapsules: Capsule[] = [];
  private toCapsules: Capsule[] = [];
  private current: Capsule[] = [];
  private previous: Capsule[] = [];

  constructor(private mesh: GarmentMesh, params: SolverParams = ESTIMATED_JERSEY) {
    this.n = mesh.positions.length / 3;
    this.x = mesh.positions.slice();
    this.prev = mesh.positions.slice();
    this.rest = mesh.positions.slice();
    this.v = new Float32Array(this.n * 3);
    this.params = { ...params };
  }

  /** New collider targets; motion is interpolated across the next fixed step. */
  setColliders(capsules: Capsule[]): void {
    this.fromCapsules = this.toCapsules.length === capsules.length ? this.toCapsules : capsules;
    this.toCapsules = capsules.map((c) => ({ ...c }));
    this.current = capsules.map((c) => ({ ...c }));
    this.previous = capsules.map((c) => ({ ...c }));
  }

  /** Advance by wall-clock time using a fixed step. Returns fixed steps executed. */
  advance(frameDt: number): number {
    const { fixedDt, maxStepsPerFrame } = this.params;
    this.accumulator += Math.max(0, frameDt);
    const steps = Math.min(Math.floor(this.accumulator / fixedDt + 1e-9), maxStepsPerFrame);
    for (let step = 0; step < steps; step++) {
      this.fixedStep(step, steps);
      this.accumulator -= fixedDt;
    }
    if (this.accumulator >= fixedDt) {
      this.droppedTime += this.accumulator;
      this.accumulator = 0;
    }
    if (steps > 0) this.fromCapsules = this.toCapsules;
    return steps;
  }

  /** Collider motion since the last frame is spread evenly over this frame's fixed steps. */
  private fixedStep(step: number, stepCount: number): void {
    const { fixedDt, substeps, gravity, damping, maxSpeed } = this.params;
    const h = fixedDt / substeps;
    const decay = Math.exp(-damping * h);
    const maxMove = maxSpeed * h;
    const { x, prev, v } = this;
    const invMass = this.mesh.invMass;
    for (let s = 0; s < substeps; s++) {
      this.interpolateColliders((step + (s + 1) / substeps) / stepCount);
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        prev[k] = x[k];
        prev[k + 1] = x[k + 1];
        prev[k + 2] = x[k + 2];
        if (invMass[i] === 0) continue;
        v[k + 1] -= gravity * h;
        v[k] *= decay;
        v[k + 1] *= decay;
        v[k + 2] *= decay;
        let dx = v[k] * h;
        let dy = v[k + 1] * h;
        let dz = v[k + 2] * h;
        const len = Math.hypot(dx, dy, dz);
        if (len > maxMove) {
          const f = maxMove / len;
          dx *= f;
          dy *= f;
          dz *= f;
        }
        x[k] += dx;
        x[k + 1] += dy;
        x[k + 2] += dz;
      }
      this.solveDistance(this.mesh.stretch, this.params.stretchCompliance / (h * h));
      this.solveDistance(this.mesh.bend, this.params.bendCompliance / (h * h));
      this.solveAttachments(h);
      this.solveCollisions();
      for (let k = 0; k < this.n * 3; k++) v[k] = (x[k] - prev[k]) / h;
    }
    if (!this.isHealthy()) this.reset();
  }

  /** One small-step XPBD iteration: lambda starts at zero, so alpha-tilde = compliance / h^2. */
  private solveDistance(c: GarmentMesh['stretch'], alpha: number): void {
    const { x } = this;
    const w = this.mesh.invMass;
    for (let n = 0; n < c.rest.length; n++) {
      const a = c.i[n] * 3;
      const b = c.j[n] * 3;
      const wSum = w[c.i[n]] + w[c.j[n]];
      if (wSum === 0) continue;
      const dx = x[a] - x[b];
      const dy = x[a + 1] - x[b + 1];
      const dz = x[a + 2] - x[b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const lambda = -(len - c.rest[n]) / (wSum + alpha);
      const px = (lambda * dx) / len;
      const py = (lambda * dy) / len;
      const pz = (lambda * dz) / len;
      const wa = w[c.i[n]];
      const wb = w[c.j[n]];
      x[a] += px * wa;
      x[a + 1] += py * wa;
      x[a + 2] += pz * wa;
      x[b] -= px * wb;
      x[b + 1] -= py * wb;
      x[b + 2] -= pz * wb;
    }
  }

  private solveAttachments(h: number): void {
    const { x } = this;
    const w = this.mesh.invMass;
    for (const t of this.attachments) {
      const k = t.index * 3;
      const wi = w[t.index];
      if (wi === 0) continue;
      const f = wi / (wi + t.compliance / (h * h));
      x[k] += (t.x - x[k]) * f;
      x[k + 1] += (t.y - x[k + 1]) * f;
      x[k + 2] += (t.z - x[k + 2]) * f;
    }
  }

  private interpolateColliders(alpha: number): void {
    for (let c = 0; c < this.toCapsules.length; c++) {
      const from = this.fromCapsules[c] ?? this.toCapsules[c];
      const to = this.toCapsules[c];
      const cur = this.current[c];
      Object.assign(this.previous[c], cur);
      cur.ax = from.ax + (to.ax - from.ax) * alpha;
      cur.ay = from.ay + (to.ay - from.ay) * alpha;
      cur.az = from.az + (to.az - from.az) * alpha;
      cur.bx = from.bx + (to.bx - from.bx) * alpha;
      cur.by = from.by + (to.by - from.by) * alpha;
      cur.bz = from.bz + (to.bz - from.bz) * alpha;
      cur.r = from.r + (to.r - from.r) * alpha;
    }
  }

  private solveCollisions(): void {
    const { x, prev } = this;
    const { collisionOffset, friction } = this.params;
    const w = this.mesh.invMass;
    for (let c = 0; c < this.current.length; c++) {
      const cap = this.current[c];
      const old = this.previous[c];
      const abx = cap.bx - cap.ax;
      const aby = cap.by - cap.ay;
      const abz = cap.bz - cap.az;
      const abLen2 = abx * abx + aby * aby + abz * abz || 1e-12;
      const radius = cap.r + collisionOffset;
      for (let i = 0; i < this.n; i++) {
        if (w[i] === 0) continue;
        if (cap.sleeveSide !== undefined && this.mesh.simSleeve[i] !== cap.sleeveSide) continue;
        const k = i * 3;
        const t = Math.max(0, Math.min(1, ((x[k] - cap.ax) * abx + (x[k + 1] - cap.ay) * aby + (x[k + 2] - cap.az) * abz) / abLen2));
        if (cap.minT !== undefined && t < cap.minT) continue;
        const qx = cap.ax + abx * t;
        const qy = cap.ay + aby * t;
        const qz = cap.az + abz * t;
        let nx = x[k] - qx;
        let ny = x[k + 1] - qy;
        let nz = x[k + 2] - qz;
        const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (d >= radius) continue;
        if (d < 1e-7) {
          nx = 0;
          ny = 0;
          nz = 1;
        } else {
          nx /= d;
          ny /= d;
          nz /= d;
        }
        const depth = radius - d;
        x[k] += nx * depth;
        x[k + 1] += ny * depth;
        x[k + 2] += nz * depth;
        // Coulomb-style friction against the collider's surface motion at the contact.
        const sx = qx - (old.ax + (old.bx - old.ax) * t);
        const sy = qy - (old.ay + (old.by - old.ay) * t);
        const sz = qz - (old.az + (old.bz - old.az) * t);
        const rx = x[k] - prev[k] - sx;
        const ry = x[k + 1] - prev[k + 1] - sy;
        const rz = x[k + 2] - prev[k + 2] - sz;
        const rn = rx * nx + ry * ny + rz * nz;
        const tx = rx - rn * nx;
        const ty = ry - rn * ny;
        const tz = rz - rn * nz;
        const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tLen > 1e-10) {
          const f = Math.min(1, (friction * depth) / tLen);
          x[k] -= tx * f;
          x[k + 1] -= ty * f;
          x[k + 2] -= tz * f;
        }
      }
    }
  }

  /** Remove placement strain with zero-compliance iterations, leaving the cloth at rest. */
  settle(iterations: number): void {
    this.interpolateColliders(1);
    for (let it = 0; it < iterations; it++) {
      this.prev.set(this.x);
      this.solveDistance(this.mesh.stretch, 0);
      this.solveAttachments(this.params.fixedDt / this.params.substeps);
      this.solveCollisions();
    }
    this.prev.set(this.x);
    this.v.fill(0);
  }

  isHealthy(): boolean {
    const { x } = this;
    for (let k = 0; k < x.length; k++) {
      if (!Number.isFinite(x[k]) || Math.abs(x[k]) > 100) return false;
    }
    return true;
  }

  /** Recover from a blowup or tracking discontinuity. Optional offset moves the rest shape. */
  reset(offset: [number, number, number] = [0, 0, 0]): void {
    for (let k = 0; k < this.n; k++) {
      const i = k * 3;
      this.x[i] = this.rest[i] + offset[0];
      this.x[i + 1] = this.rest[i + 1] + offset[1];
      this.x[i + 2] = this.rest[i + 2] + offset[2];
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.accumulator = 0;
    this.resets++;
  }

  /** Rigidly translate cloth and history, preserving its shape after a tracking jump. */
  teleport(dx: number, dy: number, dz: number): void {
    for (let k = 0; k < this.n; k++) {
      const i = k * 3;
      this.x[i] += dx;
      this.x[i + 1] += dy;
      this.x[i + 2] += dz;
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.fromCapsules = this.toCapsules;
  }

  maxStrain(): number {
    const { i, j, rest } = this.mesh.stretch;
    const { x } = this;
    let worst = 0;
    for (let n = 0; n < rest.length; n++) {
      const a = i[n] * 3;
      const b = j[n] * 3;
      const len = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]);
      worst = Math.max(worst, Math.abs(len - rest[n]) / rest[n]);
    }
    return worst;
  }
}
