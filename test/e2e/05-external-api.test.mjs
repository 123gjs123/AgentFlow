// External API (/api/ext) as any caller sees it: auth variants, flows listing, run modes (wait / async + poll /
// events with seq / 202 timedOut), step selection, body formats (JSON, text/plain, raw webhook payload), pins,
// idempotency, dry run, cancel, ask, error codes, inbound log. Plus the guards of the local UI API and WebSocket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s; let flow; let a; let b;
before(async () => {
  s = await startServer({ name: 'ext' }); await s.start();
  a = cmd('Recibir', 'Write-Output "in={{input}} issue={{vars.issue}}"');
  b = role('Resumir', '[[mock:json {"ok":true}]]', { output: { format: 'json' } });
  flow = await s.flow('Revisar ticket', [a, b], [[a.id, b.id]], { vars: { issue: 'NONE', secretish: 'x' }, description: 'desc' });
});
after(async () => { await s?.stop(); });

test('auth: sin token / token malo → 401; Bearer, X-AFS-Token y ?token= → 200', async () => {
  assert.equal((await s.ext('GET', '/ping', undefined, {}, { auth: false })).status, 401);
  assert.equal((await s.ext('GET', '/ping', undefined, { Authorization: 'Bearer nope' }, { auth: false })).status, 401);
  assert.equal((await s.ext('GET', '/ping', undefined, { 'X-AFS-Token': s.token }, { auth: false })).status, 200);
  assert.equal((await s.ext('GET', `/ping?token=${s.token}`, undefined, {}, { auth: false })).status, 200);
  const r = await s.ext('GET', '/ping');
  assert.deepEqual(r.body, { ok: true, app: 'agent-flow-studio' });
});

test('GET /flows lista flujos, steps y SOLO los nombres de las variables', async () => {
  const r = await s.ext('GET', '/flows');
  const f = r.body.find((x) => x.id === flow.id);
  assert.deepEqual(f.vars, ['issue', 'secretish']);
  assert.deepEqual(f.steps.map((x) => x.name), ['Recibir', 'Resumir']);
  assert.ok(!JSON.stringify(r.body).includes('NONE'), 'no expone valores');
});

test('run con wait: resumen con resultado final, JSON, steps, totales, vars de la ejecución; por id o por nombre', async () => {
  for (const ref of [flow.id, 'Revisar ticket', 'revisar TICKET']) {
    const r = await s.runExt(ref, { input: 'SBK-1', vars: { issue: 'SBK-1' }, source: 'jenkins' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'success');
    assert.equal(r.body.trigger, 'jenkins');
    assert.deepEqual(r.body.json, { ok: true });
    assert.equal(r.body.steps[0].output, 'in=SBK-1 issue=SBK-1');
    assert.equal(r.body.vars.issue, 'SBK-1');
    assert.ok(r.body.totals.inputTokens > 0);
    assert.ok(r.body.flowSnapshotHash);
  }
});

test('run asíncrono: runId + statusUrl, polling y eventos incrementales por seq', async () => {
  const r = await s.ext('POST', `/flows/${flow.id}/run`, { input: 'x', vars: { issue: 'A' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'running');
  assert.match(r.body.statusUrl, new RegExp(`/api/ext/flows/${flow.id}/runs/${r.body.runId}$`));
  let st;
  for (let i = 0; i < 100; i++) { st = await s.ext('GET', r.body.statusUrl.replace('/api/ext', '')); if (st.body.status !== 'running') break; await sleep(100); }
  assert.equal(st.body.status, 'success');
  const ev = await s.ext('GET', `/flows/${flow.id}/runs/${r.body.runId}/events`);
  assert.ok(ev.body.events.length > 3);
  assert.ok(ev.body.events.every((e, i, all) => i === 0 || e.seq > all[i - 1].seq), 'seq creciente');
  assert.equal(ev.body.done, true);
  const mid = ev.body.events[2].seq;
  const rest = await s.ext('GET', `/flows/${flow.id}/runs/${r.body.runId}/events?after=${mid}`);
  assert.ok(rest.body.events.every((e) => e.seq > mid));
  assert.equal(rest.body.next, ev.body.next);
  assert.ok(ev.body.events.some((e) => e.kind === 'tool_use' && e.step === 'Recibir'));
});

test('wait con timeoutSec corto → 202 + timedOut; cancelar desde la API externa', async () => {
  const slow = await s.flow('Lento ext', [role('Dormir', '[[mock:sleep 30]]')]);
  const r = await s.runExt(slow.id, { timeoutSec: 1 });
  assert.equal(r.status, 202);
  assert.equal(r.body.timedOut, true);
  const c = await s.ext('POST', `/flows/${slow.id}/runs/${r.body.runId}/cancel`, {});
  assert.equal(c.body.status, 'stopped');
  await s.waitRun(slow.id, r.body.runId, 10000);
  assert.equal((await s.ext('GET', `/flows/${slow.id}/runs/${r.body.runId}`)).body.status, 'stopped');
  const again = await s.ext('POST', `/flows/${slow.id}/runs/${r.body.runId}/cancel`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'RUN_FINISHED');
});

test('solo un step (step por id o nombre; ?step=) y errores FLOW_NOT_FOUND / STEP_NOT_FOUND / RUN_NOT_FOUND / BAD_VARS', async () => {
  const r = await s.runExt(flow.id, { step: 'recibir', input: 'solo' });
  assert.deepEqual(r.body.steps.map((x) => x.step), ['Recibir']);
  const q = await s.ext('POST', `/flows/${flow.id}/run?step=${a.id}&wait=1`, { input: 'q' });
  assert.deepEqual(q.body.steps.map((x) => x.step), ['Recibir']);
  assert.equal((await s.runExt('no-existe', {})).body.code, 'FLOW_NOT_FOUND');
  assert.equal((await s.runExt(flow.id, { step: 'nope' })).body.code, 'STEP_NOT_FOUND');
  assert.equal((await s.ext('GET', `/flows/${flow.id}/runs/r_nope`)).body.code, 'RUN_NOT_FOUND');
  const bv = await s.runExt(flow.id, { vars: ['a'] });
  assert.equal(bv.status, 400); assert.equal(bv.body.code, 'BAD_VARS');
});

test('formatos de cuerpo: text/plain, input objeto, payload de webhook crudo; JSON roto → 400 BAD_REQUEST', async () => {
  const t = await s.ext('POST', `/flows/${flow.id}/run?wait=true`, 'texto plano');
  assert.equal(t.body.steps[0].output, 'in=texto plano issue=NONE');
  const o = await s.runExt(flow.id, { input: { k: 'v' } });
  assert.match(o.body.steps[0].output, /"k": "v"/);
  // Bitbucket/GitHub-like payload with no "input": the whole body is the input
  const hook = await s.ext('POST', `/flows/${flow.id}/run?wait=1`, { push: { changes: [{ new: { name: 'main' } }] }, repository: { full_name: 'org/repo' } });
  assert.match(hook.body.steps[0].output, /"full_name": "org\/repo"/);
  const bad = await fetch(`${s.base}/api/ext/flows/${flow.id}/run`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: '{"input": ' });
  assert.equal(bad.status, 400);
  const j = await bad.json();
  assert.equal(j.code, 'BAD_REQUEST');
  assert.ok(!/at |\\|\//.test(j.error), 'sin stack ni rutas');
});

test('pins: externo los ignora por defecto (ejecuta el step) y los usa con usePins:true', async () => {
  const p1 = role('Fijable', '[[mock:say real]]');
  const p2 = role('Lector', '[[mock:echo]]');
  const f = await s.flow('Pins ext', [p1, p2], [[p1.id, p2.id]]);
  await s.uiOk('POST', `/api/flows/${f.id}/steps/${p1.id}/pin`, { output: 'FIJO' });
  const r1 = await s.runExt(f.id, {});
  assert.equal(r1.body.steps.find((x) => x.step === 'Fijable').output, 'real');
  assert.deepEqual(r1.body.usedPins, []);
  const r2 = await s.runExt(f.id, { usePins: true });
  assert.equal(r2.body.steps.find((x) => x.step === 'Fijable').pinned, true);
  assert.deepEqual(r2.body.usedPins, ['Fijable']);
});

test('Idempotency-Key: repetir → misma ejecución; otro cuerpo → 409; tras un fallo → nueva ejecución; >200 → 400', async () => {
  const k = { 'Idempotency-Key': `build-${Date.now()}` };
  const r1 = await s.runExt(flow.id, { input: 'i1' }, k);
  const r2 = await s.runExt(flow.id, { input: 'i1' }, k);
  assert.equal(r2.body.runId, r1.body.runId);
  assert.equal(r2.body.idempotentReplay, true);
  const r3 = await s.runExt(flow.id, { input: 'otro' }, k);
  assert.equal(r3.status, 409); assert.equal(r3.body.code, 'IDEMPOTENCY_CONFLICT');
  const fail = await s.flow('Falla idem', [cmd('X', 'exit 1')]);
  const kf = { 'Idempotency-Key': 'k-fail' };
  const f1 = await s.runExt(fail.id, {}, kf);
  const f2 = await s.runExt(fail.id, {}, kf);
  assert.equal(f1.body.status, 'error');
  assert.notEqual(f2.body.runId, f1.body.runId, 'un fallo se puede reintentar');
  assert.equal((await s.runExt(flow.id, {}, { 'Idempotency-Key': 'x'.repeat(201) })).body.code, 'BAD_IDEMPOTENCY_KEY');
});

test('dryRun: valida todo sin ejecutar ni registrar la Idempotency-Key; avisa variables desconocidas', async () => {
  const before = (await s.uiOk('GET', `/api/flows/${flow.id}/runs`)).length;
  const r = await s.ext('POST', `/flows/${flow.id}/run`, { input: '', vars: { issue: 'A', nueva: 'B' }, dryRun: true }, { 'Idempotency-Key': 'dry-1' });
  assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.steps, ['Recibir', 'Resumir']);
  assert.ok(r.body.warnings.some((w) => /input vacío/.test(w)));
  assert.ok(r.body.warnings.some((w) => /"nueva" no existe/.test(w)));
  assert.equal((await s.uiOk('GET', `/api/flows/${flow.id}/runs`)).length, before);
  const real = await s.runExt(flow.id, { input: 'otro cuerpo' }, { 'Idempotency-Key': 'dry-1' });
  assert.equal(real.status, 200, 'la clave del dry run no quedó registrada');
});

test('ask: pregunta al flujo (enrutador) o a un step concreto', async () => {
  const g = await s.ext('POST', `/flows/${flow.id}/ask`, { message: 'qué hace este flujo?' });
  assert.equal(g.status, 200);
  assert.equal(g.body.routedTo, 'Flujo general');
  assert.match(g.body.answer, /Respuesta de chat \(mock\)/);
  const st = await s.ext('POST', `/flows/${flow.id}/ask`, { message: 'y vos?', step: 'Resumir' });
  assert.equal(st.body.routedTo, 'Resumir');
  assert.equal((await s.ext('POST', `/flows/${flow.id}/ask`, { message: '' })).status, 400);
});

test('registro de llamadas recibidas: método, ruta, origen, estado, runId, dryRun', async () => {
  const since = Date.now() - 1;
  await s.ext('POST', `/flows/${flow.id}/run`, { input: 'log', source: 'github', dryRun: true });
  await s.ext('GET', '/ping', undefined, { Authorization: 'Bearer malo' }, { auth: false });
  const log = await s.uiOk('GET', `/api/integrations/inbound?since=${since}`);
  const run = log.find((e) => e.source === 'github');
  assert.equal(run.dryRun, true);
  assert.equal(run.status, 200);
  assert.ok(log.some((e) => e.status === 401 && e.path === '/ping'));
});

test('guardas de la API de la UI: proxy/túnel, Origin ajeno, POST sin JSON, Host ajeno → rechazados', async () => {
  for (const h of ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip', 'ngrok-trace-id']) {
    const r = await s.ui('GET', '/api/info', undefined, { [h]: '1.2.3.4' });
    assert.equal(r.status, 403, `${h} debería bloquear la UI`);
  }
  assert.equal((await s.ui('GET', '/api/flows', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.ui('POST', '/api/flows', 'name=x', { 'Content-Type': 'text/plain' })).status, 415);
  // Host header rewritten by a tunnel to something else
  const http = await import('node:http');
  const status = await new Promise((res) => http.get({ host: '127.0.0.1', port: s.port, path: '/api/info', headers: { Host: 'afs.example.com' } }, (r) => { r.resume(); res(r.statusCode); }));
  assert.equal(status, 403);
  // the static UI is also local-only
  assert.equal((await s.ui('GET', '/', undefined, { 'x-forwarded-for': '1.2.3.4' })).status, 403);
  // but /api/ext works through a proxy (with token)
  assert.equal((await s.ext('GET', '/ping', undefined, { 'x-forwarded-for': '1.2.3.4' })).status, 200);
});

test('WebSocket: solo local; transmite run.started / step.status / run.event / run.finished', async () => {
  await assert.rejects(s.ws({ Origin: 'https://evil.example' }));
  await assert.rejects(s.ws({ 'x-forwarded-for': '1.2.3.4' }));
  const w = await s.ws();
  const r = await s.runExt(flow.id, { input: 'ws' });
  const fin = await w.waitFor((m) => m.type === 'run.finished' && m.runId === r.body.runId);
  assert.equal(fin.status, 'success');
  const types = new Set(w.msgs.filter((m) => m.runId === r.body.runId).map((m) => m.type));
  for (const t of ['run.started', 'step.status', 'run.event', 'run.finished']) assert.ok(types.has(t), t);
  assert.ok(w.msgs.some((m) => m.type === 'flow.updated' || m.type === 'flow.changed' || m.flowId === flow.id));
  w.close();
});
