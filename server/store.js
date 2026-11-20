// JSON-file persistence: flows, chats, runs. Everything lives under ./data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { migrateLayout } from './migrate.js';

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
const writeText = (f, text) => {
  const tmp = `${f}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx' }); // exclusive: never follows a planted tmp link
  for (let n = 0; ; n++) { try { fs.renameSync(tmp, f); return; } catch (e) { if (!BUSY.has(e.code) || n >= 5) { fs.rmSync(tmp, { force: true }); throw e; } sleepSync(100); } }
};
const writeJson = (f, v) => writeText(f, JSON.stringify(v, null, 2));
/** Path under DATA without creating directories (reads must not leave folders behind). */
const at = (...p) => path.join(DATA, ...p);
export const uid = (p = '') => p + crypto.randomUUID().slice(0, 8);
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

// ---------- spec 09: one folder per flow ----------
// <DATA>/flows/<slug>--<id>/: flow.json (portable definition: what you would put in git), state.json (machine state:
// sessions, last runs, pins, memory, secret var values), chats/, runs/, versions/, reviews/, outputs/, sources.json,
// actions.json, approvals.json, copies.json, INVOKE.md. The flow's WORKING folder stays outside DATA (spec 11).
export const FLOWS_ROOT = () => path.join(DATA, 'flows');
export const FLOW_FILE_FORMAT = 'agent-flow-studio/flow';
export const SECRET_NAME = /(token|secret|password|passwd|pwd|apikey|api_key|credential|private|auth|bearer|cookie|session)|(^|[_-])(key|pat)$/i;
/** Machine-bound fields (state.json); everything else is the portable definition (flow.json). */
export const STATE_FLOW = ['rev', 'createdAt', 'updatedAt', 'workspace', 'quarantine', 'trust', 'lastDefHash', 'globalSessionId', 'globalContextHash', 'reviewSessionId', 'reviewContextHash', 'chatParticipants', 'memory', 'linkedPath'];
export const STATE_STEP = ['lastRun', 'chatSessionId', 'chatContextHash', 'pinned', 'memory'];
export function splitFlow(flow) {
  const def = { format: FLOW_FILE_FORMAT, formatVersion: 1 }; const state = { steps: {} };
  for (const [k, v] of Object.entries(flow || {})) {
    if (k === 'format' || k === 'formatVersion') continue;
    if (STATE_FLOW.includes(k)) { if (v !== undefined) state[k] = v; continue; }
    if (k === 'steps' && Array.isArray(v)) {
      def.steps = v.map((s) => { const d = {}; const st = {}; for (const [sk, sv] of Object.entries(s || {})) (STATE_STEP.includes(sk) ? st : d)[sk] = sv; if (s?.id && Object.keys(st).length) state.steps[s.id] = st; return d; });
    } else if (k === 'schedule' && v && typeof v === 'object') { const { enabled, ...rest } = v; def.schedule = rest; state.scheduleEnabled = !!enabled; }
    else if (k === 'watchPolling' && v && typeof v === 'object') { const { enabled, ...rest } = v; def.watchPolling = rest; state.watchEnabled = !!enabled; }
    else if (k === 'vars' && v && typeof v === 'object' && !Array.isArray(v)) {
      def.vars = {};
      for (const [vk, vv] of Object.entries(v)) { if (SECRET_NAME.test(vk) && vv) { def.vars[vk] = ''; (state.secretVars ||= {})[vk] = vv; } else def.vars[vk] = vv; }
    } else def[k] = v;
  }
  return { def, state };
}
export function mergeFlow(def, state) {
  const st = state && typeof state === 'object' ? state : {};
  const { format, formatVersion, ...f } = def;
  // machine fields come ONLY from state.json: a flow.json (a repo anyone commits to) never brings its own trust,
  // quarantine, sessions or memory
  for (const k of STATE_FLOW) { delete f[k]; if (st[k] !== undefined) f[k] = st[k]; }
  if (f.memory === undefined) f.memory = [];
  if (f.schedule && typeof f.schedule === 'object') f.schedule = { ...f.schedule, enabled: !!st.scheduleEnabled };
  if (f.watchPolling && typeof f.watchPolling === 'object') f.watchPolling = { ...f.watchPolling, enabled: !!st.watchEnabled };
  if (st.secretVars && f.vars && typeof f.vars === 'object') for (const [k, v] of Object.entries(st.secretVars)) if (Object.hasOwn(f.vars, k) && f.vars[k] === '') f.vars[k] = v;
  f.steps = (Array.isArray(f.steps) ? f.steps : []).map((s) => {
    const clean = { ...(s && typeof s === 'object' ? s : {}) }; for (const k of STATE_STEP) delete clean[k];
    return { memory: [], lastRun: null, chatSessionId: null, ...clean, ...((s && st.steps?.[s.id]) || {}) };
  });
  return f;
}
// id → folder name, rebuilt when the flows folder changes (its mtime moves on every add, remove or rename)
let layoutReady = false; let idx = null; let idxStamp = null;
function flowIndex() {
  if (!layoutReady) ensureLayout();
  const root = FLOWS_ROOT();
  let st; try { st = fs.statSync(root); } catch { fs.mkdirSync(root, { recursive: true }); st = fs.statSync(root); }
  if (idx && idxStamp === st.mtimeMs) return idx;
  const m = new Map();
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory() || /^[._]/.test(e.name)) continue;
    const i = e.name.indexOf('--'); if (i < 1) continue; // slugify never makes "--": the id is what follows the first one
    const id = e.name.slice(i + 2);
    if (m.has(id)) { console.warn(`Dos carpetas para el flujo ${id}: se usa ${m.get(id)}, se ignora ${e.name}`); continue; }
    m.set(id, e.name);
  }
  idx = m; idxStamp = st.mtimeMs; return m;
}
const folderOf = (id) => flowIndex().get(safe(id)) || null;
/** The flow's folder (nothing is created). A flow with no folder yet gets the path its folder would have. */
export const flowDir = (id) => path.join(FLOWS_ROOT(), folderOf(id) || `flujo--${safe(id)}`);
export const flowFile = (id, ...p) => path.join(flowDir(id), ...p);
const flowSub = (id, ...p) => { const d = flowFile(id, ...p); if (fs.mkdirSync(d, { recursive: true })) idx = null; return d; };
function ensureFlowDir(id, name) {
  if (folderOf(id)) return;
  fs.mkdirSync(path.join(FLOWS_ROOT(), `${slugify(name) || 'flujo'}--${safe(id)}`), { recursive: true }); idx = null;
}
/** Spec 09 WS-2: migrate the old layout once (crash-safe, keeps a backup), then tidy folder names. Called at startup. */
export function ensureLayout({ log = console.log } = {}) {
  if (layoutReady) return;
  layoutReady = true;
  try { migrateLayout(DATA, { splitFlow, slugify, log }); } catch (e) { layoutReady = false; throw e; }
  tidyFolders(log);
}
/** A renamed flow gets its folder renamed at the next start (never while running: open files would block it). */
function tidyFolders(log) {
  let names = []; try { names = fs.readdirSync(FLOWS_ROOT(), { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name); } catch { return; }
  const seen = new Set();
  for (const n of names) {
    const i = n.indexOf('--'); if (i < 1) continue;
    const id = n.slice(i + 2); if (seen.has(id)) continue; seen.add(id);
    const def = readJson(path.join(FLOWS_ROOT(), n, 'flow.json'), null);
    if (!def?.name) continue;
    const want = `${slugify(def.name) || 'flujo'}--${id}`;
    if (want === n || fs.existsSync(path.join(FLOWS_ROOT(), want))) continue;
    try { fs.renameSync(path.join(FLOWS_ROOT(), n), path.join(FLOWS_ROOT(), want)); idx = null; } catch (e) { log(`No se pudo renombrar la carpeta ${n} (${e.code || e.message}): se reintenta al próximo inicio.`); }
  }
}

// ---------- flows ----------
/** Every flow: its own (origin 'local') and linked ones (origin 'linked'; an unavailable one is listed, never dropped). */
export function listFlows({ all = false } = {}) {
  const links = linkedFlows(); const linked = new Set(links.map((l) => l.id));
  const out = [];
  for (const id of flowIndex().keys()) { if (linked.has(id)) continue; const f = getFlow(id); if (f) out.push({ id: f.id, name: f.name, updatedAt: f.updatedAt, steps: f.steps.length, origin: 'local' }); }
  for (const l of links) {
    let f = null; try { f = getFlow(l.id); } catch (e) { setLinkStatus(l.id, 'invalid', e.message); }
    const st = linkState(l.id);
    if (f) out.push({ id: f.id, name: f.name, updatedAt: f.updatedAt, steps: f.steps.length, origin: 'linked', path: l.path, available: true });
    else if (all) out.push({ id: l.id, name: l.name, updatedAt: 0, steps: 0, origin: 'linked', path: l.path, available: false, status: st.status, error: st.error });
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
// ---------- spec 09 WS-8: flows linked from an outside folder (e.g. a git repo) ----------
// Only flow.json (and, on request, README.md) live there. State, chats, runs, versions… stay in DATA (<slug>--<id>/),
// so a git diff shows definition changes only and never sessions, memory or secret values. Trust lives in DATA: an
// outside edit that changes what executes puts the flow back in quarantine (WS-7) until the person reviews it.
const LINK_MAX_BYTES = 5 * 1024 * 1024;
const linkHooks = { sanitize: (f) => f, executableParts: () => [], onExternalChange: () => {}, onLinkStatus: () => {} };
export const setLinkHooks = (h) => Object.assign(linkHooks, h);
export const linkedFlows = () => { const l = getConfig().linkedFlows; return Array.isArray(l) ? l.filter((x) => x && typeof x.id === 'string' && typeof x.path === 'string') : []; };
export const linkOf = (id) => linkedFlows().find((l) => l.id === safe(id)) || null;
const linkStatus = new Map(); // id -> {status: 'available'|'unavailable'|'invalid'|'forbidden', error}
export const linkState = (id) => linkStatus.get(id) || { status: 'available' };
function setLinkStatus(id, status, error = null) {
  const prev = linkStatus.get(id)?.status || 'available';
  linkStatus.set(id, { status, error });
  if (prev !== status) try { linkHooks.onLinkStatus(id, status, prev); } catch (e) { console.error('[link]', e.message); }
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
/** What decides what a flow executes: everything except labels and positions (commands in full, hooks, tools, cwd, vars, tasks). */
export function execFingerprint(flow) {
  const { def } = splitFlow(ensureSlugs(structuredClone(flow)));
  const { name, description, versionEveryMin, format, formatVersion, id, ...rest } = def;
  rest.steps = (rest.steps || []).map(({ position, ...s }) => s);
  rest.edges = (rest.edges || []).map(({ sourceHandle, targetHandle, ...e }) => e);
  return sha(JSON.stringify(stable(rest)));
}
// F1: a flow is "inert" when every step is a role or a skill with read-only built-in tools and default permissions,
// no hooks, no "Al terminar", no checks that run commands. Any other flow changed from outside goes to review.
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite']); // no WebFetch/WebSearch: with Read they can carry data out
export function inertFlow(f) {
  if (f.finally || (f.requirements || []).some((r) => r && (r.check || r.command))) return false;
  if ((f.contextSources || []).length || (f.steps || []).some((s) => (s.contextSources || []).length)) return false; // folders/files handed to Claude
  return (f.steps || []).every((s) => {
    const tools = String(s.allowedTools ?? '').split(/[\s,]+/).filter(Boolean);
    return (s.kind === 'role' || s.kind === 'skill') && !s.hooks && (!s.permissionMode || ['default', 'plan'].includes(s.permissionMode))
      && tools.length > 0 && tools.every((x) => READ_ONLY_TOOLS.has(x)) && !(s.assertions || []).some((a) => a?.type === 'command' || a?.command);
  });
}
// F2: Claude in a custom working folder also reads that folder's own configuration (hooks, permissions, MCP servers,
// agents, CLAUDE.md). For a linked flow it is part of what was reviewed: a change there sends the flow back to review.
const CFG_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const CFG_DIRS = ['.claude/agents', '.claude/skills', '.claude/commands', '.claude/hooks'];
export function cwdConfigHash(flow) {
  if (!flow?.cwd) return null;
  const h = crypto.createHash('sha256'); let n = 0;
  const add = (p, rel) => { try { const st = fs.lstatSync(p); if (st.isSymbolicLink()) { h.update(`L:${rel}:${fs.readlinkSync(p)}`); try { const t = fs.statSync(p); if (t.isFile() && t.size < 1e6) h.update(fs.readFileSync(p)); } catch {} return; } if (st.isFile()) { h.update(`F:${rel}:${st.size}:`); if (st.size < 1e6) h.update(fs.readFileSync(p)); else h.update(String(st.mtimeMs)); } } catch {} };
  const walk = (dir, rel) => { let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; } for (const e of es) { if (++n > 3000) return; const p = path.join(dir, e.name); const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(p, r); else add(p, r); } };
  for (const r of CFG_FILES) add(path.join(flow.cwd, r), r);
  for (const r of CFG_DIRS) walk(path.join(flow.cwd, r), r);
  return h.digest('hex');
}
const linkErr = (status, code, error, extra = {}) => Object.assign(new Error(error), { status, code, ...extra });
function readLinkFile(link) {
  const st = linkState(link.id).status;
  if (st === 'unavailable' || st === 'forbidden') return { error: st, why: linkState(link.id).error };
  let real; try { real = fs.realpathSync.native(link.path); } catch { return { error: 'unavailable', why: `No se encuentra ${link.path}` }; }
  if (!samePath(real, link.path) || forbiddenPlace(real)) return { error: 'forbidden', why: 'La carpeta vinculada ahora apunta a otra ubicación' };
  const f = path.join(link.path, 'flow.json');
  let ls; try { ls = fs.lstatSync(f); } catch { return { error: 'unavailable', why: `No se encuentra ${f}` }; }
  if (!ls.isFile()) return { error: 'invalid', why: 'flow.json no es un archivo común (¿un enlace?)' };
  if (ls.size > LINK_MAX_BYTES) return { error: 'invalid', why: 'flow.json supera 5 MB' };
  try { return { text: fs.readFileSync(f, 'utf8') }; } catch (e) { return { error: 'unavailable', why: e.message }; }
}
const forbiddenPlace = (real) => { const r = realLower(real); return /^(\\\\|\/\/)/.test(real) || [DATA, WORKSPACES(), ROOT].some((o) => { const x = realLower(o); return inside(r, x) || inside(x, r); }); };
const depthOk = (v, d = 0) => (d > 64 ? false : Array.isArray(v) ? v.every((x) => depthOk(x, d + 1)) : v && typeof v === 'object' ? Object.values(v).every((x) => depthOk(x, d + 1)) : true);
const parseDef = (text) => { try { const d = JSON.parse(text); return d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.steps) && depthOk(d) ? d : null; } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function getLinked(link) {
  try { return getLinkedRaw(link); } catch (e) { setLinkStatus(link.id, 'invalid', e.message); return null; }
}
function getLinkedRaw(link) {
  const r = readLinkFile(link);
  if (r.error) { setLinkStatus(link.id, r.error, r.why); return null; }
  const def = parseDef(r.text);
  if (!def) { setLinkStatus(link.id, 'invalid', 'flow.json no es un flujo válido (JSON con "steps")'); return null; }
  ensureFlowDir(link.id, link.name || def.name);
  const d = flowDir(link.id);
  const state = readJson(path.join(d, 'state.json'), {});
  let flow = mergeFlow(def, state); flow.id = link.id;
  try { flow = linkHooks.sanitize(flow) || flow; } catch (e) { setLinkStatus(link.id, 'invalid', e.message); return null; }
  const h = sha(r.text);
  if (state.lastDefHash !== h) flow = ingestExternal(link, flow, r.text, h);
  setLinkStatus(link.id, 'available');
  return flow;
}
/** A linked flow.json that changed outside the app (or was just linked): version, trust check, maybe quarantine. */
function ingestExternal(link, flow, text, h) {
  const d = flowDir(link.id);
  const prevText = readText(path.join(d, 'flow.last.json'));
  const prevDef = prevText && parseDef(prevText);
  if (prevDef) { const pv = mergeFlow(prevDef, {}); pv.id = link.id; pv.rev = flow.rev; saveVersion(pv, { label: 'Antes del cambio externo', auto: true }); }
  const fp = execFingerprint(flow);
  const exec = [...(linkHooks.executableParts(flow) || []), ...(inertFlow(flow) ? [] : ['tiene steps que pueden ejecutar o escribir (comandos, agentes, herramientas que no son de solo lectura, hooks o permisos ampliados)'])];
  const cwdChanged = prevDef ? String(prevDef.cwd || '') !== String(flow.cwd || '') : !!flow.cwd; // a first link with its own working folder is reviewed too
  const where = `cambió fuera de la app (${path.join(link.path, 'flow.json')})`;
  const cfgNow = cwdConfigHash(flow);
  const cfgChanged = !!flow.trust && flow.trust.cfg !== undefined && (flow.trust.cfgCwd ?? '') === (flow.cwd || '') && cfgNow !== flow.trust.cfg;
  let quarantined = false;
  if (flow.quarantine) { flow.quarantine = { ...flow.quarantine, reasons: [...new Set([...exec, prevDef ? where : null].filter(Boolean))] }; quarantined = true; }
  else if ((flow.trust?.fp !== fp && (exec.length || cwdChanged)) || cfgChanged) {
    flow.quarantine = { since: Date.now(), from: { linked: link.path }, reasons: [...(prevDef || flow.trust ? [where] : [`vinculado desde ${link.path}`]), ...exec, ...(cwdChanged ? [`directorio de trabajo: ${flow.cwd || '(ninguno)'}`] : []), ...(cfgChanged ? [`cambió la configuración de Claude de su directorio de trabajo (${flow.cwd}: .claude, .mcp.json o CLAUDE.md)`] : [])] };
    quarantined = true;
  } else flow.trust = flow.trust ? { ...flow.trust, fp, at: Date.now() } : { fp, at: Date.now(), cfg: cfgNow, cfgCwd: flow.cwd || '' };
  if (!flow.createdAt) flow.createdAt = Date.now(); // a linked flow works in its own folder (spec 11)
  if (!flow.linkedPath) flow.linkedPath = link.path;
  flow.rev = (flow.rev || 0) + 1; flow.lastDefHash = h;
  writeJson(path.join(d, 'state.json'), splitFlow(flow).state);
  writeText(path.join(d, 'flow.last.json'), text);
  try { linkHooks.onExternalChange(link.id, { quarantined, first: !prevDef }); } catch (e) { console.error('[link]', e.message); }
  return flow;
}
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const realLower = (p) => { let r = p; try { r = fs.realpathSync.native(p); } catch {} return process.platform === 'win32' ? path.resolve(r).toLowerCase() : path.resolve(r); };
/** A folder that may hold a linked flow: local, existing, and never the app's own folders (data, workspaces, install). */
export function validateLinkPath(p) {
  if (typeof p !== 'string' || !p.trim() || p.length > 1000 || p.includes('\0') || !path.isAbsolute(p.trim())) throw linkErr(400, 'LINK_PATH_INVALID', 'Indica la ruta completa de una carpeta');
  const raw = p.trim();
  if (/^(\\\\|\/\/)/.test(raw)) throw linkErr(400, 'LINK_PATH_NETWORK', 'Las carpetas de red (\\\\servidor\\…) no se pueden vincular: usa una carpeta local o un clon del repo');
  if (!fs.existsSync(raw)) throw linkErr(404, 'LINK_PATH_NOT_FOUND', `No existe la carpeta ${raw}`);
  const real = fs.realpathSync.native(raw);
  if (/^(\\\\|\/\/)/.test(real)) throw linkErr(400, 'LINK_PATH_NETWORK', 'La carpeta apunta a una ubicación de red');
  if (!fs.statSync(real).isDirectory()) throw linkErr(400, 'LINK_NOT_DIR', 'La ruta no es una carpeta');
  const r = realLower(real);
  for (const own of [DATA, WORKSPACES(), ROOT]) { const o = realLower(own); if (inside(r, o) || inside(o, r)) throw linkErr(400, 'LINK_PATH_FORBIDDEN', 'No se puede vincular una carpeta de la propia app (datos, carpetas de trabajo o instalación) ni una que las contenga'); }
  return real;
}
/** Registers an outside folder with a flow.json. The flow gets a new id when it has none or it is taken (asCopy). */
export function linkFolder(p, { asCopy = false } = {}) {
  const real = validateLinkPath(p);
  const links = linkedFlows();
  if (links.some((l) => samePath(l.path, real))) throw linkErr(409, 'LINK_EXISTS', 'Esa carpeta ya está vinculada');
  if (links.length >= 200) throw linkErr(400, 'LINK_LIMIT', 'Demasiadas carpetas vinculadas (200)');
  const f = path.join(real, 'flow.json');
  let ls; try { ls = fs.lstatSync(f); } catch { throw linkErr(422, 'LINK_NO_FLOW', 'La carpeta no tiene flow.json (exporta o mueve un flujo ahí primero)'); }
  if (!ls.isFile() || ls.size > LINK_MAX_BYTES) throw linkErr(422, 'LINK_INVALID', 'flow.json no es un archivo común de hasta 5 MB');
  const text = fs.readFileSync(f, 'utf8'); const def = parseDef(text);
  if (!def) throw linkErr(422, 'LINK_INVALID', 'flow.json no es un flujo válido (JSON con "steps")');
  try { const probe = linkHooks.sanitize({ ...mergeFlow(def, {}), id: 'f_probe' }); execFingerprint(probe); } catch (e) { throw linkErr(422, 'LINK_INVALID', `flow.json no es un flujo válido: ${e.message}`); }
  let id = typeof def.id === 'string' && /^f_[a-z0-9_]{1,60}$/.test(def.id) ? def.id : null;
  const known = [...flowIndex().keys(), ...links.map((l) => l.id)].map((x) => x.toLowerCase());
  const lower = String(def.id || '').toLowerCase();
  let taken = known.includes(lower);
  if (id && taken && !links.some((l) => l.id === id) && folderOf(id) && !fs.existsSync(path.join(flowDir(id), 'flow.json'))) {
    // the app keeps the history of an unlinked folder: only that same folder gets it back (never secrets or memory to another one)
    const was = readJson(path.join(flowDir(id), 'state.json'), {}).linkedPath;
    if (was && samePath(was, real)) taken = false;
  }
  if (taken && !asCopy) throw linkErr(409, 'LINK_ID_TAKEN', `Ese flujo (${def.id}) ya está en la app: vincúlalo como copia (nuevo id)`, { flowId: def.id });
  if (!id || taken) id = uid('f_'); // the registry holds the id: the folder's file is not rewritten (it changes on the next edit)
  setConfig({ linkedFlows: [...links, { id, path: real, name: String(def.name || 'Flujo').slice(0, 200), linkedAt: Date.now() }] });
  linkStatus.delete(id);
  return id;
}
/** Removes the registration (never the folder's files). keepLocalCopy turns it back into a flow of this app. */
export function unlinkFlow(id, { keepLocalCopy = false } = {}) {
  const link = linkOf(id); if (!link) return false;
  let cur = keepLocalCopy ? getFlow(id) : null;
  if (keepLocalCopy && !cur) {
    const d = flowDir(link.id); const last = parseDef(readText(path.join(d, 'flow.last.json')) || '');
    if (!last) throw linkErr(409, 'FLOW_UNAVAILABLE', `La carpeta del flujo no está disponible (${link.path}) y no hay una copia de su definición: vuelve a conectarla o desvincúlalo sin copia`);
    cur = mergeFlow(last, readJson(path.join(d, 'state.json'), {})); cur.id = link.id;
  }
  setConfig({ linkedFlows: linkedFlows().filter((l) => l.id !== link.id) });
  linkStatus.delete(link.id);
  if (cur) { delete cur.lastDefHash; saveFlow(cur); }
  return true;
}
/** Turns a local flow into a linked one: its definition goes to <dir>/flow.json; history stays in DATA. */
export function moveFlowTo(id, p) {
  const real = validateLinkPath(p);
  if (linkOf(id)) throw linkErr(409, 'LINK_EXISTS', 'El flujo ya está en una carpeta vinculada');
  if (linkedFlows().some((l) => samePath(l.path, real))) throw linkErr(409, 'LINK_EXISTS', 'Esa carpeta ya está vinculada a otro flujo');
  const flow = getFlow(id); if (!flow) throw linkErr(404, 'FLOW_NOT_FOUND', 'Flujo no encontrado');
  if (fs.existsSync(path.join(real, 'flow.json'))) throw linkErr(409, 'LINK_TARGET_HAS_FLOW', 'Esa carpeta ya tiene un flow.json');
  const text = `${JSON.stringify(splitFlow(flow).def, null, 2)}\n`;
  writeText(path.join(real, 'flow.json'), text);
  setConfig({ linkedFlows: [...linkedFlows(), { id: safe(id), path: real, name: flow.name, linkedAt: Date.now() }] });
  const d = flowDir(id);
  try { fs.renameSync(path.join(d, 'flow.json'), path.join(d, `flow.json.moved-${Date.now()}`)); } catch {}
  flow.lastDefHash = sha(text); flow.linkedPath = real; flow.trust = { fp: execFingerprint(flow), at: Date.now(), cfg: cwdConfigHash(flow), cfgCwd: flow.cwd || '' };
  writeJson(path.join(d, 'state.json'), splitFlow(flow).state); writeText(path.join(d, 'flow.last.json'), text);
  return real;
}
/** F2: before a run (and on every poll) a linked flow whose working folder's Claude configuration changed goes to review. */
export function linkedConfigCheck(id) {
  const link = linkOf(id); if (!link) return null;
  const flow = getFlow(id);
  if (!flow || flow.quarantine || !flow.cwd || !flow.trust || flow.trust.cfg === undefined) return null;
  const h = cwdConfigHash(flow);
  if (h === flow.trust.cfg) return null;
  flow.quarantine = { since: Date.now(), from: { linked: link.path }, reasons: [`cambió la configuración de Claude de su directorio de trabajo (${flow.cwd}: .claude, .mcp.json o CLAUDE.md)`] };
  writeJson(path.join(flowDir(id), 'state.json'), splitFlow(flow).state);
  try { linkHooks.onExternalChange(id, { quarantined: true }); } catch {}
  return flow.quarantine;
}
/** A context source inside the app's data, another flow's own folder or the installation (spec 09 adversarial). */
export function forbiddenSource(abs, flow) {
  const r = realLower(abs);
  const own = flow?.id ? realLower(flowWorkspace(flow.id)) : null;
  if (own && inside(r, own)) return false;
  return [DATA, WORKSPACES(), ROOT].some((o) => { const x = realLower(o); return inside(r, x) || inside(x, r); });
}
/** Where to reveal a flow: its linked folder, else its folder in the app's data. */
export const flowLocation = (id) => linkOf(id)?.path || flowDir(id);
/** Availability of every linked folder (async, with a timeout: an unplugged or hung drive never blocks the app). */
export async function pollLinks() {
  const limit = (p) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 2000).unref?.())]);
  for (const l of linkedFlows()) {
    try {
      const real = await limit(fs.promises.realpath(l.path));
      const r = realLower(real);
      if (/^(\\\\|\/\/)/.test(real) || [DATA, WORKSPACES(), ROOT].some((o) => inside(r, realLower(o)) || inside(realLower(o), r))) { setLinkStatus(l.id, 'forbidden', 'La carpeta vinculada ahora apunta a una ubicación no permitida'); continue; }
      await limit(fs.promises.stat(path.join(l.path, 'flow.json')));
      if (['unavailable', 'forbidden'].includes(linkState(l.id).status)) setLinkStatus(l.id, 'available');
      getFlow(l.id); // ingests an outside edit (and marks invalid ones)
      linkedConfigCheck(l.id);
    } catch (e) { setLinkStatus(l.id, 'unavailable', `No se puede leer ${l.path} (${e.code || e.message})`); }
  }
}

export function getFlow(id) {
  const link = linkOf(id); if (link) return getLinked(link);
  const n = folderOf(id); if (!n) return null;
  const d = path.join(FLOWS_ROOT(), n);
  const def = readJson(path.join(d, 'flow.json'), null);
  if (!def || typeof def !== 'object' || Array.isArray(def) || !Array.isArray(def.steps)) return null;
  const sf = path.join(d, 'state.json');
  let state = null; let lost = false;
  try { state = JSON.parse(fs.readFileSync(sf, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state) || !state.createdAt) throw new Error('state'); } catch (e) { if (BUSY.has(e.code)) state = {}; else lost = true; }
  const f = mergeFlow(def, lost ? {} : state);
  f.id = n.slice(n.indexOf('--') + 2); // the folder is the address (a hand-edited id inside never redirects)
  if (lost) {
    const exec = [...(linkHooks.executableParts(f) || []), ...(inertFlow(f) ? [] : ['tiene steps que pueden ejecutar o escribir'])];
    f.createdAt = Date.now(); f.workspace = 'own';
    if (exec.length) f.quarantine = { since: Date.now(), from: { stateLost: true }, reasons: ['se perdió o dañó su estado (state.json): revisa el flujo antes de habilitarlo', ...exec] };
    try { if (fs.existsSync(sf)) fs.renameSync(sf, `${sf}.danado-${Date.now()}`); writeJson(sf, splitFlow(f).state); } catch {}
    console.warn(`El estado del flujo ${f.id} faltaba o estaba dañado: se rehízo${exec.length ? ' y quedó en revisión' : ''}.`);
  }
  return f;
}
/** Resolve a flow by id, (case-insensitive) name or the slug of its name — used by external callers. */
export function findFlow(idOrName) {
  const byId = getFlow(idOrName);
  if (byId) return byId;
  const n = String(idOrName).trim().toLowerCase();
  const all = listFlows();
  // a name or a slug shared by two flows is ambiguous (a linked flow never takes over another one's calls): use the id
  const hits = [...new Set(all.filter((f) => String(f.name ?? '').trim().toLowerCase() === n || slugify(f.name) === n).map((f) => f.id))];
  return hits.length === 1 ? getFlow(hits[0]) : null;
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
  if (!c?.token || !c?.uiKey || !c?.isolationSince) {
    // isolationSince (spec 11): flows created before it keep working in the user's folder until the person opts in
    c = { ...(c || {}), token: c?.token || crypto.randomBytes(24).toString('base64url'), uiKey: c?.uiKey || crypto.randomBytes(24).toString('base64url'), isolationSince: c?.isolationSince || Date.now() };
    writeJson(f, c);
  }
  return c;
}

// ---------- spec 11 ISO-3: each flow works in its own folder ----------
/** The flow's own working folder (not created here). Spec 09 moves it next to the flow; this is the only place to change. */
export const WORKSPACES = () => process.env.AFS_WORKSPACES || path.join(os.homedir(), '.agent-flow-studio', 'workspaces');
export const flowWorkspace = (flowId) => path.join(WORKSPACES(), safe(flowId));
/** 'own' (its folder) or 'home' (the user's folder): an explicit choice, else by age (flows from before isolation: home). */
export function workspaceMode(flow) {
  if (flow?.workspace === 'own' || flow?.workspace === 'home') return flow.workspace;
  const since = getConfig().isolationSince || 0;
  return !flow?.createdAt || flow.createdAt < since ? 'home' : 'own';
}
/** The path flowCwd would use, without creating anything (comparisons, previews). */
export function flowCwdPath(flow) {
  if (flow?.cwd && fs.existsSync(flow.cwd)) return flow.cwd;
  return !flow?.id || workspaceMode(flow) === 'home' ? os.homedir() : flowWorkspace(flow.id);
}
/** Where Claude and the commands of a flow work: its custom cwd, else its own folder (created lazily), else home. */
export function flowCwd(flow) {
  if (flow?.cwd && fs.existsSync(flow.cwd)) return flow.cwd;
  if (!flow?.id || workspaceMode(flow) === 'home') return os.homedir();
  const d = flowWorkspace(flow.id); fs.mkdirSync(d, { recursive: true }); return d;
}
export function workspaceInfo(flow) {
  const mode = flow.cwd ? 'custom' : workspaceMode(flow);
  const p = flow.cwd || (mode === 'home' ? os.homedir() : flowWorkspace(flow.id));
  return { mode, path: p, legacy: !flow.createdAt || flow.createdAt < (getConfig().isolationSince || 0), exists: fs.existsSync(p), workspace: flowWorkspace(flow.id) };
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
  // trust follows in-app saves (spec 09): a quarantined flow keeps its old trust (a save never lifts the quarantine)
  if (!flow.quarantine) {
    const fp = execFingerprint(flow);
    if (!flow.trust) flow.trust = { fp, at: Date.now(), ...(linkOf(flow.id) ? { cfg: cwdConfigHash(flow), cfgCwd: flow.cwd || '' } : {}) };
    else if (flow.trust.fp !== fp) flow.trust = { ...flow.trust, fp, at: Date.now() };
    if (linkOf(flow.id) && (flow.trust.cfgCwd ?? '') !== (flow.cwd || '')) flow.trust = { ...flow.trust, cfg: cwdConfigHash(flow), cfgCwd: flow.cwd || '' };
  }
  const link = linkOf(flow.id);
  if (link) return saveLinked(link, flow);
  ensureFlowDir(flow.id, flow.name);
  const d = flowDir(flow.id);
  const { def, state } = splitFlow(flow);
  // flow.json first, then state.json; flow.json is rewritten only when the definition changed (clean git diffs,
  // less antivirus contention: a run touches state.json only)
  const text = `${JSON.stringify(def, null, 2)}\n`;
  let cur = null; try { cur = fs.readFileSync(path.join(d, 'flow.json'), 'utf8'); } catch {}
  if (cur === null) writeJson(path.join(d, 'state.json'), state);
  if (cur !== text) writeText(path.join(d, 'flow.json'), text);
  writeJson(path.join(d, 'state.json'), state);
  return flow;
}
function normDef(flow, id) {
  let f = structuredClone(flow); f.id = id;
  try { f = linkHooks.sanitize(f) || f; } catch {}
  ensureSlugs(f);
  const { format, formatVersion, ...def } = splitFlow(f).def;
  return JSON.stringify(stable(def));
}
function saveLinked(link, flow) {
  const r = readLinkFile(link);
  if (r.error) { setLinkStatus(link.id, r.error, r.why); throw linkErr(409, 'FLOW_UNAVAILABLE', `La carpeta del flujo no está disponible: ${link.path}`, { path: link.path }); }
  ensureFlowDir(link.id, link.name);
  const d = flowDir(link.id);
  const stateNow = readJson(path.join(d, 'state.json'), {});
  if (sha(r.text) !== stateNow.lastDefHash) {
    // an outside edit the app had not seen yet: it wins; only the caller's machine state (runs, sessions…) is kept
    const fresh = getLinked(link); if (!fresh) throw linkErr(409, 'FLOW_UNAVAILABLE', `La carpeta del flujo no está disponible: ${link.path}`, { path: link.path });
    const mine = splitFlow(flow).state;
    for (const k of ['rev', 'quarantine', 'trust', 'lastDefHash', 'createdAt']) if (fresh[k] === undefined) delete mine[k]; else mine[k] = fresh[k];
    const merged = mergeFlow(splitFlow(fresh).def, mine); merged.id = link.id; merged.updatedAt = Date.now();
    writeJson(path.join(d, 'state.json'), splitFlow(merged).state);
    return merged;
  }
  const { def, state } = splitFlow(flow);
  const text = `${JSON.stringify(def, null, 2)}\n`;
  const file = path.join(link.path, 'flow.json');
  // same definition as the file (a run, a session, a pin…): the person's repo is not touched, even when the file was
  // hand-written with another layout or without the fields the app fills in
  let onDisk = r.text;
  if (text !== r.text && normDef(flow, link.id) !== normDef(mergeFlow(parseDef(r.text) || { steps: [] }, {}), link.id)) {
    let ls; try { ls = fs.lstatSync(file); } catch {}
    if (ls && !ls.isFile()) throw linkErr(422, 'LINK_INVALID', 'flow.json no es un archivo común (¿un enlace?)');
    writeText(file, text); writeText(path.join(d, 'flow.last.json'), text); onDisk = text;
  }
  state.lastDefHash = sha(onDisk); flow.lastDefHash = state.lastDefHash;
  writeJson(path.join(d, 'state.json'), state);
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
  unlinkFlow(id); // a linked flow: only the registration and the app's side go; the linked folder is never touched
  const n = folderOf(id);
  if (n) { fs.rmSync(path.join(FLOWS_ROOT(), n), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); idx = null; }
  // its own working folder: removed when empty, otherwise kept aside (it may hold work the person wants)
  const ws = flowWorkspace(id);
  try { if (fs.existsSync(ws)) { if (!fs.readdirSync(ws).length) fs.rmSync(ws, { recursive: true, force: true }); else { const to = path.join(WORKSPACES(), '_borrados', `${safe(id)}-${Date.now()}`); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(ws, to); } } } catch (e) { console.warn(`No se pudo apartar la carpeta del flujo borrado ${id} (${e.code || e.message}): queda en ${ws}`); }
}

// ---------- flow reviews (spec 28) ----------
const reviewFile = (flowId, id) => path.join(flowSub(flowId, 'reviews'), `${safe(id)}.json`);
export const saveReview = (rv) => writeJson(reviewFile(rv.flowId, rv.id), rv);
export const getReview = (flowId, id) => readJson(flowFile(flowId, 'reviews', `${safe(id)}.json`), null);
/** Newest first; only metadata (findings stay in the file). */
export function listReviews(flowId) {
  let files = [];
  try { files = fs.readdirSync(flowFile(flowId, 'reviews')).filter((f) => /^rv_.*\.json$/.test(f)); } catch { return []; }
  return files.map((f) => readJson(flowFile(flowId, 'reviews', f), null)).filter(Boolean)
    .map(({ id, status, startedAt, endedAt, flowHash, error, findings, totals }) => ({ id, status, startedAt, endedAt, flowHash, error, findings: (findings || []).length, totals }))
    .sort((a, b) => b.startedAt - a.startedAt);
}
/** Findings the person dismissed: {fp: {anchor, reason, at}} (a dismissed finding stays hidden while its anchor holds). */
// spec 10: 🔔 news of the watched sources (snapshots, pending changes) per flow
export const getWatch = (flowId) => readJson(flowFile(flowId, 'sources.json'), {});
export const saveWatch = (flowId, v) => { flowSub(flowId); writeJson(flowFile(flowId, 'sources.json'), v); };
export const getSuppressed = (flowId) => readJson(flowFile(flowId, 'reviews', 'suppressed.json'), {});
export const setSuppressed = (flowId, map) => writeJson(path.join(flowSub(flowId, 'reviews'), 'suppressed.json'), map);

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
const chatFile = (flowId, key) => path.join(flowSub(flowId, 'chats'), `${safe(key)}.json`);
export const getChat = (flowId, key) => readJson(flowFile(flowId, 'chats', `${safe(key)}.json`), []);
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
export const clearChat = (flowId, key) => fs.rmSync(flowFile(flowId, 'chats', `${safe(key)}.json`), { force: true });
export const clearAllChats = (flowId) => fs.rmSync(flowFile(flowId, 'chats'), { recursive: true, force: true });

// ---------- runs ----------
const runFile = (flowId, runId) => path.join(flowSub(flowId, 'runs'), `${safe(runId)}.json`);
export const saveRun = (run) => writeJson(runFile(run.flowId, run.id), run);
export const clearRuns = (flowId) => { for (const d of ['runs', 'outputs']) fs.rmSync(flowFile(flowId, d), { recursive: true, force: true }); fs.rmSync(flowFile(flowId, 'approvals.json'), { force: true }); };
export const countRuns = (flowId) => { try { return fs.readdirSync(flowFile(flowId, 'runs')).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const countChats = (flowId) => { try { return fs.readdirSync(flowFile(flowId, 'chats')).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
export const getRun = (flowId, runId) => readJson(flowFile(flowId, 'runs', `${safe(runId)}.json`), null);
/** Full run records of a flow (for startup recovery). */
export function rawRuns(flowId) {
  const d = flowFile(flowId, 'runs'); try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))).filter(Boolean); } catch { return []; }
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
  const d = flowFile(flowId, 'runs');
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
const verDir = (flowId) => flowSub(flowId, 'versions');
const definitionOf = (f) => ({
  name: f.name, description: f.description, cwd: f.cwd, vars: f.vars, schedule: f.schedule, runTimeoutSec: f.runTimeoutSec, versionEveryMin: f.versionEveryMin, contextSources: f.contextSources, finally: f.finally, requirements: f.requirements, policies: f.policies,
  steps: (f.steps || []).map(({ lastRun, memory, pinned, chatSessionId, chatContextHash, ...s }) => s),
  edges: f.edges || [],
});
export const definitionHash = (f) => crypto.createHash('sha256').update(JSON.stringify(definitionOf(f))).digest('hex');
export function listVersions(flowId) {
  let files = [];
  try { files = fs.readdirSync(flowFile(flowId, 'versions')).filter((x) => x.endsWith('.json')); } catch { return []; }
  return files.map((x) => readJson(flowFile(flowId, 'versions', x), null)).filter(Boolean)
    .map(({ flow, ...meta }) => ({ ...meta, steps: flow?.steps?.length || 0, edges: flow?.edges?.length || 0 }))
    .sort((a, b) => b.at - a.at);
}
export const getVersion = (flowId, id) => readJson(flowFile(flowId, 'versions', `${safe(id)}.json`), null);
export function saveVersion(flow, { label = '', auto = false } = {}) {
  const v = { id: uid('v_'), at: Date.now(), label: String(label || '').slice(0, 120), auto: !!auto, rev: flow.rev || 0, hash: definitionHash(flow), flow: definitionOf(flow) };
  writeJson(path.join(verDir(flow.id), `${v.id}.json`), v);
  // keep the last 30 automatic versions (named ones are never pruned)
  const autos = listVersions(flow.id).filter((x) => x.auto);
  for (const old of autos.slice(30)) fs.rmSync(flowFile(flow.id, 'versions', `${safe(old.id)}.json`), { force: true });
  const { flow: _f, ...meta } = v;
  return meta;
}
export const deleteVersion = (flowId, id) => fs.rmSync(flowFile(flowId, 'versions', `${safe(id)}.json`), { force: true });
export const clearVersions = (flowId) => fs.rmSync(flowFile(flowId, 'versions'), { recursive: true, force: true });
