// Spec 15 DATA-10: "para cada". A step runs once per element of a JSON list that comes from upstream (e.g. the
// tickets the coordinator picked), with limited parallelism; the results are collected into a list for what follows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'foreach' }); await s.start(); });
after(async () => { await s?.stop(); });
const run = async (id) => { const { runId } = await s.uiOk('POST', `/api/flows/${id}/run`, { input: '', breakpoints: false }); return s.waitRun(id, runId); };

test('un step de IA corre una vez por ticket ({{item.key}}), de a 2, y lo siguiente recibe la lista de resultados', async () => {
  const coord = role('Coordinador', '[[mock:json {"automatizacion":[{"key":"SBK-1"},{"key":"SBK-2"},{"key":"SBK-3"}]}]]', { id: 's_fc', output: { format: 'json' } });
  const auto = role('Automatizar', 'Automatiza {{item.key}} ({{item.index}}/{{item.total}}) [[mock:echo]]', { id: 's_fa', forEach: { path: 'automatizacion', parallel: 2 } });
  const cierre = role('Cierre', '[[mock:echo]]', { id: 's_fz' });
  const f = await s.flow('Para cada', [coord, auto, cierre], [['s_fc', 's_fa'], ['s_fa', 's_fz']]);
  assert.deepEqual((await s.getFlow(f.id)).steps.find((x) => x.id === 's_fa').forEach, { path: 'automatizacion', parallel: 2, max: 20 }, 'se guarda saneado');
  const n0 = s.calls().length;
  const r = await run(f.id);
  assert.equal(r.status, 'success', JSON.stringify(r.steps.s_fa?.error));
  const st = r.steps.s_fa;
  assert.equal(st.forEach.total, 3);
  assert.equal(st.forEach.parallel, 2);
  assert.deepEqual(st.forEach.items.map((x) => x.label), ['SBK-1', 'SBK-2', 'SBK-3']);
  assert.deepEqual(st.json.map((x) => x.item.key), ['SBK-1', 'SBK-2', 'SBK-3']);
  assert.ok(st.json.every((x) => x.status === 'success'));
  for (const k of ['SBK-1', 'SBK-2', 'SBK-3']) {
    const i = Number(k.slice(-1));
    const c = s.callsSince(n0).filter((x) => x.prompt.includes(`Automatiza ${k} (${i}/3)`) && !x.prompt.includes("— success"));
    assert.equal(c.length, 1, `una llamada para ${k}`);
    assert.match(c[0].prompt, new RegExp(`Elemento ${i} de 3`), 'el elemento llega también como entrada');
    assert.ok(!c[0].prompt.includes(`Automatiza SBK-${i === 1 ? 2 : 1}`), 'cada llamada ve solo su elemento');
    assert.equal(r.steps[`s_fa~${i}`].status, 'success', 'cada elemento tiene su registro');
  }
  assert.match(st.output, /## SBK-1 — success[\s\S]*## SBK-3 — success/);
  assert.equal(r.steps.s_fz.status, 'success');
  assert.ok(st.events.some((e) => /Para cada elemento de "Coordinador": 3/.test(e.text)));
  const last = (await s.getFlow(f.id)).steps.find((x) => x.id === 's_fa').lastRun;
  assert.equal(last.status, 'success');
  assert.equal(last.json.length, 3, 'lo que pasa a los siguientes es la lista de resultados');
});

test('step de comando: el elemento llega como $env:AFS_ITEM y {{item}}; si uno falla, los demás igual corren y el step queda en error', async () => {
  const list = cmd('Lista', `Write-Output '["A","B","C"]'`, { id: 's_l', output: { format: 'json' } });
  const each = cmd('Cada', `if ($env:AFS_ITEM -eq 'B') { Write-Output 'falla B'; exit 1 }; Write-Output "hecho $env:AFS_ITEM {{item}} $env:AFS_ITEM_INDEX/$env:AFS_ITEM_TOTAL"`, { id: 's_e', forEach: { path: '' } });
  const f = await s.flow('Para cada cmd', [list, each], [['s_l', 's_e']]);
  const r = await run(f.id);
  const st = r.steps.s_e;
  assert.equal(st.status, 'error');
  assert.equal(st.code, 'FOR_EACH_FAILED');
  assert.match(st.error, /Fallaron 1 de 3: B/);
  assert.deepEqual(st.json.map((x) => x.status), ['success', 'error', 'success'], 'C corrió aunque B falló');
  assert.match(r.steps['s_e~1'].output, /hecho A A 1\/3/);
  assert.match(r.steps['s_e~3'].output, /hecho C C 3\/3/);
});

test('lista vacía: el step se omite sin error y lo que sigue no corre; un origen que no es lista es un error claro', async () => {
  const coord = role('Coordinador', '[[mock:json {"automatizacion":[],"analisis":"no es lista"}]]', { id: 's_vc', output: { format: 'json' } });
  const auto = role('Automatizar', '[[mock:say x]]', { id: 's_va', forEach: { path: 'automatizacion' } });
  const after1 = role('Después', '[[mock:say y]]', { id: 's_vd' });
  const bad = role('Mal', '[[mock:say z]]', { id: 's_vb', forEach: { path: 'analisis', from: 'Coordinador' } });
  const f = await s.flow('Vacía', [coord, auto, after1, bad], [['s_vc', 's_va'], ['s_va', 's_vd'], ['s_vc', 's_vb']]);
  const r = await run(f.id);
  assert.equal(r.steps.s_va.status, 'skipped');
  assert.equal(r.steps.s_va.skipReason, 'empty');
  assert.equal(r.steps.s_vd.skipReason, 'not_routed');
  assert.equal(r.steps.s_vb.status, 'error');
  assert.equal(r.steps.s_vb.code, 'FOR_EACH_SOURCE');
  assert.match(r.steps.s_vb.error, /"analisis" en la salida de "Coordinador" no es una lista/);
});

test('UI: 🔁 Para cada se activa en el panel del step, se guarda saneado y el nodo lo muestra', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('foreach-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Para cada UI', [
      role('Coordinador', 'x', { id: 's_uc', position: { x: 80, y: 120 } }),
      role('Automatizar', 'Automatiza {{item.key}}', { id: 's_ua', position: { x: 380, y: 120 } }),
    ], [['s_uc', 's_ua']]);
    await page.goto(`${u.base}/?flow=${f.id}`);
    const nodeLoc = page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Automatizar' }) });
    await nodeLoc.click();
    const box = page.getByTestId('foreach-box');
    await box.getByTestId('foreach-toggle').check();
    await box.getByTestId('foreach-path').fill('automatizacion');
    await box.getByTestId('foreach-from').selectOption('s_uc');
    await nodeLoc.getByText('🔁').waitFor();
    let g;
    for (let i = 0; i < 40; i++) { g = (await u.getFlow(f.id)).steps.find((x) => x.id === 's_ua'); if (g.forEach?.from === 's_uc' && g.forEach.path === 'automatizacion') break; await new Promise((r) => setTimeout(r, 150)); }
    assert.deepEqual(g.forEach, { path: 'automatizacion', from: 's_uc', parallel: 1, max: 20 });
    await box.getByTestId('foreach-toggle').uncheck();
    for (let i = 0; i < 40; i++) { g = (await u.getFlow(f.id)).steps.find((x) => x.id === 's_ua'); if (!g.forEach) break; await new Promise((r) => setTimeout(r, 150)); }
    assert.equal(g.forEach, undefined, 'desmarcar lo quita');
  } finally { await ui.close?.(); }
});

test('revisión: el costo de "para cada" no se cuenta dos veces; el resumen externo anida los elementos', async () => {
  const coord = role('Coordinador', '[[mock:json {"t":[{"key":"A"},{"key":"B"}]}]]', { id: 's_tc', output: { format: 'json' } });
  const each = role('Cada', 'Hace {{item.key}} [[mock:say ok]]', { id: 's_te', forEach: { path: 't' } });
  const f = await s.flow('Costos', [coord, each], [['s_tc', 's_te']]);
  const r = await run(f.id);
  const per = (id) => r.steps[id].usage?.costUsd || 0;
  const expected = Math.round((per('s_tc') + per('s_te~1') + per('s_te~2')) * 1e6) / 1e6;
  assert.equal(r.totals.costUsd, expected, `${r.totals.costUsd} vs ${expected}`);
  const sum = await s.ext('GET', `/flows/${f.id}/runs/${r.id}`);
  assert.ok(!sum.body.steps.some((x) => /~/.test(x.stepId)), 'ningún "s_te~1" como step suelto');
  assert.deepEqual(sum.body.steps.find((x) => x.stepId === 's_te').forEach.items.map((x) => [x.label, x.status]), [['A', 'success'], ['B', 'success']]);
});

test('revisión: "ejecutar desde" se niega si un step anterior que necesita no tiene una salida buena', async () => {
  const a = cmd('Antes', 'exit 3', { id: 's_fa1' });
  const b = role('Desde', '[[mock:say ok]]', { id: 's_fb1' });
  const f = await s.flow('Desde roto', [a, b], [['s_fa1', 's_fb1']]);
  await run(f.id); // Antes fails
  const r = await s.ui('POST', `/api/flows/${f.id}/run`, { from: 's_fb1', breakpoints: false });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'FROM_UPSTREAM_MISSING');
  assert.match(r.body.error, /«Antes» no tiene una última salida buena/);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/run`, { from: 'nada', breakpoints: false })).status, 404);
});
