export const SCHEMA_VERSION = 1;

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Polyline in panel-local flat material coordinates (metres). */
export interface PanelEdge {
  id: string;
  points: Vec2[];
}

/** Edges are ordered counter-clockwise and form a closed loop. */
export interface Panel {
  id: string;
  edges: PanelEdge[];
}

export interface EdgeRef {
  panel: string;
  edge: string;
}

/** `reversed` means a's start is sewn to b's end. */
export interface Seam {
  a: EdgeRef;
  b: EdgeRef;
  reversed: boolean;
}

export interface Opening {
  id: 'neck' | 'hem' | 'cuff_l' | 'cuff_r';
  edges: EdgeRef[];
}

export type ReconstructionMethod = 'procedural-template' | 'sewformer';

export interface GarmentPattern {
  schemaVersion: number;
  units: 'm';
  method: ReconstructionMethod;
  panels: Panel[];
  seams: Seam[];
  openings: Opening[];
}

export type PlaceFn = (panelId: string, p: Vec2) => Vec3;

/**
 * Simulation mesh. Render vertices stay split at seams so UVs survive;
 * `renderToSim` maps each one to its welded simulation vertex.
 */
export interface GarmentMesh {
  positions: Float32Array;
  invMass: Float32Array;
  triangles: Uint32Array;
  /** Flat material coordinates per triangle corner: 6 floats per triangle. */
  triRest: Float32Array;
  stretch: { i: Uint32Array; j: Uint32Array; rest: Float32Array };
  bend: { i: Uint32Array; j: Uint32Array; rest: Float32Array };
  renderToSim: Uint32Array;
  renderUv: Float32Array;
  renderTriangles: Uint32Array;
  renderPanel: Uint8Array;
  /** +1 / -1 for vertices only on the +x / -x sleeve; 0 for body and armhole seam vertices. */
  simSleeve: Int8Array;
  openings: Record<string, Uint32Array>;
  seamVertexCount: number;
  arealDensity: number;
}
