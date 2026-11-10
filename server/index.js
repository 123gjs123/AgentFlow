// HTTP + WebSocket server. Binds to 127.0.0.1 only: hooks can run shell commands.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
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

const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (!res.headersSent) res.json(r ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
const need = (id) => { const f = store.getFlow(id); if (!f) throw new Error('Flujo no encontrado'); return f; };

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
app.get('/api/flows/:id', wrap((req) => need(req.params.id)));
app.put('/api/flows/:id', wrap((req) => {
  const cur = need(req.params.id);
  const body = req.body || {};
  // Server-managed fields are never overwritten by the UI.
  const byId = new Map(cur.steps.map((s) => [s.id, s]));
  const steps = (body.steps || []).map((s) => {
    const prev = byId.get(s.id);
    const base = prev ? { ...s, memory: prev.memory, lastRun: prev.lastRun, chatSessionId: prev.chatSessionId, chatContextHash: prev.chatContextHash } : store.newStep(s);
    return base;
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
app.post('/api/flows/:id/steps', wrap((req) => {
  const step = store.newStep(req.body || {});
  const f = store.updateFlow(req.params.id, (fl) => fl.steps.push(step));
  return { step, flow: f };
}));

// ----- runs -----
app.post('/api/flows/:id/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', trigger: 'manual' }) })));
app.post('/api/flows/:id/steps/:stepId/run', wrap((req) => ({ runId: engine.startRun(req.params.id, { input: req.body?.input || '', only: req.params.stepId, trigger: 'manual' }) })));
app.post('/api/flows/:id/stop', wrap((req) => ({ stopped: engine.stopRuns(req.params.id) })));
app.get('/api/flows/:id/runs', wrap((req) => store.listRuns(req.params.id)));
app.get('/api/flows/:id/runs/:runId', wrap((req) => store.getRun(req.params.id, req.params.runId)));
// Webhook trigger (local): POST JSON/text → flow input
app.post('/api/flows/:id/trigger', wrap((req) => {
  need(req.params.id);
  const input = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}, null, 2);
  return { runId: engine.startRun(req.params.id, { input, trigger: 'webhook' }) };
}));

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

// ----- catalog -----
app.get('/api/catalog', wrap((req) => ({
  skills: listSkills(req.query.cwd), agents: listAgents(req.query.cwd),
  tools: lastInit.tools, mcpServers: lastInit.mcpServers, rateLimit: lastRateLimit.info, claudeBin: claudeBin(),
})));
app.post('/api/catalog/probe', wrap(async (req) => probeInit(req.body?.cwd)));

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

// ----- websocket -----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
engine.bus.on('msg', (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});

for (const f of store.listFlows()) { const full = store.getFlow(f.id); if (full) engine.syncSchedule(full); }
server.listen(PORT, HOST, () => console.log(`Agent Flow Studio → http://${HOST}:${PORT}  (claude: ${claudeBin()})`));
