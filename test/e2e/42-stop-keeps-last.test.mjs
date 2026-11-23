// Stopping a run does not erase what the steps last produced: a step that never ran in the stopped run (waiting at a
// «before» break, or not reached) keeps its last real result, so «Desde aquí» and {{steps.X}} still have it. Only
// the stopped run's own record says it was skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'stop-keeps-last' }); await s.start(); });
after(async () => { await s?.stop(); });

test('detener en un break «antes» no pisa el último resultado de los pasos que no corrieron', async () => {
  const f = await s.flow('Detener', [
    role('Primero', '[[mock:say uno]]', { id: 's_1', breakpoint: 'before' }),
    role('Segundo', '[[mock:say dos]]', { id: 's_2' }),
  ], [['s_1', 's_2']]);
  const ok = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: 'IN', breakpoints: false });
  const good = await s.waitRun(f.id, ok.runId);
  assert.equal(good.status, 'success');
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: 'IN' })).runId;
  await s.waitRun(f.id, runId, 30000, (r) => r.status === 'paused' || !['running', 'queued'].includes(r.status));
  await s.uiOk('POST', `/api/flows/${f.id}/stop`, {});
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.steps.s_1.skipReason, 'cancelled', 'la ejecución detenida sí dice que se omitió');
  assert.equal(run.steps.s_2.skipReason, 'cancelled');
  const g = await s.getFlow(f.id);
  for (const [id, out] of [['s_1', 'uno'], ['s_2', 'dos']]) {
    const lr = g.steps.find((x) => x.id === id).lastRun;
    assert.equal(lr.status, 'success', `${id}: sigue el último resultado real`);
    assert.equal(lr.runId, ok.runId);
    assert.match(lr.output, new RegExp(out));
  }
});
