import * as THREE from 'three';
import type { GarmentMesh } from '@shirt/garment-schema';
import type { Capsule } from '../physics/xpbd';
import type { ImageFit } from '../tracking/body';

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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, transparent: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.root.add(this.mesh);
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8a84, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.3, 0.8, 1);
    this.scene.add(key);
    this.camera.position.z = 3000;
  }

  setGarment(mesh: GarmentMesh): void {
    this.garment = mesh;
    this.simNormals = new Float32Array(mesh.positions.length);
    const count = mesh.renderToSim.length;
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.renderUv, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(mesh.renderTriangles, 1));
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
    for (let r = 0; r < g.renderToSim.length; r++) {
      const s = g.renderToSim[r] * 3;
      px[r * 3] = x[s];
      px[r * 3 + 1] = x[s + 1];
      px[r * 3 + 2] = x[s + 2];
      nx[r * 3] = n[s];
      nx[r * 3 + 1] = n[s + 1];
      nx[r * 3 + 2] = n[s + 2];
    }
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
