import { SCHEMA_VERSION, type GarmentPattern, type Panel, type PlaceFn, type Seam, type Vec2, type Vec3 } from './types';

export interface TShirtParams {
  /** Flat half-chest, i.e. panel width. */
  bodyWidth: number;
  bodyLength: number;
  shoulderWidth: number;
  shoulderDrop: number;
  neckWidth: number;
  neckDepthFront: number;
  neckDepthBack: number;
  armholeDepth: number;
  sleeveLength: number;
  sleeveOpening: number;
  neckbandWidth: number;
}

/**
 * Published H&M 0685816001 width/length (Indian listing).
 * ASSUMPTION: "width" is chest circumference, so flat width = published / 2.
 */
export const HM_PUBLISHED_SIZES_CM = {
  XS: { width: 94, length: 68 },
  S: { width: 102, length: 70 },
  M: { width: 110, length: 71 },
  L: { width: 118, length: 73 },
  XL: { width: 126, length: 74 },
  XXL: { width: 134, length: 75 },
} as const;

export type ShirtSize = keyof typeof HM_PUBLISHED_SIZES_CM;

/** Only width and length are sourced. Every other value is an estimated proportion. */
export function paramsForSize(size: ShirtSize): TShirtParams {
  const { width, length } = HM_PUBLISHED_SIZES_CM[size];
  const bodyWidth = width / 200;
  return {
    bodyWidth,
    bodyLength: length / 100,
    shoulderWidth: bodyWidth * 0.86,
    shoulderDrop: 0.045,
    neckWidth: 0.175,
    neckDepthFront: 0.085,
    neckDepthBack: 0.02,
    armholeDepth: bodyWidth * 0.43,
    sleeveLength: 0.2,
    // Estimated flat cuff width, with a floor so small sizes still clear an adult arm.
    sleeveOpening: Math.max(bodyWidth * 0.33, 0.175),
    neckbandWidth: 0.02,
  };
}

function curve(a: Vec2, c: Vec2, b: Vec2, n = 16): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const s = 1 - t;
    out.push([s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]);
  }
  return out;
}

export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

function bodyPanel(id: string, p: TShirtParams, neckDepth: number): Panel {
  const w = p.bodyWidth / 2;
  const L = p.bodyLength;
  const sh = p.shoulderWidth / 2;
  const shY = L - p.shoulderDrop;
  const armY = shY - p.armholeDepth;
  const nw = p.neckWidth / 2;
  const hemR: Vec2 = [w, 0];
  const hemL: Vec2 = [-w, 0];
  const armR: Vec2 = [w, armY];
  const armL: Vec2 = [-w, armY];
  const shR: Vec2 = [sh, shY];
  const shL: Vec2 = [-sh, shY];
  const neckR: Vec2 = [nw, L];
  const neckL: Vec2 = [-nw, L];
  return {
    id,
    edges: [
      { id: 'hem', points: [hemL, hemR] },
      { id: 'side_r', points: [hemR, armR] },
      { id: 'arm_r', points: curve(armR, [sh, armY + p.armholeDepth * 0.3], shR) },
      { id: 'shoulder_r', points: [shR, neckR] },
      // A half ellipse gives a round crew neck. A single quadratic reads as a V.
      { id: 'neck', points: Array.from({ length: 25 }, (_, k): Vec2 => {
        const angle = (k / 24) * Math.PI;
        return k === 0 ? neckR : k === 24 ? neckL : [nw * Math.cos(angle), L - neckDepth * Math.sin(angle)];
      }) },
      { id: 'shoulder_l', points: [neckL, shL] },
      { id: 'arm_l', points: curve(shL, [-sh, armY + p.armholeDepth * 0.3], armL) },
      { id: 'side_l', points: [armL, hemL] },
    ],
  };
}

/** Sleeve cap height is solved so the cap matches the armhole it is sewn into. */
function sleevePanel(id: string, p: TShirtParams, armholeLength: number): Panel {
  // sleeveOpening is the flat (folded) cuff width, so the one-piece panel is twice as wide.
  const cuffHalf = p.sleeveOpening;
  const underHalf = Math.max(cuffHalf * 1.08, armholeLength * 0.82);
  const under = p.sleeveLength;
  const capPoints = (h: number) => curve([underHalf, under], [underHalf * 0.35, under + h * 1.05], [0, under + h]);
  let lo = 0.005;
  let hi = 0.3;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (polylineLength(capPoints(mid)) < armholeLength) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  const capR = capPoints(h);
  const capL = capR.map(([x, y]) => [-x, y] as Vec2).reverse();
  return {
    id,
    edges: [
      { id: 'cuff', points: [[-cuffHalf, 0], [cuffHalf, 0]] },
      { id: 'under_r', points: [[cuffHalf, 0], [underHalf, under]] },
      { id: 'cap_front', points: capR },
      { id: 'cap_back', points: capL },
      { id: 'under_l', points: [[-underHalf, under], [-cuffHalf, 0]] },
    ],
  };
}

function neckbandPanel(frontNeck: number, backNeck: number, width: number): Panel {
  const total = frontNeck + backNeck;
  const x0 = -total / 2;
  const split = x0 + frontNeck;
  return {
    id: 'neckband',
    edges: [
      { id: 'bottom_front', points: [[x0, 0], [split, 0]] },
      { id: 'bottom_back', points: [[split, 0], [-x0, 0]] },
      { id: 'end_r', points: [[-x0, 0], [-x0, width]] },
      { id: 'top', points: [[-x0, width], [x0, width]] },
      { id: 'end_l', points: [[x0, width], [x0, 0]] },
    ],
  };
}

export function buildTShirtPattern(p: TShirtParams): GarmentPattern {
  const front = bodyPanel('front', p, p.neckDepthFront);
  const back = bodyPanel('back', p, p.neckDepthBack);
  const edge = (panel: Panel, id: string) => panel.edges.find((e) => e.id === id)!;
  const armhole = polylineLength(edge(front, 'arm_r').points);
  const sleeveR = sleevePanel('sleeve_r', p, armhole);
  const sleeveL = sleevePanel('sleeve_l', p, armhole);
  const band = neckbandPanel(polylineLength(edge(front, 'neck').points), polylineLength(edge(back, 'neck').points), p.neckbandWidth);

  const s = (ap: string, ae: string, bp: string, be: string, reversed: boolean): Seam => ({
    a: { panel: ap, edge: ae },
    b: { panel: bp, edge: be },
    reversed,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    units: 'm',
    method: 'procedural-template',
    panels: [front, back, sleeveR, sleeveL, band],
    seams: [
      s('front', 'side_r', 'back', 'side_r', false),
      s('front', 'side_l', 'back', 'side_l', false),
      s('front', 'shoulder_r', 'back', 'shoulder_r', false),
      s('front', 'shoulder_l', 'back', 'shoulder_l', false),
      // Cap runs underarm -> apex (front), apex -> underarm (back).
      s('sleeve_r', 'cap_front', 'front', 'arm_r', false),
      s('sleeve_r', 'cap_back', 'back', 'arm_r', true),
      s('sleeve_r', 'under_r', 'sleeve_r', 'under_l', true),
      // Left armhole edges run shoulder -> underarm, so the pairing flips.
      s('sleeve_l', 'cap_front', 'front', 'arm_l', true),
      s('sleeve_l', 'cap_back', 'back', 'arm_l', false),
      s('sleeve_l', 'under_r', 'sleeve_l', 'under_l', true),
      s('neckband', 'bottom_front', 'front', 'neck', true),
      // The band continues from the right neck point around the back, so this one is not reversed.
      s('neckband', 'bottom_back', 'back', 'neck', false),
      s('neckband', 'end_r', 'neckband', 'end_l', true),
    ],
    openings: [
      { id: 'hem', edges: [{ panel: 'front', edge: 'hem' }, { panel: 'back', edge: 'hem' }] },
      { id: 'neck', edges: [{ panel: 'neckband', edge: 'top' }] },
      { id: 'cuff_r', edges: [{ panel: 'sleeve_r', edge: 'cuff' }] },
      { id: 'cuff_l', edges: [{ panel: 'sleeve_l', edge: 'cuff' }] },
    ],
  };
}

/** Point at an arc-length fraction along a polyline. */
function pointAt(points: Vec2[], fraction: number): Vec2 {
  const target = polylineLength(points) * Math.max(0, Math.min(1, fraction));
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (walked + l >= target) {
      const t = l > 0 ? (target - walked) / l : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += l;
  }
  return points[points.length - 1];
}

/**
 * Canonical placement in garment space: y up, z out of the chest, hem at y = 0.
 * Panel suffix _r is the +x side. Front and back close at the side seams and shoulders;
 * sleeves and neckband are placed from the body edges they are sewn to.
 */
export function tShirtPlacement(p: TShirtParams): PlaceFn {
  const pattern = buildTShirtPattern(p);
  const panel = (id: string) => pattern.panels.find((q) => q.id === id)!;
  const edge = (id: string, e: string) => panel(id).edges.find((q) => q.id === e)!.points;
  const w = p.bodyWidth / 2;
  const depth = p.bodyWidth * 0.26;
  const L = p.bodyLength;
  const shY = L - p.shoulderDrop;
  const armY = shY - p.armholeDepth;
  const sh = p.shoulderWidth / 2;
  const nw = p.neckWidth / 2;

  const bodyZ = (x: number, y: number) => {
    const ax = Math.min(1, Math.abs(x) / w);
    const lens = Math.sqrt(Math.max(0, 1 - ax * ax));
    const absX = Math.abs(x);
    const top = absX <= nw ? L : absX >= sh ? shY : L + ((shY - L) * (absX - nw)) / (sh - nw);
    const taper = Math.max(0, Math.min(1, (y - armY) / Math.max(1e-6, top - armY)));
    return depth * lens * (1 - taper * taper);
  };

  const armEdge = edge('front', 'arm_r');
  /** s = 0 at the shoulder point, 1 at the underarm; sign chooses front or back. */
  const armPoint = (s: number, sign: number, side: number): Vec3 => {
    const [x, y] = pointAt(armEdge, 1 - s);
    return [side * x, y, sign * bodyZ(x, y)];
  };

  const capFront = edge('sleeve_r', 'cap_front');
  const cuffHalf = p.sleeveOpening;
  const underHalf = capFront[0][0];
  const under = capFront[0][1];
  const capTop = (absX: number) => {
    for (let i = 1; i < capFront.length; i++) {
      const [a, b] = [capFront[i - 1], capFront[i]];
      if (absX <= a[0] && absX >= b[0]) {
        const t = a[0] > b[0] ? (a[0] - absX) / (a[0] - b[0]) : 0;
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return under;
  };
  const cuffRadius = p.sleeveOpening / Math.PI;
  const sleeveCentreY = (shY + armY) / 2;

  const bandBottom = panel('neckband').edges;
  const bandStart = bandBottom[0].points[0][0];
  const bandSplit = bandBottom[0].points[1][0];
  const bandEnd = bandBottom[1].points[1][0];
  const frontNeck = edge('front', 'neck');
  const backNeck = edge('back', 'neck');

  return (panelId, [x, y]): Vec3 => {
    if (panelId === 'front') return [x, y, bodyZ(x, y)];
    if (panelId === 'back') return [x, y, -bodyZ(x, y)];
    if (panelId === 'neckband') {
      if (x <= bandSplit) {
        const [nx, ny] = pointAt(frontNeck, 1 - (x - bandStart) / (bandSplit - bandStart));
        return [nx, ny + y, bodyZ(nx, ny)];
      }
      const [nx, ny] = pointAt(backNeck, (x - bandSplit) / (bandEnd - bandSplit));
      return [nx, ny + y, -bodyZ(nx, ny)];
    }
    const side = panelId === 'sleeve_r' ? 1 : -1;
    const halfAtY = y < under ? cuffHalf + ((underHalf - cuffHalf) * y) / under : underHalf;
    const u = Math.max(-1, Math.min(1, x / halfAtY));
    const t = Math.max(0, Math.min(1, y / capTop(Math.abs(x))));
    const ring = armPoint(Math.abs(u), u >= 0 ? 1 : -1, side);
    const theta = u * Math.PI;
    const cuff: Vec3 = [side * (sh + p.sleeveLength), sleeveCentreY + cuffRadius * Math.cos(theta), cuffRadius * Math.sin(theta)];
    return [cuff[0] + (ring[0] - cuff[0]) * t, cuff[1] + (ring[1] - cuff[1]) * t, cuff[2] + (ring[2] - cuff[2]) * t];
  };
}
