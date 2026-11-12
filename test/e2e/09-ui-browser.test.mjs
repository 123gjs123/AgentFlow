// The real UI in a real browser (Chromium via playwright-core, headless), served from the SOURCE (Vite dev mode) so
// it tests the current client code. Covers: welcome → create flows (empty, demo, with AI), open a flow from the
// selector, run it from the toolbar and see the nodes turn green, step panel tabs (Context box, Activity, Data),
// general chat, the integration wizard (generate Jenkins, dry run) and the offline banner + reconnection.
// playwright-core is optional: it is loaded from this project or from AFS_PLAYWRIGHT (path to a playwright-core
// folder). Browsers must be installed (npx playwright install chromium). Without them the suite is skipped.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startServer, role, cmd, sleep, ROOT } from './helpers/harness.mjs';
import * as sim from './helpers/callers.mjs';

async function loadPlaywright() {
  const candidates = [process.env.AFS_PLAYWRIGHT, path.join(ROOT, 'node_modules', 'playwright-core')].filter(Boolean);
  for (const c of candidates) {
    try { const req = createRequire(pathToFileURL(path.join(c, 'package.json'))); const m = await import(pathToFileURL(req.resolve(c)).href); return m.chromium ? m : m.default; } catch {}
  }
  try { const m = await import('playwright-core'); return m.chromium ? m : m.default; } catch { return null; }
}

let s; let browser; let page; let skipReason = null;
before(async () => {
  const pw = await loadPlaywright();
  if (!pw) { skipReason = 'playwright-core no disponible (npm i -D playwright-core, o AFS_PLAYWRIGHT=<carpeta playwright-core>)'; return; }
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { skipReason = `Chromium no instalado: ${e.message.split('\n')[0]}`; return; }
  s = await startServer({ name: 'ui', env: { NODE_ENV: 'development' } });
  await s.start();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'afs_ui', value: s.uiKey, url: s.base }]); // UI access key
  await ctx.addInitScript(() => { try { localStorage.setItem('afs.tourDone', '1'); } catch {} });
  page = await ctx.newPage();
  page.setDefaultTimeout(60000); // generous: the suites run in parallel and Vite compiles on first load
  page.on('pageerror', (e) => { (page.errors ||= []).push(e.message); });
});
after(async () => { await browser?.close(); await s?.stop(); });
const guard = (t) => { if (skipReason) { t.skip(skipReason); return true; } return false; };
// On failure: screenshot + visible text into test-results/ (also uploaded by CI as artifacts).
afterEach(async (t) => {
  if (!page || t.passed !== false) return;
  const dir = path.join(ROOT, 'test-results'); fs.mkdirSync(dir, { recursive: true });
  const name = t.name.replace(/[^\w]+/g, '_').slice(0, 60);
  try { await page.screenshot({ path: path.join(dir, `ui-${name}.png`), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(dir, `ui-${name}.txt`), await page.locator('body').innerText()); } catch {}
});
const flows = () => s.uiOk('GET', '/api/flows');

test('bienvenida → crear flujo vacío (pide nombre), demo, y eliminar (pide confirmación)', async (t) => {
  if (guard(t)) return;
  const answers = [];
  page.on('dialog', (d) => { const a = answers.shift(); if (a === false) d.dismiss(); else if (d.type() === 'prompt') d.accept(a ?? d.defaultValue()); else d.accept(); });
  await page.goto(s.base + '/');
  await page.getByText('Crea tu primer flujo').waitFor({ timeout: 60000 });
  answers.push(false); // cancel the name prompt → nothing is created
  await page.getByRole('button', { name: '+ Flujo vacío' }).click();
  await sleep(500);
  assert.equal((await flows()).length, 0);
  answers.push('Mi flujo e2e');
  await page.getByRole('button', { name: '+ Flujo vacío' }).click();
  await page.getByText('Agrega steps desde la barra superior').waitFor();
  assert.equal(await page.locator('header select').evaluate((el) => el.options[el.selectedIndex].text), 'Mi flujo e2e');
  answers.push(undefined); // accept the default demo name
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await page.locator('.node-name', { hasText: 'Analizar requerimiento' }).waitFor();
  assert.equal(await page.locator('.react-flow__node').count(), 3);
  assert.equal((await flows()).length, 2);
  answers.push(true); // confirm delete
  await page.getByTitle('Eliminar flujo').click();
  for (let i = 0; i < 30 && (await flows()).length !== 1; i++) await sleep(100);
  assert.deepEqual((await flows()).map((f) => f.name), ['Mi flujo e2e']);
});

test('crear flujo con IA (modal) → se abre el flujo generado', async (t) => {
  if (guard(t)) return;
  await page.getByRole('button', { name: '✨ Con IA' }).click();
  await page.getByPlaceholder('Quiero un flujo que…').fill('Analizar un ticket de Jira y diseñar los casos de prueba');
  await page.getByRole('button', { name: 'Crear flujo' }).click();
  await page.locator('.node-name', { hasText: 'Comprobar' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('header select').evaluate((el) => el.options[el.selectedIndex].text), 'Flujo generado (mock)');
});

test('abrir un flujo desde el selector, ejecutarlo desde la barra y ver los steps en verde + Actividad/Datos/Contexto', async (t) => {
  if (guard(t)) return;
  const a = cmd('Preparar', 'Write-Output "preparado {{input}}"', { id: 's_ui_a' });
  const b = role('Analizar UI', 'Analiza [[mock:json {"riesgo":"alto"}]]', { id: 's_ui_b', output: { format: 'json' } });
  const f = await s.flow('Flujo UI', [a, b], [['s_ui_a', 's_ui_b']]);
  await page.reload();
  await page.locator('header select').selectOption(f.id);
  await page.locator('.node-name', { hasText: 'Analizar UI' }).waitFor();
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByPlaceholder('Input del flujo (requerimiento, ticket, URL, JSON…)').fill('SBK-500');
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.locator('.node.st-success', { hasText: 'Analizar UI' }).waitFor({ timeout: 30000 });
  await page.locator('.node.st-success', { hasText: 'Preparar' }).waitFor();
  const runs = await s.uiOk('GET', `/api/flows/${f.id}/runs`);
  assert.equal(runs[0].status, 'success');
  // step panel
  await page.locator('.node-name', { hasText: 'Analizar UI' }).click();
  await page.getByText('👁 Lo que recibe el modelo').first().waitFor();
  await page.locator('[data-testid="step-context"]').waitFor();
  await page.locator('.tabs button', { hasText: 'Actividad' }).click();
  await page.locator(':is(pre, div, span):visible', { hasText: 'riesgo' }).first().waitFor();
  await page.locator('.tabs button', { hasText: 'Datos' }).click();
  await page.locator('pre:visible', { hasText: '"riesgo": "alto"' }).waitFor();
  await page.getByText('Verificación').waitFor();
});

test('chat general desde el panel del flujo', async (t) => {
  if (guard(t)) return;
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.locator('.tabs button', { hasText: 'Chat general' }).click();
  await page.getByPlaceholder('Escribe… (Enter envía · Alt+Enter nueva línea)').fill('¿qué hace este flujo?');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await page.getByText(/Respuesta de chat \(mock\)/).first().waitFor({ timeout: 30000 });
});

test('asistente de integración: Jenkins → Generar → Probar (sin ejecutar) → indicador de llamada recibida', async (t) => {
  if (guard(t)) return;
  await page.locator('.tabs button', { hasText: 'Invocar' }).click();
  await page.locator('.caller', { hasText: 'Jenkins (pipeline declarativo)' }).click();
  await page.getByRole('button', { name: 'Generar (plantilla)' }).click();
  await page.locator('.wz-file pre', { hasText: 'pipeline {' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Probar (sin ejecutar)' }).click();
  await page.locator('.inbound.ok', { hasText: 'Última llamada recibida desde "jenkins-declarative"' }).waitFor();
  assert.match(await page.locator('.inbound').innerText(), /prueba/);
});

test('asistente de integración: una llamada real de Jira Cloud (simulada, vía túnel) enciende "llamada recibida"', async (t) => {
  if (guard(t)) return;
  await page.locator('.caller', { hasText: 'Jira Cloud' }).click();
  await page.getByRole('button', { name: 'Generar (plantilla)' }).click();
  await page.locator('.wz-file pre', { hasText: '"source": "jira-cloud"' }).waitFor();
  await page.getByText('Esperando la primera llamada real').waitFor();
  const flowId = await page.locator('header select').inputValue();
  const g = await s.uiOk('POST', '/api/integrations/generate', { flow: flowId, caller: 'jira-cloud', options: {} });
  const r = await sim.jira(g, { token: s.token, issue: { key: 'UI-1', id: '1', summary: 'desde la UI', updated: '20260101000000' }, base: s.base });
  assert.equal(r.code, 200);
  await page.locator('.inbound.ok', { hasText: 'Última llamada recibida desde "jira-cloud"' }).waitFor();
  assert.match(await page.locator('.inbound').innerText(), /vía proxy\/túnel \(18\.1\.2\.3\)/);
});

test('servidor caído → aviso "no responde"; vuelve → se reconecta solo', async (t) => {
  if (guard(t)) return;
  await s.kill();
  await page.locator('.offline-bar').waitFor({ timeout: 30000 });
  await s.start();
  await page.locator('.offline-bar').waitFor({ state: 'detached', timeout: 60000 });
  assert.deepEqual(page.errors || [], [], 'sin errores de JavaScript en la página');
});
