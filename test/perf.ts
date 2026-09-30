import { Simulation } from '../src/sim/sim';

// Quick throughput benchmark: wall time per sim-tick after warmup.
const seed = Number(process.argv[2] ?? 7);
const sim = new Simulation(seed);
const warm = Math.round(300 / sim.dt); // 5 sim-minutes to reach steady state
for (let i = 0; i < warm; i++) sim.tick();
const N = Math.round(900 / sim.dt);    // measure 15 sim-minutes
for (let r = 0; r < 3; r++) {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) sim.tick();
  const ms = performance.now() - t0;
  console.log(`round ${r} seed=${seed} ticks=${N} wall=${ms.toFixed(0)}ms  ${(ms / N * 1000).toFixed(1)}us/tick  (${(N / (ms / 1000)).toFixed(0)} ticks/s)`);
}
