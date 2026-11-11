// HTTP + WebSocket server.
// - UI API (/api/*): loopback only, same-origin, JSON-only writes (blocks CSRF / DNS rebinding).
// - External API (/api/ext/*): token required (Bearer, X-AFS-Token or ?token=). Usable from scripts,
//   Jenkins, webhooks, the `afs` CLI and the MCP server. Reachable from other hosts only if HOST is set.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as engine from './engine.js';
import { listAgents, listSkills } from './catalog.js';
import { lastInit, lastRateLimit, probeInit, claudeBin } from './claude.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.use(express.json({ limit: '5mb' }));
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
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-original-host', 'ngrok-trace-id'];
const proxied = (headers = {}) => PROXY_HEADERS.some((h) => headers[h] !== undefined);
const isLocalReq = (req) => isLoopback(req.socket.remoteAddress) && okHost(req.headers.host) && !proxied(req.headers);

const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (!res.headersSent) res.json(r ?? { ok: true }); }
  catch (e) {
    const status = e.status || (e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError ? 500 : 400);
    if (status >= 500) console.error(e);
    res.status(status).json({ error: e.message, code: e.code || CODES[status] || 'ERROR' });
  }
};
const CODES = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE', 500: 'INTERNAL' };
const fail = (status, msg, code) => Object.assign(new Error(msg), { status, code });
const need = (id) => { const f = store.getFlow(id); if (!f) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND'); return f; };

// ============ external API (token) ============
const ext = express.Router();
ext.use((req, res, next) => {
  const auth = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-afs-token') || req.query.token;
  const token = store.getConfig().token;
  const a = Buffer.from(String(auth || '')); const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Token inválido o ausente. Usa Authorization: Bearer <token> (lo ves en Ayuda → Invocar desde fuera).', code: 'UNAUTHORIZED' });
  next();
});
const extFlow = (x) => { const f = store.findFlow(decodeURIComponent(x)); if (!f) throw fail(404, `Flujo no encontrado: ${x}`, 'FLOW_NOT_FOUND'); return f; };
const extRun = (flow, id) => { const r = engine.getRunLive(flow.id, id); if (!r) throw fail(404, 'Ejecución no encontrada', 'RUN_NOT_FOUND'); return r; };
const inputOf = (body) => {
  if (typeof body === 'string') return body;
  if (body && typeof body.input === 'string') return body.input;
  if (body && body.input !== undefined) return JSON.stringify(body.input, null, 2);
  const rest = { ...(body || {}) }; for (const k of ['step', 'wait', 'timeoutSec', 'source', 'vars', 'usePins', 'deadlineSec']) delete rest[k];
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''; // raw webhook payloads (Bitbucket, Jenkins…)
};
const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const truthy = (v) => v === true || v === 1 || /^(1|true|yes|si|sí)$/i.test(String(v ?? ''));

ext.get('/ping', wrap(() => ({ ok: true, app: 'agent-flow-studio' })));
ext.get('/flows', wrap(() => store.listFlows().map((f) => {
  const full = store.getFlow(f.id);
  return { id: f.id, name: f.name, description: full.description, vars: full.vars, steps: full.steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind })) };
})));
// Run a flow or one step. vars are per run (never saved into the flow). External runs ignore pins unless usePins.
ext.post('/flows/:flow/run', wrap(async (req, res) => {
  const flow = extFlow(req.params.flow);
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const stepRef = body.step || req.query.step;
  let only = null;
  if (stepRef) { const s = flow.steps.find((x) => x.id === stepRef || x.name.toLowerCase() === String(stepRef).toLowerCase()); if (!s) throw fail(404, `Step no encontrado: ${stepRef}`, 'STEP_NOT_FOUND'); only = s.id; }
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
  const input = inputOf(req.body);
  const key = String(req.get('idempotency-key') || '').trim();
  let bodyHash = null;
  if (key) {
    if (key.length > 200) throw fail(400, 'Idempotency-Key: máximo 200 caracteres', 'BAD_IDEMPOTENCY_KEY');
    bodyHash = crypto.createHash('sha256').update(stableJson({ input, only, vars: body.vars || null, usePins: truthy(body.usePins) })).digest('hex');
    const prev = store.getIdem(`${flow.id}:${key}`);
    if (prev) {
      if (prev.bodyHash !== bodyHash) throw fail(409, 'Esa Idempotency-Key ya se usó con otro contenido', 'IDEMPOTENCY_CONFLICT');
      const prevRun = engine.getRunLive(flow.id, prev.runId);
      // Replay only runs that are going or went well: a retry after a failure must be able to run again.
      if (prevRun && ['running', 'success'].includes(prevRun.status)) return respond(prev.runId, { idempotentReplay: true });
    }
  }
  const problem = engine.externalRunProblem(flow, { only, vars: body.vars });
  if (problem) throw fail(problem.status, problem.error, problem.code);
  const trigger = String(body.source || req.query.source || 'api').slice(0, 20);
  const runId = engine.startRun(flow.id, { input, only, trigger, vars: body.vars || null, usePins: truthy(body.usePins), deadlineSec: body.deadlineSec, idempotencyKey: key || null });
  if (key) store.setIdem(`${flow.id}:${key}`, { runId, bodyHash, flowId: flow.id });
  return respond(runId);
}));
ext.get('/flows/:flow/runs/:runId', wrap((req) => {
  const flow = extFlow(req.params.flow);
  return engine.runSummary(flow, extRun(flow, req.params.runId));
}));
ext.post('/flows/:flow/runs/:runId/cancel', wrap((req) => {
  const flow = extFlow(req.params.flow);
  const run = extRun(flow, req.params.runId);
  if (run.status !== 'running' || !engine.stopRun(flow.id, run.id)) throw fail(409, `La ejecución ya terminó (${run.status})`, 'RUN_FINISHED');
  return { runId: run.id, status: 'stopped' };
}));
ext.get('/flows/:flow/runs/:runId/events', wrap((req) => {
  const flow = extFlow(req.params.flow);
  return engine.runEvents(flow, extRun(flow, req.params.runId), Number(req.query.after) || 0);
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
    ans = await engine.stepChat(flow.id, s.id, message, { origin: 'api' });
    return { answer: ans.text, routedTo: s.name, status: ans.status, remembered: ans.remembered };
  }
  ans = await engine.globalChat(flow.id, message);
  return { answer: ans.text, routedTo: ans.routedTo || 'Flujo general', status: ans.status };
}));
app.use('/api/ext', ext);

// ============ UI API guard ============
app.use('/api', (req, res, next) => {
  if (!isLocalReq(req)) return res.status(403).json({ error: 'Solo accesible desde esta máquina', code: 'FORBIDDEN' });
  const origin = req.get('origin');
  if (origin && !okHost(origin.replace(/^https?:\/\//, ''))) return res.status(403).json({ error: 'Origen no permitido' });
  // POST is the only "simple" cross-site method: force a JSON content-type so browsers must preflight.
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Se requiere application/json' });
  next();
});

// ----- flows -----
app.get('/api/flows', wrap(() => store.listFlows()));
app.post('/api/flows', wrap((req) => {
  const f = store.newFlow(req.body?.name);
  if (req.body?.template === 'demo') {
    const a = store.newStep({ name: 'Analizar requerimiento', kind: 'role', role: 'Eres un QA analista senior. Detectas ambigüedades y riesgos.', task: 'Analiza el requerimiento del input y lista: objetivo, reglas de negocio, riesgos y preguntas abiertas.' });
    const b = store.newStep({ name: 'Diseñar casos', kind: 'skill', skillRef: 'qa-test-architect', task: 'Con el análisis previo, diseña casos de prueba priorizados por riesgo (Gherkin breve).' });
    const c = store.newStep({ name: 'Revisión adversarial', kind: 'skill', skillRef: 'qa-adversarial', task: 'Critica los casos diseñados: huecos, aserciones débiles, negativos faltantes.' });
    f.steps.push(a, b, c);
    f.edges.push({ id: store.uid('e_'), source: a.id, target: b.id }, { id: store.uid('e_'), source: b.id, target: c.id });
  }
  return store.saveFlow(f);
}));
app.post('/api/flows/generate', wrap(async (req) => {
  const description = String(req.body?.description || '').trim();
  if (description.length < 10) throw fail(400, 'Describe el flujo con un poco más de detalle');
  return engine.generateFlow(description, { skills: listSkills(req.body?.cwd), agents: listAgents(req.body?.cwd) });
}));
app.get('/api/flows/:id', wrap((req) => need(req.params.id)));
app.put('/api/flows/:id', wrap((req) => {
  const cur = need(req.params.id);
  const body = req.body || {};
  // Server-managed fields are never overwritten by the UI.
  const byId = new Map(cur.steps.map((s) => [s.id, s]));
  const steps = (body.steps || []).map((s) => {
    const prev = byId.get(s.id);
    return prev ? { ...s, memory: prev.memory, lastRun: prev.lastRun, pinned: prev.pinned, chatSessionId: prev.chatSessionId, chatContextHash: prev.chatContextHash } : store.newStep({ ...s, pinned: undefined });
  });
  const ids = new Set(steps.map((s) => s.id));
  for (const s of cur.steps) if (!ids.has(s.id)) store.clearChat(cur.id, s.id); // no orphaned step chats
  const edges = (body.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const next = { ...cur, name: body.name ?? cur.name, description: body.description ?? cur.description, cwd: body.cwd ?? cur.cwd, vars: body.vars ?? cur.vars, schedule: body.schedule ?? cur.schedule, runTimeoutSec: body.runTimeoutSec ?? cur.runTimeoutSec, steps, edges };
  engine.topoLevels(next); // throws on cycles
  const saved = store.saveFlow(next);
  engine.syncSchedule(saved);
  return saved;
}));
// What is left in a flow besides its steps (shown when the canvas is empty, cleared by /reset).
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
  });
  engine.syncSchedule(f);
  return f;
}));
app.delete('/api/flows/:id', wrap((req) => { engine.stopRuns(req.params.id); engine.clearSchedule(req.params.id); store.deleteFlow(req.params.id); }));

// ----- runs -----
app.post('/api/flows/:id/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', trigger: 'manual' }) })));
app.post('/api/flows/:id/steps/:stepId/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', only: req.params.stepId, trigger: 'manual' }) })));
app.post('/api/flows/:id/steps/:stepId/pin', wrap((req) => engine.pinStep(req.params.id, req.params.stepId, req.body || {})));
app.delete('/api/flows/:id/steps/:stepId/pin', wrap((req) => engine.unpinStep(req.params.id, req.params.stepId)));
app.post('/api/flows/:id/stop', wrap((req) => ({ stopped: engine.stopRuns(req.params.id) })));
app.post('/api/flows/:id/runs/:runId/cancel', wrap((req) => {
  need(req.params.id);
  if (!engine.getRunLive(req.params.id, req.params.runId)) throw fail(404, 'Ejecución no encontrada', 'RUN_NOT_FOUND');
  if (!engine.stopRun(req.params.id, req.params.runId)) throw fail(409, 'La ejecución no está en curso', 'RUN_FINISHED');
  return { runId: req.params.runId, status: 'stopped' };
}));
app.get('/api/flows/:id/runs', wrap((req) => store.listRuns(req.params.id)));
app.get('/api/flows/:id/runs/:runId', wrap((req) => engine.getRunLive(req.params.id, req.params.runId)));

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
  const p = key === '_global' ? engine.globalChat(id, message) : engine.stepChat(id, key, message, { improve: !!req.body?.improve });
  p.catch((e) => console.error('chat error', e));
  return { accepted: true };
}));
app.delete('/api/flows/:id/chat/:key', wrap((req) => {
  const { id, key } = req.params;
  store.clearChat(id, key);
  const f = store.updateFlow(id, (fl) => {
    if (key === '_flow' || key === '_global') { fl.globalSessionId = null; fl.globalContextHash = null; }
    const s = fl.steps.find((x) => x.id === key);
    if (s) { s.chatSessionId = null; s.chatContextHash = null; }
  });
  if (key === '_global') store.clearChat(id, '_flow');
  return f;
}));
app.post('/api/flows/:id/chat/:key/apply', wrap((req) => engine.applyProposal(req.params.id, req.params.key, req.body.messageId, req.body.proposalId)));

// ----- catalog / info -----
app.get('/api/catalog', wrap((req) => ({
  skills: listSkills(req.query.cwd), agents: listAgents(req.query.cwd),
  tools: lastInit.tools, mcpServers: lastInit.mcpServers, rateLimit: lastRateLimit.info, claudeBin: claudeBin(),
})));
app.post('/api/catalog/probe', wrap(async (req) => probeInit(req.body?.cwd)));
app.get('/api/info', wrap(() => ({
  token: store.getConfig().token, port: PORT, host: HOST, root: ROOT,
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
  if (!isLocalReq(req) || (origin && !okHost(origin.replace(/^https?:\/\//, '')))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
engine.bus.on('msg', (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});

store.getConfig(); // ensure token exists

for (const f of store.listFlows()) { const full = store.getFlow(f.id); if (full) engine.syncSchedule(full); }
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `El puerto ${PORT} ya está en uso: ¿hay otro Agent Flow Studio corriendo?` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  // Only after owning the port: a second instance that fails to start must not touch the first one's runs.
  const recovered = engine.recoverStaleRuns();
  if (recovered) console.log(`${recovered} ejecución(es) interrumpidas por el reinicio marcadas como 'interrupted'.`);
  console.log(`Agent Flow Studio → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (claude: ${claudeBin()})`);
});
