// Spec 09 (export & import): share a flow as a .afsflow.json file. Exports never carry machine state or secrets;
// imports get a new id, are sanitized, and are QUARANTINED when they contain anything that would execute on the
// importer's machine (no runs, chats, schedules or external calls until the person confirms they reviewed it).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let a; let b; // two independent installations ("my PC" and "a colleague's PC")
before(async () => { a = await startServer({ name: 'expA' }); b = await startServer({ name: 'expB' }); await Promise.all([a.start(), b.start()]); });
after(async () => { await a?.stop(); await b?.stop(); });

const fullFlow = async (s) => {
  const f = await s.flow('Flujo para compartir', [
    role('Analizar', '[[mock:say análisis]]', { id: 's_an', contextSources: [{ id: 'c1', type: 'jira', ref: '{{vars.issue}}' }], assertions: [{ type: 'contains', value: 'análisis' }], breakpoint: 'after' }),
    cmd('Medir', 'Write-Output medido', { id: 's_me' }),
  ], [['s_an', 's_me']], {
    description: 'desc', cwd: s.dirs.work, vars: { issue: 'SBK-1', api_token: 'tok-SECRETO-123' },
    requirements: [{ id: 'r1', type: 'tool', name: 'node', check: 'node --version' }],
    finally: { command: 'Write-Output fin', shell: 'powershell', timeoutSec: 30 },
    schedule: { enabled: true, everyMinutes: 60, input: 'x' },
    contextSources: [{ id: 'cf', type: 'url', url: 'https://example.com' }],
  });
  await s.runUi(f.id, '', { stepId: 's_me' });
  await s.uiOk('POST', `/api/flows/${f.id}/memory/s_an`, { text: 'hecho aprendido' });
  await s.uiOk('POST', `/api/flows/${f.id}/steps/s_me/pin`, { output: 'dato real fijado' });
  return s.getFlow(f.id);
};

test('exportar: formato, nombre de archivo, sin estado de la máquina ni secretos; programación desactivada; opciones de memoria/chats/ejecuciones/fijadas', async () => {
  const f = await fullFlow(a);
  const res = await fetch(`${a.base}/api/flows/${f.id}/export`, { headers: { 'X-AFS-UI': a.uiKey } });
  assert.match(res.headers.get('content-disposition'), /attachment; filename="flujo-para-compartir\.afsflow\.json"/);
  const bundle = await res.json();
  assert.equal(bundle.format, 'agent-flow-studio/flow'); assert.equal(bundle.version, 1); assert.ok(bundle.app);
  const text = JSON.stringify(bundle);
  for (const secret of [a.token, a.uiKey, 'tok-SECRETO-123', 'dato real fijado']) assert.ok(!text.includes(secret), `no exporta ${secret.slice(0, 8)}…`);
  assert.equal(bundle.flow.vars.api_token, '');
  assert.equal(bundle.flow.schedule.enabled, false);
  assert.ok(bundle.flow.steps.every((s) => !s.lastRun && !s.chatSessionId && !s.pinned));
  assert.ok(bundle.removed.some((r) => /api_token/.test(r)) && bundle.removed.some((r) => /fijadas/.test(r)));
  assert.equal(bundle.flow.steps[0].memory[0].text, 'hecho aprendido');
  assert.deepEqual(bundle.flow.requirements[0].name, 'node');
  assert.equal(bundle.chats, undefined); assert.equal(bundle.runs, undefined);
  const full = await a.uiOk('GET', `/api/flows/${f.id}/export?chats=1&runs=1&memory=0&pins=1&secrets=1`);
  assert.equal(full.flow.vars.api_token, 'tok-SECRETO-123');
  assert.equal(full.flow.steps[0].memory.length, 0);
  assert.equal(full.flow.steps[1].pinned.output, 'dato real fijado');
  assert.equal(full.runs.length, 1);
});

test('ida y vuelta entre dos instalaciones: se reproduce el flujo (steps, flechas, contexto, requisitos, Al terminar), con id nuevo y en revisión', async () => {
  const f = await fullFlow(a);
  const bundle = await a.uiOk('GET', `/api/flows/${f.id}/export?chats=1&runs=1`);
  const r = await b.uiOk('POST', '/api/flows/import', { bundle });
  const g = r.flow;
  assert.notEqual(g.id, f.id);
  assert.equal(g.name, 'Flujo para compartir');
  assert.deepEqual(g.steps.map((s) => [s.id, s.name, s.kind]), f.steps.map((s) => [s.id, s.name, s.kind]));
  assert.deepEqual(g.edges.map((e) => [e.source, e.target]), [['s_an', 's_me']]);
  assert.deepEqual(g.steps[0].contextSources, f.steps[0].contextSources);
  assert.deepEqual(g.contextSources, f.contextSources);
  assert.deepEqual(g.requirements, f.requirements);
  assert.deepEqual(g.finally, f.finally);
  assert.equal(g.steps[0].breakpoint, 'after');
  assert.deepEqual(g.steps[0].assertions, f.steps[0].assertions);
  assert.equal(g.schedule.enabled, false);
  assert.ok(g.steps.every((s) => s.lastRun === null && !s.chatSessionId));
  assert.ok(r.quarantine, 'trae un comando → en revisión');
  assert.ok(r.quarantine.reasons.some((x) => /comando en "Medir"/.test(x)));
  assert.ok(r.quarantine.reasons.some((x) => /Al terminar/.test(x)));
  assert.ok(r.warnings.some((w) => /api_token/.test(w)), 'avisa que la variable secreta viene vacía');
  const runs = await b.uiOk('GET', `/api/flows/${g.id}/runs`);
  assert.equal(runs.length, 1, 'el historial vino incluido');
  assert.ok((await b.uiOk('GET', `/api/flows/${g.id}/versions`)).some((v) => v.label === 'Importado'));
  // importing again does not overwrite: new id and suffixed name
  const r2 = await b.uiOk('POST', '/api/flows/import', { bundle });
  assert.notEqual(r2.flow.id, g.id);
  assert.equal(r2.flow.name, 'Flujo para compartir (importado)');
});

test('cuarentena: no se ejecuta ni se chatea (UI, step suelto, API externa, dry run, chat); "Revisé, habilitar" lo libera', async () => {
  const f = await fullFlow(a);
  const { flow: g } = await b.uiOk('POST', '/api/flows/import', { bundle: await a.uiOk('GET', `/api/flows/${f.id}/export`) });
  const ui = await b.ui('POST', `/api/flows/${g.id}/run`, { input: '' });
  assert.equal(ui.status, 423); assert.equal(ui.body.code, 'QUARANTINED'); assert.ok(ui.body.reasons.length);
  assert.equal((await b.ui('POST', `/api/flows/${g.id}/steps/s_an/run`, { input: '' })).status, 423);
  assert.equal((await b.runExt(g.id, {})).status, 423);
  assert.equal((await b.ext('POST', `/flows/${g.id}/run`, { dryRun: true })).body.code, 'QUARANTINED');
  assert.equal((await b.ui('POST', `/api/flows/${g.id}/chat/s_an`, { message: 'hola' })).status, 423);
  assert.equal((await b.ext('POST', `/flows/${g.id}/ask`, { message: 'hola' })).status, 423);
  assert.equal((await b.uiOk('GET', `/api/flows/${g.id}/runs`)).length, 0);
  // editing is allowed and does not lift it
  const edited = await b.uiOk('PUT', `/api/flows/${g.id}`, { ...g, description: 'revisando', quarantine: null });
  assert.ok(edited.quarantine, 'un guardado no puede quitar la revisión');
  const t = await b.uiOk('POST', `/api/flows/${g.id}/trust`, {});
  assert.equal(t.quarantine, undefined);
  const run = await b.runUi(g.id, '', { stepId: 's_me' });
  assert.equal(run.status, 'success');
});

test('un flujo sin nada ejecutable (solo lee y razona) se importa sin revisión; archivos inválidos o de una versión más nueva se rechazan con un mensaje claro; se sanea', async () => {
  const f = await a.flow('Solo razona', [role('Pensar', '[[mock:say ok]]', { id: 's_p', allowedTools: 'Read Grep' })]);
  const r = await b.uiOk('POST', '/api/flows/import', { bundle: await a.uiOk('GET', `/api/flows/${f.id}/export`) });
  assert.equal(r.quarantine, null);
  assert.equal((await b.runUi(r.flow.id)).status, 'success');
  assert.equal((await b.ui('POST', '/api/flows/import', { bundle: { hola: 1 } })).body.code, 'BAD_BUNDLE');
  assert.equal((await b.ui('POST', '/api/flows/import', { bundle: { format: 'agent-flow-studio/flow', version: 99, flow: {} } })).body.code, 'BUNDLE_TOO_NEW');
  const dirty = { format: 'agent-flow-studio/flow', version: 1, flow: {
    name: 'Sucio', vars: { n: 5 }, quarantine: null, rev: 999, globalSessionId: 'x',
    steps: [{ id: 's_1', name: 'A', kind: 'role', lastRun: { status: 'success' }, chatSessionId: 'sess', contextSources: [{ type: 'raro' }, { type: 'url', url: 'https://x' }] }, { nope: true }],
    edges: [{ id: 'e', source: 's_1', target: 's_404' }, { id: 'e2', source: 's_1', target: 's_1' }],
  } };
  const d = (await b.uiOk('POST', '/api/flows/import', { bundle: dirty })).flow;
  assert.equal(d.steps.length, 1); assert.equal(d.steps[0].lastRun, null); assert.equal(d.steps[0].chatSessionId, null);
  assert.deepEqual(d.steps[0].contextSources.map((x) => x.type), ['url']);
  assert.deepEqual(d.edges, []);
  assert.equal(d.vars.n, '5');
  assert.equal(d.globalSessionId, null);
  assert.notEqual(d.rev, 999, 'la revisión no se hereda del archivo');
});

test('CLI: afs export y afs import entre dos instalaciones', async () => {
  const f = await fullFlow(a);
  const out = path.join(a.dirs.work, 'compartido.afsflow.json');
  const e = await a.afs(['export', f.name, '-o', out, '--chats']);
  assert.equal(e.code, 0, e.stderr);
  assert.match(e.stderr, /no incluido: valor de la variable "api_token"/);
  const bundle = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(bundle.format, 'agent-flow-studio/flow');
  const i = await b.afs(['import', out, '--json']);
  assert.equal(i.code, 0, i.stderr);
  const r = JSON.parse(i.stdout);
  assert.ok(r.quarantine);
  assert.match(i.stderr, /En revisión/);
  assert.equal((await b.getFlow(r.id)).name.startsWith('Flujo para compartir'), true);
  assert.equal((await b.afs(['import', path.join(a.dirs.work, 'no-existe.json')])).code, 2);
});

// ---------------- browser ----------------
let ui = {};
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
afterEach(async (t) => { await captureOnFailure(ui.page, t); });
after(async () => { await ui.close?.(); });

test('UI: exportar descarga el archivo; importarlo abre el flujo con el aviso de revisión; "Revisé, habilitar" permite ejecutar', async (t) => {
  ui = await openUi('expui');
  if (guard(t)) return;
  const { s: u, page } = ui;
  const f = await u.flow('Para exportar', [cmd('Eco', 'Write-Output hola', { id: 's_eco', position: { x: 120, y: 120 } })], [], { vars: { password: 'x' } });
  await page.goto(`${u.base}/?flow=${f.id}`);
  await page.getByRole('button', { name: '⬇ Exportar' }).click();
  await page.getByText('Exportar “Para exportar”').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Descargar' }).click()]);
  assert.equal(download.suggestedFilename(), 'para-exportar.afsflow.json');
  const file = path.join(u.dirs.work, download.suggestedFilename());
  await download.saveAs(file);
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(bundle.flow.vars.password, '');
  // import it back (as a colleague would)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '⬆ Importar' }).click()]);
  await chooser.setFiles(file);
  await page.locator('[data-testid="quarantine"]').waitFor();
  assert.match(await page.locator('header select').evaluate((el) => el.options[el.selectedIndex].text), /Para exportar \(importado\)/);
  assert.equal(await page.getByRole('button', { name: '▶ Ejecutar flujo' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Ver qué' }).click();
  await page.getByText(/comando en "Eco"/).waitFor();
  ui.answers.push(true);
  await page.getByRole('button', { name: 'Revisé este flujo, habilitar' }).click();
  await page.locator('[data-testid="quarantine"]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.locator('.node.st-success', { hasText: 'Eco' }).waitFor();
  assert.deepEqual(page.errors, []);
});
