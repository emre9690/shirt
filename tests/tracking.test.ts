import { describe, expect, it } from 'vitest';
import { ClothSolver } from '../apps/web/src/physics/xpbd';
import { prepareTemplateGarment, TryOnSession } from '../apps/web/src/runtime';
import {
  DEFAULT_PROFILE, LM, bodyCapsules, bodyFrame, fitGarment, fitImage, poseFromWorld, syntheticPose, type Landmark,
} from '../apps/web/src/tracking/body';
import { OneEuroVector } from '../apps/web/src/tracking/oneEuro';

function worldLandmarks(): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  out[LM.ls] = { x: 0.2, y: -0.5, z: 0, visibility: 1 };
  out[LM.rs] = { x: -0.2, y: -0.5, z: 0, visibility: 1 };
  out[LM.le] = { x: 0.3, y: -0.25, z: 0, visibility: 1 };
  out[LM.re] = { x: -0.3, y: -0.25, z: 0, visibility: 1 };
  out[LM.lw] = { x: 0.35, y: 0, z: -0.1, visibility: 1 };
  out[LM.rw] = { x: -0.35, y: 0, z: 0, visibility: 1 };
  out[LM.lh] = { x: 0.1, y: 0, z: 0, visibility: 1 };
  out[LM.rh] = { x: -0.1, y: 0, z: 0, visibility: 1 };
  return out;
}

describe('coordinates', () => {
  it('converts MediaPipe axes without swapping anatomical sides', () => {
    const p = poseFromWorld(worldLandmarks());
    expect(p.ls[0]).toBeGreaterThan(p.rs[0]);
    expect(p.ls[1]).toBeGreaterThan(p.lh[1]);
    expect(p.lw[2]).toBeCloseTo(0.1);
  });

  it('builds a right-handed frame with the chest toward the camera', () => {
    const f = bodyFrame(poseFromWorld(worldLandmarks()));
    expect(f.x[0]).toBeCloseTo(1);
    expect(f.y[1]).toBeCloseTo(1);
    expect(f.z[2]).toBeCloseTo(1);
  });

  it('recovers an image fit', () => {
    const world = worldLandmarks();
    const pose = poseFromWorld(world);
    const [w, h, s, tx, ty] = [1280, 720, 600, 640, 200];
    const image = world.map((l, i) => {
      const j = Object.values(LM).indexOf(i as never);
      if (j < 0) return { x: 0, y: 0, z: 0, visibility: 0 };
      return { x: (l.x * s + tx) / w, y: 1 - (-l.y * s + ty) / h, z: 0, visibility: 1 };
    });
    const fit = fitImage(pose, image, w, h)!;
    expect(fit.scale).toBeCloseTo(s, 3);
    expect(fit.tx).toBeCloseTo(tx, 3);
    expect(fit.ty).toBeCloseTo(ty, 3);
  });
});

describe('filter', () => {
  it('reduces jitter and follows a step', () => {
    const f = new OneEuroVector(1);
    let out = 0;
    for (let i = 0; i < 120; i++) out = f.filter([1 + (i % 2 ? 0.01 : -0.01)], i / 30)[0];
    expect(Math.abs(out - 1)).toBeLessThan(0.01);
    for (let i = 120; i < 150; i++) out = f.filter([2], i / 30)[0];
    expect(out).toBeGreaterThan(1.95);
  });
});

describe('garment on a moving body', () => {
  it('fitting never changes garment rest dimensions', () => {
    const small = prepareTemplateGarment('S', 0.04);
    const large = prepareTemplateGarment('XL', 0.04);
    const rest = small.mesh.stretch.rest.slice();
    const session = new TryOnSession(small, { heightM: 2.0 });
    session.refit(syntheticPose(0));
    expect(Array.from(small.mesh.stretch.rest)).toEqual(Array.from(rest));
    // Flat material area is the size-defining quantity; a drape's silhouette is not.
    const area = (r: Float32Array) => {
      let total = 0;
      for (let t = 0; t < r.length; t += 6) total += Math.abs((r[t + 2] - r[t]) * (r[t + 5] - r[t + 1]) - (r[t + 3] - r[t + 1]) * (r[t + 4] - r[t])) / 2;
      return total;
    };
    expect(area(large.mesh.triRest) / area(small.mesh.triRest)).toBeGreaterThan(1.2);
  });

  it('stays finite, bounded and unstretched through synthetic motion', () => {
    const session = new TryOnSession(prepareTemplateGarment('M', 0.04), DEFAULT_PROFILE);
    let worst = 0;
    for (let f = 0; f < 60 * 12; f++) {
      session.updatePose(syntheticPose(f / 60));
      session.step(1 / 60);
      worst = Math.max(worst, session.solver.maxStrain());
      expect(session.solver.isHealthy()).toBe(true);
    }
    expect(session.solver.resets).toBe(0);
    expect(session.refits).toBe(1);
    expect(worst).toBeLessThan(0.6);
  });

  it('keeps moving after the pose stops, then settles', () => {
    const session = new TryOnSession(prepareTemplateGarment('M', 0.04), DEFAULT_PROFILE);
    for (let f = 0; f < 240; f++) {
      session.updatePose(syntheticPose(f / 60));
      session.step(1 / 60);
    }
    const speed = (s: ClothSolver) => {
      let max = 0;
      for (let k = 0; k < s.n; k++) max = Math.max(max, Math.hypot(s.v[k * 3], s.v[k * 3 + 1], s.v[k * 3 + 2]));
      return max;
    };
    const held = syntheticPose(240 / 60);
    session.updatePose(held);
    session.step(1 / 60);
    const early = speed(session.solver);
    for (let f = 0; f < 60 * 6; f++) session.step(1 / 60);
    const late = speed(session.solver);
    expect(early).toBeGreaterThan(0.005);
    expect(late).toBeLessThan(early);
  });

  it('refits after a tracking teleport without stretching', () => {
    const session = new TryOnSession(prepareTemplateGarment('M', 0.04), DEFAULT_PROFILE);
    session.updatePose(syntheticPose(0));
    for (let f = 0; f < 30; f++) session.step(1 / 60);
    const moved = syntheticPose(0);
    for (const k of Object.keys(moved) as (keyof typeof moved)[]) moved[k] = [moved[k][0] + 1, moved[k][1], moved[k][2]];
    session.updatePose(moved);
    session.step(1 / 60);
    expect(session.refits).toBe(2);
    expect(session.solver.maxStrain()).toBeLessThan(0.6);
  });

  it('fitGarment places the collar above the shoulder line', () => {
    const g = prepareTemplateGarment('M', 0.04);
    const out = new Float32Array(g.mesh.positions.length);
    const pose = syntheticPose(0);
    fitGarment(g.mesh.positions, g.params, pose, out);
    const neck = Array.from(g.mesh.openings.neck);
    const avgY = neck.reduce((sum, v) => sum + out[v * 3 + 1], 0) / neck.length;
    expect(avgY).toBeGreaterThan(pose.ls[1]);
    expect(bodyCapsules(pose, DEFAULT_PROFILE)).toHaveLength(7);
  });
});
