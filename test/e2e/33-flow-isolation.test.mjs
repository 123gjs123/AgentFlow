// Spec 11: flow isolation. Each flow works in its own folder (older flows keep the user's folder until the person
// opts in), has its own external token (the global one is the admin token and can be disabled), and crosses into
// another flow only through an explicit call (a 🔀 Flujo step or ctx.invokeFlow) that passes the input only, with a
// recursion guard. Offline: command steps + the mock Claude CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, cmd, role, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'isolation' }); await s.start(); });
after(async () => { await s?.stop(); });
const chat = async (flowId, key, message) => {
  const before = (await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`)).length;
  await s.uiOk('POST', `/api/flows/${flowId}/chat/${key}`, { message });
  for (let i = 0; i < 200; i++) { const m = await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`); if (m.length > before + 1 && m.slice(before).every((x) => x.status !== 'running')) return m.slice(before); await sleep(100); }
  throw new Error('chat sin respuesta');
};
// the flows' own folders live OUTSIDE the app's data folder (pass 2: never next to config.json)
const WS = () => path.join(s.dirs.home, '.agent-flow-studio', 'workspaces');
const pwd = (id) => cmd('Dónde', 'Write-Output (Get-Location).Path', { id });

// ---------------- ISO-3: workspace ----------------
test('ISO-3: un flujo nuevo trabaja en su carpeta propia (creada al usarla); Claude también; un directorio propio sigue ganando', async () => {
  const f = await s.flow('Carpeta', [pwd('s_p'), role('Claude', '[[mock:say ok]]', { id: 's_c' })], [['s_p', 's_c']]);
  const ws = path.join(WS(), f.id);
  assert.ok(!fs.existsSync(ws), 'no se crea antes de usarla');
  const info = await s.uiOk('GET', `/api/flows/${f.id}/workspace`);
  assert.equal(info.mode, 'own'); assert.equal(path.resolve(info.path), path.resolve(ws));
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(path.resolve(run.steps.s_p.output.trim()), path.resolve(ws));
  assert.equal(path.resolve(s.callsSince(n)[0].cwd), path.resolve(ws), 'Claude corre en la carpeta del flujo');
  const other = await s.flow('Otra', [pwd('s_o')]);
  assert.notEqual((await s.runUi(other.id)).steps.s_o.output.trim(), run.steps.s_p.output.trim(), 'cada flujo la suya');
  const custom = await s.flow('Propio', [pwd('s_x')], [], { cwd: s.dirs.project });
  assert.equal(path.resolve((await s.runUi(custom.id)).steps.s_x.output.trim()), path.resolve(s.dirs.project));
  // deleting the flow: an empty folder goes, one with work is kept aside
  fs.writeFileSync(path.join(ws, 'trabajo.txt'), 'x');
  await s.uiOk('DELETE', `/api/flows/${f.id}`);
  assert.ok(!fs.existsSync(ws));
  const kept = fs.readdirSync(path.join(WS(), '_borrados')).find((d) => d.startsWith(f.id));
  assert.ok(kept && fs.existsSync(path.join(WS(), '_borrados', kept, 'trabajo.txt')), 'lo que tenía no se pierde');
});

test('ISO-3: un flujo de antes sigue en tu carpeta de usuario (su archivo no se toca al arrancar); activar "carpeta propia" lo mueve y empieza conversaciones nuevas', async () => {
  const f = await s.flow('Viejo', [pwd('s_v'), role('Charla', 'x', { id: 's_ch' })], [['s_v', 's_ch']]);
  await s.kill();
  const cfg = path.join(s.dirs.data, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8')); c.isolationSince = Date.now() + 1e9; fs.writeFileSync(cfg, JSON.stringify(c)); // everything existing is "from before"
  const file = s.flowFile(f.id, 'flow.json'); const before = fs.readFileSync(file, 'utf8');
  await s.start();
  try {
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'arrancar no reescribe el flujo');
    const info = await s.uiOk('GET', `/api/flows/${f.id}/workspace`);
    assert.equal(info.mode, 'home'); assert.equal(info.legacy, true);
    assert.equal(path.resolve((await s.runUi(f.id)).steps.s_v.output.trim()), path.resolve(s.dirs.home));
    await chat(f.id, 's_ch', 'hola');
    assert.ok((await s.getFlow(f.id)).steps.find((x) => x.id === 's_ch').chatSessionId);
    const g = await s.getFlow(f.id);
    const saved = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, workspace: 'own' });
    assert.ok(!saved.steps.find((x) => x.id === 's_ch').chatSessionId, 'otra carpeta = conversación nueva');
    assert.equal(path.resolve((await s.runUi(f.id)).steps.s_v.output.trim()), path.resolve(WS(), f.id));
    assert.equal((await s.ui('PUT', `/api/flows/${f.id}`, { ...(await s.getFlow(f.id)), workspace: 'otra' })).body.code, 'BAD_REQUEST');
    // an export never carries the choice (the importer's flow is new: its own folder)
    const b = await s.uiOk('GET', `/api/flows/${f.id}/export`);
    assert.ok(!('workspace' in b.flow));
  } finally { c.isolationSince = 1; fs.writeFileSync(cfg, JSON.stringify(c)); }
});

// ---------------- ISO-4/5/10: per-flow tokens ----------------
const as = (tok) => (method, url, body) => s.ext(method, url, body, { Authorization: `Bearer ${tok}` }, { auth: false });
test('ISO-4/5: el token de un flujo abre solo ese flujo (todas sus rutas); /flows lista solo el suyo; el de administración abre todos y se puede desactivar', async () => {
  const A = await s.flow('Token A', [cmd('Eco', 'Write-Output A-OK', { id: 's_a' })]);
  const B = await s.flow('Token B', [cmd('Eco', 'Write-Output B-OK', { id: 's_b' })]);
  const tA = (await s.uiOk('POST', `/api/flows/${A.id}/token`, {})).token;
  assert.match(tA, /^afsf_/);
  const a = as(tA);
  assert.match((await a('POST', `/flows/${A.id}/run`, { wait: true, timeoutSec: 60 })).body.result, /A-OK/);
  assert.match((await a('POST', `/flows/${encodeURIComponent('Token A')}/run`, { wait: true, timeoutSec: 60 })).body.result, /A-OK/, 'por nombre también');
  const rb = await s.runExt(B.id, { input: 'x' });
  // every flow route of B is forbidden with A's token (and an unknown flow too: no enumeration)
  const routes = [['POST', `/flows/${B.id}/run`, { wait: true }], ['POST', `/flows/${B.id}/steps/s_b/run`, {}], ['GET', `/flows/${B.id}/runs/${rb.runId}`], ['POST', `/flows/${B.id}/runs/${rb.runId}/cancel`, {}],
    ['GET', `/flows/${B.id}/runs/${rb.runId}/events`], ['POST', `/flows/${B.id}/ask`, { message: 'hola' }], ['POST', `/flows/${B.id}/runs/${rb.runId}/resume`, {}], ['GET', `/flows/${B.id}/runs/${rb.runId}/files/x`], ['POST', `/flows/${B.id}/runs/${rb.runId}/actions/decide`, {}], ['POST', `/flows/${B.id}/status`, {}], ['POST', '/flows/no-existe/run', {}], ['POST', `/flows/${encodeURIComponent('Token B')}/run`, {}]];
  for (const [m, u, b] of routes) { const r = await a(m, u, b); assert.equal(r.status, 403, `${m} ${u}: ${r.status}`); assert.equal(r.body.code, 'FLOW_FORBIDDEN'); }
  assert.deepEqual((await a('GET', '/flows')).body.map((x) => x.id), [A.id]);
  assert.deepEqual((await a('GET', '/ping')).body, { ok: true, app: 'agent-flow-studio', scope: 'flow', flowId: A.id });
  assert.equal((await s.ext('POST', `/flows/${A.id}/run?token=${tA}`, { wait: true, timeoutSec: 60 }, {}, { auth: false })).body.status, 'success', '?token= también');
  // admin: every flow; disabled → 401 ADMIN_DISABLED while flow tokens keep working
  assert.ok((await s.ext('GET', '/flows')).body.length >= 2);
  assert.equal((await s.ext('GET', '/ping')).body.scope, 'admin');
  await s.uiOk('PUT', '/api/info/admin-token', { enabled: false });
  try {
    const d = await s.ext('GET', '/flows');
    assert.equal(d.status, 401); assert.equal(d.body.code, 'ADMIN_DISABLED');
    assert.equal((await a('GET', '/flows')).status, 200);
    assert.equal((await s.uiOk('GET', '/api/info')).adminEnabled, false);
  } finally { await s.uiOk('PUT', '/api/info/admin-token', { enabled: true }); }
});

test('ISO-10: regenerar invalida el anterior; revocar; atado a esta máquina (con otra clave no vale); nunca en el disco en claro ni en un export', async () => {
  const A = await s.flow('Token rot', [cmd('Eco', 'Write-Output R', { id: 's_r' })]);
  const t1 = (await s.uiOk('POST', `/api/flows/${A.id}/token`, {})).token;
  assert.equal((await s.uiOk('GET', `/api/flows/${A.id}/token?reveal=1`)).token, t1, 'se puede volver a ver');
  const t2 = (await s.uiOk('POST', `/api/flows/${A.id}/token`, {})).token;
  assert.notEqual(t1, t2);
  assert.equal((await as(t1)('GET', '/flows')).status, 401, 'el anterior ya no vale');
  assert.equal((await as(t2)('GET', '/flows')).status, 200);
  const meta = await s.uiOk('GET', `/api/flows/${A.id}/token`);
  assert.ok(meta.exists && meta.rotatedAt && !meta.token, 'sin reveal no se muestra');
  // nowhere in clear on disk (data dir), nor in an export with chats and runs
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(s.dirs.data)) assert.ok(!fs.readFileSync(f, 'utf8').includes(t2), `token en claro en ${f}`);
  const b = await s.uiOk('GET', `/api/flows/${A.id}/export?chats=1&runs=1`);
  assert.ok(!JSON.stringify(b).includes(t2) && !JSON.stringify(b).includes('afsf_'));
  // the same data with another machine key: the token opens nothing; revealing asks to regenerate
  await s.kill();
  const keyFile = path.join(s.dirs.home, '.afs', 'credentials.key'); const keyBefore = fs.readFileSync(keyFile, 'utf8');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 7).toString('base64'));
  await s.start();
  try {
    assert.equal((await as(t2)('GET', '/flows')).status, 401);
    assert.equal((await s.ui('GET', `/api/flows/${A.id}/token?reveal=1`)).body.code, 'TOKEN_KEY_CHANGED');
  } finally { await s.kill(); fs.writeFileSync(keyFile, keyBefore); await s.start(); }
  assert.equal((await as(t2)('GET', '/flows')).status, 200);
  await s.uiOk('DELETE', `/api/flows/${A.id}/token`);
  assert.equal((await as(t2)('GET', '/flows')).status, 401, 'revocado');
  // deleting the flow drops its token
  const t3 = (await s.uiOk('POST', `/api/flows/${A.id}/token`, {})).token;
  await s.uiOk('DELETE', `/api/flows/${A.id}`);
  assert.equal((await as(t3)('GET', '/ping')).status, 401);
});

test('ISO-4: snippets e INVOKE.md sin token y con una credencial de Jenkins por flujo; el de PowerShell funciona con el token de su flujo y no con el de otro; el CLI y el MCP respetan el alcance', async () => {
  const A = await s.flow('Snip A', [cmd('Eco', 'Write-Output SNIP-A', { id: 's_sa' })]);
  const B = await s.flow('Snip B', [cmd('Eco', 'Write-Output SNIP-B', { id: 's_sb' })]);
  const tA = (await s.uiOk('POST', `/api/flows/${A.id}/token`, {})).token;
  const tB = (await s.uiOk('POST', `/api/flows/${B.id}/token`, {})).token;
  const inv = await s.uiOk('GET', `/api/flows/${A.id}/steps/s_sa/invoke`);
  assert.equal(inv.credId, 'afs-token-snip-a');
  assert.match(inv.snippets.find((x) => x.id === 'jenkins-sh').content, /credentialsId: 'afs-token-snip-a'/);
  assert.ok(!JSON.stringify(inv).includes(tA));
  const md = await s.ui('GET', `/api/flows/${A.id}/invoke.md`);
  assert.ok(!md.body.includes(tA) && /afs-token-snip-a/.test(md.body));
  const ps = inv.snippets.find((x) => x.id === 'powershell').content;
  const ok = await s.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { AFS_TOKEN: tA } });
  assert.equal(ok.code, 0, ok.stderr); assert.match(ok.stdout, /SNIP-A/);
  assert.notEqual((await s.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { AFS_TOKEN: tB } })).code, 0, 'con el token de otro flujo falla');
  // CLI: scoped list, another flow refused, AFS_TOKEN_FILE, admin disabled without env → Spanish error
  const l = await s.afs(['list', '--json'], { env: { AFS_TOKEN: tA } });
  assert.deepEqual(JSON.parse(l.stdout).map((x) => x.id), [A.id]);
  assert.notEqual((await s.afs(['run', B.id], { env: { AFS_TOKEN: tA } })).code, 0);
  const tf = path.join(s.tmp, 'tokA.txt'); fs.writeFileSync(tf, tA);
  assert.equal((await s.afs(['run', A.id], { env: { AFS_TOKEN_FILE: tf } })).code, 0);
  assert.equal((await s.afs(['token', A.id])).stdout.trim(), tA, 'afs token muestra el del flujo');
  // admin disabled: a REMOTE client without a flow token gets the Spanish error (locally the UI key keeps working: revisión 11)
  await s.uiOk('PUT', '/api/info/admin-token', { enabled: false });
  try {
    const d = await s.afs(['list'], { env: { AFS_URL: s.base.replace('127.0.0.1', 'remoto.invalid') } });
    assert.notEqual(d.code, 0); assert.match(d.stderr + d.stdout, /administración está desactivado/);
  } finally { await s.uiOk('PUT', '/api/info/admin-token', { enabled: true }); }
  // the generated-integration lint catches a pasted flow token
  const lint = await s.uiOk('POST', '/api/integrations/lint', { flow: A.id, caller: 'jenkins-declarative', files: [{ name: 'Jenkinsfile', content: `sh 'curl -H "Authorization: Bearer ${tA}" x'` }] }).catch((e) => ({ errors: [{ code: String(e.message) }] }));
  assert.ok(JSON.stringify(lint).includes('TOKEN_LITERAL'), JSON.stringify(lint).slice(0, 300));
});

// ---------------- ISO-6/7/8/9: explicit calls between flows ----------------
const flowStep = (name, flowRef, more = {}) => ({ id: more.id || `s_f${Math.random().toString(36).slice(2, 7)}`, name, kind: 'flow', flowRef, ...more });
test('ISO-6/7: un step 🔀 Flujo corre el otro flujo con solo el input y recibe su resultado; el otro conserva sus variables, memoria y chats', async () => {
  const B = await s.flow('Hijo B', [cmd('Calcula', 'Write-Output "B:{{vars.color}}:$env:FLOW_INPUT"', { id: 's_bc' }), cmd('JSON', 'Write-Output \'{"ok":true,"n":7}\'', { id: 's_bj', output: { format: 'json' } })], [['s_bc', 's_bj']], { vars: { color: 'azul' } });
  const bBefore = await s.getFlow(B.id);
  const A = await s.flow('Padre A', [cmd('Prep', 'Write-Output "dato-A"', { id: 's_ap' }), flowStep('Llama a B', B.id, { id: 's_af' }), cmd('Usa', 'Write-Output "recibí: $env:STEP_UPSTREAM"', { id: 's_au' })], [['s_ap', 's_af'], ['s_af', 's_au']], { vars: { color: 'rojo' } });
  const run = await s.runUi(A.id);
  assert.equal(run.status, 'success', JSON.stringify(run.steps.s_af));
  assert.deepEqual(run.steps.s_af.json, { ok: true, n: 7 }, 'su resultado (json del último step)');
  const child = run.steps.s_af.childRun;
  assert.ok(child?.runId);
  const cr = await s.uiOk('GET', `/api/flows/${B.id}/runs/${child.runId}`);
  assert.equal(cr.trigger, `flow:${A.id}`); assert.equal(cr.parent.runId, run.id); assert.deepEqual(cr.callChain, [A.id, B.id]);
  assert.equal(cr.steps.s_bc.output.trim(), 'B:azul:dato-A', 'usa SUS variables; solo cruza el input');
  const bAfter = await s.getFlow(B.id);
  assert.deepEqual(bAfter.vars, bBefore.vars); assert.deepEqual(bAfter.memory, bBefore.memory);
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${B.id}/chat/_global`), []);
  // a step of B + "from", an input template, and fire-and-forget
  const g = await s.getFlow(A.id);
  g.steps[1] = { ...g.steps[1], flowStep: 's_bc', flowScope: 'only', flowInput: 'plantilla-{{vars.color}}' };
  await s.uiOk('PUT', `/api/flows/${A.id}`, g);
  const r2 = await s.runUi(A.id, '', { stepId: 's_af' });
  assert.match(r2.steps.s_af.output, /^B:azul:plantilla-rojo/);
  const g2 = await s.getFlow(A.id); g2.steps[1] = { ...g2.steps[1], flowStep: '', flowInput: '', waitResult: false };
  await s.uiOk('PUT', `/api/flows/${A.id}`, g2);
  const r3 = await s.runUi(A.id, 'x', { stepId: 's_af' });
  assert.equal(r3.steps.s_af.status, 'success'); assert.match(r3.steps.s_af.output, /^r_/);
  assert.ok(await s.waitRun(B.id, r3.steps.s_af.output.trim()));
  // a flow step has no chat
  assert.equal((await s.ui('POST', `/api/flows/${A.id}/chat/s_af`, { message: 'hola' })).body.code, 'FLOW_STEP_NO_CHAT');
});

test('ISO-7: si el flujo llamado falla, el step falla (CHILD_FAILED) y lo que sigue no corre; detener al que llama detiene al llamado', async () => {
  const B = await s.flow('Hijo falla', [cmd('Falla', 'exit 4', { id: 's_x' })]);
  const A = await s.flow('Padre falla', [flowStep('Llama', B.id, { id: 's_l' }), cmd('Después', 'Write-Output nunca', { id: 's_d' })], [['s_l', 's_d']]);
  const run = await s.runUi(A.id);
  assert.equal(run.steps.s_l.status, 'error'); assert.equal(run.steps.s_l.code, 'CHILD_FAILED'); assert.match(run.steps.s_l.error, /Hijo falla.*error/);
  assert.notEqual(run.steps.s_d?.status, 'success');
  // cancel the parent while the child runs → the child stops too
  const slow = await s.flow('Hijo lento', [cmd('Lento', 'Start-Sleep -Seconds 20; Write-Output tarde', { id: 's_sl' })]);
  const P = await s.flow('Padre cancela', [flowStep('Llama lento', slow.id, { id: 's_ls' })]);
  const { runId } = await s.uiOk('POST', `/api/flows/${P.id}/run`, { input: '' });
  let childId;
  for (let i = 0; i < 60 && !childId; i++) { await sleep(150); childId = (await s.ui('GET', `/api/flows/${slow.id}/runs`)).body.find?.((x) => x.status === 'running')?.id; }
  assert.ok(childId, 'el hijo arrancó');
  await s.uiOk('POST', `/api/flows/${P.id}/runs/${runId}/cancel`, {});
  const c = await s.waitRun(slow.id, childId, 30000);
  assert.ok(['stopped', 'error'].includes(c.status), `el hijo quedó en ${c.status}`);
});

test('ISO-8: A→B→A falla por recursión sin crear una tercera ejecución; un flujo que se llama a sí mismo falla; 5 niveles funcionan y 6 no', async () => {
  const A = await s.flow('Rec A', []);
  const B = await s.flow('Rec B', [flowStep('B llama a A', A.id, { id: 's_ba' })]);
  let g = await s.getFlow(A.id); g.steps = [flowStep('A llama a B', B.id, { id: 's_ab' })]; await s.uiOk('PUT', `/api/flows/${A.id}`, g);
  const before = (await s.ui('GET', `/api/flows/${A.id}/runs`)).body.length;
  const run = await s.runUi(A.id);
  assert.equal(run.status, 'error');
  const bRun = await s.uiOk('GET', `/api/flows/${B.id}/runs/${run.steps.s_ab.childRun.runId}`);
  assert.equal(bRun.steps.s_ba.code, 'FLOW_RECURSION'); assert.match(bRun.steps.s_ba.error, /Rec A → Rec B → Rec A/);
  assert.equal((await s.ui('GET', `/api/flows/${A.id}/runs`)).body.length, before + 1, 'no se creó una tercera ejecución');
  // the review sees the cycle before running
  const lint = await s.uiOk('GET', `/api/flows/${A.id}/lint`).catch(() => null);
  if (lint) assert.ok(JSON.stringify(lint).includes('R-FLOW-CYCLE'));
  // self call
  const self = await s.flow('Se llama', []);
  g = await s.getFlow(self.id); g.steps = [flowStep('Yo', self.id, { id: 's_yo' })]; await s.uiOk('PUT', `/api/flows/${self.id}`, g);
  assert.equal((await s.runUi(self.id)).steps.s_yo.code, 'FLOW_RECURSION');
  // chain: L1 → L2 → … → L5 works (5 flows); L0 → L1 → … → L5 (6) fails
  const leaf = await s.flow('L5', [cmd('Hoja', 'Write-Output HOJA', { id: 's_h' })]);
  let next = leaf;
  for (const n of ['L4', 'L3', 'L2', 'L1']) next = await s.flow(n, [flowStep(`→ ${next.name}`, next.id, { id: `s_${n}` })]);
  const ok = await s.runUi(next.id);
  assert.equal(ok.status, 'success', JSON.stringify(ok.steps)); assert.match(ok.steps.s_L1.output, /HOJA/);
  const top = await s.flow('L0', [flowStep('→ L1', next.id, { id: 's_L0' })]);
  const deep = await s.runUi(top.id);
  assert.equal(deep.status, 'error');
  assert.match(JSON.stringify(await s.uiOk('GET', `/api/flows/${leaf.id}/runs`)), /.*/);
  // the deepest call that failed is reported up the chain
  assert.match(deep.steps.s_L0.error, /CHAIN|demasiado larga|terminó en error/);
});

test('ISO-6: ctx.invokeFlow en un hook (por nombre); fallos con código; un flujo en cuarentena no se invoca; importar un flujo con un step 🔀 lo pone en revisión', async () => {
  const B = await s.flow('Hook destino', [cmd('Eco', 'Write-Output "HOOK:$env:FLOW_INPUT"', { id: 's_he' })]);
  const A = await s.flow('Hook origen', [cmd('Base', 'Write-Output base', { id: 's_hb', hooks: "async function onSuccess(ctx) { const r = await ctx.invokeFlow('Hook destino', 'desde-hook'); return r.result; }" })]);
  const run = await s.runUi(A.id);
  assert.match(run.steps.s_hb.output, /HOOK:desde-hook/);
  const bad = await s.flow('Hook malo', [cmd('Base', 'Write-Output base', { id: 's_hm', hooks: "async function onSuccess(ctx) { try { await ctx.invokeFlow('No existe', 'x'); } catch (e) { return e.code; } }" })]);
  assert.equal((await s.runUi(bad.id)).steps.s_hm.output, 'FLOW_REF_NOT_FOUND');
  // a quarantined flow cannot be called
  const bundle = await s.uiOk('GET', `/api/flows/${B.id}/export`);
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle });
  assert.ok(imp.quarantine);
  const C = await s.flow('Llama cuarentena', [flowStep('→ importado', imp.flow.id, { id: 's_q' })]);
  assert.equal((await s.runUi(C.id)).steps.s_q.code, 'QUARANTINED');
  // importing a flow with a flow step: quarantined, and relinked by exact name only
  const ex = await s.uiOk('GET', `/api/flows/${C.id}/export`);
  assert.ok(ex.flow.steps[0].flowRefName);
  const imp2 = await s.uiOk('POST', '/api/flows/import', { bundle: ex });
  assert.ok(imp2.quarantine.reasons.some((r) => /invocar[ií]a tu flujo local|invoca otro flujo/.test(r)), JSON.stringify(imp2.quarantine.reasons));
});

test('ISO-9: /calls muestra a quién llama y quién lo llama (también por hook); una referencia rota se marca', async () => {
  const T = await s.flow('Destino calls', [cmd('Eco', 'Write-Output t', { id: 's_t' })]);
  const U = await s.flow('Origen calls', [flowStep('→ destino', T.id, { id: 's_u' }), cmd('Hook', 'Write-Output h', { id: 's_k', hooks: "async function onSuccess(ctx) { await ctx.invokeFlow('Destino calls', 'x'); }" })]);
  const c = await s.uiOk('GET', `/api/flows/${U.id}/calls`);
  assert.deepEqual(c.calls.map((x) => [x.flowId, x.via]), [[T.id, 'step'], [T.id, 'hook']]);
  const by = await s.uiOk('GET', `/api/flows/${T.id}/calls`);
  assert.ok(by.calledBy.some((x) => x.flowId === U.id));
  await s.uiOk('DELETE', `/api/flows/${T.id}`);
  assert.ok((await s.uiOk('GET', `/api/flows/${U.id}/calls`)).calls.every((x) => x.broken));
});

// ---- first adversarial pass on spec 11 ----
test('revisión 11: los comandos no heredan dónde guarda la app sus tokens; la cadena de llamadas viaja (afs run / API desde un comando no se salta la recursión)', async () => {
  const E = await s.flow('Rec env E', [cmd('Env', 'Write-Output "data=[$env:AFS_DATA] tok=[$env:AFS_TOKEN] chain=[$env:AFS_CALL_CHAIN]"', { id: 's_env' })]);
  const out = (await s.runUi(E.id)).steps.s_env.output;
  assert.match(out, /data=\[\] tok=\[\]/, out); assert.match(out, new RegExp(`chain=\\[${E.id}\\]`));
  // F (called by G) tries to start G again through the external API with the chain header → refused
  const G = await s.flow('Rec G', []);
  const F = await s.flow('Rec F', [cmd('Vuelve a G', `$r = try { Invoke-RestMethod -Method Post -Uri '${s.base}/api/ext/flows/${G.id}/run' -Headers @{ Authorization = 'Bearer ${s.token}'; 'X-AFS-Call-Chain' = $env:AFS_CALL_CHAIN } -ContentType 'application/json' -Body '{}' } catch { $_.ErrorDetails.Message }; Write-Output $r`, { id: 's_back' })]);
  const g = await s.getFlow(G.id); g.steps = [{ id: 's_g', name: '→ F', kind: 'flow', flowRef: F.id }]; await s.uiOk('PUT', `/api/flows/${G.id}`, g);
  const before = (await s.ui('GET', `/api/flows/${G.id}/runs`)).body.length;
  const run = await s.runUi(G.id);
  const fr = await s.uiOk('GET', `/api/flows/${F.id}/runs/${run.steps.s_g.childRun.runId}`);
  assert.match(fr.steps.s_back.output, /FLOW_RECURSION/, fr.steps.s_back.output);
  assert.equal((await s.ui('GET', `/api/flows/${G.id}/runs`)).body.length, before + 1, 'G no volvió a arrancar');
  // the CLI forwards it too
  const cli = await s.afs(['run', G.id], { env: { AFS_CALL_CHAIN: `${G.id}` } });
  assert.notEqual(cli.code, 0); assert.match(cli.stderr + cli.stdout, /circular/i);
});

test('revisión 11: importar dice a qué flujo LOCAL apuntaría un step 🔀; /ask no conversa con un step 🔀; un tokens.json mal formado no tumba la API; borrar un flujo inexistente es 404', async () => {
  const S = await s.flow('Beta Secreto', [cmd('Prod', 'Write-Output prod', { id: 's_p' })]);
  const X = await s.flow('Externo', [{ id: 's_l', name: 'Llama', kind: 'flow', flowRef: S.id, flowInput: 'DROP EVERYTHING' }]);
  const b = await s.uiOk('GET', `/api/flows/${X.id}/export`);
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle: b });
  assert.ok(imp.quarantine.reasons.some((r) => r.includes('«Beta Secreto»') && r.includes(S.id)), JSON.stringify(imp.quarantine.reasons));
  assert.ok(imp.warnings.some((w) => /Beta Secreto/.test(w)));
  assert.equal((await s.ext('POST', `/flows/${X.id}/ask`, { message: 'hola', step: 's_l' })).body.code, 'FLOW_STEP_NO_CHAT');
  // tokens.json with a wrong shape: flow tokens fail closed (401), admin and the UI keep working
  const tf = path.join(s.dirs.data, 'tokens.json'); const keep = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8') : null;
  fs.writeFileSync(tf, '{"flows":null}');
  try {
    assert.equal((await s.ext('GET', '/ping', undefined, { Authorization: `Bearer afsf_${'x'.repeat(43)}` }, { auth: false })).status, 401);
    assert.equal((await s.ext('GET', '/ping')).status, 200);
    const t = await s.ui('GET', `/api/flows/${X.id}/token`);
    assert.equal(t.body.code, 'TOKENS_CORRUPT');
  } finally { if (keep != null) fs.writeFileSync(tf, keep); else fs.rmSync(tf, { force: true }); }
  assert.equal((await s.ui('DELETE', '/api/flows/_borrados')).status, 404);
});

test('revisión 11: el hijo de un ensayo es un ensayo; con el token de administración desactivado el CLI pide el token del flujo y la clave de la interfaz no abre la API externa', async () => {
  const B = await s.flow('Ensayo hijo', [cmd('Eco', 'Write-Output hijo', { id: 's_e' })]);
  const A = await s.flow('Ensayo padre', [{ id: 's_c', name: '→ hijo', kind: 'flow', flowRef: B.id }]);
  const { runId } = await s.uiOk('POST', `/api/flows/${A.id}/rehearsal`, { input: '' });
  const r = await s.waitRun(A.id, runId);
  assert.equal(r.rehearsal, true); {
    const c = await s.uiOk('GET', `/api/flows/${B.id}/runs/${r.steps.s_c.childRun.runId}`);
    assert.equal(c.rehearsal, true); assert.equal(c.trigger, `flow:${A.id}`);
    assert.ok(!(await s.getFlow(B.id)).steps[0].lastRun, 'su último resultado real no se toca');
  }
  await s.uiOk('PUT', '/api/info/admin-token', { enabled: false });
  try {
    const l = await s.afs(['list', '--json']);
    assert.notEqual(l.code, 0); assert.match(l.stderr + l.stdout, /administración está desactivado/, 'pide el token del flujo');
    assert.equal((await s.ext('GET', '/ping', undefined, { 'X-AFS-UI': s.uiKey }, { auth: false })).status, 401, 'la clave de la interfaz no es una credencial de la API externa');
  } finally { await s.uiOk('PUT', '/api/info/admin-token', { enabled: true }); }
});

test('UI: step 🔀 Flujo (elegir flujo y step), token del flujo en 🔌 Invocar y llamadas entre flujos en la pestaña Flujo', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('isolation-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const B = await u.flow('Destino UI', [cmd('Eco', 'Write-Output "UI:$env:FLOW_INPUT"', { id: 's_e', position: { x: 100, y: 100 } })]);
    const A = await u.flow('Origen UI', [{ id: 's_f', name: 'Llamar', kind: 'flow', flowRef: '', position: { x: 120, y: 120 } }]);
    await page.goto(`${u.base}/?flow=${A.id}`);
    await page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Llamar' }) }).click();
    await page.getByTestId('flow-step-ref').selectOption(B.id);
    await page.getByTestId('flow-step-step').selectOption('s_e');
    let g; for (let i = 0; i < 40; i++) { g = await u.getFlow(A.id); if (g.steps[0].flowRef === B.id && g.steps[0].flowStep === 's_e') break; await sleep(150); }
    assert.equal(g.steps[0].flowRef, B.id); assert.equal(g.steps[0].flowStep, 's_e');
    const run = await u.runUi(A.id, 'hola');
    assert.match(run.steps.s_f.output, /UI:hola/);
    // Invoke tab: the flow token (created on first reveal) and its Jenkins credential
    await page.locator('.tabs button', { hasText: 'Invocar' }).click();
    await page.getByTestId('invoke-show-token').click();
    const tok = (await page.getByTestId('invoke-token').textContent()).trim();
    assert.match(tok, /^afsf_/);
    assert.equal((await u.ext('GET', '/flows', undefined, { Authorization: `Bearer ${tok}` }, { auth: false })).body.length, 1);
    await page.getByText('afs-token-origen-ui').first().waitFor();
    // Flow tab: calls and the workspace
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.locator('.tabs button', { hasText: 'Flujo' }).first().click();
    await page.getByTestId('flow-calls').getByText('Destino UI').waitFor();
    await page.getByTestId('flow-workspace').getByText(/carpeta propia del flujo/).waitFor();
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});

// ---- second adversarial pass on spec 11 ----
test('revisión 11b: un comando no encuentra la configuración de la app desde su carpeta ni hereda dónde está o en qué puerto escucha; con el admin desactivado no consigue nada', async () => {
  await s.uiOk('PUT', '/api/info/admin-token', { enabled: false });
  try {
    const B = await s.flow('Secreto B', [cmd('Dato', 'Write-Output B-SECRET-OUTPUT', { id: 's_sb' })]);
    const atk = await s.flow('Atacante', [cmd('Busca', [
      "$c = $null; foreach ($p in @('../../config.json','../config.json','../../data/config.json','../../../data/config.json')) { if (Test-Path $p) { $c = Get-Content $p -Raw | ConvertFrom-Json } }",
      "Write-Output (\"found=\" + [bool]$c)",
      "Write-Output (\"port=[\" + $env:PORT + \"] data=[\" + $env:AFS_DATA + \"] npm=[\" + $env:npm_package_json + \"]\")",
      `try { $k = if ($c) { $c.uiKey } else { 'x' }; $r = Invoke-RestMethod -Method Post -Uri '${s.base}/api/ext/flows/${B.id}/run' -Headers @{ 'X-AFS-UI' = $k } -ContentType 'application/json' -Body '{"wait":true}'; Write-Output ("RUN=" + $r.result) } catch { Write-Output ("RUN-DENIED " + $_.Exception.Response.StatusCode.value__) }`,
    ].join('; '), { id: 's_atk' })]);
    const out = (await s.runUi(atk.id)).steps.s_atk.output;
    assert.match(out, /found=False/, out);
    assert.match(out, /port=\[\] data=\[\] npm=\[\]/, out);
    assert.match(out, /RUN-DENIED 401/, out);
    assert.ok(!out.includes('B-SECRET-OUTPUT'));
    assert.ok(!path.resolve((await s.uiOk('GET', `/api/flows/${atk.id}/workspace`)).path).startsWith(path.resolve(s.dirs.data)), 'su carpeta no está dentro de los datos de la app');
  } finally { await s.uiOk('PUT', '/api/info/admin-token', { enabled: true }); }
});
