import type { Cell } from './types';

/** Walkability grid with A* (8-neighbour, no corner cutting). */
export class Grid {
  readonly blocked: Uint8Array;
  private gScore: Float32Array; private came: Int32Array; private closed: Uint8Array; private heap: MinHeap;
  constructor(readonly w: number, readonly h: number) {
    this.blocked = new Uint8Array(w * h);
    this.gScore = new Float32Array(w * h); this.came = new Int32Array(w * h); this.closed = new Uint8Array(w * h); this.heap = new MinHeap(w * h);
  }
  idx(cx: number, cz: number) { return cz * this.w + cx; }
  inBounds(cx: number, cz: number) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }
  isBlocked(cx: number, cz: number) { return !this.inBounds(cx, cz) || this.blocked[this.idx(cx, cz)] === 1; }
  block(cx: number, cz: number) { if (this.inBounds(cx, cz)) this.blocked[this.idx(cx, cz)] = 1; }
  walkable(c: Cell) { return !this.isBlocked(c.cx, c.cz); }

  /** Returns cell path from start to goal (excluding start, including goal), or null. */
  findPath(start: Cell, goal: Cell): Cell[] | null {
    if (this.isBlocked(goal.cx, goal.cz) || this.isBlocked(start.cx, start.cz)) return null;
    if (start.cx === goal.cx && start.cz === goal.cz) return [];
    const n = this.w * this.h;
    const g = this.gScore; g.fill(Infinity);
    const came = this.came; came.fill(-1);
    const closed = this.closed; closed.fill(0);
    const s = this.idx(start.cx, start.cz), t = this.idx(goal.cx, goal.cz);
    g[s] = 0;
    const open = this.heap; open.clear();
    open.push(s, this.h8(start.cx, start.cz, goal.cx, goal.cz));
    const w = this.w;
    while (open.size > 0) {
      const cur = open.pop();
      if (cur === t) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % w, cz = (cur - cx) / w;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dz = DZ[d];
        const nx = cx + dx, nz = cz + dz;
        if (this.isBlocked(nx, nz)) continue;
        if (dx !== 0 && dz !== 0 && (this.isBlocked(cx + dx, cz) || this.isBlocked(cx, cz + dz))) continue;
        const ni = nz * w + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + (dx !== 0 && dz !== 0 ? 1.4142 : 1);
        if (ng < g[ni]) {
          g[ni] = ng; came[ni] = cur;
          open.push(ni, ng + this.h8(nx, nz, goal.cx, goal.cz));
        }
      }
    }
    if (came[t] === -1) return null;
    const out: Cell[] = [];
    let c = t;
    while (c !== s) { out.push({ cx: c % w, cz: Math.floor(c / w) }); c = came[c]; }
    out.reverse();
    return out;
  }
  private h8(ax: number, az: number, bx: number, bz: number) {
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
  }

  /** Nearest walkable cell to c (BFS ring search). */
  nearestWalkable(c: Cell): Cell {
    if (!this.isBlocked(c.cx, c.cz)) return c;
    for (let r = 1; r < 6; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (!this.isBlocked(c.cx + dx, c.cz + dz)) return { cx: c.cx + dx, cz: c.cz + dz };
    }
    return c;
  }
}
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

class MinHeap {
  private ids: Int32Array; private keys: Float32Array; size = 0;
  constructor(cap: number) { this.ids = new Int32Array(cap * 4); this.keys = new Float32Array(cap * 4); }
  clear() { this.size = 0; }
  push(id: number, key: number) {
    if (this.size >= this.ids.length) { // grow
      const ni = new Int32Array(this.ids.length * 2); ni.set(this.ids); this.ids = ni;
      const nk = new Float32Array(this.keys.length * 2); nk.set(this.keys); this.keys = nk;
    }
    let i = this.size++;
    this.ids[i] = id; this.keys[i] = key;
    while (i > 0) { const p = (i - 1) >> 1; if (this.keys[p] <= this.keys[i]) break; this.swap(i, p); i = p; }
  }
  pop(): number {
    const top = this.ids[0];
    this.size--;
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size]; this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break; this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
}
