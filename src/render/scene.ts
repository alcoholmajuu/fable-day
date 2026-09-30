import * as THREE from 'three';
import { GRID_H, GRID_W } from '../sim/layout';

/** World position of a cell centre (grid is centred on the origin). */
export function cellToWorld(cx: number, cz: number, out = new THREE.Vector3()) {
  return out.set(cx + 0.5 - GRID_W / 2, 0, cz + 0.5 - GRID_H / 2);
}
export const OX = -GRID_W / 2, OZ = -GRID_H / 2;

export class SceneHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly sun: THREE.DirectionalLight;
  target = new THREE.Vector3(-4.5, 0, 2);
  azimuth = Math.PI / 4;
  elevation = 0.62;
  zoom = 16; // half-height in world units
  private targetZoom = 16;
  private targetAzimuth = this.azimuth;
  private targetElevation = this.elevation;
  private panVel = new THREE.Vector2();
  private followTmp = new THREE.Vector3();
  followFn: (() => THREE.Vector3 | null) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0xcfd8e3);
    this.scene.fog = new THREE.Fog(0xcfd8e3, 90, 160);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x8a7a66, 0.85));
    const amb = new THREE.AmbientLight(0xffffff, 0.25); this.scene.add(amb);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    this.sun.position.set(-18, 34, 14);
    this.sun.castShadow = true;
    const lite = new URLSearchParams(location.search).get('lite') === '1';
    if (lite) this.renderer.setPixelRatio(1);
    this.sun.shadow.mapSize.set(lite ? 1024 : 4096, lite ? 1024 : 4096);
    const sc = this.sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 24; sc.bottom = -24; sc.near = 5; sc.far = 90;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5); fill.position.set(20, 18, -24); this.scene.add(fill);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.installControls();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.updateProjection();
  }
  private updateProjection() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const a = w / h; const z = this.zoom;
    this.camera.left = -z * a; this.camera.right = z * a; this.camera.top = z; this.camera.bottom = -z;
    this.camera.updateProjectionMatrix();
  }

  /** Smoothly integrate camera state; call each frame with real dt. */
  update(dt: number) {
    const k = 1 - Math.exp(-dt * 10);
    this.zoom += (this.targetZoom - this.zoom) * k;
    this.azimuth += (this.targetAzimuth - this.azimuth) * k;
    // following someone through the aisles: look down more steeply so racks don't hide them
    const wantElev = this.followFn ? Math.max(this.targetElevation, 1.0) : this.targetElevation;
    this.elevation += (wantElev - this.elevation) * k;
    if (this.followFn) { const p = this.followFn(); if (p) this.target.lerp(this.followTmp.set(p.x, 0, p.z), k); }
    if (this.panVel.lengthSq() > 0) {
      const f = this.forwardXZ(), r = this.rightXZ();
      this.target.addScaledVector(r, this.panVel.x * dt * this.zoom * 1.4).addScaledVector(f, this.panVel.y * dt * this.zoom * 1.4);
      this.followFn = null;
    }
    this.target.x = THREE.MathUtils.clamp(this.target.x, -32, 32); this.target.z = THREE.MathUtils.clamp(this.target.z, -24, 24);
    const d = 90;
    const cy = Math.sin(this.elevation) * d, ch = Math.cos(this.elevation) * d;
    this.camera.position.set(this.target.x + Math.sin(this.azimuth) * ch, cy, this.target.z + Math.cos(this.azimuth) * ch);
    this.camera.lookAt(this.target);
    this.updateProjection();
  }
  forwardXZ() { return new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth)); }
  rightXZ() { return new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth)); }

  focusOn(p: THREE.Vector3, zoom?: number) { this.followFn = null; this.target.set(p.x, 0, p.z); if (zoom) this.targetZoom = zoom; }
  setZoom(z: number) { this.targetZoom = THREE.MathUtils.clamp(z, 3.5, 26); }
  reset() { this.followFn = null; this.target.set(-4.5, 0, 2); this.targetZoom = 16; this.targetAzimuth = Math.PI / 4; this.targetElevation = 0.62; }

  onClick: ((x: number, y: number, shift: boolean) => void) | null = null;
  onDoubleClick: ((x: number, y: number) => void) | null = null;
  onHover: ((x: number, y: number) => void) | null = null;
  private keys = new Set<string>();

  private installControls() {
    const c = this.canvas;
    let down: { x: number; y: number; button: number; moved: boolean; shift: boolean } | null = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, shift: e.shiftKey }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!down) { this.onHover?.(e.clientX, e.clientY); return; }
      const dx = e.clientX - (down.x), dy = e.clientY - (down.y);
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      if (!down.moved) return;
      const pan = down.button === 2 || down.button === 1 || down.shift;
      if (pan) {
        const h = c.clientHeight; const unitsPerPx = (this.zoom * 2) / h;
        const f = this.forwardXZ(), r = this.rightXZ();
        this.target.addScaledVector(r, -dx * unitsPerPx).addScaledVector(f, -dy * unitsPerPx / Math.sin(this.elevation));
        this.followFn = null;
      } else {
        this.targetAzimuth -= dx * 0.006; this.azimuth = this.targetAzimuth;
        this.targetElevation = THREE.MathUtils.clamp(this.targetElevation + dy * 0.004, 0.35, 1.25); this.elevation = this.targetElevation;
      }
      down.x = e.clientX; down.y = e.clientY;
    });
    c.addEventListener('pointerup', e => {
      if (down && !down.moved && down.button === 0) this.onClick?.(e.clientX, e.clientY, e.shiftKey);
      down = null;
    });
    c.addEventListener('dblclick', e => this.onDoubleClick?.(e.clientX, e.clientY));
    c.addEventListener('wheel', e => { e.preventDefault(); this.setZoom(this.targetZoom * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    window.addEventListener('keydown', e => { if ((e.target as HTMLElement)?.tagName === 'INPUT') return; this.keys.add(e.key.toLowerCase()); });
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
  }
  /** Poll keyboard for continuous camera motion. */
  pollKeys(dt: number) {
    const k = this.keys; let px = 0, py = 0;
    if (k.has('a') || k.has('arrowleft')) px -= 1; if (k.has('d') || k.has('arrowright')) px += 1;
    if (k.has('w') || k.has('arrowup')) py += 1; if (k.has('s') || k.has('arrowdown')) py -= 1;
    this.panVel.set(px, py);
    if (k.has('q')) this.targetAzimuth += dt * 1.6; if (k.has('e')) this.targetAzimuth -= dt * 1.6;
    if (k.has('z')) this.setZoom(this.targetZoom * (1 - dt)); if (k.has('x')) this.setZoom(this.targetZoom * (1 + dt));
  }
  /** Unproject screen coords to a ray. */
  ray(x: number, y: number, out = new THREE.Raycaster()) {
    const r = this.canvas.getBoundingClientRect();
    const nx = ((x - r.left) / r.width) * 2 - 1, ny = -((y - r.top) / r.height) * 2 + 1;
    out.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return out;
  }
  groundPoint(x: number, y: number): THREE.Vector3 | null {
    const rc = this.ray(x, y); const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p);
  }
  render() { this.renderer.render(this.scene, this.camera); }
}
