// D59 (UI): 🎫 Tickets shows each ticket the flow touched with its counts; selecting it shows what the steps raised,
// grouped by class, with the person's actions (Llevar al ticket / Descartar / Reabrir) and its log. 🧾 Registro lists
// everything newest first with filters and the path of journal.jsonl. The step panel shows «Lo que levantó este paso».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { role } from './helpers/harness.mjs';

const FINALLY = [
  '$q = $env:AFS_QUESTIONS_JSON | ConvertFrom-Json',
  'foreach ($x in $q) { if ($x.id) { Write-Output ("AFS-PUBLISHED " + $env:AFS_PUBLISH_NONCE + " " + $x.id + " C-1") } }',
].join('\n');
const INPUT = 'SBK-1: El trader asignado puede editar el juego desde Edit Game.';

test('UI: Tickets (conteos, ítems, llevar al ticket, descartar, reabrir), Registro con filtros y lo que levantó el paso', async (t) => {
  const { openUi, captureOnFailure } = await import('./helpers/browser.mjs');
  const ui = await openUi('tickets-registro-ui');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-tickets-ui-'));
  let page;
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u } = ui; page = ui.page;
    const reply = path.join(dir, 'reply.txt').replace(/\\/g, '/');
    fs.writeFileSync(reply, [
      'Análisis listo.',
      '<raise>{"kind":"question","item":"SBK-1","for":"PO","text":"¿El trader asignado también puede editar juegos en vivo?","quote":"El trader asignado puede editar el juego","blocks":"criterio 2"}</raise>',
      '<raise>{"kind":"question","item":"SBK-1","for":"Dev","text":"¿Qué pasa con los usuarios sin rol?"}</raise>',
      '<raise>{"kind":"blocker","item":"SBK-1","text":"El binario de Cypress no arranca, hay que reinstalarlo"}</raise>',
      '<raise>{"kind":"check","item":"SBK-9","text":"El bug SBK-9 sigue In Progress aunque el retest pasó"}</raise>',
      '<raise>{"kind":"lesson","text":"La skill debería listar los casos de borde"}</raise>',
    ].join('\n'));
    const f = await u.flow('Tickets UI', [role('Analiza', `[[mock:say-file ${reply}]]`, { id: 's_an' })], [], { finally: { command: FINALLY, shell: 'powershell' } });
    const run = await u.runUi(f.id, INPUT);
    assert.equal(run.status, 'success');
    const items = await u.uiOk('GET', `/api/flows/${f.id}/items`);
    const by = (re) => items.find((x) => re.test(x.text));
    const pub = by(/en vivo/); const rev = by(/sin rol/); const blk = by(/Cypress/);
    assert.equal(rev.state, 'review'); assert.equal(blk.kind, 'blocker');

    await page.goto(`${u.base}/?flow=${f.id}`);
    // --- 🎫 Tickets
    await page.getByTestId('flow-tab-tickets').click();
    const row = page.getByTestId('ticket-row-SBK-1');
    await row.waitFor();
    const n = async (id) => (await row.getByTestId(id).innerText()).trim();
    assert.deepEqual([await n('tk-q-open'), await n('tk-q-review'), await n('tk-q-published'), await n('tk-blockers')], ['1', '1', '1', '1']);
    assert.match(await row.getByTestId('ticket-last-run').innerText(), /bien/);
    await page.getByTestId('ticket-row-SBK-9').waitFor();
    await page.getByTestId('ticket-row-none').waitFor(); // the lesson does not name a ticket
    await row.click();
    const detail = page.getByTestId('ticket-detail');
    await detail.getByTestId('tk-group-question').waitFor();
    assert.match(await detail.getByTestId('tk-group-question').innerText(), /Duda del ticket \(2\)/);
    assert.match(await detail.getByTestId('tk-group-blocker').innerText(), /Problema del flujo/);
    const pubCard = detail.getByTestId(`item-${pub.id}`);
    assert.match(await pubCard.getByTestId('item-published').innerText(), /publicada \(C-1\)/);
    assert.match(await pubCard.getByTestId('item-quote').innerText(), /El trader asignado puede editar el juego/);
    assert.equal(await pubCard.getByTestId('item-promote').count(), 0, 'abierta: no se promueve');
    // the ticket's log
    await detail.getByTestId('ticket-journal').getByTestId('journal-entry').first().waitFor();
    assert.match(await detail.getByTestId('ticket-journal').innerText(), /Levantó duda del ticket/);

    // «Llevar al ticket»: review → open
    const revCard = detail.getByTestId(`item-${rev.id}`);
    assert.equal((await revCard.getByTestId('item-state').innerText()).trim(), 'a revisar');
    await revCard.getByTestId('item-promote').click();
    await revCard.getByTestId('item-state').getByText('abierto').waitFor();
    assert.equal((await u.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === rev.id).state, 'open');
    await row.getByTestId('tk-q-review').getByText('0').waitFor();

    // «Descartar» asks why; «Reabrir» brings it back
    const blkCard = detail.getByTestId(`item-${blk.id}`);
    ui.answers.push('no aplica');
    await blkCard.getByTestId('item-dismiss').click();
    await blkCard.getByTestId('item-reopen').waitFor();
    const d1 = (await u.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === blk.id);
    assert.equal(d1.state, 'dismissed'); assert.equal(d1.reason, 'no aplica');
    assert.match(await blkCard.getByTestId('item-reason').innerText(), /no aplica/);
    await blkCard.getByTestId('item-reopen').click();
    await blkCard.getByTestId('item-dismiss').waitFor();
    assert.equal((await u.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === blk.id).state, 'open');

    // --- 🧾 Registro
    await page.getByTestId('flow-tab-journal').click();
    const jv = page.getByTestId('journal-view');
    await jv.getByTestId('journal-entry').first().waitFor();
    const all = await u.uiOk('GET', `/api/flows/${f.id}/journal`);
    assert.equal(await jv.getByTestId('journal-entry').count(), all.entries.length);
    assert.equal(await jv.getByTestId('journal-entry').first().getAttribute('data-type'), all.entries[0].type, 'lo más nuevo primero');
    assert.equal((await jv.getByTestId('journal-file').innerText()).trim(), all.file);
    assert.equal(await jv.getByTestId('journal-download').getAttribute('href'), `/api/flows/${f.id}/journal.jsonl`);
    assert.match(await jv.innerText(), /Cambiaste problema del flujo/);
    await jv.getByTestId('journal-filter-ticket').selectOption('SBK-9');
    const only9 = (await u.uiOk('GET', `/api/flows/${f.id}/journal?ticket=SBK-9`)).entries.length;
    const dl = Date.now() + 10000;
    while (Date.now() < dl && await jv.getByTestId('journal-entry').count() !== only9) await new Promise((r) => setTimeout(r, 150));
    assert.equal(await jv.getByTestId('journal-entry').count(), only9);
    assert.match(await jv.getByTestId('journal-list').innerText(), /SBK-9 sigue In Progress/);
    await jv.getByTestId('journal-filter-type').selectOption('run');
    await jv.getByTestId('journal-empty').waitFor(); // the run's input names SBK-1, not SBK-9

    // a ticket's last run opens in Ejecuciones
    await page.getByTestId('flow-tab-tickets').click();
    await page.getByTestId('ticket-row-SBK-1').getByTestId('ticket-last-run').click();
    await page.locator('h4', { hasText: run.id }).waitFor();

    // --- step panel: «Lo que levantó este paso», also when the step went well
    await page.locator('.react-flow__node').first().click();
    const raised = page.getByTestId('raised-items');
    await raised.waitFor();
    assert.equal(await page.getByTestId('what-happened').count(), 0, 'salió bien: no hay «Qué pasó»');
    const txt = await raised.innerText();
    for (const w of ['Duda del ticket', 'Problema del flujo', 'Control de cierre', 'Aprendizaje', 'sin rol']) assert.ok(txt.includes(w), `${w} en ${txt}`);
    await raised.getByTestId(`raised-${pub.id}`).getByTestId('raised-goes').waitFor();
    await raised.getByTestId(`raised-${rev.id}`).getByTestId('raised-review').waitFor();
    assert.match(await raised.getByTestId(`raised-${rev.id}`).innerText(), /Sin cita del ticket/, 'las notas se ven');
    await raised.getByTestId('raised-open-tickets').click();
    await page.getByTestId('tickets-view').waitFor();
    assert.deepEqual(page.errors, []);
  } finally {
    if (page) await captureOnFailure(page, t);
    await ui.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
