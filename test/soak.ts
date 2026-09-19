import { Simulation } from '../src/sim/sim';

const hours = Number(process.argv[2] ?? 1);
const seed = Number(process.argv[3] ?? 7);
const sim = new Simulation(seed);
const steps = Math.floor(hours * 3600 / sim.dt);
let violations = 0; const seen = new Set<string>();
const jobAges = new Map<string, number>();
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  sim.tick();
  if (i % 20 === 0) {
    const errs = sim.checkInvariants();
    for (const e of errs) { violations++; if (!seen.has(e.replace(/[0-9.]+/g, '#'))) { seen.add(e.replace(/[0-9.]+/g, '#')); console.log(`[t=${sim.time.toFixed(1)}] INVARIANT: ${e}`); } }
    // job starvation check: open jobs older than 10 min, active jobs older than 4 min
    for (const j of sim.jobs.values()) {
      const age = sim.time - (j.state === 'active' ? j.startedAt! : j.createdAt);
      if ((j.state === 'active' && age > 240) || (j.state === 'open' && age > 900)) { const k = `${j.type}:${j.state}`; if (!jobAges.has(k)) { jobAges.set(k, age); console.log(`[t=${sim.time.toFixed(0)}] STALE ${j.state} job ${j.type} ${j.summary} age ${age.toFixed(0)}s`); } }
    }
  }
  if (i % (20 * 600) === 0 && i > 0) {
    const s = sim.snapshot();
    console.log(`t=${(sim.time / 60).toFixed(0)}m shipped=${sim.metrics.ordersShipped} backlog=${s.backlog} thr/h=${s.throughputPerHour.toFixed(0)} onHand=${s.inventory.onHand} idle=${s.workers.idle}/${s.workers.total} util=${(sim.metrics.utilization * 100).toFixed(0)}% failed=${sim.metrics.jobsFailed} replans=${sim.metrics.replans} orders=${JSON.stringify(s.orders)} jobs=${Object.entries(s.jobs).map(([k, v]) => `${k}:${v.open}/${v.active}`).join(' ')}`);
  }
}
const s = sim.snapshot();
console.log('--- final ---');
console.log(JSON.stringify({ time: sim.time, shipped: sim.metrics.ordersShipped, created: sim.metrics.ordersCreated, dropped: sim.metrics.ordersDropped, backlog: s.backlog, palletsReceived: sim.metrics.palletsReceived, unitsPicked: sim.metrics.unitsPicked, failed: sim.metrics.jobsFailed, replans: sim.metrics.replans, avgCycle: s.avgCycleTime.toFixed(0), inventory: s.inventory, violations, wall_ms: Date.now() - t0 }, null, 1));
console.log('backorder events:', sim.log.filter(l => l.text.includes('backorder')).length, 'trucks in/out:', sim.metrics.trucksIn, sim.metrics.trucksOut, 'rush periods:', sim.log.filter(l => l.text.includes('Rush period started')).length);
const warns = sim.log.filter(l => l.kind === 'warn' && !l.text.includes('backorder') && !l.text.includes('Rush'));
console.log('warnings:', warns.length); for (const w of warns.slice(0, 15)) console.log('  ', w.t.toFixed(0), w.text);
if (violations > 0 || sim.metrics.ordersShipped === 0) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
