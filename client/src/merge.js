// Three-way merge of a flow edited in several places at once (other tabs, chat proposals, hooks) — spec 19.
// base = last version this tab got from the server; local = this tab's version (with unsaved edits);
// remote = the newer version on the server. Rules, per field:
//   only remote changed it → remote · only local changed it → local · both, same value → that value ·
//   both, different values → local wins and the field is reported as a conflict.
// Run state that only the server writes (lastRun, memory, pins, chat sessions) always comes from remote.

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const SERVER_STEP = new Set(['memory', 'lastRun', 'pinned', 'chatSessionId', 'chatContextHash']);
const SERVER_FLOW = new Set(['memory', 'globalSessionId', 'globalContextHash', 'updatedAt', 'createdAt', 'rev', 'id']);
const FLOW_FIELDS = ['name', 'description', 'cwd', 'vars', 'schedule', 'runTimeoutSec', 'versionEveryMin', 'contextSources'];

function field(b, l, r, label, conflicts) {
  if (eq(l, b)) return r;
  if (eq(r, b) || eq(l, r)) return l;
  conflicts.push(label);
  return l;
}

/** Merges two objects key by key (server-managed keys from remote). */
function mergeObj(b = {}, l = {}, r = {}, serverKeys, label, conflicts) {
  const out = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    if (serverKeys.has(k)) { if (r[k] !== undefined) out[k] = r[k]; continue; }
    const v = field(b[k], l[k], r[k], `${label}.${k}`, conflicts);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Merges two lists of objects with ids (steps, edges): additions and deletions from both sides. */
function mergeList(b = [], l = [], r = [], mergeItem, label, conflicts) {
  const B = new Map(b.map((x) => [x.id, x])); const L = new Map(l.map((x) => [x.id, x])); const R = new Map(r.map((x) => [x.id, x]));
  const order = [...r.map((x) => x.id), ...l.map((x) => x.id).filter((id) => !R.has(id))];
  const out = [];
  for (const id of order) {
    const bi = B.get(id); const li = L.get(id); const ri = R.get(id);
    if (!bi) { out.push(li && ri ? mergeItem({}, li, ri) : li || ri); continue; } // added on one side (or both)
    if (!li && !ri) continue; // deleted on both sides
    if (!li) { if (eq(ri, bi)) continue; conflicts.push(`${label} "${ri.name || id}" (borrado aquí, cambiado en otra parte: se conserva)`); out.push(ri); continue; }
    if (!ri) { if (eq(li, bi)) continue; conflicts.push(`${label} "${li.name || id}" (borrado en otra parte, cambiado aquí: se conserva)`); out.push(li); continue; }
    out.push(mergeItem(bi, li, ri));
  }
  return out;
}

export function mergeFlows(base, local, remote) {
  const conflicts = [];
  if (!base || !local || local.id !== remote.id) return { merged: remote, conflicts };
  const merged = { ...remote };
  for (const k of FLOW_FIELDS) merged[k] = field(base[k], local[k], remote[k], k, conflicts);
  for (const k of Object.keys(local)) if (!(k in merged) && !SERVER_FLOW.has(k) && k !== 'steps' && k !== 'edges') merged[k] = local[k];
  merged.steps = mergeList(base.steps, local.steps, remote.steps, (b, l, r) => mergeObj(b, l, r, SERVER_STEP, `step "${r.name || l.name}"`, conflicts), 'step', conflicts);
  const ids = new Set(merged.steps.map((s) => s.id));
  const edges = mergeList(base.edges, local.edges, remote.edges, (b, l, r) => mergeObj(b, l, r, new Set(), 'flecha', conflicts), 'flecha', conflicts)
    .filter((e) => ids.has(e.source) && ids.has(e.target));
  // Arrows added on each side can close a cycle together: keep the server's first, drop the one that would close it.
  merged.edges = [];
  for (const e of edges) {
    if (reaches(merged.edges, e.target, e.source) || merged.edges.some((x) => x.source === e.source && x.target === e.target)) { conflicts.push(`flecha ${e.source}→${e.target} (cerraba un ciclo o estaba repetida: se descartó)`); continue; }
    merged.edges.push(e);
  }
  return { merged, conflicts };
}

function reaches(edges, from, to) {
  const stack = [from]; const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue; seen.add(n);
    for (const e of edges) if (e.source === n) stack.push(e.target);
  }
  return false;
}
