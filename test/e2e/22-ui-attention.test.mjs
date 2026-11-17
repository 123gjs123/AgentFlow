// Spec 27 in the real UI: a break in ANOTHER flow is visible (toast "Abrir", 🔔 count, tab title, prefix in the flow
// list) and "Abrir" takes you to the review — without resuming anything (D48). ⚙ Configuración renders its tabs.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { role, cmd, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let ui = {}; let s; let page;
before(async () => { ui = await openUi('ui-attention'); ({ s, page } = ui); });
after(async () => { await ui.close?.(); });
afterEach(async (t) => { await captureOnFailure(page, t); });
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };

test('un break en otro flujo: toast "Abrir", 🔔 con contador, título "(1)" y prefijo ⏸; "Abrir" lleva a la revisión sin reanudar nada', async (t) => {
  if (guard(t)) return;
  const a = await s.flow('Flujo A con break', [role('Paso A', '[[mock:say salida A]]', { id: 's_a', breakpoint: 'after', position: { x: 100, y: 100 } })]);
  const b = await s.flow('Flujo B abierto', [cmd('Paso B', 'Write-Output b', { position: { x: 100, y: 100 } })]);
  await page.goto(`${s.base}/?flow=${b.id}`);
  await page.locator('.react-flow__node', { hasText: 'Paso B' }).waitFor();
  const { runId } = await s.uiOk('POST', `/api/flows/${a.id}/run`, { input: '' });
  const toast = page.getByTestId('attention-toast').filter({ hasText: 'Break esperando revisión' });
  await toast.waitFor();
  await toast.getByText('Flujo A con break · Paso A').waitFor();
  await page.getByTestId('attention-count').getByText('1').waitFor();
  assert.match(await page.title(), /^\(1\) Flujo B abierto · Agent Flow Studio$/);
  assert.equal(await page.locator('header select option', { hasText: 'Flujo A con break' }).textContent(), '⏸ Flujo A con break');
  // the drawer lists it (Ctrl+Shift+A) and closes with Esc
  await page.keyboard.press('Control+Shift+A');
  await page.getByTestId('attention-drawer').getByText('Break esperando revisión').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('attention-drawer').waitFor({ state: 'detached' });
  await toast.getByRole('button', { name: 'Abrir' }).click();
  await page.waitForURL(new RegExp(`\\?flow=${a.id}`));
  await page.getByText('Break: validar antes de seguir').waitFor();
  await sleep(400);
  assert.equal((await s.uiOk('GET', `/api/flows/${a.id}/runs/${runId}`)).status, 'paused', 'abrir no reanuda');
  await page.getByRole('button', { name: '✔ Aprobar y seguir' }).click();
  await s.waitRun(a.id, runId);
  await page.getByTestId('attention-count').waitFor({ state: 'detached' });
  assert.match(await page.title(), /^Flujo A con break · Agent Flow Studio$/);
  assert.deepEqual(page.errors, []);
});

test('un fallo en otro flujo: en la bandeja "Marcar visto" lo saca del contador; "Ver ejecución" abre esa ejecución', async (t) => {
  if (guard(t)) return;
  const f = await s.flow('Flujo que falla', [cmd('Rompe', 'exit 4', { id: 's_r', position: { x: 100, y: 100 } })]);
  const r = await s.runUi(f.id);
  await page.getByTestId('attention-btn').click();
  const item = page.getByTestId('attention-drawer').getByTestId('att-run_failed').filter({ hasText: 'Flujo que falla' });
  await item.waitFor();
  await item.getByRole('button', { name: 'Marcar visto' }).click();
  await page.getByTestId('attention-drawer').getByText(/Vistos \(1\)/).waitFor();
  await page.getByTestId('attention-drawer').getByText(/Vistos \(1\)/).click();
  await page.getByTestId('attention-drawer').getByRole('button', { name: 'Ver ejecución' }).click();
  await page.waitForURL(new RegExp(`\\?flow=${f.id}`));
  await page.getByText(new RegExp(`${r.id} ·`)).waitFor();
  assert.deepEqual(page.errors, []);
});

test('⚙ Configuración: pestañas Credenciales, Integraciones, Claude Code CLI (chequeo), Notificaciones y "De dónde salen los números"', async (t) => {
  if (guard(t)) return;
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('credentials-panel').waitFor();
  await page.getByTestId('settings-tab-integrations').click();
  await page.getByText('Snippets rápidos y token').waitFor();
  await page.getByTestId('settings-tab-cli').click();
  await page.getByTestId('check-cli').getByText(/Claude Code CLI instalado/).waitFor();
  await page.getByTestId('check-data').waitFor();
  await page.getByTestId('settings-tab-notifications').click();
  await page.getByTestId('notify-os').waitFor();
  await page.getByTestId('settings-tab-numbers').click();
  await page.getByTestId('numbers-table').getByText('No es un cobro', { exact: false }).waitFor();
  // credentials help points here: the old event opens the Credenciales tab
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('afs:open-credentials', { detail: { name: 'jira' } })));
  await page.getByTestId('cred-form').waitFor();
  assert.equal(await page.getByTestId('cred-name').inputValue(), 'jira', 'precargada con el nombre');
  assert.deepEqual(page.errors, []);
});
