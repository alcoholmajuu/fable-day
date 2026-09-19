import { buildLayout, type Layout, RACK_LEVELS, PACK_Z0, MAIN_Z0, MAIN_Z1, LANE_Z, LANE_DOCK, SCANNER_Z } from './layout';
import { ConveyorNetwork, type Segment } from './conveyor';
import { Grid } from './grid';
import { RNG } from './rng';
import {
  type Cell, type Container, type Dock, type Job, type JobType, type LogEvent, type Order, type OrderState,
  type RackLocation, type Role, type SKU, type Spot, type SpotKind, type Station, type Step, type Truck, type Worker,
  sameCell,
} from './types';

export interface Metrics {
  ordersCreated: number; ordersShipped: number; ordersDropped: number;
  unitsPicked: number; unitsReceived: number; palletsReceived: number; cartonsPacked: number; trucksIn: number; trucksOut: number;
  shipTimes: number[];        // sim times of shipments (for throughput window)
  cycleTimes: number[];       // last N order cycle times
  jobsFailed: number; replans: number;
  utilization: number;        // 0..1 rolling
  cartonsInducted: number;
}

export interface SimSnapshot {
  workers: { total: number; idle: number; walking: number; working: number };
  jobs: Record<JobType, { open: number; active: number }>;
  orders: Record<OrderState, number>;
  inventory: { onHand: number; reserved: number; incoming: number; inTotes: number; inCartons: number; onPallets: number; onTrucks: number; locationsUsed: number; locationsTotal: number };
  throughputPerHour: number;
  avgCycleTime: number;
  backlog: number;
  rush: boolean;
  conveyor: { cartons: number; onMain: number; inLanes: number; blocked: number; throughputPerHour: number; laneFill: { id: string; name: string; n: number; cap: number; status: string; dockId: string }[]; mainStatus: string; inductionsBlocked: number };
}

const WORKER_NAMES = ['Ava', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lou', 'Mia', 'Nio'];
const CUSTOMERS = ['Northwind', 'Acme Retail', 'Bluebird Co', 'Harbor Goods', 'Pinecrest', 'Summit Supply', 'Lumen Home', 'Orbit Tools', 'Maple & Co', 'Vega Stores'];
const JOB_PRIORITY: Record<JobType, number> = { LOAD: 90, PACK: 80, PICK: 70, UNLOAD: 62, PUTAWAY: 56, INSPECT: 52, TOTE_RETURN: 30 };
const ROLE_JOBS: Record<Role, JobType[]> = {
  receiver: ['UNLOAD', 'INSPECT', 'PUTAWAY'], picker: ['PICK', 'TOTE_RETURN'], packer: ['PACK'], shipper: ['LOAD'],
};
const ROLE_HOME: Record<Role, Cell> = { receiver: { cx: 5, cz: 15 }, picker: { cx: 31, cz: 15 }, packer: { cx: 35, cz: 15 }, shipper: { cx: 43, cz: 18 } };

export class Simulation {
  readonly dt = 0.05;
  time = 0;
  readonly layout: Layout;
  readonly grid: Grid;
  readonly rng: RNG;
  readonly skus = new Map<string, SKU>();
  readonly racks = new Map<string, RackLocation>();
  readonly spots = new Map<string, Spot>();
  readonly stations = new Map<string, Station>();
  readonly docks: Dock[];
  readonly containers = new Map<string, Container>();
  readonly orders = new Map<string, Order>();
  readonly orderList: Order[] = [];
  readonly jobs = new Map<string, Job>();
  readonly workers: Worker[] = [];
  readonly trucks = new Map<string, Truck>();
  readonly log: LogEvent[] = [];
  readonly conveyor: ConveyorNetwork;
  readonly metrics: Metrics = { ordersCreated: 0, ordersShipped: 0, ordersDropped: 0, unitsPicked: 0, unitsReceived: 0, palletsReceived: 0, cartonsPacked: 0, trucksIn: 0, trucksOut: 0, shipTimes: [], cycleTimes: [], jobsFailed: 0, replans: 0, utilization: 0, cartonsInducted: 0 };
  /** Bumped whenever inventory or container placement changes (renderer dirty flag). */
  version = 0;
  rushActive = false;
  /** Orders/hour sampled every 20s for the dashboard sparkline (last 90 samples = 30 min). */
  readonly history: { t: number; thr: number; backlog: number; rush: boolean }[] = [];
  private nextSampleAt = 20;
  private lastDropLog = -100;
  /** SKU with a promotion during the current rush (demand ×4); creates realistic shortages. */
  hotSkuId: string | null = null;
  private nextRushAt: number;
  private rushEndsAt = 0;
  private nextOrderAt: number;
  private nextAllocAt = 0;
  private nextDispatchAt = 0;
  private readonly sources = new Set<string>();
  private ids: Record<string, number> = {};
  private spotsByKind = new Map<SpotKind, Spot[]>();
  private locsBySku = new Map<string, RackLocation[]>();
  private emptyLocs: RackLocation[] = [];

  constructor(seed = 12345, opts: { workers?: number; seedStock?: boolean } = {}) {
    this.rng = new RNG(seed);
    this.layout = buildLayout();
    this.grid = this.layout.grid;
    for (const s of this.layout.skus) this.skus.set(s.id, s);
    for (const r of this.layout.racks) this.racks.set(r.id, r);
    for (const s of this.layout.spots) {
      this.spots.set(s.id, s);
      const arr = this.spotsByKind.get(s.kind) ?? []; arr.push(s); this.spotsByKind.set(s.kind, arr);
    }
    for (const s of this.layout.stations) this.stations.set(s.id, s);
    this.docks = this.layout.docks;
    this.conveyor = new ConveyorNetwork({
      get time() { return self.time; }, containers: this.containers,
      route: (c, lanes) => this.routeCarton(c, lanes),
      onEvent: (k, t) => this.emit(k, t), bump: () => { this.version++; },
    });
    const self = this;
    this.buildConveyor();
    this.nextRushAt = this.rng.range(150, 260);
    this.nextOrderAt = 4;
    this.createWorkers(opts.workers ?? 12);
    if (opts.seedStock !== false) this.seedStock();
    for (const shelf of this.spotsByKind.get('tote_shelf')!) for (let i = 0; i < 6; i++) { const t = this.newContainer('tote', []); t.spotId = shelf.id; shelf.containerIds.push(t.id); }
    this.rebuildLocIndex();
    // start mid-shift: a truck is already pulling in and a few orders are waiting
    this.docks[0].nextArrival = 1; this.docks[2].nextArrival = 25;
    for (let i = 0; i < 5; i++) this.createOrder();
    this.emit('info', 'Shift started. Warehouse online.');
  }

  // ---------------------------------------------------------------- conveyor topology
  private buildConveyor() {
    const cv = this.conveyor; const X = 39.5;
    const main = cv.addSegment({ id: 'MAIN', kind: 'main', name: 'Main sorter line', points: [{ x: X, z: MAIN_Z0 + 0.2 }, { x: X, z: MAIN_Z1 + 0.5 }], speed: 1.3, next: null, cells: Array.from({ length: MAIN_Z1 - MAIN_Z0 + 1 }, (_, i) => ({ cx: 39, cz: MAIN_Z0 + i })) });
    for (const z0 of PACK_Z0) {
      const z = z0 + 2 + 0.5;
      cv.addSegment({ id: `IND-${z0}`, kind: 'induction', name: `Induction ${PACK_Z0.indexOf(z0) + 1}`, points: [{ x: 37.3, z }, { x: 39.0, z }], speed: 1.0, next: { segId: 'MAIN', pos: z - (MAIN_Z0 + 0.2) }, stationId: `PACK-${z0}`, accessCell: { cx: 36, cz: z0 + 2 }, cells: [{ cx: 37, cz: z0 + 2 }, { cx: 38, cz: z0 + 2 }] });
    }
    cv.addScanner({ id: 'SCAN-1', segId: 'MAIN', pos: SCANNER_Z + 0.5 - (MAIN_Z0 + 0.2) });
    LANE_Z.forEach((z, i) => {
      const laneId = `LANE-${i + 1}`;
      cv.addSegment({ id: laneId, kind: 'lane', name: `Lane ${i + 1} → ${LANE_DOCK[z].replace('DOCK-', '')}`, points: [{ x: X, z: z + 0.5 }, { x: 40.2, z: z + 0.5 }, { x: 42.6, z: z + 0.5 }], speed: 0.9, next: null, dockId: LANE_DOCK[z], laneNo: i + 1, accessCell: { cx: 43, cz: z }, cells: [40, 41, 42].map(cx => ({ cx, cz: z })) });
      cv.addDiverter({ id: `DIV-${i + 1}`, segId: 'MAIN', pos: z + 0.5 - (MAIN_Z0 + 0.2), laneId });
    });
    void main;
  }
  /** Sorter routing: pick the lane serving the order's dock with the most free space. Deterministic; never crosses docks. */
  private routeCarton(c: Container, lanes: Segment[]): string {
    const o = c.orderId ? this.orders.get(c.orderId) : null;
    const dock = o?.dockId ?? this.docks.find(d => d.kind === 'outbound')!.id;
    const cands = lanes.filter(l => l.dockId === dock);
    let best = cands[0], br = -1;
    for (const l of cands) { const r = this.conveyor.laneRoom(l) - (l.cartons.length ? 0 : 0.5) + this.pendingFor(l.id) * -1; if (r > br) { br = r; best = l; } }
    return best.id;
  }
  /** Cartons already routed to a lane but not yet in it (still on the main line). */
  private pendingFor(laneId: string) { let n = 0; for (const id of this.conveyor.segments.get('MAIN')!.cartons) if (this.containers.get(id)!.convDest === laneId) n++; return n; }

  // ---------------------------------------------------------------- setup
  private nid(prefix: string) { const n = (this.ids[prefix] = (this.ids[prefix] ?? 0) + 1); return `${prefix}${n}`; }

  private createWorkers(n: number) {
    const roles: Role[] = ['receiver', 'picker', 'packer', 'shipper', 'receiver', 'picker', 'picker', 'packer', 'receiver', 'shipper', 'picker', 'receiver', 'packer', 'picker'];
    for (let i = 0; i < n; i++) {
      const role = roles[i % roles.length];
      const home = ROLE_HOME[role];
      const cell = this.grid.nearestWalkable({ cx: home.cx, cz: home.cz + (i % 3) - 1 });
      this.workers.push({
        id: this.nid('W'), name: WORKER_NAMES[i % WORKER_NAMES.length], role, x: cell.cx + 0.5, z: cell.cz + 0.5, facing: 0, cell,
        path: [], pathIdx: 0, jobId: null, carrying: null, carryExtra: [], state: 'idle', workTimer: 0, workTotal: 0, workLabel: '',
        stuckTimer: 0, waitTimer: 0, lastProgressDist: Infinity, lateral: this.rng.range(-0.22, 0.22), speed: 2.4, busyTime: 0, jobsDone: 0, replans: 0, idleSince: 0,
      });
    }
  }

  private seedStock() {
    const locs = this.layout.racks.slice();
    // Seed each SKU at 55–115% of its replenishment target so purchasing has work from the first minutes,
    // spread over several partially filled slots. Popular SKUs sit nearer the picking zone and lower.
    for (const sku of this.layout.skus) {
      let units = Math.round(this.skuTarget(sku) * this.rng.range(0.55, 1.15));
      while (units > 0) {
        const free = locs.filter(l => l.skuId === null);
        if (!free.length) return;
        const pref = sku.popularity / 9;
        const loc = this.rng.weighted(free, l => 0.2 + Math.pow((l.cell.cx - 8) / 24, 2 * pref) * (l.level === 0 ? 1.4 : 1));
        const q = Math.min(units, this.rng.int(3, 9));
        loc.skuId = sku.id; loc.qty = q; units -= q;
      }
    }
  }

  private rebuildLocIndex() {
    this.locsBySku.clear(); this.emptyLocs = [];
    for (const l of this.racks.values()) {
      if (l.skuId) { const a = this.locsBySku.get(l.skuId) ?? []; a.push(l); this.locsBySku.set(l.skuId, a); }
      else this.emptyLocs.push(l);
    }
  }
  private locSetSku(l: RackLocation, sku: string | null) {
    if (l.skuId === sku) return;
    if (l.skuId) { const a = this.locsBySku.get(l.skuId); if (a) { const i = a.indexOf(l); if (i >= 0) a.splice(i, 1); } }
    else { const i = this.emptyLocs.indexOf(l); if (i >= 0) this.emptyLocs.splice(i, 1); }
    l.skuId = sku;
    if (sku) { const a = this.locsBySku.get(sku) ?? []; a.push(l); this.locsBySku.set(sku, a); }
    else this.emptyLocs.push(l);
  }
  private maybeFreeLoc(l: RackLocation) { if (l.qty === 0 && l.incoming === 0 && l.reserved === 0) this.locSetSku(l, null); }

  emit(kind: LogEvent['kind'], text: string) {
    this.log.push({ t: this.time, text, kind });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  // ---------------------------------------------------------------- main tick
  tick() {
    const dt = this.dt;
    this.time += dt;
    this.updateTrucks(dt);
    this.updateDemand();
    this.plan();
    if (this.time >= this.nextAllocAt) { this.allocateOrders(); this.nextAllocAt = this.time + 0.5; }
    if (this.time >= this.nextDispatchAt) { this.dispatch(); this.nextDispatchAt = this.time + 0.2; }
    let busy = 0;
    for (const w of this.workers) { this.updateWorker(w, dt); if (w.jobId) { busy++; w.busyTime += dt; } }
    this.conveyor.tick(dt);
    // orders whose carton entered a lane are staged
    for (const lane of this.conveyor.lanes) for (const id of lane.cartons) { const o = this.orders.get(this.containers.get(id)!.orderId!); if (o && o.state === 'SORTING') this.setOrderState(o, 'STAGED'); }
    if (this.time >= this.nextSampleAt) { this.nextSampleAt += 20; const s = this.snapshot(); this.history.push({ t: this.time, thr: s.throughputPerHour, backlog: s.backlog, rush: this.rushActive }); if (this.history.length > 90) this.history.shift(); }
    this.metrics.utilization += (busy / this.workers.length - this.metrics.utilization) * Math.min(1, dt / 30);
  }

  // ---------------------------------------------------------------- trucks & inbound
  private updateTrucks(dt: number) {
    for (const d of this.docks) {
      if (!d.truckId && this.time >= d.nextArrival) {
        if (d.kind === 'inbound' && this.time > 300 && this.rng.chance(0.12)) { d.nextArrival = this.time + this.rng.range(120, 240); this.emit('warn', `Supplier delay: inbound truck for ${d.id} running late`); continue; }
        this.spawnTruck(d);
      }
    }
    for (const tr of [...this.trucks.values()]) {
      if (tr.state === 'arriving') {
        tr.t = Math.min(1, tr.t + dt / 5);
        if (tr.t >= 1) { tr.state = 'docked'; tr.dockedAt = this.time; this.emit(tr.kind === 'inbound' ? 'inbound' : 'info', tr.kind === 'inbound' ? `Truck ${tr.id} docked with ${tr.containerIds.length} pallets` : `Outbound truck ${tr.id} ready at ${tr.dockId}`); }
      } else if (tr.state === 'docked') {
        if (tr.kind === 'inbound') {
          if (tr.containerIds.length === 0 && tr.activeUnloads === 0) this.departTruck(tr);
        } else {
          const elapsed = this.time - tr.dockedAt;
          const full = tr.containerIds.length >= tr.capacity;
          const staged = this.conveyor.lanes.some(l => l.dockId === tr.dockId && l.cartons.length > 0);
          const timedOut = elapsed > tr.dwell && tr.pending === 0 && (tr.containerIds.length > 0 || (!staged && elapsed > tr.dwell * 1.6));
          if ((full && tr.pending === 0) || timedOut) this.departTruck(tr);
        }
      } else if (tr.state === 'departing') {
        tr.t = Math.max(0, tr.t - dt / 5);
        if (tr.t <= 0) { this.trucks.delete(tr.id); const d = this.docks.find(x => x.id === tr.dockId)!; d.truckId = null; }
      }
    }
  }

  private spawnTruck(d: Dock) {
    const tr: Truck = { id: this.nid(d.kind === 'inbound' ? 'TI' : 'TO'), kind: d.kind, state: 'arriving', dockId: d.id, dockCell: d.cell, t: 0, containerIds: [], capacity: 0, dockedAt: 0, dwell: 0, loadedCount: 0, pending: 0, activeUnloads: 0 };
    if (d.kind === 'inbound') {
      // Purchasing: replenish SKUs whose projected stock (on hand + inbound) is below target; short SKUs first.
      const freeLocs = this.emptyLocs.length;
      const maxPallets = Math.min(this.rng.int(6, 10), Math.max(0, Math.floor((freeLocs - 20) / 3)));
      const deficits = this.layout.skus.map(s => ({ s, d: this.skuTarget(s) - this.skuOnHand(s.id) })).filter(x => x.d > 0).sort((a, b) => b.d / a.s.palletQty - a.d / b.s.palletQty);
      const picks: SKU[] = [];
      for (const x of deficits) { let d = x.d; while (d > 0 && picks.length < maxPallets) { picks.push(x.s); d -= x.s.palletQty; } if (picks.length >= maxPallets) break; }
      if (picks.length === 0) { d.nextArrival = this.time + 45; return; }
      for (const sku of picks) {
        const c = this.newContainer('pallet', [{ skuId: sku.id, qty: sku.palletQty }]);
        c.truckId = tr.id; tr.containerIds.push(c.id);
      }
      this.metrics.trucksIn++;
      this.emit('inbound', `Inbound truck ${tr.id} arriving at ${d.id}`);
    } else {
      tr.capacity = this.rng.int(10, 14); tr.dwell = this.rng.range(140, 200);
    }
    d.truckId = tr.id; this.trucks.set(tr.id, tr);
  }

  private departTruck(tr: Truck) {
    tr.state = 'departing';
    const d = this.docks.find(x => x.id === tr.dockId)!;
    if (tr.kind === 'inbound') { d.nextArrival = this.time + this.rng.range(80, 150); }
    else {
      d.nextArrival = this.time + this.rng.range(35, 90);
      let n = 0;
      for (const cid of tr.containerIds) {
        const c = this.containers.get(cid); if (!c) continue;
        const o = c.orderId ? this.orders.get(c.orderId) : null;
        if (o && o.state !== 'SHIPPED') { this.setOrderState(o, 'SHIPPED'); o.shippedAt = this.time; this.metrics.ordersShipped++; this.metrics.shipTimes.push(this.time); this.metrics.cycleTimes.push(this.time - o.createdAt); if (this.metrics.cycleTimes.length > 50) this.metrics.cycleTimes.shift(); n++; }
        this.containers.delete(cid);
      }
      tr.containerIds = [];
      this.metrics.trucksOut++;
      if (this.metrics.shipTimes.length > 400) this.metrics.shipTimes.splice(0, 100);
      this.emit('ship', `Truck ${tr.id} departed with ${n} orders`);
      this.version++;
    }
  }

  /** Target stock level per SKU: a few hours of demand at the base order rate. */
  skuTarget(s: SKU) { return Math.round(14 + s.popularity * 20); }
  skuOnHand(skuId: string) { let n = 0; for (const l of this.locsBySku.get(skuId) ?? []) n += l.qty + l.incoming; for (const c of this.containers.values()) if (c.kind === 'pallet') for (const ln of c.lines) if (ln.skuId === skuId) n += ln.qty; return n; }
  skuAvailable(skuId: string) { let n = 0; for (const l of this.locsBySku.get(skuId) ?? []) n += l.qty - l.reserved; return n; }

  private newContainer(kind: Container['kind'], lines: Container['lines']): Container {
    const c: Container = { id: this.nid(kind === 'pallet' ? 'P' : kind === 'tote' ? 'T' : 'C'), kind, lines, spotId: null, carriedBy: null, truckId: null, orderId: null, inspected: false, reservedBy: null, createdAt: this.time, convSeg: null, convPos: 0, convDest: null, scannedAt: null };
    this.containers.set(c.id, c); this.version++;
    return c;
  }

  // ---------------------------------------------------------------- demand
  private updateDemand() {
    if (!this.rushActive && this.time >= this.nextRushAt) {
      this.rushActive = true; this.rushEndsAt = this.time + this.rng.range(70, 120);
      const hot = this.rng.pick(this.layout.skus); this.hotSkuId = hot.id;
      this.emit('warn', `Rush period started: order volume spiking, ${hot.name} on promotion`);
    }
    if (this.rushActive && this.time >= this.rushEndsAt) { this.rushActive = false; this.hotSkuId = null; this.nextRushAt = this.time + this.rng.range(220, 420); this.emit('info', 'Rush period over'); }
    while (this.time >= this.nextOrderAt) {
      const mean = this.rushActive ? 4.5 : 12.5;
      this.nextOrderAt += Math.max(0.5, this.rng.exp(mean));
      const openOrders = this.orderList.filter(o => o.state !== 'SHIPPED').length;
      if (openOrders >= 90) { this.metrics.ordersDropped++; if (this.time - this.lastDropLog > 60) { this.lastDropLog = this.time; this.emit('warn', `Order book full (${openOrders} open): customers are being turned away`); } continue; }
      this.createOrder();
    }
  }

  createOrder(): Order {
    const nLines = this.rng.weighted([1, 2, 3, 4], n => [40, 32, 18, 10][n - 1]);
    const used = new Set<string>(); const lines: Order['lines'] = [];
    for (let i = 0; i < nLines; i++) {
      const sku = this.rng.weighted(this.layout.skus.filter(s => !used.has(s.id)), s => s.popularity * (s.id === this.hotSkuId ? 5 : 1));
      used.add(sku.id);
      lines.push({ skuId: sku.id, qty: this.rng.weighted([1, 2, 3], q => [55, 30, 15][q - 1]), picked: 0, fromLocations: [] });
    }
    const num = (this.ids['O'] ?? 0) + 1;
    const customer = this.rng.pick(CUSTOMERS);
    // carrier route: each customer ships through a fixed outbound dock
    const dockId = CUSTOMERS.indexOf(customer) % 2 === 0 ? 'DOCK-OUT-1' : 'DOCK-OUT-2';
    const o: Order = { id: this.nid('O'), num, customer, lines, state: 'NEW', createdAt: this.time, shippedAt: null, toteId: null, cartonId: null, jobId: null, rush: this.rushActive, dockId };
    this.orders.set(o.id, o); this.orderList.push(o); this.metrics.ordersCreated++;
    if (this.orderList.length > 400) { // prune old shipped orders
      const idx = this.orderList.findIndex(x => x.state === 'SHIPPED');
      if (idx >= 0) { const old = this.orderList.splice(idx, 1)[0]; this.orders.delete(old.id); }
    }
    return o;
  }

  private setOrderState(o: Order, s: OrderState) { o.state = s; }

  /** Try to reserve stock for NEW / BACKORDER orders (all-or-nothing per order). */
  private allocateOrders() {
    for (const o of this.orderList) {
      if (o.state !== 'NEW' && o.state !== 'BACKORDER') continue;
      const plan: { line: Order['lines'][number]; from: { loc: RackLocation; qty: number }[] }[] = [];
      let ok = true;
      const tempRes = new Map<RackLocation, number>();
      for (const line of o.lines) {
        let need = line.qty; const from: { loc: RackLocation; qty: number }[] = [];
        const locs = (this.locsBySku.get(line.skuId) ?? []).filter(l => l.qty - l.reserved - (tempRes.get(l) ?? 0) > 0)
          .sort((a, b) => (b.qty - b.reserved) - (a.qty - a.reserved));
        // prefer a single location that covers the line, else largest first
        const single = locs.find(l => l.qty - l.reserved - (tempRes.get(l) ?? 0) >= need);
        const seq = single ? [single] : locs;
        for (const l of seq) {
          if (need <= 0) break;
          const avail = l.qty - l.reserved - (tempRes.get(l) ?? 0);
          const take = Math.min(avail, need);
          if (take > 0) { from.push({ loc: l, qty: take }); tempRes.set(l, (tempRes.get(l) ?? 0) + take); need -= take; }
        }
        if (need > 0) { ok = false; break; }
        plan.push({ line, from });
      }
      if (!ok) { if (o.state === 'NEW') { this.setOrderState(o, 'BACKORDER'); this.emit('warn', `Order #${o.num} on backorder (stock shortage)`); } continue; }
      for (const p of plan) { p.line.fromLocations = p.from.map(f => ({ locId: f.loc.id, qty: f.qty })); for (const f of p.from) f.loc.reserved += f.qty; }
      this.setOrderState(o, 'ALLOCATED');
      this.version++;
    }
  }

  // ---------------------------------------------------------------- planner: create jobs from world state
  private plan() {
    // UNLOAD: pallets in docked inbound trucks
    for (const tr of this.trucks.values()) {
      if (tr.kind !== 'inbound' || tr.state !== 'docked') continue;
      for (const cid of tr.containerIds) this.ensureJob(`unload:${cid}`, () => this.makeUnloadJob(this.containers.get(cid)!, tr));
    }
    // INSPECT / PUTAWAY: pallets in receiving spots
    for (const s of this.spotsByKind.get('receiving')!) for (const cid of s.containerIds) {
      const c = this.containers.get(cid)!;
      if (c.inspected) this.ensureJob(`putaway:${cid}`, () => this.makePutawayJob(c));
      else this.ensureJob(`inspect:${cid}`, () => this.makeInspectJob(c));
    }
    for (const s of this.spotsByKind.get('inspect_out')!) for (const cid of s.containerIds) this.ensureJob(`putaway:${cid}`, () => this.makePutawayJob(this.containers.get(cid)!));
    // PICK: allocated orders
    for (const o of this.orderList) if (o.state === 'ALLOCATED') this.ensureJob(`pick:${o.id}`, () => this.makePickJob(o));
    // PACK: totes in pack_in spots
    for (const kind of ['pack_in', 'pack_bench'] as SpotKind[]) for (const s of this.spotsByKind.get(kind)!) for (const cid of s.containerIds) this.ensureJob(`pack:${cid}`, () => this.makePackJob(this.containers.get(cid)!));
    // drop queued LOAD jobs whose truck has gone
    for (const j of [...this.jobs.values()]) if (j.type === 'LOAD' && j.state === 'open' && j.refs.truckId && this.trucks.get(j.refs.truckId)?.state !== 'docked') { this.jobs.delete(j.id); this.sources.delete(j.sourceKey); }
    // LOAD: cartons at lane discharge ends while a truck for that dock is docked with room
    for (const tr of this.trucks.values()) {
      if (tr.kind !== 'outbound' || tr.state !== 'docked') continue;
      let room = tr.capacity - tr.containerIds.length - tr.pending;
      for (const j of this.jobs.values()) if (j.type === 'LOAD' && j.state === 'open' && j.refs.truckId === tr.id) room--;
      for (const lane of this.conveyor.lanes) {
        if (lane.dockId !== tr.dockId) continue;
        const c = this.conveyor.dischargeReady(lane); if (!c || this.sources.has(`load:${c.id}`)) continue;
        if (room <= 0) break;
        this.ensureJob(`load:${c.id}`, () => this.makeLoadJob(c, lane, tr)); room--;
      }
    }
    // TOTE_RETURN: empties accumulating at pack stations
    for (const s of this.spotsByKind.get('pack_out')!) if (s.containerIds.length >= 3) this.ensureJob(`toteret:${s.id}`, () => this.makeToteReturnJob(s));
  }

  private ensureJob(key: string, make: () => Job | null) {
    if (this.sources.has(key)) return;
    const j = make(); if (!j) return;
    j.sourceKey = key; this.sources.add(key); this.jobs.set(j.id, j);
  }

  private baseJob(type: JobType, summary: string, refs: Job['refs']): Job {
    return { id: this.nid('J'), type, state: 'open', workerId: null, priority: JOB_PRIORITY[type], createdAt: this.time, startedAt: null, steps: [], stepIdx: 0, summary, refs, validate: () => true, release: () => {}, claim: () => true, attempts: 0, onlyWorkerId: null, sourceKey: '' };
  }

  private goto(cell: Cell, label: string, face?: Cell): Step { return { kind: 'goto', cell, label, face }; }
  private work(duration: number, label: string, then?: () => boolean | void): Step { return { kind: 'work', duration, label, then }; }

  private spotRoom(s: Spot) { return s.capacity - s.containerIds.length - s.pending; }
  private nearestSpot(kind: SpotKind, from: Cell, pred: (s: Spot) => boolean = () => true): Spot | null {
    let best: Spot | null = null, bd = Infinity;
    for (const s of this.spotsByKind.get(kind)!) { if (!pred(s) || this.spotRoom(s) <= 0) continue; const d = dist(s.accessCell, from); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  private pickupFromSpot(w: Worker, c: Container) {
    const s = c.spotId ? this.spots.get(c.spotId) : null;
    if (s) { const i = s.containerIds.indexOf(c.id); if (i >= 0) s.containerIds.splice(i, 1); }
    c.spotId = null; c.carriedBy = w.id; c.reservedBy = null; w.carrying = c.id; this.version++;
  }
  private dropToSpot(w: Worker, c: Container, s: Spot, hadPending: boolean) {
    if (hadPending) s.pending = Math.max(0, s.pending - 1);
    s.containerIds.push(c.id); c.spotId = s.id; c.carriedBy = null; c.reservedBy = null; w.carrying = null; this.version++;
  }

  // ---- UNLOAD
  private makeUnloadJob(c: Container, tr: Truck): Job {
    const sku = this.skus.get(c.lines[0].skuId)!;
    const j = this.baseJob('UNLOAD', `Unload pallet ${c.id} (${c.lines[0].qty}× ${sku.name})`, { containerId: c.id, truckId: tr.id });
    let spot: Spot | null = null; let picked = false; let dropped = false;
    j.claim = (wid) => {
      spot = this.nearestSpot('receiving', tr.dockCell);
      if (!spot) return false;
      spot.pending++; tr.activeUnloads++;
      const w = this.worker(wid);
      j.refs.spotIds = [spot.id];
      j.steps = [
        this.goto(tr.dockCell, 'Walking to dock', { cx: tr.dockCell.cx - 2, cz: tr.dockCell.cz }),
        this.work(1.4, 'Unloading pallet', () => {
          const i = tr.containerIds.indexOf(c.id); if (i < 0) return false;
          tr.containerIds.splice(i, 1); c.truckId = null; c.carriedBy = w.id; w.carrying = c.id; picked = true; this.version++;
          this.metrics.palletsReceived++; this.metrics.unitsReceived += c.lines[0].qty;
        }),
        this.goto(spot.accessCell, 'Carrying pallet to receiving', spot.cell),
        this.work(0.9, 'Setting down pallet', () => { this.dropToSpot(w, c, spot!, true); dropped = true; tr.activeUnloads--; }),
      ];
      return true;
    };
    j.validate = () => picked || (tr.state === 'docked' && tr.containerIds.includes(c.id));
    j.release = () => { if (spot && !dropped) { spot.pending = Math.max(0, spot.pending - 1); tr.activeUnloads = Math.max(0, tr.activeUnloads - 1); } };
    return j;
  }

  // ---- INSPECT
  private makeInspectJob(c: Container): Job {
    const sku = this.skus.get(c.lines[0].skuId)!;
    const j = this.baseJob('INSPECT', `Inspect pallet ${c.id} (${sku.name})`, { containerId: c.id });
    let st: Station | null = null; let bench: Spot | null = null; let out: Spot | null = null; let onBench = false; let done = false; let picked = false;
    j.claim = (wid) => {
      const w = this.worker(wid);
      const src = this.spots.get(c.spotId!)!;
      let best: Station | null = null, bd = Infinity;
      for (const s of this.stations.values()) {
        if (s.kind !== 'inspect' || s.busyWorkerId) continue;
        const b = this.spots.get(s.spotIds.bench!)!, o = this.spots.get(s.spotIds.out!)!;
        if (this.spotRoom(b) <= 0 || this.spotRoom(o) <= 0) continue;
        const d = dist(s.accessCell, src.accessCell); if (d < bd) { bd = d; best = s; }
      }
      if (!best) return false;
      st = best; bench = this.spots.get(st.spotIds.bench!)!; out = this.spots.get(st.spotIds.out!)!;
      bench.pending++; out.pending++; st.busyWorkerId = wid; c.reservedBy = j.id;
      j.refs.stationId = st.id; j.refs.spotIds = [src.id, bench.id, out.id];
      j.steps = [
        this.goto(src.accessCell, 'Walking to receiving', src.cell),
        this.work(0.8, 'Lifting pallet', () => { if (c.spotId !== src.id) return false; this.pickupFromSpot(w, c); picked = true; }),
        this.goto(bench!.accessCell, 'Carrying pallet to inspection', bench!.cell),
        this.work(0.6, 'Placing on bench', () => { this.dropToSpot(w, c, bench!, true); onBench = true; }),
        this.work(3.6, `Inspecting ${sku.name}`, () => { c.inspected = true; st!.processed++; this.version++; }),
        { kind: 'act', label: 'Lift pallet', fn: () => { this.pickupFromSpot(w, c); onBench = false; } },
        this.goto(out!.accessCell, 'Moving to outbound buffer', out!.cell),
        this.work(0.6, 'Setting down pallet', () => { this.dropToSpot(w, c, out!, true); st!.busyWorkerId = null; done = true; }),
      ];
      return true;
    };
    j.validate = () => picked || (c.spotId !== null && this.spots.get(c.spotId)!.kind === 'receiving');
    j.release = () => {
      if (st && !done) { st.busyWorkerId = null; if (!onBench) bench!.pending = Math.max(0, bench!.pending - 1); out!.pending = Math.max(0, out!.pending - 1); }
      c.reservedBy = null;
    };
    return j;
  }

  /** Choose a rack location that can take qty of sku. Prefers consolidating with same-SKU slots, then empty slots near the picking side for popular SKUs. */
  private chooseLocation(skuId: string, qty: number, from: Cell): RackLocation | null {
    const sku = this.skus.get(skuId)!;
    let best: RackLocation | null = null, bs = Infinity;
    for (const l of this.locsBySku.get(skuId) ?? []) {
      if (l.qty + l.incoming + qty > l.capacity) continue;
      const s = dist(l.accessCell, from) * 0.5 + l.level * 2 - 6; // consolidation bonus
      if (s < bs) { bs = s; best = l; }
    }
    const pop = sku.popularity / 9;
    for (const l of this.emptyLocs) {
      if (l.incoming > 0) continue;
      // popular SKUs go east (near picking) & low; slow movers go west & high
      const eastness = (l.cell.cx - 12) / 17; // 0..1
      const s = dist(l.accessCell, from) * 0.35 + l.level * (1 + pop * 2) + Math.abs(eastness - pop) * 14;
      if (s < bs) { bs = s; best = l; }
    }
    return best;
  }

  // ---- PUTAWAY (pallets; also restock of orphaned totes)
  private makePutawayJob(c: Container): Job | null {
    const isTote = c.kind === 'tote';
    const j = this.baseJob('PUTAWAY', isTote ? `Restock tote ${c.id}` : `Put away pallet ${c.id} (${c.lines[0].qty}× ${this.skus.get(c.lines[0].skuId)!.name})`, { containerId: c.id });
    const targets: { loc: RackLocation; line: Container['lines'][number]; qty: number; placed: boolean }[] = [];
    let picked = false; let shelf: Spot | null = null;
    j.claim = (wid) => {
      const w = this.worker(wid);
      const start = c.spotId ? this.spots.get(c.spotId)!.accessCell : w.cell;
      const tmp: typeof targets = [];
      for (const line of c.lines) {
        const loc = this.chooseLocation(line.skuId, line.qty, start);
        if (!loc) { for (const t of tmp) { t.loc.incoming -= t.qty; this.maybeFreeLoc(t.loc); } return false; }
        loc.incoming += line.qty; if (!loc.skuId) this.locSetSku(loc, line.skuId);
        tmp.push({ loc, line, qty: line.qty, placed: false });
      }
      if (isTote) { shelf = this.nearestSpot('tote_shelf', start); if (!shelf) { for (const t of tmp) { t.loc.incoming -= t.qty; this.maybeFreeLoc(t.loc); } return false; } shelf.pending++; }
      targets.push(...tmp); c.reservedBy = j.id;
      j.refs.locationIds = targets.map(t => t.loc.id);
      j.summary = isTote ? `Restock tote ${c.id}` : `Put away ${c.id} → ${targets[0].loc.id}`;
      const steps: Step[] = [];
      if (c.spotId) {
        const src = this.spots.get(c.spotId)!;
        steps.push(this.goto(src.accessCell, 'Walking to pallet', src.cell), this.work(0.8, 'Lifting pallet', () => { if (c.spotId !== src.id) return false; this.pickupFromSpot(w, c); picked = true; }));
      } else picked = true;
      for (const t of targets) {
        steps.push(this.goto(t.loc.accessCell, `Carrying to ${t.loc.id}`, t.loc.cell), this.work(1.2 + 0.5 * t.loc.level, `Putting away at ${t.loc.id}`, () => {
          if (t.loc.skuId !== t.line.skuId) return false;
          t.loc.qty += t.qty; t.loc.incoming -= t.qty; t.placed = true;
          t.line.qty -= t.qty; this.version++;
        }));
      }
      if (isTote) steps.push(this.goto(shelf!.accessCell, 'Returning tote', shelf!.cell), this.work(0.4, 'Shelving tote', () => { c.lines = []; c.orderId = null; this.dropToSpot(w, c, shelf!, true); }));
      else steps.push({ kind: 'act', label: 'Recycle pallet', fn: () => { this.containers.delete(c.id); w.carrying = null; this.version++; } });
      j.steps = steps;
      return true;
    };
    j.validate = () => picked || c.spotId !== null;
    j.release = () => { for (const t of targets) if (!t.placed) { t.loc.incoming -= t.qty; this.maybeFreeLoc(t.loc); } if (shelf && c.carriedBy !== null) shelf.pending = Math.max(0, shelf.pending - 1); c.reservedBy = null; };
    return j;
  }

  // ---- PICK
  private makePickJob(o: Order): Job {
    const j = this.baseJob('PICK', `Pick order #${o.num} (${o.lines.length} lines)`, { orderId: o.id });
    if (o.rush) j.priority += 8;
    let tote: Container | null = null; let packIn: Spot | null = null; let delivered = false; let toteTaken = false;
    const visits: { loc: RackLocation; line: Order['lines'][number]; qty: number; done: boolean }[] = [];
    j.claim = (wid) => {
      const w = this.worker(wid);
      let shelf: Spot | null = null, bd = Infinity;
      for (const s of this.spotsByKind.get('tote_shelf')!) {
        const free = s.containerIds.filter(id => !this.containers.get(id)!.reservedBy);
        if (!free.length) continue;
        const d = dist(s.accessCell, w.cell); if (d < bd) { bd = d; shelf = s; }
      }
      if (!shelf) return false;
      let best: Spot | null = null, bl = Infinity;
      for (const s of this.spotsByKind.get('pack_in')!) { if (this.spotRoom(s) <= 0) continue; const load = s.containerIds.length + s.pending; if (load < bl) { bl = load; best = s; } }
      if (!best) return false;
      packIn = best; packIn.pending++;
      tote = this.containers.get(shelf.containerIds.find(id => !this.containers.get(id)!.reservedBy)!)!;
      tote.reservedBy = j.id;
      o.jobId = j.id;
      // build visit list & route (nearest-neighbour from shelf)
      visits.length = 0;
      for (const line of o.lines) for (const f of line.fromLocations) visits.push({ loc: this.racks.get(f.locId)!, line, qty: f.qty, done: false });
      const ordered: typeof visits = []; let cur = shelf.accessCell; const rem = visits.slice();
      while (rem.length) { let bi = 0, bdd = Infinity; rem.forEach((v, i) => { const d = dist(v.loc.accessCell, cur); if (d < bdd) { bdd = d; bi = i; } }); const v = rem.splice(bi, 1)[0]; ordered.push(v); cur = v.loc.accessCell; }
      visits.splice(0, visits.length, ...ordered);
      j.refs.containerId = tote.id; j.refs.locationIds = visits.map(v => v.loc.id); j.refs.spotIds = [shelf.id, packIn.id];
      const shelfRef = shelf;
      j.steps = [
        this.goto(shelfRef.accessCell, 'Fetching tote', shelfRef.cell),
        this.work(0.5, 'Grabbing empty tote', () => { if (tote!.spotId !== shelfRef.id) return false; this.pickupFromSpot(w, tote!); tote!.orderId = o.id; o.toteId = tote!.id; toteTaken = true; this.setOrderState(o, 'PICKING'); }),
      ];
      for (const v of visits) {
        const sku = this.skus.get(v.line.skuId)!;
        j.steps.push(this.goto(v.loc.accessCell, `Walking to ${v.loc.id}`, v.loc.cell), this.work(0.9 + 0.45 * v.qty + 0.35 * v.loc.level, `Picking ${v.qty}× ${sku.name}`, () => {
          if (v.loc.skuId !== v.line.skuId || v.loc.qty < v.qty || v.loc.reserved < v.qty) return false;
          v.loc.qty -= v.qty; v.loc.reserved -= v.qty; v.done = true; this.maybeFreeLoc(v.loc);
          const ln = tote!.lines.find(l => l.skuId === v.line.skuId); if (ln) ln.qty += v.qty; else tote!.lines.push({ skuId: v.line.skuId, qty: v.qty });
          v.line.picked += v.qty; this.metrics.unitsPicked += v.qty; this.version++;
        }));
      }
      j.steps.push(this.goto(packIn.accessCell, 'Delivering tote to packing', packIn.cell), this.work(0.6, 'Dropping tote', () => {
        this.dropToSpot(w, tote!, packIn!, true); delivered = true; this.setOrderState(o, 'PICKED'); o.jobId = null;
      }));
      return true;
    };
    j.validate = () => o.state === 'ALLOCATED' || o.state === 'PICKING';
    j.release = () => {
      if (packIn && !delivered) packIn.pending = Math.max(0, packIn.pending - 1);
      for (const v of visits) if (!v.done) { v.loc.reserved = Math.max(0, v.loc.reserved - v.qty); this.maybeFreeLoc(v.loc); }
      if (!visits.length) for (const line of o.lines) for (const f of line.fromLocations) { const l = this.racks.get(f.locId)!; l.reserved = Math.max(0, l.reserved - f.qty); this.maybeFreeLoc(l); }
      if (tote) { tote.reservedBy = null; if (toteTaken && !delivered) { tote.orderId = null; } }
      if (!delivered) { for (const line of o.lines) { line.picked = 0; line.fromLocations = []; } o.toteId = null; o.jobId = null; this.setOrderState(o, 'NEW'); }
      this.version++;
    };
    return j;
  }

  // ---- PACK: tote -> bench -> carton -> induction conveyor
  private makePackJob(tote: Container): Job | null {
    const o = tote.orderId ? this.orders.get(tote.orderId) : null;
    if (!o) return null;
    const j = this.baseJob('PACK', `Pack order #${o.num}`, { orderId: o.id, containerId: tote.id });
    if (o.rush) j.priority += 5;
    let st: Station | null = null; let carton: Container | null = null; let inducted = false; let picked = false; let onBench = false;
    j.claim = (wid) => {
      const w = this.worker(wid);
      const inSpot = this.spots.get(tote.spotId!)!;
      const alreadyOnBench = inSpot.kind === 'pack_bench';
      st = [...this.stations.values()].find(s => s.spotIds.in === inSpot.id || s.spotIds.bench === inSpot.id)!;
      const bench = this.spots.get(st.spotIds.bench!)!;
      if (st.busyWorkerId || (!alreadyOnBench && this.spotRoom(bench) <= 0)) return false;
      const ind = this.conveyor.segments.get(st.inductionId!)!;
      st.busyWorkerId = wid; tote.reservedBy = j.id;
      if (!alreadyOnBench) bench.pending++; else { onBench = true; picked = true; }
      j.refs.stationId = st.id; j.refs.spotIds = [inSpot.id, bench.id]; j.refs.conveyorId = ind.id;
      const outSpot = this.spots.get(st.spotIds.out!)!;
      j.steps = alreadyOnBench ? [this.goto(bench.accessCell, 'Walking to bench', bench.cell), this.work(0.3, 'Resuming pack', () => { if (tote.spotId !== bench.id) return false; this.setOrderState(o, 'PACKING'); })] : [
        this.goto(inSpot.accessCell, 'Walking to pack station', inSpot.cell),
        this.work(0.5, 'Taking tote', () => { if (tote.spotId !== inSpot.id) return false; this.pickupFromSpot(w, tote); picked = true; }),
        this.goto(bench.accessCell, 'Moving to bench', bench.cell),
        this.work(0.4, 'Placing tote on bench', () => { this.dropToSpot(w, tote, bench, true); onBench = true; this.setOrderState(o, 'PACKING'); }),
      ];
      j.steps.push(
        this.work(3.2 + 0.6 * o.lines.length, `Packing order #${o.num}`, () => {
          carton = this.newContainer('carton', tote.lines.map(l => ({ ...l })));
          carton.orderId = o.id; o.cartonId = carton.id;
          tote.lines = []; tote.orderId = null; tote.reservedBy = null;
          const bi = bench.containerIds.indexOf(tote.id); if (bi >= 0) bench.containerIds.splice(bi, 1);
          outSpot.containerIds.push(tote.id); tote.spotId = outSpot.id; onBench = false;
          carton.carriedBy = w.id; w.carrying = carton.id;
          st!.processed++; this.metrics.cartonsPacked++;
          this.setOrderState(o, 'PACKED'); this.version++;
        }),
        this.goto(st.inductionAccess!, 'Carrying carton to conveyor', ind.cells[0]),
        { kind: 'wait', label: 'Waiting for conveyor space', until: () => this.conveyor.entryFree(ind) },
        this.work(0.5, 'Placing carton on conveyor', () => {
          if (!this.conveyor.entryFree(ind)) return false;
          this.conveyor.induct(carton!, ind); w.carrying = null; inducted = true;
          this.setOrderState(o, 'SORTING'); st!.busyWorkerId = null; this.metrics.cartonsInducted++;
        }),
      );
      return true;
    };
    j.validate = () => picked || (tote.spotId !== null && (this.spots.get(tote.spotId)!.kind === 'pack_in' || this.spots.get(tote.spotId)!.kind === 'pack_bench'));
    j.release = () => {
      if (st && st.busyWorkerId === j.workerId) st.busyWorkerId = null;
      if (st && !onBench && !carton) { const b = this.spots.get(st.spotIds.bench!)!; b.pending = Math.max(0, b.pending - 1); }
      tote.reservedBy = null;
      if (!carton && picked && o.state === 'PACKING') this.setOrderState(o, 'PICKED');
      void inducted;
    };
    return j;
  }

  // ---- LOAD: carton from a sortation lane end onto the truck for that lane's dock
  private makeLoadJob(carton: Container, lane: Segment, tr: Truck): Job | null {
    const o = carton.orderId ? this.orders.get(carton.orderId) : null;
    if (!o) return null;
    const j = this.baseJob('LOAD', `Load order #${o.num} from lane ${lane.laneNo}`, { orderId: o.id, containerId: carton.id, conveyorId: lane.id, truckId: tr.id });
    let loaded = false; let picked = false; let claimed = false;
    j.claim = (wid) => {
      const w = this.worker(wid);
      if (tr.state !== 'docked' || tr.containerIds.length + tr.pending >= tr.capacity) return false;
      if (o.dockId !== tr.dockId || lane.dockId !== tr.dockId) { this.emit('warn', `Routing check refused ${carton.id}: order dock ${o.dockId} vs truck ${tr.dockId}`); return false; }
      tr.pending++; carton.reservedBy = j.id; claimed = true;
      j.steps = [
        this.goto(lane.accessCell!, `Walking to lane ${lane.laneNo}`, lane.cells[2]),
        this.work(0.5, 'Lifting carton off lane', () => { if (this.conveyor.dischargeReady(lane)?.id !== carton.id) return false; this.conveyor.remove(carton); carton.carriedBy = w.id; w.carrying = carton.id; picked = true; this.setOrderState(o, 'LOADING'); }),
        this.goto(tr.dockCell, 'Carrying carton to truck', { cx: tr.dockCell.cx + 2, cz: tr.dockCell.cz }),
        this.work(0.8, 'Loading truck', () => {
          if (tr.state !== 'docked') return false;
          if (o.dockId !== tr.dockId) { this.emit('warn', `Load refused: order #${o.num} routed to ${o.dockId}`); return false; }
          tr.containerIds.push(carton.id); carton.truckId = tr.id; carton.carriedBy = null; w.carrying = null; tr.pending--; tr.loadedCount++; loaded = true; this.version++;
        }),
      ];
      return true;
    };
    j.validate = () => tr.state === 'docked' && (picked || this.conveyor.dischargeReady(lane)?.id === carton.id);
    j.release = () => { if (claimed && !loaded) tr.pending = Math.max(0, tr.pending - 1); carton.reservedBy = null; if (picked && !loaded) this.setOrderState(o, 'PACKED'); };
    return j;
  }

  // ---- TOTE_RETURN
  private makeToteReturnJob(out: Spot): Job {
    const j = this.baseJob('TOTE_RETURN', `Return empty totes from ${out.stationId}`, { spotIds: [out.id] });
    let shelf: Spot | null = null; let ids: string[] = []; let dropped = false; let taken = false;
    j.claim = (wid) => {
      const w = this.worker(wid);
      const n = Math.min(4, out.containerIds.length);
      if (n === 0) return false;
      shelf = this.nearestSpot('tote_shelf', out.accessCell, s => this.spotRoom(s) >= n);
      if (!shelf) return false;
      shelf.pending += n; ids = out.containerIds.slice(0, n);
      j.refs.spotIds = [out.id, shelf.id];
      j.steps = [
        this.goto(out.accessCell, 'Collecting empty totes', out.cell),
        this.work(0.7, 'Stacking totes', () => {
          ids = ids.filter(id => out.containerIds.includes(id)); if (!ids.length) return false;
          for (const id of ids) { const c = this.containers.get(id)!; const i = out.containerIds.indexOf(id); out.containerIds.splice(i, 1); c.spotId = null; c.carriedBy = w.id; }
          w.carrying = ids[0]; w.carryExtra = ids.slice(1); taken = true; this.version++;
        }),
        this.goto(shelf.accessCell, 'Carrying totes to shelf', shelf.cell),
        this.work(0.6, 'Shelving totes', () => {
          for (const id of ids) { const c = this.containers.get(id)!; shelf!.containerIds.push(id); c.spotId = shelf!.id; c.carriedBy = null; }
          shelf!.pending -= ids.length; w.carrying = null; w.carryExtra = []; dropped = true; this.version++;
        }),
      ];
      return true;
    };
    j.validate = () => taken || out.containerIds.length > 0;
    j.release = () => { if (shelf && !dropped) shelf.pending = Math.max(0, shelf.pending - ids.length); };
    return j;
  }

  // ---- recovery job for a carried container after a failure
  private makeRecoveryJob(w: Worker, c: Container): Job | null {
    if (c.kind === 'pallet') return this.makeDropJob(w, c, c.inspected ? 'inspect_out' : 'receiving', 'receiving');
    if (c.kind === 'tote') {
      if (c.lines.length) { c.orderId = null; return this.makePutawayJob(c); }
      return this.makeDropJob(w, c, 'tote_shelf');
    }
    return this.makeInductJob(w, c);
  }
  /** A worker holding a carton (after an abandoned task) walks it to the nearest induction and waits for space. */
  private makeInductJob(w: Worker, c: Container): Job {
    const j = this.baseJob('PACK', `Re-induct carton ${c.id}`, { containerId: c.id, orderId: c.orderId ?? undefined });
    j.claim = () => {
      let best: Segment | null = null, bd = Infinity;
      for (const ind of this.conveyor.inductions) { const d = dist(ind.accessCell!, w.cell); if (d < bd) { bd = d; best = ind; } }
      if (!best) return false; const ind = best; j.refs.conveyorId = ind.id;
      j.steps = [this.goto(ind.accessCell!, 'Carrying carton to conveyor', ind.cells[0]), { kind: 'wait', label: 'Waiting for conveyor space', until: () => this.conveyor.entryFree(ind) },
        this.work(0.5, 'Placing carton on conveyor', () => { if (!this.conveyor.entryFree(ind)) return false; this.conveyor.induct(c, ind); w.carrying = null; const o = c.orderId ? this.orders.get(c.orderId) : null; if (o) this.setOrderState(o, 'SORTING'); })];
      return true;
    };
    return j;
  }
  private makeDropJob(w: Worker, c: Container, kind: SpotKind, alt?: SpotKind): Job {
    const j = this.baseJob(c.kind === 'carton' ? 'PACK' : c.kind === 'tote' ? 'TOTE_RETURN' : 'UNLOAD', `Return ${c.kind} ${c.id}`, { containerId: c.id });
    let spot: Spot | null = null; let dropped = false;
    j.claim = () => {
      spot = this.nearestSpot(kind, w.cell) ?? (alt ? this.nearestSpot(alt, w.cell) : null);
      if (!spot) return false;
      spot.pending++;
      const extra = w.carryExtra.slice();
      j.steps = [this.goto(spot.accessCell, `Returning ${c.kind}`, spot.cell), this.work(0.6, `Setting down ${c.kind}`, () => {
        this.dropToSpot(w, c, spot!, true); dropped = true;
        for (const id of extra) { const e = this.containers.get(id); if (!e) continue; spot!.containerIds.push(id); e.spotId = spot!.id; e.carriedBy = null; }
        w.carryExtra = [];
        const o = c.orderId ? this.orders.get(c.orderId) : null; if (o && c.kind === 'carton') this.setOrderState(o, 'STAGED');
      })];
      return true;
    };
    j.release = () => { if (spot && !dropped) spot.pending = Math.max(0, spot.pending - 1); };
    return j;
  }

  // ---------------------------------------------------------------- dispatcher
  private dispatch() {
    const open: Job[] = [];
    for (const j of this.jobs.values()) if (j.state === 'open') open.push(j);
    if (!open.length) return;
    for (const w of this.workers) {
      if (w.jobId) continue;
      const cands = open.filter(j => j.state === 'open' && (!j.onlyWorkerId || j.onlyWorkerId === w.id) && !(w.carrying && !j.onlyWorkerId))
        .map(j => ({ j, s: this.score(w, j) })).sort((a, b) => b.s - a.s);
      let tries = 0; const failedByType = new Map<JobType, number>();
      for (const { j } of cands) {
        if (tries > 30) break;
        if ((failedByType.get(j.type) ?? 0) >= 3) continue; // repeated failures of a type usually mean a shared resource is exhausted
        tries++; j.attempts++;
        if (!j.claim(w.id)) { failedByType.set(j.type, (failedByType.get(j.type) ?? 0) + 1); continue; }
        {
          j.state = 'active'; j.workerId = w.id; j.startedAt = this.time; j.stepIdx = 0;
          w.jobId = j.id; w.path = []; w.pathIdx = 0; w.stuckTimer = 0; w.replans = 0;
          break;
        }
      }
    }
  }
  private score(w: Worker, j: Job) {
    const age = this.time - j.createdAt;
    const roleBonus = ROLE_JOBS[w.role].includes(j.type) ? 28 : 0;
    const seg = j.refs.conveyorId ? this.conveyor.segments.get(j.refs.conveyorId) : null;
    const target = j.refs.spotIds?.length ? this.spots.get(j.refs.spotIds[0])!.accessCell : seg?.accessCell ? seg.accessCell : j.refs.truckId ? (this.trucks.get(j.refs.truckId)?.dockCell ?? w.cell) : j.refs.orderId ? { cx: 32, cz: 15 } : w.cell;
    return j.priority + roleBonus + Math.min(30, age * 0.15) - dist(w.cell, target) * 0.5;
  }

  // ---------------------------------------------------------------- workers
  worker(id: string) { return this.workers.find(w => w.id === id)!; }

  private updateWorker(w: Worker, dt: number) {
    const job = w.jobId ? this.jobs.get(w.jobId) : undefined;
    if (!job) {
      w.jobId = null;
      if (w.carrying) { // holding something with no job: create a recovery job only this worker can take
        const c = this.containers.get(w.carrying);
        if (!c) { w.carrying = null; w.carryExtra = []; }
        else if (!this.sources.has(`recover:${c.id}`)) { const rj = this.makeRecoveryJob(w, c); if (rj) { rj.onlyWorkerId = w.id; rj.priority = 100; rj.summary = `Recover ${c.kind} ${c.id}`; this.ensureJob(`recover:${c.id}`, () => rj); } }
        w.state = 'idle';
        return;
      }
      // idle: after a short pause walk back to the role's home area (a real behaviour, not wandering)
      if (w.state !== 'walking') { if (w.state !== 'idle') { w.state = 'idle'; w.idleSince = this.time; } }
      const home = ROLE_HOME[w.role];
      if (w.state === 'idle' && this.time - w.idleSince > 6 && dist(w.cell, home) > 3) {
        const goal = this.grid.nearestWalkable({ cx: home.cx, cz: home.cz + (this.workers.indexOf(w) % 5) - 2 });
        const p = this.grid.findPath(w.cell, goal); if (p && p.length) { w.path = p; w.pathIdx = 0; w.state = 'walking'; }
      }
      if (w.state === 'walking') { if (this.moveAlongPath(w, dt)) { w.state = 'idle'; w.idleSince = this.time; } }
      return;
    }
    const step = job.steps[job.stepIdx];
    if (!step) { this.completeJob(job, w); return; }
    if (step.kind === 'goto') {
      if (w.path.length === 0 || w.pathIdx >= w.path.length) {
        if (sameCell(w.cell, step.cell) && Math.hypot(w.x - step.cell.cx - 0.5, w.z - step.cell.cz - 0.5) < 0.6) {
          if (step.face) w.facing = Math.atan2(step.face.cx + 0.5 - w.x, step.face.cz + 0.5 - w.z);
          job.stepIdx++; w.path = []; w.pathIdx = 0; return;
        }
        if (!job.validate()) { this.abandonJob(job, w, 'target no longer valid'); return; }
        const p = this.grid.findPath(w.cell, step.cell);
        if (!p) { this.abandonJob(job, w, `no path to ${step.cell.cx},${step.cell.cz}`); return; }
        w.path = p; w.pathIdx = 0; w.stuckTimer = 0; w.lastProgressDist = Infinity;
        if (p.length === 0) return;
      }
      w.state = 'walking'; w.workLabel = step.label;
      if (this.moveAlongPath(w, dt)) { w.path = []; }
      if (w.stuckTimer > 3) {
        w.stuckTimer = 0; w.replans++; this.metrics.replans++;
        if (w.replans > 3) { this.abandonJob(job, w, 'stuck'); return; }
        w.cell = this.grid.nearestWalkable({ cx: Math.floor(w.x), cz: Math.floor(w.z) });
        w.x = w.cell.cx + 0.5; w.z = w.cell.cz + 0.5; w.path = [];
      }
    } else if (step.kind === 'work') {
      if (w.state !== 'working') {
        if (!job.validate()) { this.abandonJob(job, w, 'target no longer valid'); return; }
        w.state = 'working'; w.workTimer = step.duration; w.workTotal = step.duration; w.workLabel = step.label;
      }
      w.workTimer -= dt;
      if (w.workTimer <= 0) {
        const ok = step.then ? step.then() : true;
        w.state = 'idle';
        if (ok === false) { this.abandonJob(job, w, 'work step failed'); return; }
        job.stepIdx++;
      }
    } else if (step.kind === 'wait') {
      w.state = 'idle'; w.workLabel = step.label; w.waitTimer += dt;
      if (step.until()) { job.stepIdx++; w.waitTimer = 0; }
    } else {
      const ok = step.fn();
      if (ok === false) { this.abandonJob(job, w, 'action failed'); return; }
      job.stepIdx++;
    }
  }

  /** Advance along w.path; returns true when the path is finished. */
  private moveAlongPath(w: Worker, dt: number): boolean {
    if (w.pathIdx >= w.path.length) return true;
    const speed = w.speed * (w.carrying && this.containers.get(w.carrying)?.kind === 'pallet' ? 0.8 : 1);
    let remaining = speed * dt;
    while (remaining > 0 && w.pathIdx < w.path.length) {
      const target = w.path[w.pathIdx];
      let tx = target.cx + 0.5, tz = target.cz + 0.5;
      if (w.pathIdx < w.path.length - 1) { // lane offset perpendicular to the (fixed) segment direction
        const prev = w.pathIdx > 0 ? w.path[w.pathIdx - 1] : w.cell;
        const sx = target.cx - prev.cx, sz = target.cz - prev.cz; const sl = Math.hypot(sx, sz) || 1;
        tx += -sz / sl * w.lateral; tz += sx / sl * w.lateral;
      }
      const dx = tx - w.x, dz = tz - w.z; const d = Math.hypot(dx, dz);
      if (d <= remaining || d < 0.02) { w.x = tx; w.z = tz; w.cell = target; w.pathIdx++; remaining -= d; w.lastProgressDist = Infinity; continue; }
      w.x += dx / d * remaining; w.z += dz / d * remaining; w.facing = Math.atan2(dx, dz); remaining = 0;
      // stuck detection: distance to target must shrink
      if (d < w.lastProgressDist - 1e-3) { w.lastProgressDist = d; w.stuckTimer = 0; } else w.stuckTimer += dt;
      // keep the logical cell in sync with the continuous position
      const cc = { cx: Math.floor(w.x), cz: Math.floor(w.z) };
      if (!this.grid.isBlocked(cc.cx, cc.cz)) w.cell = cc;
    }
    return w.pathIdx >= w.path.length;
  }

  private completeJob(job: Job, w: Worker) {
    job.state = 'done'; this.jobs.delete(job.id); this.sources.delete(job.sourceKey);
    w.jobId = null; w.state = 'idle'; w.idleSince = this.time; w.jobsDone++; w.path = [];
  }

  private abandonJob(job: Job, w: Worker | null, reason: string) {
    if (job.state === 'failed') return;
    job.state = 'failed'; this.metrics.jobsFailed++;
    try { job.release(); } catch (e) { console.error('release failed', e); }
    this.jobs.delete(job.id); this.sources.delete(job.sourceKey);
    this.emit('warn', `${job.type} ${job.summary} abandoned: ${reason}`);
    if (w) { w.jobId = null; w.path = []; w.pathIdx = 0; w.state = 'idle'; w.idleSince = this.time; w.replans = 0; }
    this.version++;
  }

  /** Management actions available to the player. */
  hireWorker(): Worker | null {
    if (this.workers.length >= 20) return null;
    const n = this.workers.length; this.createWorkers(1);
    const w = this.workers[n]; const snap = this.snapshot();
    // the new hire takes the most understaffed role
    const need: Record<Role, number> = { receiver: snap.jobs.UNLOAD.open + snap.jobs.INSPECT.open + snap.jobs.PUTAWAY.open, picker: snap.jobs.PICK.open * 1.5, packer: snap.jobs.PACK.open, shipper: snap.jobs.LOAD.open };
    w.role = (Object.keys(need) as Role[]).sort((a, b) => need[b] - need[a])[0];
    // hires walk in through the receiving dock
    const door = this.grid.nearestWalkable({ cx: 1, cz: 9 }); w.cell = door; w.x = door.cx + 0.5; w.z = door.cz + 0.5; w.idleSince = -100;
    this.emit('info', `${w.name} joined the shift as ${w.role}`); return w;
  }
  triggerRush() { if (!this.rushActive) { this.nextRushAt = this.time; this.updateDemand(); } }
  callInboundTruck(): boolean { const d = this.docks.find(d => d.kind === 'inbound' && !d.truckId); if (!d) return false; d.nextArrival = this.time; return true; }

  /** Test hook: abandon whatever job a worker is doing, as if the task became invalid mid-way. */
  debugAbandon(workerId: string, reason = 'debug') { const w = this.worker(workerId); const j = w.jobId ? this.jobs.get(w.jobId) : null; if (j) this.abandonJob(j, w, reason); }

  // ---------------------------------------------------------------- queries for UI
  snapshot(): SimSnapshot {
    const jobs = {} as SimSnapshot['jobs'];
    for (const t of ['UNLOAD', 'INSPECT', 'PUTAWAY', 'PICK', 'PACK', 'LOAD', 'TOTE_RETURN'] as JobType[]) jobs[t] = { open: 0, active: 0 };
    for (const j of this.jobs.values()) if (j.state === 'open') jobs[j.type].open++; else if (j.state === 'active') jobs[j.type].active++;
    const orders = {} as SimSnapshot['orders'];
    for (const s of ['NEW', 'BACKORDER', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'SORTING', 'STAGED', 'LOADING', 'SHIPPED'] as OrderState[]) orders[s] = 0;
    let backlog = 0;
    for (const o of this.orderList) { orders[o.state]++; if (o.state !== 'SHIPPED') backlog++; }
    let onHand = 0, reserved = 0, incoming = 0, used = 0;
    for (const l of this.racks.values()) { onHand += l.qty; reserved += l.reserved; incoming += l.incoming; if (l.qty > 0) used++; }
    let inTotes = 0, inCartons = 0, onPallets = 0, onTrucks = 0;
    for (const c of this.containers.values()) { const u = c.lines.reduce((a, l) => a + l.qty, 0); if (c.truckId) onTrucks += u; else if (c.kind === 'tote') inTotes += u; else if (c.kind === 'carton') inCartons += u; else onPallets += u; }
    const win = 600; const cutoff = this.time - win; let n = 0; for (let i = this.metrics.shipTimes.length - 1; i >= 0 && this.metrics.shipTimes[i] > cutoff; i--) n++;
    const elapsed = Math.min(win, Math.max(60, this.time));
    const w = { total: this.workers.length, idle: 0, walking: 0, working: 0 };
    for (const wk of this.workers) { if (!wk.jobId) w.idle++; else if (wk.state === 'working') w.working++; else w.walking++; }
    const cv = this.conveyor; const main = cv.segments.get('MAIN')!;
    let onMain = main.cartons.length, inLanes = 0, blocked = 0, indBlocked = 0;
    for (const l of cv.lanes) inLanes += l.cartons.length;
    for (const sg of cv.segments.values()) if (sg.status === 'BLOCKED') { blocked++; if (sg.kind === 'induction') indBlocked++; }
    let cartons = onMain + inLanes; for (const ind of cv.inductions) cartons += ind.cartons.length;
    return {
      workers: w, jobs, orders,
      inventory: { onHand, reserved, incoming, inTotes, inCartons, onPallets, onTrucks, locationsUsed: used, locationsTotal: this.racks.size },
      throughputPerHour: n / elapsed * 3600,
      avgCycleTime: this.metrics.cycleTimes.length ? this.metrics.cycleTimes.reduce((a, b) => a + b, 0) / this.metrics.cycleTimes.length : 0,
      backlog, rush: this.rushActive,
      conveyor: { cartons, onMain, inLanes, blocked, throughputPerHour: cv.throughput(main), laneFill: cv.lanes.map(l => ({ id: l.id, name: l.name, n: l.cartons.length, cap: cv.laneCapacity(l), status: l.status, dockId: l.dockId! })), mainStatus: main.status, inductionsBlocked: indBlocked },
    };
  }

  /** Returns a list of invariant violations (empty when healthy). */
  checkInvariants(): string[] {
    const errs: string[] = [];
    for (const l of this.racks.values()) {
      if (l.qty < 0) errs.push(`${l.id} negative qty ${l.qty}`);
      if (l.reserved < 0 || l.reserved > l.qty) errs.push(`${l.id} reserved ${l.reserved} > qty ${l.qty}`);
      if (l.incoming < 0) errs.push(`${l.id} negative incoming`);
      if (l.qty + l.incoming > l.capacity) errs.push(`${l.id} over capacity ${l.qty}+${l.incoming}`);
      if (l.qty > 0 && !l.skuId) errs.push(`${l.id} qty without sku`);
    }
    // reservations must match allocated/picking orders
    const res = new Map<string, number>();
    for (const o of this.orderList) if (o.state === 'ALLOCATED' || o.state === 'PICKING') for (const ln of o.lines) {
      let unpicked = ln.qty - ln.picked;
      for (const f of ln.fromLocations) { const take = Math.min(f.qty, unpicked); unpicked -= take; }
      // fromLocations are consumed in route order, so compare totals per order instead
    }
    let totalRes = 0; for (const l of this.racks.values()) totalRes += l.reserved;
    let expected = 0; for (const o of this.orderList) if (o.state === 'ALLOCATED' || o.state === 'PICKING') for (const ln of o.lines) expected += ln.qty - ln.picked;
    if (totalRes !== expected) errs.push(`reserved total ${totalRes} != unpicked allocated ${expected}`);
    void res;
    for (const c of this.containers.values()) {
      const places = (c.spotId ? 1 : 0) + (c.carriedBy ? 1 : 0) + (c.truckId ? 1 : 0) + (c.convSeg ? 1 : 0);
      if (places !== 1) errs.push(`${c.id} in ${places} places`);
      if (c.spotId && !this.spots.get(c.spotId)!.containerIds.includes(c.id)) errs.push(`${c.id} spot mismatch`);
      if (c.carriedBy) { const w = this.worker(c.carriedBy); if (!w || (w.carrying !== c.id && !w.carryExtra.includes(c.id))) errs.push(`${c.id} carriedBy mismatch`); }
      for (const ln of c.lines) if (ln.qty < 0) errs.push(`${c.id} negative line`);
    }
    for (const s of this.spots.values()) { if (s.containerIds.length > s.capacity && s.kind !== 'pack_out') errs.push(`${s.id} over capacity`); if (s.pending < 0) errs.push(`${s.id} negative pending`); for (const id of s.containerIds) if (this.containers.get(id)?.spotId !== s.id) errs.push(`${s.id} holds ${id} with wrong spotId`); }
    for (const w of this.workers) {
      if (w.jobId && this.jobs.get(w.jobId)?.workerId !== w.id) errs.push(`${w.id} job mismatch`);
      if (w.carrying && this.containers.get(w.carrying)?.carriedBy !== w.id) errs.push(`${w.id} carrying mismatch`);
      if (this.grid.isBlocked(Math.floor(w.x), Math.floor(w.z))) errs.push(`${w.id} inside blocked cell ${Math.floor(w.x)},${Math.floor(w.z)}`);
      if (w.stuckTimer > 10) errs.push(`${w.id} stuck ${w.stuckTimer.toFixed(1)}s`);
    }
    for (const j of this.jobs.values()) if (j.state === 'active') { const w = this.worker(j.workerId!); if (!w || w.jobId !== j.id) errs.push(`job ${j.id} active without worker`); }
    errs.push(...this.conveyor.check());
    for (const tr of this.trucks.values()) if (tr.kind === 'outbound') for (const cid of tr.containerIds) { const o = this.orders.get(this.containers.get(cid)?.orderId ?? ''); if (o && o.dockId !== tr.dockId) errs.push(`order ${o.id} loaded on wrong dock ${tr.dockId}`); }
    for (const lane of this.conveyor.lanes) for (const cid of lane.cartons) { const o = this.orders.get(this.containers.get(cid)!.orderId!); if (o && o.dockId !== lane.dockId) errs.push(`order ${o.id} in lane for ${lane.dockId}`); }
    for (const o of this.orderList) {
      if (o.state === 'SHIPPED' && o.lines.some(l => l.picked < l.qty)) errs.push(`order ${o.id} shipped incomplete`);
      if ((o.state === 'PICKED' || o.state === 'PACKING' || o.state === 'PACKED' || o.state === 'SORTING' || o.state === 'STAGED' || o.state === 'LOADING') && o.lines.some(l => l.picked !== l.qty)) errs.push(`order ${o.id} ${o.state} with wrong picked qty`);
    }
    return errs;
  }
}

export function dist(a: Cell, b: Cell) { return Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz); }
export { RACK_LEVELS };
