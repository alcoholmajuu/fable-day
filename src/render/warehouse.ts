import * as THREE from 'three';
import type { Layout } from '../sim/layout';
import { GRID_H, GRID_W, RACK_LEVELS, RACK_Z_RANGES, RACK_COLUMNS } from '../sim/layout';
import { OX, OZ } from './scene';
import { floorText } from './labels';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const LEVEL_H = 0.95;          // vertical spacing between rack levels
export const RACK_BASE = 0.12;        // height of first shelf deck top

const matCache = new Map<string, THREE.MeshStandardMaterial>();
/** Memoised materials so identical props share one material (and one merged draw call). */
const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
  const key = color + JSON.stringify(extra); let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...extra }); matCache.set(key, m); }
  return m;
};

export interface StaticPickables {
  rackCells: THREE.InstancedMesh;     // instanceId -> layout.rackCells index
  spotBoxes: THREE.Mesh[];            // userData.spotId
  stationBoxes: THREE.Mesh[];         // userData.stationId
}

export function buildWarehouse(layout: Layout, scene: THREE.Scene): StaticPickables {
  const g = new THREE.Group(); g.name = 'static'; scene.add(g);
  // Static props are collected per material and merged into one draw call each.
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (m: THREE.Mesh) => {
    if ((m.geometry as THREE.BufferGeometry).index === null) { g.add(m); return m; }
    m.updateMatrix(); const geo = (m.geometry as THREE.BufferGeometry).clone().applyMatrix4(m.matrix);
    const arr = batches.get(m.material as THREE.Material) ?? []; arr.push(geo); batches.set(m.material as THREE.Material, arr);
    return m;
  };
  const flush = () => {
    for (const [material, geos] of batches) {
      const merged = mergeGeometries(geos, false); if (!merged) continue;
      geos.forEach(x => x.dispose());
      const mesh = new THREE.Mesh(merged, material); const lit = material instanceof THREE.MeshStandardMaterial; mesh.castShadow = lit; mesh.receiveShadow = lit; if (!lit) mesh.renderOrder = 1; g.add(mesh);
    }
    batches.clear();
  };

  // ground far beyond the building
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0xb9c4d1, { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; g.add(ground);
  // yard asphalt strips outside the docks
  for (const side of [-1, 1]) {
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(16, GRID_H + 4), mat(0x7d838c, { roughness: 1 }));
    yard.rotation.x = -Math.PI / 2; yard.position.set(side > 0 ? GRID_W / 2 + 8 : -GRID_W / 2 - 8, -0.01, 0); yard.receiveShadow = true; add(yard);
  }
  // warehouse floor slab
  const floor = new THREE.Mesh(new THREE.BoxGeometry(GRID_W, 0.2, GRID_H), mat(0xdcdfe3, { roughness: 0.95 }));
  floor.position.set(0, -0.1, 0); floor.receiveShadow = true; g.add(floor);

  // zone paint + labels
  for (const z of layout.zones) {
    const w = z.x1 - z.x0, d = z.z1 - z.z0;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.12, d - 0.12), new THREE.MeshStandardMaterial({ color: z.color, transparent: true, opacity: 0.16, roughness: 1, depthWrite: false }));
    p.rotation.x = -Math.PI / 2; p.position.set(OX + z.x0 + w / 2, 0.004, OZ + z.z0 + d / 2); p.receiveShadow = true; add(p);
    // border line
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w - 0.12, d - 0.12)), new THREE.LineBasicMaterial({ color: z.color, transparent: true, opacity: 0.55 }));
    border.rotation.x = -Math.PI / 2; border.position.copy(p.position).setY(0.006); g.add(border);
    const t = floorText(z.name, 0.9, '#' + new THREE.Color(z.color).multiplyScalar(0.75).getHexString(), 0.85);
    t.position.set(OX + z.x0 + w / 2, 0.008, OZ + z.z0 + (z.id === 'storage' ? 0.9 : 1.0));
    if (w < 4) { t.rotation.z = Math.PI / 2; t.position.set(OX + z.x0 + w / 2, 0.008, OZ + z.z1 - 2.6); }
    g.add(t);
  }
  // aisle centre lines & lane markings inside storage
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2d24a, transparent: true, opacity: 0.8, depthWrite: false });
  const addLine = (x0: number, z0: number, x1: number, z1: number, wdt = 0.08) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, wdt), lineMat);
    m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(z1 - z0, x1 - x0);
    m.position.set(OX + (x0 + x1) / 2, 0.005, OZ + (z0 + z1) / 2); add(m);
  };
  for (let i = 0; i < RACK_COLUMNS.length; i += 2) { // yellow safety lines beside each rack face
    const xw = RACK_COLUMNS[i], xe = RACK_COLUMNS[i + 1];
    for (const [z0, z1] of RACK_Z_RANGES) { addLine(xw - 0.2, z0, xw - 0.2, z1 + 1); addLine(xe + 1.2, z0, xe + 1.2, z1 + 1); }
  }
  // cross-aisle dashed lines
  for (const z of [3.5, 15.5, 28.5]) for (let x = 10; x < 32; x += 1) addLine(x + 0.2, z, x + 0.8, z, 0.06);
  // pedestrian walkway stripes in receiving/shipping apron
  for (let z = 3; z < 29; z += 1.5) { addLine(1.2, z, 1.8, z, 0.06); addLine(43.2, z, 43.8, z, 0.06); }
  // painted pallet squares (receiving / staging)
  const sqMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  const edgeBatches: THREE.BufferGeometry[] = [];
  const addEdges = (w: number, h: number, x: number, z: number) => { const e = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)); e.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).applyMatrix4(new THREE.Matrix4().makeTranslation(x, 0.006, z)); edgeBatches.push(e); };
  for (const s of layout.spots) if (s.kind === 'receiving' || s.kind === 'staging') {
    addEdges(0.9, 0.9, OX + s.cell.cx + 0.5, OZ + s.cell.cz + 0.5);
    const n = floorText(s.id.split('-')[1], 0.35, '#8a8f99', 0.9); n.position.set(OX + s.cell.cx + 0.5, 0.007, OZ + s.cell.cz + 0.5 + (s.kind === 'receiving' ? 0.75 : -0.75)); g.add(n);
  }

  // walls (low, so the interior is visible) with dock door openings
  const wallMat = mat(0xeef1f5, { roughness: 0.9 });
  const wallH = 1.6, wallT = 0.25;
  const north = new THREE.Mesh(new THREE.BoxGeometry(GRID_W + wallT, wallH, wallT), wallMat); north.position.set(0, wallH / 2, OZ + 2 - wallT / 2); north.castShadow = true; north.receiveShadow = true; add(north);
  const south = north.clone(); south.position.z = OZ + 30 + wallT / 2; add(south);
  const dockZs = layout.docks.map(d => d.cell.cz);
  for (const side of [-1, 1]) {
    // wall segments between dock doors along x = 0 / x = GRID_W
    const x = side < 0 ? OX + wallT / 2 : OX + GRID_W - wallT / 2;
    const zs = [2, ...dockZs.filter((_, i) => layout.docks[i].kind === (side < 0 ? 'inbound' : 'outbound')).flatMap(z => [z - 1.3, z + 2.3]), 30];
    for (let i = 0; i < zs.length; i += 2) {
      const z0 = zs[i], z1 = zs[i + 1]; if (z1 - z0 <= 0) continue;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(wallT, wallH, z1 - z0), wallMat); seg.position.set(x, wallH / 2, OZ + (z0 + z1) / 2); seg.castShadow = true; seg.receiveShadow = true; add(seg);
    }
    // dock door frames + bumpers + leveler plate
    for (const d of layout.docks) {
      if (d.kind !== (side < 0 ? 'inbound' : 'outbound')) continue;
      const header = new THREE.Mesh(new THREE.BoxGeometry(wallT + 0.3, 0.9, 3.8), mat(0xc9ced6, { roughness: 0.7 })); header.position.set(x, wallH + 0.45, OZ + d.cell.cz + 0.5); header.castShadow = true; add(header);
      const seal = new THREE.Mesh(new THREE.BoxGeometry(wallT + 0.34, 0.12, 3.8), mat(0x2b2f36)); seal.position.set(x, wallH - 0.02, OZ + d.cell.cz + 0.5); add(seal);
      for (const dz of [-1.85, 1.85]) { const jamb = new THREE.Mesh(new THREE.BoxGeometry(wallT + 0.2, wallH, 0.2), mat(0xf2c53a)); jamb.position.set(x, wallH / 2, OZ + d.cell.cz + 0.5 + dz); add(jamb); }
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 2.4), mat(0x9aa1aa, { metalness: 0.4, roughness: 0.6 })); plate.position.set(x + side * 0.3, 0.03, OZ + d.cell.cz + 0.5); plate.receiveShadow = true; add(plate);
      for (const dz of [-1.3, 1.3]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.35), mat(0x1f2226)); b.position.set(x + side * 0.35, 0.3, OZ + d.cell.cz + 0.5 + dz); add(b); }
      const num = floorText(d.id.replace('DOCK-', ''), 0.42, '#3a3f47', 0.85); num.position.set(x - side * 1.4, 0.008, OZ + d.cell.cz + 0.5); num.rotation.z = side < 0 ? Math.PI / 2 : -Math.PI / 2; g.add(num);
    }
  }
  // pillars along the north/south walls for scale
  for (let x = 6; x < GRID_W; x += 8) for (const z of [OZ + 2.4, OZ + 29.6]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.2, 0.5), mat(0xd6dae0)); p.position.set(OX + x, 2.1, z); p.castShadow = true; add(p); }

  // ---- racks (instanced)
  const postGeo = new THREE.BoxGeometry(0.07, RACK_BASE + LEVEL_H * RACK_LEVELS, 0.07);
  const beamGeo = new THREE.BoxGeometry(1.0, 0.07, 0.06);
  const deckGeo = new THREE.BoxGeometry(0.96, 0.04, 0.9);
  const rackMat = mat(0x3d63b8, { roughness: 0.65, metalness: 0.15 });
  const beamMat = mat(0xe8843a, { roughness: 0.6, metalness: 0.2 });
  const deckMat = mat(0x9aa3ad, { roughness: 0.7, metalness: 0.3 });
  const cells = layout.rackCells;
  const posts = new THREE.InstancedMesh(postGeo, rackMat, cells.length * 2);
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, cells.length * RACK_LEVELS * 2);
  const decks = new THREE.InstancedMesh(deckGeo, deckMat, cells.length * RACK_LEVELS);
  const m4 = new THREE.Matrix4(); let pi = 0, bi = 0, di = 0;
  const totalH = RACK_BASE + LEVEL_H * RACK_LEVELS;
  cells.forEach((c, idx) => {
    const x = OX + c.cx + 0.5, z = OZ + c.cz + 0.5;
    // rack column faces: even rack columns face west, odd face east; posts at the back pair line (shared) + front
    const colIdx = RACK_COLUMNS.indexOf(c.cx); const side = colIdx % 2 === 0 ? -1 : 1; // side = direction of aisle
    // two posts per cell at the aisle-facing corners (z-0.5 edge). Back posts are covered by the neighbouring column's front posts.
    if (c.cz % 2 === 0) for (const dz of [-0.47]) for (const dx of [side * 0.44, -side * 0.44]) { m4.makeTranslation(x + dx, totalH / 2, z + dz); posts.setMatrixAt(pi++, m4); }
    for (let l = 0; l < RACK_LEVELS; l++) {
      const y = RACK_BASE + l * LEVEL_H;
      m4.makeTranslation(x + side * 0.44, y, z); m4.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)); beams.setMatrixAt(bi++, m4);
      m4.makeTranslation(x - side * 0.44, y, z); m4.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)); beams.setMatrixAt(bi++, m4);
      m4.makeTranslation(x, y - 0.02, z); decks.setMatrixAt(di++, m4);
    }
    void idx;
  });
  // add closing posts at the end of each rack run
  posts.count = pi; beams.count = bi; decks.count = di;
  for (const im of [posts, beams, decks]) { im.castShadow = true; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; g.add(im); }
  // extra posts at the far z end of each run
  const endPosts = new THREE.InstancedMesh(postGeo, rackMat, RACK_COLUMNS.length * RACK_Z_RANGES.length * 2); let ei = 0;
  RACK_COLUMNS.forEach((cx, i) => { const side = i % 2 === 0 ? -1 : 1; for (const [, z1] of RACK_Z_RANGES) for (const dx of [side * 0.44, -side * 0.44]) { m4.makeTranslation(OX + cx + 0.5 + dx, totalH / 2, OZ + z1 + 0.97); endPosts.setMatrixAt(ei++, m4); } });
  endPosts.count = ei; endPosts.castShadow = true; endPosts.instanceMatrix.needsUpdate = true; g.add(endPosts);
  // aisle letter signs hanging above racks
  for (const a of layout.aisleLabels) {
    const t = floorText(a.text, 0.7, '#ffffff', 1); t.rotation.set(0, 0, 0); // vertical sign facing north wall
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.06), mat(0x2b4c8c)); sign.position.set(OX + a.cell.cx + 0.5, totalH + 0.9, OZ + RACK_Z_RANGES[0][0] - 0.1); add(sign);
    t.position.copy(sign.position).add(new THREE.Vector3(0, 0, -0.04)); t.rotation.y = Math.PI; g.add(t); const t2 = floorText(a.text, 0.7, '#ffffff', 1); t2.rotation.set(0, 0, 0); t2.position.copy(sign.position).add(new THREE.Vector3(0, 0, 0.04)); g.add(t2);
  }

  // ---- hit boxes for rack cells (invisible, instanced)
  const hitGeo = new THREE.BoxGeometry(1, totalH, 1);
  const rackHits = new THREE.InstancedMesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }), cells.length);
  cells.forEach((c, i) => { m4.makeTranslation(OX + c.cx + 0.5, totalH / 2, OZ + c.cz + 0.5); rackHits.setMatrixAt(i, m4); });
  rackHits.instanceMatrix.needsUpdate = true; g.add(rackHits);

  // ---- benches, shelves, station furniture
  const spotBoxes: THREE.Mesh[] = []; const stationBoxes: THREE.Mesh[] = [];
  const benchMat = mat(0x8c6a4a, { roughness: 0.8 }); const steel = mat(0x8d949c, { metalness: 0.5, roughness: 0.5 });
  for (const st of layout.stations) {
    const c0 = st.cells[0], c1 = st.cells[st.cells.length - 1];
    const cxm = (c0.cx + c1.cx) / 2 + 0.5, czm = (c0.cz + c1.cz) / 2 + 0.5; const len = c1.cz - c0.cz + 1;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, len - 0.15), st.kind === 'pack' ? benchMat : mat(0xd9dde3)); top.position.set(OX + cxm, 0.86, OZ + czm); top.castShadow = true; top.receiveShadow = true; add(top);
    for (const dz of [-(len / 2) + 0.2, len / 2 - 0.2]) for (const dx of [-0.35, 0.35]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.82, 0.08), steel); leg.position.set(OX + cxm + dx, 0.41, OZ + czm + dz); add(leg); }
    if (st.kind === 'pack') { // tape dispenser + label printer + carton stack behind
      const disp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.3), mat(0xd94040)); disp.position.set(OX + cxm + 0.25, 0.99, OZ + czm + 0.5); disp.castShadow = true; add(disp);
      const printer = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.28), mat(0xf2f2f2)); printer.position.set(OX + cxm + 0.22, 1.0, OZ + czm - 0.55); printer.castShadow = true; add(printer);
      const flats = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.7, 1.0), mat(0xc79a62)); flats.position.set(OX + cxm + 0.6, 0.35, OZ + czm); flats.castShadow = true; add(flats);
    } else { // inspection: scanner + clipboard + light
      const scanner = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, 0.25), mat(0x3a3f47)); scanner.position.set(OX + cxm - 0.25, 1.05, OZ + czm + 0.55); scanner.castShadow = true; add(scanner);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4), steel); pole.position.set(OX + cxm + 0.35, 1.6, OZ + czm - 0.7); add(pole);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.3), mat(0xfff4d0, { emissive: 0xfff0c0, emissiveIntensity: 0.6 })); lamp.position.set(OX + cxm, 2.3, OZ + czm - 0.7); add(lamp);
    }
    const hb = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, len), new THREE.MeshBasicMaterial({ visible: false })); hb.position.set(OX + cxm, 0.6, OZ + czm); hb.userData.stationId = st.id; g.add(hb); stationBoxes.push(hb);
  }
  for (const s of layout.spots) {
    const x = OX + s.cell.cx + 0.5, z = OZ + s.cell.cz + 0.5;
    if (s.kind === 'tote_shelf') {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.5, 0.06), mat(0x3f8f55)); frame.position.set(x + 0.42, 0.75, z); frame.castShadow = true; add(frame);
      for (const y of [0.05, 0.55, 1.05]) { const sh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.9), steel); sh.position.set(x, y, z); sh.receiveShadow = true; add(sh); }
    }
    if (s.kind === 'inspect_out' || s.kind === 'pack_in' || s.kind === 'pack_out') addEdges(0.9, 0.9, x, z); // painted buffer square
    const hb = new THREE.Mesh(new THREE.BoxGeometry(1, 1.4, 1), new THREE.MeshBasicMaterial({ visible: false })); hb.position.set(x, 0.7, z); hb.userData.spotId = s.id; g.add(hb); spotBoxes.push(hb);
  }
  flush();
  const edges = mergeGeometries(edgeBatches, false); if (edges) g.add(new THREE.LineSegments(edges, sqMat));
  return { rackCells: rackHits, spotBoxes, stationBoxes };
}
