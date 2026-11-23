import { describe, expect, it } from 'vitest';
import {
  HM_PUBLISHED_SIZES_CM,
  assembleGarment,
  buildTShirtPattern,
  paramsForSize,
  polylineLength,
  tShirtPlacement,
  validateMesh,
  validatePattern,
  type ShirtSize,
} from '@shirt/garment-schema';

const sizes = Object.keys(HM_PUBLISHED_SIZES_CM) as ShirtSize[];

describe('T-shirt pattern', () => {
  it.each(sizes)('%s pattern is valid', (size) => {
    const report = validatePattern(buildTShirtPattern(paramsForSize(size)));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it.each(sizes)('%s keeps published dimensions', (size) => {
    const params = paramsForSize(size);
    const front = buildTShirtPattern(params).panels.find((p) => p.id === 'front')!;
    const hem = front.edges.find((e) => e.id === 'hem')!;
    expect(polylineLength(hem.points)).toBeCloseTo(HM_PUBLISHED_SIZES_CM[size].width / 200, 6);
    expect(params.bodyLength).toBeCloseTo(HM_PUBLISHED_SIZES_CM[size].length / 100, 6);
  });
});

describe('assembled mesh', () => {
  it.each(sizes)('%s is manifold with only true openings', (size) => {
    const params = paramsForSize(size);
    const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.03 });
    const report = validateMesh(mesh);
    expect(report.errors).toEqual([]);
    expect(Object.keys(mesh.openings).sort()).toEqual(['cuff_l', 'cuff_r', 'hem', 'neck']);
    expect(mesh.seamVertexCount).toBeGreaterThan(0);
  });

  it('keeps flat rest lengths independent of placement', () => {
    const params = paramsForSize('M');
    const pattern = buildTShirtPattern(params);
    const a = assembleGarment(pattern, tShirtPlacement(params), { spacing: 0.03 });
    const b = assembleGarment(pattern, (_, [x, y]) => [x * 3, y * 3, 1], { spacing: 0.03 });
    // Constraint order can follow triangle winding, so compare each edge by its vertex pair.
    const byEdge = (m: typeof a) => new Map(Array.from(m.stretch.rest, (r, n) => [`${m.stretch.i[n]}-${m.stretch.j[n]}`, r]));
    const [restA, restB] = [byEdge(a), byEdge(b)];
    expect(restB.size).toBe(restA.size);
    for (const [edge, r] of restA) expect(restB.get(edge), edge).toBeCloseTo(r, 6);
  });

  it.each(sizes)('%s places every sewn edge pair together before relaxation', (size) => {
    const params = paramsForSize(size);
    const pattern = buildTShirtPattern(params);
    const place = tShirtPlacement(params);
    const points = (panel: string, edge: string) => pattern.panels.find((p) => p.id === panel)!.edges.find((e) => e.id === edge)!.points;
    for (const s of pattern.seams) {
      const a = points(s.a.panel, s.a.edge);
      const b = points(s.b.panel, s.b.edge);
      const pairs = [[a[0], s.reversed ? b[b.length - 1] : b[0]], [a[a.length - 1], s.reversed ? b[0] : b[b.length - 1]]];
      for (const [pa, pb] of pairs) {
        const qa = place(s.a.panel, pa);
        const qb = place(s.b.panel, pb);
        expect(Math.hypot(qa[0] - qb[0], qa[1] - qb[1], qa[2] - qb[2]), `${s.a.panel}/${s.a.edge}`).toBeLessThan(0.012);
      }
    }
  });

  it.each(sizes)('%s cuff circumference clears an adult forearm and upper arm', (size) => {
    const pattern = buildTShirtPattern(paramsForSize(size));
    for (const id of ['sleeve_r', 'sleeve_l']) {
      const cuff = pattern.panels.find((p) => p.id === id)!.edges.find((e) => e.id === 'cuff')!;
      expect(polylineLength(cuff.points)).toBeGreaterThan(2 * Math.PI * 0.054);
    }
  });

  it('relaxes the canonical assembly close to its flat rest lengths', () => {
    const params = paramsForSize('M');
    const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.03 });
    const { i, j, rest } = mesh.stretch;
    const x = mesh.positions;
    const strains = Array.from(rest, (r, n) => Math.abs(Math.hypot(x[i[n] * 3] - x[j[n] * 3], x[i[n] * 3 + 1] - x[j[n] * 3 + 1], x[i[n] * 3 + 2] - x[j[n] * 3 + 2]) - r) / r).sort((p, q) => p - q);
    expect(strains[Math.floor(strains.length * 0.95)]).toBeLessThan(0.08);
  });

  it.each(sizes)('%s has one consistent outward surface across all seams', (size) => {
    const params = paramsForSize(size);
    const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.03 });
    const directed = new Set<string>();
    const t = mesh.triangles;
    for (let k = 0; k < t.length; k += 3) {
      for (let n = 0; n < 3; n++) {
        const id = `${t[k + n]}>${t[k + ((n + 1) % 3)]}`;
        expect(directed.has(id), `edge ${id} runs the same way in two triangles`).toBe(false);
        directed.add(id);
      }
    }
    let frontFacing = 0;
    let frontTotal = 0;
    const x = mesh.positions;
    for (let k = 0; k < t.length; k += 3) {
      const [a, b, c] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3];
      if (Math.abs(x[a]) > 0.1 || x[a + 1] > 0.4 || x[a + 2] < 0.05) continue;
      frontTotal++;
      if ((x[b] - x[a]) * (x[c + 1] - x[a + 1]) - (x[b + 1] - x[a + 1]) * (x[c] - x[a]) > 0) frontFacing++;
    }
    expect(frontTotal).toBeGreaterThan(0);
    expect(frontFacing / frontTotal).toBeGreaterThan(0.95);
  });

  it('places the neckband as an open ring around the neck', () => {
    const params = paramsForSize('M');
    const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.03 });
    const neck = Array.from(mesh.openings.neck);
    const xs = neck.map((v) => mesh.positions[v * 3]);
    const zs = neck.map((v) => mesh.positions[v * 3 + 2]);
    expect(new Set(neck.map((v) => `${mesh.positions[v * 3].toFixed(3)},${mesh.positions[v * 3 + 2].toFixed(3)}`)).size).toBe(neck.length);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(params.neckWidth * 0.7);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(params.neckWidth * 0.5);
  });

  it('maps every render vertex to a simulation vertex', () => {
    const params = paramsForSize('M');
    const mesh = assembleGarment(buildTShirtPattern(params), tShirtPlacement(params), { spacing: 0.03 });
    const simCount = mesh.positions.length / 3;
    expect(mesh.renderToSim.length).toBeGreaterThan(simCount);
    expect(new Set(mesh.renderToSim).size).toBe(simCount);
  });
});
