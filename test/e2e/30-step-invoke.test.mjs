// Spec 12: every step is callable from outside (CI, scripts, schedulers, webhooks, Claude Code): a stable slug, the
// endpoint POST /api/ext/flows/:flow/steps/:step/run with scope only | from, `afs run --step --from`, the MCP `from`,
// an Invoke tab with copy-ready snippets (no token inside) and the flow's INVOKE.md kept up to date.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'invoke' }); await s.start(); });
after(async () => { await s?.stop(); });
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };
// A → B → C; B reads {{vars.build}} and its upstream; C fails when vars.fail = 1
const chain = (name) => s.flow(name, [
  cmd('Preparar', 'Write-Output "prep-$(Get-Random)"', { id: 's_a' }),
  cmd('Correr sanity (PPD)', 'Write-Output "sanity {{vars.build}} <- $env:STEP_UPSTREAM"', { id: 's_b' }),
  cmd('Informe', 'if ("{{vars.fail}}" -eq "1") { exit 3 }; Write-Output "informe ok"', { id: 's_c' }),
], [['s_a', 's_b'], ['s_b', 's_c']], { vars: { build: '0', fail: '0' } });

test('slug estable por step: derivado del nombre, único, no cambia al renombrar, editable y validado; por nombre repetido es ambiguo', async () => {
  const f = await s.flow('Slugs', [cmd('Correr sanity (PPD)', 'Write-Output 1', { id: 's_1' }), cmd('Otro', 'Write-Output 2', { id: 's_2' }), cmd('Otro', 'Write-Output 3', { id: 's_3' })], []);
  let g = await s.getFlow(f.id);
  assert.deepEqual(g.steps.map((x) => x.slug), ['correr-sanity-ppd', 'otro', 'otro-2']);
  g.steps[0].name = 'Sanity renombrado';
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  assert.equal(g.steps[0].slug, 'correr-sanity-ppd', 'renombrar no rompe a quien ya lo llama');
  // edited through its own endpoint; a flow save never moves it
  assert.equal((await s.uiOk('PUT', `/api/flows/${f.id}/steps/s_1/slug`, { slug: 'Mi Paso' })).slug, 'mi-paso');
  assert.equal((await s.ui('PUT', `/api/flows/${f.id}/steps/s_2/slug`, { slug: 'mi-paso' })).body.code, 'STEP_SLUG_TAKEN');
  assert.equal((await s.ui('PUT', `/api/flows/${f.id}/steps/s_2/slug`, { slug: '¡¡!!' })).body.code, 'BAD_SLUG');
  g = await s.getFlow(f.id);
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: g.steps.map((x, i) => (i === 1 ? { ...x, slug: 'mi-paso' } : i === 0 ? { ...x, slug: undefined } : x)) });
  assert.deepEqual(g.steps.map((x) => x.slug), ['mi-paso', 'otro', 'otro-2'], 'guardar el flujo (otra pestaña, deshacer, cliente viejo) no cambia slugs');
  const list = (await s.ext('GET', '/flows')).body.find((x) => x.id === f.id);
  assert.deepEqual(list.steps.map((x) => x.slug), ['mi-paso', 'otro', 'otro-2']);
  const amb = await s.ext('POST', `/flows/${f.id}/steps/Otro/run`, { wait: true });
  assert.equal(amb.status, 409); assert.equal(amb.body.code, 'STEP_AMBIGUOUS');
  const bySlug = await s.ext('POST', `/flows/${f.id}/steps/otro-2/run`, { wait: true, timeoutSec: 60 });
  assert.equal(bySlug.body.status, 'success'); assert.match(bySlug.body.result, /3/);
  assert.equal((await s.ext('POST', `/flows/${f.id}/steps/nada/run`, {})).body.code, 'STEP_NOT_FOUND');
});

test('POST …/steps/:step/run: solo ese step o "desde" ese step (los anteriores no se re-ejecutan); falla como un stage de CI; trigger del source', async () => {
  const f = await chain('Release check');
  // nothing ran yet: "from" cannot start (and the dry run says why)
  const dry = await s.ext('POST', `/flows/release-check/steps/correr-sanity-ppd/run`, { scope: 'from', dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.ok, false); assert.deepEqual(dry.body.fromProblem.missing, ['Preparar']); assert.deepEqual(dry.body.steps, ['Correr sanity (PPD)', 'Informe']);
  const miss = await s.ext('POST', `/flows/${f.id}/steps/correr-sanity-ppd/run`, { scope: 'from', wait: true });
  assert.equal(miss.status, 409); assert.equal(miss.body.code, 'FROM_UPSTREAM_MISSING');
  const full = await s.runExt(f.id, { input: 'x' });
  assert.equal(full.body.status, 'success');
  const prepOut = full.body.steps.find((x) => x.stepId === 's_a').output;
  // only
  const only = await s.ext('POST', `/flows/${f.id}/steps/correr-sanity-ppd/run`, { vars: { build: '42' }, wait: true, timeoutSec: 60, source: 'jenkins' });
  assert.equal(only.body.status, 'success');
  assert.equal(only.body.scope, 'only'); assert.equal(only.body.trigger, 'jenkins');
  assert.deepEqual(only.body.steps.map((x) => x.stepId), ['s_b']);
  assert.match(only.body.result, /sanity 42/);
  // from: B and C run, A keeps its last output (passed on, not re-run)
  const from = await s.ext('POST', `/flows/${f.id}/steps/s_b/run`, { mode: 'from', vars: { build: '43' }, wait: true, timeoutSec: 60, source: 'jenkins' });
  assert.equal(from.body.status, 'success', JSON.stringify(from.body));
  assert.equal(from.body.scope, 'from'); assert.equal(from.body.scopeStep, 'Correr sanity (PPD)');
  assert.deepEqual(from.body.steps.map((x) => x.stepId).sort(), ['s_b', 's_c']);
  assert.match(from.body.result, /informe ok/, 'el resultado es el del final de la cadena');
  assert.ok(from.body.steps.find((x) => x.stepId === 's_b').output.includes(prepOut.trim()), 'B recibió la última salida de A');
  const runs = await s.uiOk('GET', `/api/flows/${f.id}/runs`);
  assert.equal(runs.find((r) => r.id === from.body.runId).from, 's_b');
  // the same through /run with step + scope
  const viaRun = await s.ext('POST', `/flows/${f.id}/run`, { step: 'Correr sanity (PPD)', scope: 'from', wait: true, timeoutSec: 60 });
  assert.equal(viaRun.body.scope, 'from');
  // a failing step fails the call (a Jenkins stage reads .status)
  const bad = await s.ext('POST', `/flows/${f.id}/steps/s_b/run`, { scope: 'from', vars: { fail: '1' }, wait: true, timeoutSec: 60 });
  assert.equal(bad.body.status, 'error');
  assert.equal((await s.ext('POST', `/flows/${f.id}/steps/s_b/run?scope=todo`, {})).body.code, 'BAD_SCOPE', 'en la URL es una opción y se valida');
  assert.equal((await s.ext('POST', `/flows/${f.id}/run?scope=from`, {})).body.code, 'STEP_REQUIRED', 'en la URL sí es una opción');
});

test('pestaña Invocar: contrato del step, snippets con host/puerto/flujo/slug reales y SIN token; el de PowerShell funciona pegado; aviso de red; INVOKE.md al día', async () => {
  const f = await chain('Snippets');
  await s.runExt(f.id, { input: 'x' });
  const inv = await s.uiOk('GET', `/api/flows/${f.id}/steps/s_b/invoke`);
  assert.equal(inv.slug, 'correr-sanity-ppd');
  assert.equal(inv.endpoint.path, `/api/ext/flows/${f.id}/steps/correr-sanity-ppd/run`);
  assert.deepEqual(inv.contract.vars.map((v) => v.name), ['build']);
  assert.deepEqual(inv.contract.upstream, ['Preparar']);
  assert.deepEqual(inv.snippets.map((x) => x.id), ['curl', 'curl-async', 'powershell', 'jenkins-sh', 'jenkins-ps', 'afs', 'mcp', 'webhook']);
  assert.ok(!JSON.stringify(inv).includes(s.token), 'el token nunca va en los snippets');
  assert.match(inv.snippets.find((x) => x.id === 'powershell').content, new RegExp(`127\\.0\\.0\\.1:${s.port}`));
  assert.match(inv.snippets.find((x) => x.id === 'jenkins-sh').content, /credentials|withCredentials/);
  assert.equal(inv.reach.status, 'needs-host', 'la app escucha solo en esta PC: avisa');
  const from = await s.uiOk('GET', `/api/flows/${f.id}/steps/correr-sanity-ppd/invoke?scope=from`);
  assert.deepEqual(from.contract.steps, ['Correr sanity (PPD)', 'Informe']);
  assert.match(from.snippets.find((x) => x.id === 'curl').content, /"scope":"from"/);
  assert.match(from.snippets.find((x) => x.id === 'afs').content, /--from/);
  // the PowerShell snippet, pasted as is (only the placeholders filled), runs the steps and fails when they fail
  const ps = from.snippets.find((x) => x.id === 'powershell').content.replace('<build>', '77');
  const ok = await s.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { AFS_TOKEN: s.token } });
  assert.equal(ok.code, 0, ok.stderr); assert.match(ok.stdout, /informe ok/);
  const failing = ps.replace('"source":"powershell"', '"source":"powershell","vars":{"fail":"1"}').replace('"vars":{"build":"77"},', '');
  const ko = await s.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', failing], { env: { AFS_TOKEN: s.token } });
  assert.notEqual(ko.code, 0, 'falla si el step falla');
  // INVOKE.md: every step, regenerated when a step is added or renamed
  const md = await s.ui('GET', `/api/flows/${f.id}/invoke.md`);
  assert.equal(md.status, 200);
  for (const n of ['Preparar', 'Correr sanity (PPD)', 'Informe']) assert.match(md.body, new RegExp(`### ${n.replace(/[()]/g, '\\$&')}`));
  assert.ok(!md.body.includes(s.token));
  const g = await s.getFlow(f.id);
  g.steps.push(cmd('Nuevo paso', 'Write-Output n', { id: 's_n' })); g.steps[0].name = 'Preparar todo';
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const file = s.flowFile(f.id, 'INVOKE.md');
  const doc = await until(() => fs.existsSync(file) && /### Nuevo paso/.test(fs.readFileSync(file, 'utf8')) && /### Preparar todo/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(doc, 'data/invoke/<flujo>.md se actualizó');
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  await until(() => !fs.existsSync(file), 3000);
  assert.ok(!fs.existsSync(file), 'se borra con el flujo');
});

test('afs run --step --from y el MCP run_flow con from', async () => {
  const f = await chain('CLI desde');
  await s.runExt(f.id, { input: 'x' });
  const r = await s.afs(['run', 'CLI desde', '--step', 'correr-sanity-ppd', '--from', '--var', 'build=9', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.scope, 'from'); assert.deepEqual(j.steps.map((x) => x.stepId).sort(), ['s_b', 's_c']);
  assert.equal((await s.afs(['run', 'CLI desde', '--from'])).code, 2, '--from sin --step');
  const m = s.mcp();
  try {
    await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    m.notify('notifications/initialized', {});
    const res = (await m.request('tools/call', { name: 'run_flow', arguments: { flow: 'CLI desde', step: 'correr-sanity-ppd', from: true, input: 'x' } })).result;
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.scope, 'from');
  } finally { m.close(); }
});

test('UI: pestaña 🔌 Invocar del step: contrato, snippets, alcance y slug editable', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('invoke-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Invocar UI', [cmd('Correr sanity', 'Write-Output "{{vars.build}}"', { id: 's_i', position: { x: 120, y: 120 } })], []);
    await page.goto(`${u.base}/?flow=${f.id}`);
    await page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Correr sanity' }) }).click();
    await page.locator('.tabs button', { hasText: 'Invocar' }).click();
    const box = page.getByTestId('step-invoke');
    await box.getByTestId('invoke-contract').getByText('build').waitFor();
    await box.getByTestId('invoke-reach').waitFor();
    await box.getByTestId('invoke-tabs').getByRole('button', { name: 'PowerShell' }).click();
    await box.getByTestId('invoke-snippet').getByText(/steps\/correr-sanity\/run/).waitFor();
    await box.getByTestId('invoke-scope').getByRole('button', { name: 'Este y los que siguen' }).click();
    await box.getByTestId('invoke-snippet').getByText(/"scope":"from"/).waitFor();
    await box.getByTestId('invoke-slug').fill('sanity-ppd');
    await box.getByTestId('invoke-slug').press('Enter');
    let g;
    for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.steps[0].slug === 'sanity-ppd') break; await sleep(150); }
    assert.equal(g.steps[0].slug, 'sanity-ppd');
    await box.getByTestId('invoke-snippet').getByText(/steps\/sanity-ppd\/run/).waitFor();
  } finally { await ui.close?.(); }
});

// ---- regressions of the architect + adversarial reviews of spec 12 ----
test('revisión 12: un slug nunca es el id de otro step; un nombre de otro step no se confunde con un slug; duplicar y restaurar no mueven slugs', async () => {
  const f = await s.flow('Ids y slugs', [cmd('Primero', 'Write-Output I-AM-PRIMERO', { id: 'informe' }), cmd('Informe', 'Write-Output I-AM-INFORME', { id: 's_x2' })], []);
  let g = await s.getFlow(f.id);
  assert.notEqual(g.steps[1].slug, 'informe', 'el slug de «Informe» no puede ser el id de «Primero»');
  const inv = await s.uiOk('GET', `/api/flows/${f.id}/steps/s_x2/invoke`);
  const r = await s.ext('POST', inv.endpoint.path.replace('/api/ext', ''), { wait: true, timeoutSec: 60 });
  assert.match(r.body.result, /I-AM-INFORME/, 'el snippet de un step ejecuta ESE step');
  // renamed "Deploy" (slug deploy) + a new "Deploy": "deploy" is ambiguous, not the old one silently
  const d = await s.flow('Renombrado', [cmd('Deploy', 'Write-Output OLD', { id: 's_d1' })], []);
  g = await s.getFlow(d.id); g.steps[0].name = 'Prep'; g.steps.push(cmd('Deploy', 'Write-Output NEW', { id: 's_d2' }));
  g = await s.uiOk('PUT', `/api/flows/${d.id}`, g);
  assert.match((await s.ext('POST', `/flows/${d.id}/steps/deploy/run`, { wait: true, timeoutSec: 60 })).body.result, /OLD/, 'el slug guardado sigue siendo la dirección del step renombrado');
  assert.match((await s.ext('POST', `/flows/${d.id}/run`, { step: 'Deploy', wait: true, timeoutSec: 60 })).body.result, /NEW/, 'el nombre exacto es el del step nuevo');
  // a duplicated box brings the original's slug: it gets its own, and the next saves keep working
  g.steps.push({ ...g.steps[1], id: 's_d3', name: 'Deploy (copia)' });
  g = await s.uiOk('PUT', `/api/flows/${d.id}`, g);
  assert.equal(new Set(g.steps.map((x) => x.slug)).size, 3);
  g = await s.uiOk('PUT', `/api/flows/${d.id}`, { ...g, steps: g.steps.map((x) => (x.id === 's_d3' ? { ...x, slug: g.steps[1].slug, task: 'y' } : x)) });
  assert.equal(new Set(g.steps.map((x) => x.slug)).size, 3, 'un cliente con el slug viejo no traba el guardado');
  // restoring an old version keeps the live slugs
  const v = await s.uiOk('POST', `/api/flows/${d.id}/versions`, { label: 'v1' });
  await s.uiOk('PUT', `/api/flows/${d.id}/steps/s_d2/slug`, { slug: 'deploy-prod' });
  await s.uiOk('POST', `/api/flows/${d.id}/versions/${v.id}/restore`, {});
  g = await s.getFlow(d.id);
  assert.equal(g.steps.find((x) => x.id === 's_d2').slug, 'deploy-prod');
});

test('revisión 12: "desde" con un anterior fijado pero sin usar fijadas no corre con vacío; los chequeos previos miran solo lo que corre', async () => {
  const f = await s.flow('Fijado', [
    { id: 's_pa', name: 'A', kind: 'role', role: 'r', task: '[[mock:json {"a":1}]]', output: { format: 'json', schema: '{ roto' } },
    cmd('B', 'Write-Output "B got $env:STEP_UPSTREAM"', { id: 's_pb' }),
  ], [['s_pa', 's_pb']]);
  await s.uiOk('POST', `/api/flows/${f.id}/steps/s_pa/pin`, { output: 'PINNED-A' });
  const dry = await s.ext('POST', `/flows/${f.id}/steps/s_pb/run`, { scope: 'from', dryRun: true });
  assert.equal(dry.body.ok, false); assert.deepEqual(dry.body.fromProblem.missing, ['A']);
  assert.equal((await s.ext('POST', `/flows/${f.id}/steps/s_pb/run`, { scope: 'from', wait: true })).body.code, 'FROM_UPSTREAM_MISSING');
  // with usePins the pinned output is a good upstream; A's broken schema does not block a run that does not run A
  const ok = await s.ext('POST', `/flows/${f.id}/steps/s_pb/run`, { scope: 'from', usePins: true, wait: true, timeoutSec: 60 });
  assert.equal(ok.body.status, 'success', JSON.stringify(ok.body));
  assert.match(ok.body.result, /PINNED-A/);
  assert.equal((await s.ext('POST', `/flows/${f.id}/run`, { wait: true })).body.code, 'INVALID_SCHEMA', 'el flujo completo sí lo corre');
  // afs --dry-run fails when the dry run is not ok
  const cli = await s.afs(['run', f.id, '--step', 's_pb', '--from', '--dry-run']);
  assert.equal(cli.code, 1, cli.stdout + cli.stderr); assert.match(cli.stderr, /última salida/);
});

test('revisión 12: un webhook crudo conserva sus claves scope/from/mode; el asistente con un step no se marca a sí mismo como error; INVOKE.md sin Markdown inyectado', async () => {
  const f = await s.flow('Crudo', [cmd('Eco', 'Write-Output "{{input}}"', { id: 's_w' })], []);
  const a = await s.ext('POST', `/flows/${f.id}/run`, { scope: 'repository', event: 'push', wait: true, timeoutSec: 60 });
  assert.equal(a.body.status, 'success', JSON.stringify(a.body)); assert.match(a.body.result, /repository/);
  const b = await s.ext('POST', `/flows/${f.id}/run`, { from: 'alice@example.com', text: 'hola', mode: 'from', wait: true, timeoutSec: 60 });
  assert.equal(b.body.status, 'success', JSON.stringify(b.body)); assert.match(b.body.result, /alice@example\.com/); assert.match(b.body.result, /mode/);
  for (const caller of ['jenkins-declarative', 'github-actions', 'powershell-task']) {
    const gen = await s.uiOk('POST', '/api/integrations/generate', { flow: f.id, caller, options: { step: 's_w', scope: 'from' } });
    assert.deepEqual(gen.lint.errors.map((e) => e.code), [], `${caller}: ${JSON.stringify(gen.lint.errors)}`);
  }
  const g = await s.getFlow(f.id); g.steps[0].name = 'x\n```\n# Inyectado';
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const md = (await s.ui('GET', `/api/flows/${f.id}/invoke.md`)).body;
  assert.ok(!/^# Inyectado/m.test(md), 'el nombre no abre un encabezado propio');
  assert.equal((md.match(/^```/gm) || []).length % 2, 0, 'los bloques de código siguen balanceados');
  const inv = await s.uiOk('GET', `/api/flows/${f.id}/steps/s_w/invoke`);
  assert.ok(inv.snippets.find((x) => x.id === 'afs').content.startsWith(`afs run '${f.id}'`), 'el CLI usa el id del flujo, no su nombre');
  assert.match(inv.snippets.find((x) => x.id === 'powershell').content, /TotalMinutes -gt 30/, 'el sondeo tiene tope');
});

// ---- second adversarial pass on spec 12 ----
test('revisión 12b: un slug pegado no se rompe por otros steps; deshacer un borrado y restaurar devuelven su slug; un payload crudo en la URL del step conserva sus claves', async () => {
  const f = await s.flow('Estable', [cmd('Alpha', 'Write-Output ALPHA', { id: 's_al' }), cmd('Beta', 'Write-Output "BETA {{input}}"', { id: 's_be' })], []);
  await s.uiOk('PUT', `/api/flows/${f.id}/steps/s_be/slug`, { slug: 'release-gate' });
  // another step NAMED like the slug does not take its calls
  await s.uiOk('PUT', `/api/flows/${f.id}/steps/s_al/slug`, { slug: 'alpha' });
  let g = await s.getFlow(f.id); g.steps[0].name = 'release-gate';
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  assert.match((await s.ext('POST', `/flows/${f.id}/steps/release-gate/run`, { wait: true, timeoutSec: 60 })).body.result, /BETA/);
  // delete + undo (the step comes back with its slug), and restore of a version after a delete
  const v = await s.uiOk('POST', `/api/flows/${f.id}/versions`, { label: 'con beta' });
  g = await s.getFlow(f.id); const beta = g.steps.find((x) => x.id === 's_be');
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: g.steps.filter((x) => x.id !== 's_be') });
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [...g.steps, beta] });
  assert.equal(g.steps.find((x) => x.id === 's_be').slug, 'release-gate', 'deshacer el borrado');
  g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: g.steps.filter((x) => x.id !== 's_be') });
  await s.uiOk('POST', `/api/flows/${f.id}/versions/${v.id}/restore`, {});
  assert.equal((await s.getFlow(f.id)).steps.find((x) => x.id === 's_be').slug, 'release-gate', 'restaurar');
  // a crafted new step id cannot take a slug in use
  g = await s.getFlow(f.id);
  assert.equal((await s.ui('PUT', `/api/flows/${f.id}`, { ...g, steps: [...g.steps, cmd('Intruso', 'Write-Output X', { id: 'release-gate' })] })).body.code, 'STEP_ID_TAKEN');
  // raw payload on the step URL (the Webhook snippet): its keys stay; ?scope= still works; case-insensitive
  const raw = await s.ext('POST', `/flows/${f.id}/steps/release-gate/run`, { scope: 'repository', from: 'alice@example.com', text: 'hola', wait: true, timeoutSec: 60 });
  assert.equal(raw.body.status, 'success', JSON.stringify(raw.body));
  assert.match(raw.body.result, /repository/); assert.match(raw.body.result, /alice@example\.com/);
  assert.equal((await s.ext('POST', `/flows/${f.id}/run?scope=FROM`, {})).body.code, 'STEP_REQUIRED');
});

// ---- third adversarial pass on spec 12 ----
test('revisión 12c: restaurar no le quita la dirección a un step vivo; un nombre en minúsculas no corre otro step por su slug; un scope mal escrito falla', async () => {
  const f = await s.flow('Restaurar ids', [cmd('Alpha', 'Write-Output ALPHA', { id: 's_r1' }), cmd('Old', 'Write-Output OLD-GATE', { id: 'gate' })], []);
  const v = await s.uiOk('POST', `/api/flows/${f.id}/versions`, { label: 'v1' });
  let g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: g.steps.filter((x) => x.id !== 'gate') });
  await s.uiOk('PUT', `/api/flows/${f.id}/steps/s_r1/slug`, { slug: 'gate' });
  const rr = await s.ui('POST', `/api/flows/${f.id}/versions/${v.id}/restore`, {});
  assert.equal(rr.status, 409); assert.equal(rr.body.code, 'STEP_ID_TAKEN');
  assert.match((await s.ext('POST', `/flows/${f.id}/steps/gate/run`, { wait: true, timeoutSec: 60 })).body.result, /ALPHA/);
  // "deploy" in a step FIELD: slug of the renamed one and name of the new one → ambiguous; on the URL the slug wins
  const d = await s.flow('Campo step', [cmd('Deploy', 'Write-Output OLD', { id: 's_q1' })], []);
  g = await s.getFlow(d.id); g.steps[0].name = 'Prep'; g.steps.push(cmd('Deploy', 'Write-Output NEW', { id: 's_q2' }));
  await s.uiOk('PUT', `/api/flows/${d.id}`, g);
  assert.equal((await s.ext('POST', `/flows/${d.id}/run`, { step: 'deploy', wait: true })).body.code, 'STEP_AMBIGUOUS');
  assert.equal((await s.afs(['run', d.id, '--step', 'deploy'])).code !== 0, true, 'el CLI tampoco adivina');
  assert.match((await s.ext('POST', `/flows/${d.id}/steps/deploy/run`, { wait: true, timeoutSec: 60 })).body.result, /OLD/);
  // the afs / MCP snippets name the step by id: never ambiguous
  const inv = await s.uiOk('GET', `/api/flows/${d.id}/steps/s_q1/invoke`);
  assert.match(inv.snippets.find((x) => x.id === 'afs').content, /--step 's_q1'/);
  // a typo in an options body is an error, not "only"
  assert.equal((await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', scope: 'fromm' })).body.code, 'BAD_SCOPE');
  assert.equal((await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', from: 'si' })).body.code, 'BAD_SCOPE');
  const one = await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', from: 1, dryRun: true });
  assert.equal(one.body.scope, 'from');
  // fourth pass: "mode" is the documented alias, also next to "input"
  assert.equal((await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', mode: 'From', dryRun: true })).body.scope, 'from');
  assert.equal((await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', mode: 'fromm' })).body.code, 'BAD_SCOPE');
  assert.equal((await s.ext('POST', `/flows/${d.id}/steps/s_q2/run`, { input: 'x', mode: 'wait', dryRun: true })).body.scope, 'only', 'los modos del cliente no son un alcance');
});

// ---- real simulation pass on spec 12: the curl snippets ran in Git Bash without jq and against an unreachable LAN IP ----
test('revisión 12d: los snippets curl funcionan pegados en bash sin jq (?format=text) y usan 127.0.0.1 si otra máquina no llega', async (t) => {
  const f = await chain('Curl sin jq');
  await s.runExt(f.id, { input: 'x' });
  const inv = await s.uiOk('GET', `/api/flows/${f.id}/steps/s_c/invoke`);
  const curl = inv.snippets.find((x) => x.id === 'curl').content; const async = inv.snippets.find((x) => x.id === 'curl-async').content;
  assert.equal(inv.reach.status, 'needs-host');
  for (const c of [curl, async, inv.snippets.find((x) => x.id === 'jenkins-sh').content]) {
    assert.ok(!/\|\s*jq\b|\bjq -r/.test(c), 'sin jq'); assert.match(c, new RegExp(`127\\.0\\.0\\.1:${s.port}`), 'la IP de red no responde todavía: usa esta PC');
  }
  // ?format=text: the outcome in the HTTP code, the result as plain text
  const h = { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' };
  const ok = await fetch(`${s.base}/api/ext/flows/${f.id}/steps/s_c/run?format=text`, { method: 'POST', headers: h, body: JSON.stringify({ input: 'x', wait: true, timeoutSec: 60 }) });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-afs-status'), 'success'); assert.match(await ok.text(), /^informe ok/);
  const ko = await fetch(`${s.base}/api/ext/flows/${f.id}/steps/s_c/run?format=text`, { method: 'POST', headers: h, body: JSON.stringify({ input: 'x', vars: { fail: '1' }, wait: true, timeoutSec: 60 }) });
  assert.equal(ko.status, 422); assert.match(await ko.text(), /terminó en (error|failed)/);
  const started = await fetch(`${s.base}/api/ext/flows/${f.id}/steps/s_c/run?format=text`, { method: 'POST', headers: h, body: JSON.stringify({ input: 'x' }) });
  const runId = (await started.text()).trim();
  assert.ok([200, 202].includes(started.status)); assert.equal(started.headers.get('x-afs-run-id'), started.status === 202 ? runId : started.headers.get('x-afs-run-id'));
  const id = started.headers.get('x-afs-run-id');
  const done = await until(async () => { const r = await fetch(`${s.base}/api/ext/flows/${f.id}/runs/${id}?format=text`, { headers: h }); return r.status === 200 ? r : null; });
  assert.ok(done, 'el sondeo llega a 200'); assert.match(await done.text(), /informe ok/);
  // errors stay JSON (a caller sees why), and so does a dry run
  const bad = await fetch(`${s.base}/api/ext/flows/${f.id}/steps/nope/run?format=text`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(bad.status, 404); assert.equal((await bad.json()).code, 'STEP_NOT_FOUND');
  const dry = await fetch(`${s.base}/api/ext/flows/${f.id}/steps/s_c/run?format=text`, { method: 'POST', headers: h, body: JSON.stringify({ input: 'x', dryRun: true }) });
  assert.equal((await dry.json()).dryRun, true);
  // pasted as is in bash (Git Bash on Windows, sh on a Linux agent)
  const bash = await s.exec('bash', ['-c', 'command -v curl'], {});
  if (bash.code !== 0) { t.diagnostic('sin bash/curl: se omite la ejecución real del snippet'); return; }
  const run = (script) => s.exec('bash', ['-c', script], { env: { AFS_TOKEN: s.token } });
  const r1 = await run(curl);
  assert.equal(r1.code, 0, r1.stderr); assert.match(r1.stdout, /informe ok/);
  const r2 = await run(curl.replace('"source":"curl"', '"source":"curl","vars":{"fail":"1"}'));
  assert.notEqual(r2.code, 0, 'falla como un stage de CI');
  const r3 = await run(async);
  assert.equal(r3.code, 0, r3.stderr); assert.match(r3.stdout, /informe ok/);
  const r4 = await run(async.replace('"source":"curl"', '"source":"curl","vars":{"fail":"1"}'));
  assert.notEqual(r4.code, 0, 'el sondeo también falla si el step falla');
  const r5 = await s.exec('bash', ['-c', curl], { env: { AFS_TOKEN: 'mal' } });
  assert.notEqual(r5.code, 0, 'un token inválido no pasa por éxito');
});

// ---- code review of spec 12 ----
test('revisión 12e: un flujo de antes del spec 12 recibe sus slugs al arrancar (INVOKE.md y /flows llamables); ids sin escapar; flujo completo sin jq; "step" crudo en la URL del step', async () => {
  const f = await s.flow('Legado', [cmd('Build', 'Write-Output 1', { id: 's_1' }), cmd('Build', 'Write-Output 2', { id: 's_2' })], []);
  await s.kill();
  const file = s.flowFile(f.id, 'flow.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); for (const st of j.steps) delete st.slug; fs.writeFileSync(file, JSON.stringify(j));
  fs.rmSync(s.flowFile(f.id, 'INVOKE.md'), { force: true });
  await s.start();
  const mdFile = s.flowFile(f.id, 'INVOKE.md');
  const md = await until(() => fs.existsSync(mdFile) && fs.readFileSync(mdFile, 'utf8'));
  assert.ok(md, 'INVOKE.md escrito al arrancar');
  assert.ok(!/undefined/.test(md), 'sin steps/undefined/run');
  assert.match(md, /id: `s_1`/, 'el id dentro de `código` no se escapa');
  assert.ok(!/\bjq\b/.test(md)); assert.match(md, /format=text/);
  const list = (await s.ext('GET', '/flows')).body.find((x) => x.id === f.id);
  assert.deepEqual(list.steps.map((x) => x.slug), ['build', 'build-2']);
  for (const sl of ['build', 'build-2']) {
    const r = await s.ext('POST', `/flows/${f.id}/steps/${sl}/run`, { input: 'x', dryRun: true });
    assert.equal(r.status, 200, `${sl}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual((await s.getFlow(f.id)).steps.map((x) => x.slug), ['build', 'build-2'], 'quedaron guardados');
  // a raw payload on the step URL keeps its own "step" field (the step comes from the path)
  const g = await s.flow('Payload step', [cmd('Eco', 'Write-Output "IN=$env:AFS_INPUT"', { id: 's_e' })], []);
  const r = await s.ext('POST', `/flows/${g.id}/steps/s_e/run?wait=true`, { step: 'deploy-prod', build: 9 });
  assert.equal(r.body.status, 'success');
  const run = await s.ui('GET', `/api/flows/${g.id}/runs/${r.body.runId}`);
  assert.match(JSON.stringify(run.body.input ?? run.body), /deploy-prod/);
});
