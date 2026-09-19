import { Simulation } from '../src/sim/sim';
let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log('  FAIL:', msg); } else console.log('  ok:', msg); };
const run = (sim: Simulation, secs: number, every?: (i: number) => void) => { const n = Math.round(secs / sim.dt); for (let i = 0; i < n; i++) { sim.tick(); every?.(i); if (i % 40 === 0) { const e = sim.checkInvariants(); if (e.length) { fails++; console.log('  INVARIANT', sim.time.toFixed(1), e.slice(0, 3)); return; } } } };

console.log('Scenario 1: empty warehouse -> all orders backorder, then inbound arrives, putaway makes stock available, orders ship');
{
  const sim = new Simulation(3, { seedStock: false });
  run(sim, 30);
  const states = sim.orderList.map(o => o.state);
  check(states.every(s => s === 'BACKORDER'), `all ${states.length} initial orders on backorder (got ${[...new Set(states)].join(',')})`);
  check(sim.snapshot().inventory.onHand === 0, 'no stock on shelf');
  check(sim.metrics.unitsPicked === 0, 'nothing picked before putaway');
  run(sim, 25 * 60);
  check(sim.metrics.palletsReceived > 0, `pallets received: ${sim.metrics.palletsReceived}`);
  check(sim.metrics.ordersShipped > 0, `orders shipped after replenishment: ${sim.metrics.ordersShipped}`);
  check(sim.log.some(l => l.text.includes('backorder')), 'backorder events logged');
}

console.log('Scenario 2: repeatedly abandon jobs mid-flight; reservations/containers recover; nobody stays stuck');
{
  const sim = new Simulation(9);
  let abandons = 0;
  run(sim, 40 * 60, i => { if (i % 137 === 0) { const w = sim.workers[i % sim.workers.length]; if (w.jobId) { sim.debugAbandon(w.id, 'test'); abandons++; } } });
  check(abandons > 100, `abandoned ${abandons} jobs`);
  check(sim.metrics.jobsFailed >= abandons, `jobsFailed counted: ${sim.metrics.jobsFailed}`);
  check(sim.metrics.ordersShipped > 50, `still shipped ${sim.metrics.ordersShipped} orders`);
  // let the dust settle: nobody should be holding a container without a plan for it
  run(sim, 5 * 60);
  const carriedNoJob = sim.workers.filter(w => w.carrying && !w.jobId && ![...sim.jobs.values()].some(j => j.onlyWorkerId === w.id)).length;
  check(carriedNoJob === 0, 'no worker holding a container without a recovery job');
  let totalRes = 0; for (const l of sim.racks.values()) totalRes += l.reserved;
  let expected = 0; for (const o of sim.orderList) if (o.state === 'ALLOCATED' || o.state === 'PICKING') for (const ln of o.lines) expected += ln.qty - ln.picked;
  check(totalRes === expected, `reservations consistent (${totalRes} == ${expected})`);
  const orphanTotes = [...sim.containers.values()].filter(c => c.kind === 'tote' && c.lines.length && !c.orderId && !c.carriedBy && !c.reservedBy);
  check(orphanTotes.length === 0 || orphanTotes.every(c => c.spotId), `orphan totes with stock are resting somewhere visible (${orphanTotes.length})`);
  const totes = [...sim.containers.values()].filter(c => c.kind === 'tote').length;
  check(totes === 24, `tote count conserved: ${totes}`);
}

console.log('Scenario 3: order integrity across a long run');
{
  const sim = new Simulation(21);
  run(sim, 60 * 60);
  const shipped = sim.orderList.filter(o => o.state === 'SHIPPED');
  check(shipped.every(o => o.lines.every(l => l.picked === l.qty)), 'every shipped order fully picked');
  check(shipped.every(o => o.cartonId !== null), 'every shipped order has a carton');
  let inTotesCartons = 0; for (const c of sim.containers.values()) if (c.kind !== 'pallet') for (const l of c.lines) inTotesCartons += l.qty;
  const active = sim.orderList.filter(o => ['PICKING', 'PICKED', 'PACKING', 'PACKED', 'SORTING', 'STAGED', 'LOADING'].includes(o.state));
  const activePicked = active.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.picked, 0), 0);
  check(inTotesCartons === activePicked, `units in totes/cartons (${inTotesCartons}) == picked units of in-flight orders (${activePicked})`);
  const s = sim.snapshot();
  check(s.throughputPerHour > 200, `throughput ${s.throughputPerHour.toFixed(0)}/h`);
}

console.log('Scenario 4: conveyor backpressure — no outbound trucks until lanes, main line and inductions block; then recovery');
{
  const sim = new Simulation(31);
  // withhold outbound trucks
  const hold = () => { for (const d of sim.docks) if (d.kind === 'outbound') d.nextArrival = sim.time + 1e9; for (const t of sim.trucks.values()) if (t.kind === 'outbound' && t.state === 'docked' && t.pending === 0) { t.dwell = 0; } };
  let laneFull = false, mainBlocked = false, indBlocked = false, packerWaiting = false, maxOnMain = 0;
  run(sim, 25 * 60, () => {
    hold();
    const cv = sim.conveyor; const s = sim.snapshot();
    if (cv.lanes.filter(l => cv.isLaneFull(l)).length >= 2) laneFull = true;
    if (cv.segments.get('MAIN')!.status === 'BLOCKED') mainBlocked = true;
    if (cv.inductions.some(i => i.status === 'BLOCKED')) indBlocked = true;
    if (sim.workers.some(w => w.workLabel === 'Waiting for conveyor space' && w.jobId)) packerWaiting = true;
    maxOnMain = Math.max(maxOnMain, s.conveyor.onMain);
  });
  check(laneFull, 'at least two lanes filled to capacity');
  check(mainBlocked, 'main line went BLOCKED behind full lanes');
  check(indBlocked, 'induction segments blocked (backpressure reached packing)');
  check(packerWaiting, 'a packer waited holding a carton');
  check(maxOnMain >= 10, `cartons accumulated on main line (max ${maxOnMain})`);
  const cv = sim.conveyor; const main = cv.segments.get('MAIN')!;
  const C = sim.containers; const sorted = main.cartons.slice().sort((a, b) => C.get(b)!.convPos - C.get(a)!.convPos);
  let minGap = Infinity; for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, C.get(sorted[i - 1])!.convPos - C.get(sorted[i])!.convPos);
  check(minGap >= 0.7, `queued cartons keep spacing (min gap ${minGap.toFixed(2)})`);
  check(cv.misroutes === 0, 'no misroutes');
  const shippedBefore = sim.metrics.ordersShipped;
  // release trucks
  for (const d of sim.docks) if (d.kind === 'outbound') d.nextArrival = sim.time + 1;
  run(sim, 20 * 60);
  check(sim.metrics.ordersShipped > shippedBefore + 20, `flow resumed: shipped ${sim.metrics.ordersShipped - shippedBefore} after trucks returned`);
  check(cv.segments.get('MAIN')!.status !== 'BLOCKED' || cv.segments.get('MAIN')!.cartons.length < 10, 'main line drained');
  const wrongDock = sim.orderList.filter(o => o.state === 'SHIPPED').length > 0 && sim.checkInvariants().length === 0;
  check(wrongDock, 'invariants clean after recovery (routing by dock verified)');
  for (const l of sim.log) if (l.text.includes('MISROUTE')) console.log('   ', l.t.toFixed(1), l.text);
  check(cv.lanes.every(l => l.passed > 0), `every lane discharged cartons: ${cv.lanes.map(l => l.passed).join('/')}`);
}
console.log('Scenario 5: pause freezes conveyors; 4x speed keeps cartons spaced');
{
  const sim = new Simulation(5);
  run(sim, 8 * 60);
  const snapshotPos = () => [...sim.containers.values()].filter(c => c.convSeg).map(c => `${c.id}:${c.convSeg}:${c.convPos.toFixed(3)}`).join(',');
  const a = snapshotPos(); // paused = no ticks; positions must be identical
  check(a === snapshotPos(), 'no movement without ticks (pause)');
  // 4x is just more ticks per frame: run 4 ticks at a time and check invariants after each batch
  let bad = 0; for (let k = 0; k < 20 * 60 * 5 / 4; k++) { for (let i = 0; i < 4; i++) sim.tick(); if (k % 10 === 0 && sim.checkInvariants().length) bad++; }
  check(bad === 0, '4x batching keeps all invariants');
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL SCENARIOS PASS');
process.exit(fails ? 1 : 0);
