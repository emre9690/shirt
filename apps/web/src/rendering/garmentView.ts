import * as THREE from 'three';
import type { GarmentMesh } from '@shirt/garment-schema';
import type { Capsule } from '../physics/xpbd';
import type { ImageFit } from '../tracking/body';

/** Drawn thickness, including the folded hem look. Slightly above real jersey so edges read on camera. */
const FABRIC_HALF_THICKNESS_M = 0.0018;

export interface ViewOptions {
  wireframe: boolean;
  showColliders: boolean;
}

/**
 * Transparent garment layer over the camera video.
 * Draw order: invisible body depth proxy first, then the garment, so the shirt's back
 * is hidden by the torso and tracked arms in front of the chest cover the shirt.
 */
export class GarmentView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, 1, 6000);
  private root = new THREE.Group();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.MeshStandardMaterial;
  private mesh: THREE.Mesh;
  private proxies: THREE.Mesh[] = [];
  private debug: THREE.Mesh[] = [];
  private proxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
  private debugMaterial = new THREE.MeshBasicMaterial({ color: 0x35d0ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.55 });
  private unit = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  private cap = new THREE.SphereGeometry(1, 16, 10);
  private simNormals = new Float32Array(0);
  private garment: GarmentMesh | null = null;
  private rimVertices = new Uint32Array(0);
  private rimEdges = new Uint32Array(0);
  private rimStart = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.FrontSide, transparent: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.root.add(this.mesh);
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c6c0, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(0.3, 0.8, 1);
    this.scene.add(key);
    this.camera.position.z = 3000;
  }

  setGarment(mesh: GarmentMesh): void {
    this.garment = mesh;
    this.simNormals = new Float32Array(mesh.positions.length);
    const count = mesh.renderToSim.length;

    // Open edges of the sewn surface: the hem, cuffs and collar.
    const edgeUse = new Map<number, number>();
    const simCount = mesh.positions.length / 3;
    const key = (a: number, b: number) => Math.min(a, b) * simCount + Math.max(a, b);
    for (let k = 0; k < mesh.triangles.length; k += 3) {
      for (let n = 0; n < 3; n++) {
        const id = key(mesh.triangles[k + n], mesh.triangles[k + ((n + 1) % 3)]);
        edgeUse.set(id, (edgeUse.get(id) ?? 0) + 1);
      }
    }
    const rimIndex = new Map<number, number>();
    const rimEdges: number[] = [];
    for (let k = 0; k < mesh.renderTriangles.length; k += 3) {
      for (let n = 0; n < 3; n++) {
        const a = mesh.renderTriangles[k + n];
        const b = mesh.renderTriangles[k + ((n + 1) % 3)];
        if (edgeUse.get(key(mesh.renderToSim[a], mesh.renderToSim[b])) !== 1) continue;
        for (const v of [a, b]) if (!rimIndex.has(v)) rimIndex.set(v, rimIndex.size);
        rimEdges.push(a, b);
      }
    }
    this.rimVertices = Uint32Array.from(rimIndex.keys());
    this.rimEdges = Uint32Array.from(rimEdges);

    // Vertex layout: outer shell, inner shell, then an outer/inner pair per rim vertex.
    const rimStart = count * 2;
    this.rimStart = rimStart;
    const total = rimStart + this.rimVertices.length * 2;
    const triangles = mesh.renderTriangles;
    const index = new Uint32Array(triangles.length * 2 + rimEdges.length * 3);
    let w = 0;
    for (let k = 0; k < triangles.length; k += 3) {
      index[w++] = triangles[k];
      index[w++] = triangles[k + 1];
      index[w++] = triangles[k + 2];
    }
    for (let k = 0; k < triangles.length; k += 3) {
      index[w++] = triangles[k] + count;
      index[w++] = triangles[k + 2] + count;
      index[w++] = triangles[k + 1] + count;
    }
    for (let k = 0; k < rimEdges.length; k += 2) {
      const a = rimStart + rimIndex.get(rimEdges[k])! * 2;
      const b = rimStart + rimIndex.get(rimEdges[k + 1])! * 2;
      index[w++] = a;
      index[w++] = a + 1;
      index[w++] = b + 1;
      index[w++] = a;
      index[w++] = b + 1;
      index[w++] = b;
    }
    const uv = new Float32Array(total * 2);
    uv.set(mesh.renderUv);
    uv.set(mesh.renderUv, count * 2);
    this.rimVertices.forEach((v, r) => {
      for (const slot of [rimStart + r * 2, rimStart + r * 2 + 1]) {
        uv[slot * 2] = mesh.renderUv[v * 2];
        uv[slot * 2 + 1] = mesh.renderUv[v * 2 + 1];
      }
    });

    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry = this.geometry;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  setFit(fit: ImageFit): void {
    this.root.matrix.makeScale(fit.scale, fit.scale, fit.scale).setPosition(fit.tx, fit.ty, 0);
    this.root.matrixWorldNeedsUpdate = true;
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
    this.mesh.visible = opacity > 0.01;
  }

  setOptions(options: ViewOptions): void {
    this.material.wireframe = options.wireframe;
    this.debug.forEach((m) => (m.visible = options.showColliders));
  }

  updateCloth(x: Float32Array): void {
    const g = this.garment;
    if (!g) return;
    const n = this.simNormals;
    n.fill(0);
    const t = g.triangles;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3;
      const b = t[k + 1] * 3;
      const c = t[k + 2] * 3;
      const ux = x[b] - x[a];
      const uy = x[b + 1] - x[a + 1];
      const uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a];
      const vy = x[c + 1] - x[a + 1];
      const vz = x[c + 2] - x[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        n[i] += nx;
        n[i + 1] += ny;
        n[i + 2] += nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const px = position.array as Float32Array;
    const nx = normal.array as Float32Array;
    const count = g.renderToSim.length;
    const h = FABRIC_HALF_THICKNESS_M;
    for (let r = 0; r < count; r++) {
      const s = g.renderToSim[r] * 3;
      const inner = (r + count) * 3;
      for (let k = 0; k < 3; k++) {
        px[r * 3 + k] = x[s + k] + n[s + k] * h;
        nx[r * 3 + k] = n[s + k];
        px[inner + k] = x[s + k] - n[s + k] * h;
        nx[inner + k] = -n[s + k];
      }
    }
    // Rim normals point out of the fabric edge, perpendicular to the edge and the surface.
    const rimNormal = new Float32Array(this.rimVertices.length * 3);
    const rimOf = new Map<number, number>();
    this.rimVertices.forEach((v, r) => rimOf.set(v, r));
    for (let k = 0; k < this.rimEdges.length; k += 2) {
      const a = g.renderToSim[this.rimEdges[k]] * 3;
      const b = g.renderToSim[this.rimEdges[k + 1]] * 3;
      const [ex, ey, ez] = [x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]];
      const [mx, my, mz] = [n[a] + n[b], n[a + 1] + n[b + 1], n[a + 2] + n[b + 2]];
      const out = [ey * mz - ez * my, ez * mx - ex * mz, ex * my - ey * mx];
      for (const v of [this.rimEdges[k], this.rimEdges[k + 1]]) {
        const r = rimOf.get(v)! * 3;
        for (let c = 0; c < 3; c++) rimNormal[r + c] += out[c];
      }
    }
    this.rimVertices.forEach((v, r) => {
      const s = g.renderToSim[v] * 3;
      const l = Math.hypot(rimNormal[r * 3], rimNormal[r * 3 + 1], rimNormal[r * 3 + 2]) || 1;
      const outer = (this.rimStart + r * 2) * 3;
      const inner = outer + 3;
      for (let c = 0; c < 3; c++) {
        px[outer + c] = x[s + c] + n[s + c] * h;
        px[inner + c] = x[s + c] - n[s + c] * h;
        nx[outer + c] = nx[inner + c] = rimNormal[r * 3 + c] / l;
      }
    });
    position.needsUpdate = true;
    normal.needsUpdate = true;
  }

  private placeCapsule(parts: THREE.Mesh[], offset: number, c: Capsule, shrink: number): void {
    const a = new THREE.Vector3(c.ax, c.ay, c.az);
    const b = new THREE.Vector3(c.bx, c.by, c.bz);
    const r = c.r * shrink;
    const len = a.distanceTo(b);
    const cyl = parts[offset];
    cyl.position.copy(a).add(b).multiplyScalar(0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    cyl.scale.set(r, Math.max(len, 1e-4), r);
    parts[offset + 1].position.copy(a);
    parts[offset + 1].scale.setScalar(r);
    parts[offset + 2].position.copy(b);
    parts[offset + 2].scale.setScalar(r);
  }

  private makeParts(material: THREE.Material, order: number): THREE.Mesh[] {
    return [this.unit, this.cap, this.cap].map((geometry) => {
      const m = new THREE.Mesh(geometry, material);
      m.renderOrder = order;
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    });
  }

  updateBody(capsules: Capsule[], showColliders: boolean): void {
    while (this.proxies.length < capsules.length * 3) {
      this.proxies.push(...this.makeParts(this.proxyMaterial, 1));
      this.debug.push(...this.makeParts(this.debugMaterial, 3));
    }
    capsules.forEach((c, i) => {
      // Slightly smaller than the collider so cloth resting on it is never clipped.
      this.placeCapsule(this.proxies, i * 3, c, 0.92);
      for (let part = 0; part < 3; part++) this.proxies[i * 3 + part].visible = c.occludes !== false;
      this.placeCapsule(this.debug, i * 3, c, 1);
    });
    this.debug.forEach((m) => (m.visible = showColliders));
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
