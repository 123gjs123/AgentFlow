// ▶▶ Desde aquí: after a step fails (a missing permission, a bug), fix it and re-run from that step. The steps before
// it are not repeated (they pass their last output) and, with no input typed, the run reuses the input of the last whole
// run (the ticket it was working on).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cmd, role } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'run-from' }); await s.start(); });
after(async () => { await s?.stop(); });

const steps = () => [
  role('Prepara', '[[mock:say preparado]]', { id: 's_a' }),
  cmd('Selecciona', 'if ("{{vars.fail}}" -eq "1") { Write-Output "sin permiso"; exit 2 }; Write-Output "selección para {{input}}"', { id: 's_b' }),
  role('Cierra', '[[mock:say cerrado]]', { id: 's_c' }),
];

test('desde el paso que falló: los anteriores no se repiten y se reusa la entrada de la última ejecución', async () => {
  const f = await s.flow('Reintento', steps(), [['s_a', 's_b'], ['s_b', 's_c']], { vars: { fail: '1' } });
  const first = await s.runUi(f.id, 'SBK-10560');
  assert.equal(first.status, 'error');
  assert.equal(first.steps.s_c.status, 'skipped');
  const cur = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...cur, vars: { fail: '0' }, baseRev: cur.rev || 0 }); // "le di el permiso"
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { from: 's_b', breakpoints: false });
  const r = await s.waitRun(f.id, runId);
  assert.equal(r.status, 'success', JSON.stringify(r.error || ''));
  assert.equal(r.input, 'SBK-10560', 'sin input, la del último run completo');
  assert.match(r.steps.s_b.output, /selección para SBK-10560/);
  assert.equal(r.steps.s_c.status, 'success');
  assert.ok(!r.steps.s_a?.startedAt, 'Prepara no se repite');
  // a typed input wins
  const { runId: r2 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { from: 's_b', input: 'SBK-2', breakpoints: false });
  assert.match((await s.waitRun(f.id, r2)).steps.s_b.output, /selección para SBK-2/);
  // the partial runs (from / only) do not count as "the last whole run"
  const { runId: r3 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { from: 's_b', breakpoints: false });
  assert.equal((await s.waitRun(f.id, r3)).input, 'SBK-10560', 'las ejecuciones parciales no cuentan como la última completa');
});

test('UI: el step tiene ▶▶ Desde aquí (solo si tiene pasos después) y arranca la ejecución desde él', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('run-from-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Desde aquí UI', steps(), [['s_a', 's_b'], ['s_b', 's_c']], { vars: { fail: '0' } });
    await u.runUi(f.id, 'SBK-7');
    await page.goto(`${u.base}/?flow=${f.id}`);
    const node = (name) => page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: new RegExp(`^${name}$`) }) });
    await node('Cierra').click();
    await page.locator('.panel-head .title-input').waitFor();
    assert.equal(await page.getByTestId('run-from-step').count(), 0, 'el último paso no lo tiene');
    await node('Selecciona').click();
    await page.getByTestId('run-from-step').click();
    const deadline = Date.now() + 30000;
    let runs = [];
    while (Date.now() < deadline) { runs = await u.uiOk('GET', `/api/flows/${f.id}/runs`); if (runs.some((x) => x.from === 's_b' && x.status === 'success')) break; await new Promise((r) => setTimeout(r, 300)); }
    const fr = runs.find((x) => x.from === 's_b');
    assert.ok(fr && fr.status === 'success', JSON.stringify(runs));
    assert.equal(fr.input, 'SBK-7');
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});
