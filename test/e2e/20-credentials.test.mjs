// Spec 26: 🔑 Credenciales. Tokens in one place, encrypted on this machine, never returned by the API, never exported,
// never in an AI prompt; commands use {{cred.name.field}} (value via env var, masked in outputs); flows that use a
// missing credential are blocked before running with a clear item; "Probar conexión"; import from a .env file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, role, cmd } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let s;
before(async () => { s = await startServer({ name: 'cred' }); await s.start(); });
after(async () => { await s?.stop(); });
const TOKEN = 'tok-SUPER-secreto-123';

test('alta, edición y borrado: la API nunca devuelve el secreto, se guarda cifrado fuera de texto plano, nombres válidos y únicos', async () => {
  const c = await s.uiOk('POST', '/api/credentials', { type: 'jira', name: 'Jira-Prueba', fields: { url: 'https://x.atlassian.net/', user: 'yo@x.com', token: TOKEN } });
  assert.equal(c.name, 'jira-prueba');
  assert.deepEqual(c.fields, { url: 'https://x.atlassian.net', user: 'yo@x.com', token: { set: true } });
  assert.deepEqual(c.refs, ['{{cred.jira-prueba.url}}', '{{cred.jira-prueba.user}}', '{{cred.jira-prueba.token}}']);
  const list = await s.uiOk('GET', '/api/credentials');
  assert.ok(!JSON.stringify(list).includes(TOKEN), 'la lista no trae el token');
  const raw = fs.readFileSync(path.join(s.dirs.data, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes(TOKEN), 'cifrado en disco');
  assert.ok(fs.existsSync(path.join(s.dirs.home, '.afs', 'credentials.key')), 'la clave vive fuera de data/');
  // editing without the secret keeps it; a new value replaces it
  const e1 = await s.uiOk('PUT', `/api/credentials/${c.id}`, { fields: { user: 'otro@x.com', token: '' } });
  assert.deepEqual(e1.fields.token, { set: true });
  assert.equal(e1.fields.user, 'otro@x.com');
  assert.equal((await s.ui('POST', '/api/credentials', { type: 'jira', name: 'jira-prueba' })).status, 409);
  assert.equal((await s.ui('POST', '/api/credentials', { type: 'jira', name: '9 mal nombre' })).status, 400);
  assert.equal((await s.ui('POST', '/api/credentials', { type: 'raro', name: 'x' })).status, 400);
  assert.deepEqual(await s.uiOk('DELETE', `/api/credentials/${c.id}`), { deleted: true });
  assert.equal((await s.uiOk('GET', '/api/credentials')).items.length, 0);
});

test('en un comando: el valor va por variable de entorno, nunca en el texto del comando ni en la salida (••••); en un prompt de IA nunca se inserta', async () => {
  await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'svc', fields: { user: 'robot', value: TOKEN } });
  const a = cmd('Usa token', 'Write-Output "user={{cred.svc.user}} len=$(\'{{cred.svc.value}}\'.Length)"; Write-Output "eco={{cred.svc.value}}"', { id: 's_c' });
  const b = role('IA', 'Usa {{cred.svc.value}} para algo [[mock:echo]]', { id: 's_ai' });
  const f = await s.flow('Con credencial', [a, b]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  const c = run.steps.s_c;
  assert.equal(c.status, 'success', c.error);
  assert.match(c.output, /user=robot/);
  assert.match(c.output, /eco=••••/, 'tapado en la salida');
  assert.ok(!JSON.stringify(run).includes(TOKEN), 'no aparece en ninguna parte de la ejecución (salida, actividad, comando)');
  assert.ok(c.inputView.values.some((v) => v.ref === 'cred.svc.value' && v.value === '••••'));
  const ai = s.callsSince(n).find((x) => /Usa \[credencial no disponible en prompts: cred\.svc\.value\]/.test(x.prompt));
  assert.ok(ai, 'el prompt recibe un marcador, no el valor');
  assert.ok(!s.callsSince(n).some((x) => x.prompt.includes(TOKEN) || x.system?.includes(TOKEN)));
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_ai/preview`, {});
  assert.ok(pv.warnings.some((w) => w.code === 'CRED_IN_PROMPT'));
});

test('credencial faltante: no arranca (UI, step suelto, API externa, dry run) con el ítem "Credencial x.y" y su ayuda; al cargarla, corre', async () => {
  const a = cmd('Pide jira', 'Write-Output "{{cred.jira2.url}}"', { id: 's_j' });
  const f = await s.flow('Falta credencial', [a]);
  const ui = await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' });
  assert.equal(ui.status, 412);
  assert.equal(ui.body.missing[0].type, 'credential');
  assert.equal(ui.body.missing[0].label, 'Credencial jira2.url');
  assert.match(ui.body.missing[0].help, /no existe: cárgala en ⚙ Configuración › Credenciales/);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/steps/s_j/run`, { input: '' })).status, 412);
  assert.equal((await s.ext('POST', `/flows/${f.id}/run`, { input: 'x' })).status, 412);
  const dry = await s.ext('POST', `/flows/${f.id}/run?dryRun=1`, { input: 'x' });
  assert.equal(dry.body.ok, false);
  const pf = await s.uiOk('GET', `/api/flows/${f.id}/preflight?fresh=1`);
  assert.equal(pf.results[0].implicit, true);
  const cr = await s.uiOk('POST', '/api/credentials', { type: 'jira', name: 'jira2', fields: { url: 'https://ok.atlassian.net' } });
  assert.match((await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' })).body.missing?.[0]?.label || 'ok', /ok/, 'url cargada: no falta nada para este flujo');
  const run = await s.runUi(f.id);
  assert.match(run.steps.s_j.output, /https:\/\/ok\.atlassian\.net/);
  // a credential that lacks the field the command uses
  const b = cmd('Pide token', 'Write-Output "{{cred.jira2.token}}"', { id: 's_t' });
  const g = await s.flow('Falta campo', [b]);
  const r = await s.ui('POST', `/api/flows/${g.id}/run`, { input: '' });
  assert.match(r.body.missing[0].help, /le falta "API token"/);
  await s.uiOk('DELETE', `/api/credentials/${cr.id}`);
});

test('"Probar conexión" (Jira: /rest/api/3/myself con usuario y token) y fallo 401; tipos sin prueba', async () => {
  const fake = http.createServer((req, res) => {
    const ok = req.url === '/rest/api/3/myself' && req.headers.authorization === `Basic ${Buffer.from(`yo@x.com:${TOKEN}`).toString('base64')}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }); res.end(JSON.stringify(ok ? { displayName: 'Yo Mismo' } : {}));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${fake.address().port}`;
  try {
    const c = await s.uiOk('POST', '/api/credentials', { type: 'jira', name: 'jira-test', fields: { url, user: 'yo@x.com', token: TOKEN } });
    const t1 = await s.uiOk('POST', `/api/credentials/${c.id}/test`, {});
    assert.equal(t1.ok, true);
    assert.equal(t1.detail, 'Conectado como Yo Mismo');
    assert.equal(t1.credential.lastTest.ok, true);
    await s.uiOk('PUT', `/api/credentials/${c.id}`, { fields: { token: 'malo' } });
    const t2 = await s.uiOk('POST', `/api/credentials/${c.id}/test`, {});
    assert.equal(t2.ok, false);
    assert.match(t2.detail, /Rechazado \(401\)/);
    const g = await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'gen-test', fields: { value: 'x1234' } });
    assert.match((await s.uiOk('POST', `/api/credentials/${g.id}/test`, {})).detail, /no tiene prueba/);
  } finally { fake.close(); }
});

test('importar desde un .env: solo se listan los nombres; el valor elegido se copia en el servidor', async () => {
  const env = path.join(s.tmp, 'mi.env');
  fs.writeFileSync(env, `# comentario\nToken_Jira="${TOKEN}"\nOTRA=valor\n`);
  const keys = await s.uiOk('POST', '/api/credentials/env-keys', { file: env });
  assert.deepEqual(keys, { keys: ['Token_Jira', 'OTRA'] });
  const c = await s.uiOk('POST', '/api/credentials', { type: 'jira', name: 'desde-env', fields: { url: 'https://e.atlassian.net', user: 'yo@x.com' } });
  const up = await s.uiOk('POST', `/api/credentials/${c.id}/import-env`, { file: env, key: 'Token_Jira', field: 'token' });
  assert.deepEqual(up.fields.token, { set: true });
  const a = cmd('Comprueba', 'if ("{{cred.desde-env.token}}" -eq "tok-SUPER-secreto-123") { "igual" } else { "distinto" }', { id: 's_e' });
  const f = await s.flow('Env', [a]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_e.output, 'igual', 'el valor importado es el del .env');
  assert.equal((await s.ui('POST', `/api/credentials/${c.id}/import-env`, { file: env, key: 'NO_EXISTE', field: 'token' })).status, 400);
  assert.equal((await s.ui('POST', '/api/credentials/env-keys', { file: path.join(s.tmp, 'nada.env') })).status, 400);
});

test('exportar nunca lleva credenciales; al importar en otra máquina avisa cuáles faltan cargar', async () => {
  await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'solo-aqui', fields: { value: TOKEN } });
  const a = cmd('Usa', 'Write-Output "{{cred.solo-aqui.value}} {{cred.otra-maquina.value}}"', { id: 's_x' });
  const f = await s.flow('Exporta', [a]);
  const bundle = await s.uiOk('GET', `/api/flows/${f.id}/export`);
  assert.ok(!JSON.stringify(bundle).includes(TOKEN));
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle });
  assert.ok(imp.warnings.some((w) => /no están cargadas en esta máquina: otra-maquina\./.test(w)), JSON.stringify(imp.warnings));
});

test('UI: ⚙ Configuración › Credenciales; alta de una credencial Jira con el token oculto; se ven sus referencias y nunca el valor', async (t) => {
  const u = await openUi('cred-ui');
  if (u.skipReason) { t.skip(u.skipReason); return; }
  const { page } = u;
  try {
    await page.goto(u.s.base + '/');
    await page.getByTestId('settings-btn').click(); // ⚙ Configuración › Credenciales (spec 27)
    await page.getByRole('button', { name: '+ Nueva credencial' }).click();
    await page.getByTestId('cred-name').fill('jira');
    await page.getByTestId('cred-field-url').fill('https://empresa.atlassian.net');
    await page.getByTestId('cred-field-user').fill('yo@empresa.com');
    assert.equal(await page.getByTestId('cred-field-token').getAttribute('type'), 'password');
    await page.getByTestId('cred-field-token').fill(TOKEN);
    await page.getByRole('button', { name: 'Guardar' }).click();
    const row = page.getByTestId('cred-jira');
    await row.getByText('{{cred.jira.token}}').waitFor();
    await row.getByText(/token: ••••/).waitFor();
    assert.ok(!(await page.content()).includes(TOKEN), 'el token no está en la página');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { name: t.name, passed: false }); throw e; }
  finally { await u.close?.(); }
});
