// Spec 28: 🩺 Revisión del flujo — lint (rules + machine + runs), policies (enforced when possible), rehearsal,
// AI review (2 independent calls, merged by code, evidence checked) and the '_review' chat. It only PROPOSES.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'review', env: { AFS_PROBE_HEADLESS: 'off', AFS_REHEARSAL_STEP_SEC: '20' } }); await s.start(); });
after(async () => { await s?.stop(); });
const lint = (id) => s.uiOk('GET', `/api/flows/${id}/lint`);
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };
const RA = 'mcp__claude_ai_Atlassian_Rovo';

test('seguridad de propuestas: bypassPermissions y Bash sin patrón nunca; ampliar acceso pide confirmación aparte', async () => {
  const a = role('Analiza', '[[mock:say ok]]', { id: 's_sec', allowedTools: 'Read' });
  const f = await s.flow('Seguridad', [a]);
  const chat = async (msg) => {
    await s.uiOk('POST', `/api/flows/${f.id}/chat/s_sec`, { message: msg });
    return until(async () => { const l = await s.uiOk('GET', `/api/flows/${f.id}/chat/s_sec`); const m = l[l.length - 1]; return m.role === 'assistant' && m.status !== 'running' ? m : null; });
  };
  const m1 = await chat('[[mock:propose {"permissionMode":"bypassPermissions"}]]');
  assert.match(m1.proposals[0].error, /bypassPermissions/);
  const r1 = await s.ui('POST', `/api/flows/${f.id}/chat/s_sec/apply`, { messageId: m1.id, proposalId: m1.proposals[0].id, confirmWiden: true });
  assert.equal(r1.status, 400);
  const m2 = await chat('[[mock:propose {"allowedTools":"Read Bash"}]]');
  assert.match(m2.proposals[0].error, /Bash sin restricción/);
  const m3 = await chat('[[mock:propose {"allowedTools":"Read Bash(git push:*)"}]]');
  assert.deepEqual(m3.proposals[0].widens, ['herramientas nuevas que pueden cambiar cosas: Bash(git push:*)']);
  const r3 = await s.ui('POST', `/api/flows/${f.id}/chat/s_sec/apply`, { messageId: m3.id, proposalId: m3.proposals[0].id });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.code, 'WIDEN_CONFIRM');
  assert.deepEqual(r3.body.widens, ['herramientas nuevas que pueden cambiar cosas: Bash(git push:*)']);
  assert.equal((await s.getFlow(f.id)).steps[0].allowedTools, 'Read', 'nada cambió sin la confirmación');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_sec/apply`, { messageId: m3.id, proposalId: m3.proposals[0].id, confirmWiden: true });
  assert.equal((await s.getFlow(f.id)).steps[0].allowedTools, 'Read Bash(git push:*)');
  // a read-only change needs no extra confirmation
  const m4 = await chat('[[mock:propose {"task":"nueva tarea"}]]');
  assert.equal(m4.proposals[0].widens, undefined);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_sec/apply`, { messageId: m4.id, proposalId: m4.proposals[0].id });
});

test('seguridad (revisión adversarial): shells sin restricción, reglas que se apagan o reemplazan, confirmación atada a la lista vista', async () => {
  const a = role('B', '[[mock:say ok]]', { id: 's_b2', allowedTools: 'Read' });
  const f = await s.flow('Seguridad 2', [a], [], { policies: [{ type: 'noExternalWrites' }] });
  const chat = async (key, msg) => {
    await s.uiOk('POST', `/api/flows/${f.id}/chat/${key}`, { message: msg });
    return until(async () => { const l = await s.uiOk('GET', `/api/flows/${f.id}/chat/${key}`); const m = l[l.length - 1]; return m.role === 'assistant' && m.status !== 'running' ? m : null; });
  };
  for (const tools of ['Read PowerShell', 'Read Bash( * )', 'Read Bash(*:*)', 'Read Bash(powershell:*)', 'Read Bash(cmd:*)']) {
    const m = await chat('s_b2', `[[mock:propose {"allowedTools":"${tools}"}]]`);
    assert.match(m.proposals[0].error || '', /sin restricción/, tools);
  }
  // a proposal cannot switch a rule off, and replacing a rule is confirmed apart
  const m = await chat('_review', '[[mock:propose-policy {"scope":"flow","type":"noExternalWrites","text":"x","enabled":false}]]');
  const p = m.proposals[0];
  assert.equal(p.policy.enabled, true);
  assert.ok(p.widens.some((w) => /reemplaza la regla vigente/.test(w)));
  const r = await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m.id, proposalId: p.id, confirmWiden: ['otra cosa'] });
  assert.equal(r.body.code, 'WIDEN_CONFIRM', 'la confirmación de otra lista no vale');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m.id, proposalId: p.id, confirmWiden: p.widens });
  const g = await s.getFlow(f.id);
  assert.equal(g.policies.length, 1);
  assert.equal(g.policies[0].enabled, true);
});

test('lint determinista: skill inexistente, MCP no cargado, escrituras externas, secreto, suite larga — sin llamar a Claude', async () => {
  // the CLI "loads" only playwright (learned from a real run's init)
  const probe = await s.flow('Probe', [role('P', '[[mock:mcp playwright=connected]] [[mock:say ok]]', { id: 's_probe' })]);
  await s.runUi(probe.id);
  const steps = [
    role('Lee Jira', '[[mock:say x]]', { id: 's_mcp', allowedTools: `Read ${RA}__getJiraIssue` }),
    { id: 's_ref', name: 'Skill rota', kind: 'skill', skillRef: 'no-existe-xyz', task: 't' },
    role('Publica', 't', { id: 's_pub', allowedTools: `Read ${RA}__createJiraIssue` }),
    cmd('Push', 'git push origin main', { id: 's_push' }),
    role('Secreto', 'Usa el token: ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz123', { id: 's_sec2' }),
    role('Automatiza', 'Corre la suite de regresión con testcafe y reporta', { id: 's_long', allowedTools: 'Read Bash(npx gherkin-testcafe:*)' }),
  ];
  const f = await s.flow('Lint', steps, [], { cwd: s.dirs.work });
  const n0 = s.calls().length;
  const l = await lint(f.id);
  assert.equal(s.calls().length, n0, 'el lint no llama a Claude');
  const by = (rule, stepId) => l.findings.find((x) => x.rule === rule && (!stepId || x.stepId === stepId));
  assert.equal(by('R-MCP', 's_mcp').severity, 'block');
  assert.ok(by('R-MCP', 's_mcp').evidence.some((e) => e.type === 'system' && /playwright=connected/.test(e.quote)));
  assert.equal(by('R-REF', 's_ref').severity, 'block');
  const pub = by('R-WRITE-EXT', 's_pub');
  assert.equal(pub.fix.kind, 'policy');
  assert.equal(pub.fix.policy.type, 'noExternalWrites');
  assert.ok(by('R-WRITE-EXT', 's_push'), 'un comando con git push también');
  const sec = by('R-SECRET', 's_sec2');
  assert.equal(sec.severity, 'block');
  assert.ok(!JSON.stringify(sec).includes('abcdefghijklmnopqrstuvwxyz'), 'el secreto nunca se repite entero');
  const long = by('R-LONG-BASH', 's_long');
  assert.equal(long.fix.patch.steps.s_long.bashTimeoutMin, 60);
  assert.ok(l.findings.every((x) => x.fp && x.anchor && x.evidence.length), 'cada hallazgo con evidencia y huella');
  assert.ok(l.findings.findIndex((x) => x.severity === 'risk') > l.findings.findIndex((x) => x.severity === 'block'), 'los bloqueantes primero');
});

test('arreglo del lint, descartar con motivo y reaparecer si el step cambia', async () => {
  const f = await s.flow('Fix', [role('Automatiza', 'Ejecuta la suite de regresión', { id: 's_l', allowedTools: 'Read Bash(npm test:*)' }), role('Publica', 't', { id: 's_p', allowedTools: `Read ${RA}__createJiraIssue` })], [], { cwd: s.dirs.work });
  let l = await lint(f.id);
  const long = l.findings.find((x) => x.rule === 'R-LONG-BASH');
  await s.uiOk('POST', `/api/flows/${f.id}/lint/apply`, { fp: long.fp });
  const st = (await s.getFlow(f.id)).steps.find((x) => x.id === 's_l');
  assert.equal(st.bashTimeoutMin, 60);
  assert.equal(st.timeoutSec, 7200);
  assert.match(st.context, /run_in_background/);
  l = await lint(f.id);
  assert.ok(!l.findings.some((x) => x.rule === 'R-LONG-BASH'), 'resuelto');
  const w = l.findings.find((x) => x.rule === 'R-WRITE-EXT');
  await s.uiOk('POST', `/api/flows/${f.id}/review/suppress`, { fp: w.fp, reason: 'es intencional', anchor: w.anchor });
  l = await lint(f.id);
  assert.ok(!l.findings.some((x) => x.fp === w.fp));
  assert.deepEqual(l.hidden.map((h) => h.reason), ['es intencional']);
  // the step changes → the dismissed finding is news again
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: g.steps.map((x) => (x.id === 's_p' ? { ...x, task: 'otra tarea' } : x)) });
  assert.ok((await lint(f.id)).findings.some((x) => x.fp === w.fp));
  // a stale fingerprint is refused
  const r = await s.ui('POST', `/api/flows/${f.id}/lint/apply`, { fp: 'no-existe' });
  assert.equal(r.status, 409);
});

test('políticas: se validan, se aplican al ejecutar (bloqueos, autor, sin trailer, ambiente por defecto) y "nunca dos a la vez"', async () => {
  assert.equal((await s.ui('PUT', '/api/policies', { policies: [{ type: 'gitAuthor', params: { name: 'X' } }] })).status, 400);
  await s.uiOk('PUT', '/api/policies', { policies: [
    { type: 'gitAuthor', text: 'Autor corporativo', params: { name: 'Gustavo Salvato', email: 'g.salvato@example.com' } },
    { type: 'noCoAuthorTrailer' },
    { type: 'note', text: 'TestCafe deja Chrome vivo: ciérralo antes de relanzar' },
  ] });
  const a = role('Hace', '[[mock:env-echo]]', { id: 's_env', allowedTools: `Read ${RA}__createJiraIssue Bash(git status:*)`, bashTimeoutMin: 45 });
  const f = await s.flow('Políticas', [a], [], { vars: { env: '' }, policies: [{ type: 'noExternalWrites' }, { type: 'defaultEnv', params: { var: 'env', value: 'qa' } }] });
  const n0 = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'success');
  assert.equal(run.vars.env, 'qa', 'la variable vacía toma el valor por defecto');
  const out = run.steps.s_env.output;
  assert.match(out, /git=g\.salvato@example\.com/);
  assert.match(out, /bash=2700000/);
  assert.match(out, /"includeCoAuthoredBy":false/);
  assert.match(out, /disallowed=.*createJiraIssue/);
  assert.match(out, /Bash\(git push:\*\)/);
  const call = s.callsSince(n0).find((c) => /env-echo/.test(c.prompt));
  assert.match(call.append, /Reglas del equipo/);
  assert.match(call.append, /TestCafe deja Chrome vivo/);
  // noParallelRuns
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: '[[mock:sleep 2]] [[mock:say ok]]' }], policies: [...g.policies, { type: 'noParallelRuns' }] });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  const second = await s.ui('POST', `/api/flows/${f.id}/run`, { input: '' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'FLOW_BUSY');
  await s.waitRun(f.id, runId);
  await s.uiOk('PUT', '/api/policies', { policies: [] });
});

test('revisión de corridas: denegaciones por la forma del comando, falso éxito con Bash en segundo plano y comando cortado', async () => {
  const d = role('Deniega', '[[mock:deny-cmd cd repo && git status]] [[mock:deny-cmd ls reports]] [[mock:say hecho]]', { id: 's_den', allowedTools: 'Read Bash(git status:*)' });
  const b = role('Fondo', '[[mock:bash-bg npm test]] [[mock:say Espero a que termine la suite.]]', { id: 's_bg', allowedTools: 'Read Bash(npm test:*)' });
  const t = role('Corte', '[[mock:bash-timeout npm run e2e]] [[mock:say listo con todo el resultado y mucho texto para que no sea corto ni sospechoso de nada en particular, ok]]', { id: 's_to', allowedTools: 'Read Bash(npm run e2e:*)' });
  const f = await s.flow('Corridas', [d, b, t], [], { cwd: s.dirs.work });
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_den.code, 'PERMISSION_DENIED');
  const l = await lint(f.id);
  const den = l.findings.find((x) => x.rule === 'R-DENY');
  assert.equal(den.severity, 'block');
  assert.ok(den.evidence.some((e) => e.runId === run.id && /cd repo && git status/.test(e.quote)));
  assert.match(den.fix.patch.steps.s_den.context, /sin "cd/);
  assert.match(den.fix.patch.steps.s_den.allowedTools, /Bash\(ls:\*\)/);
  assert.ok(den.widens?.some((w) => /Bash\(ls:\*\)/.test(w)), 'permitir ls amplía el acceso: se confirma aparte');
  const fs = l.findings.find((x) => x.rule === 'R-FALSE-SUCCESS');
  assert.equal(fs.stepId, 's_bg');
  assert.ok(fs.evidence.some((e) => /segundo plano: npm test/.test(e.quote)));
  assert.ok(l.findings.some((x) => x.rule === 'R-BASH-TIMEOUT' && x.stepId === 's_to'));
  const r = await s.ui('POST', `/api/flows/${f.id}/lint/apply`, { fp: den.fp });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'WIDEN_CONFIRM');
  await s.uiOk('POST', `/api/flows/${f.id}/lint/apply`, { fp: den.fp, confirmWiden: true });
  assert.match((await s.getFlow(f.id)).steps[0].allowedTools, /Bash\(ls:\*\)/);
});

test('ensayo acotado: IA en modo plan sin escritura, comandos que escriben fuera se omiten, no toca lastRun ni 🔔', async () => {
  const c1 = cmd('Datos', 'Write-Output "tickets: SBK-1"', { id: 's_d' });
  const c2 = cmd('Publica', 'git push origin main', { id: 's_push2' });
  const a = role('Analiza', '[[mock:say Haría X. Me falta: permiso para npm test]]', { id: 's_an', allowedTools: 'Read Edit Write Bash(npm test:*)' });
  const f = await s.flow('Ensayo', [c1, c2, a], [['s_d', 's_push2'], ['s_push2', 's_an']], { cwd: s.dirs.work, finally: { command: 'Write-Output fin', shell: 'powershell', timeoutSec: 30 } });
  const n0 = s.calls().length;
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/rehearsal`, { input: 'SBK-1' });
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.trigger, 'rehearsal');
  assert.equal(run.rehearsal, true);
  assert.equal(run.status, 'success');
  assert.equal(run.finally, undefined, '"Al terminar" no corre en un ensayo');
  assert.equal(run.steps.s_push2.status, 'skipped');
  assert.equal(run.steps.s_push2.skipReason, 'rehearsal');
  const call = s.callsSince(n0).find((c) => /Haría X/.test(c.prompt));
  assert.equal(s.argOf(call, '--permission-mode'), 'plan');
  assert.match(s.argOf(call, '--disallowedTools'), /Edit/);
  assert.match(call.append, /ENSAYO/);
  const g = await s.getFlow(f.id);
  assert.equal(g.steps.find((x) => x.id === 's_an').lastRun, null, 'el ensayo no pisa la última ejecución real');
  const l = await lint(f.id);
  assert.ok(l.findings.some((x) => x.rule === 'R-REHEARSAL-SKIP' && x.stepId === 's_push2'));
  assert.ok(l.findings.some((x) => x.rule === 'R-REHEARSAL-MISSING' && x.stepId === 's_an' && /npm test/.test(x.detail)));
  await sleep(600);
  assert.ok(!(await s.uiOk('GET', '/api/attention')).items.some((i) => i.kind === 'run_failed' && i.flowId === f.id));
});

test('ensayo sin efectos (revisión adversarial): hooks, aserciones con comando, suites, despliegues y valores insertados no corren', async () => {
  const marker = `${s.dirs.work}\\hook-ran.txt`.replace(/\\/g, '/');
  const h = role('Con hook', '[[mock:say ok]]', { id: 's_h', hooks: `async function onStart(ctx) { await ctx.sh('Set-Content -Path "${marker}" -Value x'); }`, assertions: [{ type: 'command', command: `Set-Content -Path "${marker}.a" -Value x` }] });
  const dep = cmd('Despliega', 'npm run deploy', { id: 's_dep' });
  const suite = cmd('Suite', 'npx gherkin-testcafe chrome tests', { id: 's_suite' });
  const viaVar = cmd('Por variable', 'Write-Output {{vars.accion}}', { id: 's_var' });
  const f = await s.flow('Ensayo sin efectos', [h, dep, suite, viaVar], [], { cwd: s.dirs.work, vars: { accion: 'git push origin main' } });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/rehearsal`, { input: '' });
  const run = await s.waitRun(f.id, runId);
  const fsx = await import('node:fs');
  assert.equal(fsx.existsSync(marker), false, 'el hook no corrió');
  assert.equal(fsx.existsSync(`${marker}.a`), false, 'la aserción con comando no corrió');
  for (const id of ['s_dep', 's_suite', 's_var']) assert.equal(run.steps[id].skipReason, 'rehearsal', id);
  assert.ok(run.steps.s_h.warnings.some((w) => /hooks/.test(w)));
  // the denials of a rehearsal (plan mode) are not a permissions finding
  const l = await lint(f.id);
  assert.ok(!l.findings.some((x) => x.rule === 'R-DENY'));
});

test('revisión con IA: 2 llamadas independientes y read-only, evidencia verificada, desacuerdo visible, propuestas que se aplican con controles', async () => {
  const cons = { findings: [
    { severity: 'block', category: 'gate', step: 'Pull', claim: 'Nada frena el flujo si el ticket está en Done', evidence: [{ type: 'def', quote: 'Write-Output tickets' }], fix: { kind: 'flow', patch: { steps: { Analiza: { task: 'Si el ticket está en Done, detente.' } } }, check: 'el análisis lo menciona' } },
    { severity: 'risk', category: 'permissions', step: 'Analiza', claim: 'Problema uno de permisos', evidence: [{ type: 'def', quote: 'task' }] },
    { severity: 'risk', category: 'permissions', step: 'Analiza', claim: 'Problema dos de permisos', evidence: [{ type: 'def', quote: 'Write-Output tickets' }] },
  ], notVerifiable: ['qué ambiente usa el equipo'] };
  const adv = { findings: [
    { severity: 'block', category: 'gate', step: 'Pull', claim: 'Una regla en el prompt no frena: hace falta un step de control', evidence: [{ type: 'def', quote: 'Write-Output tickets' }], fix: { kind: 'structure', patch: { addSteps: [{ after: 'Pull', name: 'Control de estado', kind: 'command', shell: 'powershell', command: 'if ($env:FLOW_INPUT -match "Done") { exit 1 }' }] }, check: 'con un ticket en Done el flujo termina con error' } },
    { severity: 'block', category: 'timeout', step: 'Analiza', claim: 'Se cortó en la corrida r_inventada', evidence: [{ type: 'run', runId: 'r_inventada', quote: 'timed out' }] },
  ] };
  const pull = cmd('Pull', 'Write-Output tickets', { id: 's_pull' });
  const an = role('Analiza', '[[mock:say ok]]', { id: 's_an2' });
  const f = await s.flow('Revisión IA', [pull, an], [['s_pull', 's_an2']], { cwd: s.dirs.work, vars: { jira_token: 'secretoSuperLargo987654' }, description:`Flujo de prueba [[mock:review-cons ${JSON.stringify(cons)}]] [[mock:review-adv ${JSON.stringify(adv)}]]` });
  const n0 = s.calls().length;
  const { reviewId } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  const rv = await until(async () => { const r = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${reviewId}`); return r.status !== 'running' ? r : null; }, 20000);
  assert.equal(rv.status, 'done');
  const calls = s.callsSince(n0).filter((c) => /Revisión de flujo — rol/.test(c.system));
  assert.equal(calls.length, 2, 'dos llamadas');
  for (const c of calls) {
    assert.ok(c.argv.includes('--strict-mcp-config'));
    assert.equal(s.argOf(c, '--tools'), 'Read,Grep,Glob');
    assert.ok(c.prompt.length <= 40000);
  }
  assert.equal(calls[0].prompt, calls[1].prompt, 'independientes: el adversarial recibe el mismo dossier, nunca la respuesta del constructivo');
  assert.ok(!calls[0].prompt.includes('secretoSuperLargo987654'), 'una variable con nombre de secreto no llega al dossier');
  assert.ok(!/\\home$|\/home$/.test(calls[0].cwd), 'los revisores trabajan en una carpeta vacía');
  const perms = rv.findings.filter((x) => x.category === 'permissions');
  assert.equal(perms.length, 2, 'dos hallazgos del MISMO revisor no se funden');
  assert.equal(perms.find((x) => x.claim === 'Problema uno de permisos').verified, false, 'una cita que es solo una clave ("task") no verifica');
  const gate = rv.findings.find((x) => x.category === 'gate');
  assert.deepEqual(gate.sources.sort(), ['adversarial', 'constructive']);
  assert.equal(gate.fix.kind, 'structure', 'gana el arreglo estructural (verificable), no el texto en el prompt');
  assert.match(gate.dissent, /Constructivo propone otra cosa/);
  const fake = rv.findings.find((x) => x.category === 'timeout');
  assert.equal(fake.verified, false);
  assert.equal(fake.severity, 'improve', 'sin evidencia verificable nunca bloquea');
  assert.ok(rv.notVerifiable.includes('qué ambiente usa el equipo'));
  // the proposal lives in the '_review' chat; adding a command step widens access
  const msgs = await s.uiOk('GET', `/api/flows/${f.id}/chat/_review`);
  const msg = msgs.find((m) => m.reviewId === reviewId);
  const p = msg.proposals.find((x) => x.id === gate.proposalId);
  assert.equal(p.kind, 'structure');
  assert.ok(p.widens.some((w) => /step de comando «Control de estado»/.test(w)));
  // 🔔: a finished review with open proposals is an item that only navigates
  const it = await until(async () => (await s.uiOk('GET', '/api/attention')).items.find((i) => i.id === `review:${f.id}`), 12000);
  assert.ok(it, 'aparece en 🔔');
  assert.deepEqual(it.target, { flowId: f.id, open: 'flowreview' });
  const r1 =await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: msg.id, proposalId: p.id });
  assert.equal(r1.body.code, 'WIDEN_CONFIRM');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: msg.id, proposalId: p.id, confirmWiden: true });
  const g = await s.getFlow(f.id);
  const ctl = g.steps.find((x) => x.name === 'Control de estado');
  assert.equal(ctl.kind, 'command');
  assert.ok(g.edges.some((e) => e.source === 's_pull' && e.target === ctl.id) && g.edges.some((e) => e.source === ctl.id && e.target === 's_an2'), 'Pull → Control → Analiza');
});

test('la revisión nunca corre durante una ejecución, y una ejecución que arranca la cancela; respuesta inválida = error claro', async () => {
  const a = role('Lento', '[[mock:sleep 2]] [[mock:say ok]]', { id: 's_slow' });
  const f = await s.flow('Prioridad', [a], [], { description: '[[mock:review-sleep 3]]' });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  const r = await s.ui('POST', `/api/flows/${f.id}/reviews`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'FLOW_RUNNING');
  await s.waitRun(f.id, runId);
  const { reviewId } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/reviews`, {})).body.code, 'REVIEW_RUNNING');
  await sleep(500);
  const { runId: r2 } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  const rv = await until(async () => { const x = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${reviewId}`); return x.status !== 'running' ? x : null; }, 15000);
  assert.equal(rv.status, 'cancelled');
  assert.match(rv.error, /arrancó una ejecución/);
  await s.waitRun(f.id, r2);
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, description: '[[mock:review-garbage]]' });
  const { reviewId: r3 } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  const bad = await until(async () => { const x = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${r3}`); return x.status !== 'running' ? x : null; }, 15000);
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /JSON/);
});

test('chat de revisión: se dirige a un rol, propone reglas; una regla de máquina amplía alcance y se confirma aparte', async () => {
  const f = await s.flow('Chat revisión', [role('A', '[[mock:say ok]]', { id: 's_ca' })]);
  const send = async (message) => {
    await s.uiOk('POST', `/api/flows/${f.id}/chat/_review`, { message });
    return until(async () => { const l = await s.uiOk('GET', `/api/flows/${f.id}/chat/_review`); const m = l[l.length - 1]; return m.role === 'assistant' && m.status !== 'running' ? m : null; });
  };
  const n0 = s.calls().length;
  const m = await send('@adversarial ¿y si el ticket está en Done? [[mock:propose-policy {"scope":"flow","type":"ticketStatus","text":"Solo tickets listos","params":{"statuses":"Ready For Testing"}}]]');
  const call = s.callsSince(n0).find((c) => /Chat de revisión del flujo/.test(c.append));
  assert.match(call.prompt, /mirada de ADVERSARIAL/);
  assert.match(call.prompt, /<review-context>/);
  assert.equal(s.argOf(call, '--allowedTools'), 'Read,Grep,Glob');
  const p = m.proposals[0];
  assert.equal(p.kind, 'policy');
  assert.equal(p.policy.type, 'ticketStatus');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m.id, proposalId: p.id });
  assert.equal((await s.getFlow(f.id)).policies[0].type, 'ticketStatus');
  assert.ok((await lint(f.id)).findings.some((x) => x.rule === 'POL-TICKET-GATE'), 'la regla exige un step de control');
  const m2 = await send('[[mock:propose-policy {"scope":"machine","type":"note","text":"Bash corta a los 10 min"}]]');
  const r = await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m2.id, proposalId: m2.proposals[0].id });
  assert.equal(r.body.code, 'WIDEN_CONFIRM');
  assert.match(r.body.widens[0], /todos los flujos/);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m2.id, proposalId: m2.proposals[0].id, confirmWiden: true });
  assert.ok((await s.uiOk('GET', '/api/policies')).machine.some((x) => x.text === 'Bash corta a los 10 min'));
  await s.uiOk('PUT', '/api/policies', { policies: [] });
  // while the flow runs the review chat waits (spec 25 C9)
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: '[[mock:sleep 2]] ok' }] });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/_review`, { message: 'hola' })).status, 409);
  await s.waitRun(f.id, runId);
});

test('🔔: un flujo con un bloqueante del lint aparece como "review" y solo navega; las políticas del flujo viajan al exportar', async () => {
  const f = await s.flow('Con skill rota', [{ id: 's_x', name: 'Rota', kind: 'skill', skillRef: 'skill-que-no-existe', task: 't' }], [], { policies: [{ type: 'noExternalWrites' }] });
  const it = await until(async () => (await s.uiOk('GET', '/api/attention')).items.find((i) => i.id === `review:${f.id}`), 12000);
  assert.ok(it, 'aparece');
  assert.equal(it.kind, 'review');
  assert.equal(it.severity, 'error');
  assert.deepEqual(it.target, { flowId: f.id, open: 'flowreview' });
  const b = await s.uiOk('GET', `/api/flows/${f.id}/export`);
  assert.equal(b.flow.policies[0].type, 'noExternalWrites');
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle: b, name: 'Importado con reglas' });
  assert.equal(imp.flow.policies[0].source, 'import');
});
