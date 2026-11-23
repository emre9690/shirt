import type { GarmentMesh, GarmentPattern } from './types';

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const CLOSE_EPS = 1e-6;

export function validatePattern(pattern: GarmentPattern): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (pattern.units !== 'm') errors.push(`Unsupported units: ${pattern.units}`);
  const known = new Set<string>();
  for (const panel of pattern.panels) {
    panel.edges.forEach((e, n) => {
      known.add(`${panel.id}/${e.id}`);
      if (e.points.length < 2) errors.push(`${panel.id}/${e.id}: fewer than 2 points`);
      if (e.points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) errors.push(`${panel.id}/${e.id}: non-finite point`);
      const next = panel.edges[(n + 1) % panel.edges.length];
      const end = e.points[e.points.length - 1];
      const start = next.points[0];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) > CLOSE_EPS) errors.push(`${panel.id}: gap between ${e.id} and ${next.id}`);
    });
  }
  const used = new Set<string>();
  for (const s of pattern.seams) {
    for (const r of [s.a, s.b]) {
      const k = `${r.panel}/${r.edge}`;
      if (!known.has(k)) errors.push(`Seam references unknown edge ${k}`);
      if (used.has(k)) errors.push(`Edge sewn twice: ${k}`);
      used.add(k);
    }
  }
  for (const o of pattern.openings) {
    for (const r of o.edges) {
      const k = `${r.panel}/${r.edge}`;
      if (!known.has(k)) errors.push(`Opening ${o.id} references unknown edge ${k}`);
      if (used.has(k)) errors.push(`Opening ${o.id} edge is also sewn: ${k}`);
      used.add(k);
    }
  }
  for (const k of known) if (!used.has(k)) warnings.push(`Edge is neither sewn nor an opening: ${k}`);
  if (!pattern.panels.some((p) => p.id === 'neckband')) warnings.push('No neckband panel');
  return { ok: errors.length === 0, errors, warnings };
}

export function validateMesh(mesh: GarmentMesh): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const vertexCount = mesh.positions.length / 3;
  if (mesh.positions.some((v) => !Number.isFinite(v))) errors.push('Non-finite vertex position');
  if (mesh.triangles.some((v) => v >= vertexCount)) errors.push('Triangle index out of range');
  if (mesh.renderToSim.some((v) => v >= vertexCount)) errors.push('Render mapping out of range');
  if (mesh.stretch.rest.some((r) => !(r > 0))) errors.push('Non-positive stretch rest length');

  const edgeUse = new Map<number, number>();
  const tris = mesh.triangles;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    if (a === b || b === c || a === c) errors.push(`Degenerate welded triangle ${t / 3}`);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const id = Math.min(u, v) * vertexCount + Math.max(u, v);
      edgeUse.set(id, (edgeUse.get(id) ?? 0) + 1);
    }
  }
  let nonManifold = 0;
  const boundary = new Set<number>();
  for (const [id, n] of edgeUse) {
    if (n > 2) nonManifold++;
    if (n === 1) {
      boundary.add(Math.floor(id / vertexCount));
      boundary.add(id % vertexCount);
    }
  }
  if (nonManifold > 0) errors.push(`${nonManifold} non-manifold edges`);

  const openingVerts = new Set<number>();
  for (const [id, verts] of Object.entries(mesh.openings)) {
    if (verts.length < 3) errors.push(`Opening ${id} has too few vertices`);
    for (const v of verts) openingVerts.add(v);
  }
  let strayBoundary = 0;
  for (const v of boundary) if (!openingVerts.has(v)) strayBoundary++;
  if (strayBoundary > 0) errors.push(`${strayBoundary} boundary vertices are not on a garment opening (unsewn gap)`);
  for (const v of openingVerts) if (!boundary.has(v)) errors.push(`Opening vertex ${v} is not on the mesh boundary`);
  return { ok: errors.length === 0, errors, warnings };
}
