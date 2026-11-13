// Spec 25: every chat is a conversation. The chat discusses, asks back and evaluates as its step (role, agent or
// skill); every change it wants (step, flow, context, skill/agent files, the deliverable of a break, memory, runs) is a
// proposal that only takes effect when the user confirms it, and can be discarded or refined with a new proposal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, skill, agent, cmd, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let s;
before(async () => { s = await startServer({ name: 'conv' }); await s.start(); });
after(async () => { await s?.stop(); });

const chat = async (flowId, key, message, extra = {}) => {
  const before = (await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`)).length;
  await s.uiOk('POST', `/api/flows/${flowId}/chat/${key}`, { message, ...extra });
  for (let i = 0; i < 200; i++) {
    const msgs = await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`);
    const fresh = msgs.slice(before);
    if (fresh.some((m) => m.role !== 'user' && m.status !== 'running') && fresh.every((m) => m.status !== 'running')) return fresh.filter((m) => m.role === 'assistant').pop();
    await sleep(100);
  }
  throw new Error('el chat no respondió');
};
const apply = (flowId, key, m, i = 0, extra = {}) => s.ui('POST', `/api/flows/${flowId}/chat/${key}/apply`, { messageId: m.id, proposalId: m.proposals[i].id, ...extra });

test('conversación de ida y vuelta: el step pregunta, el usuario responde, propone, se ajusta con otra propuesta, se descarta la vieja y se aplica la nueva', async () => {
  const a = role('Analista', 'Analiza tickets', { role: 'QA senior' });
  const f = await s.flow('Conversa', [a]);
  const q = await chat(f.id, a.id, 'quiero mejorar tu tarea [[mock:ask-back ¿para qué equipo y qué tipos de ticket?]]');
  assert.match(q.text, /¿para qué equipo/);
  assert.deepEqual(q.proposals, []);
  const p1 = await chat(f.id, a.id, 'Offer Platform, bugs y stories [[mock:propose {"task":"Analiza bugs y stories de Offer Platform"}]]');
  assert.ok(p1.proposals[0].id);
  const n = s.calls().length;
  const p2 = await chat(f.id, a.id, 'agrega también Hot Fix [[mock:propose {"task":"Analiza bugs, stories y hot fixes de Offer Platform"}]]');
  assert.ok(s.callsSince(n)[0].resume, 'misma sesión: la conversación sigue');
  assert.equal((await s.getFlow(f.id)).steps[0].task, 'Analiza tickets', 'nada cambia sin confirmar');
  assert.deepEqual((await s.ui('POST', `/api/flows/${f.id}/chat/${a.id}/discard`, { messageId: p1.id, proposalId: p1.proposals[0].id })).body, { discarded: true });
  assert.equal((await apply(f.id, a.id, p2)).status, 200);
  assert.equal((await s.getFlow(f.id)).steps[0].task, 'Analiza bugs, stories y hot fixes de Offer Platform');
  const msgs = await s.uiOk('GET', `/api/flows/${f.id}/chat/${a.id}`);
  assert.equal(msgs.find((m) => m.id === p1.id).proposals[0].discarded, true);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/${a.id}/discard`, { messageId: p2.id, proposalId: p2.proposals[0].id })).status, 409, 'una aplicada no se descarta');
});

test('el chat habla como su step: el system prompt pide actuar con su rol/agente/skill y evaluar directo; agente → --agent, skill → su archivo legible', async () => {
  const k = skill('Arquitecto', 'qa-test-architect', 'diseña');
  const g = agent('Revisor', 'reviewer', 'revisa');
  const f = await s.flow('Habla como', [k, g]);
  let n = s.calls().length;
  await chat(f.id, k.id, 'evaluá este caso: login con usuario bloqueado');
  let c = s.callsSince(n)[0];
  assert.match(c.append, /COMO ese step[\s\S]*aplicando su skill[\s\S]*SKILL\.md/);
  assert.match(c.append, /evaluación[\s\S]*hazla directamente/);
  assert.match(c.prompt, /Tipo: Skill "qa-test-architect" \(archivo: .*SKILL\.md\)/);
  n = s.calls().length;
  await chat(f.id, g.id, 'revisá esto');
  c = s.callsSince(n)[0];
  assert.equal(s.argOf(c, '--agent'), 'reviewer');
});

test('archivos de la skill o del agente: se proponen con el contenido completo, se ven junto a la versión actual y solo se escriben al confirmar; fuera de su carpeta no', async () => {
  const k = skill('Arquitecto', 'qa-test-architect', 'diseña', { id: 's_k' });
  const r = role('Rol', 'x', { id: 's_r' });
  const g = agent('Revisor', 'reviewer', 'revisa', { id: 's_g' });
  const f = await s.flow('Archivos', [k, r, g]);
  const skillMd = path.join(s.dirs.home, '.claude', 'skills', 'qa-test-architect', 'SKILL.md');
  const before = fs.readFileSync(skillMd, 'utf8');
  const m = await chat(f.id, 's_k', 'agregá una sección de riesgos [[mock:propose-file SKILL.md|# qa-test-architect\nNueva sección de riesgos.\n]]');
  const p = m.proposals[0];
  assert.equal(p.kind, 'file');
  assert.equal(path.resolve(p.target), path.resolve(skillMd));
  assert.equal(p.current, before, 'muestra la versión actual');
  assert.equal(fs.readFileSync(skillMd, 'utf8'), before, 'sin confirmar no escribe');
  assert.equal((await apply(f.id, 's_k', m)).status, 200);
  assert.equal(fs.readFileSync(skillMd, 'utf8'), '# qa-test-architect\nNueva sección de riesgos.\n');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/chat/s_k`)).find((x) => x.id === m.id).proposals[0].prev, before, 'guarda la versión anterior');
  // a new file inside the skill folder is allowed
  const m2 = await chat(f.id, 's_k', '[[mock:propose-file referencias/riesgos.md|tabla de riesgos]]');
  assert.equal((await apply(f.id, 's_k', m2)).status, 200);
  assert.ok(fs.existsSync(path.join(path.dirname(skillMd), 'referencias', 'riesgos.md')));
  // outside the folder, from a role step, or another file for an agent: rejected
  const out = await chat(f.id, 's_k', '[[mock:propose-file ../../settings.json|{}]]');
  assert.match(out.proposals[0].error, /solo archivos dentro de/);
  assert.equal((await apply(f.id, 's_k', out)).status, 400);
  assert.ok(!fs.existsSync(path.join(s.dirs.home, '.claude', 'settings.json')));
  const fromRole = await chat(f.id, 's_r', '[[mock:propose-file x.md|hola]]');
  assert.match(fromRole.proposals[0].error, /Skill o Agente/);
  assert.equal((await apply(f.id, 's_r', fromRole)).status, 400);
  const agentOther = await chat(f.id, 's_g', '[[mock:propose-file otro.md|hola]]');
  assert.equal((await apply(f.id, 's_g', agentOther)).status, 400);
  const agentOwn = await chat(f.id, 's_g', `[[mock:propose-file reviewer.md|---\nname: reviewer\n---\nRevisa con más detalle.]]`);
  assert.equal((await apply(f.id, 's_g', agentOwn)).status, 200);
  assert.match(fs.readFileSync(path.join(s.dirs.home, '.claude', 'agents', 'reviewer.md'), 'utf8'), /más detalle/);
});

test('chat del flujo: propone cambios al flujo (descripción, variables, contexto, varios steps por nombre) y ejecuciones; todo espera confirmación', async () => {
  const a = role('Diseñador', 'diseña', { id: 's_d' });
  const b = cmd('Tests', 'Write-Output "tests {{vars.amb}} {{input}}"', { id: 's_t' });
  const f = await s.flow('Flujo conversado', [a, b], [['s_d', 's_t']], { vars: { amb: 'qa' } });
  const patch = { description: 'QA de Offer Platform', vars: { amb: 'ppd' }, addContext: [{ type: 'url', url: 'https://example.com/doc', label: 'Guía' }, { type: 'raro', path: 'x' }], steps: { 'Diseñador': { task: 'diseña con riesgos', addContext: [{ type: 'jira', ref: 'SBK-1' }] }, NoExiste: { task: 'x' } } };
  const m = await chat(f.id, '_flow', `mejoremos el flujo [[mock:propose-flow ${JSON.stringify(patch)}]] [[mock:propose-run {"step":"Tests","input":"SBK-9"}]]`);
  assert.deepEqual(m.proposals.map((p) => p.kind), ['flow', 'run']);
  assert.deepEqual(m.proposals[1].patch, { step: 's_t', stepName: 'Tests', input: 'SBK-9' });
  let g = await s.getFlow(f.id);
  assert.equal(g.vars.amb, 'qa');
  const r = (await apply(f.id, "_flow", m, 0)).body;
  assert.deepEqual(r.warnings, ['Steps no encontrados: NoExiste']);
  g = await s.getFlow(f.id);
  assert.equal(g.description, 'QA de Offer Platform');
  assert.equal(g.vars.amb, 'ppd');
  assert.deepEqual(g.contextSources.map((c) => [c.type, c.url]), [['url', 'https://example.com/doc']], 'tipos desconocidos fuera');
  assert.equal(g.steps.find((x) => x.id === 's_d').task, 'diseña con riesgos');
  assert.equal(g.steps.find((x) => x.id === 's_d').contextSources[0].ref, 'SBK-1');
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${f.id}/runs`), [], 'la ejecución espera confirmación');
  const { runId } = (await apply(f.id, "_flow", m, 1)).body;
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.trigger, 'chat');
  assert.equal(run.steps.s_t.output, 'tests ppd SBK-9');
  assert.equal((await apply(f.id, '_flow', m, 1)).status, 409, 'no se ejecuta dos veces');
  const bad = await chat(f.id, '_flow', '[[mock:propose-run {"step":"Fantasma"}]]');
  assert.equal((await apply(f.id, '_flow', bad)).status, 400);
  assert.match(s.calls().filter((c) => /# Chat general del flujo/.test(c.append)).pop().prompt, /Contexto del flujo: Guía: https:\/\/example\.com\/doc/);
});

test('ejecución propuesta por un chat pasa por los requisitos antes de arrancar (412)', async () => {
  const a = cmd('Uno', 'Write-Output ok', { id: 's_u' });
  const f = await s.flow('Con requisitos', [a], [], { requirements: [{ id: 'rq', type: 'file', path: path.join(s.tmp, 'no-existe.env'), label: 'secretos' }] });
  const m = await chat(f.id, 's_u', '[[mock:propose-run {"step":"este"}]]');
  const r = await apply(f.id, 's_u', m);
  assert.equal(r.status, 412);
  assert.equal(r.body.code, 'PREFLIGHT_FAILED');
});

test('break: el entregable se corrige conversando; "Usar esta salida" no continúa sola, al aprobar siguen los datos corregidos', async () => {
  const a = role('Genera', '[[mock:json {"casos":["a"]}]]', { id: 's_gen', output: { format: 'json' }, breakpoint: 'after' });
  const b = role('Usa', '[[mock:echo]]', { id: 's_use' });
  const f = await s.flow('Entregable', [a, b], [['s_gen', 's_use']]);
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' })).runId;
  await s.waitRun(f.id, runId, 30000, (r) => r.status === 'paused');
  const m = await chat(f.id, 's_gen', 'faltan casos negativos [[mock:propose-output Corregido con negativos. ```json\n{"casos":["a","neg-1"]}\n```]]', { runId });
  const p = m.proposals[0];
  assert.equal(p.kind, 'output');
  assert.deepEqual(p.json, { casos: ['a', 'neg-1'] });
  assert.equal((await apply(f.id, 's_gen', m, 0)).status, 200, 'la ejecución en pausa en ese step se adjunta sola');
  let run = await s.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`);
  assert.equal(run.status, 'paused', 'sigue en pausa hasta aprobar');
  assert.equal(run.pauses[0].edited, true);
  assert.match(run.pauses[0].output, /neg-1/);
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_gen.reviewed.action, 'edit');
  assert.deepEqual(run.steps.s_gen.json, { casos: ['a', 'neg-1'] });
  // with the flow stopped there is no execution to correct: an output proposal is rejected
  const late = await chat(f.id, 's_gen', '[[mock:propose-output otra salida]]');
  assert.equal((await apply(f.id, 's_gen', late)).status, 400);
  assert.match(run.steps.s_use.output, /neg-1/, 'el siguiente recibe el entregable corregido');
});

test('chat general: una respuesta enrutada al flujo trae propuestas aplicables desde el chat general', async () => {
  const a = role('Uno', 'x', { id: 's_1' });
  const f = await s.flow('General', [a]);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_global`, { message: `cambiá la descripción [[mock:route ask flow cambia la descripción [[mock:propose-flow {"description":"nueva"}]]]]` });
  let mirror;
  for (let i = 0; i < 100 && !mirror; i++) { mirror = (await s.uiOk('GET', `/api/flows/${f.id}/chat/_global`)).find((m) => m.role === 'assistant' && m.status === 'done'); await sleep(100); }
  assert.ok(mirror, 'respuesta enrutada');
  assert.equal(mirror.routedKey, '_flow');
  assert.equal(mirror.proposals[0]?.kind, 'flow');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/_flow/apply`, { messageId: mirror.originMessageId, proposalId: mirror.proposals[0].id })).status, 200);
  assert.equal((await s.getFlow(f.id)).description, 'nueva');
});

// ---------- C9: a running flow follows its process; humans talk to a step only when stopped or in a break ----------
test('con el flujo en ejecución: chats y propuestas se rechazan (409) sin frenar nada; "cancelar respuesta" nunca detiene la ejecución', async () => {
  const a = role('Lento', '[[mock:sleep 3]] [[mock:say listo]]', { id: 's_l' });
  const f = await s.flow('Corriendo', [a]);
  const idle = await chat(f.id, 's_l', '[[mock:propose {"task":"otra"}]]');
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' })).runId;
  await sleep(300);
  for (const key of ['s_l', '_flow', '_global']) {
    const r = await s.ui('POST', `/api/flows/${f.id}/chat/${key}`, { message: 'hola' });
    assert.equal(r.status, 409, key);
    assert.equal(r.body.code, 'FLOW_RUNNING');
  }
  assert.equal((await apply(f.id, 's_l', idle)).status, 409, 'tampoco se aplican cambios mientras corre');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_l/cancel`, {});
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success', 'la ejecución siguió su proceso');
  assert.equal((await apply(f.id, 's_l', idle)).status, 200, 'detenido: se aplica');
});

test('en un break: solo el step en pausa conversa (con esa ejecución adjunta aunque se escriba desde su panel); el resto espera', async () => {
  const a = cmd('Pausa', 'Write-Output "salida real 42"', { id: 's_p', breakpoint: 'after' });
  const b = role('Otro', 'x', { id: 's_o' });
  const f = await s.flow('Break solo', [a, b], [['s_p', 's_o']]);
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' })).runId;
  await s.waitRun(f.id, runId, 30000, (r) => r.status === 'paused');
  const n = s.calls().length;
  const m = await chat(f.id, 's_p', '¿qué salió? [[mock:propose-run {"step":"este"}]]');
  assert.match(s.callsSince(n)[0].prompt, /<run-review>[\s\S]*salida real 42/, 'adjunta la ejecución en pausa');
  assert.equal((await apply(f.id, 's_p', m)).status, 409, 'no se lanza otra ejecución desde un break');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/s_o`, { message: 'hola' })).status, 409, 'otro step: no');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/_flow`, { message: 'hola' })).status, 409, 'chat del flujo: no');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' });
  assert.equal((await s.waitRun(f.id, runId)).status, 'success');
});

test('trigger externo (ask por API): sigue el proceso definido sin esperar a nadie: ejecuta directo, guarda memoria directo, y los cambios al flujo solo se informan', async () => {
  const a = cmd('Tests', 'Write-Output "tests ok {{input}}"', { id: 's_x' });
  const b = role('Experto', 'x', { id: 's_e' });
  const f = await s.flow('Externo', [a, b], [['s_x', 's_e']]);
  const r1 = await s.ext('POST', `/flows/${f.id}/ask`, { message: `corré los tests [[mock:route run_step s_x EXT-1]]` });
  assert.equal(r1.status, 200);
  const runId = r1.body.answer.match(/\((r_\w+)\)/)[1];
  assert.equal((await s.waitRun(f.id, runId)).steps.s_x.output, 'tests ok EXT-1');
  const r2 = await s.ext('POST', `/flows/${f.id}/ask`, { message: 'anotá esto [[mock:remember el ambiente es PPD]] [[mock:propose {"task":"cambiada"}]]', step: 'Experto' });
  assert.deepEqual(r2.body.remembered, ['el ambiente es PPD']);
  assert.deepEqual(r2.body.pendingProposals.map((p) => p.kind), ['step']);
  const g = await s.getFlow(f.id);
  assert.equal(g.steps.find((x) => x.id === 's_e').memory[0].text, 'el ambiente es PPD');
  assert.equal(g.steps.find((x) => x.id === 's_e').task, 'x', 'la definición no cambia desde fuera');
});

// ---------- UI ----------
test('UI: la propuesta se muestra con Aplicar / Descartar y "sigue conversando"; aplicar cambia el step; no hay "modo mejora"', async (t) => {
  const ui = await openUi('conv-ui');
  if (ui.skipReason) { t.skip(ui.skipReason); return; }
  const { page } = ui;
  try {
    const f = await ui.s.flow('Conversa UI', [role('Analista', 'tarea vieja', { id: 's_a', position: { x: 100, y: 100 } })]);
    await page.goto(ui.s.base + '/');
    await page.locator('header select').selectOption(f.id);
    await page.locator('.react-flow__node', { hasText: 'Analista' }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await page.getByText('modo mejora').count(), 0);
    const box = page.locator('.chat-input textarea');
    await box.fill('mejorá la tarea [[mock:propose {"task":"tarea nueva"}]]');
    await box.press('Enter');
    const prop = page.locator('.proposal[data-kind="step"]').last();
    await prop.getByText('o sigue conversando para ajustarla').waitFor();
    await prop.getByRole('button', { name: 'Descartar' }).waitFor();
    await prop.getByRole('button', { name: 'Aplicar' }).click();
    await prop.getByText('aplicado').waitFor();
    for (let i = 0; i < 40; i++) { if ((await ui.s.getFlow(f.id)).steps[0].task === 'tarea nueva') break; await sleep(100); }
    assert.equal((await ui.s.getFlow(f.id)).steps[0].task, 'tarea nueva');
    await box.fill('[[mock:propose {"task":"otra"}]]');
    await box.press('Enter');
    const p2 = page.locator('.proposal[data-kind="step"]').last();
    await p2.getByRole('button', { name: 'Descartar' }).click();
    await p2.getByText('descartado').waitFor();
    assert.equal((await ui.s.getFlow(f.id)).steps[0].task, 'tarea nueva');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { name: t.name, passed: false }); throw e; }
  finally { await ui.close?.(); }
});
