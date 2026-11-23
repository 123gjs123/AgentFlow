// D59 — What a step raises when something is missing, classified, with a stable id and a state; and the log of
// everything a run did (journal). Only a "question" about the work item may leave the app (and only when it quotes
// what the step received and does not talk about the flow's machinery); everything else is resolved inside the app.
import crypto from 'node:crypto';
import * as store from './store.js';

export const KINDS = ['question', 'blocker', 'check', 'action', 'lesson'];
export const STATES = ['open', 'review', 'answered', 'resolved', 'dismissed'];
export const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const now = () => Date.now();
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A question for a person about the work item never talks about the flow's machinery. These words mean it is the
// flow's own problem (environment, tools, permissions, repos, files): it stays inside the app as a blocker.
// Words that usually mean the flow's own machinery. Never decisive: a match sends the question to REVIEW (a person
// decides with one click), because business wording can contain them too ("skill games", "ramas del árbol").
const MACHINERY = /(?:\b[a-z]:[\\/]|\\\\|\.claude\b|\.(?:md|ps1|mjs|feature|ya?ml)\b|(?<![\p{L}\p{N}])(?:npm|npx|nodejs|git|cypress|playwright|powershell|pwsh|bash|docker|pip|python|exit\s*code|c[oó]digo de salida|stack\s?trace|reinstal\w*|variables? de entorno|env\s*vars?|mcp|conector(?:es)?|pull\s*requests?|PR|mergear|repositorios?|dry-?run|test\s*plan|plan de pruebas|test\s*executions?|xray|workspace|cach[eé] (?:de|del) (?:cypress|npm|node)|tokens?|credencial(?:es)?|bitbucket|github|jenkins|skills?|habilidad(?:es)?|carpetas?|archivos? (?:SKILL|de la skill|local(?:es)?)|permisos? de (?:escritura|lectura|edición)|acceso de (?:escritura|lectura)|herramientas? (?:bash|edit|write|read)|fue denegad[ao]|denegad[ao]s?)(?![\p{L}\p{N}]))/iu;
// A secret never reaches the log (it is meant to be read outside the app)
const SECRET_RULES = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\b(?:ATATT|ATCTT|ghp_|gho_|github_pat_|xox[abpr]-|sk-|AKIA)[A-Za-z0-9._=-]{6,}/g, '***'],
  [/((?:token|password|passwd|pwd|secret|api[_-]?key|apikey|authorization)\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1***'],
  [/(-u\s+["']?[^\s:"']+:)[^\s"']+/g, '$1***'],
  [/(https?:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@'],
];
let knownSecrets = () => [];
/** engine gives the credential values it knows, so they are masked even without a recognizable prefix */
export const setKnownSecrets = (fn) => { knownSecrets = fn; };
export function redact(s) {
  let t = String(s ?? '');
  for (const v of knownSecrets() || []) if (v && String(v).length >= 6) t = t.split(String(v)).join('***');
  for (const [re, rep] of SECRET_RULES) t = t.replace(re, rep);
  return t;
}
const redactDeep = (v) => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) : v);
store.setJournalFilter(redactDeep);
const MIN_QUOTE = 20; // a quote must be a real sentence of what the step received, not "el" or "¿?"

const fp = (kind, item, text) => crypto.createHash('sha1').update(`${kind}|${item || ''}|${norm(text).slice(0, 240)}`).digest('hex').slice(0, 10);

/** Parses the <raise>{json}</raise> blocks of a step's answer. Invalid JSON stays inside the app (a blocker). */
export function parseRaised(bodies = []) {
  const out = [];
  for (const raw of bodies) {
    let o; try { o = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { o = { kind: 'blocker', text: String(raw).trim(), invalid: true }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { out.push({ kind: 'blocker', text: String(raw).trim(), invalid: true }); continue; }
    out.push(o);
  }
  return out;
}

/** Normalizes one raised entry and applies the deterministic checks. corpus = what the step received (prompt + input). */
export function classify(o, corpus = '') {
  const ref = typeof o.id === 'string' && /^[a-z]_[0-9a-f]{10}$/.test(o.id) ? o.id : null;
  if (ref) return { ref, resolved: o.resolved ? clip(o.resolved, 400) : null };
  let kind = KINDS.includes(o.kind) ? o.kind : 'blocker';
  const text = clip(redact(o.text || o.question || o.texto || ''), 1200);
  o = { ...o, quote: redact(o.quote || o.cita || ''), blocks: redact(o.blocks || o.bloquea || '') };
  const item = String(o.item || '').match(KEY_RE)?.[0] || (String(text).match(KEY_RE) || [])[0] || '';
  const it = { kind, item, for: clip(o.for || o.para || '', 60), text, quote: clip(o.quote || o.cita || '', 600), blocks: clip(o.blocks || o.bloquea || '', 300), notes: [] };
  if (o.invalid) it.notes.push('El paso no usó el formato <raise>{json}</raise>: queda dentro de la app.');
  if (!text) return null;
  if (kind === 'question') {
    const q = norm(it.quote);
    const hit = `${text} ${it.blocks}`.match(MACHINERY);
    if (hit) { it.state = 'review'; it.notes.push(`Menciona «${hit[0].trim()}», que suele ser del funcionamiento del flujo: no sale al ticket salvo que la lleves vos.`); }
    else if (!q) { it.state = 'review'; it.notes.push('Sin cita del ticket: revisala antes de llevarla al ticket.'); }
    else if (q.length < MIN_QUOTE || q.split(' ').length < 4) { it.state = 'review'; it.notes.push('La cita es demasiado corta para mostrar de dónde sale la duda.'); }
    else if (!norm(corpus).includes(q)) { it.state = 'review'; it.notes.push('La cita no aparece en los datos que recibió el paso: revisala antes de llevarla al ticket.'); }
    if (!it.for) it.for = 'PO';
  }
  return it;
}

const prefix = { question: 'q', blocker: 'b', check: 'c', action: 'a', lesson: 'l' };

/** Records what a step raised in a run. Returns the entries for the step's run record. */
export function recordRaised(flowId, { runId, stepId, stepName, raised, corpus }) {
  const list = store.getItems(flowId);
  const seen = []; const journal = [];
  for (const o of raised) {
    const c = classify(o, corpus);
    if (!c) continue;
    if (c.ref) {
      const ex = list.find((x) => x.id === c.ref);
      if (!ex || ex.stepId !== stepId) continue; // a step only speaks for what IT raised
      if (c.resolved) {
        if (['resolved', 'dismissed'].includes(ex.state)) { /* nothing */ }
        else if (ex.kind === 'question' && ex.published) {
          // closing a question that is on the ticket is announced publicly: a person confirms it first
          if (ex.state !== 'review') { ex.state = 'review'; ex.reason = `El paso dice que ya no aplica: ${c.resolved}. Confirmalo para avisarlo en el ticket.`; ex.changedAt = now(); journal.push(j('item.state', ex, runId, stepName, `open → review: ${c.resolved}`)); }
        } else { ex.state = 'resolved'; ex.reason = c.resolved; ex.resolvedAt = now(); journal.push(j('item.resolved', ex, runId, stepName, c.resolved)); }
      }
      else { ex.lastSeen = now(); ex.runIds = [...new Set([...(ex.runIds || []), runId])].slice(-20); }
      seen.push({ id: ex.id, kind: ex.kind, text: ex.text, state: ex.state, again: !c.resolved });
      continue;
    }
    const id = `${prefix[c.kind]}_${fp(c.kind, c.item, c.text)}`;
    let ex = list.find((x) => x.id === id);
    if (ex) {
      ex.lastSeen = now(); ex.runIds = [...new Set([...(ex.runIds || []), runId])].slice(-20);
      if (['resolved'].includes(ex.state)) { ex.state = c.state || 'open'; ex.reopenedAt = now(); if (ex.published) delete ex.published; journal.push(j('item.reopened', ex, runId, stepName)); }
    } else {
      ex = { id, ...c, state: c.state || 'open', stepId, step: stepName, firstSeen: now(), lastSeen: now(), runIds: [runId] };
      list.push(ex);
      journal.push(j('item.raised', ex, runId, stepName));
    }
    seen.push({ id: ex.id, kind: ex.kind, text: ex.text, state: ex.state, notes: c.notes });
  }
  prune(list);
  store.saveItems(flowId, list);
  store.appendJournal(flowId, journal);
  return seen;
}

/** At most MAX_ITEMS: the oldest closed ones go first (open ones are never dropped). */
const MAX_ITEMS = 1000;
const MAX_OPEN_PER_STEP = 50; // a step that rewords the same problem every run must not bury the rest
function prune(list) {
  const openBy = new Map();
  for (const it of list) if (it.kind !== 'question' && ['open', 'review'].includes(it.state) && it.changedBy !== 'user') { if (!openBy.has(it.stepId)) openBy.set(it.stepId, []); openBy.get(it.stepId).push(it); }
  for (const arr of openBy.values()) {
    if (arr.length <= MAX_OPEN_PER_STEP) continue;
    arr.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    for (const it of arr.slice(0, arr.length - MAX_OPEN_PER_STEP)) { it.state = 'resolved'; it.resolvedAt = now(); it.reason = `Reemplazado: el paso tiene más de ${MAX_OPEN_PER_STEP} ítems abiertos; quedan los más recientes.`; }
  }
  if (list.length <= MAX_ITEMS) return;
  const closed = list.filter((x) => ['resolved', 'dismissed', 'answered'].includes(x.state)).sort((a, b) => (a.resolvedAt || a.changedAt || a.lastSeen || 0) - (b.resolvedAt || b.changedAt || b.lastSeen || 0));
  const drop = new Set(closed.slice(0, list.length - MAX_ITEMS).map((x) => x.id));
  for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i].id)) list.splice(i, 1);
}

const j = (type, it, runId, step, detail) => ({ at: now(), type, runId: runId || null, step: step || it.step || null, ticket: it.item || null, item: it.id, kind: it.kind, text: clip(redact(it.text), 300), ...(detail ? { detail: clip(redact(detail), 300) } : {}) });

/** After a run: an open item whose step really ran OK in this run, FOR THE SAME TICKET, and did not raise it again
 *  is resolved (with the reason). Never: questions (only the step's explicit "resolved" or a person closes them),
 *  items a person changed, steps that were pinned or skipped, or items of a ticket this run was not about. */
export function settleRun(flowId, run, flow) {
  const list = store.getItems(flowId);
  const journal = [];
  const keys = new Set(String(run.input || '').match(KEY_RE) || []);
  for (const it of list) {
    if (!['open', 'review'].includes(it.state) || it.kind === 'question') continue;
    const st = run.steps?.[it.stepId];
    if (!st || st.status !== 'success' || st.pinned || st.skipReason || (it.runIds || []).includes(run.id)) continue;
    if (it.item ? !keys.has(it.item) : keys.size > 0 && !(it.runIds || []).length) continue;
    if (it.item === '' && Object.keys(run.steps || {}).some((k) => k.startsWith(`${it.stepId}~`))) continue; // «para cada»: another element
    const name = flow.steps.find((s) => s.id === it.stepId)?.name || it.step;
    // a question already on the ticket is never closed by silence: the app shows it and a person decides
    if ((it.kind === 'question' && it.published) || it.changedBy === 'user') { it.notRaisedIn = run.id; continue; }
    it.state = 'resolved'; it.resolvedAt = now(); it.reason = `«${name}» corrió de nuevo (${run.id}) y ya no lo levanta.`;
    journal.push(j('item.resolved', it, run.id, name, it.reason));
  }
  store.saveItems(flowId, list);
  store.appendJournal(flowId, journal);
}

const pubHash = (it) => fp('pub', it.item, `${it.for} ${it.text}`);
/** What «Al terminar» may publish: open questions not published yet (or changed), and published ones resolved since. */
export function publishable(flowId) {
  const list = store.getItems(flowId);
  const pick = (it) => ({ id: it.id, ticket: it.item, for: it.for, text: it.text, quote: it.quote, blocks: it.blocks, ...(it.reason ? { reason: it.reason } : {}) });
  return {
    questions: list.filter((it) => it.kind === 'question' && it.state === 'open' && it.published?.hash !== pubHash(it)).map(pick),
    resolved: list.filter((it) => it.kind === 'question' && ['resolved', 'answered'].includes(it.state) && it.published && !it.published.closedNoticeAt).map(pick),
  };
}

/** «Al terminar» prints `AFS-PUBLISHED <nonce> <id> [ref]` / `AFS-CLOSED <nonce> <id> [ref]` for what it really
 *  published. Only counted when it ended OK, the nonce is this run's (env AFS_PUBLISH_NONCE: text echoed from a step
 *  or from Jira cannot know it) and the id was among the ones handed to it. */
export function markPublished(flowId, runId, stdout, { nonce, delivered, ok = true } = {}) {
  if (!ok || !nonce) return;
  const list = store.getItems(flowId);
  const journal = [];
  for (const m of String(stdout || '').matchAll(/^AFS-(PUBLISHED|CLOSED)\s+(\S+)\s+([a-z]_[0-9a-f]{10})(?:\s+(\S+))?\s*$/gm)) {
    if (m[2] !== nonce) continue;
    const want = m[1] === 'PUBLISHED' ? delivered?.questions : delivered?.resolved;
    if (!want?.has(m[3])) continue;
    const it = list.find((x) => x.id === m[3]);
    if (!it) continue;
    if (m[1] === 'PUBLISHED') { it.published = { at: now(), runId, ref: m[4] || null, hash: pubHash(it) }; journal.push(j('item.published', it, runId, '«Al terminar»', m[4])); }
    else if (it.published) { it.published.closedNoticeAt = now(); journal.push(j('item.closed', it, runId, '«Al terminar»', m[4])); }
  }
  store.saveItems(flowId, list);
  store.appendJournal(flowId, journal);
}

/** The user changes an item's state from the app (promote a reviewed question, dismiss, reopen). */
export function setState(flowId, id, state, reason = '') {
  if (!STATES.includes(state)) throw Object.assign(new Error(`Estado inválido: ${state}`), { status: 400, code: 'BAD_STATE' });
  const list = store.getItems(flowId);
  const it = list.find((x) => x.id === id);
  if (!it) throw Object.assign(new Error('Ítem no encontrado'), { status: 404, code: 'ITEM_NOT_FOUND' });
  const from = it.state;
  it.state = state; it.reason = clip(reason, 400) || it.reason; it.changedAt = now(); it.changedBy = 'user';
  store.saveItems(flowId, list);
  store.appendJournal(flowId, { at: now(), type: 'item.state', by: 'user', ticket: it.item || null, item: it.id, kind: it.kind, text: clip(it.text, 300), detail: `${from} → ${state}${reason ? `: ${clip(reason, 200)}` : ''}` });
  return it;
}

/** Open items a step raised before, for its prompt (so it refers to them by id instead of rewording them). */
export function openForStep(flowId, stepId) {
  return store.getItems(flowId).filter((it) => it.stepId === stepId && ['open', 'review'].includes(it.state)).slice(-20);
}

// ---------- the journal: what a step did outside its head ----------
const READ_VERB = /^(get|search|list|fetch|read|lookup|query|find|describe|view)/i;
const SHELL_WRITE = /\bgit\s+(?:commit|push|merge|tag|rebase|reset|checkout\s+-b|branch\s+-[dD])\b|\b(?:bb|gh)(?:-pr)?(?:\.mjs)?\b[^\n]*\b(?:open-pr|pr\s+create|create)\b|bb-pr\.mjs|\bnpm\s+publish\b|\bcurl\b[^\n]*-X\s*(?:POST|PUT|DELETE|PATCH)/i;
const tickets = (v) => [...new Set(JSON.stringify(v ?? '').match(KEY_RE) || [])].slice(0, 5);

/** Turns a step's events into journal entries: external writes (MCP), git/PR commands, files written (grouped). */
export function journalFromEvents(events = [], { runId, step }) {
  const results = new Map(events.filter((e) => e.kind === 'tool_result' && e.id).map((e) => [e.id, e]));
  const out = []; const files = new Set();
  for (const e of events) {
    if (e.kind !== 'tool_use' || !e.name) continue;
    const res = e.id ? results.get(e.id) : null;
    const ok = res ? !res.isError : null;
    if (e.name.startsWith('mcp__')) {
      const short = e.name.split('__').pop();
      if (READ_VERB.test(short) || /^atlassianUserInfo$/.test(short)) continue;
      out.push({ at: e.t || now(), type: 'external', runId, step, tool: e.name, what: short, ticket: tickets(e.input)[0] || null, tickets: tickets(e.input), ok, detail: clip(res?.content || '', 300) });
    } else if (['Bash', 'PowerShell'].includes(e.name)) {
      const cmd = String(e.input?.command || '');
      if (!SHELL_WRITE.test(cmd)) continue;
      out.push({ at: e.t || now(), type: 'command', runId, step, tool: e.name, what: clip(cmd.split('\n')[0], 200), ticket: tickets(cmd)[0] || null, ok, detail: clip(res?.content || '', 300) });
    } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.name) && ok !== false) {
      const p = e.input?.file_path || e.input?.notebook_path; if (p) files.add(String(p));
    }
  }
  if (files.size) out.push({ at: now(), type: 'files', runId, step, what: `${files.size} archivo(s) escritos`, files: [...files].slice(0, 50), ticket: tickets([...files])[0] || null, ok: true });
  return out.map(redactDeep);
}

/** The tickets view: every work item key the flow touched, with its questions, items and log. */
export function ticketsView(flowId, runs = []) {
  const items = store.getItems(flowId);
  const journal = store.readJournal(flowId);
  const m = new Map();
  const get = (k) => { if (!m.has(k)) m.set(k, { key: k, items: [], journal: 0, lastAt: 0, runs: new Set() }); return m.get(k); };
  for (const it of items) if (it.item) { const t = get(it.item); t.items.push(it); t.lastAt = Math.max(t.lastAt, it.lastSeen || 0); }
  for (const e of journal) for (const k of e.tickets || (e.ticket ? [e.ticket] : [])) { const t = get(k); t.journal++; t.lastAt = Math.max(t.lastAt, e.at || 0); if (e.runId) t.runs.add(e.runId); }
  for (const r of runs) for (const k of new Set(String(r.input || '').match(KEY_RE) || [])) { const t = get(k); t.runs.add(r.id); t.lastAt = Math.max(t.lastAt, r.startedAt || 0); }
  const byRun = new Map(runs.map((r) => [r.id, r]));
  return [...m.values()].map((t) => {
    const rs = [...t.runs].map((id) => byRun.get(id)).filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const count = (k, s) => t.items.filter((x) => x.kind === k && (!s || s.includes(x.state))).length;
    return {
      key: t.key, lastAt: t.lastAt, journal: t.journal,
      questions: { open: count('question', ['open']), review: count('question', ['review']), published: t.items.filter((x) => x.kind === 'question' && x.published && x.state === 'open').length, closed: count('question', ['resolved', 'answered', 'dismissed']) },
      blockers: count('blocker', ['open', 'review']), checks: count('check', ['open', 'review']), actions: count('action', ['open', 'review']), lessons: count('lesson', ['open', 'review']),
      lastRun: rs[0] ? { id: rs[0].id, status: rs[0].status, startedAt: rs[0].startedAt } : null, runs: rs.length,
    };
  }).sort((a, b) => b.lastAt - a.lastAt);
}
