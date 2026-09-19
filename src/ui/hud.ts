import type { Simulation } from '../sim/sim';
import type { Job, Order, OrderState, Worker } from '../sim/types';
import { JOB_COLORS, ROLE_COLOR, ROLE_NAME } from '../render/dynamic';

export type Selection = { kind: 'worker' | 'rack' | 'spot' | 'station' | 'order' | 'truck' | 'conveyor'; id: string } | null;

const STAGE_COLOR: Record<OrderState, string> = { NEW: '#97a0b0', BACKORDER: '#e06060', ALLOCATED: '#8fb4e8', PICKING: '#5cb870', PICKED: '#3f8f55', PACKING: '#e8813a', PACKED: '#c8641f', SORTING: '#b98ae6', STAGED: '#9c6ad6', LOADING: '#3fb8c4', SHIPPED: '#e8ecf3' };
const STAGES: OrderState[] = ['NEW', 'BACKORDER', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'SORTING', 'STAGED', 'LOADING'];
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTime = (t: number) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60); return `${String(6 + h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
const fmtDur = (t: number) => t >= 60 ? `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s` : `${Math.floor(t)}s`;

export class HUD {
  root: HTMLElement; private dash: HTMLElement; private insp: HTMLElement; private logEl: HTMLElement; private topEl: HTMLElement; private toast: HTMLElement;
  speed = 1; paused = false;
  selection: Selection = null;
  onSelect: (s: Selection) => void = () => {};
  onFollow: (id: string) => void = () => {};
  onFocus: (cx: number, cz: number) => void = () => {};
  onToggleLabels: () => void = () => {};
  onHire: (id: string) => void = () => {};
  private tab: 'orders' | 'workers' = 'orders';
  private uiHidden = false;
  private lastInsp = ''; private lastLog = -1; private fps = 0; private lastToast = 0;
  constructor(readonly sim: Simulation, root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div id="top" class="panel">
        <span class="title">MiniWarehouse</span><span class="clock" id="clock">06:00:00</span>
        <button class="btn" data-speed="0">⏸ Pause</button><button class="btn active" data-speed="1">1×</button><button class="btn" data-speed="2">2×</button><button class="btn" data-speed="4">4×</button>
        <span id="rush" class="badge calm">NORMAL DEMAND</span><span id="fps" class="clock" style="min-width:52px"></span>
        <span style="border-left:1px solid var(--line);height:20px"></span>
        <button class="btn small" data-act="hire" title="Add a worker (they walk in through receiving)">＋ Hire</button><button class="btn small" data-act="rush" title="Start a rush period now">⚡ Rush</button><button class="btn small" data-act="truck" title="Request an inbound delivery now">🚚 Call truck</button>
      </div>
      <div id="toast"></div>
      <div id="dash" class="panel"></div>
      <div id="inspector" class="panel"></div>
      <div id="log" class="panel"></div>
      <div id="tip"></div>
      <div id="help" class="panel"><b>Legend</b><br><span class="dot" style="background:#3b7ddd"></span> Receiver <span class="dot" style="background:#3faa5c"></span> Picker <span class="dot" style="background:#e8823a"></span> Packer <span class="dot" style="background:#36b3b8"></span> Shipper<br><span class="dot" style="background:#f2c53a"></span> Pallet awaiting QC <span class="dot" style="background:#3faa5c"></span> Pallet cleared<br>Dark boxes on shelves = reserved for picks<br><b style="display:block;margin-top:6px">Controls</b>Drag: rotate &amp; tilt · Right-drag / Shift-drag: pan · Wheel: zoom<br>WASD: pan · Q/E: rotate · Space: pause · 1/2/4: speed<br>Click things to inspect · Double-click: focus · F: follow · L: labels · H: hide panels · R: reset view</div>`;
    this.dash = root.querySelector('#dash')!; this.insp = root.querySelector('#inspector')!; this.logEl = root.querySelector('#log')!; this.topEl = root.querySelector('#top')!; this.toast = root.querySelector('#toast')!;
    this.topEl.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(b => b.addEventListener('click', () => this.setSpeed(Number(b.dataset.speed))));
    root.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]');
      if (t) { const [kind, id] = t.dataset.sel!.split(':'); this.select({ kind: kind as any, id }); }
      const f = (e.target as HTMLElement).closest<HTMLElement>('[data-follow]'); if (f) this.onFollow(f.dataset.follow!);
      const g = (e.target as HTMLElement).closest<HTMLElement>('[data-focus]'); if (g) { const [cx, cz] = g.dataset.focus!.split(',').map(Number); this.onFocus(cx, cz); }
      const tb = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]'); if (tb) { this.tab = tb.dataset.tab as any; this.listSig = ''; }
      if ((e.target as HTMLElement).closest('.close')) this.select(null);
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'hire') { const w = this.sim.hireWorker(); if (w) this.onHire(w.id); else this.showToast('Crew is at maximum size (20)'); }
      if (act === 'rush') { if (this.sim.rushActive) this.showToast('A rush is already running'); else this.sim.triggerRush(); }
      if (act === 'truck') { if (!this.sim.callInboundTruck()) this.showToast('Both inbound docks are occupied'); }
    });
    window.addEventListener('keydown', e => {
      if (e.key === ' ') { e.preventDefault(); this.setSpeed(this.paused ? this.speed : 0); }
      if (e.key === '1') this.setSpeed(1); if (e.key === '2') this.setSpeed(2); if (e.key === '4') this.setSpeed(4);
      if (e.key === 'Escape') this.select(null);
      if (e.key.toLowerCase() === 'l') this.onToggleLabels();
      if (e.key.toLowerCase() === 'h') { this.uiHidden = !this.uiHidden; for (const id of ['#dash', '#help', '#log', '#inspector']) (this.root.querySelector(id) as HTMLElement).style.visibility = this.uiHidden ? 'hidden' : ''; }
    });
  }
  setSpeed(s: number) {
    if (s === 0) this.paused = !this.paused || false; else { this.speed = s; this.paused = false; }
    if (s === 0 && !this.paused) { /* unpaused via pause button */ }
    this.topEl.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(b => b.classList.toggle('active', this.paused ? b.dataset.speed === '0' : Number(b.dataset.speed) === this.speed));
  }
  get effectiveSpeed() { return this.paused ? 0 : this.speed; }
  select(s: Selection) { this.selection = s; this.lastInsp = ''; this.listSig = ''; this.onSelect(s); }
  /** Hover tooltip near the cursor (empty text hides it). */
  showTip(text: string, x: number, y: number) { const t = this.root.querySelector('#tip') as HTMLElement; if (!text) { t.style.display = 'none'; return; } t.textContent = text; t.style.display = 'block'; t.style.left = `${x + 14}px`; t.style.top = `${y + 14}px`; }
  showToast(text: string) { this.toast.textContent = text; this.toast.style.display = 'block'; this.lastToast = performance.now(); }
  setFps(f: number) { this.fps = f; }

  update() {
    const sim = this.sim; const snap = sim.snapshot();
    (this.root.querySelector('#clock') as HTMLElement).textContent = fmtTime(sim.time);
    const rush = this.root.querySelector('#rush')!;
    if (this.paused) { rush.className = 'badge calm'; rush.textContent = '⏸ PAUSED'; }
    else { rush.className = 'badge ' + (snap.rush ? 'rush' : 'calm'); rush.textContent = snap.rush ? '⚡ RUSH DEMAND' : 'NORMAL DEMAND'; }
    (this.root.querySelector('#fps') as HTMLElement).textContent = `${this.fps.toFixed(0)} fps`;
    if (this.toast.style.display === 'block' && performance.now() - this.lastToast > 2500) this.toast.style.display = 'none';
    // dashboard: skeleton is built once; values update in place so buttons/lists stay clickable
    if (!this.dashBuilt) this.buildDash();
    this.setText('k-shipped', String(sim.metrics.ordersShipped));
    this.setText('k-thr', snap.throughputPerHour.toFixed(0));
    this.setText('k-backlog', String(snap.backlog));
    this.setText('k-busy', `${snap.workers.total - snap.workers.idle}<span style="font-size:12px;color:var(--muted)">/${snap.workers.total}</span>`, true);
    const openJobs = Object.values(snap.jobs).reduce((a, j) => a + j.open, 0), activeJobs = Object.values(snap.jobs).reduce((a, j) => a + j.active, 0);
    this.setText('k-tasks', `${activeJobs}<span style="font-size:12px;color:var(--muted)"> +${openJobs}</span>`, true);
    this.setText('k-cycle', snap.avgCycleTime ? fmtDur(snap.avgCycleTime) : '–');
    const maxStage = Math.max(1, ...STAGES.map(s => snap.orders[s]));
    for (const st of STAGES) { const bar = this.el(`bar-${st}`); if (bar) bar.style.width = `${(snap.orders[st] / maxStage * 100).toFixed(0)}%`; this.setText(`n-${st}`, String(snap.orders[st])); }
    for (const t of Object.keys(snap.jobs) as (keyof typeof snap.jobs)[]) this.setText(`job-${t}`, `${snap.jobs[t].active}<span style="color:var(--muted)">/${snap.jobs[t].open}</span>`, true);
    const inv = snap.inventory; const trucks = [...sim.trucks.values()];
    this.setText('i-onhand', String(inv.onHand)); this.setText('i-res', String(inv.reserved)); this.setText('i-inb', String(inv.onPallets + inv.onTrucks)); this.setText('i-inc', String(inv.incoming));
    this.setText('i-tc', `${inv.inTotes} / ${inv.inCartons}`); this.setText('i-slots', `${inv.locationsUsed} / ${inv.locationsTotal}`); this.setText('i-pal', String(sim.metrics.palletsReceived)); this.setText('i-picked', String(sim.metrics.unitsPicked));
    this.setText('i-lost', String(sim.metrics.ordersDropped));
    this.setText('i-trucks', `${trucks.filter(t => t.state === 'docked' && t.kind === 'inbound').length} in / ${trucks.filter(t => t.state === 'docked' && t.kind === 'outbound').length} out`);
    this.drawSpark();
    const cvs = snap.conveyor;
    this.setText('c-main', `<span style="color:${cvs.mainStatus === 'BLOCKED' ? 'var(--c-warn)' : cvs.mainStatus === 'RUNNING' ? '#9fe0c0' : 'var(--muted)'}">${cvs.mainStatus}</span>${cvs.inductionsBlocked ? ` <span style="color:var(--c-warn)">· ${cvs.inductionsBlocked} induction${cvs.inductionsBlocked > 1 ? 's' : ''} blocked</span>` : ''}`, true);
    this.setText('c-thr', cvs.throughputPerHour.toFixed(0)); this.setText('c-on', `${cvs.onMain} main · ${cvs.inLanes} in lanes`);
    const lanesHtml = cvs.laneFill.map(l => `<div class="stage" data-sel="conveyor:${l.id}" style="cursor:pointer"><span class="name">${l.name.split(' →')[0]} <span style="opacity:.6">${l.dockId.replace('DOCK-OUT-', 'D')}</span></span><span class="bar"><i style="width:${(l.n / l.cap * 100).toFixed(0)}%;background:${l.n >= l.cap ? 'var(--c-warn)' : 'var(--c-stage)'}"></i></span><span class="n">${l.n}/${l.cap}</span></div>`).join('');
    this.setText('lanes', lanesHtml, true);
    this.el('tab-orders')!.classList.toggle('active', this.tab === 'orders'); this.el('tab-workers')!.classList.toggle('active', this.tab === 'workers');
    // lists: rebuilt only when their content signature changes
    let listHtml = '', sig = '';
    if (this.tab === 'orders') {
      const open = sim.orderList.filter(o => o.state !== 'SHIPPED').slice(0, 60);
      sig = 'o' + open.map(o => o.id + o.state).join(',') + (this.selection?.id ?? '');
      if (sig !== this.listSig) listHtml = open.map(o => `<div class="o ${this.selection?.kind === 'order' && this.selection.id === o.id ? 'sel' : ''}" data-sel="order:${o.id}"><span>${o.rush ? '<span style="color:var(--c-warn)" title="Rush order">⚡</span>' : ''}#${o.num}</span><span class="cust">${esc(o.customer)} · ${o.lines.reduce((a, l) => a + l.qty, 0)} units</span><span class="chip" style="background:${STAGE_COLOR[o.state]}">${o.state}</span></div>`).join('') || '<div class="sub">No open orders</div>';
    } else {
      sig = 'w' + sim.workers.map(w => w.id + (w.jobId ? sim.jobs.get(w.jobId)?.type : '-') + w.workLabel).join(',') + (this.selection?.id ?? '');
      if (sig !== this.listSig) listHtml = sim.workers.map(w => { const j = w.jobId ? sim.jobs.get(w.jobId) : null; return `<div class="w ${this.selection?.kind === 'worker' && this.selection.id === w.id ? 'sel' : ''}" data-sel="worker:${w.id}"><span class="dot" style="background:#${ROLE_COLOR[w.role].toString(16).padStart(6, '0')}"></span><span>${w.name}</span><span class="st">${j ? `${j.type} · ${esc(w.workLabel)}` : 'Idle'}</span></div>`; }).join('');
    }
    if (sig !== this.listSig) { this.listSig = sig; const l = this.el('list')!; l.className = this.tab === 'orders' ? 'olist' : 'wlist'; l.innerHTML = listHtml; }
    // inspector
    const ih = this.selection ? this.renderInspector(this.selection) : '';
    if (ih !== this.lastInsp) { this.insp.innerHTML = ih; this.lastInsp = ih; this.insp.classList.toggle('show', !!ih); }
    // log
    if (sim.log.length !== this.lastLog || (sim.log.length && sim.log[sim.log.length - 1].t !== this.lastLogT)) {
      this.lastLog = sim.log.length; this.lastLogT = sim.log.length ? sim.log[sim.log.length - 1].t : 0;
      this.logEl.innerHTML = sim.log.slice(-5).map(e => `<div class="ev ${e.kind}"><span class="t">${fmtTime(e.t).slice(0, 5)}</span><span>${esc(e.text)}</span></div>`).join('');
    }
  }
  private lastLogT = 0;
  private dashBuilt = false; private listSig = ''; private els = new Map<string, HTMLElement>();
  private el(id: string) { let e = this.els.get(id); if (!e) { e = this.dash.querySelector<HTMLElement>(`[data-id="${id}"]`) ?? undefined as any; if (e) this.els.set(id, e); } return e ?? null; }
  private setText(id: string, v: string, html = false) { const e = this.el(id); if (!e) return; if (html) { if (e.innerHTML !== v) e.innerHTML = v; } else if (e.textContent !== v) e.textContent = v; }
  private lastSparkN = -1;
  private drawSpark() {
    const h = this.sim.history; if (h.length === this.lastSparkN) return; this.lastSparkN = h.length;
    const c = this.el('spark') as HTMLCanvasElement | null; if (!c) return; const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
    if (h.length < 2) { ctx.fillStyle = '#97a0b0'; ctx.font = '11px Inter, system-ui'; ctx.fillText('collecting…', 6, 30); return; }
    const max = Math.max(60, ...h.map(p => p.thr)); const n = 90; const x = (i: number) => W - (h.length - 1 - i) * (W / (n - 1)); const y = (v: number) => H - 4 - (v / max) * (H - 10);
    // rush periods as soft bands so spikes are explainable
    ctx.fillStyle = 'rgba(224,96,96,0.18)'; h.forEach((p, i) => { if (p.rush) ctx.fillRect(x(i) - W / (n - 1) / 2, 0, W / (n - 1) + 0.5, H); });
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; for (const f of [0.5, 1]) { ctx.beginPath(); ctx.moveTo(0, y(max * f)); ctx.lineTo(W, y(max * f)); ctx.stroke(); }
    ctx.strokeStyle = '#ffd23a'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath(); h.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.thr)) : ctx.moveTo(x(i), y(p.thr)); }); ctx.stroke();
    const last = h[h.length - 1]; ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(x(h.length - 1), y(last.thr), 3, 0, Math.PI * 2); ctx.fill();
    this.setText('spark-max', `peak ${max.toFixed(0)} · now ${last.thr.toFixed(0)}`);
  }
  private buildDash() {
    this.dashBuilt = true; this.els.clear();
    const kpi = (id: string, l: string) => `<div class="kpi"><div class="v" data-id="${id}">–</div><div class="l">${l}</div></div>`;
    const row = (id: string, k: string) => `<span class="k">${k}</span><span class="v" data-id="${id}">–</span>`;
    this.dash.innerHTML = `<div><h3>Shift overview</h3><div class="kpis">${kpi('k-shipped', 'Orders shipped')}${kpi('k-thr', 'Orders / hour')}${kpi('k-backlog', 'Open orders')}${kpi('k-busy', 'Workers busy')}${kpi('k-tasks', 'Tasks active / queued')}${kpi('k-cycle', 'Avg order cycle')}</div></div>
      <div><h3>Throughput · last 30 min</h3><canvas data-id="spark" width="268" height="54" style="width:100%;height:54px;display:block"></canvas><div class="sub" style="display:flex;justify-content:space-between;margin:2px 0 0"><span>orders / hour</span><span data-id="spark-max"></span></div></div>
      <div><h3>Order pipeline</h3><div class="stages">${STAGES.map(s => `<div class="stage"><span class="name">${s}</span><span class="bar"><i data-id="bar-${s}" style="width:0;background:${STAGE_COLOR[s]}"></i></span><span class="n" data-id="n-${s}">0</span></div>`).join('')}</div></div>
      <div><h3>Tasks <span style="font-weight:400;text-transform:none;letter-spacing:0">(active / queued)</span></h3><div class="jobs">${(['UNLOAD', 'INSPECT', 'PUTAWAY', 'PICK', 'PACK', 'LOAD', 'TOTE_RETURN'] as const).map(t => `<div class="job" style="--c:${JOB_COLORS[t]}"><span>${t.replace('_', ' ')}</span><span class="n" data-id="job-${t}">0</span></div>`).join('')}</div></div>
      <div><h3>Sorter conveyor</h3><div class="rows">${row('c-main', 'Main line')}${row('c-thr', 'Cartons sorted / hour')}${row('c-on', 'Cartons on conveyor')}</div><div class="stages" style="margin-top:4px" data-id="lanes"></div></div>
      <div><h3>Inventory</h3><div class="rows">${row('i-onhand', 'Units on shelf')}${row('i-res', 'Reserved for picks')}${row('i-inb', 'Inbound pallets (units)')}${row('i-inc', 'Putaway in progress')}${row('i-tc', 'In totes / cartons')}${row('i-slots', 'Slots used')}${row('i-pal', 'Pallets received')}${row('i-picked', 'Units picked')}${row('i-trucks', 'Trucks at dock')}${row('i-lost', 'Orders turned away')}</div></div>
      <div><div class="tabs"><button class="btn small" data-id="tab-orders" data-tab="orders">Orders</button><button class="btn small" data-id="tab-workers" data-tab="workers">Workers</button></div><div data-id="list" class="olist"></div></div>`;
  }

  private renderInspector(sel: NonNullable<Selection>): string {
    const sim = this.sim;
    const close = `<button class="close" title="Close (Esc)">✕</button>`;
    if (sel.kind === 'worker') {
      const w = sim.workers.find(x => x.id === sel.id); if (!w) return '';
      const j = w.jobId ? sim.jobs.get(w.jobId) : null;
      let h = `${close}<h2><span style="color:#${ROLE_COLOR[w.role].toString(16).padStart(6, '0')}">●</span> ${w.name} <span class="sub" style="display:inline">· ${ROLE_NAME[w.role]}</span></h2>`;
      h += `<div class="sub">${w.state === 'idle' ? 'Idle' : w.state === 'walking' ? 'Walking' : 'Working'} · cell ${w.cell.cx},${w.cell.cz} · ${w.jobsDone} tasks done · ${(w.busyTime / Math.max(1, sim.time) * 100).toFixed(0)}% busy</div>`;
      h += `<button class="btn small" data-follow="${w.id}">Follow camera (F)</button> `;
      const carried = w.carrying ? sim.containers.get(w.carrying) : null;
      if (carried) h += `<hr><b>Carrying:</b> ${this.describeContainer(carried)}${w.carryExtra.length ? ` +${w.carryExtra.length} more totes` : ''}`;
      if (j) h += `<hr>${this.renderJob(j, w)}`; else h += `<hr><div class="sub">No task assigned — waiting for work.</div>`;
      return h;
    }
    if (sel.kind === 'rack') {
      const l = sim.racks.get(sel.id); if (!l) return '';
      const siblings = [...sim.racks.values()].filter(r => r.cell.cx === l.cell.cx && r.cell.cz === l.cell.cz).sort((a, b) => b.level - a.level);
      let h = `${close}<h2>Rack bay ${l.aisle}-${String(l.cell.cz).padStart(2, '0')}</h2><div class="sub">Aisle ${l.aisle} · ${siblings.length} levels · <span data-focus="${l.accessCell.cx},${l.accessCell.cz}" class="btn small">Focus</span></div>`;
      for (const s of siblings) {
        const sku = s.skuId ? sim.skus.get(s.skuId) : null;
        h += `<div class="level ${s.id === l.id ? 'sel' : ''}" data-sel="rack:${s.id}"><span>L${s.level + 1}</span><span>${sku ? `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#${sku.color.toString(16).padStart(6, '0')};margin-right:6px"></span>${esc(sku.name)}` : '<span class="sub">empty</span>'}</span><span>${s.qty}/${s.capacity}${s.reserved ? ` <span style="color:var(--c-pick)">(${s.reserved} rsv)</span>` : ''}${s.incoming ? ` <span style="color:var(--c-recv)">(+${s.incoming})</span>` : ''}</span></div>`;
      }
      const sku = l.skuId ? sim.skus.get(l.skuId) : null;
      h += `<hr><div class="rows"><span class="k">Location</span><span class="v">${l.id}</span><span class="k">SKU</span><span class="v">${sku ? esc(sku.name) + ' (' + sku.id + ')' : '—'}</span><span class="k">On hand</span><span class="v">${l.qty}</span><span class="k">Reserved</span><span class="v">${l.reserved}</span><span class="k">Available</span><span class="v">${l.qty - l.reserved}</span><span class="k">Incoming</span><span class="v">${l.incoming}</span><span class="k">Capacity</span><span class="v">${l.capacity}</span></div>`;
      if (sku) h += `<div class="sub" style="margin-top:6px">Network stock for ${esc(sku.name)}: ${sim.skuAvailable(sku.id)} available, ${sim.skuOnHand(sku.id)} total incl. inbound</div>`;
      const jobs = [...sim.jobs.values()].filter(j => j.refs.locationIds?.includes(l.id));
      if (jobs.length) h += `<hr><h3>Tasks touching this slot</h3>${jobs.map(j => `<div class="w" data-sel="${j.workerId ? 'worker:' + j.workerId : 'rack:' + l.id}"><span class="dot" style="background:${JOB_COLORS[j.type]}"></span><span>${j.type}</span><span class="st">${esc(j.summary)}${j.workerId ? ' · ' + sim.worker(j.workerId).name : ' · queued'}</span></div>`).join('')}`;
      return h;
    }
    if (sel.kind === 'spot') {
      const s = sim.spots.get(sel.id); if (!s) return '';
      const names: Record<string, string> = { receiving: 'Receiving pallet spot', inspect_bench: 'Inspection bench', inspect_out: 'Inspected pallet buffer', tote_shelf: 'Empty tote shelf', pack_in: 'Pack station inbound queue', pack_bench: 'Packing bench', pack_out: 'Empty tote return stack', staging: 'Staging lane' };
      let h = `${close}<h2>${names[s.kind]}</h2><div class="sub">${s.id} · ${s.containerIds.length}/${s.capacity} occupied${s.pending ? ` · ${s.pending} reserved by tasks` : ''} <span data-focus="${s.accessCell.cx},${s.accessCell.cz}" class="btn small">Focus</span></div>`;
      if (s.stationId) h += `<div class="sub"><span class="btn small" data-sel="station:${s.stationId}">Open station ${s.stationId}</span></div>`;
      h += s.containerIds.map(id => `<div style="margin:4px 0">${this.describeContainer(sim.containers.get(id)!)}</div>`).join('') || '<div class="sub">Empty</div>';
      return h;
    }
    if (sel.kind === 'station') {
      const st = sim.stations.get(sel.id); if (!st) return '';
      const w = st.busyWorkerId ? sim.worker(st.busyWorkerId) : null;
      let h = `${close}<h2>${st.kind === 'pack' ? 'Packing station' : 'Inspection station'} ${st.id.split('-')[1]}</h2><div class="sub">${st.processed} processed · ${w ? `operated by <span data-sel="worker:${w.id}" class="btn small">${w.name}</span>` : 'no operator'} <span data-focus="${st.accessCell.cx},${st.accessCell.cz}" class="btn small">Focus</span></div>`;
      for (const [k, id] of Object.entries(st.spotIds)) { const s = sim.spots.get(id!)!; h += `<hr><h3>${k === 'in' ? 'Inbound queue' : k === 'bench' ? 'On bench' : st.kind === 'pack' ? 'Empty totes' : 'Inspected buffer'} (${s.containerIds.length}/${s.capacity})</h3>${s.containerIds.map(cid => `<div style="margin:3px 0">${this.describeContainer(sim.containers.get(cid)!)}</div>`).join('') || '<div class="sub">empty</div>'}`; }
      return h;
    }
    if (sel.kind === 'order') {
      const o = sim.orders.get(sel.id); if (!o) return '';
      const j = o.jobId ? sim.jobs.get(o.jobId) : [...sim.jobs.values()].find(x => x.refs.orderId === o.id);
      let h = `${close}<h2>Order #${o.num} <span class="chip" style="background:${STAGE_COLOR[o.state]}">${o.state}</span>${o.rush ? '<span class="chip rushflag">RUSH</span>' : ''}</h2><div class="sub">${esc(o.customer)} · placed ${fmtTime(o.createdAt)} · age ${fmtDur((o.shippedAt ?? sim.time) - o.createdAt)}</div>`;
      h += `<div class="lines">${o.lines.map(l => { const sku = sim.skus.get(l.skuId)!; return `<div class="line"><span class="sw" style="background:#${sku.color.toString(16).padStart(6, '0')}"></span><span>${esc(sku.name)}<div class="sub" style="margin:0">${l.fromLocations.map(f => `<span data-sel="rack:${f.locId}" style="cursor:pointer;text-decoration:underline">${f.locId}</span>×${f.qty}`).join(', ') || (o.state === 'BACKORDER' ? `short: ${sim.skuAvailable(l.skuId)} available` : '')}</div></span><span>${l.picked}/${l.qty}</span></div>`; }).join('')}</div>`;
      if (o.toteId && sim.containers.has(o.toteId)) h += `<div class="sub">Tote ${o.toteId}: ${this.whereIs(o.toteId)}</div>`;
      if (o.cartonId && sim.containers.has(o.cartonId)) h += `<div class="sub">Carton ${o.cartonId}: ${this.whereIs(o.cartonId)}</div>`;
      if (j) h += `<hr>${this.renderJob(j, j.workerId ? sim.worker(j.workerId) : null)}`;
      else if (o.state === 'BACKORDER') h += `<hr><div class="sub" style="color:var(--c-warn)">Waiting for inbound stock. Purchasing prioritises short SKUs on the next truck.</div>`;
      else if (o.state === 'SORTING') { const c = sim.containers.get(o.cartonId!); h += `<hr><div class="sub">Carton on the sorter conveyor (<span data-sel="conveyor:${c?.convSeg}" style="cursor:pointer;text-decoration:underline">${c?.convSeg}</span>)${c?.convDest ? `, routed to ${c.convDest}` : ', not yet scanned'}. Ships from ${o.dockId}.</div>`; }
      else if (o.state === 'STAGED') { const c = sim.containers.get(o.cartonId!); h += `<hr><div class="sub">Carton waiting in <span data-sel="conveyor:${c?.convSeg}" style="cursor:pointer;text-decoration:underline">${c?.convSeg}</span>; loads when a truck is at ${o.dockId}.</div>`; }
      else if (o.state === 'LOADING') h += `<hr><div class="sub">On the truck; ships when the truck departs.</div>`;
      return h;
    }
    if (sel.kind === 'conveyor') {
      const cv = sim.conveyor; const seg = cv.segments.get(sel.id); if (!seg) return '';
      const util = sim.time > 0 ? ((seg.runTime) / sim.time * 100) : 0; const blockedPct = sim.time > 0 ? seg.blockedTime / sim.time * 100 : 0;
      const col = seg.status === 'BLOCKED' ? 'var(--c-warn)' : seg.status === 'RUNNING' ? '#9fe0c0' : 'var(--muted)';
      let h = `${close}<h2>${esc(seg.name)} <span class="chip" style="background:${seg.status === 'BLOCKED' ? '#e06060' : seg.status === 'RUNNING' ? '#5cb870' : '#97a0b0'}">${seg.status}</span></h2>`;
      h += `<div class="sub">${seg.kind === 'lane' ? 'Accumulation lane' : seg.kind === 'main' ? 'Powered roller sorter line' : 'Pack station takeaway'} · ${seg.length.toFixed(1)} m · ${seg.speed} m/s · <span data-focus="${seg.accessCell ? seg.accessCell.cx + ',' + seg.accessCell.cz : Math.floor(seg.points[0].x) + ',' + Math.round(seg.points[0].z)}" class="btn small">Focus</span></div>`;
      h += `<div class="rows"><span class="k">Cartons on segment</span><span class="v">${seg.cartons.length}${seg.kind === 'lane' ? ' / ' + cv.laneCapacity(seg) : ''}</span><span class="k">Throughput</span><span class="v">${cv.throughput(seg).toFixed(0)} / h</span><span class="k">Total passed</span><span class="v">${seg.passed}</span><span class="k">Running</span><span class="v">${util.toFixed(0)}%</span><span class="k">Blocked</span><span class="v" style="color:${blockedPct > 10 ? 'var(--c-warn)' : 'inherit'}">${blockedPct.toFixed(0)}%</span>${seg.blockedBy ? `<span class="k">Held up by</span><span class="v" style="color:${col}">${esc(seg.blockedBy)}</span>` : ''}${seg.dockId ? `<span class="k">Destination</span><span class="v">${seg.dockId}</span>` : ''}${seg.next ? `<span class="k">Feeds</span><span class="v"><span data-sel="conveyor:${seg.next.segId}" style="cursor:pointer;text-decoration:underline">${seg.next.segId}</span> at ${seg.next.pos.toFixed(1)} m</span>` : ''}</div>`;
      if (seg.kind === 'main') {
        const sc = cv.scanners[0]; h += `<hr><h3>Scanner ${sc.id}</h3><div class="sub">${sc.count} cartons scanned${sc.lastOrder ? ` · last: <span data-sel="order:${sc.lastOrder}" style="cursor:pointer;text-decoration:underline">#${sim.orders.get(sc.lastOrder)?.num ?? '?'}</span>` : ''}</div>`;
        h += `<h3 style="margin-top:6px">Diverters</h3>${cv.diverters.map(d => { const lane = cv.segments.get(d.laneId)!; return `<div class="stage" data-sel="conveyor:${lane.id}" style="cursor:pointer"><span class="name">${d.id}</span><span class="sub" style="margin:0">→ ${esc(lane.name)} · ${d.count} diverted${d.blockedSince !== null ? ` · <span style="color:var(--c-warn)">holding (lane full)</span>` : ''}</span><span class="n">${lane.cartons.length}/${cv.laneCapacity(lane)}</span></div>`; }).join('')}`;
      }
      if (seg.cartons.length) h += `<hr><h3>Cartons (downstream first)</h3>${seg.cartons.map(id => { const c = sim.containers.get(id)!; const o = c.orderId ? sim.orders.get(c.orderId) : null; return `<div class="w" data-sel="order:${o?.id}"><span class="dot" style="background:${c.convDest ? '#9c6ad6' : '#97a0b0'}"></span><span>${c.id}</span><span class="st">${o ? `Order #${o.num} · ${o.dockId.replace('DOCK-', '')}` : 'no order'} · ${c.convPos.toFixed(1)} m${c.convDest ? ' → ' + c.convDest : seg.kind === 'main' ? ' · unscanned' : ''}</span></div>`; }).join('')}`;
      const jobs = [...sim.jobs.values()].filter(j => j.refs.conveyorId === seg.id);
      if (jobs.length) h += `<hr><h3>Workers at this segment</h3>${jobs.map(j => `<div class="w" data-sel="${j.workerId ? 'worker:' + j.workerId : 'conveyor:' + seg.id}"><span class="dot" style="background:${JOB_COLORS[j.type]}"></span><span>${j.type}</span><span class="st">${esc(j.summary)}${j.workerId ? ' · ' + sim.worker(j.workerId).name : ' · queued'}</span></div>`).join('')}`;
      return h;
    }
    if (sel.kind === 'truck') {
      const t = sim.trucks.get(sel.id); if (!t) return '';
      let h = `${close}<h2>${t.kind === 'inbound' ? 'Inbound' : 'Outbound'} truck ${t.id}</h2><div class="sub">${t.state} at ${t.dockId}${t.kind === 'outbound' ? ` · ${t.containerIds.length}/${t.capacity} cartons · departs in ${fmtDur(Math.max(0, t.dwell - (sim.time - t.dockedAt)))} or when full` : ` · ${t.containerIds.length} pallets left to unload`}</div>`;
      h += t.containerIds.slice(0, 14).map(id => `<div style="margin:3px 0">${this.describeContainer(sim.containers.get(id)!)}</div>`).join('');
      return h;
    }
    return '';
  }
  private whereIs(cid: string) {
    const c = this.sim.containers.get(cid)!;
    if (c.carriedBy) return `carried by <span data-sel="worker:${c.carriedBy}" style="cursor:pointer;text-decoration:underline">${this.sim.worker(c.carriedBy).name}</span>`;
    if (c.spotId) return `at <span data-sel="spot:${c.spotId}" style="cursor:pointer;text-decoration:underline">${c.spotId}</span>`;
    if (c.truckId) return `on truck ${c.truckId}`;
    if (c.convSeg) return `on conveyor <span data-sel="conveyor:${c.convSeg}" style="cursor:pointer;text-decoration:underline">${c.convSeg}</span> at ${c.convPos.toFixed(1)} m`;
    return 'in transit';
  }
  private describeContainer(c: { id: string; kind: string; lines: { skuId: string; qty: number }[]; orderId: string | null; inspected: boolean; carriedBy: string | null }) {
    const sim = this.sim;
    const lines = c.lines.map(l => { const s = sim.skus.get(l.skuId)!; return `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#${s.color.toString(16).padStart(6, '0')};margin:0 4px 0 2px"></span>${l.qty}× ${esc(s.name)}`; }).join(', ');
    const o = c.orderId ? sim.orders.get(c.orderId) : null;
    const tag = c.kind === 'pallet' ? (c.inspected ? '<span class="chip" style="background:#5cb870">INSPECTED</span>' : '<span class="chip" style="background:#e0b23a">AWAITING QC</span>') : o ? `<span class="chip" data-sel="order:${o.id}" style="background:${STAGE_COLOR[o.state]};cursor:pointer">Order #${o.num}</span>` : '<span class="chip" style="background:#97a0b0">EMPTY</span>';
    return `<b>${c.kind[0].toUpperCase() + c.kind.slice(1)} ${c.id}</b> ${tag}<div class="sub" style="margin:2px 0 0">${lines || 'no contents'}</div>`;
  }
  private renderJob(j: Job, w: Worker | null) {
    const sim = this.sim;
    let h = `<h3 style="color:${JOB_COLORS[j.type]}">${j.type.replace('_', ' ')} task</h3><div>${esc(j.summary)}</div><div class="sub">${j.state === 'open' ? 'Queued, waiting for a worker' : `${w ? `Assigned to <span data-sel="worker:${w.id}" style="cursor:pointer;text-decoration:underline">${w.name}</span>` : ''} · started ${fmtDur(sim.time - (j.startedAt ?? sim.time))} ago`}</div>`;
    if (j.refs.orderId && !(this.selection?.kind === 'order')) { const o = sim.orders.get(j.refs.orderId); if (o) h += `<div class="sub"><span class="btn small" data-sel="order:${o.id}">Open order #${o.num}</span></div>`; }
    if (j.steps.length) {
      h += `<div class="steps">${j.steps.map((s, i) => `<div class="step ${i < j.stepIdx ? 'done' : i === j.stepIdx ? 'cur' : ''}">${esc(s.label)}${i === j.stepIdx && w && w.state === 'working' ? `<div class="progress"><i style="width:${((1 - w.workTimer / Math.max(0.01, w.workTotal)) * 100).toFixed(0)}%"></i></div>` : ''}</div>`).join('')}</div>`;
    }
    return h;
  }
}
