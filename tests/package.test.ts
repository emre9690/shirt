import { describe, expect, it } from 'vitest';
import { assembleGarment, buildGlb, buildTShirtPattern, deserializeMesh, paramsForSize, serializeMesh, tShirtPlacement, validateMesh } from '@shirt/garment-schema';
import { ClothSolver } from '../apps/web/src/physics/xpbd';

const params = paramsForSize('L');
const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.04 });

describe('runtime garment package', () => {
  it('round-trips every array exactly through JSON', () => {
    const restored = deserializeMesh(JSON.parse(JSON.stringify(serializeMesh(mesh, params))));
    expect(restored.params).toEqual(params);
    for (const key of ['positions', 'invMass', 'triangles', 'triRest', 'renderToSim', 'renderUv', 'renderTriangles', 'renderPanel', 'simSleeve'] as const) {
      expect(Array.from(restored.mesh[key] as ArrayLike<number>), key).toEqual(Array.from(mesh[key] as ArrayLike<number>));
    }
    expect(Array.from(restored.mesh.stretch.rest)).toEqual(Array.from(mesh.stretch.rest));
    expect(Array.from(restored.mesh.bend.rest)).toEqual(Array.from(mesh.bend.rest));
    expect(Array.from(restored.mesh.openings.neck)).toEqual(Array.from(mesh.openings.neck));
    expect(validateMesh(restored.mesh).errors).toEqual([]);
  });

  it('simulates identically after loading', () => {
    const restored = deserializeMesh(JSON.parse(JSON.stringify(serializeMesh(mesh, params))));
    const a = new ClothSolver(mesh);
    const b = new ClothSolver(restored.mesh);
    for (let f = 0; f < 30; f++) {
      a.advance(1 / 60);
      b.advance(1 / 60);
    }
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
  });

  it('rejects an unknown format', () => {
    expect(() => deserializeMesh({ ...serializeMesh(mesh, params), format: 99 })).toThrow(/format/);
  });

  it('writes a structurally valid GLB', () => {
    const glb = buildGlb(mesh);
    const view = new DataView(glb.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    expect(json.accessors[0].count).toBe(mesh.renderToSim.length);
    expect(json.accessors[2].count).toBe(mesh.renderTriangles.length);
    const binLength = view.getUint32(20 + jsonLength, true);
    expect(binLength).toBeGreaterThanOrEqual(json.buffers[0].byteLength);
    expect(view.getUint32(24 + jsonLength, true)).toBe(0x004e4942);
  });
});
