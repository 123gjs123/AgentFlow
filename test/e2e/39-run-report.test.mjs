// 📋 The run report: why a run ended the way it did (the step that cut it, its error and last output), each step with
// its reason (ok, error, "no corrió porque falló un paso anterior"…), warnings, «Al terminar», as Markdown (API, .md
// download) and in the UI (Flujo › Ejecuciones › 📋 Informe).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cmd, role } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'run-report' }); await s.start(); });
after(async () => { await s?.stop(); });

test('informe de una ejecución que falló: dónde se cortó, por qué, qué no corrió; descarga .md; sin secretos', async () => {
  await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'clave', fields: { value: 'VALOR-SECRETO-123' } });
  const f = await s.flow('Con falla', [
    role('Analiza', '[[mock:say análisis listo]]', { id: 's_a' }),
    cmd('Busca tests', 'Write-Output "buscando con {{cred.clave.value}}"; Write-Output "## SBK-1 - algo"; throw "el índice de la matriz está elevado a NULL"', { id: 's_b' }),
    role('Casos', '[[mock:say casos]]', { id: 's_c' }),
    role('Cierre', '[[mock:say cierre]]', { id: 's_d' }),
  ], [['s_a', 's_b'], ['s_b', 's_c'], ['s_c', 's_d']], { finally: { command: 'Write-Output "pendientes: 0"', shell: 'powershell' } });
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'error');
  const r = await s.uiOk('GET', `/api/flows/${f.id}/runs/${run.id}/report`);
  assert.match(r.ticket, /^A\d{3}$/);
  const md = r.markdown;
  assert.match(md, /Resultado:\*\* ❌ con error/);
  assert.match(md, /Se cortó en «Busca tests»\*\* — el comando terminó con error/);
  assert.match(md, /elevado a NULL/);
  assert.match(md, /SBK-1 - algo/, 'lo último que mostró');
  assert.match(md, /\*\*2 paso\(s\)\*\* no corrieron/);
  assert.match(md, /\| Casos \| ⏭ no corrió \|[^\n]*no corrió porque falló un paso anterior/);
  assert.match(md, /## Al terminar[\s\S]*pendientes: 0/);
  assert.ok(md.indexOf('Analiza') < md.indexOf('| 2 | Busca tests'), 'en el orden en que corrieron');
  assert.ok(!md.includes('VALOR-SECRETO-123'), 'los secretos nunca aparecen');
  const dl = await fetch(`${s.base}/api/flows/${f.id}/runs/${run.id}/report?format=md`, { headers: { 'X-AFS-UI': s.uiKey } });
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition') || '', /informe-con-falla-r_/); assert.match(await dl.text(), /# Informe de ejecución/);
  assert.ok([401, 404].includes((await s.ext('GET', `/flows/${f.id}/runs/${run.id}/report`)).status), 'solo desde la interfaz');
  const ok = await s.flow('Sin falla', [role('Uno', '[[mock:say listo]]', { id: 's_1' })]);
  const r2 = await s.runUi(ok.id);
  assert.match((await s.uiOk('GET', `/api/flows/${ok.id}/runs/${r2.id}/report`)).markdown, /Todos los pasos que tocaban terminaron bien/);
});

test('UI: Flujo › Ejecuciones › una ejecución › 📋 Informe muestra el informe', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('run-report-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Informe UI', [cmd('Falla', 'exit 3', { id: 's_x' })]);
    const run = await u.runUi(f.id);
    await page.goto(`${u.base}/?flow=${f.id}`);
    await page.getByTestId('flow-tab-runs').click();
    await page.getByTestId('run-row-report').first().click(); // straight from the list
    await page.getByTestId('run-report').getByText(/Se cortó en «Falla»/).waitFor();
    await page.keyboard.press('Escape'); if (await page.locator('.modal-back').count()) await page.locator('.modal-back').first().click({ position: { x: 5, y: 5 } });
    await page.getByTestId('run-report-btn').click(); // and from the run's detail
    await page.getByTestId('run-report').getByText(/Se cortó en «Falla»/).waitFor();
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});
