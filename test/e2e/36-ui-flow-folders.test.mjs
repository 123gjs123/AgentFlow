// Spec 09 in the browser: the flow selector shows linked flows apart (🔗, folder, unavailable), 📂 reveals the folder,
// the 🔗 dialog links a folder and moves a flow, and a linked flow changed outside the app shows its review banner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cmd, role, sleep } from './helpers/harness.mjs';

const writeDef = (dir, def) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify({ format: 'agent-flow-studio/flow', formatVersion: 1, ...def }, null, 2)); };

test('UI: vincular una carpeta desde 🔗, verla agrupada en el selector, 📂, cambio externo → banner de revisión, carpeta desenchufada → (no disponible), mover un flujo', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('folders-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const local = await u.flow('Local UI', [role('R', '[[mock:say ok]]', { id: 's_r', position: { x: 100, y: 100 } })]);
    const repo = path.join(u.tmp, 'repo-ui', 'flujo');
    writeDef(repo, { id: 'f_uilink', name: 'Del repo', steps: [role('Saluda', '[[mock:say hola]]', { id: 's_s', position: { x: 100, y: 100 } })], edges: [] });
    await page.goto(`${u.base}/?flow=${local.id}`);
    await page.getByTestId('folder-btn').click();
    await page.getByTestId('link-path').fill(repo);
    await page.getByTestId('link-btn').click();
    await page.getByTestId('link-msg').getByText(/Vinculado: “Del repo”/).waitFor();
    const sel = page.locator('header.topbar select').first();
    assert.equal(await sel.inputValue(), 'f_uilink', 'abre el flujo vinculado');
    assert.equal(await sel.locator('optgroup[label="Vinculados (carpetas)"] option').count(), 1);
    assert.match(await sel.locator('optgroup[label="Vinculados (carpetas)"] option').first().textContent(), /🔗.*Del repo · flujo/);
    await page.getByTestId('flow-location').getByText(/Vinculado/).waitFor();
    await page.keyboard.press('Escape');
    if (await page.locator('.modal-back').count()) await page.locator('.modal-back').first().click({ position: { x: 5, y: 5 } });
    // 📂 → Abrir carpeta (AFS_REVEAL=0 in tests: it says the path instead of opening Explorer)
    await page.getByTestId('folder-btn').click();
    await page.getByTestId('reveal-btn').click();
    await page.getByTestId('link-msg').getByText(/Carpeta: .*flujo/).waitFor();
    await page.keyboard.press('Escape');
    if (await page.locator('.modal-back').count()) await page.locator('.modal-back').first().click({ position: { x: 5, y: 5 } });
    // changed outside the app: a command → review banner
    const d = JSON.parse(fs.readFileSync(path.join(repo, 'flow.json'), 'utf8'));
    d.steps.push(cmd('Nuevo', 'Write-Output x', { id: 's_n', position: { x: 300, y: 100 } }));
    fs.writeFileSync(path.join(repo, 'flow.json'), JSON.stringify(d, null, 2));
    await page.getByTestId('quarantine').getByText(/Flujo vinculado en revisión/).waitFor({ timeout: 20000 });
    // unplugged → listed as unavailable
    fs.renameSync(repo, `${repo}-fuera`);
    await page.goto(`${u.base}/?flow=${local.id}`);
    await page.waitForFunction(() => [...document.querySelectorAll('header.topbar select option')].some((o) => /no disponible/.test(o.textContent) && o.disabled), null, { timeout: 20000 });
    fs.renameSync(`${repo}-fuera`, repo);
    // move the local flow to a folder
    const target = path.join(u.tmp, 'repo-ui', 'otro'); fs.mkdirSync(target, { recursive: true });
    await page.getByTestId('folder-btn').click();
    await page.getByTestId('link-path').fill(target);
    await page.getByTestId('move-btn').click();
    await page.getByTestId('link-msg').getByText(/Ahora vive en/).waitFor();
    assert.ok(fs.existsSync(path.join(target, 'flow.json')));
    let item; for (let i = 0; i < 40; i++) { item = (await u.uiOk('GET', '/api/flows')).find((f) => f.id === local.id); if (item?.origin === 'linked') break; await sleep(150); }
    assert.equal(item.origin, 'linked');
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});
