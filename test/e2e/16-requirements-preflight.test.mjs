// Spec 23: flow requirements / preflight. A flow declares what the machine needs (tools, files such as a secrets file,
// env vars, reachable services, MCP connectors); they are checked before each run and explained to whoever runs it.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, role, cmd, sleep, ROOT } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let s; let web; let webUrl;
before(async () => {
  s = await startServer({ name: 'reqs', env: { AFS_TEST_REQ_VAR: 'si' } }); await s.start();
  web = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webUrl = `http://127.0.0.1:${web.address().port}/`;
});
after(async () => { await s?.stop(); web?.close(); });

const results = async (flowId) => (await s.uiOk('GET', `/api/flows/${flowId}/preflight?fresh=1`));
const byType = (pf, t) => pf.results.filter((r) => r.type === t);

test('comprobaciones: herramienta (instalada / no instalada / instalada pero falla), archivo, variable de entorno, URL, conector MCP', async () => {
  const secrets = path.join(s.dirs.work, 'nada', 'secrets.env');
  const f = await s.flow('Requisitos', [role('A', '[[mock:say a]]')], [], {
    vars: { env_file: secrets },
    requirements: [
      { id: 'r1', type: 'tool', name: 'node', check: 'node --version' },
      { id: 'r2', type: 'tool', name: 'herramienta-que-no-existe-xyz' },
      { id: 'r3', type: 'tool', name: 'node', check: 'node -e "process.exit(3)"', label: 'Node que falla' },
      { id: 'r4', type: 'file', path: '{{vars.env_file}}', template: 'API_USER=\nAPI_PASSWORD=\n' },
      { id: 'r5', type: 'env', name: 'AFS_TEST_REQ_VAR' },
      { id: 'r6', type: 'env', name: 'AFS_NO_DEFINIDA_XYZ', optional: true },
      { id: 'r7', type: 'url', url: webUrl },
      { id: 'r8', type: 'url', url: 'http://127.0.0.1:9/', optional: true },
      { id: 'r9', type: 'mcp', server: 'mock-mcp' },
    ],
  });
  let pf = await results(f.id);
  const r = Object.fromEntries(pf.results.map((x) => [x.id, x]));
  assert.equal(r.r1.ok, true); assert.match(r.r1.detail, /^v\d+/);
  assert.equal(r.r2.ok, false); assert.match(r.r2.detail, /no está instalada/);
  assert.equal(r.r3.ok, false); assert.match(r.r3.detail, /instalada, pero/);
  assert.equal(r.r4.ok, false); assert.equal(r.r4.canCreate, true); assert.match(r.r4.detail, /no existe/);
  assert.equal(r.r5.ok, true);
  assert.equal(r.r6.ok, false); assert.equal(r.r6.optional, true);
  assert.equal(r.r7.ok, true); assert.match(r.r7.detail, /HTTP 200/);
  assert.equal(r.r8.ok, false);
  assert.equal(r.r9.ok, null, 'MCP sin comprobar todavía');
  assert.deepEqual(pf.blocking.map((x) => x.id).sort(), ['r2', 'r3', 'r4']);
  assert.equal(pf.ok, false);
  pf = await s.uiOk('GET', `/api/flows/${f.id}/preflight?fresh=1&probe=1`);
  assert.equal(pf.results.find((x) => x.id === 'r9').ok, true, 'tras comprobar el conector');
  assert.ok(pf.results.every((x) => x.help), 'cada requisito explica cómo resolverlo');
});

test('archivo de secretos desde plantilla: se crea con las claves, nunca se sobrescribe, y avisa mientras falten valores', async () => {
  const secrets = path.join(s.dirs.work, 'sec', 'qa.env');
  const f = await s.flow('Secretos', [role('A', 'x')], [], { vars: { env_file: secrets }, requirements: [{ id: 'f1', type: 'file', path: '{{vars.env_file}}', template: '# completa\nAPI_USER=\nAPI_PASSWORD=\n' }] });
  const c = await s.uiOk('POST', `/api/flows/${f.id}/requirements/f1/create-file`, {});
  assert.equal(path.resolve(c.path), path.resolve(secrets));
  assert.match(fs.readFileSync(secrets, 'utf8'), /API_USER=\r?\nAPI_PASSWORD=/);
  let pf = await results(f.id);
  assert.equal(pf.results[0].ok, false);
  assert.match(pf.results[0].detail, /faltan valores en .*: API_USER, API_PASSWORD/);
  fs.writeFileSync(secrets, 'API_USER=qa\nAPI_PASSWORD=secreto\n');
  pf = await results(f.id);
  assert.equal(pf.results[0].ok, true);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/requirements/f1/create-file`, {})).body.code, 'FILE_EXISTS');
  assert.equal(fs.readFileSync(secrets, 'utf8'), 'API_USER=qa\nAPI_PASSWORD=secreto\n', 'no se tocó');
});

test('bloqueo: si falta algo obligatorio no arranca (UI, step suelto, API externa, afs); lo recomendado no bloquea; el dry run lo informa', async () => {
  const f = await s.flow('Bloquea', [cmd('A', 'Write-Output a', { id: 's_ba' })], [], { requirements: [{ id: 'x1', type: 'tool', name: 'herramienta-que-no-existe-xyz', help: 'Instálala desde el portal interno' }, { id: 'x2', type: 'env', name: 'AFS_NO_DEFINIDA_XYZ', optional: true }] });
  const ui = await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' });
  assert.equal(ui.status, 412); assert.equal(ui.body.code, 'PREFLIGHT_FAILED');
  assert.deepEqual(ui.body.missing.map((m) => m.id), ['x1']);
  assert.match(ui.body.error, /Instálala desde el portal interno/);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/steps/s_ba/run`, { input: '' })).status, 412);
  const ext = await s.runExt(f.id, {});
  assert.equal(ext.status, 412); assert.equal(ext.body.code, 'PREFLIGHT_FAILED');
  const dry = await s.ext('POST', `/flows/${f.id}/run`, { dryRun: true });
  assert.equal(dry.body.ok, false);
  assert.deepEqual(dry.body.preflight.missing.map((m) => m.id), ['x1']);
  const afs = await s.afs(['run', f.id, '-i', 'x']);
  assert.equal(afs.code, 2);
  assert.match(afs.stderr, /PREFLIGHT_FAILED/);
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/runs`)).length, 0, 'no se creó ninguna ejecución');
  // only the recommended one missing → runs
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, requirements: [g.requirements[1]] });
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'success');
  // flows without requirements are unaffected
  const plain = await s.flow('Sin requisitos', [cmd('B', 'Write-Output b')]);
  assert.equal((await s.runUi(plain.id)).status, 'success');
});

test('sugerencias a partir de lo que usa el flujo: docker/git/kubectl en comandos y accesos, Atlassian, archivos y URLs en variables; saneo al guardar', async () => {
  const f = await s.flow('Sugerir', [
    cmd('Build', 'docker compose -f x.yml build; git status', { id: 's_s1' }),
    role('Deploy', 'x', { id: 's_s2', allowedTools: 'Read Bash(kubectl:*) Bash(argo:*)', contextSources: [{ id: 'j', type: 'jira', ref: 'SBK-1' }] }),
  ], [], { vars: { env_file: 'C:\\Users\\alguien\\.afs\\secrets\\qa.env', base_url: 'https://qa.example.com/api', repo: 'https://host/x.git' } });
  const sug = await s.uiOk('GET', `/api/flows/${f.id}/requirements/suggest`);
  const keys = sug.map((x) => `${x.type}:${x.name || x.server || x.path || x.url}`);
  for (const k of ['tool:docker', 'tool:git', 'tool:kubectl', 'tool:argo', 'mcp:Atlassian', 'file:{{vars.env_file}}', 'url:{{vars.base_url}}']) assert.ok(keys.includes(k), `${k} en ${keys}`);
  assert.ok(!keys.includes('url:{{vars.repo}}'), 'una URL de clonado no es un servicio');
  assert.equal(sug.find((x) => x.name === 'docker').check, 'docker info --format "{{.ServerVersion}}"');
  assert.ok(sug.find((x) => x.type === 'file').template, 'el archivo de secretos trae plantilla');
  const g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, requirements: [...sug, { type: 'otra' }, { type: 'tool', name: 'x', help: 'h'.repeat(9000) }] });
  assert.equal(g.requirements.length, sug.length + 1);
  assert.equal(g.requirements.at(-1).help.length, 2000);
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${f.id}/requirements/suggest`), [], 'lo ya agregado no se vuelve a sugerir');
});

// ---------------- browser ----------------
let ui = {};
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
afterEach(async (t) => { await captureOnFailure(ui.page, t); });
after(async () => { await ui.close?.(); });

test('UI: al ejecutar con requisitos faltantes aparece "Antes de ejecutar…" con la ayuda; crear el archivo desde la plantilla, comprobar y ejecutar', async (t) => {
  ui = await openUi('reqsui');
  if (guard(t)) return;
  const { s: u, page } = ui;
  const secrets = path.join(u.dirs.work, 'ui', 'qa.env');
  const f = await u.flow('Requisitos UI', [cmd('Paso', 'Write-Output listo', { id: 's_rq', position: { x: 120, y: 120 } })], [], {
    vars: { env_file: secrets },
    requirements: [{ id: 'q1', type: 'file', path: '{{vars.env_file}}', template: '# solo comentarios\n', help: 'Pide el archivo al equipo y guárdalo ahí' }],
  });
  await page.goto(`${u.base}/?flow=${f.id}`);
  await page.locator('.warn-chip', { hasText: 'Faltan 1 requisito' }).waitFor();
  await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
  await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
  await page.getByText('Antes de ejecutar este flujo').waitFor();
  await page.getByText('Pide el archivo al equipo y guárdalo ahí').waitFor();
  await page.getByRole('button', { name: '📄 Crear desde plantilla' }).click();
  await page.getByRole('button', { name: '✔ Todo listo' }).click();
  await page.locator('.node.st-success', { hasText: 'Paso' }).waitFor();
  assert.ok(fs.existsSync(secrets));
  await page.locator('.warn-chip').waitFor({ state: 'detached' });
  // the editor in Flujo: suggest + add
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.locator('.tabs button', { hasText: 'Flujo' }).first().click();
  const box = page.locator('[data-testid="flow-requirements"]');
  await box.getByText('Qué necesita tener instalado').waitFor();
  await box.getByRole('button', { name: '+ 🧰 Herramienta' }).click();
  await box.locator('.req-item[data-type="tool"] input.mono').first().fill('node');
  await box.locator('.ok-text', { hasText: '✓' }).first().waitFor();
  assert.deepEqual(page.errors, []);
});
