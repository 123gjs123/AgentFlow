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
/** Resolve a flow by id or (case-insensitive) name — used by external callers. */
export function findFlow(idOrName) {
  const byId = getFlow(idOrName);
  if (byId) return byId;
  const n = String(idOrName).trim().toLowerCase();
  const hit = listFlows().find((f) => String(f.name ?? '').trim().toLowerCase() === n);
  return hit ? getFlow(hit.id) : null;
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
}

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
export const clearChat = (flowId, key) => fs.rmSync(at('chats', safe(flowId), `${safe(key)}.json`), { force: true });
export const clearAllChats = (flowId) => fs.rmSync(path.join(DATA, 'chats', safe(flowId)), { recursive: true, force: true });

// ---------- runs ----------
const runFile = (flowId, runId) => path.join(dir('runs', safe(flowId)), `${safe(runId)}.json`);
export const saveRun = (run) => writeJson(runFile(run.flowId, run.id), run);
export const clearRuns = (flowId) => fs.rmSync(path.join(DATA, 'runs', safe(flowId)), { recursive: true, force: true });
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
export function listRuns(flowId) {
  let files = [];
  try { files = fs.readdirSync(at('runs', safe(flowId))); } catch { return []; }
  return files.filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(DATA, 'runs', safe(flowId), f)))
    .filter(Boolean)
    .map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, trigger: r.trigger, input: String(r.input ?? '').slice(0, 200), only: r.only, totals: r.totals }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50);
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
  name: f.name, description: f.description, cwd: f.cwd, vars: f.vars, schedule: f.schedule, runTimeoutSec: f.runTimeoutSec, versionEveryMin: f.versionEveryMin, contextSources: f.contextSources, finally: f.finally, requirements: f.requirements,
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
