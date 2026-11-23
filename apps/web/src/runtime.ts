import { assembleGarment, buildTShirtPattern, paramsForSize, tShirtPlacement, validateMesh, validatePattern, type GarmentMesh, type ShirtSize, type TShirtParams } from '@shirt/garment-schema';
import { ClothSolver, ESTIMATED_JERSEY, type Capsule } from './physics/xpbd';
import { armholeBlend, bodyCapsules, bodyFrame, bodyRadii, collarAttachments, dist, fitGarment, JOINTS, shoulderLift, type ArmholeBlend, type BodyPose, type BodyProfile, type P3 } from './tracking/body';

const SETTLE_ITERATIONS = 80;
const SLEEVE_ROOT_WEIGHT = 0.95;

export interface PreparedGarment {
  size: ShirtSize;
  params: TShirtParams;
  mesh: GarmentMesh;
}

const cache = new Map<string, PreparedGarment>();

export function prepareTemplateGarment(size: ShirtSize, spacing = 0.025): PreparedGarment {
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
  private readonly blend: ArmholeBlend;
  private readonly supportVertices: Uint32Array;
  capsules: Capsule[] = [];
  private lastPose: BodyPose | null = null;
  refits = 0;

  constructor(readonly garment: PreparedGarment, public profile: BodyProfile) {
    this.solver = new ClothSolver(garment.mesh, ESTIMATED_JERSEY);
    this.blend = armholeBlend(garment.mesh);
    this.supportVertices = garment.mesh.openings.neck;
    this.solver.planeSide = Int8Array.from(this.blend.weight, (w, v) =>
      garment.mesh.simSleeve[v] !== 0 && w < SLEEVE_ROOT_WEIGHT ? this.blend.side[v] : 0);
    // The armhole seam sits inside the arm collider at the shoulder. If the sleeve root also
    // collided with the arm, the seam and its neighbours would be forced apart.
    this.solver.armSide = Int8Array.from(this.blend.weight, (w, v) => (w >= SLEEVE_ROOT_WEIGHT ? garment.mesh.simSleeve[v] : 0));
  }

  /** A flat limit beside the ribs. Unlike a capsule, it cannot push cloth out the wrong side. */
  private updateArmpitPlanes(pose: BodyPose): void {
    const frame = bodyFrame(pose);
    const radii = bodyRadii(pose, this.profile);
    this.solver.cuffFront = frame.z;
    const half = radii.torsoOffset + radii.torso + this.solver.params.collisionOffset;
    const offset = frame.origin[0] * frame.x[0] + frame.origin[1] * frame.x[1] + frame.origin[2] * frame.x[2];
    const across = (q: P3) => q[0] * frame.x[0] + q[1] * frame.x[1] + q[2] * frame.x[2] - offset;
    // The limit always stays inside the arm's inner edge, or the sleeve wall would be pinched
    // between them. Arms held close or crossing the body move the limit inward.
    const clearance = radii.upperArm + 2 * this.solver.params.collisionOffset;
    const limitL = Math.min(half, across(pose.ls) - clearance, across(pose.le) - clearance);
    const limitR = Math.min(half, -across(pose.rs) - clearance, -across(pose.re) - clearance);
    this.solver.sidePlanes = {
      1: { nx: frame.x[0], ny: frame.x[1], nz: frame.x[2], d: offset + limitL },
      [-1]: { nx: -frame.x[0], ny: -frame.x[1], nz: -frame.x[2], d: -offset + limitR },
    };
  }

  /** Place the garment on the body and clear all motion. */
  refit(pose: BodyPose): void {
    const { solver, garment } = this;
    const lift = shoulderLift(pose, this.profile);
    // Each sleeve is laid along its tracked arm, so the arm starts inside the sleeve.
    fitGarment(garment.mesh.positions, garment.params, pose, solver.x, lift, this.blend);
    solver.prev.set(solver.x);
    solver.v.fill(0);
    solver.attachments = collarAttachments(garment.mesh.positions, this.supportVertices, garment.params, pose, lift);
    this.capsules = bodyCapsules(pose, this.profile);
    solver.setColliders(this.capsules);
    solver.setColliders(this.capsules);
    this.updateArmpitPlanes(pose);
    solver.settle(SETTLE_ITERATIONS);
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
    this.updateArmpitPlanes(pose);
    this.solver.attachments = collarAttachments(this.garment.mesh.positions, this.supportVertices, this.garment.params, pose, shoulderLift(pose, this.profile));
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
