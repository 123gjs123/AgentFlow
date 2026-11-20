// Spec 29 in the browser: 🔲 Cajas | 🏢 Oficina, the office live during a run (reading at a shelf, the coordinator at the
// desk, the computer going red, the stamp in Salida), a break (raised hand, bell → review), clicks → panels, replay of
// a past run, reduced motion, pausing when hidden, and the persona editor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cmd, role, sleep } from './helpers/harness.mjs';
import { captureOnFailure } from './helpers/browser.mjs';

let ui; let s; let page;
const skip = (t) => { if (ui?.skipReason) { t.skip(ui.skipReason); return true; } return false; };
before(async () => { const { openUi } = await import('./helpers/browser.mjs'); ui = await openUi('office-ui'); if (!ui.skipReason) ({ s, page } = ui); });
after(async () => { await ui?.close?.(); });
const desk = (id) => page.locator(`[data-testid="office-desk"][data-step="${id}"]`);
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };

test('vista: 🏢 Oficina tiene un escritorio por step, queda en la URL y al recargar; 🔲 Cajas vuelve al lienzo', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina A', [role('Análisis', 'x', { id: 's_a' }), cmd('Corre', 'Write-Output 1', { id: 's_c' }), role('Revisión', 'x', { id: 's_r' })], [['s_a', 's_c'], ['s_c', 's_r']]);
    await page.goto(`${s.base}/?flow=${f.id}`);
    await page.getByTestId('view-office').click();
    await page.getByTestId('office').waitFor();
    assert.equal(await page.getByTestId('office-desk').count(), 3);
    assert.match(page.url(), /view=office/);
    assert.equal(await desk('s_a').getAttribute('data-name'), 'Lucía');
    await page.reload(); await page.getByTestId('office').waitFor();
    await page.getByTestId('view-canvas').click();
    await page.locator('.react-flow').waitFor();
    assert.doesNotMatch(page.url(), /view=office/);
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('en vivo: Lucía va a la estantería Contexto, Tomás lleva la carpeta, la computadora pasa a rojo y la Salida dice RECHAZADO; la bitácora lo cuenta', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina B', [
      role('Análisis', '[[mock:sleep 1]] [[mock:tool Read docs/a.md]] [[mock:hold 3]] [[mock:say ok]]', { id: 's_a' }),
      cmd('Ejecución', 'Start-Sleep 2; exit 1', { id: 's_e' }),
    ], [['s_a', 's_e']]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.getByTestId('office').waitFor();
    await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await page.locator('[data-testid="office-coordinator"][data-target="desk:s_a"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="office-walker"][data-step="s_a"][data-activity="reading"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="office-computer"][data-state="running"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="office-computer"][data-state="err"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="office-salida"][data-stamp="RECHAZADO"]').waitFor({ timeout: 20000 });
    await page.getByTestId('office-log-btn').click();
    assert.match(await page.getByTestId('office-log').textContent(), /Contexto/);
    assert.match(await page.getByTestId('office-summary').textContent(), /Ejecución A/);
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('break: la persona levanta la mano, suena la ventanilla (🔔) y la ventanilla abre la revisión', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina C', [role('Redacta', '[[mock:say borrador]]', { id: 's_b', breakpoint: 'after' })]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.getByTestId('office').waitFor();
    await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await page.locator('[data-testid="office-desk"][data-step="s_b"][data-activity="raised-hand"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="office-window"][data-bell="1"]').waitFor();
    if (await page.getByText('Break: validar antes de seguir').count()) await page.keyboard.press('Escape');
    await page.getByTestId('office-window').click();
    await page.getByText('Break: validar antes de seguir').waitFor();
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('clicks: un escritorio abre su step, una flecha su panel, la estantería Memoria la pestaña Memoria, el turno las ejecuciones', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina D', [role('Uno', 'x', { id: 's_1' }), role('Dos', 'x', { id: 's_2' })], [['s_1', 's_2']]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.getByTestId('office').waitFor();
    await desk('s_2').click();
    assert.equal(await page.locator('.title-input').inputValue(), 'Dos');
    await page.getByTestId('office-edge').first().click({ force: true });
    await page.locator('.edge-panel').getByText('Flecha: Uno → Dos').waitFor();
    await page.getByTestId('office-shelf-memoria').first().click();
    await page.locator('[data-testid="flow-tab-memory"].active').waitFor();
    await page.getByTestId('office-display').click();
    await page.locator('[data-testid="flow-tab-runs"].active').waitFor();
    // keyboard: a desk is a button
    await desk('s_1').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.title-input').inputValue(), 'Uno');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('jornada: repetir una ejecución pasada (16×) recorre los escritorios hasta su final y ✕ vuelve al vivo', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina E', [role('Lee', '[[mock:tool Read x.md]] [[mock:say ok]]', { id: 's_l' }), cmd('Falla', 'exit 2', { id: 's_f' })], [['s_l', 's_f']]);
    const r = await s.runUi(f.id);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.getByTestId('office').waitFor();
    await page.getByTestId('office-replay-btn').click();
    await page.getByTestId('office-replay-speed').selectOption('16');
    await page.getByTestId('office-replay-run').selectOption(r.id);
    await page.locator('[data-testid="office"][data-mode="replay"]').waitFor();
    await page.locator('[data-testid="office-salida"][data-stamp="RECHAZADO"]').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-testid="office-computer"]').getAttribute('data-state'), 'err');
    await page.getByTestId('office-replay-stop').click();
    await page.locator('[data-testid="office"][data-mode="live"]').waitFor();
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('movimiento reducido (del sistema o el interruptor): sin caminatas, Tomás aparece en su destino; oculta la pestaña, no anima', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina F', [role('Lejos', '[[mock:sleep 2]] [[mock:say ok]]', { id: 's_x' })]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { try { localStorage.removeItem('afs.office.reducedMotion'); } catch {} });
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.locator('[data-testid="office"][data-reduced-motion="1"]').waitFor();
    await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    const c = page.getByTestId('office-coordinator');
    await page.locator('[data-testid="office-coordinator"][data-target="desk:s_x"]').waitFor({ timeout: 15000 });
    const visit = await until(async () => (await c.getAttribute('data-moving')) === '0' && c.getAttribute('data-tile'));
    assert.ok(visit, 'llegó sin caminar');
    assert.equal(await page.getByTestId('office').getAttribute('data-animating'), '0');
    await page.getByTestId('office-reduced').uncheck();
    await page.locator('[data-testid="office"][data-reduced-motion="0"]').waitFor();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // hidden tab: nothing animates
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator('[data-testid="office"][data-animating="0"]').waitFor();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => { try { localStorage.removeItem('afs.office.reducedMotion'); } catch {} });
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('personaje: el nombre elegido en el step se ve en la oficina, se guarda en el flujo y ↺ Automático lo quita', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina G', [role('Análisis', 'x', { id: 's_p' })]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await desk('s_p').click();
    await page.getByTestId('persona-box').locator('summary').click();
    await page.getByTestId('persona-name').fill('Rigoberta');
    let g; for (let i = 0; i < 40; i++) { g = await s.getFlow(f.id); if (g.steps[0].persona?.name === 'Rigoberta') break; await sleep(150); }
    assert.equal(g.steps[0].persona.name, 'Rigoberta');
    await until(async () => /Rigoberta/.test(await desk('s_p').getAttribute('aria-label')));
    assert.match(await desk('s_p').getAttribute('aria-label'), /Rigoberta/);
    await page.reload(); await desk('s_p').waitFor();
    assert.equal(await desk('s_p').getAttribute('data-name'), 'Rigoberta');
    await desk('s_p').click();
    await page.getByTestId('persona-box').locator('summary').click();
    await page.getByTestId('persona-reset').click();
    for (let i = 0; i < 40; i++) { g = await s.getFlow(f.id); if (!g.steps[0].persona) break; await sleep(150); }
    assert.equal(g.steps[0].persona, undefined);
    assert.equal(await desk('s_p').getAttribute('data-name'), 'Lucía');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

// ---- first adversarial pass on spec 29 ----
test('revisión 29: recargar durante una ejecución con la red lenta no repite pasos; cambiar de flujo cierra la jornada', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina H', [role('Análisis', '[[mock:hold 2]] [[mock:say ok]]', { id: 's_a' }), cmd('Corre', 'Write-Output 1', { id: 's_b' }), role('Revisión', '[[mock:tool Read docs/x.md]] [[mock:hold 8]] [[mock:say ok]]', { id: 's_c' })], [['s_a', 's_b'], ['s_b', 's_c']]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`); await page.getByTestId('office').waitFor();
    await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await page.locator('[data-testid="office-desk"][data-step="s_a"][data-status="running"]').waitFor({ timeout: 15000 });
    await page.addInitScript(() => { const of = window.fetch; window.fetch = async (u, o) => { if (/\/api\/flows\/[^/]+\/runs\/r_[^/?]+$/.test(String(u))) await new Promise((r) => setTimeout(r, 3000)); return of(u, o); }; });
    await page.reload(); await page.getByTestId('office').waitFor();
    await page.locator('[data-testid="office-walker"][data-step="s_c"][data-activity="reading"]').waitFor({ timeout: 25000 });
    const lines = (await page.getByTestId('office-log-text').textContent()).split('\n').filter(Boolean);
    assert.deepEqual(lines.filter((l, i) => lines.indexOf(l) !== i), [], 'sin líneas repetidas');
    // switching flows while replaying: the new office starts live
    const g = await s.flow('Oficina I', [role('Otro', 'x', { id: 's_o' })]);
    const r = await s.runUi(g.id);
    await page.goto(`${s.base}/?flow=${g.id}&view=office`); await page.getByTestId('office').waitFor();
    await page.getByTestId('office-replay-btn').click();
    await page.getByTestId('office-replay-speed').selectOption('1');
    await page.getByTestId('office-replay-run').selectOption(r.id);
    await page.locator('[data-testid="office"][data-mode="replay"]').waitFor();
    await page.locator('header select').first().selectOption(f.id);
    await page.locator(`[data-testid="office-desk"][data-step="s_a"]`).waitFor();
    assert.equal(await page.getByTestId('office').getAttribute('data-mode'), 'live');
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});

test('cámara: girar la oficina (4 ángulos) y el zoom (botones, rueda del mouse, ajustar); los clics siguen andando girada; la recepción está adelante', async (t) => {
  if (skip(t)) return;
  try {
    const f = await s.flow('Oficina J', [role('Uno', 'x', { id: 's_1' }), role('Dos', 'x', { id: 's_2' })], [['s_1', 's_2']]);
    await page.goto(`${s.base}/?flow=${f.id}&view=office`);
    await page.getByTestId('office').waitFor();
    const off = page.getByTestId('office');
    const rot0 = Number(await off.getAttribute('data-rot'));
    await page.getByTestId('office-rotate-right').click();
    assert.equal(Number(await off.getAttribute('data-rot')), (rot0 + 1) % 4);
    await desk('s_2').focus(); await page.keyboard.press('Enter'); // girada, algo puede quedar delante: el teclado siempre llega
    assert.equal(await page.locator('.title-input').inputValue(), 'Dos', 'girada, un escritorio abre su step');
    await page.getByTestId('office-rotate-left').click(); await page.getByTestId('office-rotate-left').click();
    assert.equal(Number(await off.getAttribute('data-rot')), (rot0 + 3) % 4);
    await page.getByTestId('office-rotate-right').click();
    await page.getByTestId('office-zoom-fit').click();
    assert.equal(Number(await off.getAttribute('data-zoom')), 1);
    await page.getByTestId('office-zoom-in').click();
    assert.ok(Number(await off.getAttribute('data-zoom')) > 1);
    const box = await page.locator('.office-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const z0 = Number(await off.getAttribute('data-zoom'));
    await page.mouse.wheel(0, -300);
    await page.waitForFunction((z) => Number(document.querySelector('[data-testid="office"]').dataset.zoom) > z, z0);
    await page.getByTestId('office-zoom-fit').click();
    // the reception (counter + coordinator) is in the front corner: lower on screen than every desk
    await page.evaluate(() => { try { localStorage.setItem('afs.office.rot', '0'); } catch {} }); await page.reload(); await page.getByTestId('office').waitFor();
    const counterY = (await page.getByTestId('office-window').boundingBox()).y;
    for (const id of ['s_1', 's_2']) assert.ok(counterY > (await desk(id).boundingBox()).y, 'la recepción se ve adelante');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { ...t, passed: false, name: t.name }); throw e; }
});
