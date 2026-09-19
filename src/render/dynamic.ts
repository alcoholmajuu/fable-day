import * as THREE from 'three';
import type { Simulation } from '../sim/sim';
import type { Container, RackLocation, Role, Spot, Truck, Worker } from '../sim/types';
import { GRID_W } from '../sim/layout';
import { OX, OZ } from './scene';
import { LEVEL_H, RACK_BASE } from './warehouse';
import { Label } from './labels';

const ROLE_COLOR: Record<Role, number> = { receiver: 0x3b7ddd, picker: 0x3faa5c, packer: 0xe8823a, shipper: 0x36b3b8 };
const ROLE_JOBS: Record<Role, string[]> = { receiver: ['UNLOAD', 'INSPECT', 'PUTAWAY'], picker: ['PICK', 'TOTE_RETURN'], packer: ['PACK'], shipper: ['LOAD'] };
const ROLE_NAME: Record<Role, string> = { receiver: 'Receiver', picker: 'Picker', packer: 'Packer', shipper: 'Shipper' };
const CARTON = 0xc79a62, TOTE = 0x3d6fd6, PALLET = 0xb08a5a;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpC = new THREE.Color();

/** Instanced pool that can be rebuilt each time the sim version changes. */
class Pool {
  mesh: THREE.InstancedMesh; n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, scene: THREE.Object3D, shadow = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap); this.mesh.castShadow = shadow; this.mesh.receiveShadow = shadow;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.mesh.count = 0; scene.add(this.mesh);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  begin() { this.n = 0; }
  add(x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, rotY = 0) {
    if (this.n >= (this.mesh.instanceMatrix.count)) return;
    tmpP.set(x, y, z); tmpQ.setFromAxisAngle(UP, rotY); tmpS.set(sx, sy, sz); tmpM.compose(tmpP, tmpQ, tmpS);
    this.mesh.setMatrixAt(this.n, tmpM); this.mesh.setColorAt(this.n, tmpC.setHex(color)); this.n++;
  }
  end() { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
}
const UP = new THREE.Vector3(0, 1, 0);

function stdMat(color: number, rough = 0.8) { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 }); }

/** Stick-figure worker rig. */
class WorkerRig {
  group = new THREE.Group();
  private hips = new THREE.Group(); private torso: THREE.Mesh; private head: THREE.Mesh;
  private lArm = new THREE.Group(); private rArm = new THREE.Group(); private lLeg = new THREE.Group(); private rLeg = new THREE.Group();
  private lFore = new THREE.Group(); private rFore = new THREE.Group();
  private hands = new THREE.Group();
  private pallet: THREE.Group; private tote: THREE.Group; private carton: THREE.Mesh; private toteStack: THREE.Group;
  private palletBoxes: THREE.Mesh[] = []; private toteFill: THREE.Mesh;
  label = new Label(1.0); status = new Label(0.85, 'rgba(255,255,255,0.92)', '#1c2230');
  phase = Math.random() * 10; hit: THREE.Mesh; ring: THREE.Mesh;
  constructor(readonly w: Worker, scene: THREE.Object3D) {
    const skin = stdMat(0x2a2f38, 0.6); const vest = stdMat(ROLE_COLOR[w.role], 0.7); const hat = stdMat(ROLE_COLOR[w.role], 0.5);
    const limbGeo = new THREE.CapsuleGeometry(0.045, 0.32, 4, 8);
    this.group.add(this.hips); this.hips.position.y = 0.72;
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 4, 10), vest); this.torso.position.y = 0.32; this.torso.castShadow = true; this.hips.add(this.torso);
    // hi-vis stripes
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.014, 6, 16), stdMat(0xf5f5f5, 0.5)); stripe.castShadow = false; stripe.rotation.x = Math.PI / 2; stripe.position.y = 0.3; this.torso.add(stripe);
    const stripe2 = stripe.clone(); stripe2.position.y = 0.16; this.torso.add(stripe2);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), stdMat(0xf1c9a5, 0.7)); this.head.position.y = 0.72; this.head.castShadow = true; this.hips.add(this.head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), hat); helmet.position.y = 0.02; this.head.add(helmet);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.025, 14), hat); brim.position.y = 0.02; this.head.add(brim);
    const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.02), stdMat(0x1a1d22)); eyes.position.set(0, 0.0, 0.125); this.head.add(eyes);
    const mk = (parent: THREE.Object3D, pivot: THREE.Group, x: number, y: number, len = 0.32, mat: THREE.Material = skin) => {
      pivot.position.set(x, y, 0); const m = new THREE.Mesh(len === 0.32 ? limbGeo : new THREE.CapsuleGeometry(0.045, len, 4, 8), mat); m.position.y = -len / 2 - 0.02; m.castShadow = len > 0.3; pivot.add(m); parent.add(pivot); return m;
    };
    mk(this.hips, this.lArm, -0.17, 0.5, 0.24, vest); mk(this.hips, this.rArm, 0.17, 0.5, 0.24, vest);
    this.lFore.position.y = -0.28; this.rFore.position.y = -0.28; this.lArm.add(this.lFore); this.rArm.add(this.rFore);
    mk(this.lFore, new THREE.Group(), 0, 0, 0.24); mk(this.rFore, new THREE.Group(), 0, 0, 0.24);
    const legMat = stdMat(0x394252, 0.8);
    mk(this.hips, this.lLeg, -0.08, 0.02, 0.62, legMat); mk(this.hips, this.rLeg, 0.08, 0.02, 0.62, legMat);
    // boots
    for (const leg of [this.lLeg, this.rLeg]) { const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.18), stdMat(0x23262b)); boot.position.set(0, -0.68, 0.03); leg.add(boot); }
    // hands group in front of the torso where carried items sit
    this.hands.position.set(0, 0.1, 0.36); this.hips.add(this.hands);
    // carried pallet (with stacked boxes)
    this.pallet = new THREE.Group(); this.pallet.position.set(0, -0.1, 0.25);
    const pb = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.8), stdMat(PALLET)); pb.castShadow = true; this.pallet.add(pb);
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.34), stdMat(0xffffff)); b.position.set((i % 2 ? 0.19 : -0.19), 0.2 + Math.floor(i / 2) * 0.31, (i % 2 ? 0.19 : -0.19) * (i < 2 ? 1 : -1)); b.castShadow = true; this.pallet.add(b); this.palletBoxes.push(b); }
    this.hands.add(this.pallet);
    this.tote = new THREE.Group(); const tb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.36), stdMat(TOTE)); tb.castShadow = true; this.tote.add(tb);
    this.toteFill = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.28), stdMat(0xffffff)); this.toteFill.position.y = 0.16; this.tote.add(this.toteFill);
    this.toteStack = new THREE.Group(); for (let i = 1; i < 4; i++) { const t = tb.clone(); t.position.y = i * 0.18; this.toteStack.add(t); } this.tote.add(this.toteStack);
    this.hands.add(this.tote);
    this.carton = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.38, 0.4), stdMat(CARTON)); this.carton.castShadow = true; const tape = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.39, 0.41), stdMat(0xeadfc4)); this.carton.add(tape); this.hands.add(this.carton);
    this.pallet.visible = this.tote.visible = this.carton.visible = false;
    // hit target & selection ring
    this.hit = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.9, 8), new THREE.MeshBasicMaterial({ visible: false })); this.hit.position.y = 0.95; this.hit.userData.workerId = w.id; this.group.add(this.hit);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 32), new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.9, depthWrite: false })); this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.02; this.ring.visible = false; this.group.add(this.ring);
    this.label.sprite.position.y = 2.15; this.group.add(this.label.sprite);
    this.status.sprite.position.y = 2.5; this.group.add(this.status.sprite);
    this.label.setText(w.name, 'rgba(20,24,32,0.85)', '#fff');
    scene.add(this.group);
  }
  /** Visual-only nudge so stationary workers sharing a cell don't overlap (sim positions are untouched). */
  sepX = 0; sepZ = 0;
  update(sim: Simulation, dt: number, selected: boolean, labelsVisible: boolean, zoomFactor: number) {
    const w = this.w;
    this.label.setZoomFactor(zoomFactor); this.status.setZoomFactor(zoomFactor);
    this.label.sprite.position.y = 2.0 + 0.3 * zoomFactor; this.status.sprite.position.y = 2.0 + 0.3 * zoomFactor + 0.8 * zoomFactor + 0.08;
    this.group.position.set(OX + w.x + this.sepX, 0, OZ + w.z + this.sepZ);
    // smooth facing
    let d = w.facing - this.group.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); this.group.rotation.y += d * Math.min(1, dt * 12);
    const carrying = w.carrying ? sim.containers.get(w.carrying) : null;
    const walking = w.state === 'walking';
    const working = w.state === 'working';
    if (walking) this.phase += dt * 9.5 * (carrying?.kind === 'pallet' ? 0.85 : 1);
    else this.phase += dt * 2.2;
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const swing = walking ? 0.75 : 0;
    this.lLeg.rotation.x = s * swing; this.rLeg.rotation.x = -s * swing;
    this.hips.position.y = 0.72 + (walking ? Math.abs(c) * 0.04 : 0) + (working ? Math.sin(this.phase * 2.5) * 0.015 : 0);
    if (carrying) { // arms forward holding the load
      const heavy = carrying.kind === 'pallet';
      this.lArm.rotation.x = this.rArm.rotation.x = heavy ? -1.25 : -1.0; this.lFore.rotation.x = this.rFore.rotation.x = heavy ? -0.6 : -1.1;
      this.lArm.rotation.z = 0.15; this.rArm.rotation.z = -0.15;
      this.torso.rotation.x = heavy ? 0.12 : 0.04;
    } else if (working) { // reach/lift loop
      const p = Math.sin(this.phase * 2.5);
      this.lArm.rotation.x = -0.9 + p * 0.5; this.rArm.rotation.x = -0.9 - p * 0.5; this.lFore.rotation.x = this.rFore.rotation.x = -0.6;
      this.lArm.rotation.z = 0.2; this.rArm.rotation.z = -0.2; this.torso.rotation.x = 0.18 + p * 0.06;
    } else { // walk / idle arm swing
      this.lArm.rotation.x = -s * swing * 0.6; this.rArm.rotation.x = s * swing * 0.6; this.lFore.rotation.x = this.rFore.rotation.x = -0.25;
      this.lArm.rotation.z = 0.08; this.rArm.rotation.z = -0.08; this.torso.rotation.x = walking ? 0.06 : 0;
    }
    this.hips.rotation.y = walking ? s * 0.08 : 0;
    // idle: glance around; working: look down at the task
    this.head.rotation.y = !walking && !working ? Math.sin(this.phase * 0.35) * 0.5 : 0;
    this.head.rotation.x = working ? 0.35 : 0;
    // carried item
    this.pallet.visible = this.tote.visible = this.carton.visible = false;
    if (carrying) {
      if (carrying.kind === 'pallet') { this.pallet.visible = true; const sku = sim.skus.get(carrying.lines[0]?.skuId ?? ''); const n = Math.min(4, Math.max(1, Math.ceil((carrying.lines[0]?.qty ?? 0) / 4))); this.palletBoxes.forEach((b, i) => { b.visible = i < n; (b.material as THREE.MeshStandardMaterial).color.setHex(sku?.color ?? 0xffffff); }); }
      else if (carrying.kind === 'tote') { this.tote.visible = true; const first = carrying.lines[0]; this.toteFill.visible = !!first; if (first) (this.toteFill.material as THREE.MeshStandardMaterial).color.setHex(sim.skus.get(first.skuId)!.color); this.toteStack.children.forEach((t, i) => t.visible = i < w.carryExtra.length); }
      else this.carton.visible = true;
    }
    this.ring.visible = selected;
    // labels
    const job = w.jobId ? sim.jobs.get(w.jobId) : null;
    const showText = labelsVisible || selected;
    this.label.sprite.visible = showText; if (showText) this.label.setText(w.name, 'rgba(20,24,32,0.85)', '#fff');
    if (showText) {
      if (job) {
        const col = JOB_COLORS[job.type] ?? '#333';
        const prog = working && w.workTotal > 0.8 ? ' ' + progressGlyph(1 - w.workTimer / w.workTotal) : '';
        const helping = !ROLE_JOBS[w.role].includes(job.type) && job.type !== 'TOTE_RETURN';
        this.status.setText(`${job.type}${helping ? ' (helping)' : ''}: ${w.workLabel || job.summary}${prog}`, 'rgba(255,255,255,0.94)', col);
      }
      else this.status.setText('Idle', 'rgba(255,255,255,0.7)', '#6b7280');
    } else this.status.sprite.visible = false;
    this.status.sprite.visible = showText; if (!showText) this.label.sprite.visible = false;
  }
}
function progressGlyph(f: number) { const n = Math.round(Math.max(0, Math.min(1, f)) * 5); return '▰'.repeat(n) + '▱'.repeat(5 - n); }
export const JOB_COLORS: Record<string, string> = { UNLOAD: '#2d62c7', INSPECT: '#a97e11', PUTAWAY: '#4b5563', PICK: '#2c8a45', PACK: '#c8641f', LOAD: '#20858f', TOTE_RETURN: '#6b7280' };

class TruckRig {
  group = new THREE.Group(); cargo: THREE.Mesh[] = []; door: THREE.Mesh;
  constructor(readonly tr: Truck, scene: THREE.Object3D) {
    const outbound = tr.kind === 'outbound';
    const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.4, 2.3), stdMat(outbound ? 0xf3f4f6 : 0xf3f4f6, 0.6)); body.position.set(0, 1.85, 0); body.castShadow = true; body.receiveShadow = true; this.group.add(body);
    // stripe
    const strip = new THREE.Mesh(new THREE.BoxGeometry(6.42, 0.35, 2.32), stdMat(outbound ? 0x36b3b8 : 0x3b7ddd, 0.6)); strip.position.set(0, 1.4, 0); this.group.add(strip);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 2.1), stdMat(outbound ? 0x257f88 : 0x2d62c7, 0.5)); cab.position.set(-4.2, 1.35, 0); cab.castShadow = true; this.group.add(cab);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 1.8), stdMat(0xa8d8ff, 0.2)); glass.position.set(-5.06, 1.7, 0); this.group.add(glass);
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.25, 1.6), stdMat(0x2a2d33)); chassis.position.set(-0.6, 0.6, 0); this.group.add(chassis);
    for (const x of [-4.1, 1.2, 2.4]) for (const z of [-0.95, 0.95]) { const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14), stdMat(0x1c1f24, 0.9)); wh.rotation.x = Math.PI / 2; wh.position.set(x, 0.42, z); wh.castShadow = true; this.group.add(wh); }
    this.door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 2.2), stdMat(0xd7dbe0)); this.door.position.set(3.2, 1.85, 0); this.group.add(this.door);
    // cargo slots visible through open rear
    for (let i = 0; i < 14; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.6), stdMat(CARTON)); b.position.set(2.6 - Math.floor(i / 4) * 0.75, 1.0 + (i % 2) * 0.6, ((i >> 1) % 2 ? 0.55 : -0.55)); b.visible = false; this.group.add(b); this.cargo.push(b); }
    this.hit = new THREE.Mesh(new THREE.BoxGeometry(8.4, 3, 2.5), new THREE.MeshBasicMaterial({ visible: false })); this.hit.position.set(-0.6, 1.5, 0); this.hit.userData.truckId = tr.id; this.group.add(this.hit);
    scene.add(this.group);
  }
  hit: THREE.Mesh;
  update(sim: Simulation) {
    const tr = this.tr; const outbound = tr.kind === 'outbound';
    const dockX = outbound ? OX + GRID_W + 3.4 : OX - 3.4;
    const parkedX = outbound ? dockX + 40 : dockX - 40;
    const e = tr.t < 1 ? 1 - Math.pow(1 - tr.t, 3) : 1;
    const x = parkedX + (dockX - parkedX) * e;
    this.group.position.set(x, 0, OZ + tr.dockCell.cz + 0.5);
    this.group.rotation.y = outbound ? Math.PI : 0; // rear faces the dock
    this.door.visible = tr.state !== 'docked';
    const n = tr.containerIds.length;
    this.cargo.forEach((b, i) => {
      b.visible = i < n; if (i < n) { const c = sim.containers.get(tr.containerIds[i]); const m = b.material as THREE.MeshStandardMaterial; if (c?.kind === 'pallet') { m.color.setHex(sim.skus.get(c.lines[0].skuId)?.color ?? 0xffffff); b.scale.set(1, 1, 1); } else { m.color.setHex(CARTON); b.scale.set(0.8, 0.7, 0.8); } }
    });
  }
}

export class DynamicRenderer {
  private boxes: Pool; private pallets: Pool; private totes: Pool; private cartons: Pool; private toteFills: Pool; private tapes: Pool;
  private badges: Pool;
  private workers = new Map<string, WorkerRig>(); private trucks = new Map<string, TruckRig>();
  private lastVersion = -1;
  private hl = new THREE.Group(); private pathLine: THREE.Line; private hlBoxes: THREE.Mesh[] = [];
  labelsVisible = true;
  /** Camera half-height; labels hide when zoomed far out. */
  zoomLevel = 15;
  constructor(readonly sim: Simulation, readonly scene: THREE.Scene) {
    const grp = new THREE.Group(); grp.name = 'dynamic'; scene.add(grp);
    this.boxes = new Pool(new THREE.BoxGeometry(0.36, 0.3, 0.36), stdMat(0xffffff, 0.75), 6000, grp);
    this.pallets = new Pool(new THREE.BoxGeometry(0.86, 0.1, 0.86), stdMat(PALLET, 0.9), 900, grp);
    this.totes = new Pool(new THREE.BoxGeometry(0.5, 0.28, 0.36), stdMat(TOTE, 0.6), 80, grp);
    this.toteFills = new Pool(new THREE.BoxGeometry(0.42, 0.05, 0.28), stdMat(0xffffff, 0.8), 80, grp, false);
    this.cartons = new Pool(new THREE.BoxGeometry(0.5, 0.42, 0.44), stdMat(CARTON, 0.85), 120, grp);
    this.tapes = new Pool(new THREE.BoxGeometry(0.1, 0.43, 0.45), stdMat(0xeadfc4, 0.7), 120, grp, false);
    this.badges = new Pool(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 200, grp, false);
    scene.add(this.hl);
    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd23a, linewidth: 2, transparent: true, opacity: 0.95, depthTest: false })); this.pathLine.renderOrder = 20; this.hl.add(this.pathLine);
    for (const w of sim.workers) this.workers.set(w.id, new WorkerRig(w, grp));
  }
  get workerHits() { return [...this.workers.values()].map(r => r.hit); }
  get truckHits() { return [...this.trucks.values()].map(r => r.hit); }

  update(dt: number, selected: { kind: string; id: string } | null) {
    const sim = this.sim;
    if (sim.version !== this.lastVersion) { this.rebuildContainers(); this.lastVersion = sim.version; }
    for (const w of sim.workers) if (!this.workers.has(w.id)) this.workers.set(w.id, new WorkerRig(w, this.scene.getObjectByName('dynamic')!));
    this.separate();
    for (const rig of this.workers.values()) rig.update(sim, dt, selected?.kind === 'worker' && selected.id === rig.w.id, this.labelsVisible && this.zoomLevel < 11, Math.max(0.35, this.zoomLevel / 10));
    // trucks
    for (const tr of sim.trucks.values()) { let rig = this.trucks.get(tr.id); if (!rig) { rig = new TruckRig(tr, this.scene); this.trucks.set(tr.id, rig); } rig.update(sim); }
    for (const [id, rig] of this.trucks) if (!sim.trucks.has(id)) { this.scene.remove(rig.group); disposeGroup(rig.group); this.trucks.delete(id); }
    this.updateHighlight(selected);
  }

  private separate() {
    const rigs = [...this.workers.values()];
    for (const r of rigs) { r.sepX *= 0.9; r.sepZ *= 0.9; }
    for (let i = 0; i < rigs.length; i++) for (let j = i + 1; j < rigs.length; j++) {
      const a = rigs[i].w, b = rigs[j].w;
      if (a.state === 'walking' || b.state === 'walking') continue;
      const dx = (a.x + rigs[i].sepX) - (b.x + rigs[j].sepX), dz = (a.z + rigs[i].sepZ) - (b.z + rigs[j].sepZ);
      const d = Math.hypot(dx, dz); if (d > 0.5 || d < 1e-4) continue;
      const push = (0.5 - d) * 0.5; const nx = dx / d, nz = dz / d;
      rigs[i].sepX = clamp(rigs[i].sepX + nx * push, -0.3, 0.3); rigs[i].sepZ = clamp(rigs[i].sepZ + nz * push, -0.3, 0.3);
      rigs[j].sepX = clamp(rigs[j].sepX - nx * push, -0.3, 0.3); rigs[j].sepZ = clamp(rigs[j].sepZ - nz * push, -0.3, 0.3);
    }
  }
  /** Rebuild all resting containers and rack stock from sim state. */
  private rebuildContainers() {
    const sim = this.sim;
    for (const p of [this.boxes, this.pallets, this.totes, this.toteFills, this.cartons, this.tapes, this.badges]) p.begin();
    for (const l of sim.racks.values()) {
      if (l.qty <= 0 && l.incoming <= 0) continue;
      const x = OX + l.cell.cx + 0.5, z = OZ + l.cell.cz + 0.5, y = RACK_BASE + l.level * LEVEL_H;
      this.pallets.add(x, y + 0.05, z, PALLET);
      if (l.qty > 0) this.addBoxStack(x, y + 0.1, z, sim.skus.get(l.skuId!)!.color, l.qty, l.reserved);
    }
    for (const s of sim.spots.values()) {
      const x = OX + s.cell.cx + 0.5, z = OZ + s.cell.cz + 0.5;
      s.containerIds.forEach((cid, i) => { const c = sim.containers.get(cid); if (c) this.addContainer(c, s, i, x, z); });
    }
    for (const p of [this.boxes, this.pallets, this.totes, this.toteFills, this.cartons, this.tapes, this.badges]) p.end();
  }
  private addBoxStack(x: number, y: number, z: number, color: number, qty: number, reserved: number) {
    const n = Math.min(8, Math.max(1, Math.ceil(qty / 2)));
    for (let i = 0; i < n; i++) {
      const k = i % 4;
      const bx = x + (k % 2 ? 0.2 : -0.2), bz = z + ((k < 2) ? -0.2 : 0.2), by = y + 0.15 + Math.floor(i / 4) * 0.31;
      // boxes reserved for picks are shown slightly darker to make reservation visible
      const reservedBox = i >= n - Math.ceil(reserved / 2) && reserved > 0;
      this.boxes.add(bx, by, bz, reservedBox ? darken(color, 0.55) : color, 1, 1, 1, i % 2 ? 0.05 : -0.04);
    }
  }
  private addContainer(c: Container, s: Spot, i: number, x: number, z: number) {
    const sim = this.sim;
    if (c.kind === 'pallet') {
      const y = s.kind === 'inspect_bench' ? 0.9 : 0;
      this.pallets.add(x, y + 0.05, z, PALLET);
      const sku = sim.skus.get(c.lines[0].skuId)!; this.addBoxStack(x, y + 0.1, z, sku.color, c.lines[0].qty, 0);
      // status badge above: yellow = awaiting inspection, green = inspected
      this.badges.add(x, y + 1.05, z, c.inspected ? 0x3faa5c : 0xf2c53a, 1, 1, 1, Math.PI / 4);
    } else if (c.kind === 'tote') {
      let y = 0.07, ox = 0, oz = 0;
      if (s.kind === 'tote_shelf') { y = 0.07 + Math.floor(i / 2) * 0.5 + 0.02; ox = 0; oz = (i % 2 ? 0.22 : -0.22); }
      else if (s.kind === 'pack_bench') { y = 0.9 + 0.14; }
      else if (s.kind === 'pack_out') { y = 0.14 + i * 0.16; }
      else { y = 0.14; ox = ((i % 3) - 1) * 0.3; oz = 0; }
      const rot = s.kind === 'tote_shelf' ? Math.PI / 2 : 0;
      this.totes.add(x + ox, y, z + oz, c.orderId ? TOTE : 0x8aa7d9, 1, 1, 1, rot);
      if (c.lines.length) this.toteFills.add(x + ox, y + 0.15, z + oz, sim.skus.get(c.lines[0].skuId)!.color, 1, 1, 1, rot);
    } else {
      const y = 0.21 + i * 0.44; const rot = (i % 2) * 0.12;
      this.cartons.add(x, y, z, CARTON, 1, 1, 1, rot); this.tapes.add(x, y + 0.005, z, 0xeadfc4, 1, 1, 1, rot);
    }
  }

  private hlGeo = new THREE.BoxGeometry(1.04, 1, 1.04);
  private hlMats = new Map<number, THREE.MeshBasicMaterial>();
  private hlUsed = 0;
  private updateHighlight(sel: { kind: string; id: string } | null) {
    // pooled highlight boxes: reuse meshes, never allocate per frame
    this.hlUsed = 0;
    this.pathLine.visible = false;
    if (!sel) { for (const b of this.hlBoxes) b.visible = false; return; }
    const sim = this.sim;
    const mark = (cx: number, cz: number, y: number, h: number, color: number) => {
      let m = this.hlBoxes[this.hlUsed];
      if (!m) { m = new THREE.Mesh(this.hlGeo); this.hl.add(m); this.hlBoxes.push(m); }
      let mat = this.hlMats.get(color); if (!mat) { mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false }); this.hlMats.set(color, mat); }
      m.material = mat; m.scale.set(1, h, 1); m.position.set(OX + cx + 0.5, y + h / 2, OZ + cz + 0.5); m.visible = true; this.hlUsed++;
    };
    let job = null as ReturnType<typeof sim.jobs.get> | null; let worker: Worker | undefined;
    if (sel.kind === 'worker') { worker = sim.workers.find(w => w.id === sel.id); job = worker?.jobId ? sim.jobs.get(worker.jobId) ?? null : null; }
    else if (sel.kind === 'order') { const o = sim.orders.get(sel.id); job = o?.jobId ? sim.jobs.get(o.jobId) ?? null : null; if (!job) for (const j of sim.jobs.values()) if (j.refs.orderId === sel.id) { job = j; break; } worker = job?.workerId ? sim.workers.find(w => w.id === job!.workerId) : undefined; for (const l of o?.lines ?? []) for (const f of l.fromLocations) { const loc = sim.racks.get(f.locId)!; mark(loc.cell.cx, loc.cell.cz, RACK_BASE + loc.level * LEVEL_H, LEVEL_H - 0.1, 0x3faa5c); } if (o?.toteId) this.markContainer(o.toteId, mark); if (o?.cartonId) this.markContainer(o.cartonId, mark); }
    else if (sel.kind === 'rack') { const l = sim.racks.get(sel.id); if (l) mark(l.cell.cx, l.cell.cz, RACK_BASE + l.level * LEVEL_H, LEVEL_H - 0.1, 0xffd23a); }
    else if (sel.kind === 'spot') { const s = sim.spots.get(sel.id); if (s) mark(s.cell.cx, s.cell.cz, 0, 1.2, 0xffd23a); }
    else if (sel.kind === 'station') { const st = sim.stations.get(sel.id); if (st) for (const c of st.cells) mark(c.cx, c.cz, 0, 1.2, 0xffd23a); }
    else if (sel.kind === 'truck') { const t = sim.trucks.get(sel.id); if (t) mark(t.dockCell.cx, t.dockCell.cz, 0, 0.15, 0xffd23a); }
    if (job) {
      for (const id of job.refs.locationIds ?? []) { const l = sim.racks.get(id); if (l) mark(l.cell.cx, l.cell.cz, RACK_BASE + l.level * LEVEL_H, LEVEL_H - 0.1, 0x3faa5c); }
      for (const id of job.refs.spotIds ?? []) { const s = sim.spots.get(id); if (s) mark(s.cell.cx, s.cell.cz, 0, 1.0, 0x9c6ad6); }
    }
    if (worker) {
      const pts: THREE.Vector3[] = [new THREE.Vector3(OX + worker.x, 0.08, OZ + worker.z)];
      for (let i = worker.pathIdx; i < worker.path.length; i++) pts.push(new THREE.Vector3(OX + worker.path[i].cx + 0.5, 0.08, OZ + worker.path[i].cz + 0.5));
      if (pts.length > 1) { this.pathLine.geometry.dispose(); this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts); this.pathLine.visible = true; }
      // also mark the current goto target
      const step = job?.steps[job.stepIdx]; if (step?.kind === 'goto') mark(step.cell.cx, step.cell.cz, 0, 0.15, 0xffd23a);
    }
    for (let i = this.hlUsed; i < this.hlBoxes.length; i++) this.hlBoxes[i].visible = false;
  }
  private markContainer(cid: string, mark: (cx: number, cz: number, y: number, h: number, color: number) => void) {
    const c = this.sim.containers.get(cid); if (!c?.spotId) return; const s = this.sim.spots.get(c.spotId)!; mark(s.cell.cx, s.cell.cz, 0, 1.0, 0x3d6fd6);
  }
  workerWorldPos(id: string) { const r = this.workers.get(id); return r ? r.group.position.clone() : null; }
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function darken(hex: number, f: number) { const c = new THREE.Color(hex); c.multiplyScalar(f); return c.getHex(); }
function disposeGroup(g: THREE.Object3D) { g.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose(); }); }
export { ROLE_NAME, ROLE_COLOR };
