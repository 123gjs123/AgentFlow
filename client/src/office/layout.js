// Spec 29: the office floor plan, generated from the flow (any flow fits). Pure.
// Tiles (gx, gy) on an isometric grid. Reception on the left (the window with the coordinator, the queue, the turn
// display, Entrada), one column of desks per execution level (max 6 desks per column, 6 columns per room; more rooms
// stack below), the shelves Contexto/Memoria/Expedientes on each room's back wall, Salida and Archivo at the end.

export const TILE_W = 64; export const TILE_H = 32;
export const iso = (gx, gy) => ({ x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) });
export const depth = (gx, gy) => gx + gy;
export const MAX_DESKS = 60;
const REC_W = 4; // reception (gx 0..3); the half-wall stands on gx 4
const PER_COL = 6; const COLS_PER_ROOM = 6;
const COL_STRIDE = 3; const ROW_STRIDE = 3;

/** Execution levels (1-based), like the canvas badge; unreached / cyclic steps go to a final level. */
export function levelsOf(flow) {
  const steps = flow?.steps || []; const edges = (flow?.edges || []).filter((e) => e && e.source !== e.target);
  const ids = new Set(steps.map((s) => s.id));
  const indeg = new Map(steps.map((s) => [s.id, 0]));
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target)) indeg.set(e.target, indeg.get(e.target) + 1);
  const lvl = new Map(); let frontier = steps.filter((s) => !indeg.get(s.id)).map((s) => s.id); let k = 1;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) { if (lvl.has(id)) continue; lvl.set(id, k); for (const e of edges) if (e.source === id && ids.has(e.target)) { indeg.set(e.target, indeg.get(e.target) - 1); if (!indeg.get(e.target)) next.push(e.target); } }
    frontier = next; k++;
  }
  const rest = steps.filter((s) => !lvl.has(s.id));
  if (rest.length) { for (const s of rest) lvl.set(s.id, k); }
  return lvl;
}

/** The whole floor plan: desks, furniture, walkable grid. Deterministic for the same steps and edges. */
export function officeLayout(flow) {
  const all = flow?.steps || [];
  const steps = all.slice(0, MAX_DESKS);
  const lvl = levelsOf({ ...flow, steps });
  // columns: one per level; a level with more than PER_COL desks spills into extra sub-columns
  const byLevel = new Map();
  for (const s of steps) { const l = lvl.get(s.id) || 1; if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(s); }
  const columns = [];
  for (const l of [...byLevel.keys()].sort((a, b) => a - b)) { const list = byLevel.get(l); for (let i = 0; i < list.length; i += PER_COL) columns.push({ level: l, steps: list.slice(i, i + PER_COL) }); }
  const rooms = Math.max(1, Math.ceil(columns.length / COLS_PER_ROOM));
  // as big as this flow needs (never smaller than the reception and the three shelves)
  const usedCols = Math.min(COLS_PER_ROOM, Math.max(1, columns.length));
  const cols = Math.max(REC_W + 1 + usedCols * COL_STRIDE + 1, REC_W + 12);
  const maxPerCol = Math.max(1, ...columns.map((c) => c.steps.length));
  const ROOM_H = Math.max(8, 3 + maxPerCol * ROW_STRIDE); // back wall, shelf access row, (seat, desk, aisle) × n, one spare row
  const rows = rooms * ROOM_H;
  const cells = new Uint8Array(cols * rows).fill(1);
  const block = (gx, gy) => { if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) cells[gy * cols + gx] = 0; };
  const desks = [];
  columns.forEach((c, ci) => {
    const room = Math.floor(ci / COLS_PER_ROOM); const cr = ci % COLS_PER_ROOM;
    const gx = REC_W + 1 + cr * COL_STRIDE;
    c.steps.forEach((s, ri) => {
      const gy = room * ROOM_H + 3 + ri * ROW_STRIDE;
      block(gx, gy); block(gx + 1, gy); // the desk (2 tiles)
      // the person sits BEHIND the desk facing the viewer (like the reference illustration); the coordinator hands the
      // folder from the front
      desks.push({ id: s.id, kind: s.kind, level: c.level, room, gx, gy, seat: { gx, gy: gy - 1 }, visit: { gx, gy: gy + 1 } });
    });
  });
  // furniture
  const furniture = [];
  const put = (id, gx, gy, w, h, access, extra = {}) => { for (let x = gx; x < gx + w; x++) for (let y = gy; y < gy + h; y++) block(x, y); furniture.push({ id, gx, gy, w, h, access, ...extra }); };
  // reception: the turn display on the left wall, the coordinator's counter (he sits behind it), the ticket kiosk,
  // the waiting chairs, the Entrada/Salida cabinet
  const decor = [];
  const deco = (id, gx, gy, w = 1, h = 1, extra = {}) => { for (let x = gx; x < gx + w; x++) for (let y = gy; y < gy + h; y++) block(x, y); decor.push({ id, gx, gy, w, h, ...extra }); };
  // the turn display hangs on the left wall (no tile); the counter with the coordinator behind it; the kiosk; the
  // waiting chairs; the Entrada/Salida cabinet; the half-wall that closes the reception (doorway at the last two rows)
  furniture.push({ id: 'display', gx: 0, gy: 0, w: 0, h: 0, access: { gx: 1, gy: 1 }, wall: true });
  put('window', 1, 2, 2, 1, { gx: 1, gy: 1 });
  deco('kiosk', 0, 3);
  deco('waiting', 0, 5, 3, 1);
  put('entrada', 0, ROOM_H - 1, 1, 1, { gx: 0, gy: ROOM_H - 2 });
  put('salida', 1, ROOM_H - 1, 1, 1, { gx: 1, gy: ROOM_H - 2 });
  deco('plant:rec', 0, 0, 1, 1, { kind: 'ficus' });
  for (let y = 1; y < ROOM_H - 2; y++) block(REC_W, y);
  decor.push({ id: 'halfwall', gx: REC_W, gy: 1, w: 0.14, h: ROOM_H - 3, kind: 'halfwall' });
  for (let r = 0; r < rooms; r++) {
    const y = r * ROOM_H;
    put(`shelf:contexto:${r}`, REC_W + 1, y, 2, 1, { gx: REC_W + 1, gy: y + 1 }, { shelf: 'contexto', room: r });
    put(`shelf:memoria:${r}`, REC_W + 4, y, 2, 1, { gx: REC_W + 4, gy: y + 1 }, { shelf: 'memoria', room: r });
    put(`shelf:expedientes:${r}`, REC_W + 7, y, 2, 1, { gx: REC_W + 7, gy: y + 1 }, { shelf: 'expedientes', room: r });
    deco(`plant:${r}:a`, REC_W + 3, y, 1, 1, { kind: 'pothos' });
    deco(`plant:${r}:c`, REC_W + 6, y, 1, 1, { kind: 'pothos' });
    if (cols - 1 > REC_W + 10) { deco(`cooler:${r}`, cols - 1, y + 2, 1, 1, { kind: 'cooler' }); deco(`coffee:${r}`, cols - 1, y + 3, 1, 1, { kind: 'coffee' }); }
    deco(`plant:${r}:b`, cols - 1, y + ROOM_H - 1, 1, 1, { kind: 'plant' });
  }
  const lastRoomY = (rooms - 1) * ROOM_H;
  put('archivo', REC_W + 9, lastRoomY, 2, 1, { gx: REC_W + 9, gy: lastRoomY + 1 });
  const chair = { gx: 1, gy: 1 };
  const queue = [0, 1, 2].map((x) => ({ gx: x, gy: 5 }));
  const grid = { cols, rows, cells };
  const hubOf = (level) => { const d = desks.find((x) => x.level === level); return d ? { gx: d.gx + 2, gy: d.gy + 1 } : chair; };
  const hash = `${steps.map((s) => `${s.id}:${s.kind}`).join(',')}|${(flow?.edges || []).map((e) => `${e.source}>${e.target}`).join(',')}`;
  return { cols, rows, rooms, roomH: ROOM_H, grid, desks, furniture, decor, chair, queue, hubOf, overflow: Math.max(0, all.length - MAX_DESKS), hash };
}
/** The access tile of a shelf nearest to a desk's room. */
export function shelfAccess(layout, shelf, room = 0) {
  const f = layout.furniture.find((x) => x.shelf === shelf && x.room === room) || layout.furniture.find((x) => x.shelf === shelf);
  return f?.access || layout.chair;
}
export const furnitureAccess = (layout, id) => layout.furniture.find((f) => f.id === id)?.access || layout.chair;
