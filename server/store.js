// JSON-file persistence: flows, chats, runs. Everything lives under ./data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.AFS_DATA || path.join(ROOT, 'data');
const dir = (...p) => { const d = path.join(DATA, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); };
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
  const hit = listFlows().find((f) => f.name.trim().toLowerCase() === n);
  return hit ? getFlow(hit.id) : null;
}

// ---------- config (external API token) ----------
export function getConfig() {
  const f = path.join(dir(), 'config.json');
  let c = readJson(f, null);
  if (!c?.token) { c = { ...(c || {}), token: crypto.randomBytes(24).toString('base64url') }; writeJson(f, c); }
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
    name,
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
export const getChat = (flowId, key) => readJson(chatFile(flowId, key), []);
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
export const clearChat = (flowId, key) => fs.rmSync(chatFile(flowId, key), { force: true });
export const clearAllChats = (flowId) => fs.rmSync(path.join(DATA, 'chats', safe(flowId)), { recursive: true, force: true });

// ---------- runs ----------
const runFile = (flowId, runId) => path.join(dir('runs', safe(flowId)), `${safe(runId)}.json`);
export const saveRun = (run) => writeJson(runFile(run.flowId, run.id), run);
export const clearRuns = (flowId) => fs.rmSync(path.join(DATA, 'runs', safe(flowId)), { recursive: true, force: true });
export const countRuns = (flowId) => { try { return fs.readdirSync(path.join(DATA, 'runs', safe(flowId))).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const countChats = (flowId) => { try { return fs.readdirSync(path.join(DATA, 'chats', safe(flowId))).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const getRun = (flowId, runId) => readJson(runFile(flowId, runId), null);
export function listRuns(flowId) {
  return fs.readdirSync(dir('runs', safe(flowId))).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(DATA, 'runs', safe(flowId), f)))
    .filter(Boolean)
    .map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, trigger: r.trigger, input: (r.input || '').slice(0, 200), only: r.only }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50);
}
