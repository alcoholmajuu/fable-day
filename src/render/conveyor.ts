import * as THREE from 'three';
import type { Simulation } from '../sim/sim';
import type { Segment } from '../sim/conveyor';
import { OX, OZ } from './scene';
import { floorText } from './labels';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const BELT_H = 0.62;          // top-of-roller height
const W = 0.72;               // conveyor width
const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25, ...extra });

/** Static conveyor equipment + animated rollers/diverters/sensors + cartons riding the belts. */
export class ConveyorRenderer {
  group = new THREE.Group();
  hits: THREE.Mesh[] = [];
  private rollers!: THREE.InstancedMesh; private rollerSeg: Segment[] = []; private rollerAngle = 0;
  private cartons: THREE.InstancedMesh; private tapes: THREE.InstancedMesh; private labelsCache = new Map<string, THREE.Object3D>();
  private diverterArms = new Map<string, THREE.Group>();
  private scannerLight!: THREE.Mesh; private scannerBeam!: THREE.Mesh;
  private laneLeds = new Map<string, THREE.Mesh>(); private indLeds = new Map<string, THREE.Mesh>();
  private ledGreen = std(0x3faa5c, { emissive: 0x2fd66a, emissiveIntensity: 1.2, roughness: 0.4 });
  private ledRed = std(0xd9403a, { emissive: 0xff3b3b, emissiveIntensity: 1.4, roughness: 0.4 });
  private ledAmber = std(0xe0b23a, { emissive: 0xffb020, emissiveIntensity: 1.2, roughness: 0.4 });
  private spin = new THREE.Quaternion();
  private tmp = { x: 0, z: 0, ang: 0 }; private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private sc = new THREE.Vector3(1, 1, 1);

  constructor(readonly sim: Simulation, scene: THREE.Scene) {
    scene.add(this.group); this.group.name = 'conveyor';
    const frameMat = std(0x4a5160), legMat = std(0x353b47), railMat = std(0xb9c0cc, { roughness: 0.45 }), sideMat = std(0x2f6fdc, { roughness: 0.55 });
    const frames: THREE.BufferGeometry[] = [], legs: THREE.BufferGeometry[] = [], rails: THREE.BufferGeometry[] = [], sides: THREE.BufferGeometry[] = [];
    const rollerPositions: { x: number; z: number; ang: number; seg: Segment }[] = [];
    const cv = sim.conveyor;
    for (const seg of cv.segments.values()) {
      for (let i = 1; i < seg.points.length; i++) {
        const a = seg.points[i - 1], b = seg.points[i]; const len = Math.hypot(b.x - a.x, b.z - a.z); if (len < 1e-3) continue;
        const cx = OX + (a.x + b.x) / 2, cz = OZ + (a.z + b.z) / 2; const ang = Math.atan2(b.x - a.x, b.z - a.z);
        const rot = new THREE.Matrix4().makeRotationY(ang);
        const place = (geo: THREE.BufferGeometry, dx: number, dy: number, dz: number) => { geo.applyMatrix4(new THREE.Matrix4().makeTranslation(dx, dy, dz)).applyMatrix4(rot).applyMatrix4(new THREE.Matrix4().makeTranslation(cx, 0, cz)); return geo; };
        // bed (frame) and blue side channels
        frames.push(place(new THREE.BoxGeometry(W, 0.12, len + 0.04), 0, BELT_H - 0.12, 0));
        for (const sx of [-1, 1]) sides.push(place(new THREE.BoxGeometry(0.05, 0.16, len + 0.04), sx * (W / 2 - 0.02), BELT_H - 0.02, 0));
        // guard rails on lanes and main
        if (seg.kind !== 'induction') for (const sx of [-1, 1]) { rails.push(place(new THREE.BoxGeometry(0.03, 0.03, len), sx * (W / 2 + 0.05), BELT_H + 0.32, 0)); for (let k = -len / 2 + 0.4; k < len / 2; k += 1.5) rails.push(place(new THREE.BoxGeometry(0.03, 0.34, 0.03), sx * (W / 2 + 0.05), BELT_H + 0.15, k)); }
        // legs every ~1.6 units
        for (let k = -len / 2 + 0.35; k < len / 2; k += 1.6) for (const sx of [-1, 1]) legs.push(place(new THREE.BoxGeometry(0.06, BELT_H - 0.12, 0.06), sx * (W / 2 - 0.08), (BELT_H - 0.12) / 2, k));
        // roller positions
        for (let k = 0.14; k < len - 0.05; k += 0.27) { const t = k / len; rollerPositions.push({ x: cx + (b.x - a.x) * (t - 0.5), z: cz + (b.z - a.z) * (t - 0.5), ang, seg }); }
      }
      // hit box per segment
      const pts = seg.points; const minx = Math.min(...pts.map(p => p.x)), maxx = Math.max(...pts.map(p => p.x)), minz = Math.min(...pts.map(p => p.z)), maxz = Math.max(...pts.map(p => p.z));
      const hb = new THREE.Mesh(new THREE.BoxGeometry(maxx - minx + W, 1.0, maxz - minz + W), new THREE.MeshBasicMaterial({ visible: false })); hb.position.set(OX + (minx + maxx) / 2, 0.5, OZ + (minz + maxz) / 2); hb.userData.conveyorId = seg.id; this.group.add(hb); this.hits.push(hb);
      // lane end: stop plate, photo-eye LED and sign
      if (seg.kind === 'lane') {
        const end = seg.points[seg.points.length - 1];
        const stop = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, W + 0.1), railMat); stop.position.set(OX + end.x + 0.08, BELT_H + 0.1, OZ + end.z); this.group.add(stop);
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), this.ledGreen); led.position.set(OX + end.x + 0.08, BELT_H + 0.32, OZ + end.z - W / 2 - 0.06); this.group.add(led); this.laneLeds.set(seg.id, led);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.9), legMat); post.position.set(OX + end.x + 0.5, 0.95, OZ + end.z - 0.6); this.group.add(post);
        const sign = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.5, 0.05), std(0x9c6ad6, { roughness: 0.7, metalness: 0.05 })); sign.position.set(OX + end.x + 0.5, 2.0, OZ + end.z - 0.6); sign.rotation.y = Math.PI / 2; this.group.add(sign);
        const t = floorText(seg.name.replace('DOCK-', ''), 0.26, '#ffffff', 1); t.rotation.set(0, Math.PI / 2, 0); t.position.set(OX + end.x + 0.5 - 0.03, 2.0, OZ + end.z - 0.6); this.group.add(t);
        const t2 = floorText(seg.name.replace('DOCK-', ''), 0.26, '#ffffff', 1); t2.rotation.set(0, -Math.PI / 2, 0); t2.position.set(OX + end.x + 0.5 + 0.03, 2.0, OZ + end.z - 0.6); this.group.add(t2);
      }
      if (seg.kind === 'induction') { // induction: photo-eye LED at the entry
        const p0 = seg.points[0]; const led = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), this.ledGreen); led.position.set(OX + p0.x + 0.1, BELT_H + 0.2, OZ + p0.z - W / 2 - 0.06); this.group.add(led); this.indLeds.set(seg.id, led);
      }
    }
    const merge = (geos: THREE.BufferGeometry[], mat: THREE.Material) => { const g = mergeGeometries(geos, false); if (!g) return; geos.forEach(x => x.dispose()); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; this.group.add(m); };
    merge(frames, frameMat); merge(legs, legMat); merge(rails, railMat); merge(sides, sideMat);
    // rollers (instanced, rotate while running)
    const rg = new THREE.CylinderGeometry(0.05, 0.05, W - 0.1, 10); rg.rotateZ(Math.PI / 2);
    this.rollers = new THREE.InstancedMesh(rg, std(0x8e96a3, { roughness: 0.35, metalness: 0.6 }), rollerPositions.length);
    rollerPositions.forEach((r, i) => { this.rollerSeg.push(r.seg); this.m4.compose(this.v.set(r.x, BELT_H - 0.03, r.z), this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.ang), this.sc); this.rollers.setMatrixAt(i, this.m4); });
    this.rollers.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.rollers.castShadow = false; this.rollers.receiveShadow = true; this.group.add(this.rollers);
    // scanner arch over the main line
    const scan = cv.scanners[0]; const main = cv.segments.get(scan.segId)!; const sp = cv.pointAt(main, scan.pos);
    const archMat = std(0xf2c53a, { roughness: 0.5, metalness: 0.2 });
    for (const sx of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.5, 0.08), archMat); post.position.set(OX + sp.x + sx * (W / 2 + 0.15), 0.75, OZ + sp.z); post.castShadow = true; this.group.add(post); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.38, 0.14, 0.24), archMat); beam.position.set(OX + sp.x, 1.55, OZ + sp.z); beam.castShadow = true; this.group.add(beam);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.3), std(0x2b2f36)); head.position.set(OX + sp.x, 1.4, OZ + sp.z); this.group.add(head);
    this.scannerLight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.12), this.ledRed.clone()); this.scannerLight.position.set(OX + sp.x, 1.3, OZ + sp.z); this.group.add(this.scannerLight);
    this.scannerBeam = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.2, 0.7), new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false })); this.scannerBeam.position.set(OX + sp.x, BELT_H + 0.4, OZ + sp.z); this.scannerBeam.rotation.y = Math.PI / 2; this.group.add(this.scannerBeam);
    const label = floorText('SCAN', 0.3, '#1c2230', 1); label.rotation.set(0, Math.PI / 2, 0); label.position.set(OX + sp.x + W / 2 + 0.19, 1.55, OZ + sp.z); this.group.add(label);
    // diverters: pivoting arm on the west side of the main line that swings across when active
    for (const d of cv.diverters) {
      const p = cv.pointAt(main, d.pos); const lane = cv.segments.get(d.laneId)!; const laneDir = Math.sign(lane.points[1].x - lane.points[0].x) || 1;
      const arm = new THREE.Group(); arm.position.set(OX + p.x - laneDir * (W / 2 + 0.06), BELT_H + 0.12, OZ + p.z - 0.55);
      const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.36, 12), std(0x2b2f36)); pivot.position.y = 0.06; arm.add(pivot);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.26, 1.15), std(0xe8843a, { roughness: 0.5 })); blade.position.set(0, 0.08, 0.55); blade.castShadow = true; arm.add(blade);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), this.ledAmber); led.position.set(-laneDir * 0.12, 0.3, 0); arm.add(led);
      arm.userData.laneDir = laneDir; this.group.add(arm); this.diverterArms.set(d.id, arm);
      // sensor post at the diverter
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.05), legMat); post.position.set(OX + p.x - laneDir * (W / 2 + 0.2), 0.45, OZ + p.z + 0.5); this.group.add(post);
    }
    // cartons riding the conveyor
    this.cartons = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.42, 0.44), std(0xc79a62, { roughness: 0.85, metalness: 0.05 }), 120); this.cartons.castShadow = true; this.cartons.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.cartons);
    this.tapes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.43, 0.45), std(0xeadfc4, { roughness: 0.7, metalness: 0 }), 120); this.tapes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.tapes);
  }

  update(dt: number, simDt: number) {
    const cv = this.sim.conveyor; const t = this.sim.time;
    // cartons
    let n = 0;
    for (const seg of cv.segments.values()) for (const id of seg.cartons) {
      const c = this.sim.containers.get(id); if (!c || n >= 120) continue;
      cv.pointAt(seg, c.convPos, this.tmp);
      this.m4.compose(this.v.set(OX + this.tmp.x, BELT_H + 0.21, OZ + this.tmp.z), this.q.setFromAxisAngle(UP, this.tmp.ang), this.sc);
      this.cartons.setMatrixAt(n, this.m4); this.tapes.setMatrixAt(n, this.m4); n++;
    }
    this.cartons.count = n; this.tapes.count = n; this.cartons.instanceMatrix.needsUpdate = true; this.tapes.instanceMatrix.needsUpdate = true;
    // rollers spin on running segments (visual speed follows sim speed; frozen when paused)
    if (simDt > 0) {
      this.rollerAngle += simDt * 6;
      this.spin.setFromAxisAngle(X_AXIS, simDt * 6);
      for (let i = 0; i < this.rollerSeg.length; i++) {
        const seg = this.rollerSeg[i]; if (seg.status === 'BLOCKED' && seg.kind !== 'lane') continue;
        this.rollers.getMatrixAt(i, this.m4); this.m4.decompose(this.v, this.q, this.sc);
        this.q.multiply(this.spin); this.m4.compose(this.v, this.q, this.sc); this.rollers.setMatrixAt(i, this.m4);
      }
      this.rollers.instanceMatrix.needsUpdate = true;
    }
    // diverter arms swing across the belt while active
    for (const d of cv.diverters) {
      const arm = this.diverterArms.get(d.id)!; const active = t < d.activeUntil; const target = active ? -0.62 * (arm.userData.laneDir as number) : 0;
      arm.rotation.y += (target - arm.rotation.y) * Math.min(1, dt * 10);
      (arm.children[2] as THREE.Mesh).material = active ? this.ledGreen : d.blockedSince !== null ? this.ledRed : this.ledAmber;
    }
    // scanner flash
    const sc = cv.scanners[0]; const flash = t - sc.lastScanAt < 0.35 && sc.lastScanAt >= 0;
    (this.scannerBeam.material as THREE.MeshBasicMaterial).opacity = flash ? 0.45 : 0.06;
    (this.scannerLight.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 3 : 0.8;
    // lane photo-eyes: red when full, amber when a carton waits at the end, green when free
    for (const lane of cv.lanes) { const led = this.laneLeds.get(lane.id)!; led.material = cv.isLaneFull(lane) ? this.ledRed : cv.dischargeReady(lane) ? this.ledAmber : this.ledGreen; }
    for (const ind of cv.inductions) { const led = this.indLeds.get(ind.id)!; led.material = ind.status === 'BLOCKED' ? this.ledRed : cv.entryFree(ind) ? this.ledGreen : this.ledAmber; }
  }
}
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
