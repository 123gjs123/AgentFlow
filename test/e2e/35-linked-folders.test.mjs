// Spec 09 WS-8/9/10/11: flows linked from an outside folder (e.g. a git repo). Only flow.json lives there; state, chats,
// runs and trust stay in the app. An outside edit that changes what executes puts the flow back in quarantine.
// Offline: command steps + the mock Claude CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, cmd, role, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'linked', env: { AFS_REVEAL: '0' } }); await s.start(); });
after(async () => { await s?.stop(); });
let n = 0;
const repoDir = (name = `repo${++n}`) => { const d = path.join(s.tmp, 'repos', name); fs.mkdirSync(d, { recursive: true }); return d; };
const writeDef = (dir, def) => fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify({ format: 'agent-flow-studio/flow', formatVersion: 1, ...def }, null, 2));
const readDef = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
const editDef = (dir, fn) => { const d = readDef(dir); fn(d); fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(d, null, 2)); };
const link = (p, extra = {}) => s.ui('POST', '/api/flows/link', { path: p, ...extra });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(100); } };
const roleOnly = (id, name = 'Vinculado') => ({ id, name, description: 'en un repo', vars: { env: 'qa' }, steps: [role('Saluda', '[[mock:say hola]]', { id: 's_r', allowedTools: 'Read Grep Glob', position: { x: 0, y: 0 } })], edges: [] });

test('WS-8: vincular una carpeta con solo roles: sin cuarentena, aparece como vinculado, corre, y en la app queda el estado (no flow.json)', async () => {
  const dir = repoDir();
  writeDef(dir, roleOnly('f_link01'));
  const r = await link(dir);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.quarantine, null);
  const item = (await s.uiOk('GET', '/api/flows')).find((f) => f.id === 'f_link01');
  assert.equal(item.origin, 'linked'); assert.equal(item.available, true); assert.equal(path.resolve(item.path), fs.realpathSync.native(dir));
  assert.equal((await s.runUi('f_link01')).status, 'success');
  const side = s.flowDir('f_link01');
  assert.ok(fs.existsSync(path.join(side, 'state.json')) && fs.existsSync(path.join(side, 'runs')));
  assert.ok(!fs.existsSync(path.join(side, 'flow.json')), 'la definición vive en la carpeta vinculada');
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')) && !fs.existsSync(path.join(dir, 'runs')), 'nada de la máquina en el repo');
});

test('WS-8/WS-7: vincular un flujo con comandos lo deja en cuarentena (UI, API, step suelto); "Revisé este flujo" lo habilita', async () => {
  const dir = repoDir();
  writeDef(dir, { id: 'f_link02', name: 'Con comando', steps: [cmd('Eco', 'Write-Output hola', { id: 's_c' })], edges: [] });
  const r = await link(dir);
  assert.ok(r.body.quarantine?.reasons.some((x) => /vinculado desde/.test(x)), JSON.stringify(r.body.quarantine));
  assert.equal((await s.ui('POST', '/api/flows/f_link02/run', { input: '' })).status, 423);
  assert.equal((await s.ui('POST', '/api/flows/f_link02/steps/s_c/run', { input: '' })).status, 423);
  assert.equal((await s.ext('POST', '/flows/f_link02/run', { wait: true })).status, 423);
  const g = await s.getFlow('f_link02');
  await s.uiOk('PUT', '/api/flows/f_link02', { ...g, description: 'cambio en la app' });
  assert.ok((await s.getFlow('f_link02')).quarantine, 'guardar no levanta la cuarentena');
  await s.uiOk('POST', '/api/flows/f_link02/trust', {});
  assert.equal((await s.runUi('f_link02')).status, 'success');
});

test('WS-8: un cambio de afuera que agrega o cambia lo que se ejecuta vuelve a poner cuarentena (también un comando largo cambiado después del carácter 120 o el directorio); queda una versión «Antes del cambio externo»', async () => {
  const dir = repoDir();
  const long = `Write-Output "${'x'.repeat(130)}"`;
  writeDef(dir, { id: 'f_link03', name: 'Cambia afuera', steps: [cmd('Largo', long, { id: 's_l' }), role('Charla', 'x', { id: 's_r' })], edges: [] });
  await link(dir); await s.uiOk('POST', '/api/flows/f_link03/trust', {});
  // only labels and positions: no quarantine
  editDef(dir, (d) => { d.name = 'Cambia afuera (renombrado)'; d.description = 'otra'; d.steps[1].position = { x: 50, y: 9 }; d.quarantine = null; d.trust = { fp: 'falso' }; });
  let f = await s.getFlow('f_link03');
  assert.equal(f.name, 'Cambia afuera (renombrado)'); assert.equal(f.quarantine, undefined, 'etiquetas y posiciones no cuentan');
  // the end of a long command
  editDef(dir, (d) => { d.steps[0].command = `${long.slice(0, -2)}Y"`; });
  f = await s.getFlow('f_link03');
  assert.ok(f.quarantine?.reasons.some((x) => /cambió fuera de la app/.test(x)), JSON.stringify(f.quarantine));
  assert.equal((await s.ui('POST', '/api/flows/f_link03/run', { input: '' })).status, 423);
  const vs = await s.uiOk('GET', '/api/flows/f_link03/versions');
  assert.ok(vs.some((v) => v.label === 'Antes del cambio externo'));
  await s.uiOk('POST', '/api/flows/f_link03/trust', {});
  // a new working folder from outside
  const elsewhere = repoDir();
  editDef(dir, (d) => { d.cwd = elsewhere; });
  assert.ok((await s.getFlow('f_link03')).quarantine, 'cambiar el directorio de trabajo desde afuera');
  await s.uiOk('POST', '/api/flows/f_link03/trust', {});
  // a task change on a flow that has no executable parts beyond roles is accepted (same rule as an import)
  const dir2 = repoDir(); writeDef(dir2, roleOnly('f_link03b'));
  await link(dir2);
  editDef(dir2, (d) => { d.steps[0].task = '[[mock:say otra cosa]]'; });
  assert.equal((await s.getFlow('f_link03b')).quarantine, undefined);
  // …but turning a role into one that can run Bash is not
  editDef(dir2, (d) => { d.steps[0].allowedTools = 'Read Bash'; });
  assert.ok((await s.getFlow('f_link03b')).quarantine);
});

test('WS-8: un cambio de afuera mientras corre lo detiene; la definición nueva nunca se ejecuta', async () => {
  const dir = repoDir();
  const marker = path.join(s.tmp, 'no-debe-existir.txt');
  writeDef(dir, { id: 'f_link04', name: 'Corriendo', steps: [cmd('Lento', 'Start-Sleep -Seconds 4; Write-Output a', { id: 's_1' }), cmd('Después', 'Write-Output b', { id: 's_2' })], edges: [{ id: 'e1', source: 's_1', target: 's_2' }] });
  await link(dir); await s.uiOk('POST', '/api/flows/f_link04/trust', {});
  const { runId } = await s.uiOk('POST', '/api/flows/f_link04/run', { input: '' });
  await sleep(600);
  editDef(dir, (d) => { d.steps[1].command = `Set-Content -Path '${marker}' -Value x`; });
  await s.getFlow('f_link04');
  const run = await s.waitRun('f_link04', runId, 30000);
  assert.equal(run.status, 'stopped', run.status);
  assert.ok(!fs.existsSync(marker), 'el comando cambiado afuera no corrió');
});

test('WS-8: una pestaña con datos de antes del cambio externo recibe 409 FLOW_CONFLICT', async () => {
  const dir = repoDir(); writeDef(dir, roleOnly('f_link05'));
  await link(dir);
  const g = await s.getFlow('f_link05');
  editDef(dir, (d) => { d.description = 'desde git'; });
  const r = await s.ui('PUT', '/api/flows/f_link05', { ...g, baseRev: g.rev || 0, description: 'desde la pestaña' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'FLOW_CONFLICT'); assert.equal(r.body.flow.description, 'desde git');
});

test('WS-8: carpeta desenchufada → no disponible (409, fuera de la API externa, aviso en 🔔), nunca borrada; al volver sigue con sus chats', async () => {
  const dir = repoDir('enchufe');
  writeDef(dir, roleOnly('f_link06', 'Enchufable'));
  await link(dir);
  await s.uiOk('POST', '/api/flows/f_link06/chat/_flow', { message: 'hola' });
  await until(async () => (await s.uiOk('GET', '/api/flows/f_link06/chat/_flow')).every((m) => m.status !== 'running'));
  const away = `${dir}-fuera`;
  fs.renameSync(dir, away);
  const r = await s.ui('GET', '/api/flows/f_link06');
  assert.equal(r.status, 409); assert.equal(r.body.code, 'FLOW_UNAVAILABLE');
  const item = (await s.uiOk('GET', '/api/flows')).find((f) => f.id === 'f_link06');
  assert.equal(item.available, false); assert.equal(item.name, 'Enchufable');
  assert.ok(!(await s.ext('GET', '/flows')).body.some((f) => f.id === 'f_link06'));
  assert.equal((await s.ui('POST', '/api/flows/f_link06/run', { input: '' })).status, 409);
  assert.ok(await until(async () => (await s.uiOk('GET', '/api/attention')).items?.some?.((i) => i.id === 'linked:f_link06') || (await s.uiOk('GET', '/api/attention')).some?.((i) => i.id === 'linked:f_link06')), 'aviso en la lista de atención');
  fs.renameSync(away, dir);
  assert.ok(await until(async () => (await s.ui('GET', '/api/flows/f_link06')).status === 200), 'vuelve solo');
  assert.ok((await s.uiOk('GET', '/api/flows/f_link06/chat/_flow')).length >= 1, 'los chats siguen');
});

test('WS-8: rutas que no se pueden vincular (datos, carpetas de trabajo, instalación, ancestros, red, archivo, inexistente, sin flow.json, flow.json que es un enlace)', async () => {
  const code = async (p) => (await link(p)).body?.code;
  assert.equal(await code(s.dirs.data), 'LINK_PATH_FORBIDDEN');
  assert.equal(await code(path.join(s.dirs.data, 'flows')), 'LINK_PATH_FORBIDDEN');
  const ws = path.join(s.dirs.home, '.agent-flow-studio', 'workspaces', 'x'); fs.mkdirSync(ws, { recursive: true });
  assert.equal(await code(ws), 'LINK_PATH_FORBIDDEN');
  assert.equal(await code(path.dirname(s.dirs.data)), 'LINK_PATH_FORBIDDEN', 'una carpeta que contiene los datos');
  assert.equal(await code(path.resolve(import.meta.dirname, '..', '..')), 'LINK_PATH_FORBIDDEN', 'la instalación');
  assert.equal(await code('\\\\servidor\\share\\flujo'), 'LINK_PATH_NETWORK');
  assert.equal(await code('relativa/flujo'), 'LINK_PATH_INVALID');
  assert.equal(await code(path.join(s.tmp, 'no-existe')), 'LINK_PATH_NOT_FOUND');
  const file = path.join(s.tmp, 'un-archivo.txt'); fs.writeFileSync(file, 'x');
  assert.equal(await code(file), 'LINK_NOT_DIR');
  assert.equal(await code(repoDir()), 'LINK_NO_FLOW');
  const bad = repoDir(); fs.writeFileSync(path.join(bad, 'flow.json'), '{"no":"es un flujo"}');
  assert.equal(await code(bad), 'LINK_INVALID');
  const sym = repoDir(); const target = repoDir(); writeDef(target, roleOnly('f_sym'));
  let made = true; try { fs.symlinkSync(path.join(target, 'flow.json'), path.join(sym, 'flow.json'), 'file'); } catch { made = false; }
  if (made) assert.equal(await code(sym), 'LINK_INVALID', 'un flow.json que es un enlace');
});

test('WS-8: ids: el de un flujo que ya está → LINK_ID_TAKEN (o como copia, con id nuevo escrito en la carpeta); la misma carpeta dos veces → LINK_EXISTS', async () => {
  const mine = await s.flow('Mío local', [role('R', 'x', { id: 's_r' })]);
  const dir = repoDir(); writeDef(dir, { ...roleOnly(mine.id), name: 'Copia' });
  const r = await link(dir);
  assert.equal(r.status, 409); assert.equal(r.body.code, 'LINK_ID_TAKEN');
  const c = await link(dir, { asCopy: true });
  assert.equal(c.status, 200); assert.notEqual(c.body.flow.id, mine.id);
  assert.equal(readDef(dir).id, mine.id, 'vincular no reescribe el archivo de la persona (el id nuevo vive en la app)');
  assert.equal((await link(dir)).body.code, 'LINK_EXISTS');
});

test('WS-8: en un repo git, correr, chatear, memoria, fijar y programar no ensucian el repo; editar en la app cambia solo flow.json; los secretos nunca llegan al repo', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  const repo = repoDir('git');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  const local = await s.flow('Para el repo', [role('Saluda', '[[mock:say hola]]', { id: 's_r' })], [], { vars: { env: 'qa', api_token: 'SECRETO-XYZ' } });
  const mv = await s.ui('POST', `/api/flows/${local.id}/move-to`, { path: path.join(repo, 'flujo') });
  assert.equal(mv.body?.code, 'LINK_PATH_NOT_FOUND');
  fs.mkdirSync(path.join(repo, 'flujo'));
  await s.uiOk('POST', `/api/flows/${local.id}/move-to`, { path: path.join(repo, 'flujo') });
  git('add', '-A'); git('commit', '-qm', 'flujo');
  assert.ok(!fs.readFileSync(path.join(repo, 'flujo', 'flow.json'), 'utf8').includes('SECRETO-XYZ'));
  assert.equal((await s.getFlow(local.id)).vars.api_token, 'SECRETO-XYZ', 'el secreto sigue en la app');
  assert.equal((await s.runUi(local.id)).status, 'success');
  await s.uiOk('POST', `/api/flows/${local.id}/chat/_flow`, { message: 'hola' });
  await until(async () => (await s.uiOk('GET', `/api/flows/${local.id}/chat/_flow`)).every((m) => m.status !== 'running'));
  await s.uiOk('POST', `/api/flows/${local.id}/memory/s_r`, { text: 'recuerdo' });
  const g = await s.getFlow(local.id);
  await s.uiOk('PUT', `/api/flows/${local.id}`, { ...g, schedule: { ...g.schedule, enabled: true } });
  assert.equal(git('status', '--porcelain').stdout, '', 'repo limpio');
  await s.uiOk('PUT', `/api/flows/${local.id}`, { ...(await s.getFlow(local.id)), description: 'nueva descripción' });
  assert.equal(git('status', '--porcelain').stdout.trim(), 'M flujo/flow.json');
  assert.ok(!fs.existsSync(path.join(repo, 'flujo', 'README.md')), 'README solo a pedido');
  const rd = await s.uiOk('POST', `/api/flows/${local.id}/readme`, {});
  assert.equal(path.resolve(rd.path), path.resolve(fs.realpathSync.native(path.join(repo, 'flujo')), 'README.md'));
  assert.ok(!fs.readFileSync(rd.path, 'utf8').includes('SECRETO-XYZ'));
  await s.uiOk('PUT', `/api/flows/${local.id}`, { ...(await s.getFlow(local.id)), schedule: { ...(await s.getFlow(local.id)).schedule, enabled: false } });
});

test('WS-8: mover a una carpeta que ya tiene flow.json → LINK_TARGET_HAS_FLOW; desvincular deja los archivos y revoca el token; volver a vincular recupera el historial; borrar un vinculado nunca toca el repo', async () => {
  const f = await s.flow('Para mover', [role('R', '[[mock:say ok]]', { id: 's_r' })]);
  const busy = repoDir(); writeDef(busy, roleOnly('f_other'));
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/move-to`, { path: busy })).body.code, 'LINK_TARGET_HAS_FLOW');
  const dir = repoDir();
  await s.uiOk('POST', `/api/flows/${f.id}/move-to`, { path: dir });
  const run = await s.runUi(f.id);
  await s.uiOk('GET', `/api/flows/${f.id}/token?reveal=1`).catch(() => {});
  await s.uiOk('POST', `/api/flows/${f.id}/token`, {});
  const tok = (await s.uiOk('GET', `/api/flows/${f.id}/token?reveal=1`)).token;
  const files0 = fs.readFileSync(path.join(dir, 'flow.json'));
  await s.uiOk('DELETE', `/api/flows/link/${f.id}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'flow.json')), files0, 'el repo queda igual');
  assert.equal((await s.ui('GET', `/api/flows/${f.id}`)).status, 404);
  assert.equal((await s.ext('GET', '/ping', undefined, { Authorization: `Bearer ${tok}` }, { auth: false })).status, 401, 'token revocado');
  await s.uiOk('POST', '/api/flows/link', { path: dir });
  assert.deepEqual((await s.uiOk('GET', `/api/flows/${f.id}/runs`)).map((r) => r.id), [run.id], 'el historial vuelve');
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'flow.json')), files0);
  assert.equal((await s.ui('GET', `/api/flows/${f.id}`)).status, 404);
  assert.ok(!s.flowDir(f.id), 'se borró el lado de la app');
});

test('WS-4: importar desde una carpeta (API y `afs import <carpeta>`): id nuevo y cuarentena si ejecuta algo', async () => {
  const dir = repoDir();
  writeDef(dir, { id: 'f_imp01', name: 'Importado de carpeta', steps: [cmd('Eco', 'Write-Output hola', { id: 's_c' })], edges: [] });
  fs.mkdirSync(path.join(dir, 'chats')); fs.writeFileSync(path.join(dir, 'chats', '_flow.json'), JSON.stringify([{ id: 'c1', role: 'user', text: 'de la carpeta', at: 1 }]));
  const r = await s.uiOk('POST', '/api/flows/import', { path: dir });
  assert.notEqual(r.flow.id, 'f_imp01'); assert.ok(r.quarantine);
  assert.equal((await s.uiOk('GET', `/api/flows/${r.flow.id}/chat/_flow`))[0].text, 'de la carpeta');
  const cli = await s.afs(['import', dir, '--json']);
  assert.equal(cli.code, 0, cli.stderr + cli.stdout);
  assert.equal((await s.ui('POST', '/api/flows/import', { path: s.dirs.data })).body.code, 'LINK_PATH_FORBIDDEN');
});

test('WS-9/WS-11: «Abrir carpeta» resuelve la carpeta en el servidor (vinculada o de la app) y solo desde la interfaz; README.md local sin secretos ni rutas, estable', async () => {
  const f = await s.flow('Con README', [cmd('Secreto', 'Write-Output CUERPO-DEL-COMANDO', { id: 's_c' }), role('Charla', 'Revisa la tarea\notra línea', { id: 's_r' })], [['s_c', 's_r']], { vars: { api_token: 'SECRETO-README', env: 'qa' }, cwd: s.dirs.work });
  await s.uiOk('POST', `/api/flows/${f.id}/memory/s_r`, { text: 'MEMORIA-PRIVADA' });
  const rv = await s.uiOk('POST', `/api/flows/${f.id}/reveal`, { path: 'C:\\Windows' });
  assert.equal(path.resolve(rv.path), path.resolve(s.flowDir(f.id))); assert.equal(rv.opened, false);
  { const e = await s.ext('POST', `/flows/${f.id}/reveal`, {}); assert.ok([401, 404].includes(e.status), `no existe en la API externa (${e.status})`); }
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/reveal`, {}, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
  assert.equal((await s.ui('POST', '/api/flows/f_nadie/reveal', {})).status, 404);
  const readme = s.flowFile(f.id, 'README.md');
  const md = await until(() => fs.existsSync(readme) && fs.readFileSync(readme, 'utf8'));
  assert.match(md, /^<!-- generado por Agent Flow Studio/); assert.match(md, /Con README/); assert.match(md, /Charla/); assert.match(md, /`api_token`/);
  for (const priv of ['SECRETO-README', 'MEMORIA-PRIVADA', 'CUERPO-DEL-COMANDO', s.dirs.work, 'otra línea', s.uiKey, s.token]) assert.ok(!md.includes(priv), `README sin «${String(priv).slice(0, 20)}»`);
  const r1 = await s.uiOk('POST', `/api/flows/${f.id}/readme`, {}); assert.equal(r1.status, 'same', 'regenerar da los mismos bytes');
  fs.writeFileSync(readme, '# Mío');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/readme`, {})).body.code, 'README_NOT_OURS');
});

test('CWD_IN_DATA: un directorio de trabajo dentro de los datos de la app no corre', async () => {
  const f = await s.flow('Adentro', [cmd('Eco', 'Write-Output hola', { id: 's_e' })], [], { cwd: s.dirs.data });
  const r = await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'CWD_IN_DATA');
});

// ---- first adversarial pass on spec 09 ----
test('revisión 09 (H1/M5): en un vinculado confiable, desde afuera: un step agente, herramientas MCP que escriben, permisos ampliados o intercambiar nombres de steps (las rutas van por nombre) → revisión', async () => {
  const cases = [
    ['age', (d) => { d.steps[0] = { id: 's_r', name: 'Saluda', kind: 'agent', agentRef: 'pwn', task: 'x', position: { x: 0, y: 0 } }; }],
    ['mcp', (d) => { d.steps[0].allowedTools = 'Read mcp__github__push_files'; }],
    ['per', (d) => { d.steps[0].permissionMode = 'acceptEdits'; }],
  ];
  for (const [label, fn] of cases) {
    const dir = repoDir(); writeDef(dir, roleOnly(`f_rev1${label}`));
    await link(dir);
    editDef(dir, fn);
    assert.ok((await s.getFlow(`f_rev1${label}`)).quarantine, label);
  }
  const dir2 = repoDir();
  writeDef(dir2, { id: 'f_rev1swc', name: 'Rutas', steps: [role('Router', 'x', { id: 's_a' }), role('Seguro', 'x', { id: 's_b' }), cmd('Peligro', 'Write-Output DANGER', { id: 's_c' })], edges: [{ id: 'e1', source: 's_a', target: 's_b' }, { id: 'e2', source: 's_a', target: 's_c' }] });
  await link(dir2); await s.uiOk('POST', '/api/flows/f_rev1swc/trust', {});
  editDef(dir2, (d) => { d.steps[1].name = 'Peligro'; d.steps[2].name = 'Seguro'; });
  assert.ok((await s.getFlow('f_rev1swc')).quarantine, 'intercambiar nombres en un flujo con comandos');
});

test('revisión 09 (H2): vincular con un directorio de trabajo propio queda en revisión; después, un cambio en su .claude/.mcp.json/CLAUDE.md lo devuelve a revisión antes de correr; otra carpeta de flujo como directorio → CWD_OTHER_FLOW', async () => {
  const proj = repoDir('proyecto');
  const dir = repoDir();
  writeDef(dir, { ...roleOnly('f_rev2cwd'), cwd: proj });
  assert.ok((await link(dir)).body.quarantine, 'directorio propio al vincular');
  await s.uiOk('POST', '/api/flows/f_rev2cwd/trust', {});
  assert.equal((await s.runUi('f_rev2cwd')).status, 'success');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
  const r = await s.ui('POST', '/api/flows/f_rev2cwd/run', { input: '' });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.ok((await s.getFlow('f_rev2cwd')).quarantine.reasons.some((x) => /configuración de Claude/.test(x)));
  await s.uiOk('POST', '/api/flows/f_rev2cwd/trust', {});
  assert.equal((await s.runUi('f_rev2cwd')).status, 'success', 'revisado: la configuración nueva queda confiada');
  // an in-app change of the working folder is the person's choice: no review
  const g = await s.getFlow('f_rev2cwd'); const proj2 = repoDir('proyecto2');
  await s.uiOk('PUT', '/api/flows/f_rev2cwd', { ...g, cwd: proj2 });
  assert.equal((await s.runUi('f_rev2cwd')).status, 'success');
  const victim = await s.flow('Víctima ws', [cmd('Eco', 'Write-Output v', { id: 's_v' })]);
  await s.runUi(victim.id);
  const other = await s.flow('Intruso', [cmd('Eco', 'Write-Output i', { id: 's_i' })], [], { cwd: path.join(s.dirs.home, '.agent-flow-studio', 'workspaces', victim.id) });
  const r2 = await s.ui('POST', `/api/flows/${other.id}/run`, { input: '' });
  assert.equal(r2.status, 422); assert.equal(r2.body.code, 'CWD_OTHER_FLOW');
});

test('revisión 09 (H3): un id que solo cambia en mayúsculas no se vincula (ni comparte carpeta de trabajo); un listado nunca se rompe por un vinculado', async () => {
  const mine = await s.flow('Caso', [cmd('Eco', 'Write-Output v', { id: 's_v' })]);
  const dir = repoDir(); writeDef(dir, { ...roleOnly('x'), id: `f_${mine.id.slice(2).toUpperCase()}` });
  const r = await link(dir);
  assert.equal(r.body.code, 'LINK_ID_TAKEN');
  const c = await link(dir, { asCopy: true });
  assert.notEqual(c.body.flow.id.toLowerCase(), mine.id.toLowerCase());
  assert.equal((await s.ui('GET', '/api/flows')).status, 200); assert.equal((await s.ext('GET', '/flows')).status, 200);
});

test('revisión 09 (H4): si se pierde o daña state.json, el flujo no se habilita ni vuelve a la carpeta de usuario', async () => {
  const bundle = { format: 'agent-flow-studio/flow', version: 1, flow: { name: 'Importado frágil', steps: [cmd('Eco', 'Write-Output hola', { id: 's_e' })], edges: [] } };
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle });
  assert.ok(imp.quarantine);
  fs.rmSync(s.flowFile(imp.flow.id, 'state.json'));
  assert.equal((await s.ui('POST', `/api/flows/${imp.flow.id}/run`, { input: '' })).status, 423, 'sigue en revisión');
  const own = await s.flow('Propio', [role('R', '[[mock:say ok]]', { id: 's_r' })]);
  fs.writeFileSync(s.flowFile(own.id, 'state.json'), '{dañado');
  const w = await s.uiOk('GET', `/api/flows/${own.id}/workspace`);
  assert.equal(w.mode, 'own', 'carpeta propia, no la de usuario');
  assert.ok(fs.readdirSync(s.flowDir(own.id)).some((n) => n.startsWith('state.json.danado-')), 'el dañado queda aparte');
});

test('revisión 09 (M6): desvincular no regala el historial (secretos, memoria) a otra carpeta que diga tener ese id; la misma carpeta sí lo recupera', async () => {
  const dir = repoDir(); writeDef(dir, roleOnly('f_rev6'));
  await link(dir);
  const g = await s.getFlow('f_rev6');
  await s.uiOk('PUT', '/api/flows/f_rev6', { ...g, vars: { ...g.vars, api_token: 'SECRETO-VICTIMA' } });
  await s.uiOk('DELETE', '/api/flows/link/f_rev6');
  const other = repoDir(); writeDef(other, roleOnly('f_rev6', 'Impostor'));
  assert.equal((await link(other)).body.code, 'LINK_ID_TAKEN');
  const ok = await link(dir);
  assert.equal(ok.status, 200); assert.equal((await s.getFlow('f_rev6')).vars.api_token, 'SECRETO-VICTIMA');
});

test('revisión 09 (M7/L10): un flow.json no prende el sondeo automático; GH_KEY y JIRA_PAT no llegan al repo', async () => {
  const dir = repoDir();
  writeDef(dir, { ...roleOnly('f_rev7'), watchPolling: { enabled: true, everyMinutes: 5 } });
  await link(dir);
  assert.equal((await s.getFlow('f_rev7')).watchPolling.enabled, false);
  const g = await s.getFlow('f_rev7');
  await s.uiOk('PUT', '/api/flows/f_rev7', { ...g, vars: { GH_KEY: 'gh-valor-secreto', JIRA_PAT: 'pat-valor-secreto', issueKey: 'SBK-1' }, description: 'cambio' });
  const txt = fs.readFileSync(path.join(dir, 'flow.json'), 'utf8');
  assert.ok(!txt.includes('gh-valor-secreto') && !txt.includes('pat-valor-secreto')); assert.ok(txt.includes('SBK-1'), 'una clave de Jira no es un secreto');
});

test('revisión 09 (M8): un nombre que comparten dos flujos no se resuelve por nombre (un vinculado no se queda con las llamadas de otro)', async () => {
  const local = await s.flow('Nombre Compartido', [role('R', '[[mock:say ok]]', { id: 's_r' })]);
  const dir = repoDir(); writeDef(dir, { ...roleOnly('f_rev8'), name: 'Nombre Compartido' });
  await link(dir);
  const r = await s.ext('POST', `/flows/${encodeURIComponent('Nombre Compartido')}/run`, { wait: true });
  assert.notEqual(r.status, 200);
  assert.equal((await s.ext('POST', `/flows/${local.id}/run`, { wait: true })).status, 200, 'por id sigue andando');
});

test('revisión 09 (M9): una carpeta vinculada cambiada por un enlace a otro lado se detecta en la misma lectura (nunca lee ni escribe otro flujo)', async () => {
  const victim = await s.flow('Víctima', [role('R', 'tarea de la victima', { id: 's_r' })]);
  const dir = repoDir('swap'); writeDef(dir, roleOnly('f_rev9'));
  await link(dir);
  fs.renameSync(dir, `${dir}-orig`);
  let made = true; try { fs.symlinkSync(s.flowDir(victim.id), dir, 'junction'); } catch { made = false; }
  if (!made) return;
  const r = await s.ui('GET', '/api/flows/f_rev9');
  assert.equal(r.status, 409); assert.equal(r.body.code, 'FLOW_UNAVAILABLE');
  assert.equal((await s.getFlow(victim.id)).steps[0].task, 'tarea de la victima');
  fs.rmSync(dir); fs.renameSync(`${dir}-orig`, dir);
});

test('revisión 09 (L11): vincular no reescribe un flow.json sin id; JSON muy anidado → LINK_INVALID sin romper el listado; README con sus conexiones', async () => {
  const dir = repoDir(); const def = roleOnly('x'); delete def.id; writeDef(dir, def);
  const before = fs.readFileSync(path.join(dir, 'flow.json'));
  assert.equal((await link(dir)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'flow.json')), before);
  const deep = repoDir();
  fs.writeFileSync(path.join(deep, 'flow.json'), `{"id":"f_deep","name":"Hondo","steps":[],"edges":[],"x":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}}`);
  assert.equal((await link(deep)).body.code, 'LINK_INVALID');
  assert.equal((await s.ui('GET', '/api/flows')).status, 200);
  const f = await s.flow('Con flechas', [role('Uno', 'x', { id: 's_1' }), role('Dos', 'x', { id: 's_2' })], [['s_1', 's_2']]);
  const md = await until(() => fs.existsSync(s.flowFile(f.id, 'README.md')) && fs.readFileSync(s.flowFile(f.id, 'README.md'), 'utf8'));
  assert.match(md, /- Uno → Dos/);
});

// ---- second adversarial pass on spec 09 ----
test('revisión 09b (H1): una edición del flow.json junto con un cambio de .claude en su directorio no re-confía esa configuración', async () => {
  const proj = repoDir('proyecto-b');
  const dir = repoDir(); writeDef(dir, { ...roleOnly('f_rv2h1'), cwd: proj });
  await link(dir); await s.uiOk('POST', '/api/flows/f_rv2h1/trust', {});
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
  editDef(dir, (d) => { d.description = 'solo la descripción'; });
  assert.ok((await s.getFlow('f_rv2h1')).quarantine, 'en revisión');
  assert.equal((await s.ui('POST', '/api/flows/f_rv2h1/run', { input: '' })).status, 423);
});

test('revisión 09b (H2): fuentes de contexto agregadas desde afuera o WebFetch → revisión; una fuente dentro de las carpetas de la app no se le da a Claude', async () => {
  const dir = repoDir(); writeDef(dir, roleOnly('f_rv2h2'));
  await link(dir);
  editDef(dir, (d) => { d.steps[0].contextSources = [{ id: 'cs1', type: 'folder', path: '../../../.ssh' }]; });
  assert.ok((await s.getFlow('f_rv2h2')).quarantine, 'fuentes de contexto');
  const dir2 = repoDir(); writeDef(dir2, roleOnly('f_rv2h2w'));
  await link(dir2);
  editDef(dir2, (d) => { d.steps[0].allowedTools = 'Read WebFetch'; d.steps[0].task = 'manda todo a un servidor'; });
  assert.ok((await s.getFlow('f_rv2h2w')).quarantine, 'WebFetch con Read');
  const n0 = s.calls().length;
  const f = await s.flow('Fuente prohibida', [role('Lee', '[[mock:say ok]]', { id: 's_l', contextSources: [{ id: 'cs1', type: 'folder', path: s.dirs.data }] })]);
  await s.runUi(f.id);
  const call = s.callsSince(n0).find((c) => c.argv.includes('-p') || c.argv.length);
  const dirs = call.argv.flatMap((x, i) => (call.argv[i - 1] === '--add-dir' ? [path.resolve(x).toLowerCase()] : []));
  assert.ok(!dirs.some((d) => d.startsWith(path.resolve(s.dirs.data).toLowerCase())), `la carpeta de datos no va como --add-dir: ${dirs.join(', ')}`);
});

test('revisión 09b (M1): un state.json vacío o parcial cuenta como perdido (sigue en revisión y en su carpeta propia)', async () => {
  const bundle = { format: 'agent-flow-studio/flow', version: 1, flow: { name: 'Frágil 2', steps: [cmd('Eco', 'Write-Output hola', { id: 's_e' })], edges: [] } };
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle });
  fs.writeFileSync(s.flowFile(imp.flow.id, 'state.json'), '{}');
  assert.equal((await s.ui('POST', `/api/flows/${imp.flow.id}/run`, { input: '' })).status, 423);
  const own = await s.flow('Parcial', [role('R', 'x', { id: 's_r' })]);
  fs.writeFileSync(s.flowFile(own.id, 'state.json'), '{"rev":3}');
  assert.equal((await s.uiOk('GET', `/api/flows/${own.id}/workspace`)).mode, 'own');
});

test('revisión 09b (M2/M3): un vinculado con el slug de otro como nombre no se queda con sus llamadas; intercambiar slugs desde afuera → revisión', async () => {
  const local = await s.flow('Deploy Prod', [cmd('Eco', 'Write-Output LOCAL', { id: 's_e' })]);
  const dir = repoDir(); writeDef(dir, { ...roleOnly('f_rv2m2'), name: 'deploy-prod' });
  await link(dir);
  const r = await s.ext('POST', '/flows/deploy-prod/run', { wait: true });
  assert.notEqual(r.body?.flowId, 'f_rv2m2'); assert.notEqual(r.status, 200, 'ambiguo');
  assert.equal((await s.ext('POST', `/flows/${local.id}/run`, { wait: true })).status, 200);
  const dir2 = repoDir();
  writeDef(dir2, { id: 'f_rv2m3', name: 'Slugs', steps: [cmd('Check', 'Write-Output CHECK', { id: 's_a', slug: 'check' }), cmd('Deploy', 'Write-Output DEPLOY', { id: 's_b', slug: 'deploy' })], edges: [] });
  await link(dir2); await s.uiOk('POST', '/api/flows/f_rv2m3/trust', {});
  editDef(dir2, (d) => { d.steps[0].slug = 'deploy'; d.steps[1].slug = 'check'; });
  assert.ok((await s.getFlow('f_rv2m3')).quarantine);
});

test('revisión 09b (M4/M5/L1/L2): desvincular con copia sin carpeta usa la última definición; importar con directorio o fuentes queda en revisión; habilitar exige la revisión vista; las versiones de cambios externos se podan', async () => {
  const dir = repoDir('m4'); writeDef(dir, roleOnly('f_rv2m4', 'Copia sin carpeta'));
  await link(dir); await s.getFlow('f_rv2m4');
  editDef(dir, (d) => { d.description = 'vista por la app'; }); await s.getFlow('f_rv2m4');
  fs.renameSync(dir, `${dir}-fuera`); await s.ui('GET', '/api/flows/f_rv2m4');
  await s.uiOk('DELETE', '/api/flows/link/f_rv2m4?keepLocalCopy=1');
  const kept = await s.getFlow('f_rv2m4');
  assert.equal(kept.description, 'vista por la app');
  fs.renameSync(`${dir}-fuera`, dir);
  const bundle = { format: 'agent-flow-studio/flow', version: 1, flow: { name: 'Con cwd', cwd: s.dirs.work, steps: [role('R', 'x', { id: 's_r' })], edges: [] } };
  assert.ok((await s.uiOk('POST', '/api/flows/import', { bundle })).quarantine, 'directorio de trabajo');
  const b2 = { format: 'agent-flow-studio/flow', version: 1, flow: { name: 'Con fuentes', steps: [role('R', 'x', { id: 's_r', contextSources: [{ id: 'c', type: 'folder', path: s.dirs.home }] })], edges: [] } };
  assert.ok((await s.uiOk('POST', '/api/flows/import', { bundle: b2 })).quarantine, 'fuentes de contexto');
  const dir3 = repoDir(); writeDef(dir3, { id: 'f_rv2l1', name: 'Revisión vista', steps: [cmd('Eco', 'Write-Output REVISADO', { id: 's_e' })], edges: [] });
  await link(dir3);
  const seen = await s.getFlow('f_rv2l1');
  editDef(dir3, (d) => { d.steps[0].command = 'Write-Output NO-REVISADO'; }); await s.getFlow('f_rv2l1');
  assert.equal((await s.ui('POST', '/api/flows/f_rv2l1/trust', { baseRev: seen.rev })).status, 409);
  for (let i = 0; i < 35; i++) { editDef(dir3, (d) => { d.description = `v${i}`; }); await s.getFlow('f_rv2l1'); }
  const vs = await s.uiOk('GET', '/api/flows/f_rv2l1/versions');
  assert.ok(vs.length <= 31, `versiones: ${vs.length}`);
});

// ---- closing check on spec 09 ----
test('revisión 09c: el chat de un vinculado también se frena si cambió la configuración de Claude de su directorio; un archivo cuya carpeta contiene las de la app no se da', async () => {
  const proj = repoDir('proyecto-chat');
  const dir = repoDir(); writeDef(dir, { ...roleOnly('f_rv3chat'), cwd: proj });
  await link(dir); await s.uiOk('POST', '/api/flows/f_rv3chat/trust', {});
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
  const n0 = s.calls().length;
  const r = await s.ui('POST', '/api/flows/f_rv3chat/chat/s_r', { message: 'hola' });
  assert.equal(r.status, 423, JSON.stringify(r.body));
  assert.equal((await s.ui('POST', '/api/flows/f_rv3chat/chat/_flow', { message: 'hola' })).status, 423);
  await sleep(300);
  assert.equal(s.callsSince(n0).length, 0, 'Claude no arrancó');
  // a file whose folder holds the app's folders (here: the parent of the data folder)
  const file = path.join(path.dirname(s.dirs.data), 'notas.md'); fs.writeFileSync(file, 'notas');
  const f = await s.flow('Archivo al lado', [role('Lee', '[[mock:say ok]]', { id: 's_l', contextSources: [{ id: 'c', type: 'file', path: file }] })]);
  const n1 = s.calls().length;
  await s.runUi(f.id);
  const call = s.callsSince(n1)[0];
  const dirs = call.argv.flatMap((x, i) => (call.argv[i - 1] === '--add-dir' ? [path.resolve(x).toLowerCase()] : []));
  assert.ok(!dirs.includes(path.dirname(s.dirs.data).toLowerCase()), `no da la carpeta que contiene los datos: ${dirs.join(', ')}`);
});
