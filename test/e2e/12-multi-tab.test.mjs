// Spec 19: several browser tabs. Each tab keeps its own flow (URL ?flow=, per-tab session); the same flow open in
// several tabs is never overwritten: saves carry the revision they are based on (409 + current flow when stale),
// every save is broadcast, and tabs merge field by field (3-way). Chat proposals, ctx.setVar and resets bump the
// revision too, so a stale tab cannot undo them.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd, sleep, ROOT } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { mergeFlows } = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'merge.js')).href);

// ---------------- API ----------------
let s;
before(async () => { s = await startServer({ name: 'tabs' }); await s.start(); });
after(async () => { await s?.stop(); });

test('revisiones: cada guardado sube rev; guardar sobre una revisión vieja → 409 con el flujo actual; sin baseRev (scripts) sigue funcionando', async () => {
  const f = await s.flow('Revisiones', [role('A', 'x', { id: 's_a' })]);
  const r1 = f.rev;
  const a = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, name: 'Rev 2', baseRev: r1 });
  assert.equal(a.rev, r1 + 1);
  const stale = await s.ui('PUT', `/api/flows/${f.id}`, { ...f, name: 'pisado', baseRev: r1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'FLOW_CONFLICT');
  assert.equal(stale.body.flow.name, 'Rev 2');
  assert.equal((await s.getFlow(f.id)).name, 'Rev 2', 'no se pisó');
  const noBase = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...a, name: 'Rev 3' });
  assert.equal(noBase.rev, r1 + 2);
});

test('lo que cambia la definición fuera del editor sube rev y se difunde: propuesta del chat aplicada, ctx.setVar, reset', async () => {
  const st = role('Editable', 'vieja', { id: 's_e', hooks: 'async function onStart(ctx) { ctx.setVar("marca", "hook"); }' });
  const f = await s.flow('Rev externas', [st]);
  const w = await s.ws();
  let rev = (await s.getFlow(f.id)).rev;
  await s.runUi(f.id);
  let g = await s.getFlow(f.id);
  assert.equal(g.vars.marca, 'hook');
  assert.ok(g.rev > rev, 'ctx.setVar sube rev'); rev = g.rev;
  assert.ok(w.msgs.some((m) => m.type === 'flow.updated' && m.flowId === f.id && m.flow.vars?.marca === 'hook'));
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_e`, { message: 'cambia [[mock:propose {"task":"nueva"}]]' });
  let msg;
  for (let i = 0; i < 100 && !msg; i++) { msg = (await s.uiOk('GET', `/api/flows/${f.id}/chat/s_e`)).find((x) => x.proposals?.length && x.status === 'done'); if (!msg) await sleep(100); }
  g = await s.uiOk('POST', `/api/flows/${f.id}/chat/s_e/apply`, { messageId: msg.id, proposalId: msg.proposals[0].id });
  assert.equal(g.steps[0].task, 'nueva');
  assert.ok(g.rev > rev, 'aplicar propuesta sube rev'); rev = g.rev;
  const stale = await s.ui('PUT', `/api/flows/${f.id}`, { ...f, baseRev: f.rev });
  assert.equal(stale.status, 409, 'una pestaña vieja no deshace la propuesta');
  g = await s.uiOk('POST', `/api/flows/${f.id}/reset`, { parts: ['vars'] });
  assert.ok(g.rev > rev, 'reset sube rev');
  w.close();
});

test('difusión: guardar emite flow.updated con la pestaña que guardó; crear/renombrar/borrar avisa a las demás pestañas', async () => {
  const w = await s.ws();
  const f = await s.uiOk('POST', '/api/flows', { name: 'Difusión' });
  await w.waitFor((m) => m.type === 'flows.changed');
  const n = w.msgs.length;
  await s.ui('PUT', `/api/flows/${f.id}`, { ...f, name: 'Difusión 2', baseRev: f.rev }, { 'X-AFS-Tab': 'tabA' });
  const up = await w.waitFor((m, i) => m.type === 'flow.updated' && m.flowId === f.id && m.by === 'tabA');
  assert.equal(up.flow.name, 'Difusión 2');
  assert.ok(w.msgs.slice(n).some((m) => m.type === 'flows.changed'), 'renombrar avisa la lista');
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  await w.waitFor((m) => m.type === 'flow.deleted' && m.flowId === f.id);
  w.close();
});

// ---------------- merge (client/src/merge.js) ----------------
const st = (id, name, extra = {}) => ({ id, name, task: 't', memory: [], lastRun: null, position: { x: 0, y: 0 }, ...extra });
const BASE = { id: 'f', rev: 1, name: 'F', vars: { a: '1' }, steps: [st('a', 'A'), st('b', 'B')], edges: [{ id: 'e1', source: 'a', target: 'b' }] };
test('merge 3 vías: cambios en partes distintas se combinan; estado de ejecución viene del servidor; altas y bajas de ambos lados', () => {
  const local = structuredClone(BASE); local.steps[0].task = 'tarea local'; local.steps.push(st('c', 'C')); local.edges.push({ id: 'e2', source: 'b', target: 'c' });
  const remote = structuredClone(BASE); remote.rev = 2; remote.steps[1].name = 'B remoto'; remote.vars = { a: '2' }; remote.steps[0].lastRun = { status: 'success' }; remote.steps.push(st('d', 'D')); remote.edges.push({ id: 'e3', source: 'd', target: 'a' });
  const { merged, conflicts } = mergeFlows(BASE, local, remote);
  assert.equal(merged.steps.find((x) => x.id === 'a').task, 'tarea local');
  assert.deepEqual(merged.steps.find((x) => x.id === 'a').lastRun, { status: 'success' });
  assert.equal(merged.steps.find((x) => x.id === 'b').name, 'B remoto');
  assert.deepEqual(merged.vars, { a: '2' });
  assert.deepEqual(merged.steps.map((x) => x.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(merged.edges.map((e) => e.id).sort(), ['e1', 'e2', 'e3']);
  assert.equal(merged.rev, 2);
  assert.deepEqual(conflicts, []);
  const del = structuredClone(BASE); del.steps = [del.steps[0]]; del.edges = [];
  assert.deepEqual(mergeFlows(BASE, del, { ...structuredClone(BASE), rev: 2 }).merged.steps.map((x) => x.id), ['a'], 'borrado local');
});
test('merge 3 vías: mismo campo cambiado en ambos → gana lo local y se informa; borrado vs cambiado se conserva; ciclos entre pestañas se evitan', () => {
  const l = structuredClone(BASE); l.name = 'Mío';
  const r = structuredClone(BASE); r.name = 'Suyo'; r.rev = 2;
  let out = mergeFlows(BASE, l, r);
  assert.equal(out.merged.name, 'Mío'); assert.deepEqual(out.conflicts, ['name']);
  const l2 = structuredClone(BASE); l2.steps = [l2.steps[0]]; l2.edges = [];
  const r2 = structuredClone(BASE); r2.rev = 2; r2.steps[1].task = 'cambiada';
  out = mergeFlows(BASE, l2, r2);
  assert.ok(out.merged.steps.some((x) => x.id === 'b' && x.task === 'cambiada'));
  assert.equal(out.conflicts.length, 1);
  const l3 = structuredClone(BASE); l3.steps.push(st('c', 'C')); l3.edges.push({ id: 'x', source: 'b', target: 'c' });
  const r3 = structuredClone(BASE); r3.rev = 2; r3.steps.push(st('c', 'C')); r3.edges.push({ id: 'y', source: 'c', target: 'a' });
  out = mergeFlows(BASE, l3, r3);
  assert.ok(!(out.merged.edges.some((e) => e.id === 'x') && out.merged.edges.some((e) => e.id === 'y')), 'no cierra el ciclo a→b→c→a');
});

// ---------------- real browser tabs ----------------
let ui = {};
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
let pageB;
afterEach(async (t) => { await captureOnFailure(ui.page, t); });
// Close the browser and its server even if a test failed (otherwise the test process never exits).
after(async () => { await ui.close?.(); });
test('pestañas del navegador: cada una con su flujo (URL ?flow=, título); recargar mantiene el de cada pestaña', async (t) => {
  ui = await openUi('tabsui');
  if (guard(t)) return;
  const { s: u, page } = ui;
  const x = await u.flow('Flujo X', [role('Paso X', 'x', { id: 's_x', position: { x: 100, y: 100 } })]);
  const y = await u.flow('Flujo Y', [role('Paso Y', 'y', { id: 's_y', position: { x: 100, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${x.id}`);
  await page.locator('.node-name', { hasText: 'Paso X' }).waitFor();
  pageB = await page.context().newPage();
  pageB.setDefaultTimeout(60000);
  await pageB.goto(`${u.base}/?flow=${y.id}`);
  await pageB.locator('.node-name', { hasText: 'Paso Y' }).waitFor();
  assert.equal(await page.title(), 'Flujo X · Agent Flow Studio');
  assert.equal(await pageB.title(), 'Flujo Y · Agent Flow Studio');
  // edit each tab's flow
  await page.locator('.node-name', { hasText: 'Paso X' }).click();
  await page.locator('.title-input').fill('Paso X editado');
  await pageB.locator('.node-name', { hasText: 'Paso Y' }).click();
  await pageB.locator('.title-input').fill('Paso Y editado');
  for (let i = 0; i < 60; i++) { if ((await u.getFlow(x.id)).steps[0].name === 'Paso X editado' && (await u.getFlow(y.id)).steps[0].name === 'Paso Y editado') break; await sleep(150); }
  assert.equal((await u.getFlow(x.id)).steps[0].name, 'Paso X editado');
  assert.equal((await u.getFlow(y.id)).steps[0].name, 'Paso Y editado');
  await pageB.reload();
  await pageB.locator('.node-name', { hasText: 'Paso Y editado' }).waitFor();
  assert.match(pageB.url(), new RegExp(`flow=${y.id}`));
  // a flow created in tab B shows up in tab A's selector
  ui.answers.push('Creado en B');
  pageB.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Creado en B') : d.accept()));
  await pageB.getByRole('button', { name: '+ Flujo' }).click();
  await page.locator('header select option', { hasText: 'Creado en B' }).waitFor({ state: 'attached' });
});

test('el MISMO flujo en dos pestañas: los cambios de ambas se combinan, cada una ve la otra en vivo y nadie pisa a nadie', async (t) => {
  if (guard(t)) return;
  const { s: u, page } = ui;
  const z = await u.flow('Compartido', [role('Uno', 'tarea uno', { id: 's_1', position: { x: 100, y: 100 } }), role('Dos', 'tarea dos', { id: 's_2', position: { x: 450, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${z.id}`);
  await pageB.goto(`${u.base}/?flow=${z.id}`);
  await page.locator('.node-name', { hasText: 'Uno' }).waitFor();
  await pageB.locator('.node-name', { hasText: 'Dos' }).waitFor();
  // A renames "Uno" while B renames "Dos" at the same time (both have unsaved edits based on the same revision)
  await page.locator('.node-name', { hasText: 'Uno' }).click();
  await pageB.locator('.node-name', { hasText: 'Dos' }).click();
  await Promise.all([page.locator('.title-input').fill('Uno (A)'), pageB.locator('.title-input').fill('Dos (B)')]);
  let g;
  for (let i = 0; i < 80; i++) { g = await u.getFlow(z.id); if (g.steps.find((x) => x.id === 's_1').name === 'Uno (A)' && g.steps.find((x) => x.id === 's_2').name === 'Dos (B)') break; await sleep(150); }
  assert.equal(g.steps.find((x) => x.id === 's_1').name, 'Uno (A)', 'el cambio de A sigue');
  assert.equal(g.steps.find((x) => x.id === 's_2').name, 'Dos (B)', 'el cambio de B sigue');
  // each tab sees the other's change live
  await page.locator('.node-name', { hasText: 'Dos (B)' }).waitFor();
  await pageB.locator('.node-name', { hasText: 'Uno (A)' }).waitFor();
  // B adds a box (duplicate) → appears in A without reload; A's later edit doesn't remove it
  await pageB.getByRole('button', { name: 'Duplicar' }).click();
  await page.locator('.node-name', { hasText: 'Dos (B) (copia)' }).waitFor();
  await page.locator('.title-input').fill('Uno (A) otra vez');
  for (let i = 0; i < 60; i++) { g = await u.getFlow(z.id); if (g.steps.some((x) => x.name === 'Uno (A) otra vez')) break; await sleep(150); }
  assert.equal(g.steps.length, 3, 'la caja duplicada en B no se perdió');
  assert.ok(g.steps.some((x) => x.name === 'Dos (B) (copia)'));
});

test('borrar el flujo en una pestaña: la otra avisa y pasa a otro flujo', async (t) => {
  if (guard(t)) return;
  const { s: u, page } = ui;
  const d = await u.flow('Para borrar', [role('Z', 'z', { id: 's_z', position: { x: 100, y: 100 } })]);
  await page.goto(`${u.base}/?flow=${d.id}`);
  await pageB.goto(`${u.base}/?flow=${d.id}`);
  await pageB.locator('.node-name', { hasText: 'Z' }).waitFor();
  ui.answers.push(true);
  await page.getByTitle('Eliminar flujo').click();
  await pageB.getByText('Este flujo se eliminó en otra pestaña.').waitFor();
  await pageB.waitForFunction((id) => !location.search.includes(id), d.id);
  assert.deepEqual([...ui.page.errors], []);
});
