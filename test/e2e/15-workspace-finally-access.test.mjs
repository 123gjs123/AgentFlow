// Spec 22: generic, opt-in pieces for flows that build things (repos, images, Argo…) while simple flows stay as they
// are: safe working directory (B1), "Al terminar (siempre)" (B2), {{run.id}} templates (B3), restricted access (B4).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'env22' }); await s.start(); });
after(async () => { await s?.stop(); });

test('B1: directorio de trabajo que no existe → no arranca (CWD_MISSING), ni desde la UI ni por la API externa', async () => {
  const f = await s.flow('Cwd roto', [role('A', '[[mock:say a]]')], [], { cwd: path.join(s.dirs.work, 'no-existe') });
  const ui = await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' });
  assert.equal(ui.status, 422); assert.equal(ui.body.code, 'CWD_MISSING');
  const ext = await s.runExt(f.id, {});
  assert.equal(ext.status, 422); assert.equal(ext.body.code, 'CWD_MISSING');
  const dry = await s.ext('POST', `/flows/${f.id}/run`, { dryRun: true });
  assert.equal(dry.body.code, 'CWD_MISSING', 'el dry run también lo detecta');
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/${f.steps[0].id}/preview`, {});
  assert.ok(pv.warnings.some((w) => w.code === 'CWD_MISSING'));
});

test('B1: sin directorio, los steps que editan/ejecutan avisan; los que solo leen o razonan no cambian (flujo simple)', async () => {
  const writer = role('Escribe', '[[mock:say ok]]', { id: 's_w', allowedTools: 'Read Edit Write', permissionMode: 'acceptEdits' });
  const reader = role('Lee', '[[mock:say ok]]', { id: 's_r', allowedTools: 'Read Grep' });
  const thinker = role('Piensa', '[[mock:say ok]]', { id: 's_t', allowedTools: '' });
  const f = await s.flow('Sin cwd', [writer, reader, thinker]);
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'success');
  assert.ok(run.steps.s_w.warnings.some((w) => /no tiene directorio de trabajo/.test(w)));
  assert.ok(!run.steps.s_r.warnings.some((w) => /directorio/.test(w)));
  assert.ok(!run.steps.s_t.warnings.some((w) => /directorio/.test(w)));
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_w/preview`, {});
  assert.ok(pv.warnings.some((w) => w.code === 'CWD_EMPTY'));
});

test('B2: "Al terminar" corre siempre (éxito, error, detenido) con el estado; no cambia el resultado; no corre en un step suelto', async () => {
  const log = path.join(s.dirs.work, 'finally.log');
  const fin = { command: `Add-Content -Path '${log}' -Value ("$env:AFS_RUN_STATUS|$env:AFS_RUN_ID|" + {{vars.tag}}); Write-Output limpio`, shell: 'powershell', timeoutSec: 30 };
  const ok = await s.flow('Fin ok', [cmd('A', 'Write-Output a', { id: 's_fa' })], [], { finally: fin, vars: { tag: 'T1' } });
  let run = await s.runUi(ok.id);
  assert.equal(run.status, 'success');
  assert.equal(run.finally.status, 'success');
  assert.equal(run.finally.output, 'limpio');
  assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`success\\|${run.id}\\|T1`));
  const bad = await s.flow('Fin error', [cmd('B', 'exit 3', { id: 's_fb' })], [], { finally: fin, vars: { tag: 'T2' } });
  run = await s.runUi(bad.id);
  assert.equal(run.status, 'error', 'el resultado de la ejecución no cambia');
  assert.equal(run.finally.runStatus, 'error');
  const slow = await s.flow('Fin stop', [role('Lento', '[[mock:sleep 20]]', { id: 's_fs' })], [], { finally: fin, vars: { tag: 'T3' } });
  const { runId } = await s.uiOk('POST', `/api/flows/${slow.id}/run`, { input: '' });
  await s.waitRun(slow.id, runId, 10000, (r) => r.steps?.s_fs?.status === 'running');
  await s.uiOk('POST', `/api/flows/${slow.id}/runs/${runId}/cancel`, {});
  run = await s.waitRun(slow.id, runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.finally.runStatus, 'stopped');
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  // single-step runs don't trigger it
  await s.runUi(ok.id, '', { stepId: 's_fa' });
  assert.equal(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).length, 3);
  // external summary exposes it
  const ext = await s.runExt(ok.id, {});
  assert.equal(ext.body.finally.status, 'success');
  // a failing "Al terminar" is reported, run keeps its status
  const f2 = await s.flow('Fin falla', [cmd('C', 'Write-Output c')], [], { finally: { command: 'exit 9' } });
  run = await s.runUi(f2.id);
  assert.equal(run.status, 'success');
  assert.equal(run.finally.status, 'error');
  assert.equal(run.finally.exitCode, 9);
});

test('B2: tras una caída del servidor, "Al terminar" corre para la ejecución interrumpida (limpieza garantizada)', async () => {
  const c = await startServer({ name: 'fincrash' }); await c.start();
  try {
    const mark = path.join(c.dirs.work, 'cleanup.txt');
    const f = await c.flow('Fin caída', [role('Colgado', '[[mock:sleep 60]]', { id: 's_fc' })], [], { finally: { command: `Set-Content -Path '${mark}' -Value $env:AFS_RUN_STATUS` } });
    const { runId } = await c.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
    await c.waitRun(f.id, runId, 10000, (r) => r.steps?.s_fc?.pids?.length);
    await sleep(300);
    await c.kill(); await c.start();
    for (let i = 0; i < 60 && !fs.existsSync(mark); i++) await sleep(200);
    assert.equal(fs.readFileSync(mark, 'utf8').trim(), 'interrupted');
    let run;
    for (let i = 0; i < 40; i++) { run = await c.uiOk('GET', `/api/flows/${f.id}/runs/${runId}`); if (run.finally) break; await sleep(150); }
    assert.equal(run.status, 'interrupted');
    assert.equal(run.finally.status, 'success');
  } finally { await c.stop(); }
});

test('B2: plantillas {{{raw}}} con datos externos en "Al terminar" → 422; se guarda saneado', async () => {
  const f = await s.flow('Fin raw', [cmd('A', 'Write-Output a')], [], { vars: { v: 'x' }, finally: { command: 'Write-Output {{{vars.v}}}', shell: 'nada', timeoutSec: 99999, extra: 1 } });
  const g = await s.getFlow(f.id);
  assert.deepEqual(g.finally, { command: 'Write-Output {{{vars.v}}}', shell: 'powershell', timeoutSec: 3600 });
  const r = await s.runExt(f.id, { vars: { v: 'malo' } });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'RAW_TEMPLATE_EXTERNAL');
});

test('B3: {{run.id}} / {{run.short}} / {{run.date}} en tareas, comandos y referencias de contexto', async () => {
  const a = role('Rama', 'Trabaja en la rama afs/cov-{{run.short}} del {{run.date}} [[mock:echo]]', { id: 's_ra', contextSources: [{ id: 'j', type: 'jira', ref: 'project = X AND labels = "{{run.short}}"' }] });
  const b = cmd('Proyecto', 'Write-Output "afs-{{run.id}}"', { id: 's_rb' });
  const f = await s.flow('Run id', [a, b]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  const short = run.id.replace(/^r_/, '');
  assert.match(run.steps.s_ra.output, new RegExp(`afs/cov-${short} del \\d{4}-\\d{2}-\\d{2}`));
  assert.equal(run.steps.s_rb.output, `afs-${run.id}`);
  assert.ok(s.callsSince(n).some((c) => c.append.includes(`labels = "${short}"`)), 'la referencia de contexto usa el id de la ejecución');
});

test('B4: acceso "terminal restringida": --tools habilita Bash pero solo se preaprueban git (sin push) y docker; sin web', async () => {
  const restricted = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git switch', 'git checkout', 'git fetch', 'git branch', 'git rev-parse', 'docker', 'docker compose'].map((c) => `Bash(${c}:*)`).join(' ');
  const a = role('Dev', '[[mock:say ok]]', { id: 's_dev', allowedTools: `Read Grep Glob Skill Edit Write ${restricted}`, permissionMode: 'acceptEdits' });
  const f = await s.flow('Restringido', [a], [], { cwd: s.dirs.work });
  const n = s.calls().length;
  await s.runUi(f.id);
  const c = s.callsSince(n)[0];
  assert.deepEqual(s.argOf(c, '--tools').split(',').sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'ToolSearch', 'Write'].sort());
  const allowed = s.argOf(c, '--allowedTools');
  assert.match(allowed, /Bash\(docker compose:\*\)/);
  assert.match(allowed, /Bash\(git commit:\*\)/);
  assert.ok(!/git push/.test(allowed), 'sin push');
  assert.ok(!/WebFetch|WebSearch/.test(allowed + s.argOf(c, '--tools')), 'sin web');
});
