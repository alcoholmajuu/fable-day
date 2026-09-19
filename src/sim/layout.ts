import { Grid } from './grid';
import type { Cell, Dock, RackLocation, SKU, Spot, Station, Zone } from './types';

export const GRID_W = 45;
export const GRID_H = 32;
export const RACK_LEVELS = 3;
export const LOC_CAPACITY = 16;
export const RACK_Z_RANGES: [number, number][] = [[4, 14], [17, 27]];
/** Rack column pairs: [aisle-west rack x, aisle-east rack x]. Racks at x face outward to their neighbouring aisle. */
export const RACK_COLUMNS = [12, 13, 16, 17, 20, 21, 24, 25, 28, 29];
/** Pack station origins (z), main conveyor extent and sortation lane rows. */
export const PACK_Z0 = [4, 10, 16];
export const MAIN_Z0 = 4, MAIN_Z1 = 28;
export const LANE_Z = [22, 24, 26, 28];
export const SCANNER_Z = 20;
/** Which dock each lane row serves. */
export const LANE_DOCK: Record<number, string> = { 22: 'DOCK-OUT-1', 24: 'DOCK-OUT-1', 26: 'DOCK-OUT-2', 28: 'DOCK-OUT-2' };

export interface Layout {
  grid: Grid;
  zones: Zone[];
  racks: RackLocation[];
  spots: Spot[];
  stations: Station[];
  docks: Dock[];
  skus: SKU[];
  rackCells: Cell[];
  /** Painted lines etc. purely for rendering. */
  aisleLabels: { cell: Cell; text: string }[];
}

const AISLE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

export function buildLayout(): Layout {
  const grid = new Grid(GRID_W, GRID_H);
  const zones: Zone[] = [
    { id: 'receiving', name: 'RECEIVING', x0: 1, z0: 2, x1: 6, z1: 30, color: 0x4f7fd6 },
    { id: 'inspection', name: 'INSPECTION', x0: 6, z0: 2, x1: 9, z1: 30, color: 0xe0b23a },
    { id: 'storage', name: 'STORAGE', x0: 10, z0: 2, x1: 32, z1: 30, color: 0x8a9099 },
    { id: 'picking', name: 'PICKING', x0: 32, z0: 2, x1: 35, z1: 30, color: 0x5cb870 },
    { id: 'packing', name: 'PACKING', x0: 35, z0: 2, x1: 39, z1: 30, color: 0xe8813a },
    { id: 'staging', name: 'SORTATION', x0: 39, z0: 2, x1: 43, z1: 30, color: 0x9c6ad6 },
    { id: 'shipping', name: 'SHIPPING', x0: 43, z0: 2, x1: 45, z1: 30, color: 0x3fb8c4 },
  ];

  // Outer margins (z=0,1 and z=30,31) are walls / not walkable.
  for (let x = 0; x < GRID_W; x++) { grid.block(x, 0); grid.block(x, 1); grid.block(x, 30); grid.block(x, 31); }

  const racks: RackLocation[] = [];
  const rackCells: Cell[] = [];
  const aisleLabels: { cell: Cell; text: string }[] = [];
  RACK_COLUMNS.forEach((x, i) => {
    // even index -> rack faces west (access x-1), odd -> faces east (access x+1)
    const side: 1 | -1 = i % 2 === 0 ? -1 : 1;
    const aisle = AISLE_NAMES[i];
    for (const [z0, z1] of RACK_Z_RANGES) {
      for (let z = z0; z <= z1; z++) {
        grid.block(x, z);
        rackCells.push({ cx: x, cz: z });
        for (let lvl = 0; lvl < RACK_LEVELS; lvl++) {
          racks.push({
            id: `${aisle}-${String(z).padStart(2, '0')}-${lvl + 1}`,
            cell: { cx: x, cz: z }, level: lvl, accessCell: { cx: x + side, cz: z }, side,
            capacity: LOC_CAPACITY, skuId: null, qty: 0, reserved: 0, incoming: 0, aisle,
          });
        }
      }
    }
    aisleLabels.push({ cell: { cx: x, cz: 2 }, text: aisle });
  });

  const spots: Spot[] = [];
  const stations: Station[] = [];
  const addSpot = (s: Omit<Spot, 'containerIds' | 'pending'>) => { const sp: Spot = { ...s, containerIds: [], pending: 0 }; spots.push(sp); return sp; };

  // Receiving pallet spots: x=3, every other z, accessed from x=2
  for (let z = 4; z <= 28; z += 2) {
    grid.block(3, z);
    addSpot({ id: `RCV-${z}`, kind: 'receiving', cell: { cx: 3, cz: z }, accessCell: { cx: 2, cz: z }, capacity: 1, stationId: null });
  }
  // Inspection stations: bench at (7,z0),(7,z0+1) accessed from x=6; out buffer (7,z0+2),(7,z0+3)
  for (const z0 of [6, 14, 22]) {
    const id = `INSP-${z0}`;
    grid.block(7, z0); grid.block(7, z0 + 1); grid.block(7, z0 + 2); grid.block(7, z0 + 3);
    const bench = addSpot({ id: `${id}-bench`, kind: 'inspect_bench', cell: { cx: 7, cz: z0 }, accessCell: { cx: 6, cz: z0 }, capacity: 1, stationId: id });
    const out = addSpot({ id: `${id}-out`, kind: 'inspect_out', cell: { cx: 7, cz: z0 + 2 }, accessCell: { cx: 6, cz: z0 + 2 }, capacity: 2, stationId: id });
    stations.push({ id, kind: 'inspect', cells: [{ cx: 7, cz: z0 }, { cx: 7, cz: z0 + 1 }], accessCell: { cx: 6, cz: z0 }, busyWorkerId: null, spotIds: { bench: bench.id, out: out.id }, processed: 0 });
  }
  // Tote shelves (picking zone) x=33 accessed from x=32
  for (const z of [8, 12, 19, 23]) {
    grid.block(33, z);
    addSpot({ id: `TOTE-${z}`, kind: 'tote_shelf', cell: { cx: 33, cz: z }, accessCell: { cx: 32, cz: z }, capacity: 8, stationId: null });
  }
  // Packing stations: in-buffer (37,z0) ; bench (37,z0+1) ; induction conveyor (37,z0+2),(38,z0+2) ; out (empty totes) (37,z0+3). Access from x=36.
  for (const z0 of PACK_Z0) {
    const id = `PACK-${z0}`;
    for (let k = 0; k < 4; k++) grid.block(37, z0 + k);
    grid.block(38, z0 + 2);
    const inS = addSpot({ id: `${id}-in`, kind: 'pack_in', cell: { cx: 37, cz: z0 }, accessCell: { cx: 36, cz: z0 }, capacity: 3, stationId: id });
    const bench = addSpot({ id: `${id}-bench`, kind: 'pack_bench', cell: { cx: 37, cz: z0 + 1 }, accessCell: { cx: 36, cz: z0 + 1 }, capacity: 1, stationId: id });
    const out = addSpot({ id: `${id}-out`, kind: 'pack_out', cell: { cx: 37, cz: z0 + 3 }, accessCell: { cx: 36, cz: z0 + 3 }, capacity: 4, stationId: id });
    stations.push({ id, kind: 'pack', cells: [{ cx: 37, cz: z0 + 1 }], accessCell: { cx: 36, cz: z0 + 1 }, busyWorkerId: null, spotIds: { in: inS.id, bench: bench.id, out: out.id }, processed: 0, inductionId: `IND-${z0}`, inductionAccess: { cx: 36, cz: z0 + 2 } });
  }
  // Main outbound conveyor along x=39 (flows south), sortation lanes running east at LANE_Z
  for (let z = MAIN_Z0; z <= MAIN_Z1; z++) grid.block(39, z);
  for (const z of LANE_Z) for (let x = 40; x <= 42; x++) grid.block(x, z);

  const docks: Dock[] = [
    { id: 'DOCK-IN-1', kind: 'inbound', cell: { cx: 0, cz: 9 }, truckId: null, nextArrival: 6 },
    { id: 'DOCK-IN-2', kind: 'inbound', cell: { cx: 0, cz: 21 }, truckId: null, nextArrival: 70 },
    { id: 'DOCK-OUT-1', kind: 'outbound', cell: { cx: 44, cz: 21 }, truckId: null, nextArrival: 40 },
    { id: 'DOCK-OUT-2', kind: 'outbound', cell: { cx: 44, cz: 27 }, truckId: null, nextArrival: 130 },
  ];

  const skus: SKU[] = SKU_DEFS.map((d, i) => ({ id: `SKU-${String(i + 1).padStart(2, '0')}`, name: d[0], color: d[1], popularity: d[2], palletQty: d[3] }));
  return { grid, zones, racks, spots, stations, docks, skus, rackCells, aisleLabels };
}

const SKU_DEFS: [string, number, number, number][] = [
  ['Blue Bins', 0x3b6fd8, 9, 14],
  ['Red Kettles', 0xd9403a, 8, 11],
  ['Green Planters', 0x3faa5c, 7, 14],
  ['Yellow Lamps', 0xe8c53a, 6, 11],
  ['Orange Toolkits', 0xe8823a, 6, 11],
  ['Purple Speakers', 0x8a5ad6, 5, 11],
  ['Teal Bottles', 0x36b3b8, 5, 16],
  ['Pink Pillows', 0xe07aa8, 4, 16],
  ['White Mugs', 0xe9e9e9, 4, 16],
  ['Black Cables', 0x35363b, 4, 16],
  ['Brown Boots', 0x8a5a3a, 3, 11],
  ['Lime Toys', 0xa6d84a, 3, 14],
  ['Navy Backpacks', 0x233a7a, 2, 11],
  ['Gold Frames', 0xc9a13a, 2, 8],
  ['Grey Monitors', 0x9a9fa8, 2, 8],
  ['Cyan Drones', 0x4ad8e8, 1, 8],
];
