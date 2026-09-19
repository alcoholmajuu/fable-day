import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();
const CACHE_MAX = 300;
export function textTexture(text: string, opts: { font?: string; color?: string; bg?: string; pad?: number; w?: number; h?: number } = {}) {
  const key = JSON.stringify([text, opts]);
  let t = cache.get(key);
  if (t) { cache.delete(key); cache.set(key, t); return t; } // LRU touch
  if (cache.size >= CACHE_MAX) { const [k, old] = cache.entries().next().value as [string, THREE.Texture]; cache.delete(k); old.dispose(); }
  const font = opts.font ?? 'bold 40px "Inter", system-ui, sans-serif';
  const c = document.createElement('canvas'); const ctx = c.getContext('2d')!;
  ctx.font = font; const m = ctx.measureText(text); const pad = opts.pad ?? 16;
  c.width = opts.w ?? Math.ceil(m.width + pad * 2); c.height = opts.h ?? 64;
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  if (opts.bg) { ctx.fillStyle = opts.bg; roundRect(ctx, 0, 0, c.width, c.height, 14); ctx.fill(); }
  ctx.fillStyle = opts.color ?? '#ffffff'; ctx.fillText(text, c.width / 2, c.height / 2);
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.minFilter = THREE.LinearMipmapLinearFilter;
  (t as any).aspect = c.width / c.height;
  cache.set(key, t); return t;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
/** Flat text decal lying on the floor. */
export function floorText(text: string, height: number, color: string, alpha = 0.9) {
  const tex = textTexture(text, { color, font: 'bold 56px "Inter", system-ui, sans-serif', h: 72 });
  const aspect = (tex as any).aspect as number;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: alpha, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 2;
  return m;
}
/** Billboard sprite; call setText to update. */
export class Label {
  sprite: THREE.Sprite; private text = ''; private mat: THREE.SpriteMaterial;
  constructor(readonly scale = 1, private bg = 'rgba(20,24,32,0.82)', private color = '#fff') {
    this.mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.sprite = new THREE.Sprite(this.mat); this.sprite.renderOrder = 10; this.sprite.visible = false;
  }
  setText(t: string, bg = this.bg, color = this.color) {
    if (t === this.text && bg === this.bg && color === this.color) return;
    this.text = t; this.bg = bg; this.color = color;
    if (!t) { this.sprite.visible = false; return; }
    const tex = textTexture(t, { bg, color, font: 'bold 34px "Inter", system-ui, sans-serif', h: 52, pad: 18 });
    this.mat.map = tex; this.mat.needsUpdate = true;
    this.aspect = (tex as any).aspect as number;
    this.applyScale();
    this.sprite.visible = true;
  }
  private aspect = 1; zoomFactor = 1;
  /** Keep labels roughly constant in screen space: pass camera half-height / reference. */
  setZoomFactor(f: number) { if (Math.abs(f - this.zoomFactor) > 0.01) { this.zoomFactor = f; this.applyScale(); } }
  private applyScale() { const h = 0.55 * this.scale * this.zoomFactor; this.sprite.scale.set(h * this.aspect, h, 1); }
}
