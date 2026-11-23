import type { TShirtParams } from './template';
import type { GarmentMesh } from './types';

export const SIM_FORMAT_VERSION = 1;

type Typed = Float32Array | Uint32Array | Uint8Array | Int8Array;
const CTORS = { f32: Float32Array, u32: Uint32Array, u8: Uint8Array, i8: Int8Array } as const;
type Kind = keyof typeof CTORS;

interface Encoded {
  type: Kind;
  base64: string;
}

function kindOf(a: Typed): Kind {
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Uint32Array) return 'u32';
  if (a instanceof Int8Array) return 'i8';
  return 'u8';
}

function encode(a: Typed): Encoded {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: kindOf(a), base64: btoa(text) };
}

function decode<T extends Typed>(e: Encoded): T {
  const text = atob(e.base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  const Ctor = CTORS[e.type];
  return new Ctor(bytes.buffer) as T;
}

export interface SimPackage {
  format: number;
  params: TShirtParams;
  arealDensity: number;
  seamVertexCount: number;
  arrays: Record<string, Encoded>;
  openings: Record<string, Encoded>;
}

export function serializeMesh(mesh: GarmentMesh, params: TShirtParams): SimPackage {
  return {
    format: SIM_FORMAT_VERSION,
    params,
    arealDensity: mesh.arealDensity,
    seamVertexCount: mesh.seamVertexCount,
    arrays: {
      positions: encode(mesh.positions), invMass: encode(mesh.invMass), triangles: encode(mesh.triangles), triRest: encode(mesh.triRest),
      stretchI: encode(mesh.stretch.i), stretchJ: encode(mesh.stretch.j), stretchRest: encode(mesh.stretch.rest),
      bendI: encode(mesh.bend.i), bendJ: encode(mesh.bend.j), bendRest: encode(mesh.bend.rest),
      renderToSim: encode(mesh.renderToSim), renderUv: encode(mesh.renderUv), renderTriangles: encode(mesh.renderTriangles),
      renderPanel: encode(mesh.renderPanel), simSleeve: encode(mesh.simSleeve),
    },
    openings: Object.fromEntries(Object.entries(mesh.openings).map(([k, v]) => [k, encode(v)])),
  };
}

export function deserializeMesh(p: SimPackage): { mesh: GarmentMesh; params: TShirtParams } {
  if (p.format !== SIM_FORMAT_VERSION) throw new Error(`Unsupported simulation format ${p.format}`);
  const a = p.arrays;
  const mesh: GarmentMesh = {
    positions: decode(a.positions), invMass: decode(a.invMass), triangles: decode(a.triangles), triRest: decode(a.triRest),
    stretch: { i: decode(a.stretchI), j: decode(a.stretchJ), rest: decode(a.stretchRest) },
    bend: { i: decode(a.bendI), j: decode(a.bendJ), rest: decode(a.bendRest) },
    renderToSim: decode(a.renderToSim), renderUv: decode(a.renderUv), renderTriangles: decode(a.renderTriangles),
    renderPanel: decode(a.renderPanel), simSleeve: decode(a.simSleeve),
    openings: Object.fromEntries(Object.entries(p.openings).map(([k, v]) => [k, decode<Uint32Array>(v)])),
    seamVertexCount: p.seamVertexCount,
    arealDensity: p.arealDensity,
  };
  return { mesh, params: p.params };
}

/** Minimal glTF 2.0 binary: canonical shape, UVs in flat panel metres, one neutral material. */
export function buildGlb(mesh: GarmentMesh): Uint8Array {
  const count = mesh.renderToSim.length;
  const position = new Float32Array(count * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let r = 0; r < count; r++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[mesh.renderToSim[r] * 3 + k];
      position[r * 3 + k] = v;
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    }
  }
  const parts: Uint8Array[] = [
    new Uint8Array(position.buffer),
    new Uint8Array(mesh.renderUv.buffer, mesh.renderUv.byteOffset, mesh.renderUv.byteLength),
    new Uint8Array(mesh.renderTriangles.buffer, mesh.renderTriangles.byteOffset, mesh.renderTriangles.byteLength),
  ];
  const offsets: number[] = [];
  let length = 0;
  for (const part of parts) {
    offsets.push(length);
    length += part.byteLength;
  }
  const json = {
    asset: { version: '2.0', generator: 'shirt garment exporter' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'garment' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'estimated-white-jersey', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.9, 0.89, 0.86, 1], metallicFactor: 0, roughnessFactor: 0.92 } }],
    buffers: [{ byteLength: length }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: parts[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: parts[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: parts[2].byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC2' },
      { bufferView: 2, componentType: 5125, count: mesh.renderTriangles.length, type: 'SCALAR' },
    ],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const binPad = (4 - (length % 4)) % 4;
  const binLength = length + binPad;
  const total = 12 + 8 + jsonBytes.length + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  parts.forEach((part, i) => out.set(part, binStart + 8 + offsets[i]));
  return out;
}
