// The two local clients: `afs` CLI (all commands, options and exit codes 0/1/2/3) and the MCP server over stdio
// (initialize, tools/list, run_flow, get_run, cancel_run, ask_flow, list_flows, isError/structuredContent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, cmd } from './helpers/harness.mjs';

let s; let ok; let bad; let slow;
before(async () => {
  s = await startServer({ name: 'cli' }); await s.start();
  ok = await s.flow('Flujo OK', [cmd('Eco', 'Write-Output "in={{input}} v={{vars.v}}"'), role('Final', '[[mock:json {"r":1}]]', { output: { format: 'json' } })], [], { vars: { v: 'def' } });
  ok = await s.uiOk('PUT', `/api/flows/${ok.id}`, { ...ok, edges: [{ id: 'e', source: ok.steps[0].id, target: ok.steps[1].id }] });
  bad = await s.flow('Flujo Malo', [cmd('Rompe', 'exit 3')]);
  slow = await s.flow('Flujo Lento', [role('Dormir', '[[mock:sleep 30]]')]);
});
after(async () => { await s?.stop(); });

test('afs help / uso incorrecto → exit 2', async () => {
  const h = await s.afs(['help']);
  assert.equal(h.code, 0); assert.match(h.stdout, /afs run/);
  assert.equal((await s.afs(['run'])).code, 2);
  assert.equal((await s.afs(['nope'])).code, 2);
  assert.equal((await s.afs(['status', 'x'])).code, 2);
});

test('afs list (texto y --json)', async () => {
  const t = await s.afs(['list']);
  assert.equal(t.code, 0);
  assert.match(t.stdout, /Flujo OK .*\n\s+Eco → Final/);
  const j = JSON.parse((await s.afs(['list', '--json'])).stdout);
  assert.deepEqual(j.find((f) => f.id === ok.id).vars, ['v']);
});

test('afs run: -i, --var, stdin, -f, --step, --json, --follow; exit 0 y resultado en stdout', async () => {
  const r = await s.afs(['run', 'Flujo OK', '-i', 'hola', '--var', 'v=x=1', '--follow']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Resultado del step\./);
  assert.match(r.stderr, /✔ Eco success/);
  assert.match(r.stderr, /\[Eco\] → shell:powershell/, '--follow muestra la actividad');
  const j = JSON.parse((await s.afs(['run', ok.id, '--json', '--var', 'v=y'], { input: 'desde stdin' })).stdout);
  assert.equal(j.steps[0].output, 'in=desde stdin v=y');
  assert.equal(j.trigger, 'cli');
  const file = path.join(s.dirs.work, 'in.txt'); fs.writeFileSync(file, 'de archivo');
  const st = JSON.parse((await s.afs(['run', 'Flujo OK', '-f', file, '-s', 'Eco', '--json'])).stdout);
  assert.deepEqual(st.steps.map((x) => x.step), ['Eco']);
  assert.match(st.steps[0].output, /de archivo/);
});

test('afs run de un flujo que falla → exit 1 con el código del step; flujo inexistente → exit 1', async () => {
  const r = await s.afs(['run', 'Flujo Malo', '-i', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EXIT_NONZERO/);
  const nf = await s.afs(['run', 'No existe', '-i', 'x']);
  assert.equal(nf.code, 1);
  assert.match(nf.stderr, /FLOW_NOT_FOUND/);
});

test('afs run --timeout corto → exit 3; --no-wait + status + cancel', async () => {
  const t = await s.afs(['run', 'Flujo Lento', '-i', 'x', '--timeout', '1']);
  assert.equal(t.code, 3);
  assert.match(t.stderr, /afs cancel/);
  const nw = await s.afs(['run', 'Flujo Lento', '-i', 'x', '--no-wait']);
  const runId = nw.stdout.trim();
  assert.match(runId, /^r_/);
  const st = await s.afs(['status', 'Flujo Lento', runId]);
  assert.equal(st.code, 0); assert.match(st.stdout, /^running/);
  const c = await s.afs(['cancel', 'Flujo Lento', runId]);
  assert.equal(c.code, 0); assert.match(c.stdout, /stopped/);
  // clean the run left by the --timeout call
  await s.uiOk('POST', `/api/flows/${slow.id}/stop`, {});
});

test('afs --dry-run, --key (idempotencia), --pins, --deadline', async () => {
  const d = await s.afs(['run', 'Flujo OK', '-i', 'x', '--dry-run']);
  assert.equal(d.code, 0); assert.match(d.stdout, /se ejecutarían 2 step\(s\): Eco → Final/);
  const k1 = JSON.parse((await s.afs(['run', 'Flujo OK', '-i', 'k', '--key', 'cli-k1', '--json'])).stdout);
  const k2 = await s.afs(['run', 'Flujo OK', '-i', 'k', '--key', 'cli-k1']);
  assert.match(k2.stderr, new RegExp(`se reutilizó la ejecución ${k1.runId}`));
  await s.uiOk('POST', `/api/flows/${ok.id}/steps/${ok.steps[0].id}/pin`, { output: 'PIN' });
  const p = JSON.parse((await s.afs(['run', 'Flujo OK', '-i', 'p', '--pins', '--json'])).stdout);
  assert.deepEqual(p.usedPins, ['Eco']);
  const np = JSON.parse((await s.afs(['run', 'Flujo OK', '-i', 'p', '--json'])).stdout);
  assert.deepEqual(np.usedPins, [], 'sin --pins se ejecuta todo');
  await s.uiOk('DELETE', `/api/flows/${ok.id}/steps/${ok.steps[0].id}/pin`);
  const dl = JSON.parse((await s.afs(['run', 'Flujo Lento', '-i', 'x', '--deadline', '10', '--json'])).stdout);
  assert.equal(dl.status, 'timeout');
});

test('afs ask (flujo y --step)', async () => {
  const a = await s.afs(['ask', 'Flujo OK', '¿qué', 'hacés?']);
  assert.equal(a.code, 0); assert.match(a.stderr, /responde: Flujo general/);
  const b = await s.afs(['ask', 'Flujo OK', 'hola', '--step', 'Final']);
  assert.match(b.stderr, /responde: Final/);
});

test('afs con token inválido → exit 1 con UNAUTHORIZED (no arranca otro servidor)', async () => {
  const r = await s.afs(['list'], { env: { AFS_TOKEN: 'malo' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /UNAUTHORIZED/);
});

test('MCP: initialize, tools/list, list_flows, run_flow (ok / error / wait:false), get_run, cancel_run, ask_flow, método desconocido', async () => {
  const m = s.mcp();
  try {
    const init = await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'agent-flow-studio');
    m.notify('notifications/initialized', {});
    const tools = (await m.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.deepEqual(tools.sort(), ['ask_flow', 'cancel_run', 'get_run', 'list_flows', 'run_flow']);
    const call = async (name, args) => (await m.request('tools/call', { name, arguments: args })).result;
    const list = await call('list_flows', {});
    assert.match(list.content[0].text, /Flujo OK/);
    assert.match(list.content[0].text, /variables: v/);
    const r = await call('run_flow', { flow: 'Flujo OK', input: 'mcp', vars: { v: 'm' }, idempotencyKey: 'mcp-1' });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.status, 'success');
    assert.equal(r.structuredContent.trigger, 'mcp');
    assert.match(r.content[0].text, /Resultado estructurado:\n```json/);
    const again = await call('run_flow', { flow: 'Flujo OK', input: 'mcp', vars: { v: 'm' }, idempotencyKey: 'mcp-1' });
    assert.equal(again.structuredContent.runId, r.structuredContent.runId);
    const e = await call('run_flow', { flow: 'Flujo Malo' });
    assert.equal(e.isError, true);
    assert.match(e.content[0].text, /EXIT_NONZERO/);
    const nw = await call('run_flow', { flow: 'Flujo Lento', wait: false });
    const runId = nw.structuredContent.runId;
    const g = await call('get_run', { flow: 'Flujo Lento', runId });
    assert.equal(g.structuredContent.status, 'running');
    assert.notEqual(g.isError, true);
    const c = await call('cancel_run', { flow: 'Flujo Lento', runId });
    assert.equal(c.structuredContent.status, 'stopped');
    const ask = await call('ask_flow', { flow: 'Flujo OK', message: 'hola' });
    assert.match(ask.content[0].text, /responde: Flujo general/);
    const nf = await call('run_flow', { flow: 'No existe' });
    assert.equal(nf.isError, true); assert.match(nf.content[0].text, /FLOW_NOT_FOUND/);
    const unknown = await m.request('foo/bar', {});
    assert.equal(unknown.error.code, -32601);
  } finally { m.close(); }
});
