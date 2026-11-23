import { assembleGarment, buildTShirtPattern, paramsForSize, tShirtPlacement, validateMesh, validatePattern, type GarmentMesh, type ShirtSize, type TShirtParams } from '@shirt/garment-schema';
import { ClothSolver, ESTIMATED_JERSEY, type Capsule } from './physics/xpbd';
import { bodyCapsules, collarAttachments, dist, fitGarment, JOINTS, lerpPose, openArmPose, shoulderLift, type BodyPose, type BodyProfile } from './tracking/body';

const DRESSING_STEPS = 60;
const DRESSING_DAMPING = 12;

export interface PreparedGarment {
  size: ShirtSize;
  params: TShirtParams;
  mesh: GarmentMesh;
}

const cache = new Map<string, PreparedGarment>();

export function prepareTemplateGarment(size: ShirtSize, spacing = 0.03): PreparedGarment {
  const id = `${size}:${spacing}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const params = paramsForSize(size);
  const pattern = buildTShirtPattern(params);
  const patternReport = validatePattern(pattern);
  if (!patternReport.ok) throw new Error(`Invalid pattern: ${patternReport.errors.join('; ')}`);
  const mesh = assembleGarment(pattern, tShirtPlacement(params), { spacing });
  const meshReport = validateMesh(mesh);
  if (!meshReport.ok) throw new Error(`Invalid mesh: ${meshReport.errors.join('; ')}`);
  const prepared = { size, params, mesh };
  cache.set(id, prepared);
  return prepared;
}

/** A joint moving this far between pose updates is treated as a tracking discontinuity. */
export const JUMP_THRESHOLD_M = 0.35;

export class TryOnSession {
  readonly solver: ClothSolver;
  capsules: Capsule[] = [];
  private lastPose: BodyPose | null = null;
  refits = 0;

  constructor(readonly garment: PreparedGarment, public profile: BodyProfile) {
    this.solver = new ClothSolver(garment.mesh, ESTIMATED_JERSEY);
  }

  /** Place the garment on the body and clear all motion. */
  refit(pose: BodyPose): void {
    const { solver, garment } = this;
    const lift = shoulderLift(pose, this.profile);
    // Dress the body the way a person does: arms start inside the open sleeves,
    // then move to the tracked pose while the cloth simulates around them.
    const open = openArmPose(pose, garment.params, lift);
    fitGarment(garment.mesh.positions, garment.params, open, solver.x, lift);
    solver.prev.set(solver.x);
    solver.v.fill(0);
    solver.attachments = collarAttachments(garment.mesh.positions, garment.mesh.openings.neck, garment.params, pose, lift);
    const start = bodyCapsules(open, this.profile);
    solver.setColliders(start);
    solver.setColliders(start);
    const damping = solver.params.damping;
    solver.params.damping = DRESSING_DAMPING;
    for (let k = 1; k <= DRESSING_STEPS; k++) {
      solver.setColliders(bodyCapsules(lerpPose(open, pose, k / DRESSING_STEPS), this.profile));
      solver.advance(solver.params.fixedDt);
    }
    solver.params.damping = damping;
    solver.v.fill(0);
    solver.prev.set(solver.x);
    this.capsules = bodyCapsules(pose, this.profile);
    solver.setColliders(this.capsules);
    this.lastPose = pose;
    this.refits++;
  }

  updatePose(pose: BodyPose): void {
    if (!this.lastPose || JOINTS.some((j) => dist(pose[j], this.lastPose![j]) > JUMP_THRESHOLD_M)) {
      this.refit(pose);
      return;
    }
    this.capsules = bodyCapsules(pose, this.profile);
    this.solver.setColliders(this.capsules);
    this.solver.attachments = collarAttachments(this.garment.mesh.positions, this.garment.mesh.openings.neck, this.garment.params, pose, shoulderLift(pose, this.profile));
    this.lastPose = pose;
  }

  /** Forget the last pose so the next tracked pose re-places the shirt coherently. */
  markTrackingLost(): void {
    this.lastPose = null;
  }

  step(dt: number): number {
    const steps = this.solver.advance(dt);
    if (!this.solver.isHealthy() && this.lastPose) this.refit(this.lastPose);
    return steps;
  }
}

export class StageTimer {
  private samples: number[] = [];
  constructor(private cap = 240) {}
  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.cap) this.samples.shift();
  }
  percentile(p: number): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }
}
