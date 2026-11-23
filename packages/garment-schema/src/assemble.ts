import Delaunator from 'delaunator';
import type { EdgeRef, GarmentMesh, GarmentPattern, Panel, PlaceFn, Vec2 } from './types';
import { polylineLength } from './template';

export interface AssembleOptions {
  /** Target edge length in metres. */
  spacing: number;
  /** ESTIMATE for lightweight cotton jersey. Not derived from the listed 205 g product weight. */
  arealDensity?: number;
  relaxIterations?: number;
}

export const ESTIMATED_JERSEY_DENSITY_KG_M2 = 0.16;

const key = (r: EdgeRef) => `${r.panel}/${r.edge}`;

function resample(points: Vec2[], segments: number): Vec2[] {
  const total = polylineLength(points);
  const out: Vec2[] = [points[0]];
  let seg = 0;
  let walked = 0;
  for (let k = 1; k < segments; k++) {
    const target = (k / segments) * total;
    while (seg < points.length - 2) {
      const l = Math.hypot(points[seg + 1][0] - points[seg][0], points[seg + 1][1] - points[seg][1]);
      if (walked + l >= target) break;
      walked += l;
      seg++;
    }
    const a = points[seg];
    const b = points[seg + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = (target - walked) / l;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function inside(poly: Vec2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function distToPoly(poly: Vec2[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Segment counts must agree across a seam, including chains of seams. */
function edgeSegments(pattern: GarmentPattern, spacing: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const panel of pattern.panels) {
    for (const e of panel.edges) {
      counts.set(`${panel.id}/${e.id}`, Math.max(1, Math.ceil(polylineLength(e.points) / spacing)));
    }
  }
  for (let pass = 0; pass < pattern.seams.length + 1; pass++) {
    for (const s of pattern.seams) {
      const n = Math.max(counts.get(key(s.a))!, counts.get(key(s.b))!);
      counts.set(key(s.a), n);
      counts.set(key(s.b), n);
    }
  }
  return counts;
}

interface LocalPanel {
  panel: Panel;
  points: Vec2[];
  edgeIdx: Map<string, number[]>;
  tris: number[];
  base: number;
}

function meshPanel(panel: Panel, counts: Map<string, number>, spacing: number): LocalPanel {
  const points: Vec2[] = [];
  const ranges: { id: string; start: number; n: number }[] = [];
  for (const e of panel.edges) {
    const n = counts.get(`${panel.id}/${e.id}`)!;
    const sampled = resample(e.points, n);
    ranges.push({ id: e.id, start: points.length, n });
    for (let i = 0; i < n; i++) points.push(sampled[i]);
  }
  const boundaryCount = points.length;
  const edgeIdx = new Map<string, number[]>();
  for (const r of ranges) {
    const idx: number[] = [];
    for (let i = 0; i <= r.n; i++) idx.push((r.start + i) % boundaryCount);
    edgeIdx.set(r.id, idx);
  }
  const boundary = points.slice();
  const xs = boundary.map((p) => p[0]);
  const ys = boundary.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const rowH = spacing * Math.sqrt(3) * 0.5;
  let row = 0;
  for (let y = minY + rowH / 2; y < maxY; y += rowH, row++) {
    for (let x = minX + (row % 2 ? spacing / 2 : 0); x <= maxX; x += spacing) {
      if (inside(boundary, x, y) && distToPoly(boundary, x, y) > spacing * 0.6) points.push([x, y]);
    }
  }
  const d = Delaunator.from(points);
  const tris: number[] = [];
  for (let t = 0; t < d.triangles.length; t += 3) {
    const [a, b, c] = [d.triangles[t], d.triangles[t + 1], d.triangles[t + 2]];
    const cx = (points[a][0] + points[b][0] + points[c][0]) / 3;
    const cy = (points[a][1] + points[b][1] + points[c][1]) / 3;
    if (!inside(boundary, cx, cy)) continue;
    const area = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
    if (Math.abs(area) < 1e-10) continue;
    // Delaunator emits clockwise triangles in y-up coordinates; store CCW.
    if (area > 0) tris.push(a, b, c);
    else tris.push(a, c, b);
  }
  return { panel, points, edgeIdx, tris, base: 0 };
}

export function assembleGarment(pattern: GarmentPattern, place: PlaceFn, options: AssembleOptions): GarmentMesh {
  const density = options.arealDensity ?? ESTIMATED_JERSEY_DENSITY_KG_M2;
  const counts = edgeSegments(pattern, options.spacing);
  const locals = pattern.panels.map((p) => meshPanel(p, counts, options.spacing));
  let renderCount = 0;
  for (const l of locals) {
    l.base = renderCount;
    renderCount += l.points.length;
  }
  const byId = new Map(locals.map((l) => [l.panel.id, l]));
  const edgeGlobal = (r: EdgeRef) => {
    const l = byId.get(r.panel);
    const idx = l?.edgeIdx.get(r.edge);
    if (!l || !idx) throw new Error(`Unknown edge ${key(r)}`);
    return idx.map((i) => i + l.base);
  };

  const parent = new Int32Array(renderCount).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const s of pattern.seams) {
    const a = edgeGlobal(s.a);
    const b = edgeGlobal(s.b);
    if (a.length !== b.length) throw new Error(`Seam length mismatch ${key(s.a)} <> ${key(s.b)}`);
    for (let i = 0; i < a.length; i++) {
      const ra = find(a[i]);
      const rb = find(b[s.reversed ? b.length - 1 - i : i]);
      if (ra !== rb) parent[rb] = ra;
    }
  }

  const simIndex = new Int32Array(renderCount).fill(-1);
  let simCount = 0;
  for (let i = 0; i < renderCount; i++) {
    const r = find(i);
    if (simIndex[r] < 0) simIndex[r] = simCount++;
  }
  const renderToSim = new Uint32Array(renderCount);
  for (let i = 0; i < renderCount; i++) renderToSim[i] = simIndex[find(i)];

  const positions = new Float32Array(simCount * 3);
  const weight = new Uint16Array(simCount);
  const renderUv = new Float32Array(renderCount * 2);
  const renderPanel = new Uint8Array(renderCount);
  locals.forEach((l, panelIndex) => {
    l.points.forEach((pt, i) => {
      const render = l.base + i;
      const sim = renderToSim[render];
      const q = place(l.panel.id, pt);
      positions[sim * 3] += q[0];
      positions[sim * 3 + 1] += q[1];
      positions[sim * 3 + 2] += q[2];
      weight[sim]++;
      renderUv[render * 2] = pt[0];
      renderUv[render * 2 + 1] = pt[1];
      renderPanel[render] = panelIndex;
    });
  });
  for (let v = 0; v < simCount; v++) {
    positions[v * 3] /= weight[v];
    positions[v * 3 + 1] /= weight[v];
    positions[v * 3 + 2] /= weight[v];
  }
  let seamVertexCount = 0;
  for (let v = 0; v < simCount; v++) if (weight[v] > 1) seamVertexCount++;

  const triCount = locals.reduce((n, l) => n + l.tris.length / 3, 0);
  const triangles = new Uint32Array(triCount * 3);
  const renderTriangles = new Uint32Array(triCount * 3);
  const triRest = new Float32Array(triCount * 6);
  const mass = new Float32Array(simCount);
  const triPanel = new Uint8Array(triCount);
  let t = 0;
  for (const [panelIndex, l] of locals.entries()) {
    // Back and left-sleeve panels face the opposite way once placed.
    const flip = l.panel.id === 'back' || l.panel.id === 'sleeve_l';
    for (let k = 0; k < l.tris.length; k += 3) {
      const a = l.tris[k];
      const b = l.tris[flip ? k + 2 : k + 1];
      const c = l.tris[flip ? k + 1 : k + 2];
      const corners = [a, b, c];
      corners.forEach((corner, n) => {
        renderTriangles[t * 3 + n] = l.base + corner;
        triangles[t * 3 + n] = renderToSim[l.base + corner];
        triRest[t * 6 + n * 2] = l.points[corner][0];
        triRest[t * 6 + n * 2 + 1] = l.points[corner][1];
      });
      const [pa, pb, pc] = [l.points[a], l.points[b], l.points[c]];
      const area = Math.abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])) / 2;
      for (const corner of corners) mass[renderToSim[l.base + corner]] += (area * density) / 3;
      triPanel[t] = panelIndex;
      t++;
    }
  }
  const invMass = new Float32Array(simCount);
  for (let v = 0; v < simCount; v++) invMass[v] = mass[v] > 0 ? 1 / mass[v] : 0;
  orientTriangles(triangles, renderTriangles, triRest, positions);

  const { stretch, bend } = buildConstraints(triangles, triRest, simCount, triPanel);
  const openings: Record<string, Uint32Array> = {};
  for (const o of pattern.openings) {
    const set = new Set<number>();
    for (const r of o.edges) for (const g of edgeGlobal(r)) set.add(renderToSim[g]);
    openings[o.id] = Uint32Array.from(set);
  }

  const simSleeve = new Int8Array(simCount);
  const onBody = new Uint8Array(simCount);
  locals.forEach((l) => {
    const side = l.panel.id === 'sleeve_r' ? 1 : l.panel.id === 'sleeve_l' ? -1 : 0;
    l.points.forEach((_, i) => {
      const sim = renderToSim[l.base + i];
      if (side === 0) onBody[sim] = 1;
      else simSleeve[sim] = side;
    });
  });
  for (let v = 0; v < simCount; v++) if (onBody[v]) simSleeve[v] = 0;

  relaxToRest(positions, stretch, options.relaxIterations ?? 200);
  return { positions, invMass, triangles, triRest, stretch, bend, renderToSim, renderUv, renderTriangles, renderPanel, simSleeve, openings, seamVertexCount, arealDensity: density };
}

/**
 * Give the sewn surface one consistent winding with normals facing out of the garment,
 * so shading is continuous across seams and an inner and outer shell can be derived.
 */
function orientTriangles(triangles: Uint32Array, render: Uint32Array, rest: Float32Array, x: Float32Array): void {
  const count = triangles.length / 3;
  const vertexCount = x.length / 3;
  const edgeKey = (a: number, b: number) => Math.min(a, b) * vertexCount + Math.max(a, b);
  const byEdge = new Map<number, number[]>();
  for (let t = 0; t < count; t++) {
    for (let n = 0; n < 3; n++) {
      const key = edgeKey(triangles[t * 3 + n], triangles[t * 3 + ((n + 1) % 3)]);
      const list = byEdge.get(key);
      if (list) list.push(t);
      else byEdge.set(key, [t]);
    }
  }
  const flip = (t: number) => {
    for (const [array, base] of [[triangles, t * 3], [render, t * 3]] as const) {
      const held = array[base + 1];
      array[base + 1] = array[base + 2];
      array[base + 2] = held;
    }
    for (let k = 0; k < 2; k++) {
      const held = rest[t * 6 + 2 + k];
      rest[t * 6 + 2 + k] = rest[t * 6 + 4 + k];
      rest[t * 6 + 4 + k] = held;
    }
  };
  const runsForward = (t: number, a: number, b: number) => {
    for (let n = 0; n < 3; n++) if (triangles[t * 3 + n] === a && triangles[t * 3 + ((n + 1) % 3)] === b) return true;
    return false;
  };
  const seen = new Uint8Array(count);
  for (let seed = 0; seed < count; seed++) {
    if (seen[seed]) continue;
    seen[seed] = 1;
    const queue = [seed];
    while (queue.length) {
      const t = queue.pop()!;
      for (let n = 0; n < 3; n++) {
        const a = triangles[t * 3 + n];
        const b = triangles[t * 3 + ((n + 1) % 3)];
        for (const other of byEdge.get(edgeKey(a, b))!) {
          if (other === t || seen[other]) continue;
          if (runsForward(other, a, b)) flip(other);
          seen[other] = 1;
          queue.push(other);
        }
      }
    }
  }
  const centre = [0, 0, 0];
  for (let v = 0; v < vertexCount; v++) for (let k = 0; k < 3; k++) centre[k] += x[v * 3 + k] / vertexCount;
  let volume = 0;
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [triangles[t * 3] * 3, triangles[t * 3 + 1] * 3, triangles[t * 3 + 2] * 3];
    const p = [x[a] - centre[0], x[a + 1] - centre[1], x[a + 2] - centre[2]];
    const q = [x[b] - centre[0], x[b + 1] - centre[1], x[b + 2] - centre[2]];
    const r = [x[c] - centre[0], x[c + 1] - centre[1], x[c + 2] - centre[2]];
    volume += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  if (volume < 0) for (let t = 0; t < count; t++) flip(t);
}

/**
 * Sewing relaxation for the canonical placement. Only positions move:
 * material rest lengths still come from the flat panels.
 */
function relaxToRest(x: Float32Array, c: GarmentMesh['stretch'], iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    for (let n = 0; n < c.rest.length; n++) {
      const a = c.i[n] * 3;
      const b = c.j[n] * 3;
      const dx = x[a] - x[b];
      const dy = x[a + 1] - x[b + 1];
      const dz = x[a + 2] - x[b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const f = (0.5 * (len - c.rest[n])) / len;
      x[a] -= dx * f;
      x[a + 1] -= dy * f;
      x[a + 2] -= dz * f;
      x[b] += dx * f;
      x[b + 1] += dy * f;
      x[b + 2] += dz * f;
    }
  }
}

function buildConstraints(triangles: Uint32Array, triRest: Float32Array, simCount: number, triPanel: Uint8Array) {
  type Side = { opp: number; along: number; height: number; length: number; panel: number };
  const edges = new Map<number, { i: number; j: number; sides: Side[] }>();
  const triCount = triangles.length / 3;
  for (let t = 0; t < triCount; t++) {
    for (let n = 0; n < 3; n++) {
      const n1 = (n + 1) % 3;
      const n2 = (n + 2) % 3;
      const vi = triangles[t * 3 + n];
      const vj = triangles[t * 3 + n1];
      const vk = triangles[t * 3 + n2];
      const [i, j] = vi < vj ? [vi, vj] : [vj, vi];
      const [ci, cj] = vi < vj ? [n, n1] : [n1, n];
      const px = triRest[t * 6 + ci * 2];
      const py = triRest[t * 6 + ci * 2 + 1];
      const dx = triRest[t * 6 + cj * 2] - px;
      const dy = triRest[t * 6 + cj * 2 + 1] - py;
      const length = Math.hypot(dx, dy);
      const kx = triRest[t * 6 + n2 * 2] - px;
      const ky = triRest[t * 6 + n2 * 2 + 1] - py;
      const along = (kx * dx + ky * dy) / (length || 1);
      const height = Math.abs(kx * dy - ky * dx) / (length || 1);
      const id = i * simCount + j;
      let rec = edges.get(id);
      if (!rec) edges.set(id, (rec = { i, j, sides: [] }));
      rec.sides.push({ opp: vk, along, height, length, panel: triPanel[t] });
    }
  }
  const si: number[] = [];
  const sj: number[] = [];
  const sr: number[] = [];
  const bi: number[] = [];
  const bj: number[] = [];
  const br: number[] = [];
  for (const e of edges.values()) {
    si.push(e.i);
    sj.push(e.j);
    // Seam sides can differ slightly in length; use their mean as material rest length.
    sr.push(e.sides.reduce((sum, s) => sum + s.length, 0) / e.sides.length);
    // A seam's natural shape is a corner, so flat-rest bending applies only inside a panel.
    if (e.sides.length === 2 && e.sides[0].opp !== e.sides[1].opp && e.sides[0].panel === e.sides[1].panel) {
      const [a, b] = e.sides;
      bi.push(a.opp);
      bj.push(b.opp);
      br.push(Math.hypot(a.along - b.along, a.height + b.height));
    }
  }
  return {
    stretch: { i: Uint32Array.from(si), j: Uint32Array.from(sj), rest: Float32Array.from(sr) },
    bend: { i: Uint32Array.from(bi), j: Uint32Array.from(bj), rest: Float32Array.from(br) },
  };
}
