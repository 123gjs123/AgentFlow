// Spec 28, round 2: the reviewer INVESTIGATES (full evidence of the runs as files + read-only git on the flow's repos)
// and can RESHAPE the flow (split, remove, reconnect). It still only proposes; "apply the safe ones" never applies what
// widens access or removes something.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';

const GIT_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'review-git.mjs');
let s;
before(async () => { s = await startServer({ name: 'review2', env: { AFS_PROBE_HEADLESS: 'off' } }); await s.start(); });
after(async () => { await s?.stop(); });
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } };
const lastAnswer = (id, key) => until(async () => { const l = await s.uiOk('GET', `/api/flows/${id}/chat/${key}`); const m = l[l.length - 1]; return m.role === 'assistant' && m.status !== 'running' ? m : null; });

function makeRepo() {
  const repo = path.join(s.dirs.work, `repo-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'x'); git('add', '.'); git('commit', '-qm', 'Arreglo el texto de Line History'); git('branch', 'fix/line-history');
  return repo;
}

test('git de solo lectura: lee los repos del flujo y rechaza escrituras, programas y otras carpetas', () => {
  const repo = makeRepo();
  const env = { ...process.env, AFS_REVIEW_REPOS: repo };
  const run = (...a) => execFileSync('node', [GIT_HELPER, ...a], { encoding: 'utf8', env, stdio: 'pipe' });
  assert.match(run(repo, 'log', '--all', '--oneline', '--grep=Line History'), /Arreglo el texto/);
  assert.match(run(repo, 'branch', '-a', '--list', '*fix*'), /fix\/line-history/);
  for (const bad of [[repo, 'push'], [repo, 'commit', '-m', 'x'], [repo, 'branch', 'nueva'], [repo, 'branch', '-D', 'fix/line-history'], [repo, 'log', '--output=x'], [repo, 'grep', '-O', 'x'], [repo, 'diff', '--ext-diff'], [s.dirs.home, 'log'], [repo, 'tag', '--sort=refname', 'evil1'], [repo, 'tag', '--format=x', 'evil2'], [repo, 'branch', '--sort=refname', 'evil3'], [repo, 'tag', '-a', 'evil4'], [repo, 'diff', '--no-index', '--', 'a.txt', s.dirs.home], [repo, 'cat-file', '--filters', 'HEAD:a.txt'], [repo, 'grep', "--open-files=node -e require('fs').writeFileSync('pwn','x')", 'x'], [repo, 'grep', '--open=x', 'x'], [repo, 'grep', '-Ox', 'x'], [repo, 'blame', '--contents', path.join(s.dirs.home, 'x.txt'), 'a.txt'], [repo, 'branch', '-uother'], [repo, 'log', '--out=x'], [repo, 'show', 'HEAD:../x.txt'], [repo, 'diff', '-U', '--output=pwn'], [repo, 'diff', '--unified', '--output=pwn'], [repo, 'log', '--pretty', '--output=pwn', '-1'], [repo, 'log', '--abbrev', '--output=pwn', '-1'], [repo, 'diff', 'NUL', path.join(s.dirs.home, 'x.txt')], [repo, 'diff', '--', 'NUL', path.join(s.dirs.home, 'x.txt')], [repo, 'diff', 'NUL', '//localhost/C$/Windows/win.ini'], [repo, 'diff', 'HEAD', '../x.txt'], [repo, 'ls-files', '-o'], [repo, 'status', '-uall']]) {
    assert.throws(() => run(...bad), undefined, bad.slice(1).join(' '));
  }
  assert.match(run(repo, 'branch', '--list'), /fix\/line-history/, 'nada se borró');
  assert.doesNotMatch(run(repo, 'branch', '--list') + run(repo, 'tag', '--list'), /evil/, 'nada se creó');
  assert.ok(!fs.existsSync(path.join(repo, 'pwn')) && !fs.existsSync('pwn'), 'ningún programa corrió');
  assert.throws(() => execFileSync('git', ['-C', repo, 'config', '--get', 'branch.master.merge'], { stdio: 'pipe' }), undefined, 'no escribió config');
  // the allowlist keeps the useful forms
  assert.match(run(repo, 'log', '-n1', '--format=%s'), /Arreglo/);
  assert.match(run(repo, 'grep', '-n', '-ex'), /a\.txt:1/);
  run(repo, 'log', '--grep', 'x'); // a mandatory value may go separated (git always takes it as the value)
  assert.throws(() => run(repo, 'diff', '-U', '5'), /pegado/, 'un valor OPCIONAL separado se rechaza: va pegado (git lo leería como otra cosa)');
});

test('revisión que investiga: evidencia completa y git en sus herramientas; parte un step; "aplicar las seguras" deja lo destructivo', async () => {
  const repo = makeRepo();
  const cons = { findings: [
    { severity: 'block', category: 'timeout', step: 'Auto', claim: 'Se corta por tiempo: tres ambientes en un step', evidence: [{ type: 'def', quote: 'Ejecuta en dev, qa y ppd' }], fix: { kind: 'structure', patch: { splitStep: { step: 'Auto', into: [{ name: 'Auto dev', task: 'Ejecuta en dev' }, { name: 'Auto qa', task: 'Ejecuta en qa' }, { name: 'Auto ppd', task: 'Ejecuta en ppd' }] }, steps: { Cierre: { task: 'Junta los tres resultados' } } }, check: 'cada parte termina en su tiempo' } },
  ] };
  const adv = { findings: [
    { severity: 'improve', category: 'structure', step: 'Extra', claim: 'Extra no aporta nada al flujo', evidence: [{ type: 'def', quote: 'Nada que hacer aquí' }], fix: { kind: 'structure', patch: { removeSteps: ['Extra'] } } },
  ] };
  const pull = cmd('Pull', 'Write-Output "tickets-evidencia-r2"', { id: 's_p2' });
  const auto = role('Auto', 'Ejecuta en dev, qa y ppd [[mock:say ok]]', { id: 's_auto', allowedTools: 'Read Bash(npm test:*)', timeoutSec: 600, bashTimeoutMin: 30 });
  const cierre = role('Cierre', '[[mock:say ok]]', { id: 's_cie' });
  const extra = role('Extra', 'Nada que hacer aquí [[mock:say ok]]', { id: 's_ext' });
  const f = await s.flow('Revisión 2', [pull, auto, cierre, extra], [['s_p2', 's_auto'], ['s_auto', 's_cie'], ['s_cie', 's_ext']], { cwd: repo, description: 'R2' });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  await s.waitRun(f.id, runId);
  // the investigator: two real facts (a file of the evidence, a git output) and an invented one
  const inv = { facts: [
    { claim: 'Pull devolvió los tickets de prueba', step: 'Pull', evidence: [{ type: 'file', path: `${runId}/Pull.md`, quote: 'tickets-evidencia-r2' }] },
    { claim: 'El arreglo ya está en otra rama', evidence: [{ type: 'git', repo, args: ['log', '--all', '--oneline'], quote: 'Arreglo el texto de Line History' }] },
    { claim: 'Hecho inventado por el modelo', evidence: [{ type: 'file', path: `${runId}/Pull.md`, quote: 'esto no aparece en ningún archivo' }, { type: 'file', path: '../../../Windows/win.ini', quote: 'for 16-bit app support' }] },
  ], openQuestions: ['qué build tiene cada ambiente'] };
  cons.findings[0].evidence.push({ type: 'fact', quote: 'El arreglo ya está en otra rama' });
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...(await s.getFlow(f.id)), description: `R2 [[mock:review-inv ${JSON.stringify(inv)}]] [[mock:review-cons ${JSON.stringify(cons)}]] [[mock:review-adv ${JSON.stringify(adv)}]]` });

  const n0 = s.calls().length;
  const { reviewId } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  const rv = await until(async () => { const r = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${reviewId}`); return r.status !== 'running' ? r : null; }, 20000);
  assert.equal(rv.status, 'done');
  // only the verified facts reach the reviewers; the invented one (and a path outside the allowed folders) does not
  assert.deepEqual(rv.facts.map((x) => x.claim), ['Pull devolvió los tickets de prueba', 'El arreglo ya está en otra rama']);
  assert.ok(rv.notVerifiable.some((x) => /Hecho inventado/.test(x)));
  assert.ok(rv.notVerifiable.includes('qué build tiene cada ambiente'));
  const reviewers = s.callsSince(n0).filter((c) => /Revisión de flujo — rol/.test(c.system));
  assert.equal(reviewers.length, 2);
  for (const c of reviewers) { assert.match(c.prompt, /Hechos investigados[\s\S]*F2\. El arreglo ya está en otra rama/); assert.doesNotMatch(c.prompt, /F3\./); }
  assert.ok(rv.findings.find((x) => x.category === 'timeout').evidence.some((e) => e.type === 'fact' && e.verified), 'un hecho verificado es evidencia');
  assert.ok(s.callsSince(n0).some((c) => /Revisión de flujo — investigador/.test(c.system) && s.argOf(c, '--tools') === 'Read,Grep,Glob,Bash'));
  const call = s.callsSince(n0).find((c) => /Revisión de flujo — rol/.test(c.system));
  assert.equal(s.argOf(call, '--tools'), 'Read,Grep,Glob,Bash');
  assert.match(s.argOf(call, '--allowedTools'), /^Read,Grep,Glob,Bash\(node [^)]*review-git\.mjs:\*\)$/, 'Bash solo para el helper de solo lectura');
  assert.match(call.prompt, /INDICE\.md/);
  assert.match(call.prompt, /Cómo investigar/);
  const index = fs.readFileSync(path.join(call.cwd, 'INDICE.md'), 'utf8');
  assert.match(index, new RegExp(runId));
  const pullFile = fs.readdirSync(path.join(call.cwd, runId)).find((x) => /Pull/.test(x));
  assert.match(fs.readFileSync(path.join(call.cwd, runId, pullFile), 'utf8'), /tickets-evidencia-r2/, 'la salida completa está en la evidencia');

  const out = await s.uiOk('POST', `/api/flows/${f.id}/reviews/${reviewId}/apply-safe`, {});
  assert.equal(out.applied.length, 1);
  assert.ok(out.skipped.some((x) => /quita el step «Extra»/.test(x.why)), JSON.stringify(out.skipped));
  assert.match(out.version.label, /Antes de aplicar la revisión/);
  let g = await s.getFlow(f.id);
  const by = (n) => g.steps.find((x) => x.name === n);
  assert.equal(by('Auto dev').id, 's_auto', 'la parte 1 conserva el id (memoria, chat)');
  for (const n of ['Auto qa', 'Auto ppd']) {
    assert.equal(by(n).allowedTools, 'Read Bash(npm test:*)');
    assert.equal(by(n).timeoutSec, 600);
    assert.equal(by(n).bashTimeoutMin, 30);
  }
  const edge = (a, b) => g.edges.some((e) => e.source === by(a).id && e.target === by(b).id);
  assert.ok(edge('Pull', 'Auto dev') && edge('Auto dev', 'Auto qa') && edge('Auto qa', 'Auto ppd') && edge('Auto ppd', 'Cierre') && !edge('Auto dev', 'Cierre'), 'Pull → dev → qa → ppd → Cierre');
  assert.equal(by('Cierre').task, 'Junta los tres resultados');
  // each part keeps the original instructions under its own scope (never a one-line task that drops them)
  for (const [n, scope] of [['Auto dev', 'Ejecuta en dev'], ['Auto qa', 'Ejecuta en qa'], ['Auto ppd', 'Ejecuta en ppd']]) {
    assert.ok(by(n).task.startsWith(scope), n);
    assert.match(by(n).task, /Instrucciones del step original «Auto»[\s\S]*Ejecuta en dev, qa y ppd \[\[mock:say ok\]\]/, n);
  }

  // the destructive one, confirmed apart: Extra goes and nothing points to it
  const msg = (await s.uiOk('GET', `/api/flows/${f.id}/chat/_review`)).find((m) => m.reviewId === reviewId);
  const rm = msg.proposals.find((p) => !p.applied);
  const r0 = await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: msg.id, proposalId: rm.id });
  assert.equal(r0.body.code, 'WIDEN_CONFIRM');
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: msg.id, proposalId: rm.id, confirmWiden: rm.widens });
  g = await s.getFlow(f.id);
  assert.ok(!by('Extra') && !g.edges.some((e) => e.target === 's_ext' || e.source === 's_ext'));

  // the '_review' chat investigates too
  const n1 = s.calls().length;
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review`, { message: '[[mock:propose-structure {"addEdges":[{"from":"Cierre","to":"Pull"}],"steps":{"Pull":{"name":"Pull cambiado"}}}]]' });
  const m2 = await lastAnswer(f.id, '_review');
  const chatCall = s.callsSince(n1).find((c) => /Chat de revisión/.test(c.system || '') || /Cómo investigar/.test(c.prompt));
  assert.match(s.argOf(chatCall, '--allowedTools'), /review-git\.mjs/);
  // a structure change that makes a cycle is rejected whole, nothing saved
  const r = await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m2.id, proposalId: m2.proposals[0].id, confirmWiden: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ciclo/);
  assert.ok((await s.getFlow(f.id)).steps.some((x) => x.name === 'Pull'), 'todo o nada');
});

test('una propuesta que reemplaza instrucciones largas por un texto corto no es "segura": se confirma aparte', async () => {
  const long = `Procedimiento del PR: ${'revisa el diff, haz push, escribe la descripción, abre el PR. '.repeat(10)}`;
  const f = await s.flow('Instrucciones', [role('Cierre', long, { id: 's_ci' })], []);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/_review`, { message: '[[mock:propose-flow {"steps":{"Cierre":{"task":"Solo abre el PR si es verde."}}}]]' });
  const m = await lastAnswer(f.id, '_review');
  assert.ok(m.proposals[0].widens?.some((w) => /reemplaza la tarea por un texto más corto .*se perderían instrucciones/.test(w)), JSON.stringify(m.proposals[0]));
  const r = await s.ui('POST', `/api/flows/${f.id}/chat/_review/apply`, { messageId: m.id, proposalId: m.proposals[0].id });
  assert.equal(r.body.code, 'WIDEN_CONFIRM');
  assert.equal((await s.getFlow(f.id)).steps[0].task, long);
});

test('un revisor que devuelve JSON roto: un reintento lo repara (no se pierde su revisión)', async () => {
  const f = await s.flow('JSON roto', [role('A', '[[mock:say ok]]', { id: 's_j' })], [], { description: 'X [[mock:review-broken-json]]' });
  const { reviewId } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  const rv = await until(async () => { const r = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${reviewId}`); return r.status !== 'running' ? r : null; }, 20000);
  assert.equal(rv.roles.constructive.ok, true);
  assert.ok(rv.notVerifiable.includes('reparado'));
});

test('búsqueda determinística: los textos que esperaban las aserciones fallidas se buscan en git (-S) y se dice en qué rama está el arreglo', async () => {
  const repo = path.join(s.dirs.work, `repo-s-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'ui.txt'), 'Limit per bet: 100'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'fix/limit-texts'); fs.writeFileSync(path.join(repo, 'ui.txt'), 'Bet limit: 100'); git('commit', '-qam', 'Update set-limit texts');
  git('checkout', '-q', 'main');
  const auto = cmd('Auto', `Write-Output "1) AssertionError: limit text: expected 'Limit per bet: 100' to equal 'Bet limit: 100'"`, { id: 's_sx' });
  const f = await s.flow('Revisión -S', [auto], [], { cwd: repo, description: 'S' });
  const { runId } = await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '', breakpoints: false });
  await s.waitRun(f.id, runId);
  await s.uiOk('PUT', `/api/flows/${f.id}`, { ...(await s.getFlow(f.id)), description: `S [[mock:review-inv ${JSON.stringify({ facts: [] })}]] [[mock:review-cons ${JSON.stringify({ findings: [] })}]] [[mock:review-adv ${JSON.stringify({ findings: [] })}]]` });
  const n0 = s.calls().length;
  const { reviewId } = await s.uiOk('POST', `/api/flows/${f.id}/reviews`, {});
  const rv = await until(async () => { const r = await s.uiOk('GET', `/api/flows/${f.id}/reviews/${reviewId}`); return r.status !== 'running' ? r : null; }, 30000);
  assert.equal(rv.status, 'done');
  assert.deepEqual(rv.gitSearch.texts.slice(0, 2), ['Bet limit: 100', 'Limit per bet: 100'], 'primero el texto esperado');
  const hit = rv.facts.find((x) => /«Bet limit: 100»/.test(x.claim));
  assert.ok(hit, JSON.stringify(rv.facts));
  assert.match(hit.claim, /Update set-limit texts/);
  assert.match(hit.claim, /ramas: fix\/limit-texts/);
  assert.match(hit.claim, /La rama actual NO tiene ese commit/);
  assert.ok(hit.evidence[0].verified && /-S Bet limit: 100/.test(hit.evidence[0].ref));
  const invCall = s.callsSince(n0).find((c) => /Revisión de flujo — investigador/.test(c.system));
  assert.match(invCall.prompt, /Búsqueda en git que ya hizo la app[\s\S]*fix\/limit-texts/);
  const rev = s.callsSince(n0).find((c) => /Revisión de flujo — rol/.test(c.system));
  assert.match(rev.prompt, /Hechos investigados[\s\S]*Bet limit: 100/, 'llega a los revisores como hecho');
});
