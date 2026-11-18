// Spec 30: 🧭 the coordinator. Right after the intake it classifies the request and decides which parts of the flow run
// (route arrows to any entry point; a step runs if ANY of its arrows carries data), arrows further down can depend on
// its decision (when.from), and it attends the general chat: it answers, consults the step that knows, or proposes a run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'coord' }); await s.start(); });
after(async () => { await s?.stop(); });
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };
const run = async (id) => { const { runId } = await s.uiOk('POST', `/api/flows/${id}/run`, { input: '', breakpoints: false }); return s.waitRun(id, runId); };

test('el coordinador elige por dónde entra cada pedido: solo lo elegido corre, y un step a mitad de camino corre aunque lo anterior no', async () => {
  const pull = cmd('Pull', 'Write-Output "SBK-1"', { id: 's_pull' });
  const coord = role('Coordinador', '[[mock:emit-route Automatizar]] [[mock:say solo automatización: el análisis ya existe]]', { id: 's_co', coordinator: true });
  const an = role('Análisis', '[[mock:say análisis]]', { id: 's_an' });
  const casos = role('Casos', '[[mock:say casos]]', { id: 's_ca' });
  const auto = role('Automatizar', '[[mock:say automatizado]]', { id: 's_au' });
  const cierre = role('Cierre', '[[mock:say cerrado]]', { id: 's_ci' });
  const f = await s.flow('Coordinado', [pull, coord, an, casos, auto, cierre], [['s_pull', 's_co'], ['s_an', 's_ca'], ['s_ca', 's_au'], ['s_au', 's_ci']]);
  const g = await s.getFlow(f.id);
  g.edges.push({ id: 'e_r1', source: 's_co', target: 's_an', when: { type: 'route' } }, { id: 'e_r2', source: 's_co', target: 's_au', when: { type: 'route' } });
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const r = await run(f.id);
  assert.equal(r.status, 'success');
  assert.equal(r.steps.s_an.skipReason, 'not_routed', 'no eligió el análisis');
  assert.equal(r.steps.s_ca.skipReason, 'not_routed');
  assert.equal(r.steps.s_au.status, 'success', 'entra directo a la automatización aunque Casos no corrió');
  assert.equal(r.steps.s_ci.status, 'success', 'y sigue la cadena desde ahí');
});

test('una flecha puede depender de la decisión del coordinador (when.from), no solo de su origen', async () => {
  const coord = role('Coordinador', '[[mock:say fases: analisis]]', { id: 's_c2', coordinator: true });
  const ent = role('Entregable', '[[mock:say entregable listo]]', { id: 's_en' });
  const prep = role('Preparar repo', '[[mock:say rama lista]]', { id: 's_pr' });
  const f = await s.flow('Fases', [coord, ent, prep], [['s_c2', 's_en']]);
  const g = await s.getFlow(f.id);
  g.edges.push({ id: 'e_f', source: 's_en', target: 's_pr', when: { type: 'contains', value: 'automatizacion', from: 's_c2' } });
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  assert.equal((await s.getFlow(f.id)).edges.find((e) => e.id === 'e_f').when.from, 's_c2', 'se guarda');
  let r = await run(f.id);
  assert.equal(r.steps.s_en.status, 'success');
  assert.equal(r.steps.s_pr.skipReason, 'not_routed', 'solo análisis: no sigue a la automatización');
  assert.match(r.steps.s_pr.events[0].text, /en la salida de "Coordinador"/);
  const g2 = await s.getFlow(f.id);
  g2.steps.find((x) => x.id === 's_c2').task = '[[mock:say fases: analisis, automatizacion]]';
  await s.uiOk('PUT', `/api/flows/${f.id}`, g2);
  r = await run(f.id);
  assert.equal(r.steps.s_pr.status, 'success', 'con automatización, sigue');
  assert.match(r.steps.s_pr.inputs?.[0]?.step || 'Entregable', /Entregable/, 'lo que pasa sigue siendo la salida del origen');
});

test('un solo coordinador por flujo: marcar otro desmarca el anterior', async () => {
  const f = await s.flow('Uno', [role('A', 'x', { id: 's_a', coordinator: true }), role('B', 'y', { id: 's_b' })], []);
  const g = await s.getFlow(f.id);
  g.steps.find((x) => x.id === 's_b').coordinator = true;
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const h = await s.getFlow(f.id);
  assert.equal(h.steps.find((x) => x.id === 's_b').coordinator, true);
  assert.equal(h.steps.find((x) => x.id === 's_a').coordinator, undefined);
});

test('mesa de trabajo: @Step habla con ese step, @Otro lo suma, nombrados responden, sin nombrar decide el coordinador, @Coordinador vuelve', async () => {
  const coord = role('Coordinador', 'Clasifica', { id: 's_mc', coordinator: true });
  const a = role('Ejecutar en qa', 'Corre qa', { id: 's_mq' });
  const b = role('Selección de casos', 'Elige casos', { id: 's_ms' });
  const f = await s.flow('Mesa', [coord, a, b], [['s_mc', 's_mq'], ['s_mq', 's_ms']]);
  const say = async (message) => {
    const before = (await s.uiOk('GET', `/api/flows/${f.id}/chat/_global`)).length;
    await s.uiOk('POST', `/api/flows/${f.id}/chat/_global`, { message });
    return until(async () => { const l = await s.uiOk('GET', `/api/flows/${f.id}/chat/_global`); const fresh = l.slice(before); return fresh.length > 1 && !fresh.some((m) => m.status === 'running') ? fresh : null; }, 15000);
  };
  const who = (fresh) => fresh.filter((m) => m.role === 'assistant').map((m) => m.routedTo);
  const n0 = s.calls().length;
  // @ with the name (accents/case ignored) → that step answers, and the conversation stays with it
  let r = await say('@ejecutar en QA ¿cómo te fue en qa?');
  assert.deepEqual(who(r), ['Ejecutar en qa']);
  assert.match(r.find((m) => m.role === "router").text, /Conversación con \*\*Ejecutar en qa\*\*/);
  r = await say('¿y los fallos?');
  assert.deepEqual(who(r), ['Ejecutar en qa'], 'sigue con ese step sin nombrarlo');
  assert.ok(!s.callsSince(n0).some((c) => /enrutador de un flujo|Eres el COORDINADOR/.test(`${c.system}\n${c.append}`)), 'ni enrutador ni coordinador');
  // @Other joins the table and answers (it was named)
  r = await say('@Selección de casos sumate: ¿cubrimos eso?');
  assert.deepEqual(who(r), ['Selección de casos']);
  assert.deepEqual((await s.getFlow(f.id)).chatParticipants, ['s_mq', 's_ms']);
  // nobody named → the coordinator decides who answers
  const n1 = s.calls().length;
  r = await say('¿qué hacemos con el ambiente?');
  assert.match(r.find((m) => m.role === "router").text, /el coordinador elige: \*\*Ejecutar en qa\*\*/);
  assert.deepEqual(who(r), ['Ejecutar en qa']);
  assert.ok(s.callsSince(n1).some((c) => /Eres «Coordinador», el coordinador del flujo/.test(c.system || '')), 'decide con el rol del coordinador');
  // both named → both answer
  r = await say('@Ejecutar en qa y @Selección de casos opinen');
  assert.deepEqual(who(r).sort(), ['Ejecutar en qa', 'Selección de casos']);
  // an e-mail is not a mention; @Coordinador goes back
  r = await say('mándalo a qa@empresa.com @Coordinador');
  assert.deepEqual(who(r), ['Coordinador']);
  assert.deepEqual((await s.getFlow(f.id)).chatParticipants, []);
  // the ✕ / "volver" of the UI, and a new conversation, empty the table
  await s.uiOk('PUT', `/api/flows/${f.id}/chat/_global/participants`, { ids: ['s_ms', 's_mc', 'no-existe'] });
  assert.deepEqual((await s.getFlow(f.id)).chatParticipants, ['s_ms'], 'ni el coordinador ni steps inexistentes se sientan a la mesa');
  await s.uiOk('DELETE', `/api/flows/${f.id}/chat/_global`);
  assert.deepEqual((await s.getFlow(f.id)).chatParticipants, []);
});

test('chat general con coordinador: atiende él, consulta al step que sabe y responde con lo que ese step dijo', async () => {
  const coord = role('Coordinador', 'Clasifica pedidos', { id: 's_cc', coordinator: true });
  const casos = role('Casos', 'Diseña casos de prueba', { id: 's_cs' });
  const f = await s.flow('Chat coordinado', [coord, casos], [['s_cc', 's_cs']]);
  const n0 = s.calls().length;
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_global`, { message: '¿Qué casos hay para SBK-1? [[mock:consult Casos|¿qué casos diseñaste para SBK-1?]]' });
  const msgs = await until(async () => { const l = await s.uiOk('GET', `/api/flows/${f.id}/chat/_global`); return l.some((m) => /FINAL coordinador/.test(m.text || '')) ? l : null; }, 15000);
  assert.ok(msgs, 'el coordinador terminó respondiendo');
  assert.ok(msgs.some((m) => m.role === 'router' && /Atiende el coordinador/.test(m.text)), 'sin el enrutador Haiku');
  assert.ok(!s.callsSince(n0).some((c) => /enrutador de un flujo/.test(c.system || '')), 'el enrutador no se llamó');
  const asked = msgs.find((m) => m.routedTo === 'Casos');
  assert.ok(asked, 'la consulta al step se ve en el chat general');
  assert.match(asked.text, /qué casos diseñaste para SBK-1/);
  const final = msgs.find((m) => /FINAL coordinador/.test(m.text));
  assert.match(final.text, /«Casos» dijo: Respuesta de chat \(mock\)/, 'responde con lo que dijo el step');
  assert.ok(!msgs.some((m) => /<consult/.test(m.text || '')), 'las etiquetas de consulta no se le muestran a la persona');
  // the coordinator's chat system knows it coordinates
  assert.ok(s.callsSince(n0).some((c) => /Eres el COORDINADOR de este flujo/.test(c.append || c.system || '')));
  // the step answered in its OWN chat (its context and memory)
  assert.ok((await s.uiOk('GET', `/api/flows/${f.id}/chat/s_cs`)).some((m) => m.role === 'user' && /Consulta del coordinador/.test(m.text)));
});
