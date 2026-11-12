// Spec 18: arrows on any side, N inputs / N outputs with the same output distributed per arrow (JSON field,
// condition, or the step itself choosing destinations and content), reusable boxes (library) and breaks to
// validate outputs (pause before/after, continue, edit, retry with feedback, skip, stop) from the UI and the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'routing' }); await s.start(); });
after(async () => { await s?.stop(); });

const edge = (source, target, extra = {}) => ({ id: `e_${source}_${target}`, source, target, ...extra });
/** Flow with explicit edge objects (handles, label, when, pick). */
const flowE = async (name, steps, edges, extra = {}) => {
  const f = await s.uiOk('POST', '/api/flows', { name });
  return s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, ...extra, steps, edges });
};
const startUi = async (flowId, input = '', body = {}) => (await s.uiOk('POST', `/api/flows/${flowId}/run`, { input, ...body })).runId;
const pausedAt = (f, runId, stepId) => s.waitRun(f, runId, 30000, (r) => r.status !== 'running' && (r.status !== 'paused' || r.pauses?.some((p) => p.stepId === stepId)));

test('flechas: lados de las cajas, etiqueta, condición y campo se guardan; valores inválidos se descartan', async () => {
  const a = role('A', 'x', { id: 's_a' }); const b = role('B', 'x', { id: 's_b' });
  const f = await flowE('Flechas', [a, b], [edge('s_a', 's_b', { sourceHandle: 'out-bottom', targetHandle: 'in-top', label: 'casos', pick: 'casos', when: { type: 'json', path: 'ok', op: 'equals', value: 'true' }, junk: 1 })]);
  assert.deepEqual(f.edges[0], { id: 'e_s_a_s_b', source: 's_a', target: 's_b', sourceHandle: 'out-bottom', targetHandle: 'in-top', label: 'casos', pick: 'casos', when: { type: 'json', path: 'ok', op: 'equals', value: 'true' } });
  const g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, edges: [edge('s_a', 's_b', { sourceHandle: 'arriba', when: { type: 'eval', value: 'x' } })] });
  assert.deepEqual(g.edges[0], { id: 'e_s_a_s_b', source: 's_a', target: 's_b' });
});

test('una caja → N salidas con el mismo output distribuido por campo; N entradas → una caja (fan-out / fan-in)', async () => {
  const src = role('Analizar', '[[mock:json {"casos":["c1","c2"],"riesgos":{"alto":2},"resumen":"ok"}]]', { id: 's_src', output: { format: 'json' } });
  const casos = role('Casos', '[[mock:echo]]', { id: 's_casos' });
  const riesgos = cmd('Riesgos', 'Write-Output "altos={{steps.Analizar.json.riesgos.alto}}"; [Console]::In.ReadToEnd()', { id: 's_riesgos' });
  const todo = role('Todo', '[[mock:echo]]', { id: 's_todo' });
  const unir = role('Unir', '[[mock:echo]]', { id: 's_unir' });
  const f = await flowE('Distribución', [src, casos, riesgos, todo, unir], [
    edge('s_src', 's_casos', { pick: 'casos', sourceHandle: 'out-top' }),
    edge('s_src', 's_riesgos', { pick: 'riesgos', label: 'solo riesgos', sourceHandle: 'out-right' }),
    edge('s_src', 's_todo', { sourceHandle: 'out-bottom' }),
    edge('s_casos', 's_unir'), edge('s_riesgos', 's_unir', { targetHandle: 'in-top' }), edge('s_todo', 's_unir', { targetHandle: 'in-bottom' }),
  ]);
  const run = await s.runUi(f.id, 'REQ');
  assert.equal(run.status, 'success', JSON.stringify(Object.values(run.steps).map((x) => [x.status, x.error])));
  const out = (id) => run.steps[id].output;
  assert.match(out('s_casos'), /### Analizar → campo casos\n\[\n  "c1",\n  "c2"\n\]/);
  assert.ok(!out('s_casos').includes('riesgos'), 'Casos recibe solo su campo');
  assert.match(out('s_riesgos'), /"alto": 2/);
  assert.ok(!out('s_riesgos').includes('c1'));
  assert.match(out('s_todo'), /### Analizar\nResultado del step\.\n\nDatos \(JSON\)/, 'sin campo: recibe todo');
  for (const n of ['### Casos', '### Riesgos', '### Todo']) assert.ok(out('s_unir').includes(n), `Unir recibe de ${n}`);
  assert.deepEqual(run.steps.s_unir.inputs.map((i) => i.step).sort(), ['Casos', 'Riesgos', 'Todo']);
});

test('condiciones en flechas: solo pasa la rama que cumple; el resto queda "no enrutado" (no es error) en cascada', async () => {
  const clas = role('Clasificar', '[[mock:json {"riesgo":"alto","score":8}]]', { id: 's_cl', output: { format: 'json' } });
  const alto = role('Riesgo alto', '[[mock:say revisión completa]]', { id: 's_alto' });
  const bajo = role('Riesgo bajo', '[[mock:say smoke]]', { id: 's_bajo' });
  const trasBajo = role('Tras bajo', 'x', { id: 's_tb' });
  const score = role('Score', '[[mock:say score alto]]', { id: 's_sc' });
  const texto = role('Texto', '[[mock:say por texto]]', { id: 's_tx' });
  const cierre = role('Cierre', '[[mock:echo]]', { id: 's_ci' });
  const f = await flowE('Condiciones', [clas, alto, bajo, trasBajo, score, texto, cierre], [
    edge('s_cl', 's_alto', { when: { type: 'json', path: 'riesgo', op: 'equals', value: 'alto' }, label: 'si es alto' }),
    edge('s_cl', 's_bajo', { when: { type: 'json', path: 'riesgo', op: 'equals', value: 'bajo' } }),
    edge('s_bajo', 's_tb'),
    edge('s_cl', 's_sc', { when: { type: 'json', path: 'score', op: 'gte', value: 7 } }),
    edge('s_cl', 's_tx', { when: { type: 'regex', pattern: 'NO-APARECE' } }),
    edge('s_alto', 's_ci'), edge('s_bajo', 's_ci'),
  ]);
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'success', 'las ramas no enrutadas no son errores');
  assert.equal(run.steps.s_alto.status, 'success');
  assert.equal(run.steps.s_sc.status, 'success');
  for (const id of ['s_bajo', 's_tb', 's_tx']) { assert.equal(run.steps[id].status, 'skipped'); assert.equal(run.steps[id].skipReason, 'not_routed'); }
  assert.match(run.steps.s_bajo.events[0].text, /no se cumple: json\.riesgo equals bajo/);
  assert.equal(run.steps.s_ci.status, 'success', 'con una entrada activa alcanza');
  assert.match(run.steps.s_ci.output, /### Riesgo alto\nrevisión completa/);
  assert.ok(!run.steps.s_ci.output.includes('### Riesgo bajo'));
  const g = await s.getFlow(f.id);
  assert.equal(g.steps.find((x) => x.id === 's_bajo').lastRun.skipReason, 'not_routed');
  assert.equal(g.steps.find((x) => x.id === 's_bajo').lastRun.error, null);
});

test('el agente decide destinos y contenido por destino (<route to>), y se le explica en su system prompt', async () => {
  const dec = role('Triage', '[[mock:say Analicé el ticket. <route to="Backend">endpoint /bets falla con 500</route> <route to="QA"/>]]', { id: 's_tr' });
  const back = role('Backend', '[[mock:echo]]', { id: 's_be' });
  const qa = role('QA', '[[mock:echo]]', { id: 's_qa' });
  const front = role('Frontend', 'x', { id: 's_fe' });
  const f = await flowE('Triage', [dec, back, qa, front], ['s_be', 's_qa', 's_fe'].map((t) => edge('s_tr', t, { when: { type: 'route' }, ...(t === 's_fe' ? { label: 'solo si es de UI' } : {}) })));
  const n = s.calls().length;
  const run = await s.runUi(f.id, 'SBK-1');
  const sys = s.callsSince(n).find((c) => /# Step "Triage"/.test(c.append)).append;
  assert.match(sys, /## Destinos[\s\S]*- Backend\n- QA\n- Frontend: solo si es de UI/);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_tr.output, 'Analicé el ticket.', 'las etiquetas <route> no siguen en la salida');
  assert.deepEqual(run.steps.s_tr.routes, [{ to: 'Backend', payload: 'endpoint /bets falla con 500' }, { to: 'QA', payload: null }]);
  assert.match(run.steps.s_be.output, /### Triage → elegido por el step\nendpoint \/bets falla con 500/);
  assert.ok(!run.steps.s_be.output.includes('Analicé'), 'Backend recibe SOLO su contenido');
  assert.match(run.steps.s_qa.output, /### Triage → elegido por el step\nAnalicé el ticket\./);
  assert.equal(run.steps.s_fe.skipReason, 'not_routed');
  // external summary exposes the routes
  const ext = await s.runExt(f.id, { input: 'SBK-2' });
  assert.deepEqual(ext.body.steps.find((x) => x.step === 'Triage').routes.map((r) => r.to), ['Backend', 'QA']);
});

test('un comando también puede enrutar imprimiendo <route>; ejecutar un step solo ignora condiciones y aplica el campo', async () => {
  const c = cmd('Decidir', 'Write-Output \'{"lista":[1,2]}\'; Write-Output \'<route to="Usar"/>\'', { id: 's_dc', output: { format: 'json' } });
  const u = role('Usar', '[[mock:echo]]', { id: 's_us' });
  const n = role('Nunca', '[[mock:echo]]', { id: 's_nu' });
  const f = await flowE('Comando enruta', [c, u, n], [edge('s_dc', 's_us', { when: { type: 'route' }, pick: 'lista' }), edge('s_dc', 's_nu', { when: { type: 'route' } })]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_dc.status, 'success', run.steps.s_dc.error);
  assert.match(run.steps.s_us.output, /### Decidir → campo lista\n\[\n  1,\n  2\n\]/);
  assert.equal(run.steps.s_nu.skipReason, 'not_routed');
  const solo = await s.runUi(f.id, '', { stepId: 's_nu' });
  assert.equal(solo.steps.s_nu.status, 'success', 'un step solo no evalúa condiciones');
  assert.match(solo.steps.s_nu.output, /### Decidir \(de una ejecución anterior\)/);
});

test('caja de contexto con flechas: igual a lo enviado (campo + destinos) y avisa si con los datos de ejemplo la flecha no pasaría', async () => {
  const a = role('Origen', '[[mock:json {"items":[1],"tipo":"x"}]]', { id: 's_o', output: { format: 'json' } });
  const b = role('Destino', '[[mock:say listo]] <route to="Fin"/>', { id: 's_d' });
  const c = role('Fin', 'x', { id: 's_f' });
  const d = role('Condicional', 'x', { id: 's_k' });
  const f = await flowE('Preview flechas', [a, b, c, d], [edge('s_o', 's_d', { pick: 'items', label: 'items' }), edge('s_d', 's_f', { when: { type: 'route' } }), edge('s_o', 's_k', { when: { type: 'json', path: 'tipo', op: 'equals', value: 'y' } })]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  const sent = s.callsSince(n).find((x) => /# Step "Destino"/.test(x.append));
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_d/preview`, { sample: { runId: run.id } });
  assert.equal(pv.user, sent.prompt);
  assert.equal(pv.system, sent.append);
  assert.ok(pv.sections.some((x) => x.id === 'routes'));
  const pk = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_k/preview`, {});
  assert.ok(pk.warnings.some((w) => w.code === 'EDGE_INACTIVE'), JSON.stringify(pk.warnings));
});

test('break DESPUÉS: la ejecución se pausa con la salida a validar (WS run.paused), el deadline no corre y "continuar" sigue', async () => {
  const a = role('Generar', '[[mock:json {"casos":3}]]', { id: 's_g', output: { format: 'json' }, breakpoint: 'after' });
  const b = role('Usar', '[[mock:echo]]', { id: 's_u' });
  const f = await flowE('Break después', [a, b], [edge('s_g', 's_u')], { runTimeoutSec: 10 });
  const w = await s.ws();
  const runId = await startUi(f.id, 'x');
  let run = await pausedAt(f.id, runId, 's_g');
  assert.equal(run.status, 'paused');
  assert.deepEqual(run.pauses.map((p) => [p.step, p.when]), [['Generar', 'after']]);
  assert.deepEqual(run.pauses[0].json, { casos: 3 });
  assert.deepEqual(run.pauses[0].actions, ['continue', 'edit', 'retry', 'stop']);
  assert.equal(run.steps.s_u, undefined, 'lo siguiente no corrió');
  assert.equal((await s.getFlow(f.id)).steps[0].lastRun.status, 'paused');
  await w.waitFor((m) => m.type === 'run.paused' && m.runId === runId && m.stepId === 's_g');
  await sleep(11000); // longer than runTimeoutSec: paused time does not count
  run = await s.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`);
  assert.equal(run.status, 'paused', 'el deadline no corre en pausa');
  const r = await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' });
  assert.deepEqual(r, { runId, stepId: 's_g', action: 'continue' });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_g.reviewed.action, 'continue');
  assert.ok(run.pausedMs >= 10000);
  assert.ok(w.msgs.some((m) => m.type === 'run.resumed' && m.runId === runId));
  w.close();
});

test('break DESPUÉS: editar la salida (los siguientes reciben la versión corregida) y re-ejecutar con una corrección', async () => {
  const a = role('Redactar', '[[mock:say borrador con error]]', { id: 's_r', breakpoint: 'after' });
  const b = role('Publicar', '[[mock:echo]]', { id: 's_p' });
  const f = await flowE('Editar', [a, b], [edge('s_r', 's_p')]);
  let runId = await startUi(f.id);
  await pausedAt(f.id, runId, 's_r');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'edit', output: 'texto corregido por QA', json: { ok: true } });
  let run = await s.waitRun(f.id, runId);
  assert.equal(run.steps.s_r.output, 'texto corregido por QA');
  assert.deepEqual(run.steps.s_r.json, { ok: true });
  assert.equal(run.steps.s_r.reviewed.action, 'edit');
  assert.match(run.steps.s_p.output, /### Redactar\ntexto corregido por QA/);
  assert.equal((await s.getFlow(f.id)).steps[0].lastRun.output, 'texto corregido por QA');
  // retry with feedback
  runId = await startUi(f.id);
  await pausedAt(f.id, runId, 's_r');
  const n = s.calls().length;
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'retry', feedback: 'Quita el error y usa tono formal' });
  run = await s.waitRun(f.id, runId, 30000, (r) => r.status === 'paused' && r.pauses?.[0]?.round === 1);
  const retryCall = s.callsSince(n).find((c) => /# Step "Redactar"/.test(c.append));
  assert.match(retryCall.prompt, /## Corrección pedida por el revisor\n[\s\S]*Quita el error y usa tono formal[\s\S]*Salida anterior:\nborrador con error/);
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_r.reviewRounds, 1);
});

test('break ANTES: muestra lo que va a recibir; omitir (los siguientes siguen) o detener la ejecución', async () => {
  const a = role('Datos', '[[mock:say datos de entrada]]', { id: 's_da' });
  const b = role('Caro', '[[mock:say gasté tokens]]', { id: 's_ca', breakpoint: 'before' });
  const c = role('Final', '[[mock:say fin]]', { id: 's_fi' });
  const f = await flowE('Break antes', [a, b, c], [edge('s_da', 's_ca', { label: 'contexto' }), edge('s_ca', 's_fi')]);
  let runId = await startUi(f.id, 'IN');
  let run = await pausedAt(f.id, runId, 's_ca');
  assert.equal(run.pauses[0].when, 'before');
  assert.deepEqual(run.pauses[0].inputs.map((i) => [i.step, i.via, i.output]), [['Datos', 'contexto', 'datos de entrada']]);
  assert.equal(run.pauses[0].input, 'IN');
  const n = s.calls().length;
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'edit', output: 'x' })).body.code, 'BAD_ACTION', 'antes no se puede editar');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'skip' });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_ca.skipReason, 'review');
  assert.equal(run.steps.s_fi.status, 'success');
  assert.ok(!s.callsSince(n).some((c) => /# Step "Caro"/.test(c.append)), 'el step omitido no llamó a Claude');
  runId = await startUi(f.id, 'IN');
  await pausedAt(f.id, runId, 's_ca');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'stop' });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.steps.s_fi.skipReason, 'cancelled');
});

test('breaks en ramas paralelas: hay que indicar el step; cancelar con pausas pendientes; errores del resume', async () => {
  const a = role('Rama A', '[[mock:say a]]', { id: 's_ra', breakpoint: 'after' });
  const b = role('Rama B', '[[mock:say b]]', { id: 's_rb', breakpoint: 'after' });
  const f = await flowE('Paralelo breaks', [a, b], []);
  const runId = await startUi(f.id);
  await s.waitRun(f.id, runId, 30000, (r) => r.pauses?.length === 2);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' })).body.code, 'STEP_REQUIRED');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_ra', action: 'continue' });
  let run = await s.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`);
  assert.equal(run.status, 'paused', 'sigue en pausa mientras quede alguna');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_ra', action: 'continue' })).body.code, 'NOT_PAUSED');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_rb', action: 'edit' })).body.code, 'BAD_ACTION');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/cancel`, {});
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.steps.s_ra.status, 'success');
  assert.equal(run.steps.s_rb.status, 'stopped', 'ya se había ejecutado: queda detenido en su break');
  assert.deepEqual(run.pauses, []);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${runId}/resume`, {})).body.code, 'RUN_NOT_FOUND');
  // UI run without breaks
  const r2 = await s.uiOk('POST', `/api/flows/${f.id}/run`, { breakpoints: false });
  assert.equal((await s.waitRun(f.id, r2.runId)).status, 'success');
});

test('API externa: los breaks se ignoran por defecto; con breakpoints:true la espera vuelve en "paused" y se reanuda por API', async () => {
  const a = role('Revisable', '[[mock:say para revisar]]', { id: 's_rv', breakpoint: 'after' });
  const f = await flowE('Breaks externos', [a], []);
  const plain = await s.runExt(f.id, {});
  assert.equal(plain.body.status, 'success');
  const dry = await s.ext('POST', `/flows/${f.id}/run`, { dryRun: true, breakpoints: true });
  assert.deepEqual(dry.body.breakpoints, ['Revisable (after)']);
  const r = await s.runExt(f.id, { breakpoints: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'paused');
  assert.equal(r.body.pauses[0].output, 'para revisar');
  const res = await s.ext('POST', `/flows/${f.id}/runs/${r.body.runId}/resume`, { step: 'Revisable', action: 'edit', output: 'aprobado con cambios' });
  assert.equal(res.status, 200);
  let st;
  for (let i = 0; i < 100; i++) { st = await s.ext('GET', `/flows/${f.id}/runs/${r.body.runId}`); if (st.body.status !== 'running' && st.body.status !== 'paused') break; await sleep(100); }
  assert.equal(st.body.status, 'success');
  assert.equal(st.body.result, 'aprobado con cambios');
  assert.equal((await s.ext('POST', `/flows/${f.id}/runs/${r.body.runId}/resume`, { step: 'nope' })).body.code, 'STEP_NOT_FOUND');
});

test('caída del servidor con una ejecución en pausa → "interrupted" al reiniciar', async () => {
  const c = await startServer({ name: 'pausecrash' });
  await c.start();
  try {
    const a = role('Pausado', '[[mock:say x]]', { id: 's_pz', breakpoint: 'after' });
    const f = await c.flow('Pausa caída', [a]);
    const { runId } = await c.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await c.waitRun(f.id, runId, 20000, (r) => r.status === 'paused');
    await c.kill(); await c.start();
    const run = await c.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.steps.s_pz.status, 'interrupted');
    assert.equal((await c.getFlow(f.id)).steps[0].lastRun.status, 'interrupted');
  } finally { await c.stop(); }
});

test('cajas reutilizables: guardar un step configurado en la biblioteca (sin estado de ejecución) y borrarlo', async () => {
  const a = role('Revisor QA', 'Revisa {{input}}', { id: 's_lib', role: 'QA senior', model: 'sonnet', assertions: [{ type: 'contains', value: 'OK' }], breakpoint: 'after' });
  const f = await s.flow('Biblioteca', [a]);
  await s.uiOk('POST', `/api/flows/${f.id}/memory/s_lib`, { text: 'privado de este flujo' });
  await s.runUi(f.id, '', { stepId: 's_lib' }).catch(() => {});
  const item = await s.uiOk('POST', '/api/library', { flow: f.id, step: 's_lib', name: 'Revisor estándar' });
  assert.equal(item.name, 'Revisor estándar');
  assert.equal(item.step.role, 'QA senior');
  assert.deepEqual(item.step.assertions, [{ type: 'contains', value: 'OK' }]);
  for (const k of ['id', 'lastRun', 'memory', 'pinned', 'chatSessionId', 'position']) assert.ok(!(k in item.step), `${k} no viaja`);
  assert.ok((await s.uiOk('GET', '/api/library')).some((x) => x.id === item.id));
  // it can be inserted into another flow as a new box
  const g = await s.flow('Usa biblioteca', [{ ...item.step, id: 's_copy', name: 'Revisor (copia)' }]);
  assert.equal(g.steps[0].role, 'QA senior');
  await s.uiOk('DELETE', `/api/library/${item.id}`);
  assert.ok(!(await s.uiOk('GET', '/api/library')).some((x) => x.id === item.id));
  assert.equal((await s.ui('POST', '/api/library', { flow: f.id, step: 'nope' })).status, 404);
});

test('review: reintentar con la misma Idempotency-Key mientras la ejecución está en pausa reutiliza esa ejecución', async () => {
  const a = role('Pausa idem', '[[mock:say x]]', { id: 's_pi', breakpoint: 'after' });
  const f = await flowE('Idem en pausa', [a], []);
  const r1 = await s.runExt(f.id, { breakpoints: true }, { 'Idempotency-Key': 'k-paused' });
  assert.equal(r1.body.status, 'paused');
  const r2 = await s.runExt(f.id, { breakpoints: true }, { 'Idempotency-Key': 'k-paused' });
  assert.equal(r2.body.runId, r1.body.runId);
  assert.equal(r2.body.idempotentReplay, true);
  await s.ext('POST', `/flows/${f.id}/runs/${r1.body.runId}/resume`, { action: 'stop' });
});

test('review: un step fijado que eligió destinos (<route>) los conserva; resumen por flecha no se mezcla', async () => {
  const r = role('Router', '[[mock:say hecho <route to="B">para B</route>]]', { id: 's_rt' });
  const b = role('B', '[[mock:echo]]', { id: 's_rb2' });
  const c = role('C', '[[mock:echo]]', { id: 's_rc2' });
  const f = await flowE('Pin con rutas', [r, b, c], [edge('s_rt', 's_rb2', { when: { type: 'route' } }), edge('s_rt', 's_rc2', { when: { type: 'route' } })]);
  await s.runUi(f.id);
  await s.uiOk('POST', `/api/flows/${f.id}/steps/s_rt/pin`, { fromLast: true });
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_rt.pinned, true);
  assert.equal(run.steps.s_rb2.status, 'success', 'la ruta fijada sigue activa');
  assert.match(run.steps.s_rb2.output, /para B/);
  assert.equal(run.steps.s_rc2.skipReason, 'not_routed');
});

test('review: corrección de JSON conserva los destinos elegidos y lleva las instrucciones del step', async () => {
  const r = role('Router JSON', '[[mock:badjson-then-fix {"ok":true}]] [[mock:emit-route Dest]]', { id: 's_rj', output: { format: 'json' } });
  const d = role('Dest', '[[mock:echo]]', { id: 's_dj' });
  const f = await flowE('Corrección rutas', [r, d], [edge('s_rj', 's_dj', { when: { type: 'route' } })]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_rj.status, 'success', run.steps.s_rj.error);
  const corr = s.callsSince(n).find((c) => c.resume && /no cumple el formato/.test(c.prompt));
  assert.match(corr.append, /# Step "Router JSON"/, 'la corrección lleva el system prompt del step');
  assert.equal(run.steps.s_dj.status, 'success', 'el destino elegido antes de la corrección se mantiene');
});
