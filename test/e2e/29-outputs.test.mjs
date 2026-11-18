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

test('UI: agregar una acción "confirmar", ejecutar, aprobarla en Datos; el nodo muestra ⚡ y ⏳ mientras espera', async (t) => {
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
    await box.getByTestId('action-add').selectOption('jira.transition');
    await box.getByTestId('action-issue').fill('SBK-5');
    await box.getByTestId('action-to').fill(`Done [[mock:tool ${ATL}__transitionJiraIssue SBK-5]] ${okJson('SBK-5')}`);
    await nodeLoc.getByText('⚡ 1').waitFor();
    let g;
    for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.steps[0].actions?.[0]?.params?.to?.includes('Done')) break; await sleep(150); }
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
    assert.equal(by('a_other').status, 'error'); assert.match(by('a_other').error, /no usó el destino aprobado \(issue=SBK-1\)/);
    assert.equal(by('a_twice').status, 'error'); assert.match(by('a_twice').error, /Se llamó 2 veces/);
    assert.equal(by('a_json').status, 'done', by('a_json').error);
    assert.deepEqual(JSON.parse(got), { text: 'hola "mundo"\n, "channel":"#general' }, 'una sola clave: el texto no inyecta campos');
    assert.equal(by('a_url').status, 'error'); assert.match(by('a_url').error, /no puede salir de la ejecución/);
  } finally { srv.close(); }
});
