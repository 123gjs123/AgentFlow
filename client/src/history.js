// Undo / redo of local edits (spec 20). Each entry keeps the flow definition before and after one action (typing
// bursts within HISTORY_COALESCE_MS are one action). Undo/redo apply only what THAT action changed, on top of the
// current flow (3-way, via mergeFlows): edits that arrived later from another tab or a hook are kept.
import { mergeFlows } from './merge.js';

const SERVER_STEP = ['memory', 'lastRun', 'pinned', 'chatSessionId', 'chatContextHash'];
const SERVER_FLOW = ['memory', 'globalSessionId', 'globalContextHash', 'updatedAt', 'createdAt', 'rev', 'id'];
export const HISTORY_LIMIT = 100;
export const HISTORY_COALESCE_MS = 1000;

/** The editable definition of a flow (no run state). */
export function definition(f) {
  const out = { ...f, steps: (f.steps || []).map((s) => { const c = { ...s }; for (const k of SERVER_STEP) delete c[k]; return c; }), edges: [...(f.edges || [])] };
  for (const k of SERVER_FLOW) delete out[k];
  return out;
}

/** Applies the change from → to onto current, keeping run state and later edits of current. */
export function applyChange(current, from, to) {
  const { merged } = mergeFlows(from, definition(current), to);
  const cur = new Map(current.steps.map((s) => [s.id, s]));
  const out = { ...merged };
  for (const k of SERVER_FLOW) if (current[k] !== undefined) out[k] = current[k];
  out.steps = merged.steps.map((s) => { const c = cur.get(s.id); const extra = {}; if (c) for (const k of SERVER_STEP) if (c[k] !== undefined) extra[k] = c[k]; return { ...s, ...extra }; });
  return out;
}

export function createHistory() {
  const h = { past: [], future: [] };
  return {
    record(before, after) {
      const b = definition(before); const a = definition(after);
      if (JSON.stringify(b) === JSON.stringify(a)) return;
      const last = h.past[h.past.length - 1];
      if (last && Date.now() - last.at < HISTORY_COALESCE_MS) { last.after = a; last.at = Date.now(); }
      else { h.past.push({ before: b, after: a, at: Date.now() }); if (h.past.length > HISTORY_LIMIT) h.past.shift(); }
      h.future = [];
    },
    undo(current) { const e = h.past.pop(); if (!e) return null; h.future.push({ ...e, at: 0 }); return applyChange(current, e.after, e.before); },
    redo(current) { const e = h.future.pop(); if (!e) return null; h.past.push({ ...e, at: 0 }); return applyChange(current, e.before, e.after); },
    clear() { h.past = []; h.future = []; },
    get canUndo() { return h.past.length > 0; },
    get canRedo() { return h.future.length > 0; },
  };
}
