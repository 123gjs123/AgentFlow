// Spec 28 in the real UI: the 🔔 item takes you to the flow's 🩺 Revisión tab; findings are applied one by one, a fix
// that widens access asks for its own confirmation, a dismissed finding goes to "Descartados", rules are added.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { role } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let ui = {}; let s; let page;
before(async () => { process.env.AFS_PROBE_HEADLESS = 'off'; ui = await openUi('ui-review'); ({ s, page } = ui); });
after(async () => { await ui.close?.(); });
afterEach(async (t) => { await captureOnFailure(page, t); });
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };

test('🔔 lleva a 🩺 Revisión; aplicar un arreglo, confirmar el que amplía acceso, descartar y agregar una regla', async (t) => {
  if (guard(t)) return;
  const f = await s.flow('Flujo a revisar', [
    { id: 's_rota', name: 'Skill rota', kind: 'skill', skillRef: 'no-existe', task: 't', position: { x: 80, y: 80 } },
    role('Automatiza', 'Ejecuta la suite de regresión', { id: 's_auto', allowedTools: 'Read Bash(npm test:*)', position: { x: 380, y: 80 } }),
    role('Deniega', '[[mock:deny-cmd ls reports]] [[mock:say hecho]]', { id: 's_den', allowedTools: 'Read', position: { x: 680, y: 80 } }),
  ], [], { cwd: s.dirs.work });
  await s.runUi(f.id);
  await page.goto(`${s.base}/?flow=${f.id}&open=flowreview`);
  const panel = page.getByTestId('review-panel');
  await panel.waitFor();
  const findings = panel.getByTestId('lint-findings');
  await findings.getByText('La skill «no-existe» no existe en esta máquina').waitFor();
  // a plain fix applies directly
  const long = findings.locator('[data-rule="R-LONG-BASH"]');
  await long.getByRole('button', { name: 'Aplicar' }).click();
  await long.waitFor({ state: 'detached' });
  assert.equal((await s.getFlow(f.id)).steps.find((x) => x.id === 's_auto').bashTimeoutMin, 60);
  // a fix that widens access: the browser asks first (cancel = nothing changes)
  const deny = findings.locator('[data-rule="R-DENY"]');
  await deny.getByTestId('widens').waitFor();
  ui.answers.push(false); // cancel the confirmation
  await deny.getByRole('button', { name: 'Aplicar (amplía acceso)' }).click();
  await page.waitForTimeout(400);
  assert.equal((await s.getFlow(f.id)).steps.find((x) => x.id === 's_den').allowedTools, 'Read', 'cancelar no cambia nada');
  ui.answers.push(true);
  await deny.getByRole('button', { name: 'Aplicar (amplía acceso)' }).click();
  await deny.waitFor({ state: 'detached' });
  assert.match((await s.getFlow(f.id)).steps.find((x) => x.id === 's_den').allowedTools, /Bash\(ls:\*\)/);
  // dismiss with a reason
  const ref = findings.locator('[data-rule="R-REF"]');
  await ref.getByRole('button', { name: 'Descartar' }).click();
  await ref.locator('select').selectOption('lo hago después');
  await ref.waitFor({ state: 'detached' });
  await findings.getByText('Descartados (1)').waitFor();
  // a rule for this flow
  const pol = panel.getByTestId('flow-policies');
  await pol.locator('select').first().selectOption('defaultEnv');
  await pol.getByPlaceholder('variable (p. ej. env)').fill('env');
  await pol.getByPlaceholder('valor (p. ej. qa)').fill('qa');
  await pol.getByRole('button', { name: 'Agregar regla' }).click();
  await pol.getByText('✓ Garantiza:').first().waitFor();
  await page.waitForTimeout(1500); // debounced save
  const g = await s.getFlow(f.id);
  assert.equal(g.policies[0].type, 'defaultEnv');
  assert.deepEqual(g.policies[0].params, { var: 'env', value: 'qa' });
  assert.deepEqual(page.errors, []);
});

test('⚙ Configuración › Reglas: una regla para todos los flujos', async (t) => {
  if (guard(t)) return;
  await page.goto(`${s.base}/`);
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('settings-tab-policies').click();
  const box = page.getByTestId('machine-policies');
  await box.locator('select').first().selectOption('note');
  await box.getByPlaceholder('La regla o lección, en una frase').fill('Claude Code corta Bash a los 10 min');
  await box.getByRole('button', { name: 'Agregar regla' }).click();
  await box.getByText('Guardado: se aplica a todos los flujos').waitFor();
  assert.ok((await s.uiOk('GET', '/api/policies')).machine.some((p) => p.text === 'Claude Code corta Bash a los 10 min'));
  await s.uiOk('PUT', '/api/policies', { policies: [] });
  assert.deepEqual(page.errors, []);
});
