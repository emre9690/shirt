import type { GarmentMesh, TShirtParams } from '@shirt/garment-schema';
import type { Attachment, Capsule } from '../physics/xpbd';

/**
 * Scene space: metres, hip-centred, unmirrored camera view.
 * +x = image right (the wearer's LEFT when facing the camera), +y = up, +z = toward camera.
 * Mirroring happens exactly once, in CSS on the whole stage.
 */
export type P3 = [number, number, number];

export const LM = { ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16, lh: 23, rh: 24 } as const;
export type Joint = keyof typeof LM;
export const JOINTS = Object.keys(LM) as Joint[];

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export type BodyPose = Record<Joint, P3>;

export interface BodyProfile {
  heightM: number;
  shoulderM?: number;
  chestM?: number;
  waistM?: number;
}

export const DEFAULT_PROFILE: BodyProfile = { heightM: 1.75 };

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3): P3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const mid = (a: P3, b: P3): P3 => mul(add(a, b), 0.5);
export const dist = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** MediaPipe world landmarks: x image-right, y down, smaller z closer to camera. */
export function poseFromWorld(world: Landmark[]): BodyPose {
  const out = {} as BodyPose;
  for (const j of JOINTS) {
    const l = world[LM[j]];
    out[j] = [l.x, -l.y, -l.z];
  }
  return out;
}

export function trackingConfidence(landmarks: Landmark[]): number {
  const core: Joint[] = ['ls', 'rs', 'lh', 'rh'];
  return Math.min(...core.map((j) => landmarks[LM[j]]?.visibility ?? 0));
}

/**
 * Pose estimates are not metric. Scale them so the shoulder span matches the profile:
 * the entered shoulder width, or an anthropometric estimate from height.
 */
export function profileScale(pose: BodyPose, profile: BodyProfile): number {
  const target = profile.shoulderM ?? profile.heightM * 0.235;
  const measured = dist(pose.ls, pose.rs);
  return measured > 0.05 ? target / measured : 1;
}

export function scalePose(pose: BodyPose, s: number): BodyPose {
  const out = {} as BodyPose;
  for (const j of JOINTS) out[j] = mul(pose[j], s);
  return out;
}

export interface BodyFrame {
  origin: P3;
  x: P3;
  y: P3;
  z: P3;
}

/** Origin at shoulder centre; x toward wearer's left shoulder, y up the spine, z out of the chest. */
export function bodyFrame(p: BodyPose): BodyFrame {
  const origin = mid(p.ls, p.rs);
  const x = norm(sub(p.ls, p.rs));
  const spine = sub(origin, mid(p.lh, p.rh));
  const y = norm(sub(spine, mul(x, dot(spine, x))));
  return { origin, x, y, z: cross(x, y) };
}

const toWorld = (f: BodyFrame, x: number, y: number, z: number): P3 =>
  add(f.origin, add(mul(f.x, x), add(mul(f.y, y), mul(f.z, z))));

const capsule = (a: P3, b: P3, r: number): Capsule => ({ ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], r });

export interface BodyRadii {
  torso: number;
  torsoOffset: number;
  upperArm: number;
  foreArm: number;
}

export function bodyRadii(pose: BodyPose, profile: BodyProfile): BodyRadii {
  const shoulder = dist(pose.ls, pose.rs);
  // A two-capsule torso approximates an ellipse: circumference ~ 4*offset + 2*pi*r.
  const chest = profile.chestM ?? profile.heightM * 0.54;
  const torsoOffset = shoulder * 0.24;
  const torso = Math.max(0.06, (chest - 4 * torsoOffset) / (2 * Math.PI));
  const scale = profile.heightM / 1.75;
  return { torso, torsoOffset, upperArm: 0.048 * scale, foreArm: 0.038 * scale };
}

const SHOULDER_BAR_RATIO = 0.6;

/** Height of the shoulder seam above the shoulder joint centre. */
export function shoulderLift(p: BodyPose, profile: BodyProfile): number {
  // The pose landmark is the joint, only a few centimetres below the top of the shoulder.
  return bodyRadii(p, profile).upperArm * SHOULDER_BAR_RATIO + 0.006;
}

export function bodyCapsules(p: BodyPose, profile: BodyProfile): Capsule[] {
  const f = bodyFrame(p);
  const r = bodyRadii(p, profile);
  const hip = mid(p.lh, p.rh);
  const down = dist(f.origin, hip);
  // The torso's top stays under the shoulder line so the seam settles on the shoulder bar.
  const topY = -r.torso - 0.01;
  const bottomY = -down;
  const shoulderInset = r.upperArm * 0.6;
  const ls = add(p.ls, mul(f.x, -shoulderInset));
  const rs = add(p.rs, mul(f.x, shoulderInset));
  // The wearer's left arm is on +x, which is the garment's `sleeve_r` (simSleeve +1).
  const arm = (a: P3, b: P3, radius: number, sleeveSide: 1 | -1, minT?: number): Capsule => ({ ...capsule(a, b, radius), sleeveSide, minT });
  return [
    { ...capsule(toWorld(f, r.torsoOffset, topY, 0), toWorld(f, r.torsoOffset, bottomY, 0), r.torso), bodyPanelsOnly: true },
    { ...capsule(toWorld(f, -r.torsoOffset, topY, 0), toWorld(f, -r.torsoOffset, bottomY, 0), r.torso), bodyPanelsOnly: true },
    { ...capsule(ls, rs, r.upperArm * SHOULDER_BAR_RATIO), occludes: false },
    { ...arm(ls, p.le, r.upperArm, 1, 0.25), occludes: false },
    arm(p.le, p.lw, r.foreArm, 1),
    { ...arm(rs, p.re, r.upperArm, -1, 0.25), occludes: false },
    arm(p.re, p.rw, r.foreArm, -1),
  ];
}

/**
 * Rigidly carry the rest garment onto the body, rotating each sleeve toward its arm.
 * Dimensions are never scaled to the wearer: a selected size stays that size.
 */
export function fitGarment(rest: Float32Array, garment: TShirtParams, p: BodyPose, out: Float32Array, lift = 0.07, blend?: ArmholeBlend): void {
  const f = bodyFrame(p);
  // The shoulder seam rests on top of the shoulder collider, not through the joint centre.
  const shoulderY = garment.bodyLength - garment.shoulderDrop - lift;
  const cuffX = garment.shoulderWidth / 2 + garment.sleeveLength;
  const sleeveY = lift - garment.armholeDepth / 2;
  const toLocal = (q: P3): P3 => {
    const d = sub(q, f.origin);
    return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
  };
  /**
   * Swing the sleeve about the top of the armhole, where the shoulder seam ends, so that seam
   * keeps its length. The cuff centre lands on the tracked arm at its original distance.
   */
  const swing = (side: number, shoulder: P3, elbow: P3) => {
    const pivot: P3 = [side * garment.shoulderWidth / 2, lift, 0];
    const cuff: P3 = [side * cuffX, sleeveY, 0];
    const reach = dist(pivot, cuff);
    const joint = toLocal(shoulder);
    const arm = norm(sub(toLocal(elbow), joint));
    const offset = sub(joint, pivot);
    const along = dot(offset, arm);
    const tau = -along + Math.sqrt(Math.max(0, along * along - dot(offset, offset) + reach * reach));
    const from = norm(sub(cuff, pivot));
    const to = norm(sub(add(joint, mul(arm, tau)), pivot));
    const axis = cross(from, to);
    const sine = Math.hypot(axis[0], axis[1], axis[2]);
    return { pivot, axis: sine > 1e-6 ? mul(axis, 1 / sine) : ([0, 0, 1] as P3), angle: Math.atan2(sine, dot(from, to)) };
  };
  const swings = { 1: swing(1, p.ls, p.le), [-1]: swing(-1, p.rs, p.re) } as Record<number, ReturnType<typeof swing>>;
  for (let v = 0; v < rest.length / 3; v++) {
    let local: P3 = [rest[v * 3], rest[v * 3 + 1] - shoulderY, rest[v * 3 + 2]];
    const weight = blend?.weight[v] ?? 0;
    if (weight > 0) {
      const { pivot, axis, angle } = swings[blend!.side[v]];
      const d = sub(local, pivot);
      const c = Math.cos(angle * weight);
      const s = Math.sin(angle * weight);
      // Rodrigues rotation, partially applied so the cloth bends smoothly over the shoulder.
      local = add(pivot, add(add(mul(d, c), mul(cross(axis, d), s)), mul(axis, dot(axis, d) * (1 - c))));
    }
    const q = toWorld(f, local[0], local[1], local[2]);
    out[v * 3] = q[0];
    out[v * 3 + 1] = q[1];
    out[v * 3 + 2] = q[2];
  }
}

export interface ArmholeBlend {
  /** 0 on the body, 0.5 at the armhole seam, 1 along the sleeve. */
  weight: Float32Array;
  /** Which shoulder drives this vertex: +1 is the garment's +x side. */
  side: Int8Array;
}

/** Blend weights from each vertex's distance along the cloth to its nearest armhole seam. */
export function armholeBlend(mesh: GarmentMesh, radius = 0.07): ArmholeBlend {
  const n = mesh.positions.length / 3;
  const { i, j, rest } = mesh.stretch;
  const distance = new Float32Array(n).fill(Infinity);
  const side = new Int8Array(n);
  for (let e = 0; e < rest.length; e++) {
    const [a, b] = [i[e], j[e]];
    if (mesh.simSleeve[a] === 0 && mesh.simSleeve[b] !== 0) { distance[a] = 0; side[a] = mesh.simSleeve[b]; }
    if (mesh.simSleeve[b] === 0 && mesh.simSleeve[a] !== 0) { distance[b] = 0; side[b] = mesh.simSleeve[a]; }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (let e = 0; e < rest.length; e++) {
      const [a, b] = [i[e], j[e]];
      if (distance[a] + rest[e] < distance[b] - 1e-6) { distance[b] = distance[a] + rest[e]; side[b] = side[a]; changed = true; }
      if (distance[b] + rest[e] < distance[a] - 1e-6) { distance[a] = distance[b] + rest[e]; side[a] = side[b]; changed = true; }
    }
  }
  const weight = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const t = Math.min(1, distance[v] / radius);
    const smooth = t * t * (3 - 2 * t);
    weight[v] = mesh.simSleeve[v] !== 0 ? 0.5 + 0.5 * smooth : 0.5 - 0.5 * smooth;
    if (side[v] === 0) { side[v] = 1; weight[v] = 0; }
  }
  return { weight, side };
}

/** Sparse, compliant collar support. Everything below the neckband hangs freely. */
export function collarAttachments(rest: Float32Array, neck: Uint32Array, garment: TShirtParams, p: BodyPose, lift = 0.07, compliance = 2e-2): Attachment[] {
  const f = bodyFrame(p);
  const shoulderY = garment.bodyLength - garment.shoulderDrop - lift;
  return Array.from(neck, (index) => {
    const q = toWorld(f, rest[index * 3], rest[index * 3 + 1] - shoulderY, rest[index * 3 + 2]);
    return { index, x: q[0], y: q[1], z: q[2], compliance };
  });
}

export interface ImageFit {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares orthographic fit from scene metres to y-up image pixels,
 * using visible joints. `image` holds normalized MediaPipe landmarks.
 */
export function fitImage(pose: BodyPose, image: Landmark[], width: number, height: number): ImageFit | null {
  const pts: { wx: number; wy: number; ix: number; iy: number }[] = [];
  for (const j of ['ls', 'rs', 'lh', 'rh', 'le', 're'] as Joint[]) {
    const l = image[LM[j]];
    if ((l.visibility ?? 1) < 0.5) continue;
    pts.push({ wx: pose[j][0], wy: pose[j][1], ix: l.x * width, iy: (1 - l.y) * height });
  }
  if (pts.length < 3) return null;
  const c = pts.reduce((a, q) => ({ wx: a.wx + q.wx / pts.length, wy: a.wy + q.wy / pts.length, ix: a.ix + q.ix / pts.length, iy: a.iy + q.iy / pts.length }), { wx: 0, wy: 0, ix: 0, iy: 0 });
  let num = 0;
  let den = 0;
  for (const q of pts) {
    num += (q.wx - c.wx) * (q.ix - c.ix) + (q.wy - c.wy) * (q.iy - c.iy);
    den += (q.wx - c.wx) ** 2 + (q.wy - c.wy) ** 2;
  }
  if (den < 1e-6 || num <= 0) return null;
  const scale = num / den;
  return { scale, tx: c.ix - scale * c.wx, ty: c.iy - scale * c.wy };
}

/** Repeatable synthetic motion for testing physics and rendering without a person. */
export function syntheticPose(t: number): BodyPose {
  const yaw = 0.45 * Math.sin(t * 0.8);
  const raise = Math.max(0, Math.sin(t * 0.5 - 1)) * 1.9;
  const rot = ([x, y, z]: P3): P3 => [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  const arm = (side: number, lift: number): [P3, P3] => {
    const a = 0.3 + lift;
    const dir: P3 = [side * Math.sin(a), -Math.cos(a), 0.05];
    const sx = side * 0.205;
    return [[sx + dir[0] * 0.29, 0.5 + dir[1] * 0.29, dir[2] * 0.29], [sx + dir[0] * 0.55, 0.5 + dir[1] * 0.55, dir[2] * 0.55]];
  };
  const [le, lw] = arm(1, raise);
  const [re, rw] = arm(-1, 0);
  return {
    ls: rot([0.205, 0.5, 0]),
    rs: rot([-0.205, 0.5, 0]),
    le: rot(le),
    lw: rot(lw),
    re: rot(re),
    rw: rot(rw),
    lh: rot([0.1, 0, 0]),
    rh: rot([-0.1, 0, 0]),
  };
}
