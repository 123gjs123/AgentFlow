// Every kind of step (role, skill, agent, command in powershell/cmd/bash) and how data travels between them:
// upstream outputs, JSON, {{input}}/{{vars}}/{{steps.X…}} references, input modes, parallel branches, provenance,
// what exactly reaches the Claude CLI (flags, least-privilege tools, system/user prompt) and per-step usage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, skill, agent, cmd, stepOf, hasBin } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'steps' }); await s.start(); });
after(async () => { await s?.stop(); });

test('rol: system prompt con encabezado, rol, contexto renderizado, reglas; flags del CLI por step', async () => {
  const a = role('Analista', 'Analiza {{input}} para {{vars.env}} [[mock:say análisis listo]]', {
    role: 'Eres un QA senior', context: 'Entorno {{vars.env}}', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', allowedTools: 'Read Grep Bash(git status:*) mcp__claude_ai_Atlassian_Rovo__getJiraIssue',
  });
  const f = await s.flow('Rol', [a], [], { vars: { env: 'qa' }, cwd: s.dirs.project });
  const n = s.calls().length;
  const run = await s.runUi(f.id, 'SBK-123');
  const st = run.steps[a.id];
  assert.equal(st.status, 'success');
  assert.equal(st.output, 'análisis listo');
  const [c] = s.callsSince(n);
  assert.match(c.append, /# Step "Analista" del flujo "Rol"/);
  assert.match(c.append, /## Rol\nEres un QA senior/);
  assert.match(c.append, /## Contexto\nEntorno qa/);
  assert.match(c.append, /<remember>/);
  assert.match(c.prompt, /## Tarea\nAnaliza SBK-123 para qa/);
  assert.match(c.prompt, /## Input del flujo\nSBK-123/);
  assert.match(c.prompt, /"env": "qa"/);
  assert.equal(s.argOf(c, '--model'), 'opus');
  assert.equal(s.argOf(c, '--effort'), 'high');
  assert.equal(s.argOf(c, '--permission-mode'), 'acceptEdits');
  assert.equal(s.argOf(c, '--tools'), 'Read,Grep,Bash,ToolSearch', 'solo las built-in del acceso (mínimo privilegio)');
  assert.equal(s.argOf(c, '--allowedTools'), 'Read,Grep,Bash(git status:*),mcp__claude_ai_Atlassian_Rovo__getJiraIssue');
  assert.equal(path.resolve(c.cwd), path.resolve(s.dirs.project), 'corre en el cwd del flujo');
  // usage, attempts, inputView
  assert.equal(st.usage.inputTokens, 100);
  assert.equal(st.usage.outputTokens, 20);
  assert.ok(st.usage.costUsd > 0);
  assert.equal(st.attempts.length, 1);
  assert.equal(st.inputView.kind, 'ai');
  assert.equal(run.totals.inputTokens, 100);
});

test('skill: instrucción de usar la skill + herramienta Skill; skill del proyecto se encuentra', async () => {
  const a = skill('Diseño', 'project-skill', 'Diseña casos');
  const f = await s.flow('Skill', [a], [], { cwd: s.dirs.project });
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'success');
  const [c] = s.callsSince(n);
  assert.match(c.append, /Skill "project-skill" \(archivo: .*SKILL\.md\)/);
  assert.match(c.append, /Usa la skill "project-skill"/);
  assert.match(s.argOf(c, '--tools'), /(^|,)Skill(,|$)/);
});

test('agente: --agent y sin --tools (usa las herramientas del agente)', async () => {
  const a = agent('Revisión', 'reviewer', 'Revisa');
  const f = await s.flow('Agente', [a]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'success');
  assert.match(run.steps[a.id].output, /agent=reviewer/);
  const [c] = s.callsSince(n);
  assert.equal(s.argOf(c, '--agent'), 'reviewer');
  assert.ok(!c.argv.includes('--tools'));
  assert.match(c.append, /Agente de Claude Code "reviewer" \(archivo:/);
});

test('comandos: powershell, cmd y bash reciben input, upstream y variables por entorno', async () => {
  const shells = [cmd('PS', 'Write-Output "ps:{{input}}:{{vars.v}}"; Write-Output $env:AFS_STEP')];
  shells.push(cmd('CMD', 'echo cmd:{{input}}:{{vars.v}}', { shell: 'cmd' }));
  const bash = await hasBin(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c', 'exit 0']);
  if (bash) shells.push(cmd('BASH', 'echo "bash:"{{input}}":"{{vars.v}}; cat', { shell: 'bash' }));
  const f = await s.flow('Shells', shells, [], { vars: { v: 'V1' } });
  const run = await s.runUi(f.id, 'IN');
  const out = (n) => run.steps[shells.find((x) => x.name === n).id];
  assert.equal(out('PS').status, 'success', out('PS').error);
  assert.match(out('PS').output, /ps:IN:V1\s+PS/);
  assert.equal(out('CMD').output, 'cmd:"IN":"V1"', 'cmd recibe las comillas tal cual (sin \\" de Node)');
  if (bash) { assert.match(out('BASH').output, /bash:IN:V1/); assert.match(out('BASH').output, /IN$/, 'stdin = input del flujo'); }
  assert.equal(out('PS').exitCode, 0);
  assert.ok(out('PS').inputView.values.some((v) => v.ref === 'input' && v.value === 'IN'));
});

test('comando que falla → EXIT_NONZERO y los siguientes se omiten (upstream_failed)', async () => {
  const a = cmd('Rompe', 'Write-Error "mal"; exit 4');
  const b = role('Después', 'x');
  const f = await s.flow('Falla', [a, b], [[a.id, b.id]]);
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'error');
  assert.equal(run.steps[a.id].code, 'EXIT_NONZERO');
  assert.equal(run.steps[a.id].exitCode, 4);
  assert.equal(run.steps[b.id].status, 'skipped');
  assert.equal(run.steps[b.id].skipReason, 'upstream_failed');
});

test('cadena IA → comando → IA: salidas, JSON y referencias {{steps.X.json.campo}} viajan', async () => {
  const a = role('Extraer', '[[mock:json {"ticket":"SBK-9","casos":[1,2,3],"meta":{"prio":"alta"}}]]', { output: { format: 'json', schema: '' } });
  const b = cmd('Contar', 'Write-Output "prio={{steps.Extraer.json.meta.prio}} n={{steps.Extraer.casos}}"; $j = $env:STEP_UPSTREAM_JSON | ConvertFrom-Json; Write-Output ("t=" + $j.Extraer.ticket)');
  const c = role('Informe', 'Informa sobre {{steps.Extraer.json.ticket}} [[mock:echo]]');
  const f = await s.flow('Cadena', [a, b, c], [[a.id, b.id], [b.id, c.id], [a.id, c.id]]);
  const run = await s.runUi(f.id, 'texto');
  assert.equal(run.status, 'success', JSON.stringify(Object.values(run.steps).map((x) => x.error)));
  assert.deepEqual(run.steps[a.id].json.casos, [1, 2, 3]);
  assert.equal(run.steps[a.id].output, 'Resultado del step.', 'el bloque JSON sale del texto');
  assert.match(run.steps[b.id].output, /prio=alta n=\[\s*1,\s*2,\s*3\s*\]/);
  assert.match(run.steps[b.id].output, /t=SBK-9/);
  const echo = run.steps[c.id].output;
  assert.match(echo, /Informa sobre SBK-9/);
  assert.match(echo, /### Contar\nprio=alta/);
  assert.match(echo, /### Extraer\nResultado del step\.\n\nDatos \(JSON\):\n```json/);
  // provenance
  const inputs = run.steps[c.id].inputs;
  assert.ok(inputs.some((i) => i.step === 'Extraer' && i.source === 'run' && !i.viaRef));
  assert.ok(inputs.some((i) => i.step === 'Extraer' && i.viaRef));
});

test('modos de input: json, summary (resume con haiku si es largo) y refs', async () => {
  const long = 'x'.repeat(2000);
  const a = role('Largo', `[[mock:say INICIO ${long} FIN]]`);
  const j = role('ConJson', '[[mock:json {"k":1}]]', { output: { format: 'json' } });
  const sum = role('Resumido', '[[mock:echo]]', { input: { mode: 'summary' } });
  const js = role('SoloJson', '[[mock:echo]]', { input: { mode: 'json' } });
  const refs = role('Refs', 'k={{steps.ConJson.json.k}} [[mock:echo]]', { input: { mode: 'refs' } });
  const f = await s.flow('Modos', [a, j, sum, js, refs], [[a.id, sum.id], [j.id, js.id], [a.id, refs.id], [j.id, refs.id]]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.status, 'success');
  const summaryCall = s.callsSince(n).find((c) => /^Resume el texto/.test(c.system));
  assert.ok(summaryCall, 'se pidió un resumen');
  assert.equal(s.argOf(summaryCall, '--model'), 'haiku');
  assert.match(run.steps[sum.id].output, /### Largo\nRESUMEN\(/);
  assert.ok(!run.steps[sum.id].output.includes(long));
  assert.match(run.steps[js.id].output, /### ConJson\n```json\n\{\n  "k": 1\n\}\n```/);
  assert.ok(!run.steps[refs.id].output.includes('## Salidas de los steps anteriores'));
  assert.match(run.steps[refs.id].output, /k=1/);
});

test('referencia a un step que no es anterior → NON_UPSTREAM_REF (salvo allowNonUpstream)', async () => {
  const a = role('Uno', '[[mock:say uno]]');
  const b = role('Dos', 'usa {{steps.Uno.output}}');
  const c = role('Tres', 'usa {{steps.Uno.output}} [[mock:echo]]', { input: { mode: 'full', allowNonUpstream: true } });
  const f = await s.flow('NoUp', [a, b, c]);
  await s.runUi(f.id, '', { stepId: a.id }); // Uno has a last successful output
  const run = await s.runUi(f.id);
  assert.equal(run.steps[b.id].code, 'NON_UPSTREAM_REF');
  assert.equal(run.steps[c.id].status, 'success');
});

test('ramas paralelas (AFS_MAX_PARALLEL=2) y un step solo con su input', async () => {
  const a = role('P1', '[[mock:sleep 1]] [[mock:say p1]]');
  const b = role('P2', '[[mock:sleep 1]] [[mock:say p2]]');
  const c = role('Unir', '[[mock:echo]]');
  const f = await s.flow('Paralelo', [a, b, c], [[a.id, c.id], [b.id, c.id]]);
  const run = await s.runUi(f.id);
  const [ra, rb] = [run.steps[a.id], run.steps[b.id]];
  assert.ok(ra.startedAt < rb.endedAt && rb.startedAt < ra.endedAt, 'P1 y P2 se solapan');
  assert.match(run.steps[c.id].output, /### P1\np1/);
  assert.match(run.steps[c.id].output, /### P2\np2/);
  // run only one step: upstream comes from the previous run (lastRun)
  const solo = await s.runUi(f.id, 'solo', { stepId: c.id });
  assert.equal(Object.keys(solo.steps).length, 1);
  assert.ok(solo.steps[c.id].inputs.every((i) => i.source === 'lastRun'));
  assert.ok(solo.steps[c.id].warnings.some((w) => /última salida/.test(w)));
});

test('memoria: <remember> en la salida se guarda y vuelve en la siguiente ejecución', async () => {
  const a = role('Memorioso', '[[mock:remember el ambiente QA usa el puerto 8443]]');
  const f = await s.flow('Recordar', [a]);
  await s.runUi(f.id);
  const g = await s.getFlow(f.id);
  assert.equal(g.steps[0].memory[0].text, 'el ambiente QA usa el puerto 8443');
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.ok(!run.steps[a.id].output.includes('<remember>'));
  assert.match(s.callsSince(n)[0].append, /## Memoria de este step\n- el ambiente QA usa el puerto 8443/);
});

test('acciones MCP y archivos escritos se detectan en la salida del step', async () => {
  const a = role('Comentar', '[[mock:tool mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue SBK-1]] [[mock:tool mcp__claude_ai_Atlassian_Rovo__getJiraIssue SBK-1]] [[mock:tool Write]]', { allowedTools: 'Read mcp__claude_ai_Atlassian_Rovo' });
  const f = await s.flow('Acciones', [a]);
  const run = await s.runUi(f.id);
  const st = run.steps[a.id];
  assert.equal(st.actions.length, 1, 'solo las herramientas que escriben cuentan como acción');
  assert.equal(st.actions[0].tool, 'addCommentToJiraIssue');
  assert.equal(st.actions[0].server, 'Atlassian_Rovo');
  const evs = st.events.map((e) => e.kind);
  assert.ok(evs.includes('init') && evs.includes('tool_use') && evs.includes('tool_result') && evs.includes('result'));
});

test('pins: la UI usa la salida fijada (el step no corre); desfijar vuelve a ejecutarlo', async () => {
  const a = role('Caro', '[[mock:say real]]');
  const b = role('Usa', '[[mock:echo]]');
  const f = await s.flow('Pins', [a, b], [[a.id, b.id]]);
  await s.uiOk('POST', `/api/flows/${f.id}/steps/${a.id}/pin`, { output: 'FIJADO', json: { v: 1 } });
  const n = s.calls().length;
  let run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].pinned, true);
  assert.deepEqual(run.usedPins, ['Caro']);
  assert.equal(s.callsSince(n).length, 1, 'solo corre el step no fijado');
  assert.match(run.steps[b.id].output, /### Caro \(salida fijada\)\nFIJADO/);
  // pin from last run
  await s.uiOk('DELETE', `/api/flows/${f.id}/steps/${a.id}/pin`);
  run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].output, 'real');
  const g = await s.uiOk('POST', `/api/flows/${f.id}/steps/${a.id}/pin`, { fromLast: true });
  assert.equal(g.steps.find((x) => x.id === a.id).pinned.output, 'real');
});

test('el flujo se congela al empezar: editarlo durante la ejecución no cambia esa ejecución', async () => {
  const a = role('Lento', '[[mock:sleep 1.5]] [[mock:say versión 1]]');
  const f = await s.flow('Snapshot', [a]);
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' });
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, steps: [{ ...a, task: '[[mock:say versión 2]]' }] });
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.steps[a.id].output, 'versión 1');
  assert.ok(run.flowSnapshotHash);
  const list = await s.uiOk('GET', `/api/flows/${f.id}/runs`);
  assert.ok(list.some((r) => r.id === runId));
});

test('archivos: un Write de Claude aparece en files y cuenta como salida (no EMPTY_OUTPUT)', async () => {
  const p = path.join(s.dirs.work, 'informe.md');
  const a = role('Escribe', `[[mock:write ${p}]] [[mock:empty]]`);
  const b = role('Lee', 'archivos: {{steps.Escribe.files}} [[mock:echo]]');
  const f = await s.flow('Archivos', [a, b], [[a.id, b.id]]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps[a.id].status, 'success', run.steps[a.id].error);
  assert.deepEqual(run.steps[a.id].files, [p]);
  assert.ok(run.steps[b.id].output.includes(`archivos: ${p}`));
  assert.ok(fs.existsSync(s.dirs.work));
});
