// Spec 29: walking in the office — 4-neighbour BFS on the layout's grid (small: at most a few thousand tiles).

/** Shortest list of tiles from → to (both included is NOT the case: the list starts after `from`).
 *  [] when from equals to, null when there is no path. Tiles are {gx, gy}. */
export function findPath(grid, from, to) {
  const { cols, rows, cells } = grid;
  const idx = (x, y) => y * cols + x;
  const ok = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && cells[idx(x, y)] === 1;
  if (from.gx === to.gx && from.gy === to.gy) return [];
  if (!ok(to.gx, to.gy)) return null;
  const parent = new Int32Array(cols * rows).fill(-1);
  const start = idx(from.gx, from.gy); parent[start] = start;
  const q = [start]; const goal = idx(to.gx, to.gy);
  for (let h = 0; h < q.length; h++) {
    const c = q[h]; if (c === goal) break;
    const x = c % cols; const y = (c - x) / cols;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const ny = y + dy;
      if (!ok(nx, ny)) continue;
      const n = idx(nx, ny); if (parent[n] !== -1) continue;
      parent[n] = c; q.push(n);
    }
  }
  if (parent[goal] === -1) return null;
  const out = [];
  for (let c = goal; c !== start; c = parent[c]) out.push({ gx: c % cols, gy: Math.floor(c / cols) });
  return out.reverse();
}
/** Memoized paths for one layout. */
export function pathCache(layout) {
  const m = new Map();
  return (from, to) => {
    const k = `${from.gx},${from.gy}|${to.gx},${to.gy}`;
    if (!m.has(k)) { if (m.size > 4000) m.clear(); m.set(k, findPath(layout.grid, from, to)); }
    return m.get(k);
  };
}
/** Position (fractional tile) after walking `dist` tiles along [from, ...path]. */
export function pointAlong(from, path, dist) {
  const pts = [from, ...(path || [])];
  if (pts.length === 1 || dist <= 0) return { gx: from.gx, gy: from.gy, done: pts.length === 1 };
  const i = Math.min(Math.floor(dist), pts.length - 1);
  if (i >= pts.length - 1) { const l = pts[pts.length - 1]; return { gx: l.gx, gy: l.gy, done: true }; }
  const f = dist - i; const a = pts[i]; const b = pts[i + 1];
  return { gx: a.gx + (b.gx - a.gx) * f, gy: a.gy + (b.gy - a.gy) * f, done: false, tile: f < 0.5 ? a : b };
}
