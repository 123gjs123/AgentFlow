// Export / import of flows (spec 09, part "export & import"): a single .afsflow.json file another person can import.
// Exports never carry machine state (sessions, last runs, the API token or UI key); secret-looking variable values are
// blanked unless asked. Imports get a new id, are sanitized like any save, and are QUARANTINED when they contain
// anything that executes on the importer's machine (commands, hooks, "Al terminar", command assertions, terminal or
// file-writing access): they can be viewed and edited, but not run, until the person confirms they reviewed them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { credentialRefs, credentialNames } from './credentials.js';

export const BUNDLE_FORMAT = 'agent-flow-studio/flow';
export const BUNDLE_VERSION = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0'; } })();
export const SECRET_NAME = store.SECRET_NAME; // one list (spec 09 adversarial: GH_KEY, JIRA_PAT…)
const MACHINE_STEP = ['lastRun', 'chatSessionId', 'chatContextHash'];
const MACHINE_FLOW = ['globalSessionId', 'globalContextHash', 'reviewSessionId', 'reviewContextHash', 'quarantine', 'rev', 'updatedAt', 'createdAt', 'workspace'];

export const slug = (s) => String(s || 'flujo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'flujo';

/** Builds the export bundle. opts: {chats, runs, memory=true, pins=false, secrets=false} */
export function exportFlow(flow, opts = {}) {
  const removed = [];
  const f = structuredClone(flow);
  for (const k of MACHINE_FLOW) delete f[k];
  if (f.schedule?.enabled) { f.schedule = { ...f.schedule, enabled: false }; removed.push('programación desactivada (se activa a mano al importar)'); }
  if (opts.memory === false) { f.memory = []; }
  for (const s of f.steps || []) {
    for (const k of MACHINE_STEP) delete s[k];
    if (opts.memory === false) s.memory = [];
    if (s.pinned && !opts.pins) { delete s.pinned; if (!removed.includes('salidas fijadas')) removed.push('salidas fijadas'); }
    // spec 11: ids are local to this machine; the name lets the importer relink the call
    if (s.kind === 'flow' && s.flowRef) s.flowRefName = store.getFlow(s.flowRef)?.name || null;
  }
  if (!opts.secrets) {
    for (const [k, v] of Object.entries(f.vars || {})) if (SECRET_NAME.test(k) && v) { f.vars[k] = ''; removed.push(`valor de la variable "${k}" (parece un secreto)`); }
  }
  const bundle = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), app: APP_VERSION, flow: f, removed };
  if (opts.chats) {
    const chats = {};
    for (const key of ['_global', '_flow', '_review', ...(f.steps || []).map((s) => s.id)]) { const c = store.getChat(flow.id, key); if (c.length) chats[key] = c; }
    bundle.chats = chats;
  }
  if (opts.runs) bundle.runs = store.rawRuns(flow.id).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
  return bundle;
}

/** What in a flow would execute on the importer's machine (reasons for the quarantine). */
export function executableParts(flow) {
  const out = [];
  for (const s of flow.steps || []) {
    if (s.kind === 'command' && String(s.command || '').trim()) out.push(`comando en "${s.name}": ${String(s.command).split('\n')[0].slice(0, 120)}`);
    if (String(s.hooks || '').trim()) out.push(`hooks (código JavaScript) en "${s.name}"`);
    for (const a of s.assertions || []) if (a?.type === 'command' && String(a.command || '').trim()) out.push(`aserción con comando en "${s.name}"`);
    if (s.kind !== 'command' && /(^|[\s,])(Bash|Edit|Write|NotebookEdit)\b/.test(String(s.allowedTools || ''))) out.push(`"${s.name}" puede usar la terminal o escribir archivos (${String(s.allowedTools).match(/(Bash|Edit|Write|NotebookEdit)[^\s,]*/g).slice(0, 4).join(', ')})`);
    if (s.permissionMode === 'bypassPermissions') out.push(`"${s.name}" salta los permisos (bypassPermissions)`);
    if (s.kind === 'flow') { const t = s.flowRef ? store.getFlow(s.flowRef) : null; out.push(t ? `"${s.name}" invocaría tu flujo local «${t.name}» (${t.id}) con el input que trae el paquete` : `"${s.name}" invoca otro flujo (sin elegir)`); } // spec 11
    if (/invokeFlow\s*\(/.test(String(s.hooks || ''))) out.push(`hooks de "${s.name}" invocan otro flujo`);
    // spec 14: declared actions change external systems; a deliverable destination writes on this machine
    for (const a of s.actions || []) if (a && typeof a === 'object') out.push(`acción declarada en "${s.name}": ${String(a.type).slice(0, 40)}${a.approval === 'auto' ? ' (automática)' : ''}`);
    for (const d of s.deliverables || []) for (const x of d?.destination || []) if (x?.path) out.push(`"${s.name}" copia un archivo a ${String(x.path).slice(0, 120)}`);
    // spec 10: a command watch runs on this machine; a URL watch with a credential would send it
    for (const w of s.watches || []) {
      if (w?.type === 'command' && String(w.target || '').trim()) out.push(`fuente vigilada con comando en "${s.name}": ${String(w.target).split(/\r?\n/)[0].slice(0, 120)}`);
      if (w?.type === 'url' && w.options?.credential) out.push(`fuente vigilada en "${s.name}" que usa la credencial «${String(w.options.credential).slice(0, 40)}» con ${String(w.target || '').slice(0, 120)}`);
    }
  }
  if (String(flow.finally?.command || '').trim()) out.push(`"Al terminar": ${String(flow.finally.command).split('\n')[0].slice(0, 120)}`);
  for (const r of flow.requirements || []) if (r.type === 'tool' && String(r.check || '').trim()) out.push(`comprobación de requisito: ${r.check}`);
  return [...new Set(out)];
}

/**
 * Validates and turns a bundle into a new local flow. clean = {edge, sources, finally, requirements} sanitizers from
 * index.js (the same ones used on every save). Returns {flow, quarantine, warnings, chats, runs}.
 */
export function importBundle(bundle, clean, { name } = {}) {
  if (!bundle || typeof bundle !== 'object') throw Object.assign(new Error('El archivo no es un flujo exportado (JSON inválido)'), { status: 400, code: 'BAD_BUNDLE' });
  if (bundle.format !== BUNDLE_FORMAT || !bundle.flow || typeof bundle.flow !== 'object') throw Object.assign(new Error('El archivo no es un flujo de Agent Flow Studio (falta "format": "agent-flow-studio/flow")'), { status: 400, code: 'BAD_BUNDLE' });
  if (Number(bundle.version) > BUNDLE_VERSION) throw Object.assign(new Error(`El flujo se exportó con una versión más nueva (formato v${bundle.version}); actualiza Agent Flow Studio para importarlo`), { status: 400, code: 'BUNDLE_TOO_NEW' });
  const src = bundle.flow;
  const warnings = [];
  const base = store.newFlow(typeof (name || src.name) === 'string' ? (name || src.name) : 'Flujo importado');
  const names = new Set(store.listFlows().map((x) => String(x.name).toLowerCase()));
  if (names.has(base.name.toLowerCase())) { let n = `${base.name} (importado)`; let i = 2; while (names.has(n.toLowerCase())) n = `${base.name} (importado ${i++})`; base.name = n; }
  const steps = (Array.isArray(src.steps) ? src.steps : []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string').slice(0, 200).map((s) => {
    const st = store.newStep({ ...s, contextSources: clean.sources(s.contextSources) });
    for (const k of MACHINE_STEP) st[k] = null;
    st.lastRun = null;
    if (!Array.isArray(st.memory)) st.memory = [];
    return st;
  });
  // spec 11: a 🔀 Flujo step points at a flow of THIS machine: relinked only to one flow with exactly that name
  for (const st of steps) {
    if (st.kind !== 'flow') continue;
    const want = typeof st.flowRefName === 'string' ? st.flowRefName.trim().toLowerCase() : '';
    const m = want ? store.listFlows().filter((x) => String(x.name).trim().toLowerCase() === want) : [];
    if (m.length === 1) { st.flowRef = m[0].id; warnings.push(`«${st.name}» quedó apuntando a tu flujo local «${m[0].name}»: revísalo antes de habilitar el flujo importado`); }
    else { if (st.flowRef || want) warnings.push(`«${st.name}» invocaba el flujo «${st.flowRefName || st.flowRef}»: ${m.length ? 'hay varios con ese nombre' : 'no existe en esta máquina'}; elígelo en el step`); st.flowRef = ''; }
    delete st.flowRefName;
  }
  if (clean.steps) clean.steps(steps);
  const ids = new Set(steps.map((s) => s.id));
  const edges = (Array.isArray(src.edges) ? src.edges : []).filter((e) => e && ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map(clean.edge);
  const flow = {
    ...base,
    description: typeof src.description === 'string' ? src.description : '',
    cwd: typeof src.cwd === 'string' ? src.cwd : '',
    vars: src.vars && typeof src.vars === 'object' && !Array.isArray(src.vars) ? Object.fromEntries(Object.entries(src.vars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : {},
    schedule: src.schedule && typeof src.schedule === 'object' ? { ...src.schedule, enabled: false } : base.schedule,
    runTimeoutSec: src.runTimeoutSec, versionEveryMin: src.versionEveryMin,
    memory: Array.isArray(src.memory) ? src.memory.filter((m) => m && typeof m.text === 'string') : [],
    contextSources: clean.sources(src.contextSources), finally: clean.finally(src.finally) ?? undefined, requirements: clean.requirements(src.requirements),
    // spec 28: the flow's rules travel with it (marked as imported); this machine's rules stay here
    policies: clean.policies ? clean.policies(src.policies) : undefined,
    steps, edges,
  };
  if (flow.cwd && !fs.existsSync(flow.cwd)) warnings.push(`El directorio de trabajo "${flow.cwd}" no existe en esta máquina: elige uno en Flujo → Directorio de trabajo.`);
  for (const k of Object.keys(flow.vars)) if (SECRET_NAME.test(k) && !flow.vars[k]) warnings.push(`La variable "${k}" viene vacía (no se exportan secretos): complétala.`);
  // Credentials are never exported: name the ones this machine still has to load (spec 26).
  const have = credentialNames();
  const needed = [...new Set(credentialRefs(flow).map((r) => r.name))].filter((n) => !have.has(n));
  if (needed.length) warnings.push(`Usa credenciales que no están cargadas en esta máquina: ${needed.join(', ')}. Cárgalas en ⚙ Configuración › Credenciales (con el mismo nombre).`);
  const reasons = executableParts(flow);
  if (flow.cwd) reasons.push(`trabaja en ${flow.cwd} (Claude también lee la configuración .claude de esa carpeta)`);
  if ((flow.contextSources || []).length || steps.some((s) => (s.contextSources || []).length)) reasons.push('le da a Claude carpetas o archivos de esta máquina como contexto');
  if (reasons.length) flow.quarantine = { since: Date.now(), from: { exportedAt: bundle.exportedAt || null, app: bundle.app || null, name: src.name || null }, reasons };
  return { flow, warnings, chats: bundle.chats && typeof bundle.chats === 'object' ? bundle.chats : null, runs: Array.isArray(bundle.runs) ? bundle.runs : null };
}

/** 423 while an imported flow is under review. */
export function quarantineProblem(flow) {
  // spec 09: a linked flow whose working folder's Claude configuration changed goes back to review here (runs, chats, /ask, review)
  if (flow && !flow.quarantine && flow.cwd && store.linkOf(flow.id)) { const q = store.linkedConfigCheck(flow.id); if (q) flow = { ...flow, quarantine: q }; }
  if (!flow?.quarantine) return null;
  return { status: 423, code: 'QUARANTINED', reasons: flow.quarantine.reasons, error: `${flow.quarantine.from?.linked ? 'Este flujo vinculado cambió fuera de la app (o se acaba de vincular) y está en revisión' : 'Este flujo es importado y está en revisión'}: contiene cosas que se ejecutarían en esta máquina (${flow.quarantine.reasons.slice(0, 3).join('; ')}${flow.quarantine.reasons.length > 3 ? '…' : ''}). Revísalo y pulsa "Revisé este flujo, habilitar" en la app.` };
}

/** Spec 09 WS-4: a flow FOLDER (flow.json + optional chats/) read as a bundle; it then goes through importBundle. */
export function readFlowFolder(dir) {
  const f = path.join(dir, 'flow.json');
  let st; try { st = fs.lstatSync(f); } catch { throw Object.assign(new Error('La carpeta no tiene flow.json'), { status: 422, code: 'LINK_NO_FLOW' }); }
  if (!st.isFile() || st.size > 5 * 1024 * 1024) throw Object.assign(new Error('flow.json no es un archivo común de hasta 5 MB'), { status: 422, code: 'LINK_INVALID' });
  let def; try { def = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { def = null; }
  if (!def || typeof def !== 'object' || !Array.isArray(def.steps)) throw Object.assign(new Error('flow.json no es un flujo válido'), { status: 422, code: 'LINK_INVALID' });
  const { format, formatVersion, ...flow } = def;
  const chats = {};
  try { for (const n of fs.readdirSync(path.join(dir, 'chats')).filter((x) => x.endsWith('.json')).slice(0, 300)) { try { const l = JSON.parse(fs.readFileSync(path.join(dir, 'chats', n), 'utf8')); if (Array.isArray(l)) chats[n.slice(0, -5)] = l; } catch {} } } catch {}
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: null, app: null, flow, ...(Object.keys(chats).length ? { chats } : {}) };
}
