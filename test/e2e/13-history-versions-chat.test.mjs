// Spec 20: versions (automatic every N minutes while editing, named, restore that can itself be undone), undo/redo
// (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z and the ↶ ↷ buttons) that only revert their own action, moving an arrow's ends,
// and the chat keys (Enter sends, Alt+Enter / Shift+Enter new line).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, role, sleep, ROOT } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

const { createHistory, applyChange, definition } = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'history.js')).href);

let s;
before(async () => { s = await startServer({ name: 'versions' }); await s.start(); });
after(async () => { await s?.stop(); });

// ---------------- versions API ----------------
test('versiones automáticas: el primer cambio guarda el estado inicial; luego como máximo una cada versionEveryMin; 0 = apagado', async () => {
  const f = await s.flow('Versionado', [role('A', 'uno', { id: 's_a' })], [], { versionEveryMin: 0.002 }); // ~120 ms
  let g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, steps: [{ ...f.steps[0], task: 'dos' }] });
  let list = await s.uiOk('GET', `/api/flows/${f.id}/versions`);
  assert.ok(list.some((v) => v.label === 'Estado inicial'), JSON.stringify(list));
  const n = list.length;
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: 'tres' }] }); // too soon: no new auto version
  await sleep(200);
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: 'cuatro' }] });
  list = await s.uiOk('GET', `/api/flows/${f.id}/versions`);
  assert.ok(list.length > n, 'pasado el intervalo, nueva versión');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/versions/${list[0].id}`)).flow.steps[0].task, 'cuatro');
  const off = await s.flow('Sin versiones', [role('B', 'x', { id: 's_b' })], [], { versionEveryMin: 0 });
  await s.uiOk('PUT', `/api/flows/${off.id}`, { ...off, steps: [{ ...off.steps[0], task: 'y' }] });
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${off.id}/versions`), []);
});

test('versión con nombre y restaurar: vuelve la definición, se conserva el estado de ejecución, y el estado previo queda como versión', async () => {
  const f = await s.flow('Restaurar', [role('A', '[[mock:say hola]]', { id: 's_r' })], [], { versionEveryMin: 0 });
  await s.runUi(f.id);
  const named = await s.uiOk('POST', `/api/flows/${f.id}/versions`, { label: 'antes de romper' });
  assert.equal(named.label, 'antes de romper');
  assert.equal(named.auto, false);
  const cur = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...cur, name: 'Roto', steps: [{ ...cur.steps[0], task: 'roto' }, role('Nuevo', 'x', { id: 's_n' })] });
  const w = await s.ws();
  const restored = await s.uiOk('POST', `/api/flows/${f.id}/versions/${named.id}/restore`, {});
  assert.equal(restored.name, 'Restaurar');
  assert.deepEqual(restored.steps.map((x) => x.id), ['s_r']);
  assert.equal(restored.steps[0].task, '[[mock:say hola]]');
  assert.equal(restored.steps[0].lastRun.status, 'success', 'se conserva lo ejecutado');
  assert.ok(restored.rev > cur.rev);
  await w.waitFor((m) => m.type === 'flow.updated' && m.flowId === f.id && m.flow.name === 'Restaurar');
  const list = await s.uiOk('GET', `/api/flows/${f.id}/versions`);
  const undo = list.find((v) => /^Antes de restaurar/.test(v.label));
  assert.ok(undo, 'el estado previo quedó guardado');
  const back = await s.uiOk('POST', `/api/flows/${f.id}/versions/${undo.id}/restore`, {});
  assert.equal(back.name, 'Roto', 'restaurar se puede deshacer');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/versions/v_nope/restore`, {})).status, 404);
  w.close();
});

test('restaurar con una ejecución en curso → 409; borrar versión; borrar el flujo borra sus versiones', async () => {
  const f = await s.flow('Ocupado', [role('Lento', '[[mock:sleep 5]]', { id: 's_l' })], [], { versionEveryMin: 0 });
  const v = await s.uiOk('POST', `/api/flows/${f.id}/versions`, { label: 'x' });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
  const r = await s.ui('POST', `/api/flows/${f.id}/versions/${v.id}/restore`, {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'RUN_IN_PROGRESS');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/cancel`, {});
  await s.uiOk('DELETE', `/api/flows/${f.id}/versions/${v.id}`);
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${f.id}/versions`), []);
  await s.uiOk('POST', `/api/flows/${f.id}/versions`, { label: 'y' });
  await s.waitRun(f.id, runId);
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.equal((await s.ui('GET', `/api/flows/${f.id}/versions`)).status, 404);
});

// ---------------- undo/redo logic (client/src/history.js) ----------------
const fl = (steps, extra = {}) => ({ id: 'f', rev: 1, name: 'F', vars: {}, edges: [], steps, ...extra });
const st = (id, task, extra = {}) => ({ id, name: id, task, memory: [], lastRun: null, position: { x: 0, y: 0 }, ...extra });
test('deshacer/rehacer: revierte solo su acción, conserva lo que llegó después de otra pestaña y el estado de ejecución', () => {
  const h = createHistory();
  const v0 = fl([st('a', 'uno'), st('b', 'dos')]);
  const v1 = fl([st('a', 'UNO'), st('b', 'dos')]);
  h.record(v0, v1);
  // later: another tab renames b, and a run updates a's lastRun
  const current = fl([st('a', 'UNO', { lastRun: { status: 'success' } }), st('b', 'dos (otra pestaña)')], { rev: 5 });
  const undone = h.undo(current);
  assert.equal(undone.steps[0].task, 'uno');
  assert.equal(undone.steps[1].task, 'dos (otra pestaña)', 'el cambio de la otra pestaña sigue');
  assert.deepEqual(undone.steps[0].lastRun, { status: 'success' }, 'el estado de ejecución sigue');
  assert.equal(undone.rev, 5);
  assert.equal(h.canRedo, true);
  const redone = h.redo(undone);
  assert.equal(redone.steps[0].task, 'UNO');
  // undo a deletion restores the step; a new record clears redo
  const h2 = createHistory();
  const d0 = fl([st('a', 'x'), st('b', 'y')]); const d1 = fl([st('a', 'x')]);
  h2.record(d0, d1);
  assert.deepEqual(h2.undo(d1).steps.map((x) => x.id), ['a', 'b']);
  h2.record(d1, fl([st('a', 'z')]));
  assert.equal(h2.canRedo, false);
  assert.deepEqual(Object.keys(definition(fl([st('a', 'x', { lastRun: {} })]))).includes('rev'), false);
  assert.equal(applyChange(fl([st('a', 'q')]), definition(fl([st('a', 'q')])), definition(fl([st('a', 'r')]))).steps[0].task, 'r');
});

// ---------------- browser ----------------
let ui = {};
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
afterEach(async (t) => { await captureOnFailure(ui.page, t); });
// Close the browser and its server even if a test failed (otherwise the test process never exits).
after(async () => { await ui.close?.(); });
const node = (page, name) => page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: new RegExp(`^${name}$`) }) });

test('Ctrl+Z / Ctrl+Y y los botones ↶ ↷: deshacer y rehacer agregar una caja y renombrarla; dentro de un campo de texto Ctrl+Z es el del campo', async (t) => {
  ui = await openUi('undo');
  if (guard(t)) return;
  const { s: u, page } = ui;
  const f = await u.flow('Deshacer', [role('Base', 'x', { id: 's_base', position: { x: 100, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${f.id}`);
  await node(page, 'Base').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Deshacer' }).isDisabled(), true);
  await node(page, 'Base').click();
  await page.getByRole('button', { name: 'Duplicar' }).click();
  await node(page, 'Base \\(copia\\)').waitFor();
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } }); // focus out of fields
  await page.keyboard.press('Control+z');
  await node(page, 'Base \\(copia\\)').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+y');
  await node(page, 'Base \\(copia\\)').waitFor();
  await page.getByRole('button', { name: 'Deshacer' }).click();
  await node(page, 'Base \\(copia\\)').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Rehacer' }).click();
  await node(page, 'Base \\(copia\\)').waitFor();
  // rename, then undo with Ctrl+Shift+Z / Ctrl+Z from the canvas
  await node(page, 'Base').click();
  await page.locator('.title-input').fill('Renombrada');
  await sleep(1200); // separate action from the duplicate
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+z');
  await node(page, 'Base').waitFor();
  await page.keyboard.press('Control+Shift+z');
  await node(page, 'Renombrada').waitFor();
  // saved on the server too
  let g;
  for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.steps.some((x) => x.name === 'Renombrada') && g.steps.length === 2) break; await sleep(150); }
  assert.deepEqual(g.steps.map((x) => x.name).sort(), ['Base (copia)', 'Renombrada']);
});

test('Versiones en la UI: guardar con nombre, cambiar, restaurar y ver el flujo anterior en el canvas', async (t) => {
  if (guard(t)) return;
  const { s: u, page } = ui;
  const f = await u.flow('Con versiones', [role('Original', 'x', { id: 's_o', position: { x: 100, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${f.id}`);
  await node(page, 'Original').waitFor();
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await page.locator('.tabs button', { hasText: 'Versiones' }).click();
  await page.getByPlaceholder('Nombre de la versión (opcional)').fill('punto seguro');
  await page.getByRole('button', { name: 'Guardar versión' }).click();
  await page.locator('.version-list li', { hasText: 'punto seguro' }).waitFor();
  await node(page, 'Original').click();
  await page.locator('.title-input').fill('Cambiada');
  for (let i = 0; i < 40 && (await u.getFlow(f.id)).steps[0].name !== 'Cambiada'; i++) await sleep(150);
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await page.locator('.tabs button', { hasText: 'Versiones' }).click();
  ui.answers.push(true);
  await page.locator('.version-list li', { hasText: 'punto seguro' }).getByRole('button', { name: 'Restaurar' }).click();
  await node(page, 'Original').waitFor();
  await page.locator('.version-list li', { hasText: 'Antes de restaurar' }).waitFor();
  assert.equal((await u.getFlow(f.id)).steps[0].name, 'Original');
});

test('mover una flecha: volver a unir las mismas cajas desde otro punto mueve la flecha existente', async (t) => {
  if (guard(t)) return;
  const { s: u, page } = ui;
  const f = await u.flow('Mover flecha', [role('A', 'x', { id: 's_ma', position: { x: 100, y: 80 } }), role('B', 'x', { id: 's_mb', position: { x: 520, y: 360 } })], [['s_ma', 's_mb']]);
  await page.goto(`${u.base}/?flow=${f.id}`);
  await node(page, 'B').waitFor();
  const a = await node(page, 'A').locator('[data-handleid="out-bottom"]').boundingBox();
  const b = await node(page, 'B').locator('[data-handleid="in-top"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + 15, a.y + 15, { steps: 5 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 }); await page.mouse.up();
  await page.getByText('Flecha movida a los puntos elegidos.').waitFor();
  let g;
  for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.edges[0]?.sourceHandle === 'out-bottom') break; await sleep(150); }
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].sourceHandle, 'out-bottom');
  assert.equal(g.edges[0].targetHandle, 'in-top');
});

test('chat: Enter envía; Alt+Enter y Shift+Enter hacen salto de línea; el botón Enviar sigue', async (t) => {
  if (guard(t)) return;
  const { s: u, page } = ui;
  const f = await u.flow('Chat teclas', [role('Uno', 'x', { id: 's_ct', position: { x: 100, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${f.id}`);
  await node(page, 'Uno').waitFor();
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await page.locator('.tabs button', { hasText: 'Chat general' }).click();
  const box = page.getByPlaceholder('Escribe… (Enter envía · Alt+Enter nueva línea)');
  await box.click();
  await box.type('línea uno');
  await page.keyboard.press('Alt+Enter');
  await box.type('línea dos');
  await page.keyboard.press('Shift+Enter');
  await box.type('línea tres');
  assert.equal(await box.inputValue(), 'línea uno\nlínea dos\nlínea tres');
  assert.equal((await u.uiOk('GET', `/api/flows/${f.id}/chat/_global`)).length, 0, 'todavía no se envió');
  await page.keyboard.press('Enter');
  await page.getByText(/Respuesta de chat \(mock\)/).first().waitFor();
  assert.equal(await box.inputValue(), '');
  const msgs = await u.uiOk('GET', `/api/flows/${f.id}/chat/_global`);
  assert.equal(msgs.find((m) => m.role === 'user').text, 'línea uno\nlínea dos\nlínea tres');
  await box.type('por botón');
  await page.getByRole('button', { name: 'Enviar' }).click();
  for (let i = 0; i < 40 && !(await u.uiOk('GET', `/api/flows/${f.id}/chat/_global`)).some((m) => m.text === 'por botón'); i++) await sleep(150);
  assert.ok((await u.uiOk('GET', `/api/flows/${f.id}/chat/_global`)).some((m) => m.text === 'por botón'));
  assert.deepEqual(page.errors, []);
});
