import type { Cell, Container } from './types';

/** Continuous point in cell space (cell centre = cx + 0.5). */
export interface P2 { x: number; z: number }
export type SegKind = 'induction' | 'main' | 'lane';
export type SegStatus = 'RUNNING' | 'BLOCKED' | 'STARVED';

export const CARTON_GAP = 0.78;   // centre-to-centre minimum spacing on a belt
export const MERGE_GAP = 0.9;     // clearance needed on the main line to merge

export interface Segment {
  id: string;
  kind: SegKind;
  name: string;
  points: P2[];        // polyline in cell space
  cum: number[];       // cumulative length at each point
  length: number;
  speed: number;       // cells per second
  /** Downstream connection: the carton enters `segId` at distance `pos` (merge) when it leaves this segment's end. */
  next: { segId: string; pos: number } | null;
  cartons: string[];   // sorted by position, index 0 = furthest downstream
  /** Lanes: the dock this lane serves. Inductions: the pack station that feeds it. */
  dockId?: string; stationId?: string; laneNo?: number;
  accessCell?: Cell;   // where a worker stands to induct / discharge
  cells: Cell[];       // grid cells occupied (blocked)
  // stats
  status: SegStatus; blockedTime: number; runTime: number; passed: number; passedTimes: number[];
  blockedBy: string | null; // what is holding this segment up (downstream seg id / 'lane full' / 'awaiting pickup')
}
export interface Diverter { id: string; segId: string; pos: number; laneId: string; activeUntil: number; count: number; blockedSince: number | null }
export interface Scanner { id: string; segId: string; pos: number; lastScanAt: number; count: number; lastOrder: string | null }

export interface ConveyorHost {
  time: number;
  containers: Map<string, Container>;
  /** Called when a carton passes the scanner; must return the lane id it should be routed to. */
  route: (carton: Container, lanes: Segment[]) => string;
  onEvent: (kind: 'info' | 'warn', text: string) => void;
  bump: () => void;
}

/** Powered conveyor network. Pure simulation: no rendering concerns. */
export class ConveyorNetwork {
  readonly segments = new Map<string, Segment>();
  readonly diverters: Diverter[] = [];
  readonly scanners: Scanner[] = [];
  misroutes = 0;
  constructor(private host: ConveyorHost) {}

  addSegment(s: Omit<Segment, 'cum' | 'length' | 'cartons' | 'status' | 'blockedTime' | 'runTime' | 'passed' | 'passedTimes' | 'blockedBy'>): Segment {
    const cum = [0]; for (let i = 1; i < s.points.length; i++) cum.push(cum[i - 1] + Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].z - s.points[i - 1].z));
    const seg: Segment = { ...s, cum, length: cum[cum.length - 1], cartons: [], status: 'STARVED', blockedTime: 0, runTime: 0, passed: 0, passedTimes: [], blockedBy: null };
    this.segments.set(seg.id, seg); return seg;
  }
  addDiverter(d: Omit<Diverter, 'activeUntil' | 'count' | 'blockedSince'>) { this.diverters.push({ ...d, activeUntil: -1, count: 0, blockedSince: null }); }
  addScanner(s: Omit<Scanner, 'lastScanAt' | 'count' | 'lastOrder'>) { this.scanners.push({ ...s, lastScanAt: -1, count: 0, lastOrder: null }); }

  get lanes() { return [...this.segments.values()].filter(s => s.kind === 'lane'); }
  get inductions() { return [...this.segments.values()].filter(s => s.kind === 'induction'); }

  /** World-space point and heading at a distance along a segment. */
  pointAt(seg: Segment, pos: number, out: { x: number; z: number; ang: number } = { x: 0, z: 0, ang: 0 }) {
    const p = Math.max(0, Math.min(seg.length, pos));
    let i = 1; while (i < seg.cum.length - 1 && seg.cum[i] < p) i++;
    const a = seg.points[i - 1], b = seg.points[i]; const l = seg.cum[i] - seg.cum[i - 1] || 1; const t = (p - seg.cum[i - 1]) / l;
    out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t; out.ang = Math.atan2(b.x - a.x, b.z - a.z); return out;
  }

  /** Free space at the head of a segment for a new carton. */
  entryFree(seg: Segment, gap = CARTON_GAP) { const last = seg.cartons[seg.cartons.length - 1]; if (!last) return true; return this.host.containers.get(last)!.convPos >= gap; }
  /** Space around a position on a segment (for merges). */
  gapFreeAt(seg: Segment, pos: number, gap = MERGE_GAP) { for (const id of seg.cartons) { const p = this.host.containers.get(id)!.convPos; if (Math.abs(p - pos) < gap) return false; } return true; }
  /** How many more cartons a lane can accept (approx). */
  laneRoom(lane: Segment) { const n = lane.cartons.length; return Math.max(0, Math.floor(lane.length / CARTON_GAP) - n); }
  laneCapacity(lane: Segment) { return Math.floor(lane.length / CARTON_GAP); }
  isLaneFull(lane: Segment) { return !this.entryFree(lane); }

  /** Put a carton on a segment at its head. Caller must have checked entryFree. */
  induct(c: Container, seg: Segment) {
    c.convSeg = seg.id; c.convPos = 0; c.convDest = null; c.spotId = null; c.carriedBy = null; c.truckId = null;
    seg.cartons.push(c.id); this.host.bump();
  }
  /** Carton at the discharge end of a lane, ready to be picked up (front carton only). */
  dischargeReady(lane: Segment): Container | null {
    const id = lane.cartons[0]; if (!id) return null; const c = this.host.containers.get(id)!;
    return c.convPos >= lane.length - 0.02 ? c : null;
  }
  /** Remove a carton from the network (picked up by a worker). */
  remove(c: Container) {
    const seg = c.convSeg ? this.segments.get(c.convSeg) : null;
    if (seg) { const i = seg.cartons.indexOf(c.id); if (i >= 0) seg.cartons.splice(i, 1); seg.passed++; seg.passedTimes.push(this.host.time); if (seg.passedTimes.length > 200) seg.passedTimes.splice(0, 50); }
    c.convSeg = null; c.convPos = 0; this.host.bump();
  }

  tick(dt: number) {
    const t = this.host.time;
    // downstream first so freed space is usable in the same tick: lanes, main, inductions
    const order = [...this.segments.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
    for (const seg of order) this.tickSegment(seg, dt, t);
  }

  private tickSegment(seg: Segment, dt: number, t: number) {
    const C = this.host.containers;
    let anyMoved = false, anyBlocked = false; seg.blockedBy = null;
    // keep sorted downstream-first
    seg.cartons.sort((a, b) => C.get(b)!.convPos - C.get(a)!.convPos);
    for (let i = 0; i < seg.cartons.length; i++) {
      const c = C.get(seg.cartons[i])!;
      const ahead = i > 0 ? C.get(seg.cartons[i - 1])! : null;
      let target = c.convPos + seg.speed * dt;
      let limit = seg.length; let limitReason: string | null = null;
      if (ahead && ahead.convSeg === seg.id) { const l = ahead.convPos - CARTON_GAP; if (l < limit) { limit = l; limitReason = 'queue'; } }
      // scanner
      for (const sc of this.scanners) if (sc.segId === seg.id && c.convPos < sc.pos && target >= sc.pos) {
        c.convDest = this.host.route(c, this.lanes); c.scannedAt = t; sc.lastScanAt = t; sc.count++; sc.lastOrder = c.orderId;
      }
      // diverter for this carton's destination
      if (seg.kind === 'main' && c.convDest) {
        const dv = this.diverters.find(d => d.segId === seg.id && d.laneId === c.convDest);
        if (dv) {
          if (c.convPos > dv.pos + 0.01) { this.misroutes++; this.host.onEvent('warn', `MISROUTE: carton ${c.id} passed diverter ${dv.id} (pos ${c.convPos.toFixed(3)} > ${dv.pos.toFixed(3)}, target ${target.toFixed(3)}, dest ${c.convDest}, scanned ${c.scannedAt?.toFixed(1)})`); c.convDest = null; }
          else if (target >= dv.pos) {
            const lane = this.segments.get(dv.laneId)!;
            if (this.entryFree(lane)) {
              // transfer onto the lane; overshoot carries over so motion is continuous
              const over = target - dv.pos;
              seg.cartons.splice(i, 1); i--;
              this.placeOn(lane, c, Math.min(over, CARTON_GAP * 0.5));
              dv.activeUntil = t + 1.1; dv.count++; dv.blockedSince = null; seg.passed++; seg.passedTimes.push(t); if (seg.passedTimes.length > 200) seg.passedTimes.splice(0, 50);
              anyMoved = true; this.host.bump(); continue;
            }
            if (dv.pos < limit) { limit = dv.pos; limitReason = `lane ${lane.laneNo} full`; if (dv.blockedSince === null) dv.blockedSince = t; }
          }
        }
      }
      // segment end behaviour
      if (target >= seg.length - 1e-6 && limit >= seg.length - 1e-6) {
        if (seg.kind === 'induction' && seg.next) {
          const nx = this.segments.get(seg.next.segId)!;
          if (this.gapFreeAt(nx, seg.next.pos)) {
            seg.cartons.splice(i, 1); i--;
            this.placeOn(nx, c, seg.next.pos + Math.min(target - seg.length, 0.2));
            seg.passed++; seg.passedTimes.push(t); if (seg.passedTimes.length > 200) seg.passedTimes.splice(0, 50);
            anyMoved = true; this.host.bump(); continue;
          }
          limitReason = 'merge wait';
        } else if (seg.kind === 'lane') limitReason = 'awaiting pickup';
        else if (seg.kind === 'main') {
          // a carton whose diverter sits at the very end of the line is simply waiting there; anything else at the end is misrouted
          const dv = c.convDest ? this.diverters.find(d => d.segId === seg.id && d.laneId === c.convDest) : null;
          if (dv && dv.pos >= seg.length - 0.05) { /* waiting at the last diverter: limitReason already set */ }
          else { limitReason = 'end of line'; if (c.convDest || c.scannedAt !== null) { this.misroutes++; this.host.onEvent('warn', `MISROUTE: carton ${c.id} reached end of line (dest ${c.convDest}, scanned ${c.scannedAt})`); c.convDest = null; } }
        }
      }
      const np = Math.max(c.convPos, Math.min(target, limit));
      if (np > c.convPos + 1e-6) { c.convPos = np; anyMoved = true; }
      else if (limitReason && limitReason !== 'awaiting pickup') { anyBlocked = true; if (i === 0 || limitReason !== 'queue') seg.blockedBy = seg.blockedBy ?? limitReason; }
      else if (limitReason === 'awaiting pickup' && i === 0) seg.blockedBy = 'awaiting pickup';
    }
    if (seg.cartons.length === 0) seg.status = 'STARVED';
    else if (anyMoved && !anyBlocked) { seg.status = 'RUNNING'; seg.runTime += dt; }
    else if (anyBlocked) { seg.status = 'BLOCKED'; seg.blockedTime += dt; }
    else { seg.status = seg.kind === 'lane' ? 'RUNNING' : 'BLOCKED'; if (seg.kind !== 'lane') seg.blockedTime += dt; }
    if (anyMoved) this.host.bump();
  }

  /** Put a carton onto a segment at `pos`, pulled back if needed so it never overlaps the carton ahead. */
  private placeOn(seg: Segment, c: Container, pos: number) {
    const C = this.host.containers;
    let p = Math.max(0, Math.min(seg.length, pos));
    for (const id of seg.cartons) { const q = C.get(id)!.convPos; if (q >= p - CARTON_GAP && q < p + CARTON_GAP) p = Math.max(0, Math.min(p, q - CARTON_GAP)); }
    c.convSeg = seg.id; c.convPos = p; seg.cartons.push(c.id); seg.cartons.sort((a, b) => C.get(b)!.convPos - C.get(a)!.convPos);
  }

  /** Cartons per hour that left this segment over the last 10 minutes. */
  throughput(seg: Segment) { const cutoff = this.host.time - 600; let n = 0; for (let i = seg.passedTimes.length - 1; i >= 0 && seg.passedTimes[i] > cutoff; i--) n++; return n / Math.min(600, Math.max(60, this.host.time)) * 3600; }

  /** Invariant checks for the conveyor state. */
  check(): string[] {
    const errs: string[] = []; const C = this.host.containers; const seen = new Set<string>();
    for (const seg of this.segments.values()) {
      const sorted = seg.cartons.slice().sort((a, b) => C.get(b)!.convPos - C.get(a)!.convPos);
      for (let i = 0; i < sorted.length; i++) {
        const c = C.get(sorted[i]); if (!c) { errs.push(`${seg.id} references missing carton ${sorted[i]}`); continue; }
        if (seen.has(c.id)) errs.push(`carton ${c.id} on two segments`); seen.add(c.id);
        if (c.convSeg !== seg.id) errs.push(`carton ${c.id} segment mismatch`);
        if (c.convPos < -1e-6 || c.convPos > seg.length + 1e-6) errs.push(`carton ${c.id} off segment ${seg.id} at ${c.convPos.toFixed(2)}`);
        if (i > 0) { const ahead = C.get(sorted[i - 1])!; if (ahead.convPos - c.convPos < CARTON_GAP - 0.05) errs.push(`cartons ${ahead.id}/${c.id} overlap on ${seg.id}`); }
        if (seg.kind === 'lane' && c.convDest && c.convDest !== seg.id) errs.push(`carton ${c.id} in wrong lane ${seg.id} (dest ${c.convDest})`);
        if (seg.kind === 'main' && c.convDest) { const dv = this.diverters.find(d => d.laneId === c.convDest); if (dv && c.convPos > dv.pos + 0.05) errs.push(`carton ${c.id} passed its diverter`); }
      }
    }
    for (const c of C.values()) if (c.convSeg && !seen.has(c.id)) errs.push(`carton ${c.id} claims segment ${c.convSeg} but is not listed`);
    if (this.misroutes) errs.push(`${this.misroutes} misroutes`);
    return errs;
  }
}
const rank = (k: SegKind) => k === 'lane' ? 0 : k === 'main' ? 1 : 2;
