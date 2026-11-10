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

const isLoopback = (ip = '') => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const okHost = (h = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);

const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (!res.headersSent) res.json(r ?? { ok: true }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const need = (id) => { const f = store.getFlow(id); if (!f) throw fail(404, 'Flujo no encontrado'); return f; };

// ============ external API (token) ============
const ext = express.Router();
ext.use((req, res, next) => {
  const auth = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-afs-token') || req.query.token;
  const token = store.getConfig().token;
  const a = Buffer.from(String(auth || '')); const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Token inválido o ausente. Usa Authorization: Bearer <token> (lo ves en Ayuda → Invocar desde fuera).' });
  next();
});
const extFlow = (x) => { const f = store.findFlow(decodeURIComponent(x)); if (!f) throw fail(404, `Flujo no encontrado: ${x}`); return f; };
const inputOf = (body) => {
  if (typeof body === 'string') return body;
  if (body && typeof body.input === 'string') return body.input;
  if (body && body.input !== undefined) return JSON.stringify(body.input, null, 2);
  const rest = { ...(body || {}) }; delete rest.step; delete rest.wait; delete rest.timeoutSec; delete rest.source;
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''; // raw webhook payloads (Bitbucket, Jenkins…)
};
const truthy = (v) => v === true || v === 1 || /^(1|true|yes|si|sí)$/i.test(String(v ?? ''));

ext.get('/ping', wrap(() => ({ ok: true, app: 'agent-flow-studio' })));
ext.get('/flows', wrap(() => store.listFlows().map((f) => {
  const full = store.getFlow(f.id);
  return { id: f.id, name: f.name, description: full.description, vars: full.vars, steps: full.steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind })) };
})));
ext.post('/flows/:flow/run', wrap(async (req) => {
  const flow = extFlow(req.params.flow);
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const stepRef = body.step || req.query.step;
  let only = null;
  if (stepRef) { const s = flow.steps.find((x) => x.id === stepRef || x.name.toLowerCase() === String(stepRef).toLowerCase()); if (!s) throw fail(404, `Step no encontrado: ${stepRef}`); only = s.id; }
  if (body.vars && typeof body.vars === 'object') store.updateFlow(flow.id, (f) => { f.vars = { ...(f.vars || {}), ...body.vars }; });
  const trigger = String(body.source || req.query.source || 'api').slice(0, 20);
  const runId = engine.startRun(flow.id, { input: inputOf(req.body), only, trigger });
  if (!truthy(body.wait ?? req.query.wait)) return { runId, status: 'running', statusUrl: `/api/ext/flows/${flow.id}/runs/${runId}` };
  const run = await engine.waitRun(flow.id, runId, Number(body.timeoutSec || req.query.timeoutSec || 900) * 1000);
  return engine.runSummary(store.getFlow(flow.id), run);
}));
ext.get('/flows/:flow/runs/:runId', wrap((req) => {
  const flow = extFlow(req.params.flow);
  const run = store.getRun(flow.id, req.params.runId);
  if (!run) throw fail(404, 'Ejecución no encontrada');
  return engine.runSummary(flow, run);
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
  if (!isLoopback(req.socket.remoteAddress) || !okHost(req.get('host'))) return res.status(403).json({ error: 'Solo accesible desde esta máquina' });
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
    return prev ? { ...s, memory: prev.memory, lastRun: prev.lastRun, chatSessionId: prev.chatSessionId, chatContextHash: prev.chatContextHash } : store.newStep(s);
  });
  const ids = new Set(steps.map((s) => s.id));
  const edges = (body.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const next = { ...cur, name: body.name ?? cur.name, description: body.description ?? cur.description, cwd: body.cwd ?? cur.cwd, vars: body.vars ?? cur.vars, schedule: body.schedule ?? cur.schedule, steps, edges };
  engine.topoLevels(next); // throws on cycles
  const saved = store.saveFlow(next);
  engine.syncSchedule(saved);
  return saved;
}));
app.delete('/api/flows/:id', wrap((req) => { engine.stopRuns(req.params.id); engine.clearSchedule(req.params.id); store.deleteFlow(req.params.id); }));

// ----- runs -----
app.post('/api/flows/:id/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', trigger: 'manual' }) })));
app.post('/api/flows/:id/steps/:stepId/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', only: req.params.stepId, trigger: 'manual' }) })));
app.post('/api/flows/:id/stop', wrap((req) => ({ stopped: engine.stopRuns(req.params.id) })));
app.get('/api/flows/:id/runs', wrap((req) => store.listRuns(req.params.id)));
app.get('/api/flows/:id/runs/:runId', wrap((req) => store.getRun(req.params.id, req.params.runId)));

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
const server = http.createServer(app);
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
  if (!isLoopback(req.socket.remoteAddress) || !okHost(req.headers.host) || (origin && !okHost(origin.replace(/^https?:\/\//, '')))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
engine.bus.on('msg', (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});

store.getConfig(); // ensure token exists
for (const f of store.listFlows()) { const full = store.getFlow(f.id); if (full) engine.syncSchedule(full); }
server.listen(PORT, HOST, () => console.log(`Agent Flow Studio → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (claude: ${claudeBin()})`));
