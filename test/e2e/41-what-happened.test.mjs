// «Qué pasó»: when a step fails, the panel says why in one sentence, offers the fix as a button that fits the problem
// (a read in one click; something that writes with a confirmation; a whole shell never; the connector's real name) and
// the retry. Skipped steps name the step that really failed (the root, not the skipped one before). The log is folded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'what-happened' }); await s.start(); });
after(async () => { await s?.stop(); });

const chain = (task, tools) => [
  role('Busca', task, { id: 's_a', allowedTools: tools }),
  role('Arma', '[[mock:say armado]]', { id: 's_b' }),
  role('Cierra', '[[mock:say cerrado]]', { id: 's_c' }),
];

test('lo guardado: las herramientas denegadas, una por nombre (Bash por comando), y la causa raíz en cada omitido', async () => {
  const f = await s.flow('Raíz', chain('[[mock:deny mcp__jira__searchIssues]] [[mock:deny-cmd git status]] [[mock:deny-cmd rm -rf build]] [[mock:say hecho]]', 'Read'), [['s_a', 's_b'], ['s_b', 's_c']]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_a.code, 'PERMISSION_DENIED');
  const g = await s.getFlow(f.id);
  const a = g.steps.find((x) => x.id === 's_a').lastRun;
  assert.deepEqual(a.denied.map((d) => d.tool).sort(), ['Bash', 'Bash(git status:*)', 'mcp__jira__searchIssues'], 'cada comando por separado: git status sugiere su patrón, rm -rf no');
  assert.ok(a.denied.some((d) => /git status/.test(d.input)));
  const c = g.steps.find((x) => x.id === 's_c').lastRun;
  assert.equal(c.skipReason, 'upstream_failed');
  assert.equal(c.blockedBy, 's_a', 'el último de la cadena nombra al que falló, no al omitido de antes');
  assert.match(run.steps.s_c.events[0].text, /falló "Busca"/);
  // a later good run clears it
  const ok = await s.getFlow(f.id);
  ok.steps[0].task = '[[mock:say hecho]]';
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...ok, baseRev: ok.rev || 0 });
  await s.runUi(f.id);
  const h = await s.getFlow(f.id);
  assert.equal(h.steps[0].lastRun.denied, undefined); assert.equal(h.steps[2].lastRun.blockedBy, undefined);
});

test('clasificación (servidor): lo que parece lectura pero escribe pide confirmación; intérpretes y comandos que escriben, nunca', async () => {
  const f = await s.flow('Ataques', [role('X', '[[mock:deny mcp__jira__getAndDelete]] [[mock:deny-cmd node -e 1]] [[mock:deny-cmd git "push" origin]] [[mock:deny-cmd git -c a=b status]] [[mock:deny-cmd powershell -c dir]] [[mock:deny-cmd git log]] [[mock:say x]]', { id: 's_x', allowedTools: 'Read' })]);
  await s.runUi(f.id);
  const d = (await s.getFlow(f.id)).steps[0].lastRun.denied;
  const by = (t) => d.filter((x) => x.tool === t).map((x) => x.kind);
  assert.deepEqual(by('mcp__jira__getAndDelete'), ['confirm'], 'get…Delete no es lectura');
  assert.deepEqual(by('Bash').sort(), ['blocked', 'blocked', 'blocked', 'blocked'], 'node -e, git "push", git -c, powershell -c: bloqueados');
  assert.deepEqual(by('Bash(git log:*)'), ['confirm'], 'git log: patrón con confirmación');
  assert.ok(!d.some((x) => x.kind === 'read'));
});

test('UI: la tarjeta en cualquier pestaña; leer en un clic, escribir con confirmación, Bash entero nunca; log plegado; reintentar', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('what-happened-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Qué pasó UI', chain('[[mock:deny mcp__jira__searchIssues]] [[mock:deny-cmd git status]] [[mock:deny-cmd rm -rf build]] [[mock:say hecho]]', 'Read Grep'), [['s_a', 's_b'], ['s_b', 's_c']], { finally: { command: 'Write-Output fin', shell: 'powershell' } });
    await u.runUi(f.id);
    await page.goto(`${u.base}/?flow=${f.id}`);
    const node = (name) => page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: new RegExp(`^${name}$`) }) });
    await node('Cierra').getByTestId('node-blocked').getByText(/falló «Busca»/).waitFor(); // la caja omitida dice por qué
    await node('Cierra').click();
    const card = page.getByTestId('what-happened');
    await card.getByText(/No corrió porque falló «Busca»/).waitFor();
    await card.getByTestId('wh-go-root').click();
    await page.locator('.panel-head .title-input[value="Busca"]').waitFor();
    // Actividad: the card is there too; the log is folded
    await page.locator('.tabs button', { hasText: 'Actividad' }).click();
    await card.getByText(/necesitó herramientas que no tiene permitidas/).waitFor();
    assert.equal(await page.getByTestId('run-log').getAttribute('open'), null, 'el log está plegado');
    assert.equal(await card.getByTestId('wh-allow-write').count(), 1, 'git status: con confirmación');
    assert.match(await card.innerText(), /no se habilita con un clic \(\s*rm -rf build\s*\)/, 'rm -rf: nunca con un clic');
    await card.getByText(/También corre «Al terminar»/).waitFor();
    await card.getByTestId('wh-allow-read').click();
    ui.answers?.push?.(true);
    await card.getByTestId('wh-allow-write').click();
    const deadline = Date.now() + 10000; let tools = '';
    while (Date.now() < deadline) { tools = (await u.getFlow(f.id)).steps[0].allowedTools; if (tools.includes('Bash(git status:*)')) break; await new Promise((r) => setTimeout(r, 200)); }
    const list = tools.match(/[^\s,()]+(?:\([^)]*\))?/g); // the same tokens the UI reads (a pattern keeps its spaces)
    assert.ok(['Read', 'Grep', 'mcp__jira__searchIssues', 'Bash(git status:*)'].every((x) => list.includes(x)), tools);
    assert.ok(!list.includes('Bash'), 'nunca Bash entero');
    assert.ok(!list.some((x) => /rm /.test(x)), 'rm nunca');
    // the denied rm -rf is still there: not "fixed", but the retry is offered
    assert.equal(await card.getByText('✓ Ya está corregido').count(), 0);
    await card.getByTestId('wh-retry').waitFor();
    assert.match(await card.getByTestId('wh-retry').innerText(), /Reintentar desde aquí/);
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});

test('UI: el conector con otro nombre en el CLI se corrige con un clic; cubierto por el servidor entero = corregido', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('what-happened-rename');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Renombre', [role('Lee', '[[mock:mcp claude.ai Atlassian MCP=connected]] [[mock:deny mcp__claude_ai_Atlassian_MCP__getJiraIssue]] [[mock:say x]]', { id: 's_r', allowedTools: 'Read mcp__claude_ai_Atlassian_Rovo__getJiraIssue mcp__claude_ai_Atlassian_Rovo__createJiraIssue' })]);
    await u.runUi(f.id);
    await page.goto(`${u.base}/?flow=${f.id}`);
    await page.locator('.react-flow__node').first().click();
    const card = page.getByTestId('what-happened');
    await card.getByTestId('wh-rename').click();
    await card.getByText('✓ Ya está corregido: falta reintentar.').waitFor();
    let tools = []; const dl = Date.now() + 10000;
    while (Date.now() < dl) { tools = (await u.getFlow(f.id)).steps[0].allowedTools.split(' ').sort(); if (!tools.some((x) => x.includes('Rovo'))) break; await new Promise((r) => setTimeout(r, 200)); }
    assert.deepEqual(tools, ['Read', 'mcp__claude_ai_Atlassian_MCP__createJiraIssue', 'mcp__claude_ai_Atlassian_MCP__getJiraIssue']);
    assert.match(await card.getByTestId('wh-retry').innerText(), /Reintentar este paso/, 'sin pasos después: solo este');
    // the whole server also covers it
    const g = await u.getFlow(f.id); g.steps[0].allowedTools = 'Read mcp__claude_ai_Atlassian_MCP';
    await u.uiOk('PUT', `/api/flows/${f.id}`, { ...g, baseRev: g.rev || 0 });
    await page.reload(); await page.locator('.react-flow__node').first().click();
    await page.getByTestId('what-happened').getByText('✓ Ya está corregido').waitFor();
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});
