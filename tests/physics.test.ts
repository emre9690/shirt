import { describe, expect, it } from 'vitest';
import { assembleGarment, buildTShirtPattern, paramsForSize, tShirtPlacement, type GarmentMesh } from '@shirt/garment-schema';
import { ClothSolver, ESTIMATED_JERSEY, type Capsule } from '../apps/web/src/physics/xpbd';

function shirt(): GarmentMesh {
  const params = paramsForSize('M');
  return assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.04 });
}

function strip(count: number, spacing: number): GarmentMesh {
  const positions = new Float32Array(count * 3);
  const invMass = new Float32Array(count).fill(100);
  invMass[0] = 0;
  const i = new Uint32Array(count - 1);
  const j = new Uint32Array(count - 1);
  const rest = new Float32Array(count - 1).fill(spacing);
  for (let n = 0; n < count; n++) positions[n * 3] = n * spacing;
  for (let n = 0; n < count - 1; n++) {
    i[n] = n;
    j[n] = n + 1;
  }
  return {
    positions,
    invMass,
    triangles: new Uint32Array(),
    triRest: new Float32Array(),
    stretch: { i, j, rest },
    bend: { i: new Uint32Array(), j: new Uint32Array(), rest: new Float32Array() },
    renderToSim: new Uint32Array(),
    renderUv: new Float32Array(),
    renderTriangles: new Uint32Array(),
    renderPanel: new Uint8Array(),
    simSleeve: new Int8Array(count),
    openings: {},
    seamVertexCount: 0,
    arealDensity: 0.16,
  };
}

const run = (s: ClothSolver, seconds: number, fps: number) => {
  const frames = Math.round(seconds * fps);
  for (let f = 0; f < frames; f++) s.advance(1 / fps);
};

describe('XPBD solver', () => {
  it('free fall matches gravity within damping tolerance', () => {
    const mesh = strip(2, 0.1);
    mesh.invMass[0] = 100;
    const s = new ClothSolver(mesh, { ...ESTIMATED_JERSEY, damping: 0 });
    run(s, 0.5, 60);
    expect(s.x[1]).toBeCloseTo(-0.5 * 9.81 * 0.25, 1);
  });

  it('is independent of render rate', () => {
    const a = new ClothSolver(strip(12, 0.05));
    const b = new ClothSolver(strip(12, 0.05));
    run(a, 1, 60);
    for (let f = 0; f < 120; f++) b.advance(1 / 120);
    for (let k = 0; k < a.x.length; k++) expect(b.x[k]).toBeCloseTo(a.x[k], 2);
  });

  it('holds stretch under gravity', () => {
    const s = new ClothSolver(strip(12, 0.05));
    run(s, 3, 60);
    expect(s.maxStrain()).toBeLessThan(0.05);
  });

  it('stays outside a static capsule', () => {
    const mesh = strip(2, 0.02);
    mesh.invMass[0] = 100;
    mesh.positions.set([0, 0.3, 0, 0.02, 0.3, 0]);
    const s = new ClothSolver(mesh);
    const cap: Capsule = { ax: -0.5, ay: 0, az: 0, bx: 0.5, by: 0, bz: 0, r: 0.1 };
    s.setColliders([cap]);
    run(s, 2, 60);
    expect(s.x[1]).toBeGreaterThanOrEqual(0.1);
  });

  it('is pushed by a moving capsule', () => {
    const mesh = strip(2, 0.02);
    mesh.invMass[0] = 100;
    mesh.positions.set([0, 0.11, 0, 0.02, 0.11, 0]);
    const s = new ClothSolver(mesh, { ...ESTIMATED_JERSEY, gravity: 0 });
    for (let f = 0; f < 60; f++) {
      const y = (f / 60) * 0.5;
      s.setColliders([{ ax: -0.5, ay: y, az: 0, bx: 0.5, by: y, bz: 0, r: 0.1 }]);
      s.advance(1 / 60);
    }
    expect(s.x[1]).toBeGreaterThan(0.5);
  });

  it('spreads collider motion across multiple fixed steps in one frame', () => {
    const mesh = strip(2, 0.02);
    mesh.invMass[0] = 100;
    mesh.positions.set([0, 0.11, 0, 0.02, 0.11, 0]);
    const s = new ClothSolver(mesh, { ...ESTIMATED_JERSEY, gravity: 0, damping: 0 });
    s.setColliders([{ ax: -0.5, ay: 0, az: 0, bx: 0.5, by: 0, bz: 0, r: 0.1 }]);
    s.advance(1 / 60);
    s.setColliders([{ ax: -0.5, ay: 0.06, az: 0, bx: 0.5, by: 0.06, bz: 0, r: 0.1 }]);
    expect(s.advance(3 / 60)).toBe(3);
    expect(s.x[1]).toBeGreaterThanOrEqual(0.16);
    expect(s.x[1]).toBeLessThan(0.3);
  });

  it('recovers from non-finite state', () => {
    const s = new ClothSolver(shirt());
    s.x[10] = Number.NaN;
    s.advance(1 / 60);
    expect(s.isHealthy()).toBe(true);
    expect(s.resets).toBe(1);
  });

  it('teleport preserves cloth shape', () => {
    const s = new ClothSolver(shirt());
    run(s, 0.2, 60);
    const strain = s.maxStrain();
    s.teleport(2, 0, -1);
    expect(s.maxStrain()).toBeCloseTo(strain, 2);
    expect(Array.from(s.v).every((v) => v === 0)).toBe(true);
  });

  it('full shirt stays finite on a torso for 5 seconds', () => {
    const s = new ClothSolver(shirt());
    s.setColliders([{ ax: 0, ay: 0, az: 0, bx: 0, by: 0.55, bz: 0, r: 0.14 }]);
    run(s, 5, 60);
    expect(s.isHealthy()).toBe(true);
    expect(s.resets).toBe(0);
  });
});
