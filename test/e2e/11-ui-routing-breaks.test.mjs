// Spec 18 in the real UI: draw an arrow from any side of a box, configure what passes and when, see conditional
// branches as "no enrutado", put a break on a box and validate its output (edit / approve) from the review window,
// duplicate a box and reuse it from "Mis steps".
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { role, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let ui = {}; let s; let page;
before(async () => { ui = await openUi('ui18'); ({ s, page } = ui); });
after(async () => { await ui.close?.(); });
afterEach(async (t) => { await captureOnFailure(page, t); });
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
/** Mouse drag in small steps (React Flow needs real pointer moves to start/finish a connection). */
async function drag(from, to) {
  const a = await from.boundingBox(); const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}
const node = (name) => page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: name }) });

let flowId;
test('dibujar una flecha desde el lado de ABAJO de una caja al de ARRIBA de otra; se guarda con sus lados', async (t) => {
  if (guard(t)) return;
  const f = await s.flow('Lados', [
    role('Origen', '[[mock:json {"casos":["a","b"],"riesgo":"alto"}]]', { id: 's_o', output: { format: 'json' }, position: { x: 100, y: 80 } }),
    role('Destino', '[[mock:echo]]', { id: 's_d', position: { x: 100, y: 420 } }),
    role('Otro', '[[mock:say otro]]', { id: 's_x', position: { x: 520, y: 420 } }),
  ]);
  flowId = f.id;
  await page.goto(s.base + '/');
  await page.locator('header select').selectOption(f.id);
  await node('Destino').waitFor();
  const from = node('Origen').locator('.react-flow__handle[data-handleid="out-bottom"]');
  const to = node('Destino').locator('.react-flow__handle[data-handleid="in-top"]');
  await drag(from, to);
  let g;
  for (let i = 0; i < 40; i++) { g = await s.getFlow(f.id); if (g.edges.length) break; await sleep(150); }
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].sourceHandle, 'out-bottom');
  assert.equal(g.edges[0].targetHandle, 'in-top');
  // a second arrow from the same box (N outputs), from its right side
  await drag(node('Origen').locator('.react-flow__handle[data-handleid="out-right"]'), node('Otro').locator('.react-flow__handle[data-handleid="in-left"]'));
  for (let i = 0; i < 40; i++) { g = await s.getFlow(f.id); if (g.edges.length === 2) break; await sleep(150); }
  assert.equal(g.edges.length, 2);
  assert.deepEqual(g.edges.map((e) => e.source), ['s_o', 's_o']);
  assert.deepEqual(page.errors, []);
});

test('seleccionar la flecha: qué pasa (campo) y cuándo (condición); se ve sobre la flecha y la ejecución lo respeta', async (t) => {
  if (guard(t)) return;
  const g = await s.getFlow(flowId);
  const toDest = g.edges.find((e) => e.target === 's_d');
  await page.locator(`.react-flow__edge[data-id="${toDest.id}"]`).click({ force: true });
  await page.getByText('Flecha: Origen → Destino').waitFor();
  await page.getByPlaceholder('Ej: casos  ·  riesgos.alto  ·  items.0').fill('casos');
  await page.getByPlaceholder('Ej: casos de riesgo alto').fill('lista de casos');
  const toOther = g.edges.find((e) => e.target === 's_x');
  await page.locator(`.react-flow__edge[data-id="${toOther.id}"]`).click({ force: true });
  await page.getByText('Flecha: Origen → Otro').waitFor();
  await page.locator('.edge-panel select').first().selectOption('json');
  await page.getByPlaceholder('campo (riesgo)').fill('riesgo');
  await page.getByPlaceholder('valor (alto)').fill('bajo');
  await page.locator('.react-flow__edge-text', { hasText: 'si riesgo = bajo' }).waitFor();
  await page.locator('.react-flow__edge-text', { hasText: 'lista de casos · { casos }' }).waitFor();
  let saved;
  for (let i = 0; i < 40; i++) { saved = await s.getFlow(flowId); if (saved.edges.find((e) => e.target === 's_x')?.when?.value === 'bajo') break; await sleep(150); }
  assert.equal(saved.edges.find((e) => e.target === 's_d').pick, 'casos');
  assert.deepEqual(saved.edges.find((e) => e.target === 's_x').when, { type: 'json', path: 'riesgo', op: 'equals', value: 'bajo' });
  // run from the toolbar: Destino gets only "casos", Otro is not routed
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await node('Destino').locator('.node.st-success').waitFor();
  await node('Otro').locator('.status', { hasText: 'no enrutado' }).waitFor();
  const runs = await s.uiOk('GET', `/api/flows/${flowId}/runs`);
  const run = await s.uiOk('GET', `/api/flows/${flowId}/runs/${runs[0].id}`);
  assert.equal(run.status, 'success');
  assert.match(run.steps.s_d.output, /### Origen → lista de casos · campo casos\n\[\n  "a",\n  "b"\n\]/);
  assert.equal(run.steps.s_x.skipReason, 'not_routed');
});

test('break después: elegirlo en la caja, la ejecución se pausa, se edita la salida en la ventana de revisión y sigue', async (t) => {
  if (guard(t)) return;
  await node('Origen').click();
  await page.locator('.field', { hasText: 'Break' }).locator('select').selectOption('after');
  await node('Origen').locator('.brk', { hasText: '⏸ después' }).waitFor();
  for (let i = 0; i < 40; i++) { if ((await s.getFlow(flowId)).steps.find((x) => x.id === 's_o').breakpoint === 'after') break; await sleep(150); }
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.getByText('Break: validar antes de seguir').waitFor();
  await page.locator('.review-bar', { hasText: 'Ejecución en pausa en “Origen”' }).waitFor();
  await node('Origen').locator('.status', { hasText: 'en revisión' }).waitFor();
  await page.getByRole('button', { name: '✎ Editar salida' }).click();
  const areas = page.locator('.pause-card textarea');
  await areas.nth(0).fill('salida revisada');
  await areas.nth(1).fill('{"casos":["solo-este"],"riesgo":"alto"}');
  await page.getByRole('button', { name: 'Guardar y seguir' }).click();
  await page.locator('.review-bar').waitFor({ state: 'detached' });
  await node('Destino').locator('.node.st-success').waitFor();
  const runs = await s.uiOk('GET', `/api/flows/${flowId}/runs`);
  const run = await s.waitRun(flowId, runs[0].id);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_o.reviewed.action, 'edit');
  assert.match(run.steps.s_d.output, /"solo-este"/);
});

test('break: re-ejecutar con corrección vuelve a pausar; aprobar y seguir termina', async (t) => {
  if (guard(t)) return;
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.getByRole('button', { name: '↻ Re-ejecutar con corrección' }).click();
  await page.getByPlaceholder('Ej: faltan los casos negativos; usa formato Gherkin').fill('agrega casos negativos');
  await page.getByRole('button', { name: '↻ Re-ejecutar con la corrección' }).click();
  await page.getByText('(intento 2)').waitFor();
  await page.getByRole('button', { name: '✔ Aprobar y seguir' }).click();
  await page.locator('.review-bar').waitFor({ state: 'detached' });
  const runs = await s.uiOk('GET', `/api/flows/${flowId}/runs`);
  const run = await s.waitRun(flowId, runs[0].id);
  assert.equal(run.status, 'success');
  assert.equal(run.steps.s_o.reviewRounds, 1);
});

test('reutilizar cajas: duplicar en el flujo y guardar en "Mis steps" para insertarla en otro flujo', async (t) => {
  if (guard(t)) return;
  await node('Origen').click();
  await page.getByRole('button', { name: 'Duplicar' }).click();
  await node('Origen (copia)').waitFor();
  ui.answers.push('Analizador estándar');
  await page.getByRole('button', { name: '📚 Guardar' }).click();
  for (let i = 0; i < 40 && !(await s.uiOk('GET', '/api/library')).length; i++) await sleep(150);
  const lib = await s.uiOk('GET', '/api/library');
  assert.equal(lib[0].name, 'Analizador estándar');
  assert.equal(lib[0].step.breakpoint, 'after');
  // another flow: insert it from + Step → Mis steps
  ui.answers.push('Flujo destino');
  await page.getByRole('button', { name: '+ Flujo' }).click();
  await page.getByText('Agrega steps desde la barra superior').waitFor();
  await page.getByRole('button', { name: '＋ Step' }).click();
  await page.getByText('📚 Mis steps').waitFor();
  await page.locator('.lib-item .preset', { hasText: 'Analizador estándar' }).click();
  await node('Analizador estándar').waitFor();
  const flows = await s.uiOk('GET', '/api/flows');
  let other;
  for (let i = 0; i < 40; i++) { other = await s.getFlow(flows.find((x) => x.name === 'Flujo destino').id); if (other.steps.length) break; await sleep(150); }
  assert.equal(other.steps[0].name, 'Analizador estándar');
  assert.equal(other.steps[0].output.format, 'json');
  assert.equal(other.steps[0].lastRun, null);
  assert.deepEqual(page.errors, []);
});
