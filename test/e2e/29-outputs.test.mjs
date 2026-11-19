// Spec 14: what a step PRODUCES (📄 deliverables: checked files in the run's outputs, copied, downloadable) and what it
// CHANGES outside (⚡ declared actions: a constrained Claude call with ONLY that action's MCP tools, which must really
// call the write tool; auto / confirm (approved later, the run does not wait) / dryRun; never duplicated on a re-run
// with the same input; blocked by the "no external writes" policy; never in a rehearsal; quarantined on import).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'outputs' }); await s.start(); });
after(async () => { await s?.stop(); });
const run = async (id, body = {}) => { const { runId } = await s.uiOk('POST', `/api/flows/${id}/run`, { input: '', breakpoints: false, ...body }); return s.waitRun(id, runId); };
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };
const ATL = 'mcp__claude_ai_Atlassian_Rovo';
const okJson = (key) => `[[mock:say {"ok":true,"key":"${key}","url":"https://x.atlassian.net/browse/${key}"}]]`;

test('entregables: .feature, JSON de un campo y CSV de una lista; chequeo de formato; copia a una carpeta; descarga por la UI y la API; llegan como archivos al siguiente', async () => {
  const dest = path.join(s.dirs.work, `dest-${Date.now()}`); fs.mkdirSync(dest, { recursive: true });
  const json = { cases: [{ id: 'C1', title: 'Línea media' }, { id: 'C2', title: 'Línea asiática, "cuarto"' }] };
  const gherkin = 'Feature: Line History\\n  Scenario: media línea\\n    Given algo';
  const design = role('Diseño', `[[mock:json ${JSON.stringify({ ...json, feature: 'Feature: X\nScenario: Y' })}]]`, { id: 's_ds', output: { format: 'json' }, deliverables: [
    { id: 'd_f', format: 'feature', path: '{{vars.issue}}.feature', from: 'json.feature', destination: [{ path: dest }] },
    { id: 'd_j', format: 'json', path: 'casos.json', from: 'json.cases' },
    { id: 'd_c', format: 'csv', path: 'matriz.csv', from: 'json.cases' },
    { id: 'd_bad', format: 'nope', path: 'x' },
  ] });
  const next = cmd('Siguiente', 'Write-Output $env:STEP_UPSTREAM_JSON', { id: 's_nx' });
  const f = await s.flow('Entregables', [design, next], [['s_ds', 's_nx']], { vars: { issue: 'SBK-7' } });
  const g = await s.getFlow(f.id);
  assert.deepEqual(g.steps[0].deliverables.map((d) => d.id), ['d_f', 'd_j', 'd_c'], 'formato desconocido descartado al guardar');
  const r = await run(f.id);
  assert.equal(r.steps.s_ds.status, 'success', r.steps.s_ds.error);
  const dl = r.steps.s_ds.deliverables;
  assert.deepEqual(dl.map((x) => x.name), ['SBK-7.feature', 'casos.json', 'matriz.csv']);
  assert.ok(fs.existsSync(path.join(dest, 'SBK-7.feature')), 'copiado a la carpeta destino');
  assert.deepEqual(JSON.parse(fs.readFileSync(dl[1].path, 'utf8')), json.cases);
  assert.equal(fs.readFileSync(dl[2].path, 'utf8'), 'id,title\nC1,Línea media\nC2,"Línea asiática, ""cuarto"""');
  assert.ok(r.steps.s_ds.files.includes(dl[0].path), 'el archivo pasa al siguiente como files');
  // download: UI and external API (by name or by id), never outside the outputs folder
  const ui = await s.ui('GET', `/api/flows/${f.id}/runs/${r.id}/files/casos.json`);
  assert.equal(ui.status, 200);
  assert.deepEqual(typeof ui.body === 'string' ? JSON.parse(ui.body) : ui.body, json.cases);
  const ex = await s.ext('GET', `/flows/${f.id}/runs/${r.id}/files/d_f`);
  assert.equal(ex.status, 200);
  assert.match(String(ex.body), /Feature: X/);
  assert.equal((await s.ext('GET', `/flows/${f.id}/runs/${r.id}/files/${encodeURIComponent('..\\..\\config.json')}`)).status, 404);
  // a deliverable that fails its format check fails the step
  g.steps[0].deliverables = [{ id: 'd_bad2', format: 'feature', path: 'mal.feature', from: 'json.cases' }];
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const r2 = await run(f.id);
  assert.equal(r2.steps.s_ds.status, 'error');
  assert.equal(r2.steps.s_ds.code, 'DELIVERABLE_INVALID');
  assert.match(r2.steps.s_ds.error, /necesita "Feature:"/);
});

test('acción automática (comentar en Jira): Haiku con SOLO las herramientas de esa acción; la clave llega a la salida; re-ejecutar con la misma entrada no la repite', async () => {
  const st = role('Analizar', '[[mock:say análisis listo]]', { id: 's_ac', actions: [{ id: 'a_c', type: 'jira.comment', idempotencyKey: '{{vars.issue}}-resultado', params: { issue: '{{vars.issue}}', body: `Resultado: {{output}} [[mock:tool ${ATL}__addCommentToJiraIssue SBK-1]] ${okJson('SBK-1')}` } }] });
  const nx = cmd('Siguiente', 'Write-Output "{{steps.Analizar.actions}}"', { id: 's_an' });
  const f = await s.flow('Acción auto', [st, nx], [['s_ac', 's_an']], { vars: { issue: 'SBK-1' } });
  assert.equal((await s.getFlow(f.id)).steps[0].actions[0].approval, 'auto', 'comentar es automática por defecto');
  const n0 = s.calls().length;
  let r = await run(f.id);
  assert.equal(r.steps.s_ac.status, 'success', r.steps.s_ac.error);
  const call = s.callsSince(n0).find((c) => /Ejecutas UNA acción/.test(c.system));
  assert.ok(call, 'llamada de la acción');
  assert.equal(s.argOf(call, '--allowedTools'), `${ATL}__getAccessibleAtlassianResources,${ATL}__addCommentToJiraIssue`);
  assert.equal(s.argOf(call, '--model'), 'haiku');
  assert.equal(s.argOf(call, '--tools'), 'ToolSearch');
  assert.match(s.argOf(call, '--disallowedTools'), /Bash/);
  assert.match(call.prompt, /<untrusted-data>[\s\S]*Resultado: análisis listo/);
  const p = r.steps.s_ac.declaredActions[0];
  assert.equal(p.status, 'done'); assert.equal(p.key, 'SBK-1');
  assert.match(r.steps.s_an.output, /SBK-1/, 'el siguiente step ve la clave (actions)');
  const n1 = s.calls().length;
  r = await run(f.id);
  assert.equal(r.steps.s_ac.declaredActions[0].status, 'exists');
  assert.ok(!s.callsSince(n1).some((c) => /Ejecutas UNA acción/.test(c.system)), 'no la repite');
});

test('una acción que no llama a la herramienta de escritura no cuenta como hecha (el step falla, salvo opcional); la política "sin escrituras externas" la bloquea', async () => {
  const st = role('Paso', '[[mock:say ok]]', { id: 's_nf', actions: [{ id: 'a_n', type: 'jira.comment', params: { issue: 'SBK-2', body: `dice que sí ${okJson('SBK-2')}` } }] });
  const f = await s.flow('Acción falsa', [st], []);
  let r = await run(f.id);
  assert.equal(r.steps.s_nf.status, 'error');
  assert.equal(r.steps.s_nf.code, 'ACTION_FAILED');
  assert.match(r.steps.s_nf.error, /No se llamó a addCommentToJiraIssue/);
  const g = await s.getFlow(f.id); g.steps[0].actions[0].optional = true; await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  r = await run(f.id);
  assert.equal(r.steps.s_nf.status, 'success', 'opcional: el step sale bien');
  const g2 = await s.getFlow(f.id); g2.steps[0].actions[0].optional = false; g2.steps[0].actions[0].params.body = `con política [[mock:tool ${ATL}__addCommentToJiraIssue SBK-2]] ${okJson('SBK-3')}`; g2.policies = [{ type: 'noExternalWrites' }];
  await s.uiOk('PUT', `/api/flows/${f.id}`, g2);
  const n0 = s.calls().length;
  r = await run(f.id);
  assert.equal(r.steps.s_nf.status, 'success', 'bloqueada por política no es una falla');
  assert.equal(r.steps.s_nf.declaredActions[0].status, 'blocked');
  assert.match(r.steps.s_nf.declaredActions[0].reason, /sin escrituras externas/);
  assert.ok(!s.callsSince(n0).some((c) => /Ejecutas UNA acción/.test(c.system)));
});

test('confirmar: la ejecución no espera; la acción queda en ⚡ atención; aprobar con datos editados la ejecuta; rechazar; en un ensayo nunca se envía', async () => {
  const st = role('Bugs', '[[mock:json {"defects":[{"title":"Falla la línea"}]}]]', { id: 's_cf', output: { format: 'json' }, actions: [
    { id: 'a_bug', type: 'jira.createIssue', params: { project: 'SBK', issueType: 'Bug', summary: '{{output.json.defects.0.title}}', fields: { environment: 'QA, PPD' } }, if: { type: 'json', path: 'defects', op: 'lengthGte', value: 1 } },
    { id: 'a_sub', type: 'jira.createSubtask', params: { parent: 'SBK-9', summary: 'QA' } },
  ] });
  const f = await s.flow('Confirmar', [st], []);
  const g = await s.getFlow(f.id);
  assert.equal(g.steps[0].actions[0].approval, 'confirm', 'crear es "confirmar" por defecto');
  const r = await run(f.id);
  assert.equal(r.status, 'success');
  const acts = r.steps.s_cf.declaredActions;
  assert.deepEqual(acts.map((p) => p.status), ['awaiting_approval', 'awaiting_approval']);
  assert.equal(acts[0].params.summary, 'Falla la línea');
  assert.deepEqual(acts[0].params.fields, { environment: 'QA, PPD' });
  const att = await until(async () => (await s.uiOk('GET', '/api/attention')).items.find((x) => x.kind === 'approval' && x.flowId === f.id));
  assert.match(att.title, /2 acciones esperando aprobación/);
  assert.deepEqual(att.target, { flowId: f.id, stepId: 's_cf', open: 'approve' });
  // approve with edited data (the mock reads its answer from the edited summary)
  const edited = { ...acts[0].params, summary: `Falla la línea media [[mock:tool ${ATL}__createJiraIssue SBK]] ${okJson('SBK-77')}` };
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_cf', actionId: 'a_bug', approve: true, params: { ...edited, project: 'OTRO' } })).body.code, 'TARGET_LOCKED', 'el destino no se cambia al aprobar');
  const res = await s.uiOk('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_cf', actionId: 'a_bug', approve: true, params: edited });
  assert.equal(res.status, 'done'); assert.equal(res.key, 'SBK-77'); assert.equal(res.edited, true);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_cf', actionId: 'a_bug', approve: true })).status, 409, 'ya no espera');
  // reject the other one (external API)
  const rej = await s.ext('POST', `/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_cf', actionId: 'a_sub', approve: false });
  assert.equal(rej.body.status, 'rejected');
  const last = (await s.getFlow(f.id)).steps[0].lastRun;
  assert.deepEqual(last.declaredActions.map((p) => p.status), ['done', 'rejected']);
  assert.ok(last.actions.some((a) => a.key === 'SBK-77'));
  assert.ok(await until(async () => !(await s.uiOk('GET', '/api/attention')).items.some((x) => x.kind === 'approval' && x.flowId === f.id)), 'el aviso se va');
  // rehearsal: shown, never sent
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/rehearsal`, { input: '' });
  const rh = await s.waitRun(f.id, runId);
  assert.deepEqual(rh.steps.s_cf.declaredActions.map((p) => p.status), ['exists', 'dry_run'], 'la ya hecha figura como existente; la otra solo se muestra');
});

test('HTTP POST: la credencial solo va a su propio sitio; un flujo importado con acciones queda en cuarentena', async () => {
  let got = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = { auth: req.headers.authorization, body: b, type: req.headers['content-type'] }; res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await s.uiOk('POST', '/api/credentials', { type: 'jenkins', name: 'hook', fields: { url: base, user: 'qa', token: 'T0K3N' } });
    const st = role('Avisar', '[[mock:say listo]]', { id: 's_hp', actions: [
      { id: 'a_ok', type: 'http.post', approval: 'auto', params: { url: `${base}/hook`, body: '{"text":"{{output}}"}', credential: 'hook' } },
      { id: 'a_no', type: 'http.post', approval: 'auto', optional: true, params: { url: 'http://127.0.0.2:9/x', body: 'x', credential: 'hook' } },
    ] });
    const f = await s.flow('Webhook', [st], []);
    const r = await run(f.id);
    const by = (id) => r.steps.s_hp.declaredActions.find((p) => p.actionId === id);
    assert.equal(by('a_ok').status, 'done', by('a_ok').error);
    assert.deepEqual(JSON.parse(got.body), { text: 'listo' });
    assert.match(got.type, /application\/json/);
    assert.match(got.auth, /^Basic /);
    assert.equal(by('a_no').status, 'error');
    assert.match(by('a_no').error, /no se envía a/);
    // import: actions are a reason for quarantine
    const bundle = await s.uiOk('GET', `/api/flows/${f.id}/export`);
    const { flow: imp } = await s.uiOk('POST', '/api/flows/import', { bundle });
    assert.ok(imp.quarantine?.reasons.some((x) => /acción declarada en "Avisar": http\.post \(automática\)/.test(x)), JSON.stringify(imp.quarantine));
  } finally { srv.close(); }
});

test('UI: agregar una acción, ponerla en "confirmar", ejecutar, aprobarla en Datos; el nodo muestra ⚡ y ⏳ mientras espera', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('outputs-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const f = await u.flow('Acciones UI', [role('Paso', '[[mock:say hecho]]', { id: 's_ui', position: { x: 120, y: 120 } })], []);
    await page.goto(`${u.base}/?flow=${f.id}`);
    const nodeLoc = page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Paso' }) });
    await nodeLoc.click();
    const box = page.getByTestId('outputs-box');
    await box.getByTestId('action-add').selectOption('jira.comment');
    await box.getByTestId('action-issue').fill('SBK-5');
    await box.getByTestId('action-approval').selectOption('confirm');
    await box.getByTestId('action-item').locator('textarea').first().fill(`Listo [[mock:tool ${ATL}__addCommentToJiraIssue SBK-5]] ${okJson('SBK-5')}`);
    await nodeLoc.getByText('⚡ 1').waitFor();
    let g;
    for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.steps[0].actions?.[0]?.params?.body?.includes('Listo') && g.steps[0].actions[0].approval === 'confirm') break; await sleep(150); }
    assert.equal(g.steps[0].actions[0].approval, 'confirm');
    const { runId } = await u.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
    await u.waitRun(f.id, runId);
    await nodeLoc.getByTestId('approval-badge').waitFor();
    await page.locator('.tabs button', { hasText: 'Datos' }).first().click();
    const item = page.getByTestId('declared-action');
    await item.getByText('⏳ espera aprobación').waitFor();
    await item.getByTestId('action-approve').click();
    await page.getByTestId('declared-action').getByText('✓ hecha').waitFor();
    await nodeLoc.getByTestId('approval-badge').waitFor({ state: 'detached' });
  } finally { await ui.close?.(); }
});

// ---- regressions of the architect + adversarial reviews of spec 14 ----
test('revisión 14: con break "después" las acciones corren DESPUÉS de revisar, con la salida editada; los entregables también', async () => {
  const st = role('Analizar', '[[mock:say original]]', { id: 's_bk', breakpoint: 'after',
    actions: [{ id: 'a_k', type: 'jira.comment', approval: 'auto', params: { issue: 'SBK-4', body: `{{output}} [[mock:tool ${ATL}__addCommentToJiraIssue SBK-4]] ${okJson('SBK-4')}` } }],
    deliverables: [{ id: 'd_k', format: 'md', path: 'nota.md' }] });
  const f = await s.flow('Break y acciones', [st], []);
  const n0 = s.calls().length;
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: true });
  await s.waitRun(f.id, runId, 20000, (x) => x.status === 'paused');
  assert.ok(!s.callsSince(n0).some((c) => /Ejecutas UNA acción/.test(c.system)), 'nada se envió antes del break');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'edit', output: 'corregido por QA' });
  const r = await s.waitRun(f.id, runId);
  assert.equal(r.steps.s_bk.status, 'success', r.steps.s_bk.error);
  const call = s.callsSince(n0).find((c) => /Ejecutas UNA acción/.test(c.system));
  assert.match(call.prompt, /corregido por QA/, 'la acción usa la salida editada');
  assert.equal(fs.readFileSync(r.steps.s_bk.deliverables[0].path, 'utf8'), 'corregido por QA');
});

test('revisión 14: la clave de idempotencia es el destino (no el texto): otra salida no crea otro sub-task; un webhook fijo sí vuelve a enviarse', async () => {
  let posts = 0;
  const srv = http.createServer((req, res) => { posts++; req.resume(); res.writeHead(200); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const answer = path.join(s.dirs.work, `out-${Date.now()}.txt`).replace(/\\/g, '/');
    fs.writeFileSync(answer, 'primera versión');
    const st = role('QA', `[[mock:say-file ${answer}]]`, { id: 's_id', actions: [
      { id: 'a_sub', type: 'jira.createSubtask', approval: 'auto', params: { parent: 'SBK-8', summary: 'QA SBK-8', description: `{{output}} [[mock:tool ${ATL}__createJiraIssue SBK-8]] ${okJson('SBK-80')}` } },
      { id: 'a_hook', type: 'http.post', approval: 'auto', params: { url: `http://127.0.0.1:${srv.address().port}/nightly`, body: '{"text":"Nightly OK"}' } },
    ] });
    const f = await s.flow('Idempotencia', [st], []);
    let r = await run(f.id);
    assert.deepEqual(r.steps.s_id.declaredActions.map((p) => p.status), ['done', 'done']);
    fs.writeFileSync(answer, 'otra salida distinta del modelo');
    r = await run(f.id);
    const sub = r.steps.s_id.declaredActions.find((p) => p.actionId === 'a_sub');
    assert.equal(sub.status, 'exists', 'mismo padre + resumen: no se repite');
    assert.match(sub.reason, /los datos cambiaron/);
    assert.ok(r.steps.s_id.actions.some((a) => a.key === 'SBK-80'), 'la clave sigue llegando al siguiente');
    assert.equal(posts, 2, 'el webhook fijo se envía en cada ejecución');
  } finally { srv.close(); }
});

test('revisión 14: dos aprobaciones a la vez ejecutan UNA sola vez; un elemento de "para cada" aprobado por la clave del padre no queda pendiente', async () => {
  let posts = 0;
  const srv = http.createServer((req, res) => { posts++; req.resume(); setTimeout(() => { res.writeHead(200); res.end(); }, 800); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/x`;
    const src = role('Lista', '[[mock:json {"t":["A","B"]}]]', { id: 's_l', output: { format: 'json' } });
    const each = role('Cada', '[[mock:say ok]]', { id: 's_e', forEach: { path: 't' }, actions: [{ id: 'a_p', type: 'http.post', params: { url, body: '{"item":"{{item}}"}' } }] });
    const f = await s.flow('Aprobar dos veces', [src, each], [['s_l', 's_e']]);
    const r = await run(f.id);
    assert.deepEqual(r.steps.s_e.declaredActions.map((p) => [p.stepKey, p.status]), [['s_e~1', 'awaiting_approval'], ['s_e~2', 'awaiting_approval']]);
    // the same element approved twice at once (two tabs, a retrying client): ONE execution
    const one = { stepKey: 's_e~1', actionId: 'a_p', approve: true };
    const [x, y] = await Promise.all([s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, one), s.ext('POST', `/flows/${f.id}/runs/${r.id}/actions/decide`, one)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(posts, 1, 'una sola ejecución');
    let sum = await s.ext('GET', `/flows/${f.id}/runs/${r.id}`);
    assert.equal(sum.body.pendingApprovals, 1, 'el resumen externo dice cuántas esperan');
    assert.deepEqual((await s.uiOk('GET', `/api/flows/${f.id}/approvals`)).map((p) => p.stepKey), ['s_e~2']);
    // through the PARENT key: it takes the element that still waits, and that element is decided (not left pending)
    const viaParent = await s.uiOk('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_e', actionId: 'a_p', approve: true });
    assert.equal(viaParent.stepKey, 's_e~2');
    const after = await s.uiOk('GET', `/api/flows/${f.id}/runs/${r.id}`);
    assert.deepEqual(['s_e~1', 's_e~2'].map((k) => after.steps[k].declaredActions[0].status), ['done', 'done']);
    assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { ...one, stepKey: 's_e~2' })).status, 409, 'no se vuelve a ejecutar');
    assert.equal(posts, 2);
    sum = await s.ext('GET', `/flows/${f.id}/runs/${r.id}`);
    assert.equal(sum.body.pendingApprovals, undefined);
  } finally { srv.close(); }
});

test('revisión 14: un destino de copia no viene de plantillas ni sobrescribe; archivos de igual nombre por elemento se descargan por step', async () => {
  const victim = path.join(s.dirs.work, `victim-${Date.now()}`); fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'settings.json'), '{"original":true}');
  const src = role('Lista', '[[mock:json {"t":["A","B"]}]]', { id: 's_l2', output: { format: 'json' } });
  const each = role('Cada', 'res {{item}} [[mock:echo]]', { id: 's_e2', forEach: { path: 't' }, deliverables: [
    { id: 'd_r', format: 'txt', path: 'res.txt' },
    { id: 'd_s', format: 'json', path: 'settings.json', from: 'output', destination: [{ path: victim }] },
    { id: 'd_t', format: 'txt', path: 'x.txt', destination: [{ path: '{{vars.dir}}' }] },
  ] });
  const f = await s.flow('Destinos', [src, each], [['s_l2', 's_e2']], { vars: { dir: victim } });
  const g = await s.getFlow(f.id);
  assert.equal(g.steps[1].deliverables.find((d) => d.id === 'd_t').destination, undefined, 'destino con plantilla descartado al guardar');
  g.steps[1].deliverables = g.steps[1].deliverables.filter((d) => d.id !== 'd_s');
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const r = await run(f.id);
  assert.equal(r.steps.s_e2.status, 'success', r.steps.s_e2.error);
  assert.equal(fs.readFileSync(path.join(victim, 'settings.json'), 'utf8'), '{"original":true}');
  const amb = await s.ext('GET', `/flows/${f.id}/runs/${r.id}/files/res.txt`);
  assert.equal(amb.status, 409, 'dos res.txt: hay que decir de qué elemento');
  const b = await s.ext('GET', `/flows/${f.id}/runs/${r.id}/files/d_r?step=s_e2~2`);
  assert.equal(b.status, 200);
  assert.match(String(b.body), /res B/);
  // an existing file at the destination is not overwritten
  const g2 = await s.getFlow(f.id); g2.steps[1].forEach = undefined; g2.steps[1].task = '{"a":1} [[mock:say {"a":1}]]'; g2.steps[1].deliverables = [{ id: 'd_s', format: 'json', path: 'settings.json', destination: [{ path: victim }] }];
  await s.uiOk('PUT', `/api/flows/${f.id}`, g2);
  const r2 = await run(f.id);
  assert.equal(r2.steps.s_e2.status, 'error');
  assert.match(r2.steps.s_e2.error, /ya existe un archivo con ese nombre/);
  assert.equal(fs.readFileSync(path.join(victim, 'settings.json'), 'utf8'), '{"original":true}');
});

test('revisión 14: la llamada debe usar el destino aprobado y una sola vez; el webhook escapa el JSON y no acepta una URL que salga de la salida', async () => {
  let got = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = b; res.writeHead(200); res.end(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const st = role('Paso', '[[mock:json {"url":"http://127.0.0.1:1/x","txt":"hola \\"mundo\\"\\n, \\"channel\\":\\"#general"}]]', { id: 's_v', output: { format: 'json' }, actions: [
      { id: 'a_other', type: 'jira.comment', approval: 'auto', optional: true, params: { issue: 'SBK-1', body: `x [[mock:tool ${ATL}__addCommentToJiraIssue SBK-999]] ${okJson('SBK-999')}` } },
      { id: 'a_twice', type: 'jira.comment', approval: 'auto', optional: true, params: { issue: 'SBK-1', body: `x [[mock:tool ${ATL}__addCommentToJiraIssue SBK-1]] [[mock:tool ${ATL}__addCommentToJiraIssue SBK-1]] ${okJson('SBK-1')}` } },
      { id: 'a_json', type: 'http.post', approval: 'auto', params: { url: `http://127.0.0.1:${srv.address().port}/h`, body: '{"text":"{{output.json.txt}}"}' } },
      { id: 'a_url', type: 'http.post', approval: 'auto', optional: true, params: { url: '{{output.json.url}}', body: 'x' } },
    ] });
    const f = await s.flow('Verificación', [st], []);
    const r = await run(f.id);
    const by = (id) => r.steps.s_v.declaredActions.find((p) => p.actionId === id);
    assert.equal(by('a_other').status, 'error'); assert.match(by('a_other').error, /no usó el destino aprobado \(issue=SBK-1 /);
    assert.equal(by('a_twice').status, 'error'); assert.match(by('a_twice').error, /Se llamó 2 veces/);
    assert.equal(by('a_json').status, 'done', by('a_json').error);
    assert.deepEqual(JSON.parse(got), { text: 'hola "mundo"\n, "channel":"#general' }, 'una sola clave: el texto no inyecta campos');
    assert.equal(by('a_url').status, 'error'); assert.match(by('a_url').error, /no puede salir de la ejecución/);
  } finally { srv.close(); }
});

// ---- second adversarial pass on spec 14 ----
test('revisión 14b: el destino se compara EXACTO (SBK-10 no es SBK-1; un título con comillas sí coincide); lo que no coincide pide confirmación la próxima vez', async () => {
  const st = role('Paso', '[[mock:say ok]]', { id: 's_x', actions: [
    { id: 'a_10', type: 'jira.comment', approval: 'auto', optional: true, idempotencyKey: 'k-{{vars.n}}', params: { issue: 'SBK-1', body: `x [[mock:tool ${ATL}__addCommentToJiraIssue SBK-10]] ${okJson('SBK-10')}` } },
    { id: 'a_q', type: 'confluence.createPage', approval: 'auto', params: { space: 'QA', title: 'Plan "Q4"', body: `y [[mock:tool ${ATL}__createConfluencePage Plan "Q4"]] ${okJson('123')}` } },
  ] });
  const f = await s.flow('Exacto', [st], [], { vars: { n: '1' } });
  let r = await run(f.id);
  const by = (id) => r.steps.s_x.declaredActions.find((p) => p.actionId === id);
  assert.equal(by('a_10').status, 'error'); assert.match(by('a_10').error, /no usó el destino aprobado \(issue=SBK-1 /);
  assert.equal(by('a_q').status, 'done', by('a_q').error);
  r = await run(f.id);
  assert.equal(by('a_10').status, 'awaiting_approval', 'no queda como "ya hecha": una persona revisa');
  assert.match(by('a_10').reason, /no coincidió con lo aprobado/);
  assert.equal(by('a_q').status, 'exists');
});

test('revisión 14b: al aprobar no se puede mover el destino (padre, tipo, campos nuevos, listas) y un reinicio a mitad de una aprobación la deja decidible', async () => {
  let hang = true;
  const srv = http.createServer((req, res) => { req.resume(); if (!hang) { res.writeHead(200); res.end(); } });
  await new Promise((rr) => srv.listen(0, '127.0.0.1', rr));
  try {
    const st = role('Paso', '[[mock:say ok]]', { id: 's_l', actions: [
      { id: 'a_pg', type: 'confluence.createPage', params: { space: 'QA', parent: '100', title: 'T', body: 'b' } },
      { id: 'a_is', type: 'jira.createIssue', params: { project: 'SBK', issueType: 'Bug', summary: 's', fields: { environment: 'QA' } } },
      { id: 'a_h', type: 'http.post', params: { url: `http://127.0.0.1:${srv.address().port}/h`, body: 'x' } },
    ] });
    const f = await s.flow('Bloqueo', [st], []);
    const r = await run(f.id);
    const dec = (actionId, params) => s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_l', actionId, approve: true, params });
    const pg = r.steps.s_l.declaredActions.find((p) => p.actionId === 'a_pg').params;
    const is = r.steps.s_l.declaredActions.find((p) => p.actionId === 'a_is').params;
    for (const [id, params] of [['a_pg', { ...pg, parent: '999' }], ['a_is', { ...is, issueType: 'Sub-task' }], ['a_is', { ...is, fields: { project: { key: 'OPS' } } }], ['a_is', { ...is, project: ['SBK'] }], ['a_is', { ...is, extra: 'x' }]]) {
      const x = await dec(id, params);
      assert.equal(x.status, 400, `${id} ${JSON.stringify(params)}`); assert.equal(x.body.code, 'TARGET_LOCKED');
    }
    // a restart while an approval is executing: it goes back to waiting, marked as halfway, and can be decided
    const pending = s.ui('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_l', actionId: 'a_h', approve: true }).catch(() => null);
    await until(async () => (await s.uiOk('GET', `/api/flows/${f.id}/runs/${r.id}`)).steps.s_l.declaredActions.some((p) => p.actionId === 'a_h' && p.status === 'executing'), 5000);
    await s.kill(); await pending;
    hang = false;
    await s.start();
    const back = (await s.uiOk('GET', `/api/flows/${f.id}/runs/${r.id}`)).steps.s_l.declaredActions.find((p) => p.actionId === 'a_h');
    assert.equal(back.status, 'awaiting_approval');
    assert.match(back.reason, /se reinició durante la aprobación/);
    const ok = await s.uiOk('POST', `/api/flows/${f.id}/runs/${r.id}/actions/decide`, { stepKey: 's_l', actionId: 'a_h', approve: false });
    assert.equal(ok.status, 'rejected');
  } finally { srv.close(); }
});

test('revisión 14b: un destino fijo admite reemplazar su propia copia anterior (no la de otro); {{{…}}} en un webhook y la clave con datos de la ejecución se rechazan', async () => {
  const dest = path.join(s.dirs.work, `dest2-${Date.now()}`); fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'ajeno.md'), 'de otra persona');
  const st = role('Paso', '[[mock:say contenido]]', { id: 's_d', deliverables: [{ id: 'd_m', format: 'md', path: 'mio.md', destination: [{ path: dest }] }], actions: [
    { id: 'a_raw', type: 'http.post', approval: 'auto', optional: true, params: { url: 'http://127.0.0.1:9/x', body: '{"t":"{{{output}}}"}' } },
    { id: 'a_key', type: 'jira.comment', approval: 'auto', optional: true, idempotencyKey: '{{output}}', params: { issue: 'SBK-1', body: 'x' } },
  ] });
  const f = await s.flow('Copias', [st], []);
  let r = await run(f.id);
  assert.equal(r.steps.s_d.status, 'success', r.steps.s_d.error);
  r = await run(f.id);
  assert.equal(r.steps.s_d.status, 'success', 'la segunda ejecución reemplaza su propia copia');
  const by = (id) => r.steps.s_d.declaredActions.find((p) => p.actionId === id);
  assert.match(by('a_raw').error, /sin escapar/);
  assert.match(by('a_key').error, /clave para no repetir no puede salir de la ejecución/);
  // somebody else's file (or ours, edited since) is never replaced
  fs.writeFileSync(path.join(dest, 'mio.md'), 'editado a mano');
  r = await run(f.id);
  assert.equal(r.steps.s_d.status, 'error');
  assert.equal(fs.readFileSync(path.join(dest, 'mio.md'), 'utf8'), 'editado a mano');
});

// ---- third adversarial pass on spec 14 ----
const tj = (name, input, result) => `[[mock:tooljson ${ATL}__${name} ${JSON.stringify({ input, ...(result !== undefined ? { result } : {}) })}]]`;
test('revisión 14c: el destino se verifica en SU campo (sin señuelos), el vínculo por dirección, la transición por evidencia y sin mover páginas', async () => {
  const A = (id, type, params, extra = '') => ({ id, type, approval: 'auto', optional: true, params: { ...params, [type === 'jira.comment' ? 'body' : type.startsWith('confluence') ? 'body' : 'summary']: `x ${extra} ${okJson('K')}` } });
  const st = role('Paso', '[[mock:say ok]]', { id: 's_t', actions: [
    A('decoy', 'jira.comment', { issue: 'SBK-1' }, tj('addCommentToJiraIssue', { issueIdOrKey: 'SBK-999', issue: 'SBK-1', commentBody: 'SBK-1' })),
    A('edit', 'jira.comment', { issue: 'SBK-1' }, tj('addCommentToJiraIssue', { issueIdOrKey: 'SBK-1', commentId: '777', commentBody: 'x' })),
    A('proj', 'jira.createIssue', { project: 'SBK', issueType: 'Bug' }, tj('createJiraIssue', { projectKey: 'OPS', issueTypeName: 'Bug', summary: 's', additional_fields: { labels: { key: 'SBK' } } })),
    A('link', 'jira.link', { from: 'SBK-1', to: 'SBK-2', type: 'Blocks' }, tj('createIssueLink', { inwardIssue: 'SBK-2', outwardIssue: 'SBK-1', type: 'Blocks' })),
    A('page', 'confluence.updatePage', { page: '123' }, tj('updateConfluencePage', { pageId: '999', version: { id: '123' }, body: 'b' })),
    A('move', 'confluence.updatePage', { page: '123' }, tj('updateConfluencePage', { pageId: '123', parentId: '5', body: 'b' })),
    A('trans', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-1' }, { transitions: [{ id: '31', name: 'Done' }, { id: '41', name: 'Won\'t do' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: 'SBK-1', transition: { id: '41' } })}`),
    A('transok', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-1' }, { transitions: [{ id: '31', name: 'Done' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: 'SBK-1', transition: { id: '31' } })}`),
    A('linkok', 'jira.link', { from: 'SBK-1', to: 'SBK-2', type: 'Blocks' }, tj('createIssueLink', { inwardIssue: 'SBK-1', outwardIssue: 'SBK-2', type: 'Blocks' })),
  ] });
  const f = await s.flow('Señuelos', [st], []);
  const r = await run(f.id);
  const by = (id) => r.steps.s_t.declaredActions.find((p) => p.actionId === id);
  for (const id of ['decoy', 'edit', 'proj', 'link', 'page', 'move', 'trans']) { assert.equal(by(id).status, 'error', `${id}: ${by(id).status}`); assert.match(by(id).error, /no usó el destino aprobado/, id); }
  assert.match(by('edit').error, /no debía usar commentId/);
  assert.match(by('trans').error, /no es la de ese estado/);
  for (const id of ['transok', 'linkok']) assert.equal(by(id).status, 'done', `${id}: ${by(id).error}`);
});

test('revisión 14c: {{…}} dentro de la salida del modelo no hace fallar la acción; una variable vacía en el destino sí la frena', async () => {
  const st = role('Bugs', '[[mock:json {"title":"Falla al mostrar {{odds}}"}]]', { id: 's_b', output: { format: 'json' }, actions: [
    { id: 'a_b', type: 'jira.createIssue', approval: 'confirm', params: { project: 'SBK', issueType: 'Bug', summary: '{{output.json.title}}' } },
    { id: 'a_v', type: 'jira.comment', approval: 'confirm', optional: true, params: { issue: '{{vars.issue}}', body: 'x' } },
  ] });
  const f = await s.flow('Llaves', [st], [], { vars: { issue: '' } });
  const r = await run(f.id);
  const by = (id) => r.steps.s_b.declaredActions.find((p) => p.actionId === id);
  assert.equal(by('a_b').status, 'awaiting_approval', by('a_b').error);
  assert.equal(by('a_b').params.summary, 'Falla al mostrar {{odds}}');
  assert.equal(by('a_v').status, 'error');
});

test('revisión 14c: "reiniciar ejecuciones" no rompe un destino fijo; una acción en curso de OTRA ejecución viva no se toma como caída', async () => {
  const dest = path.join(s.dirs.work, `dest3-${Date.now()}`); fs.mkdirSync(dest, { recursive: true });
  const st = role('Paso', '[[mock:say c]]', { id: 's_r', deliverables: [{ id: 'd_m', format: 'md', path: 'r.md', destination: [{ path: dest }] }] });
  const f = await s.flow('Reset', [st], []);
  await run(f.id);
  await s.uiOk('POST', `/api/flows/${f.id}/reset`, { parts: ['runs'] });
  const r = await run(f.id);
  assert.equal(r.steps.s_r.status, 'success', r.steps.s_r.error);
  // a webhook still in flight in run 1 while run 2 plans the same action: no "halfway"
  let release; const gate = new Promise((ok) => { release = ok; });
  const srv = http.createServer(async (req, res) => { req.resume(); await gate; res.writeHead(200); res.end(); });
  await new Promise((rr) => srv.listen(0, '127.0.0.1', rr));
  try {
    const st2 = role('Hook', '[[mock:say y]]', { id: 's_h', actions: [{ id: 'a_h', type: 'http.post', approval: 'auto', params: { url: `http://127.0.0.1:${srv.address().port}/h`, body: 'x' } }] });
    const f2 = await s.flow('Vivas', [st2], [], { policies: [] });
    const { runId: r1 } = await s.uiOk('POST', `/api/flows/${f2.id}/run`, { input: '', breakpoints: false });
    await until(async () => fs.existsSync(path.join(s.dirs.data, 'actions', `${f2.id}.json`)) && /started/.test(fs.readFileSync(path.join(s.dirs.data, 'actions', `${f2.id}.json`), 'utf8')), 8000);
    const { runId: r2 } = await s.uiOk('POST', `/api/flows/${f2.id}/run`, { input: '', breakpoints: false });
    await sleep(800); release();
    const [x1, x2] = [await s.waitRun(f2.id, r1), await s.waitRun(f2.id, r2)];
    assert.equal(x1.steps.s_h.declaredActions[0].status, 'done');
    assert.equal(x2.steps.s_h.declaredActions[0].status, 'done', x2.steps.s_h.declaredActions[0].reason || '');
  } finally { release(); srv.close(); }
});

// ---- fourth adversarial pass on spec 14 ----
test('revisión 14d: additional_fields no mueve el issue; el sub-task va al proyecto del padre; la transición vale solo con la evidencia de ESE issue; vínculo por nombre o frase', async () => {
  const A = (id, type, params, extra, body = 'summary') => ({ id, type, approval: 'auto', optional: true, params: { ...params, [body]: `x ${extra} ${okJson('K')}` } });
  const st = role('Paso', '[[mock:say ok]]', { id: 's_u', actions: [
    A('xf', 'jira.createIssue', { project: 'SBK', issueType: 'Bug' }, tj('createJiraIssue', { projectKey: 'SBK', issueTypeName: 'Bug', summary: 's', additional_fields: { parent: { key: 'OPS-1' }, project: { key: 'OPS' } } })),
    A('sp', 'jira.createSubtask', { parent: 'SBK-1' }, tj('createJiraIssue', { projectKey: 'OPS', issueTypeName: 'Subtask', parent: 'SBK-1', summary: 's' })),
    A('tr', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-2' }, { transitions: [{ id: '31', name: 'Done' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: 'SBK-1', transition: { id: '31' } })}`, 'issue2'),
    A('trf', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-1' }, { transitions: [{ id: '31', name: 'Done' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: 'SBK-1', transition: { id: '31' }, fields: { resolution: { name: "Won't Do" } } })}`, 'issue2'),
    A('lk', 'jira.link', { from: 'SBK-1', to: 'SBK-2', type: 'relates to' }, `${tj('getIssueLinkTypes', {}, { issueLinkTypes: [{ id: '1', name: 'Relates', inward: 'relates to', outward: 'relates to' }] })} ${tj('createIssueLink', { inwardIssue: 'SBK-1', outwardIssue: 'SBK-2', type: 'Relates' })}`, 'note'),
    A('num', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getJiraIssue', { issueIdOrKey: 'SBK-1' }, { id: '10234', key: 'SBK-1', fields: { cf: { key: 'SBK-1', id: '55555' } } })} ${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-1' }, { transitions: [{ id: '31', name: 'Done' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: '10234', transition: { id: '31' } })}`, 'issue2'),
    A('num2', 'jira.transition', { issue: 'SBK-1', to: 'Done' }, `${tj('getJiraIssue', { issueIdOrKey: 'SBK-1' }, { id: '10234', key: 'SBK-1', fields: { cf: { key: 'SBK-1', id: '55555' } } })} ${tj('getTransitionsForJiraIssue', { issueIdOrKey: 'SBK-1' }, { transitions: [{ id: '31', name: 'Done' }] })} ${tj('transitionJiraIssue', { issueIdOrKey: '55555', transition: { id: '31' } })}`, 'issue2'),
    A('lkc', 'jira.link', { from: 'SBK-1', to: 'SBK-2', type: 'Relates' }, tj('createIssueLink', { inwardIssue: 'SBK-1', outwardIssue: 'SBK-2', type: 'Relates', comment: 'texto libre' }), 'note'),
    A('ttl', 'confluence.updatePage', { page: '123' }, tj('updateConfluencePage', { pageId: '123', title: 'Otro título', body: 'b' }), 'body'),
  ] });
  const f = await s.flow('Señuelos 2', [st], []);
  const r = await run(f.id);
  const by = (id) => r.steps.s_u.declaredActions.find((p) => p.actionId === id);
  assert.match(by('xf').error, /no debía usar additional_fields\.parent/);
  assert.match(by('sp').error, /no es el del padre SBK-1/);
  assert.match(by('tr').error, /getTransitionsForJiraIssue de SBK-1/);
  assert.match(by('trf').error, /no debía usar fields/);
  assert.equal(by('lk').status, 'done', by('lk').error);
  assert.equal(by('num').status, 'done', by('num').error);
  assert.match(by('num2').error, /no usó el destino aprobado/, 'el id de un campo anidado no es evidencia');
  assert.match(by('lkc').error, /no debía usar comment/);
  assert.match(by('ttl').error, /title=\(ninguno\)/);
});

// ---- code review of the session (specs 10/14/15/28/30) ----
test('code review: un entregable inválido corre UNA vez las acciones "si falla"; una condición inválida falla solo esa acción; YAML con tab en cualquier línea', async () => {
  let posts = 0;
  const srv = http.createServer((req, res) => { posts++; req.resume(); res.writeHead(200); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    const yml = JSON.stringify({ y: 'a:\n  b: 1\nc:\n\td: 2' });
    const st = role('Paso', `[[mock:json ${yml}]]`, { id: 's_cr', output: { format: 'json' },
      deliverables: [{ id: 'd_y', format: 'yaml', path: 'x.yaml', from: 'json.y' }],
      actions: [
        { id: 'a_f', type: 'http.post', when: 'failure', approval: 'auto', params: { url, body: 'falló' } },
        { id: 'a_rx', type: 'http.post', when: 'failure', approval: 'auto', optional: true, if: { type: 'regex', pattern: '(' }, params: { url, body: 'x' } },
      ] });
    const next = cmd('Después', 'Write-Output fin', { id: 's_cr2' });
    const f = await s.flow('Falla una vez', [st, next], [], { policies: [] });
    const r = await run(f.id);
    assert.equal(r.steps.s_cr.status, 'error');
    assert.match(r.steps.s_cr.error, /tabuladores/);
    const by = (id) => r.steps.s_cr.declaredActions.filter((p) => p.actionId === id);
    assert.equal(by('a_f').length, 1, 'planificada una sola vez');
    assert.equal(posts, 1, 'el webhook "si falla" se envió una sola vez');
    assert.match(by('a_rx')[0].error, /condición inválida/);
    assert.equal(r.steps.s_cr2.status, 'success', 'el resto de la ejecución sigue');
  } finally { srv.close(); }
});

test('code review: en "para cada" un nombre fijo con carpeta destino no pisa la copia de otro elemento; la vista del flujo marca los datos recortados', async () => {
  const dest = path.join(s.dirs.work, `dest-cr-${Date.now()}`); fs.mkdirSync(dest, { recursive: true });
  const src = role('Lista', '[[mock:json {"t":["A","B"]}]]', { id: 's_l3', output: { format: 'json' } });
  const each = role('Cada', 'r {{item}} [[mock:echo]]', { id: 's_e3', forEach: { path: 't' }, deliverables: [
    { id: 'd_fix', format: 'txt', path: 'fijo.txt', destination: [{ path: dest }] },
    { id: 'd_idx', format: 'txt', path: 'r-{{item.index}}.txt', destination: [{ path: dest }] },
  ] });
  const f = await s.flow('Copias por elemento', [src, each], [['s_l3', 's_e3']]);
  const r = await run(f.id);
  assert.equal(r.steps['s_e3~1'].status, 'success', r.steps['s_e3~1'].error);
  assert.match(r.steps['s_e3~2'].error || '', /otro elemento de esta ejecución/);
  assert.match(fs.readFileSync(path.join(dest, 'fijo.txt'), 'utf8'), /r A/, 'la copia del elemento 1 sigue');
  assert.ok(fs.existsSync(path.join(dest, 'r-1.txt')) && fs.existsSync(path.join(dest, 'r-2.txt')));
  // a second run may replace its own earlier copies (same flow, other run)
  const r2 = await run(f.id);
  assert.equal(r2.steps['s_e3~1'].status, 'success', r2.steps['s_e3~1'].error);
  // long params: the flow-file view is clipped and says so (no "edit and approve" over it)
  const long = 'x'.repeat(400);
  const st = role('Largo', '[[mock:say ok]]', { id: 's_lg', actions: [{ id: 'a_lg', type: 'jira.comment', approval: 'confirm', params: { issue: 'SBK-1', body: long } }] });
  const f2 = await s.flow('Recorte', [st], []);
  const r3 = await run(f2.id);
  assert.equal(r3.steps.s_lg.declaredActions[0].params.body, long, 'el registro de la ejecución lo tiene entero');
  const g = await s.getFlow(f2.id);
  assert.equal(g.steps[0].lastRun.declaredActions[0].paramsClipped, true);
});

test('code review: "Detener" corta una acción en curso', async () => {
  const srv = http.createServer(() => {}); // never answers
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const st = role('Hook', '[[mock:say y]]', { id: 's_st', actions: [{ id: 'a_st', type: 'http.post', approval: 'auto', params: { url: `http://127.0.0.1:${srv.address().port}/h`, body: 'x' } }] });
    const f = await s.flow('Detener acción', [st], [], { policies: [] });
    const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
    await until(async () => fs.existsSync(path.join(s.dirs.data, 'actions', `${f.id}.json`)) && /started/.test(fs.readFileSync(path.join(s.dirs.data, 'actions', `${f.id}.json`), 'utf8')), 8000);
    const t0 = Date.now();
    await s.uiOk('POST', `/api/flows/${f.id}/stop`, {});
    const r = await s.waitRun(f.id, runId);
    assert.ok(Date.now() - t0 < 15000, 'no esperó los 3 minutos');
    assert.match(r.steps.s_st.declaredActions[0].error || '', /ejecución detenida/);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
