// Spec 09: one folder per flow (data/flows/<slug>--<id>/: flow.json portable, state.json machine state, chats, runs,
// versions, reviews, outputs…), the automatic migration of the old layout (crash-safe, with a backup), README.md and
// "Abrir carpeta". Offline: seeded data folders + command steps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, cmd, role, sleep } from './helpers/harness.mjs';

const servers = [];
after(async () => { for (const x of servers) await x.stop(); });
const fresh = async (name, env = {}) => { const x = await startServer({ name, env: { AFS_REVEAL: '0', ...env } }); servers.push(x); return x; };
const w = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const backupOf = (x) => { const n = fs.readdirSync(x.dirs.data).filter((d) => d.startsWith('_backup-pre09-')); return n.map((d) => path.join(x.dirs.data, d)); };
const files = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { return []; } };
const startFails = async (x) => { try { await x.start(); } catch (e) { return String(e.message); } throw new Error('debía fallar al arrancar'); };

/** An old-layout flow (before spec 09) with everything a real one has. */
function seedOld(data, id, name, { orphan = false } = {}) {
  const out = path.join(data, 'outputs', id, 'r_1', 'paso-s_1', 'salida.txt');
  w(out, 'contenido del entregable');
  w(path.join(data, 'flows', `${id}.json`), {
    id, name, description: 'viejo', cwd: '', vars: { api_token: 'SECRETO-123', env: 'qa' }, schedule: { enabled: true, everyMinutes: 60, input: '' },
    steps: [{ id: 's_1', name: 'Paso', kind: 'command', command: 'Write-Output hola', shell: 'powershell', task: '', output: { format: 'text', schema: '' }, input: { mode: 'full', maxChars: 12000 }, position: { x: 0, y: 0 },
      memory: [{ id: 'm1', text: 'recuerdo privado', at: 1 }], chatSessionId: 'sess-privada', lastRun: { status: 'success', output: 'salida vieja', runId: 'r_1' }, pinned: { output: 'fijado' } }],
    edges: [], memory: [{ id: 'm2', text: 'memoria del flujo', at: 1 }], globalSessionId: 'g-privada', createdAt: 1, updatedAt: 2,
  });
  w(path.join(data, 'chats', id, '_flow.json'), [{ id: 'c1', role: 'user', text: 'hola del chat', at: 1 }]);
  w(path.join(data, 'runs', id, 'r_1.json'), { id: 'r_1', flowId: id, status: 'success', trigger: 'ui', input: '', startedAt: 10, endedAt: 11,
    steps: { s_1: { status: 'success', output: 'hola', deliverables: [{ id: 'salida', stepKey: 's_1', name: 'salida.txt', path: out, format: 'text', size: 25 }] } } });
  w(path.join(data, 'versions', id, 'v_1.json'), { id: 'v_1', at: 5, label: 'Mía', auto: false, rev: 1, hash: 'x', flow: { name, steps: [], edges: [] } });
  w(path.join(data, 'reviews', id, 'suppressed.json'), { fp1: { anchor: 'a', reason: 'no aplica', at: 1 } });
  w(path.join(data, 'watch', `${id}.json`), { snapshots: {} });
  w(path.join(data, 'actions', `${id}.json`), []);
  w(path.join(data, 'invoke', `${id}.md`), '# viejo');
  if (orphan) w(path.join(data, 'runs', 'f_dead', 'r_9.json'), { id: 'r_9', flowId: 'f_dead', status: 'success' });
}

test('WS-2: la carpeta de datos vieja se migra sola: mismo flujo, chats, ejecuciones (con su entregable), versiones y revisiones; flow.json sin estado de la máquina; respaldo completo, también lo huérfano', async () => {
  const x = await fresh('migra');
  seedOld(x.dirs.data, 'f_aaa', 'Flujo Viejo', { orphan: true });
  const original = fs.readFileSync(path.join(x.dirs.data, 'flows', 'f_aaa.json'));
  await x.start();
  const f = await x.uiOk('GET', '/api/flows/f_aaa');
  assert.equal(f.name, 'Flujo Viejo'); assert.equal(f.vars.api_token, 'SECRETO-123'); assert.equal(f.schedule.enabled, true);
  assert.equal(f.steps[0].memory[0].text, 'recuerdo privado'); assert.equal(f.steps[0].lastRun.output, 'salida vieja'); assert.equal(f.memory[0].text, 'memoria del flujo');
  assert.equal((await x.uiOk('GET', '/api/flows/f_aaa/chat/_flow'))[0].text, 'hola del chat');
  assert.deepEqual((await x.uiOk('GET', '/api/flows/f_aaa/runs')).map((r) => r.id), ['r_1']);
  assert.equal((await x.uiOk('GET', '/api/flows/f_aaa/versions'))[0].label, 'Mía');
  const dl = await fetch(`${x.base}/api/flows/f_aaa/runs/r_1/files/salida`, { headers: { 'X-AFS-UI': x.uiKey } });
  assert.equal(dl.status, 200); assert.equal(await dl.text(), 'contenido del entregable', 'el entregable de una ejecución vieja se sigue descargando');
  const dir = x.flowDir('f_aaa');
  assert.equal(path.basename(dir), 'flujo-viejo--f_aaa');
  for (const rel of ['flow.json', 'state.json', 'chats/_flow.json', 'runs/r_1.json', 'versions/v_1.json', 'reviews/suppressed.json', 'sources.json', 'actions.json', 'outputs/r_1/paso-s_1/salida.txt']) assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  const def = fs.readFileSync(path.join(dir, 'flow.json'), 'utf8');
  for (const priv of ['SECRETO-123', 'sess-privada', 'g-privada', 'recuerdo privado', 'memoria del flujo', 'salida vieja', 'fijado']) assert.ok(!def.includes(priv), `flow.json no lleva «${priv}»`);
  assert.match(def, /"format": "agent-flow-studio\/flow"/);
  // the backup has every original byte, including runs of a flow deleted long ago
  const [bk] = backupOf(x);
  assert.ok(bk, 'hay respaldo');
  assert.deepEqual(fs.readFileSync(path.join(bk, 'flows', 'f_aaa.json')), original);
  assert.ok(fs.existsSync(path.join(bk, 'runs', 'f_dead', 'r_9.json')), 'lo huérfano queda en el respaldo');
  for (const d of ['chats', 'runs', 'versions', 'reviews', 'outputs', 'watch', 'actions', 'invoke']) assert.ok(!fs.existsSync(path.join(x.dirs.data, d)), `${d} viejo apartado`);
  assert.ok(!fs.readdirSync(path.join(x.dirs.data, 'flows')).some((n) => n.endsWith('.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.dirs.data, 'layout.json'), 'utf8')).layout, 2);
  // idempotent: a restart neither makes a second backup nor touches the flow's files
  const stamp = () => Object.fromEntries(files(dir).map((r) => [r, fs.statSync(path.join(dir, r)).mtimeMs]));
  await sleep(1200); // INVOKE.md is written 300 ms after start
  const before = stamp();
  await x.kill(); await x.start(); await sleep(1200);
  assert.equal(backupOf(x).length, 1);
  assert.deepEqual(stamp(), before, 'reiniciar no reescribe nada');
});

test('WS-2: si se corta en medio de la copia, lo original queda intacto y el próximo arranque termina sin duplicar ni perder nada', async () => {
  const x = await fresh('migra-corte', { AFS_TEST_FAULT: 'migrate:after-stage:1' });
  seedOld(x.dirs.data, 'f_aaa', 'Uno'); seedOld(x.dirs.data, 'f_bbb', 'Dos');
  assert.match(await startFails(x), /terminó al arrancar/);
  for (const id of ['f_aaa', 'f_bbb']) assert.ok(fs.existsSync(path.join(x.dirs.data, 'flows', `${id}.json`)) && fs.existsSync(path.join(x.dirs.data, 'chats', id, '_flow.json')), `${id} original intacto`);
  assert.equal(fs.readdirSync(path.join(x.dirs.data, 'flows')).filter((n) => n.includes('--')).length, 1, 'un flujo ya armado (completo por construcción)');
  delete x.env.AFS_TEST_FAULT;
  await x.start();
  const list = await x.uiOk('GET', '/api/flows');
  assert.deepEqual(list.map((f) => f.name).sort(), ['Dos', 'Uno']);
  for (const id of ['f_aaa', 'f_bbb']) { assert.equal((await x.uiOk('GET', `/api/flows/${id}/chat/_flow`)).length, 1); assert.equal((await x.uiOk('GET', `/api/flows/${id}/runs`)).length, 1); }
  assert.equal(fs.readdirSync(path.join(x.dirs.data, 'flows')).filter((n) => n.startsWith('.staging')).length, 0);
});

test('WS-2: si se corta mientras aparta lo viejo, los flujos ya funcionan y el próximo arranque termina de apartar (un solo respaldo)', async () => {
  const x = await fresh('migra-corte2', { AFS_TEST_FAULT: 'migrate:in-backup:1' });
  seedOld(x.dirs.data, 'f_aaa', 'Uno'); seedOld(x.dirs.data, 'f_bbb', 'Dos');
  await startFails(x);
  delete x.env.AFS_TEST_FAULT;
  await x.start();
  assert.equal((await x.uiOk('GET', '/api/flows')).length, 2);
  const bks = backupOf(x); assert.equal(bks.length, 1, 'el mismo respaldo');
  for (const id of ['f_aaa', 'f_bbb']) assert.ok(fs.existsSync(path.join(bks[0], 'flows', `${id}.json`)), id);
  assert.ok(fs.existsSync(path.join(bks[0], 'chats', 'f_aaa', '_flow.json')));
  assert.ok(!fs.existsSync(path.join(x.dirs.data, '.migration-09.json')));
});

test('WS-2: un archivo bloqueado (antivirus, editor) frena el arranque con MIGRATION_FAILED y no toca nada; al liberarlo migra', { skip: process.platform !== 'win32' }, async () => {
  const x = await fresh('migra-lock');
  seedOld(x.dirs.data, 'f_aaa', 'Bloqueado');
  const p = path.join(x.dirs.data, 'runs', 'f_aaa', 'r_1.json');
  const locker = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${p}','Open','Read','None'); Write-Output LOCKED; Start-Sleep 60`], { windowsHide: true });
  await new Promise((ok) => locker.stdout.on('data', (d) => { if (/LOCKED/.test(d)) ok(); }));
  try {
    const msg = await startFails(x);
    assert.match(msg, /MIGRATION_FAILED/); assert.match(msg, /r_1\.json|f_aaa/);
    assert.ok(fs.existsSync(path.join(x.dirs.data, 'flows', 'f_aaa.json')));
    assert.equal(fs.readdirSync(path.join(x.dirs.data, 'flows')).filter((n) => n.includes('--') || n.startsWith('.staging')).length, 0, 'nada a medio armar');
  } finally { locker.kill(); await new Promise((r) => locker.once('exit', r)); }
  await sleep(300);
  await x.start();
  assert.equal((await x.uiOk('GET', '/api/flows/f_aaa/runs')).length, 1);
});

test('WS-2: un archivo viejo restaurado junto a la carpeta nueva solo agrega lo que falta (nunca pisa); uno nuevo se migra', async () => {
  const x = await fresh('migra-merge');
  seedOld(x.dirs.data, 'f_aaa', 'Uno');
  await x.start();
  await x.uiOk('PUT', '/api/flows/f_aaa', { ...(await x.uiOk('GET', '/api/flows/f_aaa')), description: 'editado después' });
  await x.kill();
  seedOld(x.dirs.data, 'f_aaa', 'Uno'); // an old backup restored by hand
  w(path.join(x.dirs.data, 'chats', 'f_aaa', '_otro.json'), [{ id: 'c9', role: 'user', text: 'chat recuperado', at: 2 }]);
  seedOld(x.dirs.data, 'f_bbb', 'Nuevo viejo');
  await x.start();
  assert.equal((await x.uiOk('GET', '/api/flows/f_aaa')).description, 'editado después', 'no se pisó');
  assert.equal((await x.uiOk('GET', '/api/flows/f_aaa/chat/_otro'))[0].text, 'chat recuperado', 'se agregó lo que faltaba');
  assert.equal((await x.uiOk('GET', '/api/flows/f_bbb')).name, 'Nuevo viejo');
  assert.equal(backupOf(x).length, 1);
});

test('WS-1: correr un flujo solo cambia state.json (flow.json intacto, byte a byte); editarlo cambia flow.json; un nombre nuevo renombra la carpeta al reiniciar sin perder historial', async () => {
  const x = await fresh('split');
  await x.start();
  const f = await x.flow('Separado', [cmd('Eco', 'Write-Output hola', { id: 's_e' }), role('Charla', '[[mock:say ok]]', { id: 's_r' })], [['s_e', 's_r']]);
  const defFile = x.flowFile(f.id, 'flow.json');
  const before = fs.readFileSync(defFile); const m0 = fs.statSync(defFile).mtimeMs;
  const run = await x.runUi(f.id);
  assert.equal(run.status, 'success');
  await x.uiOk('POST', `/api/flows/${f.id}/memory/s_r`, { text: 'algo aprendido' });
  assert.deepEqual(fs.readFileSync(defFile), before); assert.equal(fs.statSync(defFile).mtimeMs, m0);
  assert.match(fs.readFileSync(x.flowFile(f.id, 'state.json'), 'utf8'), /algo aprendido/);
  const g = await x.getFlow(f.id);
  await x.uiOk('PUT', `/api/flows/${f.id}`, { ...g, name: 'Renombrado Ahora' });
  assert.match(fs.readFileSync(defFile, 'utf8'), /Renombrado Ahora/);
  assert.equal(path.basename(x.flowDir(f.id)), `separado--${f.id}`, 'no se renombra mientras corre');
  const stale = await x.ui('PUT', `/api/flows/${f.id}`, { ...g, baseRev: g.rev || 0, description: 'pestaña vieja' });
  assert.equal(stale.status, 409, 'una pestaña con datos viejos sigue recibiendo conflicto');
  await x.kill(); await x.start();
  assert.equal(path.basename(x.flowDir(f.id)), `renombrado-ahora--${f.id}`);
  assert.deepEqual((await x.uiOk('GET', `/api/flows/${f.id}/runs`)).map((r) => r.id), [run.id]);
  assert.equal((await x.getFlow(f.id)).steps.find((s) => s.id === 's_r').memory[0].text, 'algo aprendido');
});

test('WS-1: borrar un flujo borra su carpeta entera', async () => {
  const x = await fresh('borra');
  await x.start();
  const f = await x.flow('Efímero', [cmd('Eco', 'Write-Output hola', { id: 's_e' })]);
  await x.runUi(f.id);
  const dir = x.flowDir(f.id); assert.ok(fs.existsSync(path.join(dir, 'runs')));
  await x.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.ok(!fs.existsSync(dir));
  assert.equal((await x.ui('GET', `/api/flows/${f.id}`)).status, 404);
});
