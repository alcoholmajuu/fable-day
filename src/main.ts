import * as THREE from 'three';
import { Simulation } from './sim/sim';
import { SceneHost, OX, OZ } from './render/scene';
import { buildWarehouse } from './render/warehouse';
import { DynamicRenderer } from './render/dynamic';
import { ConveyorRenderer } from './render/conveyor';
import { HUD, type Selection } from './ui/hud';
import { RACK_BASE, LEVEL_H } from './render/warehouse';
import { RACK_LEVELS } from './sim/layout';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 12345);
const sim = new Simulation(seed);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const host = new SceneHost(canvas);
const statics = buildWarehouse(sim.layout, host.scene);
const dyn = new DynamicRenderer(sim, host.scene);
const conv = new ConveyorRenderer(sim, host.scene);
const hud = new HUD(sim, document.getElementById('ui')!);
(window as any).sim = sim; (window as any).__renderer = host.renderer; // for debugging in the console

// fast-forward for screenshots/testing: ?t=seconds
const ff = Number(params.get('t') ?? 0);
for (let i = 0; i < ff / sim.dt; i++) sim.tick();
if (params.get('speed')) hud.setSpeed(Number(params.get('speed')));
if (params.get('zoom')) host.setZoom(Number(params.get('zoom')));
if (params.get('focus')) { const [cx, cz] = params.get('focus')!.split(',').map(Number); host.focusOn(new THREE.Vector3(OX + cx, 0, OZ + cz)); }
if (params.get('labels') === '0') dyn.labelsVisible = false;
if (params.get('follow')) { const id = params.get('follow')!; host.followFn = () => dyn.workerWorldPos(id); }
if (params.get('select')) { const [k, id] = params.get('select')!.split(':'); setTimeout(() => hud.select({ kind: k as any, id }), 0); }

let selection: Selection = null;
hud.onSelect = s => { selection = s; };
hud.onFollow = id => { host.followFn = () => dyn.workerWorldPos(id); host.setZoom(Math.min(host.zoom, 7)); };
hud.onFocus = (cx, cz) => host.focusOn(new THREE.Vector3(OX + cx + 0.5, 0, OZ + cz + 0.5), Math.min(host.zoom, 8));
hud.onToggleLabels = () => { dyn.labelsVisible = !dyn.labelsVisible; };

const raycaster = new THREE.Raycaster();
function pick(x: number, y: number): Selection {
  host.ray(x, y, raycaster);
  const hits = raycaster.intersectObjects([...dyn.workerHits, statics.rackCells, ...statics.spotBoxes, ...statics.stationBoxes, ...dyn.truckHits, ...conv.hits], false);
  if (!hits.length) return null;
  const h = hits[0]; const o = h.object as THREE.Mesh;
  if (o.userData.workerId) return { kind: 'worker', id: o.userData.workerId };
  if (o.userData.truckId) return { kind: 'truck', id: o.userData.truckId };
  if (o.userData.conveyorId) return { kind: 'conveyor', id: o.userData.conveyorId };
  if (o.userData.spotId) return { kind: 'spot', id: o.userData.spotId };
  if (o.userData.stationId) return { kind: 'station', id: o.userData.stationId };
  if (o === statics.rackCells && h.instanceId !== undefined) {
    const cell = sim.layout.rackCells[h.instanceId];
    const level = Math.max(0, Math.min(RACK_LEVELS - 1, Math.floor((h.point.y - RACK_BASE + 0.15) / LEVEL_H)));
    const loc = [...sim.racks.values()].find(r => r.cell.cx === cell.cx && r.cell.cz === cell.cz && r.level === level);
    if (loc) return { kind: 'rack', id: loc.id };
  }
  return null;
}
host.onClick = (x, y) => { hud.select(pick(x, y)); };
host.onDoubleClick = (x, y) => { const s = pick(x, y); if (s?.kind === 'worker') { hud.onFollow(s.id); return; } const p = host.groundPoint(x, y); if (p) host.focusOn(p, Math.min(host.zoom, 8)); };
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.key.toLowerCase() === 'f' && selection?.kind === 'worker') hud.onFollow(selection.id);
  if (e.key.toLowerCase() === 'r') host.reset();
});
// pointer cursor on hover
host.onHover = (x, y) => {
  const s = pick(x, y); canvas.style.cursor = s ? 'pointer' : 'default';
  hud.showTip(s ? describe(s) : '', x, y);
};
function describe(s: NonNullable<Selection>): string {
  if (s.kind === 'worker') { const w = sim.workers.find(w => w.id === s.id)!; const j = w.jobId ? sim.jobs.get(w.jobId) : null; return `${w.name} · ${j ? j.type + ': ' + (w.workLabel || j.summary) : 'Idle'}`; }
  if (s.kind === 'rack') { const l = sim.racks.get(s.id)!; const sku = l.skuId ? sim.skus.get(l.skuId) : null; return `${l.id} · ${sku ? `${l.qty}× ${sku.name}${l.reserved ? ` (${l.reserved} reserved)` : ''}` : 'empty slot'}`; }
  if (s.kind === 'spot') { const sp = sim.spots.get(s.id)!; return `${sp.id} · ${sp.containerIds.length}/${sp.capacity} ${sp.kind.replace('_', ' ')}`; }
  if (s.kind === 'station') { const st = sim.stations.get(s.id)!; return `${st.kind === 'pack' ? 'Packing' : 'Inspection'} station · ${st.busyWorkerId ? sim.worker(st.busyWorkerId).name + ' working' : 'free'}`; }
  if (s.kind === 'conveyor') { const seg = sim.conveyor.segments.get(s.id)!; return `${seg.name} · ${seg.status} · ${seg.cartons.length} carton${seg.cartons.length === 1 ? '' : 's'}${seg.blockedBy ? ' · ' + seg.blockedBy : ''}`; }
  if (s.kind === 'truck') { const t = sim.trucks.get(s.id)!; return `${t.kind} truck ${t.id} · ${t.state} · ${t.containerIds.length}${t.kind === 'outbound' ? '/' + t.capacity + ' cartons' : ' pallets'}`; }
  return '';
}

// ---- fixed-timestep loop
let last = performance.now(); let acc = 0; let frames = 0; let fpsT = 0;
let invariantT = 0; let errorShown = false;
window.addEventListener('error', e => { if (!errorShown) { errorShown = true; hud.showToast('Error: ' + e.message); } });
function frame(now: number) {
  requestAnimationFrame(frame);
  const real = Math.min(0.1, (now - last) / 1000); last = now;
  acc += real * hud.effectiveSpeed;
  let steps = 0;
  while (acc >= sim.dt && steps < 40) { sim.tick(); acc -= sim.dt; steps++; }
  if (steps >= 40) acc = 0; // avoid spiral of death after tab was hidden
  invariantT += real;
  if (import.meta.env.DEV && invariantT > 2) { invariantT = 0; const errs = sim.checkInvariants(); if (errs.length) { console.error('INVARIANT', errs); hud.showToast('Invariant violated: ' + errs[0]); } }
  host.pollKeys(real);
  host.update(real);
  dyn.zoomLevel = host.zoom;
  dyn.update(real * Math.max(0.0001, hud.effectiveSpeed), selection);
  conv.update(real, real * hud.effectiveSpeed);
  hud.update();
  host.render();
  frames++; (window as any).__frames = ((window as any).__frames ?? 0) + 1; fpsT += real; if (fpsT >= 0.5) { hud.setFps(frames / fpsT); frames = 0; fpsT = 0; }
}
requestAnimationFrame(frame);
