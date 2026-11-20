// Spec 29: the office floor plan, generated from the flow (any flow fits). Pure.
// Tiles (gx, gy) on an isometric grid. Reception on the left (the window with the coordinator, the queue, the turn
// display, Entrada), one column of desks per execution level (max 6 desks per column, 6 columns per room; more rooms
// stack below), the shelves Contexto/Memoria/Expedientes on each room's back wall, Salida and Archivo at the end.

export const TILE_W = 64; export const TILE_H = 32;
// The camera: rotation r (0..3, quarter turns) of the floor W×H. The plan never changes; only how it is projected.
let VIEW = { r: 0, W: 1, H: 1 };
export function setView(r, W, H) { VIEW = { r: ((Number(r) || 0) % 4 + 4) % 4, W, H }; }
export const viewRotation = () => VIEW.r;
/** Plan coordinates → rotated coordinates (where +x and +y point towards the viewer). */
export function rot(gx, gy) {
  const { r, W, H } = VIEW;
  if (r === 1) return [H - gy, gx];
  if (r === 2) return [W - gx, H - gy];
  if (r === 3) return [gy, W - gx];
  return [gx, gy];
}
/** A direction of the plan, rotated (to know which faces look at the viewer). */
export function rotDir(dx, dy) {
  const { r } = VIEW;
  if (r === 1) return [-dy, dx];
  if (r === 2) return [-dx, -dy];
  if (r === 3) return [dy, -dx];
  return [dx, dy];
}
/** Is a face whose outward normal is (dx, dy) in the plan turned towards the viewer? */
export const facesViewer = (dx, dy) => { const [x, y] = rotDir(dx, dy); return x > 0 || y > 0; };
export const isoRaw = (x, y) => ({ x: (x - y) * (TILE_W / 2), y: (x + y) * (TILE_H / 2) });
export const iso = (gx, gy) => { const [x, y] = rot(gx, gy); return isoRaw(x, y); };
/** Paint order of a tile (bigger = closer to the viewer). */
export const depth = (gx, gy) => { const [x, y] = rot(gx + 0.5, gy + 0.5); return x + y - 1; };
/** Paint order of a footprint: its closest tile. */
export const depthOf = (gx, gy, w = 1, h = 1) => Math.max(depth(gx, gy), depth(gx + w - 1, gy), depth(gx, gy + h - 1), depth(gx + w - 1, gy + h - 1));
export const MAX_DESKS = 60;
const REC_W = 4; // the reception is 4 tiles wide, at the FRONT-RIGHT corner (closest to the viewer); a half-wall on its left
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
  const cols = Math.max(1 + usedCols * COL_STRIDE + 1 + 1 + REC_W, 16); // corridor, desks, aisle, half-wall, reception
  const maxPerCol = Math.max(1, ...columns.map((c) => c.steps.length));
  const ROOM_H = Math.max(8, 3 + maxPerCol * ROW_STRIDE); // back wall, shelf access row, (seat, desk, aisle) × n, one spare row
  const rows = rooms * ROOM_H;
  const cells = new Uint8Array(cols * rows).fill(1);
  const block = (gx, gy) => { if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) cells[gy * cols + gx] = 0; };
  const desks = [];
  columns.forEach((c, ci) => {
    const room = Math.floor(ci / COLS_PER_ROOM); const cr = ci % COLS_PER_ROOM;
    const gx = 1 + cr * COL_STRIDE;
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
  // the reception sits at the FRONT-RIGHT corner of the office (the corner closest to the viewer): the coordinator
  // behind his counter, facing you, is the first one you see; the waiting chairs in front of it (people seen from
  // behind); the turn display on a stand; the kiosk; the Entrada/Salida cabinet behind him; a half-wall on its left
  // (open at the back, towards the desks)
  const F = rows; const X = cols - REC_W; // front edge, first reception column
  put('window', X + 1, F - 3, 2, 1, { gx: X + 1, gy: F - 2 });
  put('display', X, F - 3, 1, 1, { gx: X + 1, gy: F - 2 });
  deco('kiosk', X + 3, F - 1);
  deco('waiting', X, F - 1, 3, 1);
  put('entrada', X, F - 5, 1, 1, { gx: X, gy: F - 6 });
  put('salida', X + 1, F - 5, 1, 1, { gx: X + 1, gy: F - 6 });
  deco('plant:rec', X, F - 4, 1, 1, { kind: 'ficus' });
  for (let y = F - 6; y < F; y++) block(X - 1, y);
  for (let k = 0; k < 6; k++) decor.push({ id: `halfwall:${k}`, gx: X - 1, gy: F - 6 + k, w: 0.14, h: 1, kind: 'halfwall' }); // one piece per tile: each one paints in its place
  for (let r = 0; r < rooms; r++) {
    const y = r * ROOM_H;
    put(`shelf:contexto:${r}`, 1, y, 2, 1, { gx: 1, gy: y + 1 }, { shelf: 'contexto', room: r });
    put(`shelf:memoria:${r}`, 4, y, 2, 1, { gx: 4, gy: y + 1 }, { shelf: 'memoria', room: r });
    put(`shelf:expedientes:${r}`, 7, y, 2, 1, { gx: 7, gy: y + 1 }, { shelf: 'expedientes', room: r });
    deco(`plant:${r}:a`, 3, y, 1, 1, { kind: 'pothos' });
    deco(`plant:${r}:c`, 6, y, 1, 1, { kind: 'pothos' });
    deco(`cooler:${r}`, 0, y + 2, 1, 1, { kind: 'cooler' }); deco(`coffee:${r}`, 0, y + 3, 1, 1, { kind: 'coffee' });
    if (r < rooms - 1 || ROOM_H > 8) deco(`plant:${r}:b`, 0, y + ROOM_H - 1, 1, 1, { kind: 'plant' });
  }
  const lastRoomY = (rooms - 1) * ROOM_H;
  put('archivo', 9, lastRoomY, 2, 1, { gx: 9, gy: lastRoomY + 1 });
  const chair = { gx: X + 1, gy: F - 4 };
  const queue = [0, 1, 2].map((x) => ({ gx: X + x, gy: F - 1 }));
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
