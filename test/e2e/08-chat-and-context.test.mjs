// Conversations and visibility: step chats (session reuse, context resend only on change, proposals + apply,
// memory, improve mode, lost session recovery), the general chat router (ask a step / the flow, run a step / the
// flow, fallback) with WebSocket streaming, and the context box: the preview must be EXACTLY what the CLI receives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, role, skill, agent, cmd, sleep } from './helpers/harness.mjs';

let s;
before(async () => { s = await startServer({ name: 'chat' }); await s.start(); });
after(async () => { await s?.stop(); });

/** Sends a UI chat message (async on the server) and waits for the assistant reply. */
const chat = async (flowId, key, message, extra = {}) => {
  const before = (await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`)).length;
  await s.uiOk('POST', `/api/flows/${flowId}/chat/${key}`, { message, ...extra });
  for (let i = 0; i < 200; i++) {
    const msgs = await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`);
    const done = msgs.slice(before).filter((m) => m.role !== 'user' && m.status !== 'running');
    if (done.length && msgs.slice(before).every((m) => m.status !== 'running')) return msgs.slice(before);
    await sleep(100);
  }
  throw new Error('el chat no respondió');
};

test('chat de step: primera vez envía <step-context>, después reanuda la sesión sin reenviarlo; cambiar el step lo reenvía', async () => {
  const a = role('Analista', 'Analiza tickets', { role: 'QA senior' });
  const f = await s.flow('Chat step', [a]);
  let n = s.calls().length;
  const [, r1] = await chat(f.id, a.id, 'hola');
  assert.equal(r1.status, 'done');
  assert.match(r1.text, /Respuesta de chat \(mock\) a: hola/);
  let c = s.callsSince(n)[0];
  assert.match(c.append, /^# Chat de step/);
  assert.match(c.prompt, /<step-context>[\s\S]*Analiza tickets[\s\S]*<\/step-context>/);
  assert.equal(c.resume, null);
  n = s.calls().length;
  await chat(f.id, a.id, 'segunda');
  c = s.callsSince(n)[0];
  assert.ok(c.resume, 'reanuda la sesión');
  assert.match(c.prompt, /<step-context>\(sin cambios desde el último mensaje\)<\/step-context>/);
  const g = await s.getFlow(f.id);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...g, steps: [{ ...g.steps[0], task: 'Nueva tarea' }] });
  n = s.calls().length;
  await chat(f.id, a.id, 'tercera');
  assert.match(s.callsSince(n)[0].prompt, /<step-context>[\s\S]*Nueva tarea/);
  assert.equal(s.argOf(s.callsSince(n)[0], '--allowedTools'), 'Read,Grep,Glob,WebFetch,WebSearch,Skill');
});

test('chat de step: propuestas <step-update> (aplicar cambia el step; inválidas no se aplican) y <remember>', async () => {
  const a = role('Editable', 'tarea vieja');
  const f = await s.flow('Propuestas', [a]);
  const [, r] = await chat(f.id, a.id, 'mejorá la tarea [[mock:propose {"task":"tarea nueva","model":"sonnet","memory":[]}]] [[mock:remember usar Gherkin]]');
  assert.equal(r.proposals.length, 1);
  assert.deepEqual(r.remembered, ['usar Gherkin']);
  assert.ok(!r.text.includes('<step-update>'));
  const applied = await s.uiOk('POST', `/api/flows/${f.id}/chat/${a.id}/apply`, { messageId: r.id, proposalId: r.proposals[0].id });
  const st = applied.steps[0];
  assert.equal(st.task, 'tarea nueva');
  assert.equal(st.model, 'sonnet');
  assert.equal(st.memory[0].text, 'usar Gherkin', 'campos no permitidos (memory) no se pisan');
  const [, bad] = await chat(f.id, a.id, 'otra [[mock:propose-invalid]]');
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/chat/${a.id}/apply`, { messageId: bad.id, proposalId: bad.proposals[0].id })).status, 400);
  const msgs = await s.uiOk('GET', `/api/flows/${f.id}/chat/${a.id}`);
  assert.equal(msgs.find((m) => m.id === r.id).proposals[0].applied, true);
});

test('modo mejora: agrega Edit/Write, acceptEdits y --add-dir con la carpeta de la skill', async () => {
  const a = skill('Con skill', 'qa-test-architect', 'x');
  const f = await s.flow('Mejora', [a]);
  const n = s.calls().length;
  await chat(f.id, a.id, 'mejorá la skill', { improve: true });
  const c = s.callsSince(n)[0];
  assert.match(s.argOf(c, '--allowedTools'), /Edit,Write$/);
  assert.equal(s.argOf(c, '--permission-mode'), 'acceptEdits');
  assert.equal(path.resolve(s.argOf(c, '--add-dir')), path.resolve(s.dirs.home, '.claude', 'skills', 'qa-test-architect'));
  assert.match(c.prompt, /modo mejora ACTIVO/);
});

test('sesión perdida (expirada/borrada) → se reintenta una vez con sesión nueva y el contexto completo', async () => {
  const a = role('Olvidadizo', 'x');
  const f = await s.flow('Sesión', [a]);
  await chat(f.id, a.id, 'primero');
  for (const x of fs.readdirSync(s.dirs.state)) if (x.startsWith('session-')) fs.rmSync(path.join(s.dirs.state, x));
  const n = s.calls().length;
  const [, r] = await chat(f.id, a.id, 'segundo');
  assert.equal(r.status, 'done');
  const calls = s.callsSince(n);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].resume && !calls[1].resume);
  assert.match(calls[1].prompt, /<step-context>[\s\S]*<\/step-context>/);
  assert.ok(r.events.some((e) => /Sesión anterior no disponible/.test(e.text || '')));
});

test('borrar el chat de un step reinicia su sesión', async () => {
  const a = role('Borrable', 'x');
  const f = await s.flow('Borrar chat', [a]);
  await chat(f.id, a.id, 'hola');
  assert.ok((await s.getFlow(f.id)).steps[0].chatSessionId);
  const g = await s.uiOk('DELETE', `/api/flows/${f.id}/chat/${a.id}`);
  assert.equal(g.steps[0].chatSessionId, null);
  assert.deepEqual(await s.uiOk('GET', `/api/flows/${f.id}/chat/${a.id}`), []);
});

test('chat general: el enrutador (haiku, sin tools) deriva a un step, al flujo, ejecuta un step o el flujo; respuesta inválida → flujo', async () => {
  const a = role('Diseñador', '[[mock:say casos diseñados]]');
  const b = cmd('Tests', 'Write-Output "tests ok {{input}}"');
  const f = await s.flow('Router', [a, b], [[a.id, b.id]]);
  const w = await s.ws();
  let n = s.calls().length;
  let msgs = await chat(f.id, '_global', `¿cómo diseñás? [[mock:route ask ${a.id} explicame tu método]]`);
  const router = s.callsSince(n).find((c) => /enrutador de un flujo/.test(c.system));
  assert.equal(s.argOf(router, '--model'), 'haiku');
  assert.equal(s.argOf(router, '--tools'), '');
  assert.equal(msgs.find((m) => m.role === 'router').decision.target, a.id);
  const ans = msgs.find((m) => m.role === 'assistant');
  assert.equal(ans.routedTo, 'Diseñador');
  assert.match(ans.text, /explicame tu método/);
  const stepChat = await s.uiOk('GET', `/api/flows/${f.id}/chat/${a.id}`);
  assert.ok(stepChat.some((m) => m.origin === 'global'), 'queda en el chat del step');
  assert.ok(w.msgs.some((m) => m.type === 'chat.event' && m.key === '_global' && m.relayed), 'se retransmite en vivo al chat general');
  msgs = await chat(f.id, '_global', 'resumen general');
  assert.equal(msgs.find((m) => m.role === 'assistant').routedTo, 'Flujo general');
  n = s.calls().length;
  msgs = await chat(f.id, '_global', `corré los tests [[mock:route run_step ${b.id} SBK-5]]`);
  const started = msgs.find((m) => m.role === 'assistant');
  const runId = started.text.match(/\((r_\w+)\)/)[1];
  const run = await s.waitRun(f.id, runId);
  assert.equal(run.trigger, 'chat');
  assert.deepEqual(Object.keys(run.steps), [b.id]);
  assert.equal(run.steps[b.id].output, 'tests ok SBK-5');
  msgs = await chat(f.id, '_global', 'ejecutá todo [[mock:route run_flow flow REQ-1]]');
  const all = await s.waitRun(f.id, msgs.find((m) => m.role === 'assistant').text.match(/\((r_\w+)\)/)[1]);
  assert.equal(Object.keys(all.steps).length, 2);
  msgs = await chat(f.id, '_global', 'algo [[mock:route ask s_inexistente]]');
  assert.equal(msgs.find((m) => m.role === 'router').decision.target, 'flow');
  w.close();
});

test('chat general de un flujo vacío no llama al enrutador', async () => {
  const f = await s.flow('Vacío chat', []);
  const n = s.calls().length;
  const msgs = await chat(f.id, '_global', 'hola');
  assert.ok(!s.callsSince(n).some((c) => /enrutador/.test(c.system)));
  assert.equal(msgs.find((m) => m.role === 'router').decision.reason, 'El flujo no tiene steps todavía.');
});

test('caja de contexto: la vista previa es EXACTAMENTE lo que recibe el CLI (system, prompt, flags)', async () => {
  const up = role('Origen', '[[mock:json {"ticket":"SBK-3","n":2}]]', { output: { format: 'json' } });
  const target = role('Destino', 'Trabaja {{steps.Origen.json.ticket}} en {{vars.env}} [[mock:say hecho]]', {
    role: 'Revisor', context: 'Ctx {{vars.env}}', model: 'opus', allowedTools: 'Read Bash(git:*)', output: { format: 'json', schema: '{"type":"object"}' }, assertions: [{ type: 'contains', value: 'x', severity: 'warn' }],
  });
  const f = await s.flow('Contexto', [up, target], [[up.id, target.id]], { vars: { env: 'qa' } });
  await s.uiOk('POST', `/api/flows/${f.id}/memory/${target.id}`, { text: 'dato recordado' });
  const n = s.calls().length;
  const run = await s.runUi(f.id, 'REQ-9');
  const sent = s.callsSince(n).find((c) => /# Step "Destino"/.test(c.append));
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/${target.id}/preview`, { sample: { runId: run.id } });
  assert.equal(pv.system, sent.append, 'system prompt idéntico');
  assert.equal(pv.user, sent.prompt, 'prompt idéntico');
  const flags = (argv) => argv.filter((x, i) => !/^--(append-)?system-prompt-file$/.test(argv[i - 1] || '') && !/^--(append-)?system-prompt-file$/.test(x));
  assert.deepEqual(flags(pv.cli.args), flags(sent.argv), 'mismos flags del CLI');
  const ids = pv.sections.map((x) => `${x.id}:${x.toModel}`);
  for (const want of ['header:system', 'role:system', 'context:system', 'memoryStep:system', 'outputFormat:system', 'rules:system', 'task:user', 'upstream:user', 'input:user', 'vars:user', 'claudeCode:claude-code', 'access:cli', 'around:none']) assert.ok(ids.includes(want), `${want} en ${ids}`);
  assert.ok(pv.sections.every((x) => x.chars === x.text.length && x.tokensEst > 0));
  assert.deepEqual(pv.refs.map((r) => [r.step, r.source]), [['Origen', 'run']]);
  // draft (unsaved) edits are previewed without saving
  const d = await s.uiOk('POST', `/api/flows/${f.id}/steps/${target.id}/preview`, { draft: { task: 'borrador {{vars.env}}' }, sample: { input: 'X' } });
  assert.match(d.user, /## Tarea\nborrador qa/);
  assert.match(d.user, /## Input del flujo\nX/);
  assert.equal((await s.getFlow(f.id)).steps[1].task, target.task);
});

test('caja de contexto: avisos (skill/agente inexistente, ref no anterior, secreto, schema, onStart, pins en externo) y chat/comando', async () => {
  const a = role('A', '[[mock:say a]]');
  const k = skill('Sk', 'no-existe', 'x');
  const ag = agent('Ag', 'nadie', 'x');
  const r = role('Ref', 'usa {{steps.A.output}} y {{steps.Fantasma.output}}', { hooks: 'async function onStart(ctx) {}', output: { format: 'json', schema: '{"type":' } });
  const c = cmd('Cmd', "Write-Output '{{input}}' {{{vars.api_token}}}");
  const f = await s.flow('Avisos', [a, k, ag, r, c], [[a.id, c.id]], { vars: { api_token: 'abc' } });
  await s.uiOk('POST', `/api/flows/${f.id}/steps/${a.id}/pin`, { output: 'fijo' });
  const codes = async (id, body = {}) => (await s.uiOk('POST', `/api/flows/${f.id}/steps/${id}/preview`, body)).warnings.map((w) => w.code);
  assert.ok((await codes(k.id)).includes('SKILL_NOT_FOUND'));
  assert.ok((await codes(ag.id)).includes('AGENT_NOT_FOUND'));
  const rc = await codes(r.id);
  for (const w of ['NON_UPSTREAM_REF', 'UNRESOLVED_REF', 'SECRET_IN_PROMPT', 'INVALID_SCHEMA', 'HOOK_MAY_CHANGE']) assert.ok(rc.includes(w), `${w} en ${rc}`);
  const cmdPv = await s.uiOk('POST', `/api/flows/${f.id}/steps/${c.id}/preview`, { sample: { mode: 'external', input: 'hola' } });
  assert.ok(cmdPv.warnings.some((w) => w.code === 'TEMPLATE_IN_SINGLE_QUOTES'));
  assert.ok(cmdPv.warnings.some((w) => w.code === 'RAW_TEMPLATE'));
  assert.match(cmdPv.command.rendered, /\$\{env:AFS_V0\}/);
  assert.equal(cmdPv.upstream[0].note, 'se ejecutará: la salida real no se conoce aún', 'fijado + externo: se ejecuta (no "sin salida")');
  const ui = await s.uiOk('POST', `/api/flows/${f.id}/steps/${c.id}/preview`, {});
  assert.deepEqual(ui.pinsUsed.length >= 0 && ui.upstream[0].source, 'pinned');
  const ch = await s.uiOk('POST', `/api/flows/${f.id}/steps/${a.id}/preview`, { target: 'chat' });
  assert.equal(ch.chat.willResend, true);
  assert.match(ch.chat.system, /^# Chat de step/);
  assert.equal((await s.ui('POST', `/api/flows/${f.id}/steps/s_nope/preview`, {})).status, 404);
});
