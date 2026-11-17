// "Necesita atención" (spec 27): what is waiting for a person, across ALL flows, computed on the server so it is seen
// even with another flow open, survives a reload and also drives the desktop notifications.
// Kinds: break (a run paused for review), run_failed (the latest finished run of a flow failed), quarantine (imported
// flow under review), blocked (the flow cannot start: a missing credential, or a requirement from the cached preflight),
// review (spec 28: the flow review found problems that will make it fail, or has proposals waiting).
// NAVIGATION ONLY (D48): items point to the place; nothing here resumes, applies or trusts anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import { credentialChecks } from './credentials.js';

const FILE = () => path.join(store.DATA, 'attention.json');
const FAIL_WINDOW_MS = Number(process.env.AFS_FAIL_WINDOW_SEC) > 0 ? Number(process.env.AFS_FAIL_WINDOW_SEC) * 1000 : 72 * 3600e3;
const FAILED = new Set(['error', 'timeout', 'interrupted']);
const CAUSE = {
  MCP_UNAVAILABLE: 'Claude Code no cargó un conector (MCP) que usa este step.',
  CREDENTIAL_MISSING: 'El step usa una credencial que no está cargada o le falta un campo.',
  PERMISSION_DENIED: 'El step intentó usar una herramienta que no tiene permitida.',
  TIMEOUT: 'El step superó su tiempo máximo.',
  DEADLINE: 'La ejecución superó su tiempo máximo.',
  INTERRUPTED: 'El servidor se reinició durante la ejecución.',
  EMPTY_OUTPUT: 'El step terminó sin producir salida.',
  INVALID_JSON: 'El step no devolvió el JSON esperado.',
  INVALID_SCHEMA: 'La salida JSON no cumple el schema.',
  ASSERTION_FAILED: 'Una verificación de la salida no pasó.',
  CLI_ERROR: 'Claude Code devolvió un error.',
};
const clip = (s, n) => { const t = String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const firstLine = (s) => String(s || '').split(/\r?\n/).find((l) => l.trim()) || '';

let deps = null; // { pausedRuns, emit }
const items = new Map(); // flowId -> item[]
let state = { dismissed: {}, notified: {}, lastNotifyAt: {} };
// Latest relevant failure per flow, kept in memory (adversarial review: never rescan run files on every event).
// Fed by run.finished (one file read per finished run); built from disk only once at boot.
const failures = new Map(); // flowId -> {runId, status, code, stepId, endedAt, trigger, error, interruptedAtBreak}
// A failure cleared by a real success (not by the 72 h window): the removed item says so, so notify can tell "volvió a funcionar" truthfully.
const recoveries = new Map(); // flowId -> {runId, trigger}
const timers = new Map();
const listeners = new Set(); // (added, removed, flowId) => void   (notify.js)

function load() { try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch {} }
export function save() {
  try { const tmp = `${FILE()}.tmp`; fs.mkdirSync(store.DATA, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, FILE()); } catch (e) { console.error('attention: no se pudo guardar', e.message); }
}
export const getState = () => state;

/** The items of one flow, from what is on disk + the live paused runs. Cheap: no network, no Claude. */
function compute(flowId, cachedPreflight) {
  const flow = store.getFlow(flowId);
  if (!flow) return [];
  const out = [];
  const base = { flowId, flowName: flow.name };
  const stepName = (id) => flow.steps.find((s) => s.id === id)?.name || id;
  // breaks waiting (any trigger: UI, chat, external with breakpoints)
  for (const r of deps.pausedRuns().filter((x) => x.flowId === flowId)) {
    for (const p of r.pauses) {
      out.push({ ...base, id: `break:${r.runId}:${p.stepId}`, kind: 'break', severity: 'action', runId: r.runId, stepId: p.stepId, stepName: p.step || stepName(p.stepId), trigger: r.trigger,
        title: 'Break esperando revisión', detail: `La ejecución está pausada hasta que revises ${p.when === 'before' ? 'lo que va a recibir' : 'la salida'} del step.`,
        createdAt: p.at, stateKey: `${p.when}:${p.at}`, target: { flowId, open: 'review', runId: r.runId, stepId: p.stepId } });
    }
  }
  // the latest relevant run failed (72 h) and no complete run succeeded after it
  const fl = failures.get(flowId);
  if (fl && Date.now() - fl.endedAt < FAIL_WINDOW_MS) {
    const code = fl.code;
    const cause = fl.interruptedAtBreak ? `El servidor se reinició mientras «${fl.interruptedAtBreak}» esperaba revisión.` : CAUSE[code] || clip(firstLine(fl.error), 140) || 'La ejecución terminó con error.';
    const open = code === 'MCP_UNAVAILABLE' ? { open: 'settings', tab: 'cli' } : code === 'CREDENTIAL_MISSING' ? { open: 'settings', tab: 'credentials' } : { open: 'run', runId: fl.runId };
    out.push({ ...base, id: `fail:${flowId}`, kind: 'run_failed', severity: fl.status === 'interrupted' ? 'warn' : 'error', runId: fl.runId, stepId: fl.stepId, stepName: fl.stepId ? stepName(fl.stepId) : null, trigger: fl.trigger, code,
      title: code === 'INTERRUPTED' ? 'Ejecución interrumpida' : code === 'MCP_UNAVAILABLE' ? 'Falló: MCP no disponible' : code === 'CREDENTIAL_MISSING' ? 'Falló: falta una credencial' : 'Falló una ejecución',
      detail: clip(cause, 160), createdAt: fl.endedAt, stateKey: fl.runId, target: { flowId, runId: fl.runId, ...open } });
  }
  if (flow.quarantine) {
    out.push({ ...base, id: `quar:${flowId}`, kind: 'quarantine', severity: 'warn', title: 'Flujo importado en revisión',
      detail: 'Viene de otra máquina: revisa sus comandos y accesos antes de habilitarlo.', createdAt: flow.quarantine.since || Date.now(),
      stateKey: String(flow.quarantine.since || ''), target: { flowId, open: 'quarantine' } });
  }
  // blocked: credentials (local, cheap) + the requirements already checked (cache only: never probes the network)
  const credMissing = credentialChecks(flow).filter((c) => c.ok === false);
  const reqMissing = (cachedPreflight?.(flow)?.blocking || []).filter((b) => b.type !== 'credential');
  const labels = [...credMissing.map((c) => c.label), ...reqMissing.map((b) => b.label)];
  if (labels.length) {
    const credNames = [...new Set(credMissing.map((c) => c.id.replace(/^cred:/, '').split('.')[0]))];
    out.push({ ...base, id: `blocked:${flowId}`, kind: 'blocked', severity: 'error',
      title: credNames.length ? `Falta la credencial ${credNames.map((n) => `«${n}»`).join(', ')}` : `Falta un requisito: ${clip(reqMissing[0].label, 60)}`,
      detail: clip(`El flujo no puede arrancar hasta que ${credNames.length ? 'la cargues en Configuración › Credenciales' : 'lo resuelvas'}${labels.length > 1 ? ` (${labels.length} pendientes)` : ''}.`, 160),
      createdAt: Date.now(), stateKey: crypto.createHash('sha1').update([...labels].sort().join('|')).digest('hex').slice(0, 12),
      target: credNames.length ? { flowId, open: 'settings', tab: 'credentials', name: credNames[0] } : { flowId, open: 'preflight' } });
  }
  // spec 28: the flow review (blocking findings of the lint, or an AI review with open proposals)
  try { const rv = deps.reviewItem?.(flow); if (rv) out.push(rv); } catch (e) { console.error('attention review', e.message); }
  return out;
}

/** Applies one finished run to the failure memory. Relevant failures: full runs and non-manual single steps (schedule,
 *  API, chat) that ended in error/timeout/interrupted. Only a COMPLETE run that succeeds clears it; stopped runs and
 *  manual single-step tests change nothing. */
function track(flowId, r) {
  if (!r || r.status === 'stopped' || r.rehearsal || r.trigger === 'rehearsal') return; // a rehearsal (spec 28) is not news
  const fullRun = !r.only;
  if (FAILED.has(r.status) && (fullRun || !['manual', 'chat'].includes(r.trigger))) {
    const [stepId, st] = Object.entries(r.steps || {}).find(([, x]) => FAILED.has(x.status)) || [];
    failures.set(flowId, { runId: r.id, status: r.status, code: st?.code || (r.status === 'interrupted' ? 'INTERRUPTED' : r.status === 'timeout' ? 'DEADLINE' : null), stepId: stepId || null,
      endedAt: r.endedAt || r.startedAt || Date.now(), trigger: r.trigger, error: st?.error || r.error || '', interruptedAtBreak: r.interruptedAtBreak || null });
  } else if (r.status === 'success' && fullRun && failures.has(flowId)) { failures.delete(flowId); recoveries.set(flowId, { runId: r.id, trigger: r.trigger }); }
}

const SEV = { error: 0, action: 1, warn: 2 };
// spec 28: review.js computes the lint in the background and calls this when it has news
export const refreshFlow = (flowId) => refresh(flowId);
/** All items, worst first then oldest first, each with `dismissed`. */
export function list() {
  const all = [...items.values()].flat().map((i) => ({ ...i, dismissed: state.dismissed[i.id] === i.stateKey }));
  return all.sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (a.createdAt - b.createdAt)).slice(0, 100);
}

let cachedPf = null;
function recompute(flowId, { quiet = false } = {}) {
  const prev = items.get(flowId) || [];
  const before = new Map(prev.map((i) => [i.id, i.stateKey]));
  const now = compute(flowId, cachedPf);
  for (const i of now) { const p = prev.find((x) => x.id === i.id && x.stateKey === i.stateKey); if (p) i.createdAt = p.createdAt; } // same state keeps its age
  if (now.length) items.set(flowId, now); else items.delete(flowId);
  const added = now.filter((i) => before.get(i.id) !== i.stateKey && state.dismissed[i.id] !== i.stateKey);
  const rec = recoveries.get(flowId); recoveries.delete(flowId);
  const removed = prev.filter((i) => !now.some((n) => n.id === i.id)).map((i) => (i.kind === 'run_failed' && rec ? { ...i, recovered: rec } : i));
  const sig = (list) => list.map((i) => `${i.id}|${i.stateKey}|${i.title}|${i.detail}`).join('\n');
  const changed = added.length || removed.length || sig(prev) !== sig(now);
  // a dismissed item whose state changed is new again
  for (const i of now) if (state.dismissed[i.id] && state.dismissed[i.id] !== i.stateKey) delete state.dismissed[i.id];
  if (!quiet) {
    if (added.length || removed.length) for (const fn of listeners) { try { fn(added, removed, flowId); } catch (e) { console.error('attention listener', e.message); } }
    // only when something changed: flow.updated arrives on every lastRun change while any flow runs (adversarial review)
    if (changed) deps.emit({ type: 'attention.changed', items: list(), added: added.map((i) => i.id) });
  }
  return added;
}
/** Debounced: several events of one run (paused + saved + status) become one recompute. */
export function refresh(flowId) {
  clearTimeout(timers.get(flowId));
  timers.set(flowId, setTimeout(() => { timers.delete(flowId); try { recompute(flowId); } catch (e) { console.error('attention', e.message); } }, 200));
}
export function refreshAll() { for (const f of store.listFlows()) refresh(f.id); }
export function removeFlow(flowId) {
  items.delete(flowId); failures.delete(flowId);
  for (const k of Object.keys(state.dismissed)) if (k.endsWith(`:${flowId}`)) delete state.dismissed[k];
  save();
  deps.emit({ type: 'attention.changed', items: list(), added: [] });
}

export function dismiss(id, stateKey) {
  const it = [...items.values()].flat().find((i) => i.id === id);
  if (!it) throw Object.assign(new Error('Ese aviso ya no está pendiente'), { status: 404, code: 'ATTENTION_NOT_FOUND' });
  if (it.stateKey !== stateKey) throw Object.assign(new Error('El aviso cambió desde que lo viste: revísalo de nuevo'), { status: 409, code: 'ATTENTION_CHANGED' });
  state.dismissed[id] = stateKey; save();
  deps.emit({ type: 'attention.changed', items: list(), added: [] });
  return { id, dismissed: true };
}
export const onAdded = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/**
 * Boot: build everything from disk (after recoverStaleRuns) WITHOUT notifying, then follow the engine bus.
 * deps: { bus, pausedRuns, emit, cachedPreflight }
 */
export function init(d) {
  deps = d; cachedPf = d.cachedPreflight || null;
  load();
  recoveries.clear();
  for (const f of store.listFlows()) {
    const runs = store.listRuns(f.id).filter((r) => r.status !== 'running' && r.status !== 'paused').reverse(); // oldest → newest
    for (const r of runs) if (FAILED.has(r.status) || (r.status === 'success' && !r.only)) track(f.id, FAILED.has(r.status) ? store.getRun(f.id, r.id) : r);
  }
  recoveries.clear(); // what was resolved while the server was down is not news
  const live = new Set();
  for (const f of store.listFlows()) { recompute(f.id, { quiet: true }); for (const i of items.get(f.id) || []) live.add(i.id); }
  // everything present at boot counts as already notified (no toast storm after a restart); prune stale entries
  for (const i of [...items.values()].flat()) state.notified[i.id] = i.stateKey;
  for (const k of Object.keys(state.dismissed)) if (!live.has(k)) delete state.dismissed[k];
  // a failure that is no longer live (resolved while the server was down, or out of the window) is not "already told" any more
  for (const k of Object.keys(state.notified)) if (!live.has(k)) delete state.notified[k];
  save();
  d.bus.on('msg', (m) => {
    if (!m || m.type === 'attention.changed') return;
    if (m.type === 'run.finished' && m.flowId) { try { track(m.flowId, store.getRun(m.flowId, m.runId)); } catch {} refresh(m.flowId); }
    else if (['run.started', 'run.paused', 'run.resumed', 'flow.updated', 'preflight.checked'].includes(m.type) && m.flowId) refresh(m.flowId);
    else if (m.type === 'flow.deleted' && m.flowId) removeFlow(m.flowId);
    else if (m.type === 'flows.changed' || m.type === 'credentials.changed') refreshAll();
  });
}
