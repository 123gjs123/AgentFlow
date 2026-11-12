// Reliability and safety of runs: transient retries (and never after side effects), command retries, step timeout,
// run deadline, cancel/stop (process tree killed), global Claude slot limit with queued status, crash recovery
// (interrupted + orphan processes killed), shell-injection safety in powershell/cmd/bash, schedules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, cmd, sleep, hasBin } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'rel' }); await s.start(); });
after(async () => { await s?.stop(); });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** taskkill runs asynchronously: under load the tree can take a few seconds to disappear. */
const dead = async (pid, ms = 10000) => { for (let t = 0; t < ms; t += 250) { if (!alive(pid)) return true; await sleep(250); } return false; };

test('error transitorio (API 500) → reintento automático y éxito; siempre transitorio → 3 intentos y CLI_ERROR', async () => {
  const a = role('Una vez', '[[mock:transient-once t1]] [[mock:say recuperado]]');
  const b = role('Siempre', '[[mock:transient-always]]');
  const f = await s.flow('Transitorio', [a, b]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'success', run.steps[a.id].error);
  assert.equal(run.steps[a.id].output, 'recuperado');
  assert.deepEqual(run.steps[a.id].attempts.map((x) => [x.reason, x.status]), [['first', 'error'], ['transient', 'success']]);
  assert.ok(run.steps[a.id].events.some((e) => e.kind === 'retry'));
  assert.equal(run.steps[b.id].code, 'CLI_ERROR');
  assert.equal(run.steps[b.id].attempts.length, 3);
});

test('nunca reintenta si el intento fallido ya escribió algo (efectos secundarios)', async () => {
  const a = role('Escribió', '[[mock:write-then-transient]]');
  const f = await s.flow('SinReintento', [a]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].attempts.length, 1);
  assert.ok(run.steps[a.id].events.some((e) => /No se reintenta/.test(e.text || '')));
});

test('el CLI muere sin resultado → se trata como transitorio y se reintenta', async () => {
  const a = role('Crash', '[[mock:crash]]');
  const f = await s.flow('Crash', [a]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'error');
  assert.equal(run.steps[a.id].attempts.length, 3);
  assert.match(run.steps[a.id].error, /boom/);
});

test('comando con retry {max, backoffSec}: reintenta y termina bien', async () => {
  const marker = path.join(s.dirs.work, 'intentos.txt');
  const a = cmd('Inestable', `Add-Content -Path '${marker}' -Value x; if ((Get-Content '${marker}').Count -lt 2) { exit 1 } else { Write-Output listo }`, { retry: { max: 2, backoffSec: 1 } });
  const f = await s.flow('RetryCmd', [a]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'success', run.steps[a.id].error);
  assert.equal(run.steps[a.id].attempts.length, 2);
  assert.equal(run.steps[a.id].output, 'listo');
});

test('timeout del step (TIMEOUT) y deadline de la ejecución (DEADLINE) matan el proceso', async () => {
  const slow = cmd('Lento', 'Start-Sleep -Seconds 60', { timeoutSec: 10 });
  const f1 = await s.flow('Timeout', [slow]);
  const ai = role('IA lenta', '[[mock:sleep 60]]');
  const next = role('Nunca', 'x');
  const f2 = await s.flow('Deadline', [ai, next], [[ai.id, next.id]], { runTimeoutSec: 10 });
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([s.runUi(f1.id, '', { timeoutMs: 40000 }), s.runUi(f2.id, '', { timeoutMs: 40000 })]);
  assert.ok(Date.now() - t0 < 30000, 'no espera los 60 s');
  assert.equal(r1.status, 'timeout');
  assert.equal(r1.steps[slow.id].code, 'TIMEOUT');
  assert.equal(r2.status, 'timeout');
  assert.equal(r2.steps[ai.id].code, 'DEADLINE');
  assert.equal(r2.steps[next.id].skipReason, 'deadline');
  for (const pid of [...(r1.steps[slow.id].pids || []), ...(r2.steps[ai.id].pids || [])]) assert.ok(await dead(pid), `proceso ${pid} sigue vivo`);
});

test('cancelar una ejecución (UI) y detener todo el flujo; la otra ejecución sigue', async () => {
  const a = role('Largo', '[[mock:sleep 30]]');
  const b = role('Después', 'x');
  const f = await s.flow('Cancelar', [a, b], [[a.id, b.id]]);
  const { runId: r1 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '1' });
  const { runId: r2 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '2' });
  await s.waitRun(f.id, r1, 10000, (r) => r.steps?.[a.id]?.pids?.length);
  const c = await s.uiOk('POST', `/api/flows/${f.id}/runs/${r1}/cancel`, {});
  assert.equal(c.status, 'stopped');
  const run1 = await s.waitRun(f.id, r1);
  assert.equal(run1.status, 'stopped');
  assert.equal(run1.steps[a.id].code, 'STOPPED');
  assert.equal(run1.steps[b.id].skipReason, 'cancelled');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/runs/${r2}`)).status, 'running', 'cancelar una no toca la otra');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/${r1}/cancel`, {})).status, 409);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/runs/r_nope/cancel`, {})).status, 404);
  const stop = await s.uiOk('POST', `/api/flows/${f.id}/stop`, {});
  assert.ok(stop.stopped >= 1);
  assert.equal((await s.waitRun(f.id, r2)).status, 'stopped');
  for (const pid of run1.steps[a.id].pids) assert.ok(await dead(pid), 'el proceso de claude se mató');
});

test('cancelar durante la espera de un reintento de comando no lo vuelve a ejecutar', async () => {
  const marker = path.join(s.dirs.work, 'cancel-retry.txt');
  const a = cmd('Reintenta', `Add-Content -Path '${marker}' -Value x; exit 1`, { retry: { max: 3, backoffSec: 5 } });
  const f = await s.flow('CancelRetry', [a]);
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
  await s.waitRun(f.id, runId, 20000, (r) => (r.steps?.[a.id]?.events || []).some((e) => e.kind === 'retry'));
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/cancel`, {});
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'stopped');
  await sleep(1000);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 1);
});

test('inyección: datos externos nunca se ejecutan en powershell, cmd ni bash', async () => {
  const pwn = path.join(s.dirs.work, 'pwned.txt');
  const steps = [
    cmd('PS', 'Write-Output {{input}}; Write-Output "{{vars.v}}"'),
    cmd('CMD', 'echo {{input}} {{vars.v}}', { shell: 'cmd' }),
  ];
  if (await hasBin(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c', 'exit 0'])) steps.push(cmd('BASH', 'echo {{input}} {{vars.v}}', { shell: 'bash' }));
  const f = await s.flow('Inyección', steps, [], { vars: { v: 'x' } });
  const p = pwn.replace(/\\/g, '/');
  const input = `a; New-Item -ItemType File '${p}' & echo pwned> "${p}" $(touch ${p}) \`touch ${p}\` "; New-Item '${p}'; "`;
  const r = await s.runExt(f.id, { input, vars: { v: `"; New-Item -ItemType File '${p}'; " & type nul > "${p}"` } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'success', JSON.stringify(r.body.steps.map((x) => x.error)));
  assert.ok(!fs.existsSync(pwn), 'se ejecutó código inyectado');
  for (const st of r.body.steps) assert.ok(st.output.includes('New-Item'), `${st.step} recibe el dato literal`);
});

test('plantillas: {{x}} entre comillas simples → TEMPLATE_IN_SINGLE_QUOTES; {{{raw}}} con datos externos → 422', async () => {
  const q = cmd('Comillas', "Write-Output '{{input}}'");
  const raw = cmd('Raw', 'Write-Output {{{vars.v}}}');
  const f = await s.flow('Plantillas', [q]);
  const run = await s.runUi(f.id, 'hola');
  assert.equal(run.steps[q.id].code, 'TEMPLATE_IN_SINGLE_QUOTES');
  const g = await s.flow('Raw', [raw], [], { vars: { v: 'ok' } });
  assert.equal((await s.runExt(g.id, { vars: { v: 'malo' } })).body.code, 'RAW_TEMPLATE_EXTERNAL');
  const ok = await s.runExt(g.id, {});
  assert.equal(ok.body.status, 'success', 'sin variable externa el raw es del autor y se permite');
  assert.ok(ok.body.steps[0].warnings === undefined || Array.isArray(ok.body.steps[0].warnings));
});

test('variables por ejecución aisladas entre ejecuciones concurrentes y nunca guardadas en el flujo', async () => {
  const a = cmd('Var', 'Start-Sleep -Milliseconds 800; Write-Output {{vars.v}}');
  const f = await s.flow('Aislamiento', [a], [], { vars: { v: 'base' } });
  const [x, y] = await Promise.all([s.runExt(f.id, { vars: { v: 'A' } }), s.runExt(f.id, { vars: { v: 'B' } })]);
  assert.equal(x.body.steps[0].output, 'A');
  assert.equal(y.body.steps[0].output, 'B');
  assert.equal((await s.getFlow(f.id)).vars.v, 'base');
});

test('programación: el flujo se dispara solo (trigger schedule) y deja de hacerlo al desactivarla', async () => {
  const a = cmd('Tick', 'Write-Output tick');
  const f = await s.flow('Programado', [a], [], { schedule: { enabled: true, everyMinutes: 1, input: 'auto' } }); // 1 min × AFS_TIME_SCALE 0.01 = 0.6 s
  let runs = [];
  for (let i = 0; i < 40 && !runs.length; i++) { await sleep(250); runs = await s.uiOk('GET', `/api/flows/${f.id}/runs`); }
  assert.ok(runs.length >= 1, 'no se disparó');
  const run = await s.uiOk('GET', `/api/flows/${f.id}/runs/${runs[0].id}`);
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.input, 'auto');
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, schedule: { ...g.schedule, enabled: false } });
  await sleep(1500);
  const n = (await s.uiOk('GET', `/api/flows/${f.id}/runs`)).length;
  await sleep(1500);
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/runs`)).length, n);
});

test('límite global de procesos de Claude (AFS_MAX_CLAUDE=1): el segundo step queda "queued" y no se solapan', async () => {
  const q = await startServer({ name: 'queue', env: { AFS_MAX_CLAUDE: '1' } });
  await q.start();
  try {
    const a = role('Q1', '[[mock:sleep 1]] [[mock:say 1]]');
    const b = role('Q2', '[[mock:sleep 1]] [[mock:say 2]]');
    const f = await q.flow('Cola', [a, b]);
    const ws = await q.ws();
    const run = await q.runUi(f.id);
    assert.equal(run.status, 'success');
    const [x, y] = [run.steps[a.id], run.steps[b.id]].sort((m, n) => m.attempts[0].startedAt - n.attempts[0].startedAt);
    assert.ok(y.attempts[0].startedAt >= x.attempts[0].endedAt - 50, 'no se solapan');
    assert.ok(y.events.some((e) => e.kind === 'queued'));
    assert.ok(ws.msgs.some((m) => m.type === 'step.status' && m.status === 'queued'));
  } finally { await q.stop(); }
});

test('caída del servidor durante una ejecución → al reiniciar queda "interrupted" y se matan los procesos huérfanos', async () => {
  const c = await startServer({ name: 'crash' });
  await c.start();
  try {
    const a = role('Colgado', '[[mock:sleep 60]]');
    const f = await c.flow('Caída', [a]);
    const { runId } = await c.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    const live = await c.waitRun(f.id, runId, 10000, (r) => r.steps?.[a.id]?.pids?.length);
    await sleep(300); // let the run file with the pid be written
    await c.kill();
    await c.start();
    const run = await c.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.steps[a.id].code, 'INTERRUPTED');
    assert.equal((await c.getFlow(f.id)).steps[0].lastRun.status, 'interrupted');
    for (const pid of live.steps[a.id].pids) assert.ok(await dead(pid), `huérfano ${pid} sigue vivo`);
  } finally { await c.stop(); }
});
