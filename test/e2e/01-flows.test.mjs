// Flow creation and editing: blank/demo/AI-generated flows, graph validation, server-managed fields, leftovers/reset,
// skills/agents catalog (user + project), CLI probe, definition files, UI shell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'flows' }); await s.start(); });
after(async () => { await s?.stop(); });

test('crea un flujo vacío y uno demo (rol → skill → skill)', async () => {
  const blank = await s.uiOk('POST', '/api/flows', { name: 'Vacío' });
  assert.match(blank.id, /^f_/);
  assert.equal(blank.steps.length, 0);
  const demo = await s.uiOk('POST', '/api/flows', { name: 'Demo', template: 'demo' });
  assert.deepEqual(demo.steps.map((x) => x.kind), ['role', 'skill', 'skill']);
  assert.equal(demo.edges.length, 2);
  const list = await s.uiOk('GET', '/api/flows');
  assert.ok(list.some((f) => f.id === blank.id) && list.some((f) => f.id === demo.id));
});

test('editar: steps, edges, vars, cwd, runTimeoutSec; edges inválidos se descartan; ciclos se rechazan', async () => {
  const a = role('A', 't'); const b = role('B', 't'); const c = role('C', 't');
  const f = await s.flow('Grafo', [a, b, c], [[a.id, b.id], [b.id, c.id]], { vars: { env: 'qa' }, cwd: s.dirs.project, runTimeoutSec: 120, description: 'd' });
  assert.equal(f.edges.length, 2);
  assert.deepEqual(f.vars, { env: 'qa' });
  assert.equal(f.runTimeoutSec, 120);
  // self-loop and dangling edges are dropped
  const g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, edges: [...f.edges, { id: 'x', source: a.id, target: a.id }, { id: 'y', source: a.id, target: 's_nope' }] });
  assert.equal(g.edges.length, 2);
  // cycle
  const r = await s.ui('PUT', `/api/flows/${f.id}`, { ...f, edges: [...f.edges, { id: 'z', source: c.id, target: a.id }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ciclo/);
});

test('campos gestionados por el servidor (memoria, lastRun, pin) no se pisan desde la UI', async () => {
  const a = role('Mem', 'x');
  const f = await s.flow('Gestionados', [a]);
  await s.uiOk('POST', `/api/flows/${f.id}/memory/${a.id}`, { text: 'hecho importante' });
  await s.uiOk('POST', `/api/flows/${f.id}/steps/${a.id}/pin`, { output: 'fijo' });
  const cur = await s.getFlow(f.id);
  const tampered = { ...cur, steps: cur.steps.map((x) => ({ ...x, memory: [], pinned: null, lastRun: { status: 'success', output: 'falso' } })) };
  const saved = await s.uiOk('PUT', `/api/flows/${f.id}`, tampered);
  assert.equal(saved.steps[0].memory[0].text, 'hecho importante');
  assert.equal(saved.steps[0].pinned.output, 'fijo');
  assert.notEqual(saved.steps[0].lastRun?.output, 'falso');
});

test('memoria: alta y baja manual, del step y del flujo', async () => {
  const a = role('M', 'x');
  const f = await s.flow('Memoria', [a]);
  const item = await s.uiOk('POST', `/api/flows/${f.id}/memory/${a.id}`, { text: 'uno' });
  await s.uiOk('POST', `/api/flows/${f.id}/memory/_flow`, { text: 'global' });
  let g = await s.getFlow(f.id);
  assert.equal(g.steps[0].memory.length, 1);
  assert.equal(g.memory[0].text, 'global');
  await s.uiOk('DELETE', `/api/flows/${f.id}/memory/${a.id}/${item.id}`);
  g = await s.getFlow(f.id);
  assert.equal(g.steps[0].memory.length, 0);
});

test('leftovers y reset por partes; borrar flujo', async () => {
  const a = cmd('Eco', 'Write-Output hola');
  const f = await s.flow('Reset', [a], [], { vars: { x: '1' }, description: 'algo' });
  await s.runUi(f.id);
  let lo = await s.uiOk('GET', `/api/flows/${f.id}/leftovers`);
  assert.equal(lo.runs, 1); assert.equal(lo.vars, 1); assert.equal(lo.description, true);
  await s.uiOk('POST', `/api/flows/${f.id}/reset`, { parts: ['runs', 'vars'] });
  lo = await s.uiOk('GET', `/api/flows/${f.id}/leftovers`);
  assert.equal(lo.runs, 0); assert.equal(lo.vars, 0); assert.equal(lo.description, true);
  const g = await s.uiOk('POST', `/api/flows/${f.id}/reset`, {});
  assert.equal(g.steps.length, 0);
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.equal((await s.ui('GET', `/api/flows/${f.id}`)).status, 404);
});

test('crear flujo con IA (mock): usa el catálogo, mapea accesos y arma el DAG', async () => {
  const before = s.calls().length;
  const f = await s.uiOk('POST', '/api/flows/generate', { description: 'Analizar un ticket de Jira, diseñar casos y revisarlos' });
  const call = s.callsSince(before).find((c) => /Diseñas flujos/.test(c.system));
  assert.ok(call, 'el generador llamó a Claude');
  assert.equal(s.argOf(call, '--model'), 'sonnet');
  assert.equal(s.argOf(call, '--tools'), '', 'el generador no tiene herramientas');
  assert.ok(call.argv.includes('--no-session-persistence') && call.argv.includes('--strict-mcp-config'));
  assert.match(call.prompt, /qa-test-architect/, 'recibe las skills del catálogo');
  assert.equal(f.name, 'Flujo generado (mock)');
  assert.deepEqual(f.steps.map((x) => x.kind), ['role', 'skill', 'agent', 'command']);
  assert.equal(f.steps[1].skillRef, 'qa-test-architect');
  assert.equal(f.steps[2].agentRef, 'reviewer');
  assert.match(f.steps[1].allowedTools, /getJiraIssue/, 'access atlassian-read');
  assert.equal(f.steps[2].permissionMode, 'acceptEdits', 'access edit');
  assert.equal(f.edges.length, 4);
  // the generated flow runs end to end
  const run = await s.runUi(f.id, 'SBK-1');
  assert.equal(run.status, 'success', JSON.stringify(Object.values(run.steps).map((x) => [x.status, x.error])));
});

test('crear flujo con IA: descripción corta → 400; respuesta inválida → error claro', async () => {
  assert.equal((await s.ui('POST', '/api/flows/generate', { description: 'corto' })).status, 400);
  const r = await s.ui('POST', '/api/flows/generate', { description: 'algo que no se puede [[mock:gen-fail]]' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No se pudo generar/);
});

test('catálogo: skills y agentes del usuario y del proyecto; archivo de definición; probe del CLI', async () => {
  const cat = await s.uiOk('GET', `/api/catalog?cwd=${encodeURIComponent(s.dirs.project)}`);
  const skills = cat.skills.map((x) => `${x.name}:${x.source}`);
  assert.ok(skills.includes('qa-test-architect:user') && skills.includes('project-skill:project'), skills.join(','));
  const agents = cat.agents.map((x) => `${x.name}:${x.source}`);
  assert.ok(agents.includes('reviewer:user') && agents.includes('project-agent:project'), agents.join(','));
  assert.match(cat.claudeBin, /claude-mock\.mjs$/);
  const file = await s.uiOk('GET', '/api/catalog/file?kind=skill&name=qa-test-architect');
  assert.match(JSON.stringify(file), /Instrucciones de prueba/);
  const bad = await s.ui('GET', `/api/catalog/file?kind=skill&name=${encodeURIComponent('../../etc/passwd')}`);
  assert.ok(bad.status >= 400, 'solo sirve entradas del catálogo');
  const probe = await s.uiOk('POST', '/api/catalog/probe', {});
  assert.ok(probe.tools.includes('Read'));
  assert.equal(probe.mcpServers[0].name, 'mock-mcp');
});

test('UI: sirve la app, info y rotación de token', async () => {
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<div id="root"|<script/);
  const info = await s.uiOk('GET', '/api/info');
  assert.equal(info.port, s.port);
  const old = s.token;
  const { token } = await s.uiOk('POST', '/api/info/rotate-token', {});
  assert.notEqual(token, old);
  assert.equal((await s.ext('GET', '/ping')).status, 401, 'el token viejo deja de servir');
  s.token = token;
  assert.equal((await s.ext('GET', '/ping')).status, 200);
});
