import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HM_PUBLISHED_SIZES_CM, SCHEMA_VERSION, assembleGarment, buildGlb, buildTShirtPattern, paramsForSize, serializeMesh, tShirtPlacement,
  validateMesh, validatePattern, type GarmentPattern, type ShirtSize,
} from '@shirt/garment-schema';

const { values } = parseArgs({
  options: {
    size: { type: 'string' }, out: { type: 'string' }, name: { type: 'string', default: 'T-shirt' },
    article: { type: 'string', default: 'unknown' }, method: { type: 'string', default: 'procedural-template' },
    source: { type: 'string', default: '' }, spacing: { type: 'string', default: '0.03' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const size = values.size as ShirtSize;
if (!values.out) fail('--out is required');
if (!(size in HM_PUBLISHED_SIZES_CM)) fail(`Unknown size: ${values.size}`);
// This exporter builds the template. It must never label that output as a model reconstruction.
if (values.method !== 'procedural-template') fail(`Exporter has no verified pattern input for method "${values.method}".`);

const params = paramsForSize(size);
const pattern: GarmentPattern = buildTShirtPattern(params);
const patternReport = validatePattern(pattern);
if (!patternReport.ok) fail(`Pattern failed validation: ${patternReport.errors.join('; ')}`);
const mesh = assembleGarment(pattern, tShirtPlacement(params), { spacing: Number(values.spacing) });
const meshReport = validateMesh(mesh);
if (!meshReport.ok) fail(`Mesh failed validation: ${meshReport.errors.join('; ')}`);

const panelPaths = pattern.panels.map((panel, index) => {
  const points = panel.edges.flatMap((e) => e.points.slice(0, -1));
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 100 + 45 + index * 2).toFixed(1)} ${(100 - y * 100).toFixed(1)}`).join(' ');
  return `<path d="${d} Z" fill="none" stroke="#333" stroke-width="0.4"><title>${panel.id}</title></path>`;
});
const preview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 0 130 110">${panelPaths.join('')}</svg>`;

const outputs: Record<string, [string, Uint8Array]> = {
  render: ['render.glb', buildGlb(mesh)],
  simulation: ['sim.json', new TextEncoder().encode(JSON.stringify(serializeMesh(mesh, params)))],
  preview: ['preview.svg', new TextEncoder().encode(preview)],
};

mkdirSync(values.out, { recursive: true });
const files: Record<string, { path: string; sha256: string; bytes: number }> = {};
for (const [role, [path, data]] of Object.entries(outputs)) {
  writeFileSync(join(values.out, path), data);
  files[role] = { path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength };
}

const published = HM_PUBLISHED_SIZES_CM[size];
const manifest = {
  schemaVersion: SCHEMA_VERSION,
  name: values.name,
  article: values.article,
  size,
  units: 'm',
  sourceUrls: values.source ? [values.source] : [],
  reconstructionMethod: 'procedural-template',
  processingVersions: { exporter: '1', simFormat: 1, spacingM: Number(values.spacing) },
  observedFacts: { publishedWidthCm: published.width, publishedLengthCm: published.length, publishedOn: 'H&M Indian listing for article 0685816001, retrieved 2026-11-23' },
  assumptions: [
    'Published width is treated as chest circumference, so flat width is half of it. This is unverified.',
    'Shoulder, neck, armhole and sleeve dimensions are estimated proportions.',
    `Areal density ${mesh.arealDensity} kg/m2 is an estimate. It is not derived from the listed 205 g product weight.`,
    'Cloth material parameters are an uncalibrated jersey preset.',
  ],
  mesh: { simVertices: mesh.positions.length / 3, triangles: mesh.triangles.length / 3, renderVertices: mesh.renderToSim.length, seamVertices: mesh.seamVertexCount },
  validation: { status: 'passed', warnings: [...patternReport.warnings, ...meshReport.warnings] },
  files,
  createdAt: new Date().toISOString(),
};
writeFileSync(join(values.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`exported ${size}: ${manifest.mesh.simVertices} sim vertices`);
