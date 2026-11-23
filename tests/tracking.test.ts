import { describe, expect, it } from 'vitest';
import { ClothSolver } from '../apps/web/src/physics/xpbd';
import { prepareTemplateGarment, TryOnSession } from '../apps/web/src/runtime';
import {
  DEFAULT_PROFILE, LM, bodyCapsules, bodyFrame, fitGarment, fitImage, poseFromWorld, syntheticPose, type BodyPose, type Landmark,
} from '../apps/web/src/tracking/body';
import frontPose from './fixtures/front-pose.json';
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
    const session = new TryOnSession(prepareTemplateGarment('M'), DEFAULT_PROFILE);
    let worst = 0;
    for (let f = 0; f < 60 * 12; f++) {
      session.updatePose(syntheticPose(f / 60));
      session.step(1 / 60);
      worst = Math.max(worst, session.solver.maxStrain());
      expect(session.solver.isHealthy()).toBe(true);
    }
    expect(session.solver.resets).toBe(0);
    expect(session.refits).toBe(1);
    expect(worst).toBeLessThan(0.35);
  });

  it('keeps moving after the pose stops, then settles', () => {
    const session = new TryOnSession(prepareTemplateGarment('M'), DEFAULT_PROFILE);
    for (let f = 0; f < 240; f++) {
      session.updatePose(syntheticPose(f / 60));
      session.step(1 / 60);
    }
    // Median vertex movement across one displayed frame, in millimetres.
    const frameMovement = (s: ClothSolver) => {
      const before = s.x.slice();
      session.step(1 / 60);
      const moves = Array.from({ length: s.n }, (_, v) => Math.hypot(s.x[v * 3] - before[v * 3], s.x[v * 3 + 1] - before[v * 3 + 1], s.x[v * 3 + 2] - before[v * 3 + 2]) * 1000).sort((a, b) => a - b);
      return moves[moves.length >> 1];
    };
    session.updatePose(syntheticPose(240 / 60));
    const early = frameMovement(session.solver);
    for (let f = 0; f < 60 * 8; f++) session.step(1 / 60);
    const late = frameMovement(session.solver);
    expect(early).toBeGreaterThan(0.2);
    expect(late).toBeLessThan(0.02);
  });

  it('refits after a tracking teleport without stretching', () => {
    const session = new TryOnSession(prepareTemplateGarment('M'), DEFAULT_PROFILE);
    session.updatePose(syntheticPose(0));
    for (let f = 0; f < 30; f++) session.step(1 / 60);
    const moved = syntheticPose(0);
    for (const k of Object.keys(moved) as (keyof typeof moved)[]) moved[k] = [moved[k][0] + 1, moved[k][1], moved[k][2]];
    session.updatePose(moved);
    session.step(1 / 60);
    expect(session.refits).toBe(2);
    expect(session.solver.maxStrain()).toBeLessThan(0.35);
  });

  it('drapes on a real tracked front pose without severe stretch', () => {
    const pose = frontPose.pose as BodyPose;
    const garment = prepareTemplateGarment('M');
    const session = new TryOnSession(garment, DEFAULT_PROFILE);
    for (let f = 0; f < 240; f++) {
      session.updatePose(pose);
      session.step(1 / 60);
    }
    const { i, j, rest } = garment.mesh.stretch;
    const x = session.solver.x;
    const strains = Array.from(rest, (r, n) => (Math.hypot(x[i[n] * 3] - x[j[n] * 3], x[i[n] * 3 + 1] - x[j[n] * 3 + 1], x[i[n] * 3 + 2] - x[j[n] * 3 + 2]) - r) / r).sort((a, b) => a - b);
    expect(strains[Math.floor(strains.length * 0.95)]).toBeLessThan(0.1);
    expect(strains[Math.floor(strains.length * 0.99)]).toBeLessThan(0.2);
    expect(strains[strains.length - 1]).toBeLessThan(0.45);
  });

  it('keeps each cuff around its arm through motion', () => {
    const garment = prepareTemplateGarment('M');
    const session = new TryOnSession(garment, DEFAULT_PROFILE);
    for (let f = 0; f < 60 * 12; f++) {
      const pose = syntheticPose(f / 60);
      session.updatePose(pose);
      session.step(1 / 60);
      if (f % 30 !== 0) continue;
      for (const [cuff, shoulder, elbow] of [[garment.mesh.openings.cuff_r, pose.ls, pose.le], [garment.mesh.openings.cuff_l, pose.rs, pose.re]] as const) {
        // The arm is through the cuff exactly when the closed ring winds once around the arm axis.
        const x = session.solver.x;
        const length = Math.hypot(elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]);
        const axis = [(elbow[0] - shoulder[0]) / length, (elbow[1] - shoulder[1]) / length, (elbow[2] - shoulder[2]) / length];
        const seed = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const uRaw = [axis[1] * seed[2] - axis[2] * seed[1], axis[2] * seed[0] - axis[0] * seed[2], axis[0] * seed[1] - axis[1] * seed[0]];
        const uLength = Math.hypot(uRaw[0], uRaw[1], uRaw[2]);
        const u = uRaw.map((c) => c / uLength);
        const w = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
        const angles = Array.from(cuff, (v) => {
          const d = [x[v * 3] - shoulder[0], x[v * 3 + 1] - shoulder[1], x[v * 3 + 2] - shoulder[2]];
          return Math.atan2(d[0] * w[0] + d[1] * w[1] + d[2] * w[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2]);
        });
        let turned = 0;
        angles.forEach((angle, n) => {
          let delta = angles[(n + 1) % angles.length] - angle;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          turned += delta;
        });
        expect(Math.abs(Math.round(turned / (2 * Math.PI))), `frame ${f}`).toBe(1);
      }
    }
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
