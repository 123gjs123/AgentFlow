// Spec 27: "Necesita atención" (server-side, all flows) + Windows notifications sent by the server.
// Navigation only (D48): nothing here resumes, applies or trusts. Notifications go to AFS_NOTIFY_SINK (JSONL) in tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s; let sink;
before(async () => {
  sink = path.join(fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'afs-sink-')), 'notify.jsonl');
  s = await startServer({ name: 'attention', env: { AFS_NOTIFY_SINK: sink } });
  await s.start();
});
after(async () => { await s?.stop(); });
const att = async () => (await s.uiOk('GET', '/api/attention')).items;
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(100); } };
const sinkLines = () => { try { return fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const setNotify = (b) => s.uiOk('PUT', '/api/settings/notify', b);

test('break en cualquier flujo (UI y API externa) aparece con su destino; al continuar desaparece; nunca se reanuda solo', async () => {
  const a = role('Genera', '[[mock:say listo]]', { id: 's_g', breakpoint: 'after' });
  const f = await s.flow('Con break', [a]);
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
  const it = await until(async () => (await att()).find((i) => i.kind === 'break' && i.runId === runId));
  assert.ok(it, 'aparece el break');
  assert.equal(it.id, `break:${runId}:s_g`);
  assert.equal(it.stepName, 'Genera');
  assert.deepEqual(it.target, { flowId: f.id, open: 'review', runId, stepId: 's_g' });
  assert.equal(it.severity, 'action');
  await sleep(500);
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`)).status, 'paused', 'la lista no toca la ejecución');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'continue' });
  await s.waitRun(f.id, runId);
  assert.ok(await until(async () => !(await att()).some((i) => i.runId === runId)), 'desaparece');
  // external run with breakpoints also shows up, with its trigger
  const ext = await s.ext('POST', `/flows/${f.id}/run`, { input: 'x', breakpoints: true });
  const e = await until(async () => (await att()).find((i) => i.kind === 'break' && i.runId === ext.body.runId));
  assert.equal(e.trigger, 'api');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${ext.body.runId}/resume`, { action: 'stop' });
});

test('ejecución fallida: MCP_UNAVAILABLE lleva a Configuración › CLI; un éxito completo lo limpia; detenida o step suelto manual no cuentan', async () => {
  const RA = 'mcp__claude_ai_Atlassian_Rovo';
  const a = role('Lee Jira', '[[mock:mcp playwright=connected]] [[mock:deny mcp__playwright__browser_navigate]] [[mock:say no pude]]', { id: 's_j', allowedTools: `Read ${RA}__getJiraIssue` });
  const f = await s.flow('Falla MCP', [a]);
  const r1 = await s.runUi(f.id);
  assert.equal(r1.status, 'error');
  const it = await until(async () => (await att()).find((i) => i.id === `fail:${f.id}`));
  assert.equal(it.code, 'MCP_UNAVAILABLE');
  assert.equal(it.title, 'Falló: MCP no disponible');
  assert.deepEqual(it.target, { flowId: f.id, runId: r1.id || it.runId, open: 'settings', tab: 'cli' });
  assert.ok(!/no pude/.test(JSON.stringify(it)), 'nunca la salida del step');
  // a manual single-step success does not clear it
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: '[[mock:say ok]]', allowedTools: 'Read' }] });
  await s.runUi(f.id, '', { stepId: 's_j' });
  await sleep(500);
  assert.ok((await att()).some((i) => i.id === `fail:${f.id}`), 'step suelto manual: sigue');
  await s.runUi(f.id);
  assert.ok(await until(async () => !(await att()).some((i) => i.id === `fail:${f.id}`)), 'ejecución completa OK: se limpia');
});

test('marcar visto: no cuenta, no toca la ejecución; 409 si el estado cambió; reaparece con un fallo nuevo', async () => {
  const a = cmd('Rompe', 'exit 3', { id: 's_x' });
  const f = await s.flow('Visto', [a]);
  await s.runUi(f.id);
  const it = await until(async () => (await att()).find((i) => i.id === `fail:${f.id}`));
  assert.equal((await s.ui('POST', '/api/attention/dismiss', { id: it.id, stateKey: 'viejo' })).status, 409);
  await s.uiOk('POST', '/api/attention/dismiss', { id: it.id, stateKey: it.stateKey });
  assert.equal((await att()).find((i) => i.id === it.id).dismissed, true);
  await s.runUi(f.id);
  const again = await until(async () => (await att()).find((i) => i.id === it.id && i.stateKey !== it.stateKey));
  assert.equal(again.dismissed, false, 'un fallo nuevo vuelve a contar');
  assert.equal((await s.ui('POST', '/api/attention/dismiss', { id: 'fail:nada', stateKey: 'x' })).status, 404);
});

test('flujo importado en revisión y flujo bloqueado por credencial; al habilitar / cargar la credencial desaparecen', async () => {
  const a = cmd('Usa', 'Write-Output "{{cred.svc-att.value}}"', { id: 's_u' });
  const f = await s.flow('Bloqueado', [a]);
  const b = await until(async () => (await att()).find((i) => i.id === `blocked:${f.id}`));
  assert.match(b.title, /Falta la credencial «svc-att»/);
  assert.deepEqual(b.target, { flowId: f.id, open: 'settings', tab: 'credentials', name: 'svc-att' });
  const c = await s.uiOk('POST', '/api/credentials', { type: 'generic', name: 'svc-att', fields: { value: 'v1234' } });
  assert.ok(await until(async () => !(await att()).some((i) => i.id === `blocked:${f.id}`)), 'cargada: desaparece');
  await s.uiOk('DELETE', `/api/credentials/${c.id}`);
  const bundle = await s.uiOk('GET', `/api/flows/${f.id}/export`);
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle: { ...bundle, flow: { ...bundle.flow, name: 'Importado <toast>\u0007 raro' } } });
  const q = await until(async () => (await att()).find((i) => i.id === `quar:${imp.flow.id}`));
  assert.equal(q.target.open, 'quarantine');
  await s.uiOk('POST', `/api/flows/${imp.flow.id}/trust`, {});
  assert.ok(await until(async () => !(await att()).some((i) => i.id === `quar:${imp.flow.id}`)));
  await s.uiOk('DELETE', `/api/flows/${imp.flow.id}`);
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.ok(await until(async () => !(await att()).some((i) => i.flowId === f.id)), 'borrar el flujo quita sus avisos');
});

test('GET /api/attention nunca dispara comprobaciones de red (usa solo el preflight en caché)', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const f = await s.flow('Con URL', [cmd('X', 'Write-Output x')], [], { requirements: [{ id: 'rq_u', type: 'url', url: `http://127.0.0.1:${srv.address().port}/` }] });
    for (let i = 0; i < 5; i++) await att();
    await sleep(400);
    assert.equal(hits, 0);
    await s.uiOk('DELETE', `/api/flows/${f.id}`);
  } finally { srv.close(); }
});

test('rendimiento: con 2000 ejecuciones en disco, los avisos no releen el historial en cada evento', async () => {
  const f = await s.flow('Historial grande', [cmd('Ok', 'Write-Output ok', { id: 's_ok' })]);
  const dir = path.join(s.dirs.data, 'runs', f.id);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 3600e3;
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dir, `r_old${i}.json`), JSON.stringify({ id: `r_old${i}`, flowId: f.id, status: 'success', startedAt: t0 + i, endedAt: t0 + i + 1, steps: {}, events: [] }));
  const g = await s.getFlow(f.id);
  const started = Date.now();
  for (let i = 0; i < 20; i++) await s.uiOk('PUT', `/api/flows/${f.id}`, { ...(await s.getFlow(f.id)), description: `d${i}` });
  for (let i = 0; i < 10; i++) await att();
  assert.ok(Date.now() - started < 8000, `20 guardados + 10 lecturas con 2000 ejecuciones: ${Date.now() - started} ms`);
  void g;
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
});

test('notificaciones: opt-in; un break y un fallo avisan una vez, sin datos de la ejecución; varias juntas no se pierden', async () => {
  fs.rmSync(sink, { force: true });
  const a = role('Secreto', 'SECRET123 [[mock:say SECRET123]]', { id: 's_s', breakpoint: 'after' });
  const f = await s.flow('Avisa <b>&\u0001', [a]);
  // off by default
  let r = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: 'SECRET123' })).runId;
  await until(async () => (await att()).some((i) => i.runId === r));
  await sleep(400);
  assert.equal(sinkLines().length, 0, 'apagado: nada');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${r}/resume`, { action: 'stop' });
  await setNotify({ os: true });
  r = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: 'SECRET123' })).runId;
  const l = await until(() => sinkLines().find((x) => x.kind === 'break'));
  assert.ok(l, 'avisó el break');
  assert.equal(l.title, '⏸ Break esperando revisión');
  assert.match(l.body, /^Avisa b & · Secreto\. La ejecución sigue pausada/);
  assert.ok(!JSON.stringify(sinkLines()).includes('SECRET123'), 'nunca input ni salida');
  assert.match(l.url, new RegExp(`/\\?flow=${f.id}&open=review$`));
  assert.ok(!/[?&]k=/.test(l.url), 'la URL nunca lleva la clave');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${r}/resume`, { action: 'stop' });
  // two failures of different flows at once → combined, none lost
  fs.rmSync(sink, { force: true });
  const b1 = await s.flow('Uno falla', [cmd('E', 'exit 1')]);
  const b2 = await s.flow('Dos falla', [cmd('E', 'exit 1')]);
  await Promise.all([s.runUi(b1.id), s.runUi(b2.id)]);
  const lines = await until(() => { const x = sinkLines(); return x.length && JSON.stringify(x).includes('Dos falla') && JSON.stringify(x).includes('Uno falla') ? x : null; });
  assert.ok(lines, `los dos fallos llegaron: ${JSON.stringify(sinkLines())}`);
  // dedupe: the same failure state does not notify twice
  const n = sinkLines().length;
  await s.uiOk('PUT', `/api/flows/${b1.id}`, { ...(await s.getFlow(b1.id)), description: 'x' });
  await sleep(600);
  assert.equal(sinkLines().length, n, 'sin cambio de estado no repite');
  await setNotify({ os: false });
});

test('ejecuciones programadas: avisa el primer fallo y la recuperación, no cada fallo', async () => {
  fs.rmSync(sink, { force: true });
  await setNotify({ os: true, minIntervalSec: 0 });
  const a = cmd('Prog', 'if ($env:FLOW_INPUT -eq "ok") { "bien" } else { exit 2 }', { id: 's_p' });
  const f = await s.flow('Programado', [a]);
  const run = async (input) => { const r = await s.ext('POST', `/flows/${f.id}/run`, { input, source: 'schedule', wait: true }); return r.body; };
  await run('mal'); await until(() => sinkLines().length >= 1);
  await run('mal'); await sleep(700);
  await run('ok');
  const lines = await until(() => (sinkLines().length >= 2 ? sinkLines() : null));
  assert.deepEqual(sinkLines().map((x) => x.title), ['✗ Falló un flujo', '✓ Volvió a funcionar'], JSON.stringify(sinkLines()));
  void lines;
  await setNotify({ os: false, minIntervalSec: 120 });
});

test('configuración: valida tipos, no expone secretos; probar notificación; plataforma sin soporte', async () => {
  assert.equal((await s.ui('PUT', '/api/settings/notify', { os: 'si' })).status, 400);
  assert.equal((await s.ui('PUT', '/api/settings/notify', { minIntervalSec: -1 })).status, 400);
  const g = await s.uiOk('GET', '/api/settings');
  assert.equal(typeof g.notify.os, 'boolean');
  assert.ok(!JSON.stringify(g).includes(s.token), 'no expone el token');
  fs.rmSync(sink, { force: true });
  const t = await s.uiOk('POST', '/api/settings/notify/test', {});
  assert.equal(t.ok, true);
  assert.equal(sinkLines()[0].kind, 'test');
  const c = await startServer({ name: 'notify-linux', env: { AFS_NOTIFY_PLATFORM: 'linux' } });
  await c.start();
  try {
    const st = await c.uiOk('GET', '/api/settings');
    assert.equal(st.osSupported, false);
    const tl = await c.uiOk('POST', '/api/settings/notify/test', {});
    assert.equal(tl.unsupported, true);
  } finally { await c.stop(); }
});

test('chequeo de instalación: CLI, sesión, conectores del flujo abierto vs cargados, certificados y carpeta; sin valores de entorno', async () => {
  const RA = 'mcp__claude_ai_Atlassian_Rovo';
  const f = await s.flow('Chequeo', [role('Jira', 'x', { allowedTools: `Read ${RA}__getJiraIssue mcp__otro_conector__leer` })]);
  await s.uiOk('POST', '/api/catalog/probe', {});
  const r = await s.uiOk('GET', `/api/system/check?flow=${f.id}&fresh=1`);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(by.cli.ok, true);
  assert.match(by.cli.detail, /claude-mock/);
  assert.equal(by.data.ok, true);
  assert.equal(by.mcp.ok, false);
  assert.match(by.mcp.detail, /usados por este flujo y NO cargados: otro conector \(Jira\)/);
  assert.match(by.mcp.fix, /claude mcp list/);
  assert.ok(['tls', 'login'].every((k) => by[k]));
  assert.ok(!JSON.stringify(r).includes(process.env.HTTPS_PROXY || '§§'), 'no expone el valor del proxy');
});

test('reinicio con un break pendiente: aparece como interrumpida "mientras esperaba revisión"; al arrancar no hay ráfaga de avisos, solo un resumen', async () => {
  const c = await startServer({ name: 'attention-boot', env: { AFS_NOTIFY_SINK: sink } });
  await c.start();
  try {
    await c.uiOk('PUT', '/api/settings/notify', { os: true });
    const f = await c.flow('Reinicio', [role('Espera', '[[mock:say x]]', { id: 's_w', breakpoint: 'after' })]);
    const { runId } = await c.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await c.waitRun(f.id, runId, 20000, (r) => r.status === 'paused');
    await sleep(500);
    fs.rmSync(sink, { force: true });
    await c.kill(); await c.start();
    const it = await until(async () => (await c.uiOk('GET', '/api/attention')).items.find((i) => i.id === `fail:${f.id}`));
    assert.equal(it.code, 'INTERRUPTED');
    assert.equal(it.severity, 'warn');
    assert.match(it.detail, /mientras «Espera» esperaba revisión/);
    await sleep(800);
    assert.deepEqual(sinkLines().map((x) => x.kind), ['boot'], 'un único resumen al arrancar');
  } finally { await c.stop(); }
});

// ---------- adversarial review of the implementation ----------
test('sin cambios no se emite attention.changed (guardar el flujo varias veces no inunda el WebSocket)', async () => {
  const f = await s.flow('Sin ruido', [cmd('X', 'exit 1', { id: 's_n' })]);
  await s.runUi(f.id);
  await until(async () => (await att()).some((i) => i.id === `fail:${f.id}`));
  await sleep(400);
  const w = await s.ws();
  for (let i = 0; i < 5; i++) await s.uiOk('PUT', `/api/flows/${f.id}`, { ...(await s.getFlow(f.id)), description: `cambio ${i}` });
  await sleep(800);
  assert.equal(w.msgs.filter((m) => m.type === 'attention.changed').length, 0, 'ningún attention.changed sin cambios');
  w.close();
});

test('fallo programado que vence la ventana: se olvida sin un "volvió a funcionar" falso', async () => {
  const c = await startServer({ name: 'attention-window', env: { AFS_NOTIFY_SINK: sink, AFS_FAIL_WINDOW_SEC: '2' } });
  await c.start();
  try {
    await c.uiOk('PUT', '/api/settings/notify', { os: true, minIntervalSec: 0 });
    const f = await c.flow('Vence', [cmd('E', 'exit 2')]);
    fs.rmSync(sink, { force: true });
    await c.ext('POST', `/flows/${f.id}/run`, { input: 'x', source: 'schedule', wait: true });
    await until(() => sinkLines().length >= 1);
    await sleep(2300);
    await c.uiOk('PUT', `/api/flows/${f.id}`, { ...(await c.getFlow(f.id)), description: 'recalcular' });
    await sleep(900);
    assert.deepEqual(sinkLines().map((x) => x.title), ['✗ Falló un flujo'], 'sin recuperación falsa');
    assert.ok(!(await c.uiOk('GET', '/api/attention')).items.some((i) => i.flowId === f.id), 'vencido: fuera de la lista');
  } finally { await c.stop(); }
});

test('reinicio con el fallo resuelto en disco: el siguiente fallo programado SÍ avisa', async () => {
  const c = await startServer({ name: 'attention-resolved', env: { AFS_NOTIFY_SINK: sink } });
  await c.start();
  try {
    await c.uiOk('PUT', '/api/settings/notify', { os: true, minIntervalSec: 0 });
    const f = await c.flow('Resuelto apagado', [cmd('P', 'if ($env:FLOW_INPUT -eq "ok") { "bien" } else { exit 2 }')]);
    fs.rmSync(sink, { force: true });
    await c.ext('POST', `/flows/${f.id}/run`, { input: 'mal', source: 'schedule', wait: true });
    await until(() => sinkLines().length >= 1);
    await c.kill();
    // while the server was down a complete run succeeded (written straight to disk)
    const dir = path.join(c.dirs.data, 'runs', f.id);
    fs.writeFileSync(path.join(dir, 'r_okoffline.json'), JSON.stringify({ id: 'r_okoffline', flowId: f.id, status: 'success', trigger: 'schedule', startedAt: Date.now(), endedAt: Date.now() + 1, steps: {}, events: [] }));
    await c.start();
    fs.rmSync(sink, { force: true });
    await c.ext('POST', `/flows/${f.id}/run`, { input: 'mal', source: 'schedule', wait: true });
    const l = await until(() => sinkLines().find((x) => x.title === '✗ Falló un flujo'));
    assert.ok(l, `avisó el nuevo fallo: ${JSON.stringify(sinkLines())}`);
  } finally { await c.stop(); }
});
