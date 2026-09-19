export interface Cell { cx: number; cz: number }
export const cellKey = (c: Cell) => c.cx * 1000 + c.cz;
export const sameCell = (a: Cell, b: Cell) => a.cx === b.cx && a.cz === b.cz;

export interface SKU {
  id: string;
  name: string;
  color: number;      // display color
  popularity: number; // demand weight
  palletQty: number;  // units per inbound pallet
}

/** A rack slot holding a single SKU. This is the inventory of record. */
export interface RackLocation {
  id: string;
  cell: Cell;        // rack cell (blocked)
  level: number;     // 0..levels-1
  accessCell: Cell;  // aisle cell where a worker stands
  side: 1 | -1;      // which x-direction faces the aisle
  capacity: number;
  skuId: string | null;
  qty: number;       // physical units on the shelf
  reserved: number;  // units reserved for open pick jobs (<= qty)
  incoming: number;  // units en route via putaway (qty + incoming <= capacity)
  aisle: string;
}

export type SpotKind = 'receiving' | 'inspect_bench' | 'inspect_out' | 'tote_shelf' | 'pack_in' | 'pack_bench' | 'pack_out' | 'staging';

/** A floor/bench spot that holds containers (pallets, totes, cartons). */
export interface Spot {
  id: string;
  kind: SpotKind;
  cell: Cell;
  accessCell: Cell;
  capacity: number;        // containers
  containerIds: string[];
  pending: number;         // slots promised to in-flight jobs
  stationId: string | null;
}

export type ContainerKind = 'pallet' | 'tote' | 'carton';
export interface Line { skuId: string; qty: number }
export interface Container {
  id: string;
  kind: ContainerKind;
  lines: Line[];
  spotId: string | null;     // resting in a spot
  carriedBy: string | null;  // worker id
  truckId: string | null;    // inside a truck
  orderId: string | null;    // tote/carton belongs to order
  inspected: boolean;        // pallets: passed inspection
  reservedBy: string | null; // job id that has claimed this container
  createdAt: number;
}

export type OrderState = 'NEW' | 'BACKORDER' | 'ALLOCATED' | 'PICKING' | 'PICKED' | 'PACKING' | 'PACKED' | 'STAGED' | 'LOADING' | 'SHIPPED';
export const ORDER_STATES: OrderState[] = ['NEW', 'BACKORDER', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'STAGED', 'LOADING', 'SHIPPED'];
export interface OrderLine extends Line { picked: number; fromLocations: { locId: string; qty: number }[] }
export interface Order {
  id: string;
  num: number;
  customer: string;
  lines: OrderLine[];
  state: OrderState;
  createdAt: number;
  shippedAt: number | null;
  toteId: string | null;
  cartonId: string | null;
  jobId: string | null;
  rush: boolean;
}

export type JobType = 'UNLOAD' | 'INSPECT' | 'PUTAWAY' | 'PICK' | 'PACK' | 'LOAD' | 'TOTE_RETURN';
export const JOB_TYPES: JobType[] = ['UNLOAD', 'INSPECT', 'PUTAWAY', 'PICK', 'PACK', 'LOAD', 'TOTE_RETURN'];
export type JobState = 'open' | 'active' | 'done' | 'failed';

export type Step =
  | { kind: 'goto'; cell: Cell; label: string; face?: Cell }
  | { kind: 'work'; duration: number; label: string; then?: () => boolean | void }
  | { kind: 'act'; label: string; fn: () => boolean | void };

export interface Job {
  id: string;
  type: JobType;
  state: JobState;
  workerId: string | null;
  priority: number;
  createdAt: number;
  startedAt: number | null;
  steps: Step[];
  stepIdx: number;
  /** Human-readable target, e.g. "Order #12" or "Pallet P3 -> A2-07-2". */
  summary: string;
  /** Ids related to the job for inspection/highlighting. */
  refs: { orderId?: string; containerId?: string; locationIds?: string[]; spotIds?: string[]; truckId?: string; stationId?: string };
  /** Check the job can start/continue. Returning false abandons it. */
  validate: () => boolean;
  /** Undo reservations etc. when abandoned. Called at most once. */
  release: () => void;
  /** Called by the dispatcher when a worker claims the job. Builds steps. Return false if it cannot be claimed right now. */
  claim: (workerId: string) => boolean;
  attempts: number;
  /** If set, only this worker may claim the job (used for carried-container recovery). */
  onlyWorkerId: string | null;
  sourceKey: string;
}

export type Role = 'receiver' | 'picker' | 'packer' | 'shipper';
export type WorkerState = 'idle' | 'walking' | 'working';
export interface Worker {
  id: string;
  name: string;
  role: Role;
  x: number; z: number;      // world position (cell units, continuous)
  facing: number;            // radians
  cell: Cell;
  path: Cell[];
  pathIdx: number;
  jobId: string | null;
  carrying: string | null;   // container id
  carryExtra: string[];      // additional stacked containers (tote returns)
  state: WorkerState;
  workTimer: number;
  workTotal: number;
  workLabel: string;
  stuckTimer: number;
  lastProgressDist: number;
  lateral: number;           // small lane offset so workers don't overlap
  speed: number;
  busyTime: number;
  jobsDone: number;
  replans: number;
  idleSince: number;
}

export type TruckKind = 'inbound' | 'outbound';
export type TruckState = 'arriving' | 'docked' | 'departing';
export interface Truck {
  id: string;
  kind: TruckKind;
  state: TruckState;
  dockId: string;
  dockCell: Cell;      // where the worker stands
  t: number;           // 0..1 animation progress for arriving/departing
  containerIds: string[];
  capacity: number;
  dockedAt: number;
  dwell: number;
  loadedCount: number;
  pending: number;     // load slots promised to active jobs
  activeUnloads: number;
}

export interface Dock { id: string; kind: TruckKind; cell: Cell; truckId: string | null; nextArrival: number }

export interface Station {
  id: string;
  kind: 'inspect' | 'pack';
  cells: Cell[];
  accessCell: Cell;
  busyWorkerId: string | null;
  spotIds: { in?: string; bench?: string; out?: string };
  processed: number;
}

export interface Zone { id: string; name: string; x0: number; z0: number; x1: number; z1: number; color: number }

export interface LogEvent { t: number; text: string; kind: 'info' | 'ship' | 'inbound' | 'warn' | 'order' }
