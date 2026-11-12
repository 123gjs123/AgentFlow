// Spec 21: 📎 Contexto — consultation sources (documents, folders, web pages, Jira, Confluence) attached to a step or
// to the whole flow. They are NOT pasted into the prompt: the model gets a short index plus the access it needs
// (--add-dir + Read/Grep/Glob, WebFetch, Atlassian read tools) and consults them when its skill/agent/role needs it.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, role, cmd, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let s; let web; let webUrl; let docs; let mdFile; let pdfFile;
const SECRET_LINE = 'CONTENIDO-QUE-NO-DEBE-IR-EN-EL-PROMPT';
before(async () => {
  s = await startServer({ name: 'ctxsrc' }); await s.start();
  docs = path.join(s.dirs.work, 'docs'); fs.mkdirSync(path.join(docs, 'sub'), { recursive: true });
  mdFile = path.join(docs, 'reglas.md'); fs.writeFileSync(mdFile, `# Reglas\n${SECRET_LINE}\n`);
  fs.writeFileSync(path.join(docs, 'sub', 'casos.feature'), 'Feature: x');
  pdfFile = path.join(docs, 'manual.pdf'); fs.writeFileSync(pdfFile, Buffer.from('%PDF-1.4 binario\0\0'));
  web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Guía de apuestas</title></head><body>hola</body></html>'); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webUrl = `http://127.0.0.1:${web.address().port}/guia`;
});
after(async () => { await s?.stop(); web?.close(); });

const lastCall = (n, stepName) => s.callsSince(n).find((c) => c.append.includes(`# Step "${stepName}"`));
const argList = (c, flag) => { const out = []; c.argv.forEach((a, i) => { if (a === flag) { for (let j = i + 1; j < c.argv.length && !c.argv[j].startsWith('--'); j++) out.push(c.argv[j]); } }); return out; };

test('las fuentes NO van en el prompt: el modelo recibe un índice corto + acceso (add-dir, Read/Grep/Glob, WebFetch, Atlassian)', async () => {
  const st = role('Analista', '[[mock:say listo]]', {
    id: 's_an', allowedTools: 'Read',
    contextSources: [
      { id: 'c1', type: 'file', path: mdFile, label: 'Reglas de negocio', note: 'reglas para validar apuestas' },
      { id: 'c2', type: 'folder', path: docs },
      { id: 'c3', type: 'url', url: webUrl, label: 'Guía' },
      { id: 'c4', type: 'jira', ref: 'SBK-10', children: true, label: 'Iniciativa' },
      { id: 'c5', type: 'confluence', ref: '123456', label: 'Página' },
      { id: 'c6', type: 'file', path: pdfFile },
    ],
  });
  const f = await s.flow('Contexto', [st]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_an.status, 'success', run.steps.s_an.error);
  const c = lastCall(n, 'Analista');
  assert.match(c.append, /## Fuentes de consulta disponibles/);
  assert.match(c.append, /📄 Reglas de negocio: archivo .*reglas\.md \(md, \d+ bytes\) — ábrelo con Read si lo necesitas — reglas para validar apuestas/);
  assert.match(c.append, /📁 .*docs: carpeta .*docs \(3 archivos\) — explórala con Glob\/Grep/);
  assert.match(c.append, /🌐 Guía: http:\/\/127\.0\.0\.1:\d+\/guia — consúltala con WebFetch/);
  assert.match(c.append, /🎫 Iniciativa: Jira SBK-10 y sus hijos \(iniciativa\/épica: JQL `parent in \(SBK-10\)`\)/);
  assert.match(c.append, /📘 Página: Confluence página id 123456/);
  assert.ok(!c.append.includes(SECRET_LINE) && !c.prompt.includes(SECRET_LINE), 'el contenido no se mete en el prompt');
  const dirs = argList(c, '--add-dir').map((d) => path.resolve(d));
  assert.ok(dirs.includes(path.resolve(docs)), JSON.stringify(dirs));
  const tools = s.argOf(c, '--tools').split(',');
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch']) assert.ok(tools.includes(t), `--tools ${t}`);
  const allowed = s.argOf(c, '--allowedTools');
  for (const t of ['mcp__claude_ai_Atlassian_Rovo__getJiraIssue', 'mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql', 'mcp__claude_ai_Atlassian_Rovo__getConfluencePage', 'WebFetch']) assert.ok(allowed.includes(t), `--allowedTools ${t}`);
  assert.ok(run.steps.s_an.events.some((e) => /📎 Fuentes de consulta disponibles/.test(e.text || '')));
});

test('contexto del flujo: lo ven todos los steps (marcado "del flujo"); plantillas {{vars}} / {{input}} en las referencias', async () => {
  const a = role('Uno', '[[mock:say a]]', { id: 's_u1' });
  const b = role('Dos', '[[mock:say b]]', { id: 's_u2', contextSources: [{ id: 'x', type: 'file', path: '{{input}}' }] });
  const f = await s.flow('Contexto flujo', [a, b], [], { vars: { issue: 'SBK-77' }, contextSources: [{ id: 'f1', type: 'jira', ref: '{{vars.issue}}', label: 'Ticket' }] });
  const n = s.calls().length;
  await s.runUi(f.id, mdFile);
  for (const name of ['Uno', 'Dos']) assert.match(lastCall(n, name).append, /🎫 Ticket: Jira SBK-77 — consúltalo con getJiraIssue.* \(del flujo\)/);
  assert.match(lastCall(n, 'Dos').append, /📄 .*reglas\.md: archivo/);
  assert.ok(!lastCall(n, 'Uno').append.includes('reglas.md'), 'la fuente del step es solo de ese step');
  const ext = await s.runExt(f.id, { vars: { issue: 'SBK-88' }, input: mdFile });
  assert.equal(ext.body.status, 'success');
  assert.ok(s.calls().some((c) => c.append.includes('Jira SBK-88')), 'la variable de la ejecución se usa en la referencia');
});

test('fuente que no existe: aviso en el step y en la vista previa, la ejecución sigue; comandos no se ven afectados', async () => {
  const a = role('Avisa', '[[mock:say ok]]', { id: 's_w', contextSources: [{ id: 'm', type: 'file', path: path.join(s.dirs.work, 'no-existe.md') }] });
  const c = cmd('Cmd', 'Write-Output ok', { id: 's_c', contextSources: [{ id: 'k', type: 'folder', path: docs }] });
  const f = await s.flow('Avisos ctx', [a, c]);
  const run = await s.runUi(f.id);
  assert.equal(run.steps.s_w.status, 'success');
  assert.ok(run.steps.s_w.warnings.some((w) => /no existe/.test(w)));
  assert.equal(run.steps.s_c.status, 'success');
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_w/preview`, {});
  assert.ok(pv.warnings.some((w) => w.code === 'CONTEXT_SOURCE'));
});

test('vista previa = lo enviado (índice de fuentes, --add-dir y tools); el chat del step también las tiene disponibles', async () => {
  const a = role('Consulta', '[[mock:say ok]]', { id: 's_p', contextSources: [{ id: 'd', type: 'folder', path: docs, label: 'Docs' }, { id: 'j', type: 'jira', ref: 'project = SBK AND status = QA' }] });
  const f = await s.flow('Preview ctx', [a]);
  const n = s.calls().length;
  const run = await s.runUi(f.id);
  const sent = lastCall(n, 'Consulta');
  const pv = await s.uiOk('POST', `/api/flows/${f.id}/steps/s_p/preview`, { sample: { runId: run.id } });
  assert.equal(pv.system, sent.append);
  const flags = (argv) => argv.filter((x, i) => !/^--(append-)?system-prompt-file$/.test(argv[i - 1] || '') && !/^--(append-)?system-prompt-file$/.test(x));
  assert.deepEqual(flags(pv.cli.args), flags(sent.argv));
  assert.ok(pv.sections.some((x) => x.id === 'contextSources' && x.toModel === 'system'));
  assert.deepEqual(pv.context.map((x) => x.type), ['folder', 'jira']);
  // step chat
  const m = s.calls().length;
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_p`, { message: 'hola' });
  for (let i = 0; i < 100 && !s.callsSince(m).length; i++) await sleep(100);
  await sleep(300);
  const chat = s.callsSince(m)[0];
  assert.match(chat.prompt, /Contexto adjunto[\s\S]*📁 Docs: carpeta/);
  assert.ok(argList(chat, '--add-dir').map((d) => path.resolve(d)).includes(path.resolve(docs)));
  assert.match(s.argOf(chat, '--allowedTools'), /searchJiraIssuesUsingJql/);
});

test('API de apoyo: comprobar fuentes (✓/✗), explorador de carpetas, subir documento, saneo de fuentes al guardar', async () => {
  const f = await s.flow('Apoyo ctx', [role('X', 'x', { id: 's_x' })]);
  let r = await s.uiOk('POST', '/api/context/check', { flow: f.id, source: { type: 'file', path: mdFile } });
  assert.equal(r.ok, true); assert.match(r.detail, /archivo .*reglas\.md/);
  r = await s.uiOk('POST', '/api/context/check', { flow: f.id, source: { type: 'file', path: 'C:/nada/no.md' } });
  assert.equal(r.ok, false);
  r = await s.uiOk('POST', '/api/context/check', { flow: f.id, source: { type: 'url', url: webUrl } });
  assert.equal(r.ok, true); assert.match(r.detail, /HTTP 200 · “Guía de apuestas”/);
  r = await s.uiOk('POST', '/api/context/check', { flow: f.id, source: { type: 'url', url: 'https://x.atlassian.net/wiki/spaces/A/pages/1' } });
  assert.ok(r.warnings.some((w) => /parece Confluence/.test(w)));
  r = await s.uiOk('POST', '/api/context/check', { flow: f.id, source: { type: 'jira', ref: 'SBK-1' } });
  assert.match(r.detail, /MCP de Atlassian/);
  const ls = await s.uiOk('GET', `/api/fs/list?path=${encodeURIComponent(docs)}`);
  assert.deepEqual(ls.entries.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`), ['d:sub', 'f:manual.pdf', 'f:reglas.md']);
  assert.equal(path.resolve(ls.parent), path.resolve(s.dirs.work));
  assert.equal((await s.ui('GET', `/api/fs/list?path=${encodeURIComponent(path.join(docs, 'zzz'))}`)).status, 404);
  const up = await s.uiOk('POST', `/api/flows/${f.id}/context-files`, { name: 'notas: v1.md', data: Buffer.from('# Notas\nhola').toString('base64') });
  assert.equal(fs.readFileSync(up.path, 'utf8'), '# Notas\nhola');
  assert.ok(!path.basename(up.path).includes(':'));
  const g = await s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, contextSources: [{ type: 'raro', path: 'x' }, { type: 'url', url: webUrl, extra: 1, label: 'L'.repeat(5000) }], steps: [{ ...f.steps[0], contextSources: [{ type: 'jira', ref: 'SBK-1', children: 'sí' }] }] });
  assert.equal(g.contextSources.length, 1);
  assert.equal(g.contextSources[0].extra, undefined);
  assert.equal(g.contextSources[0].label.length, 2000);
  assert.equal(g.steps[0].contextSources[0].children, true);
  assert.ok(g.steps[0].contextSources[0].id);
});

// ---------------- browser ----------------
let ui = {};
const guard = (t) => { if (ui.skipReason) { t.skip(ui.skipReason); return true; } return false; };
afterEach(async (t) => { await captureOnFailure(ui.page, t); });
after(async () => { await ui.close?.(); });

test('UI: la sección 📎 Contexto se ve en Config; agregar carpeta con el explorador y un Jira; ✓ al lado; insignia 📎 en la caja; aparece en "Lo que recibe el modelo"; contexto del flujo', async (t) => {
  ui = await openUi('ctxui');
  if (guard(t)) return;
  const { s: u, page } = ui;
  const folder = path.join(u.dirs.work, 'docs-ui'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'a.md'), '# a');
  const f = await u.flow('Ctx UI', [role('Paso', 'x', { id: 's_ui', position: { x: 120, y: 120 } })], [], { cwd: u.dirs.work });
  await page.goto(`${u.base}/?flow=${f.id}`);
  const nodeLoc = page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Paso' }) });
  await nodeLoc.click();
  const box = page.locator('[data-testid="step-context"]');
  await box.getByText('📎 Contexto').waitFor();
  await box.getByText('No se meten en el prompt').waitFor();
  await box.getByRole('button', { name: '+ 📁 Carpeta' }).click();
  await box.getByRole('button', { name: 'Explorar…' }).click();
  await page.getByRole('button', { name: '📁 docs-ui' }).click();
  await page.getByRole('button', { name: /^Usar esta carpeta/ }).click();
  await box.locator('.ok-text', { hasText: '✓' }).waitFor();
  await box.getByRole('button', { name: '+ 🎫 Jira' }).click();
  await box.locator('.src-item[data-type="jira"] .src-ref').fill('SBK-5');
  await box.locator('.src-item[data-type="jira"]').getByText('incluir hijos').click();
  await nodeLoc.locator('.node-badges', { hasText: '📎 2' }).waitFor();
  let g;
  for (let i = 0; i < 40; i++) { g = await u.getFlow(f.id); if (g.steps[0].contextSources?.length === 2 && g.steps[0].contextSources[1].children) break; await sleep(150); }
  assert.equal(path.resolve(g.steps[0].contextSources[0].path), path.resolve(folder));
  assert.deepEqual({ type: g.steps[0].contextSources[1].type, ref: g.steps[0].contextSources[1].ref, children: g.steps[0].contextSources[1].children }, { type: 'jira', ref: 'SBK-5', children: true });
  // the preview box shows the index section
  await page.getByText('👁 Lo que recibe el modelo').first().click();
  await page.getByText(/Fuentes de consulta disponibles \(2\)/).first().waitFor();
  // flow-level context
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.locator('.tabs button', { hasText: 'Flujo' }).first().click();
  const fbox = page.locator('[data-testid="flow-context"]');
  await fbox.getByRole('button', { name: '+ 🌐 Página web' }).click();
  await fbox.locator('.src-ref').fill(webUrl);
  await fbox.locator('.ok-text', { hasText: 'Guía de apuestas' }).waitFor();
  for (let i = 0; i < 40 && !(await u.getFlow(f.id)).contextSources?.length; i++) await sleep(150);
  assert.equal((await u.getFlow(f.id)).contextSources[0].url, webUrl);
  assert.deepEqual(page.errors, []);
});
