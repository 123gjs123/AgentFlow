// HTTP + WebSocket server.
// - UI API (/api/*): loopback only, same-origin, JSON-only writes (blocks CSRF / DNS rebinding).
// - External API (/api/ext/*): token required (Bearer, X-AFS-Token or ?token=). Usable from scripts,
//   Jenkins, webhooks, the `afs` CLI and the MCP server. Reachable from other hosts only if HOST is set.
import './certs.js'; // first: trust the OS certificate store (corporate TLS proxies)
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as engine from './engine.js';
import { listAgents, listSkills } from './catalog.js';
import * as SK from './skills.js';
import * as TOK from './tokens.js';
import { lastInit, lastRateLimit, probeInit, claudeBin } from './claude.js';
import { previewStep, definitionFile } from './context.js';
import * as integ from './integrations.js';
import { SOURCE_TYPES, checkSource } from './sources.js';
import { exportFlow, importBundle, quarantineProblem, slug, executableParts, readFlowFolder } from './bundle.js';
import { parseSchema } from './schema.js';
import { needsPreflight } from './preflight.js';
import * as CRED from './credentials.js';
import * as attention from './attention.js';
import * as review from './review.js';
import * as W from './watch.js';
import * as OUT from './outputs.js';
import * as POL from './policies.js';
import * as notify from './notify.js';
import { checkSystem } from './system.js';
import { cachedPreflight, setOnChecked } from './preflight.js';
import { REQ_TYPES, preflight, preflightMessage, suggestRequirements, createFromTemplate, clearPreflightCache } from './preflight.js';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
// Imports may carry chats and run history: bigger limit for that route only.
const json5mb = express.json({ limit: '5mb' }); const json50mb = express.json({ limit: '50mb' });
app.use((req, res, next) => (req.path === '/api/flows/import' || req.path === '/api/skills/inspect' ? json50mb : json5mb)(req, res, next)); // a 20 MB zip in base64 ≈ 27 MB
app.use(express.text({ type: ['text/*'], limit: '5mb' }));
// Body parse errors (malformed JSON, too large): JSON error without stack traces or local paths.
app.use((err, req, res, next) => {
  if (!err) return next();
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ error: status === 413 ? 'Cuerpo demasiado grande (máx. 5 MB)' : `Cuerpo inválido: ${err.type === 'entity.parse.failed' ? 'JSON mal formado' : err.message}`, code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST' });
});

const isLoopback = (ip = '') => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const okHost = (h = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
// A tunnel/reverse proxy (ngrok, cloudflared, nginx…) connects from loopback and may rewrite Host to localhost:
// any forwarding header means the request really comes from elsewhere -> never treat it as local.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'x-forwarded', 'forwarded', 'via', 'x-real-ip', 'x-client-ip', 'x-cluster-client-ip', 'cf-connecting-ip', 'true-client-ip', 'x-original-host', 'ngrok-trace-id'];
const proxied = (headers = {}) => PROXY_HEADERS.some((h) => headers[h] !== undefined);
const isLocalReq = (req) => isLoopback(req.socket.remoteAddress) && okHost(req.headers.host) && !proxied(req.headers);

const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (!res.headersSent) res.json(r ?? { ok: true }); }
  catch (e) {
    res.locals.code = e.code || null;
    const status = e.status || (e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError ? 500 : 400);
    if (status >= 500) console.error(e);
    res.status(status).json({ error: e.message, code: e.code || CODES[status] || 'ERROR', ...(Array.isArray(e.widens) ? { widens: e.widens } : {}), ...(Array.isArray(e.conflicts) ? { conflicts: e.conflicts } : {}) });
  }
};
const CODES = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE', 500: 'INTERNAL' };
const fail = (status, msg, code) => Object.assign(new Error(msg), { status, code });
const need = (id) => {
  const f = store.getFlow(id);
  if (f) return f;
  const link = store.linkOf(id); // spec 09: a linked folder that is not there right now (never "not found": it comes back)
  if (link) { const st = store.linkState(link.id); throw Object.assign(fail(409, `${st.status === 'invalid' ? 'El flow.json vinculado no es válido' : st.status === 'forbidden' ? 'La carpeta vinculada no está permitida' : 'La carpeta del flujo no está disponible'}: ${link.path}${st.error ? ` (${st.error})` : ''}`, 'FLOW_UNAVAILABLE'), { path: link.path }); }
  throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND');
};

// ============ external API (token) ============
const ext = express.Router();
ext.use((req, res, next) => {
  const at = Date.now();
  res.on('finish', () => integ.logInbound({
    at, method: req.method, path: req.path.slice(0, 200), source: String(req.body?.source || req.query.source || '').slice(0, 20) || null,
    status: res.statusCode, code: res.locals.code || null, remoteIp: req.socket.remoteAddress, forwardedFor: req.get('x-forwarded-for') || null,
    userAgent: (req.get('user-agent') || '').slice(0, 120), runId: res.locals.runId || null, dryRun: !!res.locals.dryRun, scope: res.locals.scope || null,
  }));
  next();
});
// spec 11: the admin token (config.json, every flow, can be disabled) or a flow token (that flow only)
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
ext.use((req, res, next) => {
  const auth = String(req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-afs-token') || req.query.token || '');
  const cfg = store.getConfig();
  if (auth && crypto.timingSafeEqual(digest(auth), digest(cfg.token))) {
    if (cfg.adminDisabled) { res.locals.code = 'ADMIN_DISABLED'; return res.status(401).json({ error: 'El token de administración está desactivado. Usa el token del flujo (pestaña 🔌 Invocar de un step) o reactívalo en Ayuda → Invocar desde fuera.', code: 'ADMIN_DISABLED' }); }
    req.scope = { admin: true }; res.locals.scope = 'admin'; return next();
  }
  const flowId = auth ? TOK.resolve(auth) : null;
  if (flowId && store.getFlow(flowId)) { req.scope = { flowId }; res.locals.scope = flowId; return next(); }
  return res.status(401).json({ error: 'Token inválido o ausente. Usa Authorization: Bearer <token> (el del flujo: pestaña 🔌 Invocar de un step).', code: 'UNAUTHORIZED' });
});
// every /flows/:flow/* route goes through here: a flow token opens its own flow only (an unknown one is 403 too: no enumeration)
ext.param('flow', (req, res, next, ref) => {
  const f = store.findFlow(ref);
  if (req.scope?.flowId && f?.id !== req.scope.flowId) {
    const mine = store.getFlow(req.scope.flowId);
    res.locals.code = 'FLOW_FORBIDDEN';
    return res.status(403).json({ error: `Este token es del flujo «${mine?.name || req.scope.flowId}» y no da acceso a otro flujo. Usa el token de ese flujo o el de administración.`, code: 'FLOW_FORBIDDEN' });
  }
  next();
});
const extFlow = (x) => { const f = store.findFlow(x); if (!f) throw fail(404, `Flujo no encontrado: ${x}`, 'FLOW_NOT_FOUND'); return f; };
const extRun = (flow, id) => { const r = engine.getRunLive(flow.id, id); if (!r) throw fail(404, 'Ejecución no encontrada', 'RUN_NOT_FOUND'); return r; };
const inputOf = (body, stepped = false, stepInPath = false) => {
  if (typeof body === 'string') return body;
  if (body && typeof body.input === 'string') return body.input;
  if (body && body.input !== undefined) return JSON.stringify(body.input, null, 2);
  const rest = { ...(body || {}) }; for (const k of [...(stepInPath ? [] : ['step']), 'wait', 'timeoutSec', 'source', 'vars', 'usePins', 'deadlineSec', 'dryRun', 'breakpoints']) delete rest[k];
  if (stepped) { for (const k of ['scope', 'mode']) if (scopeWord(rest[k])) delete rest[k]; if (fromFlag(rest.from)) delete rest.from; }
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''; // raw webhook payloads (Bitbucket, Jenkins…)
};
const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const truthy = (v) => v === true || v === 1 || /^(1|true|yes|si|sí)$/i.test(String(v ?? ''));

ext.get('/ping', wrap((req) => ({ ok: true, app: 'agent-flow-studio', scope: req.scope?.admin ? 'admin' : 'flow', ...(req.scope?.flowId ? { flowId: req.scope.flowId } : {}) })));
ext.get('/flows', wrap((req) => store.listFlows().filter((f) => !req.scope?.flowId || f.id === req.scope.flowId).map((f) => {
  const full = store.getFlow(f.id);
  return { id: f.id, name: f.name, description: full.description, vars: Object.keys(full.vars || {}), steps: store.ensureSlugs(structuredClone(full)).steps.map((s) => ({ id: s.id, slug: s.slug, name: s.name, kind: s.kind })) };
})));
// Run a flow or one step. vars are per run (never saved into the flow). External runs ignore pins unless usePins.
// Spec 12: a step is addressed by id, slug or name; scope "only" (default) runs just it, "from" it and everything after.
// Body keys count as the scope option only with OUR values (scope/mode "only"|"from", from: true); any other value is
// data of a raw payload (scope:"repository", from:"alice@…") and stays in the input. The query string is always an option.
const scopeWord = (v) => (typeof v === 'string' && ['only', 'from'].includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);
const fromFlag = (v) => v === true || v === 1 || v === 'true';
const scopeOf = (req, body) => {
  if (req.query.scope !== undefined) { const v = scopeWord(String(req.query.scope)); if (!v) throw fail(400, '"scope" debe ser "only" o "from"', 'BAD_SCOPE'); return v; }
  if (body.input !== undefined) {
    // a body with "input" is an options body: a typo must not silently run one step instead of the chain
    if (body.scope !== undefined && !scopeWord(body.scope)) throw fail(400, '"scope" debe ser "only" o "from"', 'BAD_SCOPE');
    if (body.from !== undefined && typeof body.from !== 'boolean' && !/^(0|1|true|false)$/i.test(String(body.from))) throw fail(400, '"from" debe ser true o false', 'BAD_SCOPE');
    if (body.mode !== undefined && !scopeWord(body.mode) && !['wait', 'async-poll', 'fire-and-forget'].includes(String(body.mode))) throw fail(400, '"mode" debe ser "only" o "from"', 'BAD_SCOPE');
    if (scopeWord(body.scope) || scopeWord(body.mode)) return scopeWord(body.scope) || scopeWord(body.mode);
    return truthy(body.from) || truthy(req.query.from) ? 'from' : 'only';
  }
  return scopeWord(body.scope) || scopeWord(body.mode) || (fromFlag(body.from) || truthy(req.query.from) ? 'from' : 'only');
};
// ?format=text (snippets without jq): 200 = success (body: the result), 202 = still going (body: runId),
// 422 = ended in another state (body: result + error). X-AFS-Run-Id / X-AFS-Status carry the details.
const asText = (fn) => async (req, res) => {
  if (String(req.query.format || '') !== 'text') return fn(req, res);
  const r = await fn(req, res);
  if (!r || typeof r !== 'object' || !r.runId || !r.status || r.dryRun) return r; // errors, dry runs, gates: JSON
  const going = ['running', 'queued'].includes(r.status) || r.timedOut;
  res.set('X-AFS-Run-Id', String(r.runId)); res.set('X-AFS-Status', String(r.status));
  res.status(going ? 202 : r.status === 'success' ? 200 : 422).type('text/plain; charset=utf-8');
  res.send(going ? `${r.runId}\n` : r.status === 'success' ? `${r.result ?? ''}\n` : [r.result, `El run ${r.runId} terminó en ${r.status}${r.error ? `: ${r.error}` : ''}`].filter(Boolean).join('\n\n') + '\n');
  return undefined;
};
const extRunRoute = (stepInPath) => wrap(asText(async (req, res) => {
  const flow = extFlow(req.params.flow);
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const stepRef = stepInPath ? req.params.step : body.step || req.query.step;
  // scope / from / mode are options only when a step is named (a raw webhook payload may carry those keys)
  const scope = stepRef ? scopeOf(req, body) : scopeWord(String(req.query.scope ?? '')) === 'from' || truthy(req.query.from) ? 'from' : 'only';
  let only = null; let from = null;
  if (stepRef) { const r = store.findStep(flow, stepRef, { slugWins: stepInPath }); if (!r.step) throw fail(r.status, r.error, r.code); if (scope === 'from') from = r.step.id; else only = r.step.id; }
  else if (scope === 'from') throw fail(400, '"scope":"from" necesita un step', 'STEP_REQUIRED');
  const runSet = only || (from ? engine.fromSetOf(flow, from) : null); // what the checks look at
  if (body.vars !== undefined && (typeof body.vars !== 'object' || Array.isArray(body.vars) || body.vars === null)) throw fail(400, '"vars" debe ser un objeto', 'BAD_VARS');
  const wait = truthy(body.wait ?? req.query.wait);
  const waitSec = Math.min(Number(body.timeoutSec || req.query.timeoutSec || 900) || 900, 4 * 3600);
  const respond = async (runId, extra = {}) => {
    if (!wait) return { runId, status: engine.getRunLive(flow.id, runId)?.status || 'running', statusUrl: `/api/ext/flows/${flow.id}/runs/${runId}`, eventsUrl: `/api/ext/flows/${flow.id}/runs/${runId}/events`, ...extra };
    const run = await engine.waitRun(flow.id, runId, waitSec * 1000);
    const sum = { ...engine.runSummary(store.getFlow(flow.id), run), ...extra };
    if (run.waitTimedOut || run.status === 'running') { res.status(202); sum.timedOut = true; }
    return sum;
  };
  const input = inputOf(req.body, !!stepRef, stepInPath);
  const key = String(req.get('idempotency-key') || '').trim();
  if (key.length > 200) throw fail(400, 'Idempotency-Key: máximo 200 caracteres', 'BAD_IDEMPOTENCY_KEY');
  const bodyHashOf = () => crypto.createHash('sha256').update(stableJson({ input, only, ...(from ? { from } : {}), vars: body.vars || null, usePins: truthy(body.usePins), breakpoints: truthy(body.breakpoints) })).digest('hex');
  // Replay what is still going (running, paused at a break) or went well: a retry after a failure must run again.
  const REPLAYABLE = ['running', 'paused', 'queued', 'success'];
  if (truthy(body.dryRun ?? req.query.dryRun)) {
    const problem0 = engine.externalRunProblem(flow, { only, from, vars: body.vars });
    if (problem0) throw fail(problem0.status, problem0.error, problem0.code);
    let wouldReplay = null;
    if (key) {
      const prev = store.getIdem(`${flow.id}:${key}`);
      if (prev && prev.bodyHash !== bodyHashOf()) throw fail(409, 'Esa Idempotency-Key ya se usó con otro contenido', 'IDEMPOTENCY_CONFLICT');
      if (prev && REPLAYABLE.includes(engine.getRunLive(flow.id, prev.runId)?.status)) wouldReplay = prev.runId;
    }
    // Every pre-start check, nothing started, idempotency key not recorded (spec 17 INT-10).
    res.locals.dryRun = true;
    const usePins = truthy(body.usePins);
    const fset = from ? engine.fromSetOf(flow, from) : null;
    const steps = only ? flow.steps.filter((s) => s.id === only) : fset ? flow.steps.filter((s) => fset.has(s.id)) : flow.steps;
    const warnings = [];
    const fromP = from ? engine.fromProblem(flow, from, { usePins }) : null;
    if (!input) warnings.push('input vacío');
    for (const k of Object.keys(body.vars || {})) if (!(k in (flow.vars || {}))) warnings.push(`la variable "${k}" no existe en el flujo`);
    const pf = needsPreflight(flow, runSet) ? await preflight(flow, { only: runSet }) : { ok: true, blocking: [], results: [] };
    return { dryRun: true, ok: pf.ok && !fromP, preflight: { ok: pf.ok, missing: pf.blocking, results: pf.results }, ...(fromP ? { fromProblem: { code: fromP.code, error: fromP.error, missing: fromP.missing } } : {}), scope: stepRef ? scope : 'flow', flow: flow.name, flowId: flow.id, steps: steps.map((s) => s.name), breakpoints: truthy(body.breakpoints) ? steps.filter((s) => s.breakpoint).map((s) => `${s.name} (${s.breakpoint})`) : [], vars: Object.keys({ ...(flow.vars || {}), ...(body.vars || {}) }), input: input.slice(0, 2000), usedPins: usePins ? steps.filter((s) => s.pinned).map((s) => s.name) : [], idempotencyKey: key || null, wouldReplay, warnings };
  }
  let bodyHash = null;
  if (key) {
    if (key.length > 200) throw fail(400, 'Idempotency-Key: máximo 200 caracteres', 'BAD_IDEMPOTENCY_KEY');
    bodyHash = bodyHashOf();
    const prev = store.getIdem(`${flow.id}:${key}`);
    if (prev) {
      if (prev.bodyHash !== bodyHash) throw fail(409, 'Esa Idempotency-Key ya se usó con otro contenido', 'IDEMPOTENCY_CONFLICT');
      const prevRun = engine.getRunLive(flow.id, prev.runId);
      if (prevRun && REPLAYABLE.includes(prevRun.status)) return respond(prev.runId, { idempotentReplay: true });
    }
  }
  const problem = engine.externalRunProblem(flow, { only, from, vars: body.vars });
  if (problem) throw fail(problem.status, problem.error, problem.code);
  { const blocked = await gate(flow, res, runSet); if (blocked) return blocked; }
  const trigger = String(body.source || req.query.source || 'api').slice(0, 20);
  const chain = String(req.get('x-afs-call-chain') || '').split(',').map((x) => x.trim()).filter((x) => /^f_[\w-]{1,60}$/.test(x)).slice(0, 10);
  if (chain.includes(flow.id)) throw fail(409, `Llamada circular entre flujos: ${[...chain, flow.id].map((id) => store.getFlow(id)?.name || id).join(' → ')}`, 'FLOW_RECURSION');
  if (chain.length >= engine.MAX_FLOW_CHAIN) throw fail(409, `Cadena de flujos demasiado larga (máximo ${engine.MAX_FLOW_CHAIN})`, 'FLOW_CHAIN_TOO_DEEP');
  const runId = engine.startRun(flow.id, { input, only, from, trigger, vars: body.vars || null, usePins: truthy(body.usePins), deadlineSec: body.deadlineSec, idempotencyKey: key || null, breakpoints: truthy(body.breakpoints), ...(chain.length ? { callChain: [...chain, flow.id] } : {}) });
  if (key) store.setIdem(`${flow.id}:${key}`, { runId, bodyHash, flowId: flow.id });
  res.locals.runId = runId;
  return respond(runId);
}));
ext.post('/flows/:flow/run', extRunRoute(false));
ext.post('/flows/:flow/steps/:step/run', extRunRoute(true));
ext.get('/flows/:flow/runs/:runId/files/:file', wrap(async (req, res) => { const flow = extFlow(req.params.flow); const f = deliverableFile(flow.id, req.params.runId, req.params.file, req.query.step ? String(req.query.step) : null); await sendFile(res, f); return undefined; }));
ext.post('/flows/:flow/runs/:runId/actions/decide', wrap((req) => { const flow = extFlow(req.params.flow); return decide(flow.id, req.params.runId, req.body); }));
ext.get('/flows/:flow/runs/:runId', wrap(asText((req) => {
  const flow = extFlow(req.params.flow);
  return engine.runSummary(flow, extRun(flow, req.params.runId));
})));
ext.post('/flows/:flow/runs/:runId/cancel', wrap((req) => {
  const flow = extFlow(req.params.flow);
  const run = extRun(flow, req.params.runId);
  if (run.status !== 'running' || !engine.stopRun(flow.id, run.id)) throw fail(409, `La ejecución ya terminó (${run.status})`, 'RUN_FINISHED');
  return { runId: run.id, status: 'stopped' };
}));
// Breaks (spec 18): decision on a paused step. body {action: continue|edit|retry|skip|stop, step?, output?, json?, feedback?}
ext.post('/flows/:flow/runs/:runId/resume', wrap((req) => {
  const flow = extFlow(req.params.flow);
  const b = typeof req.body === 'object' && req.body ? req.body : {};
  const s = b.step ? flow.steps.find((x) => x.id === b.step || x.name.toLowerCase() === String(b.step).toLowerCase()) : null;
  if (b.step && !s) throw fail(404, `Step no encontrado: ${b.step}`, 'STEP_NOT_FOUND');
  return engine.resumeRun(flow.id, req.params.runId, s?.id, b);
}));
ext.get('/flows/:flow/runs/:runId/events', wrap((req) => {
  const flow = extFlow(req.params.flow);
  return engine.runEvents(flow, extRun(flow, req.params.runId), Number(req.query.after) || 0);
}));
// Spec 25: chats only propose. Proposals made through the API wait for confirmation in the app (chat of that step/flow).
const pendingOf = (ans) => { const p = (ans.proposals || []).filter((x) => !x.applied && !x.discarded).map((x) => ({ id: x.id, kind: x.kind || 'step' })); return p.length ? { pendingProposals: p, note: 'Propuestas de cambio al flujo: no se aplican desde fuera; quedan en el chat de la app para que una persona las revise con el flujo detenido.' } : {}; };
// spec 10: 🔔 check the flow's watched sources (optionally one step); on-change actions apply (trigger "api")
ext.post('/flows/:flow/status', wrap(async (req) => {
  const flow = extFlow(req.params.flow);
  const ref = req.query.step || req.body?.step;
  const step = ref ? flow.steps.find((s) => s.id === ref || s.name === ref) : null;
  if (ref && !step) throw fail(404, `Step no encontrado: ${ref}`, 'STEP_NOT_FOUND');
  return W.checkFlow(flow.id, { stepId: step?.id || null, trigger: 'api' });
}));
ext.post('/flows/:flow/ask', wrap(async (req) => {
  const flow = extFlow(req.params.flow);
  const body = typeof req.body === 'object' && req.body ? req.body : { message: String(req.body || '') };
  const message = String(body.message || '').trim();
  if (!message) throw fail(400, 'Falta "message"');
  let ans;
  if (body.step) {
    const s = flow.steps.find((x) => x.id === body.step || x.name.toLowerCase() === String(body.step).toLowerCase());
    if (!s) throw fail(404, `Step no encontrado: ${body.step}`);
    if (s.kind === 'flow') throw fail(409, 'Un step 🔀 Flujo no tiene chat: pregúntale al flujo que invoca', 'FLOW_STEP_NO_CHAT');
    ans = await engine.stepChat(flow.id, s.id, message, { origin: 'api', external: true });
    return { answer: ans.text, routedTo: s.name, status: ans.status, remembered: ans.remembered, ...pendingOf(ans) };
  }
  ans = await engine.globalChat(flow.id, message, { external: true });
  return { answer: ans.text, routedTo: ans.routedTo || 'Flujo general', status: ans.status, ...pendingOf(ans) };
}));
app.use('/api/ext', ext);

// ============ UI access key ============
// Loopback + Host + no forwarding headers is not enough: a TCP forwarder or a proxy that adds no X-Forwarded-For looks
// local. The UI (pages, /api, /ws) also needs a per-installation key, given once via the link the server prints
// (/?k=…, also start.cmd and `afs ui`) and then kept in an HttpOnly SameSite=Strict cookie. /api/ext keeps its token.
const UI_COOKIE = 'afs_ui';
const eqSecret = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = (req) => { for (const c of String(req.headers.cookie || '').split(/;\s*/)) { const i = c.indexOf('='); if (c.slice(0, i) === UI_COOKIE) return c.slice(i + 1); } return ''; };
const hasUiKey = (req) => { const k = store.getConfig().uiKey; return eqSecret(cookieOf(req), k) || eqSecret(req.headers['x-afs-ui'], k); };
const uiUrl = () => `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/?k=${store.getConfig().uiKey}`;
const NEED_KEY_PAGE = `<!doctype html><meta charset="utf-8"><title>Agent Flow Studio</title><body style="font:15px system-ui;background:#0f1115;color:#e6e8ef;padding:40px;max-width:640px">
<h2>Agent Flow Studio</h2><p>Para abrir la interfaz usa el enlace con la clave que muestra la consola al arrancar (<code>npm start</code>), o ábrela con <code>start.cmd</code> o <code>afs ui</code>.</p>
<p style="color:#8b92a7">Después de abrirla una vez, este navegador recuerda la clave y la dirección normal funciona.</p>
<p style="color:#8b92a7">¿Llegaste desde una notificación de Windows? Se abrió en un navegador que todavía no tiene la clave: abre Agent Flow Studio con <code>start.cmd</code> en ese navegador una vez.</p></body>`;
app.use((req, res, next) => {
  if (!isLocalReq(req)) return res.status(403).json({ error: 'Solo accesible desde esta máquina', code: 'FORBIDDEN' });
  if (req.method === 'GET' && typeof req.query.k === 'string' && eqSecret(req.query.k, store.getConfig().uiKey)) {
    res.setHeader('Set-Cookie', `${UI_COOKIE}=${store.getConfig().uiKey}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return res.redirect(302, req.path);
  }
  if (hasUiKey(req)) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Falta la clave de la interfaz: abre el enlace que muestra la consola al arrancar (npm start), start.cmd o afs ui.', code: 'UI_KEY_REQUIRED' });
  res.status(401).type('html').send(NEED_KEY_PAGE);
});

// ============ UI API guard ============
app.use('/api', (req, res, next) => {
  if (!isLocalReq(req)) return res.status(403).json({ error: 'Solo accesible desde esta máquina', code: 'FORBIDDEN' });
  const origin = req.get('origin');
  if (origin && !okHost(origin.replace(/^https?:\/\//, ''))) return res.status(403).json({ error: 'Origen no permitido' });
  // POST is the only "simple" cross-site method: force a JSON content-type so browsers must preflight.
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Se requiere application/json' });
  next();
});

// ----- versions (spec 20) -----
// While a flow is being edited, a snapshot is taken at most every versionEveryMin minutes (default 5; 0 = off).
// The first edit also keeps the state it started from, so the oldest version is "before any change".
const VERSION_DEFAULT_MIN = Number(process.env.AFS_VERSION_EVERY_MIN ?? 5);
function autoVersion(before, after) {
  const every = after.versionEveryMin ?? VERSION_DEFAULT_MIN;
  if (!(every > 0) || store.definitionHash(before) === store.definitionHash(after)) return;
  const list = store.listVersions(after.id);
  if (!list.length) store.saveVersion(before, { label: 'Estado inicial', auto: true });
  const lastAuto = list.find((v) => v.auto);
  if (!lastAuto || Date.now() - lastAuto.at >= every * 60000) {
    if (list[0]?.hash !== store.definitionHash(after)) store.saveVersion(after, { auto: true });
  }
}
app.get('/api/flows/:id/versions', wrap((req) => { need(req.params.id); return store.listVersions(req.params.id); }));
app.post('/api/flows/:id/versions', wrap((req) => store.saveVersion(need(req.params.id), { label: typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label : 'Versión guardada' })));
app.get('/api/flows/:id/versions/:vid', wrap((req) => { need(req.params.id); const v = store.getVersion(req.params.id, req.params.vid); if (!v) throw fail(404, 'Versión no encontrada', 'VERSION_NOT_FOUND'); return v; }));
app.delete('/api/flows/:id/versions/:vid', wrap((req) => { need(req.params.id); store.deleteVersion(req.params.id, req.params.vid); }));
/** Restore: the current state is saved first ("Antes de restaurar…"), so a restore can always be undone. Run state is kept for steps that still exist. */
app.post('/api/flows/:id/versions/:vid/restore', wrap((req) => {
  const cur = need(req.params.id);
  const v = store.getVersion(req.params.id, req.params.vid);
  if (!v) throw fail(404, 'Versión no encontrada', 'VERSION_NOT_FOUND');
  if (engine.isRunning(cur.id)) throw fail(409, 'Hay una ejecución en curso: deténla antes de restaurar una versión', 'RUN_IN_PROGRESS');
  const when = new Date(v.at).toLocaleString('es');
  store.saveVersion(cur, { label: `Antes de restaurar ${v.label || when}` });
  const prev = new Map(cur.steps.map((s) => [s.id, s]));
  const d = v.flow;
  const steps = (d.steps || []).map((s) => { const p = prev.get(s.id); return p ? { ...s, memory: p.memory, lastRun: p.lastRun, pinned: p.pinned, chatSessionId: p.chatSessionId, chatContextHash: p.chatContextHash } : { ...s, memory: [], lastRun: null }; });
  settleSlugs(steps, prev, { rejectIds: false });
  {
    const live = new Map(steps.filter((s) => prev.get(s.id)?.slug).map((s) => [s.slug, s]));
    const clash = steps.find((s) => !prev.has(s.id) && live.has(String(s.id).toLowerCase()) && live.get(String(s.id).toLowerCase()) !== s);
    if (clash) throw fail(409, `No se puede restaurar: el step «${clash.name}» volvería con el id «${clash.id}», que hoy es la dirección (slug) de «${live.get(String(clash.id).toLowerCase()).name}». Cambia ese slug y vuelve a restaurar.`, 'STEP_ID_TAKEN');
  }
  for (const s of cur.steps) if (!steps.some((x) => x.id === s.id)) store.clearChat(cur.id, s.id);
  const next = { ...cur, name: d.name, description: d.description, cwd: d.cwd, vars: d.vars || {}, schedule: d.schedule, runTimeoutSec: d.runTimeoutSec, versionEveryMin: d.versionEveryMin, watchPolling: d.watchPolling, contextSources: d.contextSources, finally: d.finally, requirements: d.requirements, steps, edges: d.edges || [], rev: (cur.rev || 0) + 1 };
  engine.topoLevels(next);
  const saved = store.saveFlow(next);
  engine.syncSchedule(saved); W.syncPolling(saved);
  engine.flowChanged(saved, String(req.get('x-afs-tab') || '').slice(0, 40) || null);
  if (saved.name !== cur.name) engine.bus.emit('msg', { type: 'flows.changed' });
  return saved;
}));

/** Requirements (spec 23): known types and fields only, bounded sizes. */
function cleanRequirements(list) {
  if (!Array.isArray(list)) return undefined;
  return list.filter((r) => r && REQ_TYPES.includes(r.type)).slice(0, 40).map((r) => {
    const o = { id: typeof r.id === 'string' ? r.id.slice(0, 40) : store.uid('rq_'), type: r.type };
    for (const k of ['label', 'name', 'check', 'path', 'url', 'server', 'help']) if (typeof r[k] === 'string' && (r[k].trim() || k === 'check')) o[k] = r[k].slice(0, k === 'help' ? 2000 : 1000);
    if (typeof r.template === 'string' && r.template.trim()) o.template = r.template.slice(0, 5000);
    if (r.optional) o.optional = true;
    if (r.disabled) o.disabled = true;
    return o;
  });
}
/** Blocks the start of a run when a required requirement is missing: 412 + what is missing and how to fix it. */
/**
 * Step fields added by spec 10 (watches) and spec 15 DATA-10 (forEach): sanitised on every save AND on import.
 * Watch ids are unique across the flow (a duplicated step must not share another watch's snapshot).
 */
/** Spec 29: the step's character in the 🏢 Oficina view (name ≤ 40, look = small integers the client maps to its palette). */
const LOOK_KEYS = ['skin', 'hair', 'hairColor', 'top', 'bottom', 'accessory', 'layer'];
function cleanPersona(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  if (typeof p.name === 'string') { const n = p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40); if (n) out.name = n; }
  if (p.look && typeof p.look === 'object' && !Array.isArray(p.look)) {
    const look = {};
    for (const k of LOOK_KEYS) { const v = Number(p.look[k]); if (Number.isInteger(v)) look[k] = Math.min(15, Math.max(0, v)); }
    if (Object.keys(look).length) out.look = look;
  }
  return Object.keys(out).length ? out : null;
}
function cleanStepExtras(steps) {
  const seen = new Set();
  for (const s of steps) {
    if ('persona' in s) { const p = cleanPersona(s.persona); if (p) s.persona = p; else Reflect.deleteProperty(s, 'persona'); }
    // spec 11: a step that calls another flow (by id), optionally one of its steps, with an input template
    if (s.kind === 'flow') {
      s.flowRef = typeof s.flowRef === 'string' && /^f_[\w-]{1,60}$/.test(s.flowRef) ? s.flowRef : '';
      s.flowStep = typeof s.flowStep === 'string' ? s.flowStep.slice(0, 120) : '';
      s.flowScope = s.flowScope === 'from' ? 'from' : 'only';
      s.waitResult = s.waitResult !== false;
      s.flowInput = typeof s.flowInput === 'string' ? s.flowInput.slice(0, 20000) : '';
      if (s.flowVars && typeof s.flowVars === 'object' && !Array.isArray(s.flowVars)) s.flowVars = Object.fromEntries(Object.entries(s.flowVars).filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && typeof v === 'string').slice(0, 50).map(([k, v]) => [k, v.slice(0, 4000)])); else Reflect.deleteProperty(s, 'flowVars');
    } else for (const k of ['flowRef', 'flowStep', 'flowScope', 'waitResult', 'flowInput', 'flowVars']) if (k in s) Reflect.deleteProperty(s, k);
    if ('watches' in s) {
      const w = W.cleanWatches(s.watches);
      if (w?.length) { for (const x of w) { if (seen.has(x.id)) x.id = `w_${crypto.randomBytes(4).toString('hex')}`; seen.add(x.id); } s.watches = w; } else Reflect.deleteProperty(s, 'watches');
    }
    for (const [k, fn] of [['actions', OUT.cleanActions], ['deliverables', OUT.cleanDeliverables]]) if (k in s) { const v = fn(s[k]); if (v?.length) s[k] = v; else Reflect.deleteProperty(s, k); }
    if ('forEach' in s) {
      const fe = s.forEach;
      if (!fe || typeof fe !== 'object' || typeof fe.path !== 'string') { Reflect.deleteProperty(s, 'forEach'); continue; }
      const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || d));
      s.forEach = { path: fe.path.trim().slice(0, 200), ...(typeof fe.from === 'string' && fe.from.trim() ? { from: fe.from.trim().slice(0, 120) } : {}), parallel: n(fe.parallel, 1, 4, 1), max: n(fe.max, 1, 50, 20) };
    }
  }
  return steps;
}
async function gate(flow, res, only = null) {
  const qp = quarantineProblem(flow);
  if (qp) { res.status(qp.status); return { error: qp.error, code: qp.code, reasons: qp.reasons || flow.quarantine?.reasons || [] }; }
  // An invalid JSON schema would only fail after Claude ran (and spent tokens): reject it before starting, like the external API.
  for (const s of (flow.steps || []).filter((x) => !only || (only instanceof Set ? only.has(x.id) : x.id === only))) {
    if (s.kind === 'command' || s.output?.format !== 'json' || !String(s.output.schema || '').trim()) continue;
    const { error } = parseSchema(s.output.schema);
    if (error) { res.status(422); return { error: `Step "${s.name}": el schema JSON de la salida no es válido (${error}). Corrígelo en el step → Salida.`, code: 'INVALID_SCHEMA', step: s.id }; }
  }
  if (!needsPreflight(flow, only)) return null;
  const pf = await preflight(flow, { only });
  if (pf.ok) return null;
  res.status(412);
  return { error: preflightMessage(pf), code: 'PREFLIGHT_FAILED', missing: pf.blocking };
}

/** "Al terminar" (spec 22): one command run after every full run. */
function cleanFinally(f) {
  if (f === null) return null;
  if (!f || typeof f !== 'object') return undefined;
  return { command: String(f.command || '').slice(0, 20000), shell: ['powershell', 'bash', 'cmd'].includes(f.shell) ? f.shell : 'powershell', timeoutSec: Math.min(3600, Math.max(5, Number(f.timeoutSec) || 300)), ...(f.disabled ? { disabled: true } : {}) };
}

// Context sources (spec 21): only known types and fields, bounded sizes.
function cleanSources(list) {
  if (!Array.isArray(list)) return undefined;
  return list.filter((s) => s && SOURCE_TYPES.includes(s.type)).slice(0, 50).map((s) => {
    const o = { id: typeof s.id === 'string' ? s.id.slice(0, 40) : store.uid('cs_'), type: s.type };
    for (const k of ['label', 'path', 'url', 'ref', 'note']) if (typeof s[k] === 'string' && s[k].trim()) o[k] = s[k].slice(0, k === 'note' ? 500 : 2000);
    if (s.children) o.children = true;
    if (s.disabled) o.disabled = true;
    return o;
  });
}

// ----- flows -----
// Arrows keep only known fields (spec 18): sides on the boxes, label, condition and the JSON field they carry.
const EDGE_WHEN = ['always', 'route', 'contains', 'notContains', 'regex', 'json'];
function cleanEdge(e) {
  const out = { id: String(e.id || store.uid('e_')), source: e.source, target: e.target };
  for (const k of ['sourceHandle', 'targetHandle']) if (typeof e[k] === 'string' && /^(in|out)-(top|right|bottom|left)$/.test(e[k])) out[k] = e[k];
  if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim().slice(0, 80);
  if (typeof e.pick === 'string' && e.pick.trim()) out.pick = e.pick.trim().slice(0, 200);
  if (e.when && typeof e.when === 'object' && EDGE_WHEN.includes(e.when.type) && e.when.type !== 'always') {
    const w = { type: e.when.type };
    for (const k of ['value', 'pattern', 'flags', 'path', 'op']) if (e.when[k] !== undefined && e.when[k] !== '') w[k] = e.when[k];
    if (typeof e.when.from === 'string' && e.when.from.trim() && e.when.type !== 'route') w.from = e.when.from.trim().slice(0, 120);
    out.when = w;
  }
  return out;
}
app.get('/api/flows', wrap(() => store.listFlows({ all: true })));
app.post('/api/flows', wrap((req) => {
  const f = store.newFlow(typeof req.body?.name === 'string' ? req.body.name : undefined);
  if (req.body?.template === 'demo') {
    const a = store.newStep({ name: 'Analizar requerimiento', kind: 'role', role: 'Eres un QA analista senior. Detectas ambigüedades y riesgos.', task: 'Analiza el requerimiento del input y lista: objetivo, reglas de negocio, riesgos y preguntas abiertas.' });
    const b = store.newStep({ name: 'Diseñar casos', kind: 'skill', skillRef: 'qa-test-architect', task: 'Con el análisis previo, diseña casos de prueba priorizados por riesgo (Gherkin breve).' });
    const c = store.newStep({ name: 'Revisión adversarial', kind: 'skill', skillRef: 'qa-adversarial', task: 'Critica los casos diseñados: huecos, aserciones débiles, negativos faltantes.' });
    f.steps.push(a, b, c);
    f.edges.push({ id: store.uid('e_'), source: a.id, target: b.id }, { id: store.uid('e_'), source: b.id, target: c.id });
  }
  const saved = store.saveFlow(f);
  engine.bus.emit('msg', { type: 'flows.changed' });
  return saved;
}));
app.post('/api/flows/generate', wrap(async (req) => {
  const description = String(req.body?.description || '').trim();
  if (description.length < 10) throw fail(400, 'Describe el flujo con un poco más de detalle');
  return engine.generateFlow(description, { skills: listSkills(req.body?.cwd), agents: listAgents(req.body?.cwd) });
}));
app.get('/api/flows/:id', wrap((req) => need(req.params.id)));
app.put('/api/flows/:id', wrap((req, res) => {
  const cur = need(req.params.id);
  const body = req.body || {};
  // Optimistic concurrency (tabs): a save based on an older revision gets 409 + the current flow, and the tab merges.
  if (body.baseRev !== undefined && Number(body.baseRev) !== (cur.rev || 0)) {
    res.status(409);
    return { error: 'El flujo cambió en otra pestaña o por otra acción: se combinan los cambios', code: 'FLOW_CONFLICT', flow: cur };
  }
  // Server-managed fields are never overwritten by the UI.
  const byId = new Map(cur.steps.map((s) => [s.id, s]));
  if (body.steps !== undefined && !Array.isArray(body.steps)) throw fail(400, '"steps" debe ser una lista', 'BAD_REQUEST');
  if (body.edges !== undefined && !Array.isArray(body.edges)) throw fail(400, '"edges" debe ser una lista', 'BAD_REQUEST');
  if (body.vars !== undefined && (typeof body.vars !== 'object' || body.vars === null || Array.isArray(body.vars))) throw fail(400, '"vars" debe ser un objeto', 'BAD_VARS');
  for (const k of ['name', 'description', 'cwd']) if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') throw fail(400, `"${k}" debe ser texto`, 'BAD_REQUEST');
  if (body.workspace !== undefined && body.workspace !== null && !['own', 'home'].includes(body.workspace)) throw fail(400, '"workspace" debe ser "own" o "home"', 'BAD_REQUEST');
  const steps = (body.steps || []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string').map((s) => ({ ...s, contextSources: cleanSources(s.contextSources) })).map((s) => {
    const prev = byId.get(s.id);
    return prev ? { ...s, memory: prev.memory, lastRun: prev.lastRun, pinned: prev.pinned, chatSessionId: prev.chatSessionId, chatContextHash: prev.chatContextHash } : store.newStep({ ...s, pinned: undefined });
  });
  // spec 30: one coordinator per flow: the one just marked wins over the previous one
  {
    const marked = steps.filter((s) => s.coordinator === true);
    const keep = marked.length > 1 ? marked.find((s) => !byId.get(s.id)?.coordinator) || marked[0] : marked[0];
    for (const s of steps) if (s !== keep && 'coordinator' in s) Reflect.deleteProperty(s, 'coordinator');
  }
  cleanStepExtras(steps);
  // spec 12: the slug is managed by the server (PUT …/steps/:id/slug changes it). A saved flow never moves it:
  // existing steps keep theirs (stable across renames, other tabs, undo); new ones (duplicates, "Mis steps") get a free one.
  settleSlugs(steps, byId);
  const ids = new Set(steps.map((s) => s.id));
  for (const s of cur.steps) if (!ids.has(s.id)) store.clearChat(cur.id, s.id); // no orphaned step chats
  const edges = (body.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map(cleanEdge);
  const next = { ...cur, name: body.name ?? cur.name, description: body.description ?? cur.description, cwd: body.cwd ?? cur.cwd, vars: body.vars ?? cur.vars, schedule: body.schedule ?? cur.schedule, runTimeoutSec: body.runTimeoutSec ?? cur.runTimeoutSec, contextSources: cleanSources(body.contextSources) ?? cur.contextSources, finally: cleanFinally(body.finally) ?? cur.finally, requirements: cleanRequirements(body.requirements) ?? cur.requirements, policies: POL.cleanPolicies(body.policies, 'flow') ?? cur.policies, watchPolling: W.cleanPolling(body.watchPolling) ?? cur.watchPolling, ...(body.workspace ? { workspace: body.workspace } : cur.workspace ? { workspace: cur.workspace } : {}), steps, edges };
  // spec 11: Claude keeps its sessions per working folder: a new folder starts new conversations
  if (store.flowCwdPath(next) !== store.flowCwdPath(cur)) { delete next.globalSessionId; delete next.globalContextHash; for (const s of next.steps) { delete s.chatSessionId; delete s.chatContextHash; } }
  engine.topoLevels(next); // throws on cycles
  next.rev = (cur.rev || 0) + 1;
  delete next.baseRev;
  if (body.versionEveryMin !== undefined) next.versionEveryMin = Math.min(1440, Math.max(0, Number(body.versionEveryMin) || 0));
  const saved = store.saveFlow(next);
  autoVersion(cur, saved);
  clearPreflightCache(saved.id);
  engine.syncSchedule(saved); W.syncPolling(saved);
  engine.flowChanged(saved, String(req.get('x-afs-tab') || '').slice(0, 40) || null);
  if (saved.name !== cur.name) engine.bus.emit('msg', { type: 'flows.changed' });
  return saved;
}));
// What is left in a flow besides its steps (shown when the canvas is empty, cleared by /reset).
/** spec 11 ISO-9: calls between flows (🔀 Flujo steps and invokeFlow('…') literals in hooks). */
function callsOf(flow) {
  const all = store.listFlows();
  const byName = (n) => all.filter((x) => String(x.name).trim().toLowerCase() === String(n).trim().toLowerCase());
  const out = [];
  for (const s of flow.steps || []) {
    if (s.kind === 'flow') { const t = s.flowRef ? store.getFlow(s.flowRef) : null; out.push({ flowId: s.flowRef || null, name: t?.name || null, stepId: s.id, stepName: s.name, via: 'step', broken: !t }); }
    for (const m of String(s.hooks || '').matchAll(/invokeFlow\(\s*(['"`])([^'"`]{1,200})\1/g)) { const t = store.getFlow(m[2]) || (byName(m[2]).length === 1 ? store.getFlow(byName(m[2])[0].id) : null); out.push({ flowId: t?.id || null, name: t?.name || m[2], stepId: s.id, stepName: s.name, via: 'hook', broken: !t }); }
  }
  return out;
}
app.get('/api/flows/:id/calls', wrap((req) => {
  const flow = need(req.params.id);
  const calledBy = [];
  for (const f of store.listFlows()) { if (f.id === flow.id) continue; const full = store.getFlow(f.id); for (const c of callsOf(full || { steps: [] })) if (c.flowId === flow.id) calledBy.push({ flowId: f.id, name: f.name, stepId: c.stepId, stepName: c.stepName, via: c.via }); }
  return { calls: callsOf(flow), calledBy };
}));
app.get('/api/flows/:id/workspace', wrap((req) => store.workspaceInfo(need(req.params.id))));
app.get('/api/flows/:id/leftovers', wrap((req) => {
  const f = need(req.params.id);
  return { description: !!f.description?.trim(), vars: Object.keys(f.vars || {}).length, memory: (f.memory || []).length, chats: store.countChats(f.id), runs: store.countRuns(f.id), schedule: !!f.schedule?.enabled };
}));
app.post('/api/flows/:id/reset', wrap((req) => {
  const all = ['steps', 'description', 'vars', 'memory', 'chats', 'runs', 'schedule'];
  const parts = Array.isArray(req.body?.parts) ? req.body.parts.filter((p) => all.includes(p)) : all;
  need(req.params.id);
  engine.stopRuns(req.params.id);
  if (parts.includes('chats')) store.clearAllChats(req.params.id);
  if (parts.includes('runs')) store.clearRuns(req.params.id);
  const f = store.updateFlow(req.params.id, (fl) => {
    if (parts.includes('steps')) { fl.steps = []; fl.edges = []; }
    if (parts.includes('description')) fl.description = '';
    if (parts.includes('vars')) fl.vars = {};
    if (parts.includes('memory')) fl.memory = [];
    if (parts.includes('schedule')) fl.schedule = { ...(fl.schedule || {}), enabled: false, input: '' };
    if (parts.includes('chats')) { fl.globalSessionId = null; fl.globalContextHash = null; for (const s of fl.steps) { s.chatSessionId = null; s.chatContextHash = null; } }
    engine.bumpRev(fl);
  });
  engine.flowChanged(f);
  engine.syncSchedule(f); W.syncPolling(f);
  return f;
}));
app.delete('/api/flows/:id', wrap((req) => { need(req.params.id); engine.stopRuns(req.params.id); engine.clearSchedule(req.params.id); W.clearPolling(req.params.id); store.deleteFlow(req.params.id); SK.removeFlowSkills(req.params.id); TOK.revoke(req.params.id); engine.bus.emit('msg', { type: 'flow.deleted', flowId: req.params.id }); engine.bus.emit('msg', { type: 'flows.changed' }); }));

// ----- runs -----
// UI runs honour breaks unless {breakpoints:false}.
const uiInput = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2));
app.post('/api/flows/:id/run', wrap(async (req, res) => (await gate(need(req.params.id), res)) || ({ runId: engine.startRun(req.params.id, { input: uiInput(req.body?.input), trigger: 'manual', breakpoints: req.body?.breakpoints !== false, from: typeof req.body?.from === 'string' ? req.body.from : null }) })));
// spec 10: 🔔 news of the watched sources
app.get('/api/flows/:id/watch', wrap((req) => { need(req.params.id); return W.view(req.params.id); }));
app.post('/api/flows/:id/watch/check', wrap(async (req) => { need(req.params.id); return W.checkFlow(req.params.id, { stepId: req.body?.stepId || null, watchId: req.body?.watchId || null, trigger: 'manual' }); }));
app.post('/api/flows/:id/watch/ack', wrap((req) => { need(req.params.id); return W.ack(req.params.id, req.body?.stepId || null); }));
app.post('/api/flows/:id/steps/:stepId/run', wrap(async (req, res) => (await gate(need(req.params.id), res, req.params.stepId)) || ({ runId: engine.startRun(req.params.id, { input: uiInput(req.body?.input), only: req.params.stepId, trigger: 'manual', breakpoints: req.body?.breakpoints !== false }) })));
/**
 * Spec 12: slugs are the server's. Steps that exist keep theirs (a save from another tab, undo or an old client never
 * moves them). A step that is not live (new, duplicated, undo of a delete, restored) keeps the slug it brings only when
 * it is valid and free; otherwise store.ensureSlugs gives it one. A new step id equal to a slug in use is refused.
 */
function settleSlugs(steps, byId, { rejectIds = true } = {}) {
  const used = new Set();
  for (const s of steps) { const p = byId.get(s.id)?.slug; if (p) { s.slug = p; used.add(p); } }
  for (const s of steps) {
    if (byId.get(s.id)?.slug) continue;
    if (rejectIds && !byId.has(s.id) && used.has(String(s.id).toLowerCase())) throw fail(400, `El id «${s.id}» es la dirección (slug) de otro step`, 'STEP_ID_TAKEN');
    const ids = new Set(steps.filter((x) => x !== s).map((x) => String(x.id).toLowerCase()));
    if (typeof s.slug === 'string' && store.SLUG_RE.test(s.slug) && !used.has(s.slug) && !ids.has(s.slug)) used.add(s.slug);
    else Reflect.deleteProperty(s, 'slug');
  }
}
app.put('/api/flows/:id/steps/:stepId/slug', wrap((req) => {
  const flow = need(req.params.id);
  const step = flow.steps.find((s) => s.id === req.params.stepId); if (!step) throw fail(404, 'Step no encontrado', 'STEP_NOT_FOUND');
  if (typeof req.body?.slug !== 'string') throw fail(400, 'El slug debe ser texto', 'BAD_SLUG');
  const v = store.slugify(req.body.slug);
  if (!store.SLUG_RE.test(v)) throw fail(400, `Slug inválido «${req.body.slug}»: letras, números y guiones`, 'BAD_SLUG');
  const other = flow.steps.find((s) => s.id !== step.id && (s.slug === v || String(s.id).toLowerCase() === v));
  if (other) throw fail(409, `El slug «${v}» ya lo usa el step «${other.name}»`, 'STEP_SLUG_TAKEN');
  const saved = store.updateFlow(flow.id, (f) => { const s = f.steps.find((x) => x.id === step.id); if (s) s.slug = v; engine.bumpRev(f); });
  engine.flowChanged(saved, String(req.get('x-afs-tab') || '').slice(0, 40) || null);
  return { slug: v, rev: saved.rev };
}));
app.post('/api/flows/:id/steps/:stepId/pin', wrap((req) => engine.pinStep(req.params.id, req.params.stepId, req.body || {})));
app.delete('/api/flows/:id/steps/:stepId/pin', wrap((req) => engine.unpinStep(req.params.id, req.params.stepId)));
app.post('/api/flows/:id/stop', wrap((req) => ({ stopped: engine.stopRuns(req.params.id) })));
app.post('/api/flows/:id/runs/:runId/cancel', wrap((req) => {
  need(req.params.id);
  if (!engine.getRunLive(req.params.id, req.params.runId)) throw fail(404, 'Ejecución no encontrada', 'RUN_NOT_FOUND');
  if (!engine.stopRun(req.params.id, req.params.runId)) throw fail(409, 'La ejecución no está en curso', 'RUN_FINISHED');
  return { runId: req.params.runId, status: 'stopped' };
}));
app.post('/api/flows/:id/runs/:runId/resume', wrap((req) => { need(req.params.id); return engine.resumeRun(req.params.id, req.params.runId, req.body?.step || null, req.body || {}); }));
app.get('/api/flows/:id/runs', wrap((req) => store.listRuns(req.params.id)));
app.get('/api/flows/:id/runs/:runId', wrap((req) => engine.getRunLive(req.params.id, req.params.runId)));
// spec 14: ⚡ a declared action in "confirm" waits for a person (the run did not wait for it)
const decideDeps = { getRun: (f, r) => engine.getRunLive(f, r), saveRun: (r) => store.saveRun(r), getFlow: store.getFlow, updateFlow: (id, fn) => { const fl = store.updateFlow(id, fn); if (fl) engine.flowChanged(fl); attention.refreshFlow(id); return fl; }, policyBlocked: (fl) => POL.has(fl, 'noExternalWrites'), quarantine: quarantineProblem };
const decide = (flowId, runId, b) => OUT.decide(flowId, runId, String(b?.stepKey || ''), String(b?.actionId || ''), { approve: b?.approve === true, params: b?.params }, decideDeps);
app.get('/api/flows/:id/approvals', wrap((req) => { need(req.params.id); return OUT.pendingOf(req.params.id); }));
app.post('/api/flows/:id/runs/:runId/actions/decide', wrap((req) => { need(req.params.id); return decide(req.params.id, req.params.runId, req.body); }));
// spec 14: 📄 a deliverable of a run (by its id inside the step, or by file name)
function deliverableFile(flowId, runId, fileRef, stepRef) {
  const run = engine.getRunLive(flowId, runId);
  if (!run) throw fail(404, 'Ejecución no encontrada', 'RUN_NOT_FOUND');
  // each file once (the parent of a "para cada" repeats its elements' entries), optionally of one step / element
  const seen = new Set();
  const all = Object.entries(run.steps || {}).flatMap(([k, s]) => (s.deliverables || []).map((d) => ({ ...d, stepKey: d.stepKey || k }))).filter((d) => !seen.has(d.path) && seen.add(d.path));
  const scoped = stepRef ? all.filter((d) => d.stepKey === stepRef) : all;
  const hits = scoped.filter((x) => x.id === fileRef || x.name === fileRef);
  if (hits.length > 1) throw fail(409, `Hay ${hits.length} archivos "${fileRef}" (de distintos steps o elementos): indica ?step=<step o step~n>`, 'FILE_AMBIGUOUS');
  const f = hits[0] && { ...hits[0], path: OUT.localPath(flowId, runId, hits[0].path) };
  const root = path.resolve(OUT.outputsDir(flowId, runId));
  if (!f || !path.resolve(f.path).startsWith(root + path.sep) || !fs.existsSync(f.path)) throw fail(404, `Archivo no encontrado: ${fileRef}`, 'FILE_NOT_FOUND');
  return f;
}
const sendFile = (res, f) => new Promise((ok, ko) => res.download(f.path, f.name, { dotfiles: 'allow' }, (e) => (e ? ko(e) : ok())));
app.get('/api/flows/:id/runs/:runId/files/:file', wrap(async (req, res) => { need(req.params.id); const f = deliverableFile(req.params.id, req.params.runId, req.params.file, req.query.step ? String(req.query.step) : null); await sendFile(res, f); return undefined; }));

// ----- memory -----
app.post('/api/flows/:id/memory/:scope', wrap((req) => engine.addMemory(req.params.id, req.params.scope, req.body?.text, 'manual')));
app.delete('/api/flows/:id/memory/:scope/:memId', wrap((req) => engine.removeMemory(req.params.id, req.params.scope, req.params.memId)));

// ----- chats -----
app.get('/api/flows/:id/chat/:key', wrap((req) => store.getChat(req.params.id, req.params.key)));
app.post('/api/flows/:id/chat/:key', wrap((req) => {
  const { id, key } = req.params;
  need(id);
  const message = String(req.body?.message || '').trim();
  if (!message) throw new Error('Mensaje vacío');
  { const qp = quarantineProblem(store.getFlow(id)); if (qp) throw fail(qp.status, qp.error, qp.code); }
  // Spec 25 (C9): while the flow runs it follows its process; a human talks to a step only when stopped or in a break.
  { const ip = engine.interactionProblem(id, key); if (ip?.status) throw fail(ip.status, ip.error, ip.code); }
  if (key !== '_global' && store.getFlow(id).steps.find((s) => s.id === key)?.kind === 'flow') throw fail(409, 'Un step 🔀 Flujo no tiene chat: abre el flujo que invoca para conversar con sus steps', 'FLOW_STEP_NO_CHAT');
  const p = key === '_global' ? engine.globalChat(id, message) : engine.stepChat(id, key, message, { improve: !!req.body?.improve, runId: typeof req.body?.runId === 'string' ? req.body.runId : null });
  p.catch((e) => console.error('chat error', e));
  return { accepted: true };
}));
app.delete('/api/flows/:id/chat/:key', wrap((req) => {
  const { id, key } = req.params;
  store.clearChat(id, key);
  const f = store.updateFlow(id, (fl) => {
    if (key === '_flow' || key === '_global') { fl.globalSessionId = null; fl.globalContextHash = null; }
    if (key === '_global') fl.chatParticipants = []; // a new conversation starts with the coordinator
    const s = fl.steps.find((x) => x.id === key);
    if (s) { s.chatSessionId = null; s.chatContextHash = null; }
  });
  if (key === '_global') store.clearChat(id, '_flow');
  return f;
}));
// Spec 25: chats only propose; the user confirms each proposal here (or discards it).
app.post('/api/flows/:id/chat/:key/apply', wrap(async (req, res) => {
  const { id, key } = req.params;
  const { messageId, proposalId } = req.body || {};
  const p = engine.findProposal(id, key, messageId, proposalId);
  const ip = engine.interactionProblem(id, key);
  if (ip?.status) throw fail(ip.status, ip.error, ip.code);
  if (ip?.runId && p.kind === 'run') throw fail(409, 'El flujo está en un break: termina o detén esa ejecución antes de lanzar otra.', 'FLOW_RUNNING');
  if (p.kind === 'run') {
    if (p.patch?.__invalid) throw fail(400, typeof p.patch.__invalid === 'string' ? p.patch.__invalid : 'Propuesta inválida', 'BAD_PROPOSAL');
    if (p.applied) throw fail(409, 'Ya se ejecutó', 'ALREADY_APPLIED');
    const flow = need(id);
    const only = p.patch.step || null;
    if (only && !flow.steps.some((s) => s.id === only)) throw fail(400, 'Ese step ya no existe', 'BAD_PROPOSAL');
    const blocked = await gate(flow, res, only);
    if (blocked) return blocked;
    const runId = engine.startRun(id, { input: uiInput(p.patch.input), only, trigger: 'chat', breakpoints: true });
    engine.markRunProposal(id, key, messageId, proposalId, runId);
    return { runId };
  }
  // spec 28: a review proposal can reshape the flow: a version is saved first (undo = restore it)
  if (key === '_review' && !p.applied) { const cur = need(id); if (store.listVersions(id)[0]?.hash !== store.definitionHash(cur)) store.saveVersion(cur, { label: 'Antes de aplicar una propuesta de la revisión' }); }
  // spec 28: a proposal that widens access needs its own confirmation (409 WIDEN_CONFIRM + the list otherwise)
  return engine.applyProposal(id, key, messageId, proposalId, { runId: typeof req.body?.runId === 'string' ? req.body.runId : ip?.runId || null, confirmWiden: wideOk(req.body?.confirmWiden) });
}));
// spec 30: who the general chat is talking with (@mentions); [] = back to the coordinator
app.put('/api/flows/:id/chat/_global/participants', wrap((req) => { need(req.params.id); const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []; return { participants: engine.setParticipants(req.params.id, ids) }; }));
// Cancels only the chat's answer in progress: never a run (the flow keeps its process).
app.post('/api/flows/:id/chat/:key/cancel', wrap((req) => { need(req.params.id); return { stopped: engine.stopChat(req.params.id, req.params.key) }; }));
app.post('/api/flows/:id/chat/:key/discard', wrap((req) => engine.discardProposal(req.params.id, req.params.key, req.body?.messageId, req.body?.proposalId)));

// ----- export / import (spec 09) -----
app.get('/api/flows/:id/export', wrap((req, res) => {
  const flow = need(req.params.id);
  const b = exportFlow(flow, { chats: req.query.chats === '1', runs: req.query.runs === '1', memory: req.query.memory !== '0', pins: req.query.pins === '1', secrets: req.query.secrets === '1' });
  if (req.query.skills !== '0') { const sk = SK.embedForExport(flow.id, { mode: req.query.skills === 'ref' ? 'ref' : 'embed' }); if (sk.length) b.skills = sk; }
  res.setHeader('Content-Disposition', `attachment; filename="${slug(flow.name)}.afsflow.json"`);
  return b;
}));
app.post('/api/flows/import', wrap((req) => {
  const body = req.body || {};
  const policies = (x) => { if (!Array.isArray(x)) return undefined; const out = []; for (const p of x.slice(0, 50)) { try { out.push(POL.cleanPolicy({ ...p, source: 'import' }, 'flow')); } catch {} } return out; };
  // spec 09 WS-4: a flow folder (flow.json + chats/) imports like a bundle: new id, quarantine when it executes things
  if (body.path !== undefined && body.bundle === undefined) body.bundle = readFlowFolder(store.validateLinkPath(body.path));
  const { flow, warnings, chats, runs } = importBundle(body.bundle, { steps: cleanStepExtras, edge: cleanEdge, sources: (x) => cleanSources(x), finally: (x) => cleanFinally(x), requirements: (x) => cleanRequirements(x), policies }, { name: typeof body.name === 'string' ? body.name : undefined });
  engine.topoLevels(flow); // rejects cycles
  const saved = store.saveFlow(flow);
  if (chats) for (const [key, list] of Object.entries(chats)) {
    const k = key === '_global' || key === '_flow' ? key : saved.steps.some((s) => s.id === key) ? key : null;
    if (k && Array.isArray(list)) store.saveChat(saved.id, k, list.filter((m) => m && typeof m === 'object').map((m) => ({ ...m, status: m.status === 'running' ? 'done' : m.status })));
  }
  if (runs) for (const r of runs.slice(0, 50)) if (r && typeof r.id === 'string') store.saveRun({ ...r, flowId: saved.id, imported: true, status: ['running', 'paused'].includes(r.status) ? 'interrupted' : r.status, pauses: [] });
  store.saveVersion(saved, { label: 'Importado' });
  engine.bus.emit('msg', { type: 'flows.changed' });
  // spec 13: the bundle's skills are only staged; installing them goes through the same review as a zip
  let skillReview = null;
  try { skillReview = SK.stageImport(body.bundle?.skills, saved.id); } catch (e) { warnings.push(`Skills del paquete descartadas: ${e.message}`); }
  return { flow: saved, quarantine: saved.quarantine || null, warnings, ...(skillReview ? { skillReview: { ...skillReview, flowId: saved.id } } : {}) };
}));
// ----- spec 09: linked folders, reveal, README -----
/** What a linked flow.json may contain: the same cleaning as a save from the UI (never written back by itself). */
function sanitizeLinked(f) {
  const steps = (Array.isArray(f.steps) ? f.steps : []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string').slice(0, 200).map((s) => store.newStep({ ...s, contextSources: cleanSources(s.contextSources) }));
  cleanStepExtras(steps);
  const ids = new Set(steps.map((s) => s.id));
  const edges = (Array.isArray(f.edges) ? f.edges : []).filter((e) => e && ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map(cleanEdge);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const vars = f.vars && typeof f.vars === 'object' && !Array.isArray(f.vars) ? Object.fromEntries(Object.entries(f.vars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : {};
  const policies = Array.isArray(f.policies) ? f.policies.slice(0, 50).flatMap((p) => { try { return [POL.cleanPolicy({ ...p }, 'flow')]; } catch { return []; } }) : undefined;
  const out = { ...f, watchPolling: f.watchPolling && typeof f.watchPolling === 'object' ? W.cleanPolling(f.watchPolling) : undefined, name: str(f.name).trim().slice(0, 200) || 'Flujo vinculado', description: str(f.description), cwd: str(f.cwd), vars, contextSources: cleanSources(f.contextSources), finally: cleanFinally(f.finally) ?? undefined, requirements: cleanRequirements(f.requirements), policies, steps, edges };
  engine.topoLevels(out); // a cycle: the flow is "invalid", nothing runs
  return out;
}
const linkEvents = (id) => { engine.bus.emit('msg', { type: 'flows.changed' }); const f = store.getFlow(id); if (f) engine.flowChanged(f); attention.refreshFlow(id); };
store.setLinkHooks({
  sanitize: sanitizeLinked,
  executableParts,
  onExternalChange: (id, { quarantined }) => setImmediate(() => {
    if (quarantined) { engine.stopRuns(id); engine.clearSchedule(id); W.clearPolling(id); }
    clearPreflightCache(id); linkEvents(id);
  }),
  onLinkStatus: (id, status) => setImmediate(() => {
    if (status === 'available') { const f = store.getFlow(id); if (f) { engine.syncSchedule(f); W.syncPolling(f); } } else { engine.clearSchedule(id); W.clearPolling(id); }
    linkEvents(id);
  }),
});
const LINK_POLL_MS = Math.max(200, 5000 * (Number(process.env.AFS_TIME_SCALE) > 0 ? Number(process.env.AFS_TIME_SCALE) * 10 : 1));
setInterval(() => { store.pollLinks().catch((e) => console.error('[link]', e.message)); }, LINK_POLL_MS).unref();
const asStoreError = (fn) => { try { return fn(); } catch (e) { if (e.status) throw fail(e.status, e.message, e.code); throw e; } };
app.post('/api/flows/link', wrap((req) => {
  const id = asStoreError(() => store.linkFolder(req.body?.path, { asCopy: req.body?.asCopy === true }));
  const flow = need(id);
  engine.syncSchedule(flow); W.syncPolling(flow);
  engine.bus.emit('msg', { type: 'flows.changed' }); attention.refreshFlow(id);
  return { flow, quarantine: flow.quarantine || null, path: store.linkOf(id)?.path };
}));
app.delete('/api/flows/link/:id', wrap((req) => {
  const id = req.params.id;
  if (!store.linkOf(id)) throw fail(404, 'Ese flujo no está vinculado', 'LINK_NOT_FOUND');
  const keep = req.body?.keepLocalCopy === true || req.query.keepLocalCopy === '1';
  engine.stopRuns(id); engine.clearSchedule(id); W.clearPolling(id);
  store.unlinkFlow(id, { keepLocalCopy: keep });
  if (!keep) { TOK.revoke(id); engine.bus.emit('msg', { type: 'flow.deleted', flowId: id }); } else { const f = store.getFlow(id); if (f) { engine.syncSchedule(f); W.syncPolling(f); engine.flowChanged(f); } }
  engine.bus.emit('msg', { type: 'flows.changed' }); attention.refreshFlow(id);
  return { ok: true, keptLocalCopy: keep };
}));
app.post('/api/flows/:id/move-to', wrap((req) => {
  need(req.params.id);
  const p = asStoreError(() => store.moveFlowTo(req.params.id, req.body?.path));
  const flow = need(req.params.id);
  engine.bus.emit('msg', { type: 'flows.changed' }); engine.flowChanged(flow);
  return { flow, path: p };
}));
/** WS-9: open the flow's folder in the file manager (path decided here, never taken from the request). */
app.post('/api/flows/:id/reveal', wrap((req) => {
  need(req.params.id);
  const dir = store.flowLocation(req.params.id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail(409, `La carpeta no está disponible: ${dir}`, 'FLOW_UNAVAILABLE');
  if (process.env.AFS_REVEAL === '0') return { path: dir, opened: false };
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((ok, ko) => {
    const c = spawn(cmd, [dir], { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    c.once('error', (e) => ko(fail(500, `No se pudo abrir la carpeta: ${e.message}`, 'REVEAL_FAILED')));
    c.once('spawn', () => { c.unref(); ok({ path: dir, opened: true }); });
  });
}));
/** WS-11: README.md of the flow (in a linked folder only on request: it is the person's repo). */
app.post('/api/flows/:id/readme', wrap((req) => {
  const flow = need(req.params.id);
  const dir = store.flowLocation(flow.id);
  const r = writeReadme(flow, dir);
  if (r === 'not-ours') throw fail(409, 'Ya hay un README.md que no generó la app: no se sobrescribe', 'README_NOT_OURS');
  if (r === 'error') throw fail(500, 'No se pudo escribir README.md', 'README_FAILED');
  return { path: path.join(dir, 'README.md'), status: r };
}));
/** "Revisé este flujo, habilitar": lifts the import quarantine. */
app.post('/api/flows/:id/trust', wrap((req, res) => {
  const cur = need(req.params.id);
  if (req.body?.baseRev !== undefined && Number(req.body.baseRev) !== (cur.rev || 0)) { res.status(409); return { error: 'El flujo cambió mientras lo revisabas: revisa la versión nueva antes de habilitarlo', code: 'FLOW_CONFLICT', flow: cur }; }
  const f = store.updateFlow(req.params.id, (fl) => { delete fl.quarantine; delete fl.trust; engine.bumpRev(fl); }); // trust = what was reviewed now (definition and, for a linked flow, its folder's Claude configuration)
  engine.flowChanged(f);
  return f;
}));

// ----- requirements / preflight (spec 23) -----
app.get('/api/flows/:id/preflight', wrap(async (req) => preflight(need(req.params.id), { fresh: req.query.fresh === '1', probe: req.query.probe === '1' })));
app.get('/api/flows/:id/requirements/suggest', wrap((req) => suggestRequirements(need(req.params.id))));
app.post('/api/flows/:id/requirements/:rid/create-file', wrap((req) => {
  const flow = need(req.params.id);
  const r = (flow.requirements || []).find((x) => x.id === req.params.rid);
  if (!r) throw fail(404, 'Requisito no encontrado', 'REQUIREMENT_NOT_FOUND');
  return createFromTemplate(r, flow);
}));

// ----- context sources helpers (spec 21) -----
app.post('/api/context/check', wrap(async (req) => {
  const flow = need(req.body?.flow);
  const [src] = cleanSources([req.body?.source]) || [];
  if (!src) throw fail(400, 'Fuente inválida', 'BAD_SOURCE');
  return checkSource(src, { flow, input: typeof req.body?.input === 'string' ? req.body.input : '' });
}));
/** Folder browser for choosing paths (this machine only, behind the UI key). */
app.get('/api/fs/list', wrap((req) => {
  const flow = req.query.flow ? store.getFlow(String(req.query.flow)) : null;
  let p = String(req.query.path || '').trim() || (flow ? store.flowCwd(flow) : os.homedir());
  p = path.resolve(p);
  let st; try { st = fs.statSync(p); } catch { throw fail(404, `No existe: ${p}`, 'PATH_NOT_FOUND'); }
  if (!st.isDirectory()) p = path.dirname(p);
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { throw fail(403, `No se puede leer ${p}: ${e.code || e.message}`, 'PATH_UNREADABLE'); }
  const list = entries.filter((e) => !e.name.startsWith('$')).map((e) => { let size = null; if (!e.isDirectory()) { try { size = fs.statSync(path.join(p, e.name)).size; } catch {} } return { name: e.name, dir: e.isDirectory(), size }; })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)).slice(0, 1000);
  const parent = path.dirname(p);
  return { path: p, parent: parent !== p ? parent : null, home: os.homedir(), entries: list };
}));
/** Upload a document (e.g. a .md or .pdf from another place): stored under data/context-files/<flow>/ and used by path. */
app.post('/api/flows/:id/context-files', wrap((req) => {
  const flow = need(req.params.id);
  const name = String(req.body?.name || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'archivo';
  const data = typeof req.body?.data === 'string' ? Buffer.from(req.body.data, 'base64') : null;
  if (!data?.length) throw fail(400, 'Archivo vacío', 'BAD_FILE');
  const dir = path.join(store.DATA, 'context-files', flow.id.replace(/[^\w-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
  fs.writeFileSync(file, data);
  return { path: file, name, size: data.length };
}));

// ----- step library (spec 18) -----
// ----- credentials (spec 26): values never leave the server -----
app.get('/api/credentials', wrap(() => ({ types: CRED.TYPES, items: CRED.listCredentials() })));
// credential changes refresh the "blocked" attention items (the event carries no names or values)
const credChanged = (x) => { engine.bus.emit('msg', { type: 'credentials.changed' }); return x; };
app.post('/api/credentials', wrap((req) => credChanged(CRED.createCredential(req.body))));
app.put('/api/credentials/:cid', wrap((req) => credChanged(CRED.updateCredential(req.params.cid, req.body))));
app.delete('/api/credentials/:cid', wrap((req) => credChanged(CRED.deleteCredential(req.params.cid))));
app.post('/api/credentials/:cid/test', wrap((req) => CRED.testCredential(req.params.cid)));
app.post('/api/credentials/env-keys', wrap((req) => ({ keys: CRED.envKeys(req.body?.file) })));
app.post('/api/credentials/:cid/import-env', wrap((req) => credChanged(CRED.importFromEnv(req.params.cid, req.body || {}))));

// ----- "Necesita atención" + notifications + settings (spec 27). Navigation only: nothing here resumes/applies/trusts. -----
app.get('/api/attention', wrap(() => ({ items: attention.list(), at: Date.now() })));
app.post('/api/attention/dismiss', wrap((req) => attention.dismiss(String(req.body?.id || ''), String(req.body?.stateKey ?? ''))));
app.get('/api/settings', wrap(() => ({ notify: notify.settings(), platform: process.platform, osSupported: notify.osSupported() })));
app.put('/api/settings/notify', wrap((req) => ({ notify: notify.setSettings(req.body || {}) })));
app.post('/api/settings/notify/test', wrap(() => notify.test()));
app.get('/api/system/check', wrap(async (req) => checkSystem({ flow: req.query.flow ? store.getFlow(String(req.query.flow)) : null, fresh: req.query.fresh === '1' })));

// ----- 🩺 flow review (spec 28): it only proposes; every change goes through engine.applyChange -----
// spec 28: true (API) or the list of widenings the person saw (UI); anything else = not confirmed
const wideOk = (v) => (v === true ? true : Array.isArray(v) ? v.map(String).slice(0, 50) : false);
const describedPolicies = (flow) => ({ machine: POL.machinePolicies().map(POL.describe), flow: (flow?.policies || []).map(POL.describe) });
app.get('/api/flows/:id/lint', wrap(async (req) => {
  const flow = need(req.params.id);
  const lint = await review.lintFlow(flow, { probes: true, fresh: req.query.fresh === '1' });
  return { ...lint, policies: describedPolicies(flow), running: engine.isRunning(flow.id), activeReview: review.activeReview(flow.id) };
}));
app.post('/api/flows/:id/lint/apply', wrap((req) => review.applyLintFix(req.params.id, String(req.body?.fp || ''), { confirmWiden: wideOk(req.body?.confirmWiden) })));
app.post('/api/flows/:id/review/suppress', wrap((req) => review.suppress(need(req.params.id).id, String(req.body?.fp || ''), String(req.body?.reason || ''), String(req.body?.anchor || ''))));
app.post('/api/flows/:id/review/unsuppress', wrap((req) => review.unsuppress(need(req.params.id).id, String(req.body?.fp || ''))));
app.get('/api/flows/:id/reviews', wrap((req) => { need(req.params.id); return { items: store.listReviews(req.params.id), active: review.activeReview(req.params.id) }; }));
app.post('/api/flows/:id/reviews', wrap((req) => review.startReview(req.params.id)));
app.get('/api/flows/:id/reviews/:rid', wrap((req) => {
  need(req.params.id); const rv = store.getReview(req.params.id, req.params.rid); if (!rv) throw fail(404, 'Revisión no encontrada', 'REVIEW_NOT_FOUND');
  // each finding carries the state of its proposal (applied, discarded, what it widens, why it cannot apply)
  const props = rv.messageId ? store.getChat(req.params.id, '_review').find((m) => m.id === rv.messageId)?.proposals || [] : [];
  const findings = (rv.findings || []).map((f) => { const p = props.find((x) => x.id === f.proposalId); return p ? { ...f, proposal: { applied: !!p.applied, discarded: !!p.discarded, widens: p.widens || [], error: p.error || null } } : f; });
  return { ...rv, findings, stale: rv.flowHash !== store.definitionHash(store.getFlow(req.params.id)) };
}));
app.post('/api/flows/:id/reviews/:rid/apply-safe', wrap(async (req) => { need(req.params.id); return review.applySafe(req.params.id, req.params.rid); }));
app.post('/api/flows/:id/reviews/:rid/cancel', wrap((req) => { need(req.params.id); if (!review.cancelReview(req.params.id, req.params.rid)) throw fail(409, 'Esa revisión no está en curso', 'REVIEW_FINISHED'); return { cancelled: true }; }));
// Rehearsal: the whole flow, read-only AI (plan mode), commands that write outside skipped, each step capped
app.post('/api/flows/:id/rehearsal', wrap(async (req, res) => (await gate(need(req.params.id), res)) || ({ runId: engine.startRun(req.params.id, { input: uiInput(req.body?.input), rehearsal: true }) })));
app.get('/api/policies', wrap(() => ({ types: POL.POLICY_TYPES, machine: POL.machinePolicies().map(POL.describe) })));
app.put('/api/policies', wrap((req) => { const list = POL.setMachinePolicies(req.body?.policies || []); engine.bus.emit('msg', { type: 'flows.changed' }); return { machine: list.map(POL.describe) }; }));
app.post('/api/system/cleanup-headless', wrap(() => review.cleanupHeadless()));
app.get('/api/library', wrap(() => store.listLibrary()));
app.post('/api/library', wrap((req) => {
  const f = need(req.body?.flow);
  const s = f.steps.find((x) => x.id === req.body?.step);
  if (!s) throw fail(404, 'Step no encontrado', 'STEP_NOT_FOUND');
  return store.saveToLibrary(s, req.body?.name);
}));
app.delete('/api/library/:id', wrap((req) => store.deleteFromLibrary(req.params.id)));

// ----- catalog / info -----
app.get('/api/catalog', wrap((req) => ({
  skills: listSkills(req.query.cwd, req.query.flow && store.getFlow(String(req.query.flow)) ? String(req.query.flow) : undefined), agents: listAgents(req.query.cwd),
  tools: lastInit.tools, mcpServers: lastInit.mcpServers, rateLimit: lastRateLimit.info, claudeBin: claudeBin(),
})));
app.post('/api/catalog/probe', wrap(async (req) => probeInit(req.body?.cwd)));

/** 🧩 updates of the skills a flow uses (spec 13 SKSRC-11): flow skills + user skills (installed by the app) its steps reference. */
function skillUpdateItem(flow) {
  const own = Object.entries(SK.updatesOf(flow.id)).filter(([, v]) => v.available).map(([n]) => n);
  const user = SK.updatesOf('_user');
  const used = flow.steps.filter((s) => s.kind === 'skill' && s.skillRef).map((s) => s.skillRef);
  const mine = Object.entries(user).filter(([n, v]) => v.available && used.includes(n) && !own.includes(n) && listSkills(flow.cwd, flow.id).filter((x) => x.name === n).sort((a, b) => (SK._rank[a.source] ?? 9) - (SK._rank[b.source] ?? 9))[0]?.source === 'user').map(([n]) => n);
  const names = [...own, ...mine];
  if (!names.length) return null;
  const step = flow.steps.find((s) => s.kind === 'skill' && names.includes(s.skillRef));
  return { flowId: flow.id, flowName: flow.name, id: `skillupd:${flow.id}`, kind: 'skill_update', severity: 'warn', stepId: step?.id || null, stepName: step?.name || null,
    title: `🧩 ${names.length} skill${names.length === 1 ? '' : 's'} con actualización`, detail: `${names.join(', ')}: revisa los cambios con «Buscar actualización» en el step`,
    createdAt: Date.now(), stateKey: crypto.createHash('sha1').update(names.sort().join('|')).digest('hex').slice(0, 12), target: { flowId: flow.id, ...(step ? { stepId: step.id, open: 'watch' } : {}) } };
}
// ----- skill sources (spec 13): inspect → review → install for this flow or for the user's Claude Code -----
const skillFlow = (id, required) => { if (!id) { if (required) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND'); return null; } const f = store.getFlow(String(id)); if (!f) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND'); return f; };
/** A running flow whose skill step uses one of these user skills (resolved as Claude would: no flow skill of that name). */
const userSkillInUse = (names) => { for (const f of store.listFlows().map((x) => store.getFlow(x.id)).filter(Boolean)) { if (!engine.isRunning(f.id)) continue; const n = f.steps.find((s) => s.kind === 'skill' && names.includes(s.skillRef) && listSkills(f.cwd, f.id).filter((x) => x.name === s.skillRef).sort((p, q) => (SK._rank[p.source] ?? 9) - (SK._rank[q.source] ?? 9))[0]?.source === 'user'); if (n) return { flow: f, name: n.skillRef }; } return null; };
const skillsChanged = (flowId) => engine.bus.emit('msg', { type: 'catalog.changed', flowId: flowId || null });
app.post('/api/skills/inspect', wrap((req) => {
  const b = req.body || {};
  const one = ['url', 'path', 'zipBase64'].filter((k) => b[k] !== undefined);
  if (one.length !== 1) throw fail(400, 'Indica una sola fuente: url, path o zipBase64', 'BAD_SOURCE');
  return SK.inspect({ url: b.url, path: b.path, zipBase64: b.zipBase64, fileName: b.fileName });
}));
app.post('/api/skills/install', wrap((req) => {
  const b = req.body || {};
  const scope = b.scope || 'flow';
  const flow = skillFlow(b.flowId, scope === 'flow');
  if (flow && engine.isRunning(flow.id) && Object.values(b.resolve || {}).some((x) => x?.action === 'replace' || x?.replace === true)) throw fail(409, 'El flujo se está ejecutando: reemplaza la skill cuando termine', 'FLOW_RUNNING');
  if (scope === 'user' && Object.values(b.resolve || {}).some((x) => x?.action === 'replace' || x?.replace === true)) { const busy = userSkillInUse(Object.keys(b.resolve || {}).concat(Object.values(b.resolve || {}).map((x) => x?.to).filter(Boolean))); if (busy) throw fail(409, `«${busy.flow.name}» se está ejecutando y usa esa skill: reemplázala cuando termine`, 'FLOW_RUNNING'); }
  const r = SK.install({ token: b.token, names: b.names, scope, flow, mode: b.mode || 'copy', confirmUser: b.confirmUser === true, resolve: b.resolve && typeof b.resolve === 'object' ? b.resolve : {} });
  skillsChanged(flow?.id);
  return r;
}));
app.get('/api/flows/:id/skills', wrap((req) => SK.flowSkills(need(req.params.id).id)));
app.get('/api/flows/:id/skills/updates', wrap((req) => ({ flow: SK.updatesOf(need(req.params.id).id), user: SK.updatesOf('_user') })));
app.post('/api/flows/:id/skills/check-updates', wrap(async (req) => { const f = need(req.params.id); const qp = quarantineProblem(f); if (qp) throw fail(qp.status, qp.error, qp.code); return { flow: await SK.checkSkillUpdates(f.id, { background: req.body?.background === true }), user: SK.updatesOf('_user') }; }));
app.post('/api/skills/check-updates', wrap(async () => ({ user: await SK.checkSkillUpdates('_user') })));
app.get('/api/skills/:name/origin', wrap((req) => SK.originOf(req.params.name, String(req.query.scope || 'flow'), skillFlow(req.query.flowId, req.query.scope !== 'user'))));
app.post('/api/skills/:name/update', wrap((req) => SK.checkUpdate(req.params.name, String(req.query.scope || req.body?.scope || 'flow'), skillFlow(req.query.flowId || req.body?.flowId, (req.query.scope || req.body?.scope || 'flow') !== 'user'))));
app.delete('/api/skills/:name', wrap((req) => {
  const scope = String(req.query.scope || 'flow');
  const flow = skillFlow(req.query.flowId, scope === 'flow');
  if (flow && scope === 'flow' && engine.isRunning(flow.id)) throw fail(409, 'El flujo se está ejecutando: quita la skill cuando termine', 'FLOW_RUNNING');
  if (scope === 'user') { const busy = userSkillInUse([req.params.name]); if (busy) throw fail(409, `«${busy.flow.name}» se está ejecutando y usa esa skill: quítala cuando termine`, 'FLOW_RUNNING'); }
  const r = SK.remove(req.params.name, scope, flow, { confirm: req.query.confirm === '1' });
  skillsChanged(flow?.id);
  return r;
}));
app.get('/api/catalog/file', wrap((req) => definitionFile(String(req.query.kind || ''), String(req.query.name || ''), req.query.flow ? String(req.query.flow) : null)));

// ----- context box (spec 17 CTX) -----
app.post('/api/flows/:id/steps/:stepId/preview', wrap((req) => previewStep(req.params.id, req.params.stepId, { draft: req.body?.draft, target: req.body?.target === 'chat' ? 'chat' : 'run', sample: req.body?.sample || {} })));

// ----- integration helper (spec 17 INT) -----
app.get('/api/integrations/callers', wrap(() => integ.CALLERS));
const integCtx = (flowRef, callerId, opts = {}) => {
  const flow = store.findFlow(String(flowRef || ''));
  if (!flow) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND');
  const caller = integ.CALLERS.find((c) => c.id === callerId);
  if (!caller) throw fail(400, 'Origen desconocido', 'UNKNOWN_CALLER');
  if (opts.step) { const r = store.findStep(flow, opts.step); if (!r.step) throw fail(r.status, r.error, r.code); }
  const cfg = store.getConfig();
  const reach = integ.reachability(caller, { location: opts.location, host: HOST, port: PORT, publicUrl: cfg.publicUrl });
  const lintCtx = { flow, flows: store.listFlows(), callerId, token: cfg.token, flowVars: flow.vars || {} };
  return { flow, caller, reach, lintCtx };
};
app.post('/api/integrations/generate', wrap(async (req) => {
  const b = req.body || {};
  const o = b.options || {};
  const { flow, caller, reach, lintCtx } = integCtx(b.flow, b.caller, o);
  const stepObj = o.step ? store.findStep(flow, o.step).step : null;
  const step = stepObj?.name || '';
  const mode = ['wait', 'async-poll', 'fire-and-forget'].includes(o.mode) ? o.mode : caller.id.startsWith('jira') || caller.id === 'webhook' ? 'fire-and-forget' : 'wait';
  const params = {
    base: reach.base, flowId: flow.id, flowName: flow.name, step, stepId: stepObj?.id || '', scope: stepObj && o.scope === 'from' ? 'from' : 'only', mode, input: o.input, vars: o.vars && typeof o.vars === 'object' ? o.vars : undefined,
    idempotencyKey: o.idempotencyKey, timeoutSec: Math.min(Number(o.timeoutSec) || 1800, 4 * 3600), deadlineSec: Number(o.deadlineSec) || 0,
    source: caller.id, reach, info: { node: process.execPath, mcp: path.join(ROOT, 'bin', 'mcp.js'), cli: path.join(ROOT, 'bin', 'afs.js') },
  };
  const tpl = integ.buildTemplate(caller.id, params);
  if (caller.id.startsWith('jira') && mode !== 'wait' && !flow.steps.some((s) => /coment|comment/i.test(`${s.name} ${s.task || ''}`))) {
    tpl.notes.push('Este flujo no tiene un step que comente en Jira: añade un step final "Comentar en Jira" (acceso Atlassian) que comente el resultado en {{vars.issue}}.');
  }
  if (b.ai && String(b.description || '').trim()) {
    const out = await integ.adaptWithAI({ caller, flow, description: b.description, template: tpl, reach, lintCtx });
    return { ...out, reachability: reach, template: tpl };
  }
  return { ...tpl, reachability: reach, lint: integ.lintIntegration(tpl.files, { ...lintCtx, mappedVars: tpl.mapping?.vars, base: reach.base, texts: [...tpl.setup, ...tpl.notes] }), ai: { used: false } };
}));
app.post('/api/integrations/lint', wrap((req) => {
  const { lintCtx, reach } = integCtx(req.body?.flow, req.body?.caller);
  return integ.lintIntegration(Array.isArray(req.body?.files) ? req.body.files : [], { ...lintCtx, mappedVars: req.body?.vars, base: reach.base });
}));
const invokeBases = () => {
  const cfg = store.getConfig();
  const remote = integ.reachability(integ.CALLERS.find((c) => c.id === 'jenkins-declarative'), { host: HOST, port: PORT, publicUrl: cfg.publicUrl });
  return { localBase: `http://127.0.0.1:${PORT}`, remote, cliPath: path.join(ROOT, 'bin', 'afs.js') };
};
const withSlugs = (flow) => { if (!flow.steps.some((s) => !s.slug)) return flow; const f = store.updateFlow(flow.id, () => {}); engine.flowChanged(f); return f; }; // saveFlow assigns them
app.get('/api/flows/:id/steps/:stepId/invoke', wrap((req) => {
  const flow = withSlugs(need(req.params.id));
  const r = store.findStep(flow, req.params.stepId); if (!r.step) throw fail(r.status, r.error, r.code);
  const scope = req.query.scope === 'from' ? 'from' : 'only';
  return integ.stepInvoke(flow, r.step, { ...invokeBases(), scope, fromSet: scope === 'from' ? engine.fromSetOf(flow, r.step.id) : null });
}));
app.get('/api/flows/:id/invoke.md', wrap((req, res) => {
  const flow = withSlugs(need(req.params.id));
  res.type('text/markdown; charset=utf-8').send(integ.invokeDoc(flow, invokeBases()));
  return undefined;
}));
// STEPINV-9: <flow folder>/INVOKE.md follows every change of the flow (written only when its text changes)
const invokeTimers = new Map(); const invokeLast = new Map();
const writeInvokeDoc = (flowId) => {
  const flow = store.getFlow(flowId);
  if (!flow) { invokeLast.delete(flowId); return; }
  const file = store.flowFile(flowId, 'INVOKE.md');
  try {
    const md = integ.invokeDoc(flow, invokeBases());
    if (invokeLast.get(flowId) === md && fs.existsSync(file)) return;
    try { if (fs.readFileSync(file, 'utf8') === md) { invokeLast.set(flowId, md); return; } } catch {} // a restart does not touch an unchanged file
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, md); invokeLast.set(flowId, md);
  } catch (e) { console.error('[invoke.md]', e.message); }
  writeReadme(flow);
};
/** Spec 09 WS-11: README.md of the flow's folder (only when the text changed; never over a README the person wrote). */
function writeReadme(flow, dir = store.flowDir(flow.id)) {
  const file = path.join(dir, 'README.md');
  try {
    const md = integ.flowReadme(flow);
    let cur = null; try { if (!fs.lstatSync(file).isFile()) return 'not-ours'; cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur === md) return 'same';
    if (cur !== null && !cur.startsWith(integ.README_MARK)) return 'not-ours';
    fs.writeFileSync(file, md); return 'written';
  } catch (e) { console.error('[README.md]', e.message); return 'error'; }
}
const scheduleInvokeDoc = (flowId) => { clearTimeout(invokeTimers.get(flowId)); invokeTimers.set(flowId, setTimeout(() => { invokeTimers.delete(flowId); writeInvokeDoc(flowId); }, 300)); };
const invokeRev = new Map();
engine.bus.on('msg', (m) => {
  if (m?.type === 'flow.updated' && m.flowId) { const k = `${m.flow?.rev}|${m.flow?.name}`; if (invokeRev.get(m.flowId) !== k) { invokeRev.set(m.flowId, k); scheduleInvokeDoc(m.flowId); } }
  else if (m?.type === 'flows.changed') for (const f of store.listFlows()) scheduleInvokeDoc(f.id);
});
app.get('/api/integrations/inbound', wrap((req) => integ.inboundSince(Number(req.query.since) || 0)));
app.put('/api/info/public-url', wrap((req) => {
  const url = String(req.body?.url || '').trim();
  let clean;
  if (url) {
    try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) throw new Error(); clean = (u.origin + u.pathname).replace(/\/+$/, ''); }
    catch { throw fail(400, 'URL inválida: debe ser https://host[/ruta] sin usuario ni contraseña', 'BAD_URL'); }
  }
  const out = { publicUrl: store.setConfig({ publicUrl: clean }).publicUrl || null };
  for (const f of store.listFlows()) scheduleInvokeDoc(f.id); // the remote base of every INVOKE.md changed
  return out;
}));
// spec 11 ISO-4/10: the token of one flow (UI key only)
app.get('/api/flows/:id/token', wrap((req) => TOK.meta(need(req.params.id).id, { reveal: req.query.reveal === '1' })));
app.post('/api/flows/:id/token', wrap((req) => ({ token: TOK.issue(need(req.params.id).id), ...TOK.meta(req.params.id) })));
app.delete('/api/flows/:id/token', wrap((req) => { TOK.revoke(need(req.params.id).id); return { exists: false }; }));
app.put('/api/info/admin-token', wrap((req) => { if (typeof req.body?.enabled !== 'boolean') throw fail(400, '"enabled" debe ser true o false', 'BAD_REQUEST'); store.setConfig({ adminDisabled: !req.body.enabled }); return { adminEnabled: req.body.enabled }; }));
app.get('/api/info', wrap(() => ({
  adminEnabled: !store.getConfig().adminDisabled,
  token: store.getConfig().token, port: PORT, host: HOST, root: ROOT, publicUrl: store.getConfig().publicUrl || null,
  cli: path.join(ROOT, 'bin', 'afs.js'), mcp: path.join(ROOT, 'bin', 'mcp.js'), node: process.execPath,
})));
app.post('/api/info/rotate-token', wrap(() => ({ token: store.rotateToken().token })));

// ----- static / vite -----
// Everything except /api/ext (token) is for this machine only, also the dev server and its /@fs files.
app.use((req, res, next) => {
  if (!isLocalReq(req)) return res.status(403).json({ error: 'Solo accesible desde esta máquina', code: 'FORBIDDEN' });
  next();
});
const server = http.createServer(app);
server.keepAliveTimeout = 65000; // longer than typical client idle gaps (CI scripts polling between commands)
server.headersTimeout = 66000;
if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(ROOT, 'dist'))) {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: path.join(ROOT, 'client'), configFile: path.join(ROOT, 'vite.config.js'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

// ----- websocket (UI only: loopback + same host) -----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return;
  const origin = req.headers.origin || '';
  if (!isLocalReq(req) || !hasUiKey(req) || (origin && !okHost(origin.replace(/^https?:\/\//, '')))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
engine.bus.on('msg', (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});

// spec 09: one folder per flow (migrates the old layout once; a locked file stops the start, nothing is lost)
try { store.ensureLayout(); } catch (e) { console.error(e.message); process.exit(1); }
store.getConfig(); // ensure token exists
// a stray rejected promise (a check, a hook, a socket) must not take the whole app down: log it loudly instead
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e?.stack || e); });

for (const f of store.listFlows()) { if (store.linkOf(f.id)) continue; const g = store.getFlow(f.id); if (g?.steps?.some((s) => !s.slug)) store.updateFlow(f.id, () => {}); } // a linked flow.json is never rewritten at boot (its slugs settle in memory, saved on the next edit)
for (const f of store.listFlows()) { const full = store.getFlow(f.id); if (full) { engine.syncSchedule(full); W.syncPolling(full); scheduleInvokeDoc(full.id); } }
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `El puerto ${PORT} ya está en uso: ¿hay otro Agent Flow Studio corriendo?` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  // Only after owning the port: a second instance that fails to start must not touch the first one's runs.
  const recovered = engine.recoverStaleRuns();
  if (recovered) console.log(`${recovered} ejecución(es) interrumpidas por el reinicio marcadas como 'interrupted'.`);
  // spec 27: attention list from disk (after the recovery), then notifications; no toast storm, one summary
  // spec 28: the flow review (lint in the background, AI review on demand) feeds the 🔔 list with kind 'review'
  review.init({ bus: engine.bus, emit: (m) => engine.bus.emit('msg', m), refreshAttention: (flowId) => attention.refreshFlow(flowId) });
  attention.init({ bus: engine.bus, pausedRuns: engine.pausedRuns, emit: (m) => engine.bus.emit('msg', m), cachedPreflight, reviewItem: review.attentionItem, watchItem: W.attentionItem, approvalItem: OUT.attentionItem, skillUpdateItem });
  SK.startUpdateScheduler({ flows: () => store.listFlows().map((f) => store.getFlow(f.id)).filter(Boolean), skip: (f) => !!quarantineProblem(f), emit: (m) => engine.bus.emit('msg', m) });
  OUT.init({ httpAuth: W.authHeader });
  { const n = OUT.recoverExecuting({ listFlows: store.listFlows, getRun: store.getRun, saveRun: store.saveRun }); if (n) console.log(`${n} ejecución(es) con una aprobación interrumpida: vuelven a esperar decisión.`); }
  W.init({
    emit: (m) => engine.bus.emit('msg', m), onNews: (flowId) => attention.refreshFlow(flowId),
    // a run started by news has the guards of an external run (its input comes from outside)
    runGuard: async (flow, only) => { const p = engine.externalRunProblem(flow, { only }); if (p) return p.error; const g = await gate(flow, { status() {} }, only); return g?.error || null; },
  });
  // spec 11: a flow called by another passes the same checks as an external run (its input comes from outside)
  engine.setChildGuard(async (flow, only) => { const g = await gate(flow, { status() {} }, only); return g?.error || null; });
  setOnChecked((flowId) => engine.bus.emit('msg', { type: 'preflight.checked', flowId }));
  notify.init({ getBaseUrl: () => `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}` });
  notify.bootSummary(recovered);
  console.log(`Agent Flow Studio → ${uiUrl()}  (claude: ${claudeBin()})`);
  console.log('Abre ese enlace (lleva la clave de la interfaz); luego este navegador la recuerda.');
});
