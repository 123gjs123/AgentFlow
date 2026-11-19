// JSON-file persistence: flows, chats, runs. Everything lives under ./data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.AFS_DATA || path.join(ROOT, 'data');
const dir = (...p) => { const d = path.join(DATA, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** For files that must never be silently reset (token, idempotency): missing → def; locked → retry; corrupt → throw. */
function readJsonStrict(f, def) {
  for (let n = 0; ; n++) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return def;
      if (BUSY.has(e.code) && n < 5) { sleepSync(100); continue; }
      throw Object.assign(new Error(`No se pudo leer ${path.basename(f)}: ${e.message}. Revisa el archivo en ${path.dirname(f)} (no se sobrescribe).`), { status: 500, code: 'DATA_FILE_ERROR' });
    }
  }
}
/** Atomic write; retries the rename while Windows (antivirus, backup) holds the target. */
const writeJson = (f, v) => {
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  for (let n = 0; ; n++) { try { fs.renameSync(tmp, f); return; } catch (e) { if (!BUSY.has(e.code) || n >= 5) throw e; sleepSync(100); } }
};
/** Path under DATA without creating directories (reads must not leave folders behind). */
const at = (...p) => path.join(DATA, ...p);
export const uid = (p = '') => p + crypto.randomUUID().slice(0, 8);
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

// ---------- flows ----------
export function listFlows() {
  return fs.readdirSync(dir('flows')).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(DATA, 'flows', f)))
    .filter(Boolean)
    .map((f) => ({ id: f.id, name: f.name, updatedAt: f.updatedAt, steps: f.steps.length }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export const getFlow = (id) => readJson(path.join(dir('flows'), `${safe(id)}.json`), null);
/** Resolve a flow by id, (case-insensitive) name or the slug of its name — used by external callers. */
export function findFlow(idOrName) {
  const byId = getFlow(idOrName);
  if (byId) return byId;
  const n = String(idOrName).trim().toLowerCase();
  const all = listFlows();
  const hit = all.find((f) => String(f.name ?? '').trim().toLowerCase() === n);
  if (hit) return getFlow(hit.id);
  const bySlug = all.filter((f) => slugify(f.name) === n);
  return bySlug.length === 1 ? getFlow(bySlug[0].id) : null; // two flows with the same slug: use the id or the name
}

// ---------- step slugs (spec 12 STEPINV-1) ----------
/** "Correr sanity (PPD)" → "correr-sanity-ppd". URL- and shell-safe, at most 60 chars. */
export const slugify = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
/** A slug for every step that has none (derived from its name, unique in the flow). Once given it never changes by itself. */
export function ensureSlugs(flow) {
  // an invalid or repeated slug (a hand-edited or imported file) is replaced; the first holder keeps it
  // a slug never equals the id of ANOTHER step (findStep resolves ids first: that step would run instead)
  const ids = new Set((flow.steps || []).map((s) => String(s.id).toLowerCase()));
  const used = new Set();
  for (const s of flow.steps || []) { if (typeof s.slug === 'string' && SLUG_RE.test(s.slug) && !used.has(s.slug) && (!ids.has(s.slug) || String(s.id).toLowerCase() === s.slug)) used.add(s.slug); else Reflect.deleteProperty(s, 'slug'); }
  for (const s of flow.steps || []) {
    if (s.slug) continue;
    const base = slugify(s.name) || 'step';
    let x = base; for (let i = 2; used.has(x) || (ids.has(x) && String(s.id).toLowerCase() !== x); i++) x = `${base.slice(0, 55)}-${i}`;
    used.add(x); s.slug = x;
  }
  return flow;
}
/**
 * A step by id, slug or (case-insensitive) name. Returns {step} or {error, status, code}: a name shared by two steps
 * is ambiguous (use the slug or the id).
 */
export function findStep(flow, ref, { slugWins = false } = {}) {
  const r = String(ref ?? '').trim();
  if (!r) return { status: 400, code: 'STEP_REQUIRED', error: 'Falta el step' };
  const steps = flow.steps || [];
  const byId = steps.find((s) => s.id === r);
  if (byId) return { step: byId };
  // a stored slug is the step's stable address: it wins (renaming/adding OTHER steps never breaks a pasted call)
  const hit = steps.find((s) => s.slug && s.slug === r);
  if (hit) {
    const other = slugWins ? null : steps.find((s) => s !== hit && String(s.name ?? '').trim().toLowerCase() === r.toLowerCase());
    if (other) return { status: 409, code: 'STEP_AMBIGUOUS', error: `«${r}» es el slug de «${hit.name}» y el nombre de «${other.name}»: usa el id (${hit.id} o ${other.id}) o la URL …/steps/${r}/run (el slug)` };
    return { step: hit };
  }
  const exact = steps.filter((s) => String(s.name ?? '').trim() === r);
  if (exact.length === 1) return { step: exact[0] };
  const byName = steps.filter((s) => String(s.name ?? '').trim().toLowerCase() === r.toLowerCase());
  if (byName.length === 1) return { step: byName[0] };
  if (byName.length > 1) return { status: 409, code: 'STEP_AMBIGUOUS', error: `Hay ${byName.length} steps llamados «${r}»: usa su slug (${byName.map((s) => s.slug || s.id).join(', ')}) o su id` };
  const bySlug = steps.filter((s) => !s.slug && slugify(s.name) === r.toLowerCase());
  if (bySlug.length === 1) return { step: bySlug[0] };
  return { status: 404, code: 'STEP_NOT_FOUND', error: `Step no encontrado: ${r}` };
}

// ---------- config (external API token) ----------
export function getConfig() {
  const f = path.join(dir(), 'config.json');
  let c = readJsonStrict(f, null); // a locked or corrupt file must not rotate the token everyone uses
  if (!c?.token || !c?.uiKey) {
    c = { ...(c || {}), token: c?.token || crypto.randomBytes(24).toString('base64url'), uiKey: c?.uiKey || crypto.randomBytes(24).toString('base64url') };
    writeJson(f, c);
  }
  return c;
}
export function setConfig(patch) {
  const c = { ...getConfig(), ...patch };
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  writeJson(path.join(dir(), 'config.json'), c);
  return c;
}
export function rotateToken() {
  const c = { ...getConfig(), token: crypto.randomBytes(24).toString('base64url') };
  writeJson(path.join(dir(), 'config.json'), c);
  return c;
}
export function saveFlow(flow) {
  flow.updatedAt = Date.now();
  ensureSlugs(flow);
  writeJson(path.join(dir('flows'), `${safe(flow.id)}.json`), flow);
  return flow;
}
/** Read-modify-write so engine updates never clobber concurrent UI edits. */
export function updateFlow(id, fn) {
  const f = getFlow(id);
  if (!f) return null;
  fn(f);
  return saveFlow(f);
}
export function deleteFlow(id) {
  fs.rmSync(path.join(dir('flows'), `${safe(id)}.json`), { force: true });
  fs.rmSync(path.join(DATA, 'chats', safe(id)), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'runs', safe(id)), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'versions', safe(id)), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'reviews', safe(id)), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'watch', `${safe(id)}.json`), { force: true });
  fs.rmSync(path.join(DATA, 'outputs', safe(id)), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'actions', `${safe(id)}.json`), { force: true });
  fs.rmSync(path.join(DATA, 'approvals', `${safe(id)}.json`), { force: true });
  fs.rmSync(path.join(DATA, 'copies', `${safe(id)}.json`), { force: true });
  fs.rmSync(path.join(DATA, 'invoke', `${safe(id)}.md`), { force: true });
}

// ---------- flow reviews (spec 28) ----------
const reviewFile = (flowId, id) => path.join(dir('reviews', safe(flowId)), `${safe(id)}.json`);
export const saveReview = (rv) => writeJson(reviewFile(rv.flowId, rv.id), rv);
export const getReview = (flowId, id) => readJson(at('reviews', safe(flowId), `${safe(id)}.json`), null);
/** Newest first; only metadata (findings stay in the file). */
export function listReviews(flowId) {
  let files = [];
  try { files = fs.readdirSync(at('reviews', safe(flowId))).filter((f) => /^rv_.*\.json$/.test(f)); } catch { return []; }
  return files.map((f) => readJson(at('reviews', safe(flowId), f), null)).filter(Boolean)
    .map(({ id, status, startedAt, endedAt, flowHash, error, findings, totals }) => ({ id, status, startedAt, endedAt, flowHash, error, findings: (findings || []).length, totals }))
    .sort((a, b) => b.startedAt - a.startedAt);
}
/** Findings the person dismissed: {fp: {anchor, reason, at}} (a dismissed finding stays hidden while its anchor holds). */
// spec 10: 🔔 news of the watched sources (snapshots, pending changes) per flow
export const getWatch = (flowId) => readJson(at('watch', `${safe(flowId)}.json`), {});
export const saveWatch = (flowId, v) => writeJson(path.join(dir('watch'), `${safe(flowId)}.json`), v);
export const getSuppressed = (flowId) => readJson(at('reviews', safe(flowId), 'suppressed.json'), {});
export const setSuppressed = (flowId, map) => writeJson(path.join(dir('reviews', safe(flowId)), 'suppressed.json'), map);

export function newStep(partial = {}) {
  return {
    id: uid('s_'),
    name: 'Nuevo step',
    kind: 'role', // role | agent | skill | command
    role: '',
    agentRef: '',
    skillRef: '',
    command: '',
    shell: 'powershell',
    task: '',
    context: '',
    model: '',
    effort: '',
    permissionMode: '',
    allowedTools: 'Read Grep Glob WebFetch WebSearch Skill',
    hooks: '',
    output: { format: 'text', schema: '' },
    input: { mode: 'full', maxChars: 12000 },
    position: { x: 0, y: 0 },
    memory: [],
    chatSessionId: null,
    lastRun: null,
    ...partial,
  };
}

export function newFlow(name = 'Nuevo flujo') {
  return {
    id: uid('f_'),
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'Nuevo flujo',
    description: '',
    cwd: '',
    vars: {},
    schedule: { enabled: false, everyMinutes: 60, input: '' },
    steps: [],
    edges: [],
    memory: [],
    globalSessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- chats ----------
const chatFile = (flowId, key) => path.join(dir('chats', safe(flowId)), `${safe(key)}.json`);
export const getChat = (flowId, key) => readJson(at('chats', safe(flowId), `${safe(key)}.json`), []);
export function appendChat(flowId, key, msg) {
  const list = getChat(flowId, key);
  list.push(msg);
  writeJson(chatFile(flowId, key), list.slice(-300));
  return msg;
}
export function updateChatMsg(flowId, key, id, fn) {
  const list = getChat(flowId, key);
  const m = list.find((x) => x.id === id);
  if (m) { fn(m); writeJson(chatFile(flowId, key), list); }
  return m;
}
/** Replaces a whole chat (import). */
export const saveChat = (flowId, key, list) => writeJson(chatFile(flowId, key), (Array.isArray(list) ? list : []).slice(-300));
export const clearChat = (flowId, key) => fs.rmSync(at('chats', safe(flowId), `${safe(key)}.json`), { force: true });
export const clearAllChats = (flowId) => fs.rmSync(path.join(DATA, 'chats', safe(flowId)), { recursive: true, force: true });

// ---------- runs ----------
const runFile = (flowId, runId) => path.join(dir('runs', safe(flowId)), `${safe(runId)}.json`);
export const saveRun = (run) => writeJson(runFile(run.flowId, run.id), run);
export const clearRuns = (flowId) => { for (const d of ['runs', 'outputs']) fs.rmSync(path.join(DATA, d, safe(flowId)), { recursive: true, force: true }); fs.rmSync(path.join(DATA, 'approvals', `${safe(flowId)}.json`), { force: true }); };
export const countRuns = (flowId) => { try { return fs.readdirSync(path.join(DATA, 'runs', safe(flowId))).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const countChats = (flowId) => { try { return fs.readdirSync(path.join(DATA, 'chats', safe(flowId))).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const getRun = (flowId, runId) => readJson(at('runs', safe(flowId), `${safe(runId)}.json`), null);
/** Full run records of a flow (for startup recovery). */
export function rawRuns(flowId) {
  try { return fs.readdirSync(path.join(DATA, 'runs', safe(flowId))).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(DATA, 'runs', safe(flowId), f))).filter(Boolean); } catch { return []; }
}

// ---------- idempotency keys (external runs, 24 h) ----------
const idemFile = () => path.join(dir(), 'idempotency.json');
export function getIdem(key) {
  const all = readJsonStrict(idemFile(), {});
  const e = all[key];
  return e && e.at > Date.now() - 24 * 3600e3 ? e : null;
}
export function setIdem(key, entry) {
  const all = readJsonStrict(idemFile(), {}); // a failed read must not erase every other key
  const cut = Date.now() - 24 * 3600e3;
  for (const k of Object.keys(all)) if (all[k].at < cut) delete all[k];
  all[key] = { ...entry, at: Date.now() };
  writeJson(idemFile(), all);
}
// Run summaries cached by file mtime+size: a run file (up to ~1 MB) is parsed again only when it changed (spec 28:
// the review and the attention list ask for the list often).
const runMeta = new Map(); // path -> {mtimeMs, size, meta}
export function listRuns(flowId) {
  let files = [];
  const d = at('runs', safe(flowId));
  try { files = fs.readdirSync(d); } catch { return []; }
  const out = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    const p = path.join(d, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    const hit = runMeta.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { out.push(hit.meta); continue; }
    const r = readJson(p, null);
    if (!r) continue;
    const meta = { id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, trigger: r.trigger, input: String(r.input ?? '').slice(0, 200), only: r.only, from: r.from, totals: r.totals };
    runMeta.set(p, { mtimeMs: st.mtimeMs, size: st.size, meta });
    out.push(meta);
  }
  if (runMeta.size > 5000) runMeta.clear();
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
}

// ---------- step library (spec 18: reusable boxes across flows) ----------
const LIB = () => path.join(dir(), 'library.json');
/** Run/session state never travels with a saved box. */
const portable = ({ id, lastRun, memory, pinned, chatSessionId, chatContextHash, position, ...s }) => s;
export const listLibrary = () => readJson(LIB(), []);
export function saveToLibrary(step, name) {
  const item = { id: uid('l_'), name: String(name || step.name || 'Step').slice(0, 120), kind: step.kind, savedAt: Date.now(), step: portable(step) };
  writeJson(LIB(), [...listLibrary(), item]);
  return item;
}
export function deleteFromLibrary(id) { writeJson(LIB(), listLibrary().filter((x) => x.id !== id)); }

// ---------- versions (spec 20): snapshots of a flow's definition ----------
// Only the definition travels (no run state, memory or chat sessions). Automatic ones are pruned; named ones are kept.
const verDir = (flowId) => dir('versions', safe(flowId));
const definitionOf = (f) => ({
  name: f.name, description: f.description, cwd: f.cwd, vars: f.vars, schedule: f.schedule, runTimeoutSec: f.runTimeoutSec, versionEveryMin: f.versionEveryMin, contextSources: f.contextSources, finally: f.finally, requirements: f.requirements, policies: f.policies,
  steps: (f.steps || []).map(({ lastRun, memory, pinned, chatSessionId, chatContextHash, ...s }) => s),
  edges: f.edges || [],
});
export const definitionHash = (f) => crypto.createHash('sha256').update(JSON.stringify(definitionOf(f))).digest('hex');
export function listVersions(flowId) {
  let files = [];
  try { files = fs.readdirSync(at('versions', safe(flowId))).filter((x) => x.endsWith('.json')); } catch { return []; }
  return files.map((x) => readJson(at('versions', safe(flowId), x), null)).filter(Boolean)
    .map(({ flow, ...meta }) => ({ ...meta, steps: flow?.steps?.length || 0, edges: flow?.edges?.length || 0 }))
    .sort((a, b) => b.at - a.at);
}
export const getVersion = (flowId, id) => readJson(at('versions', safe(flowId), `${safe(id)}.json`), null);
export function saveVersion(flow, { label = '', auto = false } = {}) {
  const v = { id: uid('v_'), at: Date.now(), label: String(label || '').slice(0, 120), auto: !!auto, rev: flow.rev || 0, hash: definitionHash(flow), flow: definitionOf(flow) };
  writeJson(path.join(verDir(flow.id), `${v.id}.json`), v);
  // keep the last 30 automatic versions (named ones are never pruned)
  const autos = listVersions(flow.id).filter((x) => x.auto);
  for (const old of autos.slice(30)) fs.rmSync(at('versions', safe(flow.id), `${safe(old.id)}.json`), { force: true });
  const { flow: _f, ...meta } = v;
  return meta;
}
export const deleteVersion = (flowId, id) => fs.rmSync(at('versions', safe(flowId), `${safe(id)}.json`), { force: true });
export const clearVersions = (flowId) => fs.rmSync(at('versions', safe(flowId)), { recursive: true, force: true });
