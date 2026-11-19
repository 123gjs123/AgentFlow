// Spec 13 (complete): updates of installed skills in the 🔔 model (git head / ETag / hash; background without
// credential prompts; stale results dropped; attention item), bundles that carry a reference to the https origin,
// the explicit corporate proxy (HTTPS_PROXY / NO_PROXY, CONNECT to the checked address, TLS still verified) and the
// management of user skills installed by the app. Offline: local repo through insteadOf, local HTTPS + CONNECT proxy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, skill, cmd, ROOT, sleep } from './helpers/harness.mjs';
import { buildZip } from '../../server/unzip.js';

const TLS = path.join(ROOT, 'test', 'e2e', 'fixtures', 'tls');
const md = (name, description = `Skill ${name}`, body = `Instrucciones de ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe', encoding: 'utf8' });
const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };
let s; let pre; let work; let bare; let web; let webBase; let hits = { full: 0, cond: 0, zip: 0 }; let zipVersion = 1; let delayMs = 0;
const zipOf = (v) => buildZip([{ name: 'z/SKILL.md', data: md('zipada', `Versión ${v}`) }]);

before(async () => {
  pre = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'afs-sku-'));
  work = path.join(pre, 'work'); fs.mkdirSync(path.join(work, 'skills', 'gita'), { recursive: true });
  fs.writeFileSync(path.join(work, 'skills', 'gita', 'SKILL.md'), md('gita', 'Git v1'));
  fs.writeFileSync(path.join(work, 'README.md'), 'v1\n');
  g(work, 'init', '-q'); g(work, 'add', '-A'); g(work, 'commit', '-qm', 'v1');
  bare = path.join(pre, 'repos', 'acme', 'skills.git'); fs.mkdirSync(path.dirname(bare), { recursive: true });
  g(pre, 'clone', '-q', '--bare', work, bare);
  const key = fs.readFileSync(path.join(TLS, 'localhost.key')); const cert = fs.readFileSync(path.join(TLS, 'localhost.crt'));
  web = https.createServer({ key, cert }, async (req, res) => {
    if (delayMs) await sleep(delayMs);
    if (req.url === '/z.zip') {
      hits.zip++;
      const etag = `"v${zipVersion}"`;
      if (req.headers['if-none-match'] === etag) { hits.cond++; res.writeHead(304, { ETag: etag }); return res.end(); }
      hits.full++; res.writeHead(200, { 'Content-Type': 'application/zip', ETag: etag }); return res.end(zipOf(zipVersion));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webBase = `https://127.0.0.1:${web.address().port}`;
  const reposUrl = `file:///${path.join(pre, 'repos').replace(/\\/g, '/').replace(/^\/+/, '')}/`;
  s = await startServer({ name: 'skill-upd', env: {
    NODE_EXTRA_CA_CERTS: path.join(TLS, 'localhost.crt'), AFS_SKILLS_ALLOW_LOOPBACK: '1', AFS_SKILLS_ALLOW_FILE_GIT: '1', AFS_SKILL_UPDATES: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${reposUrl}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/',
  } });
  await s.start();
});
after(async () => { await s?.stop(); web?.close(); if (pre) fs.rmSync(pre, { recursive: true, force: true }); });
const inspect = (srv, body) => srv.ui('POST', '/api/skills/inspect', body);
const installFlow = async (srv, flowId, body) => srv.uiOk('POST', '/api/skills/install', { token: (await inspect(srv, body)).body.token, scope: 'flow', flowId });
const check = (srv, flowId, extra = {}) => srv.uiOk('POST', `/api/flows/${flowId}/skills/check-updates`, extra);
const push = (file, text, msg) => { fs.writeFileSync(path.join(work, file), text); g(work, 'add', '-A'); g(work, 'commit', '-qm', msg); g(work, 'push', '-q', bare, 'HEAD:main'); };

test('git: un commit fuera de la skill no es actualización (y no se vuelve a clonar); uno dentro sí → 🔔 aviso; instalarla lo limpia', async () => {
  const f = await s.flow('Upd git', [skill('Usa gita', 'gita', 'x', { id: 's_g' })], []);
  await installFlow(s, f.id, { url: 'https://github.com/acme/skills/tree/main/skills/gita' });
  let r = await check(s, f.id);
  assert.equal(r.flow.gita.available, false);
  push('README.md', 'v2\n', 'readme');
  r = await check(s, f.id);
  assert.equal(r.flow.gita.available, false, 'el head se movió pero la skill no cambió');
  push('skills/gita/SKILL.md', md('gita', 'Git v2'), 'skill v2');
  r = await check(s, f.id);
  assert.equal(r.flow.gita.available, true);
  const att = await until(async () => (await s.uiOk('GET', '/api/attention')).items.find((i) => i.id === `skillupd:${f.id}`));
  assert.ok(att, 'aviso en la bandeja'); assert.match(att.title, /1 skill con actualización/); assert.equal(att.target.stepId, 's_g');
  // the update: diff + files, then replace → flag gone, attention gone
  const u = await s.uiOk('POST', `/api/skills/gita/update?scope=flow&flowId=${f.id}`, {});
  assert.equal(u.changed, true); assert.match(u.current, /Git v2/);
  await s.uiOk('POST', '/api/skills/install', { token: u.token, names: ['gita'], scope: 'flow', flowId: f.id, resolve: { gita: { action: 'replace' } } });
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/skills/updates`)).flow.gita?.available ?? false, false);
  assert.ok(await until(async () => !(await s.uiOk('GET', '/api/attention')).items.some((i) => i.id === `skillupd:${f.id}`)), 'el aviso se fue');
});

test('zip por URL: la segunda revisión usa ETag (304, sin descarga completa); una versión nueva se detecta', async () => {
  const f = await s.flow('Upd zip', [], []);
  zipVersion = 1; hits = { full: 0, cond: 0, zip: 0 };
  await installFlow(s, f.id, { url: `${webBase}/z.zip` });
  await check(s, f.id); // first check: full GET, stores the ETag
  const full = hits.full;
  const r = await check(s, f.id);
  assert.equal(hits.full, full, 'sin descarga completa'); assert.ok(hits.cond >= 1, '304'); assert.equal(r.flow.zipada.available, false);
  zipVersion = 2;
  assert.equal((await check(s, f.id)).flow.zipada.available, true);
});

test('carrera: si se instala mientras se revisa, el resultado viejo se descarta; una revisión en segundo plano no le quita la suya a la persona', async () => {
  const f = await s.flow('Upd carrera', [], []);
  zipVersion = 3;
  await installFlow(s, f.id, { url: `${webBase}/z.zip` });
  zipVersion = 4;
  const open = await inspect(s, { zipBase64: buildZip([{ name: 'o/SKILL.md', data: md('abierta') }]).toString('base64') }); // a person's review
  delayMs = 1500;
  const pending = check(s, f.id);
  await sleep(300);
  // meanwhile the person installs version 4 by hand (another review: the source answers after the delay too)
  const v4 = await inspect(s, { url: `${webBase}/z.zip` });
  delayMs = 0;
  await s.uiOk('POST', '/api/skills/install', { token: v4.body.token, scope: 'flow', flowId: f.id, resolve: { zipada: { action: 'replace' } } });
  await pending;
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/skills/updates`)).flow.zipada?.available ?? false, false, 'sin aviso falso');
  for (let i = 0; i < 3; i++) await check(s, f.id);
  assert.equal((await s.ui('POST', '/api/skills/install', { token: open.body.token, scope: 'flow', flowId: f.id })).status, 200, 'su revisión sigue viva');
});

test('paquete: el origen https viaja (las rutas locales no); "solo la URL" → el import ofrece traerla y compara con lo exportado; la instalada sigue actualizable', async () => {
  const f = await s.flow('Upd paquete', [], []);
  await installFlow(s, f.id, { url: 'https://github.com/acme/skills/tree/main/skills/gita' });
  const src = path.join(pre, 'local'); fs.mkdirSync(path.join(src, 'local-sk'), { recursive: true }); fs.writeFileSync(path.join(src, 'local-sk', 'SKILL.md'), md('local-sk'));
  await installFlow(s, f.id, { path: src });
  const emb = await s.uiOk('GET', `/api/flows/${f.id}/export`);
  assert.ok(!JSON.stringify(emb.skills).includes(src.replace(/\\/g, '\\\\')) && !JSON.stringify(emb.skills).includes(pre.replace(/\\/g, '\\\\')), 'ninguna ruta de esta PC viaja');
  assert.equal(emb.skills.find((x) => x.name === 'gita').origin.type, 'url');
  // embedded → installed → keeps its https origin → can be checked
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle: emb });
  assert.equal(imp.skillReview.skills.find((x) => x.name === 'gita').importedFrom, 'https://github.com/acme/skills/tree/main/skills/gita');
  await s.uiOk('POST', '/api/skills/install', { token: imp.skillReview.token, scope: 'flow', flowId: imp.flow.id });
  assert.ok('gita' in (await check(s, imp.flow.id)).flow);
  assert.equal((await check(s, imp.flow.id)).flow['local-sk'].unsupported, true, 'sin origen https: no se revisa');
  // reference mode
  const ref = await s.uiOk('GET', `/api/flows/${f.id}/export?skills=ref`);
  const gr = ref.skills.find((x) => x.name === 'gita');
  assert.equal(gr.reference, true); assert.ok(!gr.files); assert.match(gr.origin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(ref.skills.find((x) => x.name === 'local-sk').files, 'sin URL: viaja con sus archivos');
  const imp2 = await s.uiOk('POST', '/api/flows/import', { bundle: ref });
  const ne = imp2.skillReview.notEmbedded.find((x) => x.name === 'gita');
  assert.equal(ne.fetchable, true); assert.equal(ne.source, 'https://github.com/acme/skills/tree/main/skills/gita');
  const fetched = await inspect(s, { url: ne.source });
  assert.ok(fetched.body.skills.some((x) => x.sha256), 'la revisión trae el hash para comparar con el exportado');
  // a crafted bundle origin pointing at a local path is dropped
  const evil = { ...emb, skills: [{ ...emb.skills.find((x) => x.name === 'local-sk'), origin: { type: 'folder', source: 'C:\\Users\\x' } }, { name: 'ref-local', reference: true, origin: { type: 'folder', source: 'C:\\Windows' } }] };
  const imp3 = await s.uiOk('POST', '/api/flows/import', { bundle: evil });
  assert.equal(imp3.skillReview.notEmbedded.find((x) => x.name === 'ref-local').fetchable, false);
  await s.uiOk('POST', '/api/skills/install', { token: imp3.skillReview.token, scope: 'flow', flowId: imp3.flow.id });
  assert.equal((await s.ui('POST', `/api/skills/local-sk/update?scope=flow&flowId=${imp3.flow.id}`, {})).body.code, 'NO_UPDATE_SOURCE');
});

test('skills de "Mi Claude Code" instaladas por la app: el catálogo las marca, se actualizan (confirmando) y se quitan; una skill de flujo con el mismo nombre no bloquea la actualización', async () => {
  const z = (v) => buildZip([{ name: 'u/SKILL.md', data: md('mia-global', `Global ${v}`) }]).toString('base64');
  await s.uiOk('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(1) })).body.token, scope: 'user', confirmUser: true });
  const f = await s.flow('Upd user', [], []);
  const cat = (await s.uiOk('GET', `/api/catalog?flow=${f.id}`)).skills;
  assert.equal(cat.find((x) => x.name === 'mia-global').managed, true);
  assert.ok(!cat.find((x) => x.name === 'qa-test-architect').managed, 'una tuya hecha a mano no');
  // a flow skill with the same name that already coexists (copied by hand into the flow folder)
  const fd = path.join(s.dirs.data, 'flow-skills', f.id, '.claude', 'skills', 'mia-global'); fs.mkdirSync(fd, { recursive: true }); fs.writeFileSync(path.join(fd, 'SKILL.md'), md('mia-global', 'del flujo'));
  const r = await s.uiOk('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(2) })).body.token, scope: 'user', confirmUser: true, resolve: { 'mia-global': { action: 'replace' } } });
  assert.deepEqual(r.shadows, [{ name: 'mia-global', flowId: f.id }]);
  assert.match(fs.readFileSync(path.join(s.dirs.home, '.claude', 'skills', 'mia-global', 'SKILL.md'), 'utf8'), /Global 2/);
  assert.equal((await s.ui('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(3) })).body.token, scope: 'user', confirmUser: true })).status, 409, 'un nombre nuevo sí choca');
  await s.uiOk('DELETE', '/api/skills/mia-global?scope=user&confirm=1');
  assert.ok(!fs.existsSync(path.join(s.dirs.home, '.claude', 'skills', 'mia-global')));
});

test('un flujo ejecutándose no se cambia: reemplazar o quitar su skill espera a que termine', async () => {
  const f = await s.flow('Upd corriendo', [cmd('Lento', 'Start-Sleep -Seconds 6; Write-Output ok', { id: 's_l' })], []);
  const z = (v) => buildZip([{ name: 'r/SKILL.md', data: md('en-uso', `v${v}`) }]).toString('base64');
  await installFlow(s, f.id, { zipBase64: z(1) });
  const run = await s.ext('POST', `/flows/${f.id}/run`, { input: 'x' });
  await until(async () => (await s.ui('GET', `/api/flows/${f.id}/runs`)).body.some?.((x) => x.status === 'running'), 5000);
  const rep = await s.ui('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(2) })).body.token, scope: 'flow', flowId: f.id, resolve: { 'en-uso': { action: 'replace' } } });
  assert.equal(rep.body.code, 'FLOW_RUNNING');
  assert.equal((await s.ui('DELETE', `/api/skills/en-uso?scope=flow&flowId=${f.id}`)).body.code, 'FLOW_RUNNING');
  await s.ext('POST', `/flows/${f.id}/runs/${run.body.runId}/cancel`, {});
});

test('proxy corporativo explícito: CONNECT a la dirección revisada con su credencial; TLS se verifica a través del túnel; NO_PROXY va directo; 407 sin filtrar la credencial; una IP bloqueada ni llega al proxy', async () => {
  const seen = []; let mitm = false;
  const key = fs.readFileSync(path.join(TLS, 'untrusted.key')); const cert = fs.readFileSync(path.join(TLS, 'untrusted.crt'));
  const fake = https.createServer({ key, cert }, (q, r) => { r.writeHead(200); r.end('x'); }); await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const proxy = http.createServer((q, r) => { r.writeHead(400); r.end(); });
  proxy.on('connect', (req, sock) => {
    seen.push({ target: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('u:p').toString('base64')}`) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [h, p] = req.url.replace(/^\[|\](?=:)/g, '').split(/:(?=\d+$)/);
    const up = net.connect(mitm ? fake.address().port : Number(p), mitm ? '127.0.0.1' : h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const P = proxy.address().port;
  const mk = async (name, env) => { const x = await startServer({ name, env: { NODE_EXTRA_CA_CERTS: path.join(TLS, 'localhost.crt'), AFS_SKILL_UPDATES: '0', ...env } }); await x.start(); return x; };
  const sp = await mk('proxy-ok', { AFS_SKILLS_ALLOW_LOOPBACK: '1', HTTPS_PROXY: `http://u:p@127.0.0.1:${P}`, NO_PROXY: 'localhost' });
  const sbad = await mk('proxy-407', { AFS_SKILLS_ALLOW_LOOPBACK: '1', HTTPS_PROXY: `http://u:s3cr3t-proxy@127.0.0.1:${P}` });
  const sblock = await mk('proxy-block', { HTTPS_PROXY: `http://u:p@127.0.0.1:${P}` });
  try {
    zipVersion = 7;
    const port = web.address().port;
    const ok = await inspect(sp, { url: `${webBase}/z.zip` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(seen.at(-1).target, `127.0.0.1:${port}`, 'CONNECT a la IP revisada');
    mitm = true; // a proxy that answers with another certificate
    assert.equal((await inspect(sp, { url: `${webBase}/z.zip` })).body.code, 'TLS_ERROR', 'TLS sigue verificado a través del túnel');
    mitm = false;
    const n = seen.length;
    const direct = await inspect(sp, { url: `https://localhost:${port}/z.zip` });
    assert.equal(direct.status, 200, JSON.stringify(direct.body)); assert.equal(seen.length, n, 'NO_PROXY: directo');
    const auth = await inspect(sbad, { url: `${webBase}/z.zip` });
    assert.equal(auth.body.code, 'PROXY_AUTH'); assert.ok(!JSON.stringify(auth.body).includes('s3cr3t') && !sbad.output.includes('s3cr3t'), 'la credencial del proxy no aparece');
    const m = seen.length;
    assert.equal((await inspect(sblock, { url: `${webBase}/z.zip` })).body.code, 'SOURCE_BLOCKED');
    assert.equal(seen.length, m, 'ni siquiera llega al proxy');
  } finally { await sp.stop(); await sbad.stop(); await sblock.stop(); proxy.close(); fake.close(); }
});

test('segundo plano: una fuente que pide credenciales no abre ventanas, se marca y no se reintenta sola; el programador no revisa flujos en cuarentena', async () => {
  // git over https to a local server that always answers 401 (git trusts the fixture via its own CA config)
  let gitHits = 0;
  const key = fs.readFileSync(path.join(TLS, 'localhost.key')); const cert = fs.readFileSync(path.join(TLS, 'localhost.crt'));
  const gsrv = https.createServer({ key, cert }, (q, r) => { gitHits++; r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); r.end(); });
  await new Promise((r) => gsrv.listen(0, '127.0.0.1', r));
  const sa = await startServer({ name: 'skill-auth', env: { NODE_EXTRA_CA_CERTS: path.join(TLS, 'localhost.crt'), AFS_SKILLS_ALLOW_LOOPBACK: '1', AFS_SKILL_UPDATES: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.sslBackend', GIT_CONFIG_VALUE_0: 'openssl', GIT_CONFIG_KEY_1: 'http.sslCAInfo', GIT_CONFIG_VALUE_1: path.join(TLS, 'localhost.crt') } });
  await sa.start();
  try {
    const f = await sa.flow('Auth', [], []);
    // a managed flow skill whose origin is that private repo (as if installed when the credentials still worked)
    const d = path.join(sa.dirs.data, 'flow-skills', f.id, '.claude', 'skills', 'privada'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), md('privada'));
    fs.writeFileSync(path.join(d, '.afs-origin.json'), JSON.stringify({ type: 'url', kind: 'git', source: `https://127.0.0.1:${gsrv.address().port}/privada.git`, url: `https://127.0.0.1:${gsrv.address().port}/privada.git`, ref: '', subPath: '', head: 'a'.repeat(40), sha256: 'b'.repeat(64), name: 'privada' }));
    const r1 = await sa.uiOk('POST', `/api/flows/${f.id}/skills/check-updates`, { background: true });
    assert.equal(r1.flow.privada.authBlocked, true, JSON.stringify(r1)); assert.match(r1.flow.privada.error, /credenciales/);
    const n = gitHits; assert.ok(n >= 1);
    await sa.uiOk('POST', `/api/flows/${f.id}/skills/check-updates`, { background: true });
    assert.equal(gitHits, n, 'no se reintenta sola');
  } finally { await sa.stop(); gsrv.close(); }
  // the scheduler (fast with AFS_TIME_SCALE): checks a normal flow, never a quarantined one
  const ss = await startServer({ name: 'skill-sched', env: { NODE_EXTRA_CA_CERTS: path.join(TLS, 'localhost.crt'), AFS_SKILLS_ALLOW_LOOPBACK: '1' } });
  await ss.start();
  try {
    const normal = await ss.flow('Normal', [], []);
    zipVersion = 9;
    await installFlow(ss, normal.id, { url: `${webBase}/z.zip` });
    const bundle = await ss.uiOk('GET', `/api/flows/${normal.id}/export`);
    bundle.flow.steps = [{ id: 's_q', name: 'Comando', kind: 'command', shell: 'powershell', command: 'Write-Output hi' }];
    const imp = await ss.uiOk('POST', '/api/flows/import', { bundle });
    assert.ok(imp.quarantine, 'en cuarentena');
    await ss.uiOk('POST', '/api/skills/install', { token: imp.skillReview.token, scope: 'flow', flowId: imp.flow.id });
    await ss.kill(); await ss.start(); // a fresh scheduler: first look ~1 s after boot with this time scale
    const seenNormal = await until(async () => Object.keys((await ss.uiOk('GET', `/api/flows/${normal.id}/skills/updates`)).flow).length > 0, 20000);
    assert.ok(seenNormal, 'el programador revisó el flujo normal');
    assert.deepEqual((await ss.uiOk('GET', `/api/flows/${imp.flow.id}/skills/updates`)).flow, {}, 'el de cuarentena no');
    assert.equal((await ss.ui('POST', `/api/flows/${imp.flow.id}/skills/check-updates`, {})).status, 423);
  } finally { await ss.stop(); }
});

test('UI: ⬆ en el selector cuando su origen tiene una versión nueva; actualizar muestra los archivos y la reemplaza', async (t) => {
  const { openUi } = await import('./helpers/browser.mjs');
  const ui = await openUi('skill-upd-ui');
  try {
    if (ui.skipReason) { t.skip(ui.skipReason); return; }
    const { s: u, page } = ui;
    const src = path.join(pre, 'ui-src'); fs.mkdirSync(path.join(src, 'ui-sk'), { recursive: true }); fs.writeFileSync(path.join(src, 'ui-sk', 'SKILL.md'), md('ui-sk', 'UI v1'));
    const f = await u.flow('Upd UI', [skill('Usa ui-sk', 'ui-sk', 'x', { id: 's_u', position: { x: 120, y: 120 } })], []);
    await u.uiOk('POST', '/api/skills/install', { token: (await u.ui('POST', '/api/skills/inspect', { path: src })).body.token, scope: 'flow', flowId: f.id });
    fs.writeFileSync(path.join(src, 'ui-sk', 'SKILL.md'), md('ui-sk', 'UI v2')); fs.writeFileSync(path.join(src, 'ui-sk', 'nuevo.ps1'), 'Write-Output x');
    await u.uiOk('POST', `/api/flows/${f.id}/skills/check-updates`, {});
    await page.goto(`${u.base}/?flow=${f.id}`);
    await page.locator('.react-flow__node', { has: page.locator('.node-name', { hasText: 'Usa ui-sk' }) }).click();
    const box = page.getByTestId('skill-picker');
    await box.getByTestId('skill-update-badge').waitFor();
    await box.getByRole('button', { name: 'Buscar actualización' }).click();
    await page.getByTestId('skill-update-files').getByText('nuevo.ps1').waitFor();
    await page.getByTestId('skill-diff').getByText(/UI v2/).waitFor();
    await page.getByTestId('skill-update-apply').click();
    await box.getByTestId('skill-msg').getByText('Actualizada').waitFor();
    assert.match(fs.readFileSync(path.join(u.dirs.data, 'flow-skills', f.id, '.claude', 'skills', 'ui-sk', 'SKILL.md'), 'utf8'), /UI v2/);
    assert.deepEqual(page.errors, []);
  } finally { await ui.close?.(); }
});

// ---- adversarial pass on the completion of spec 13 ----
test('revisión 13f: tras el proxy, nombres "localhost" y con punto final se bloquean; un nombre que solo resuelve el proxy no se usa en segundo plano', async () => {
  const proxy = http.createServer(); const seen = [];
  proxy.on('connect', (req, sock) => { seen.push(req.url); const port = Number(req.url.split(':').pop()); const up = net.connect(port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock); sock.pipe(up); }); up.on('error', () => sock.destroy()); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const sp = await startServer({ name: 'proxy-names', env: { NODE_EXTRA_CA_CERTS: path.join(TLS, 'localhost.crt'), AFS_SKILL_UPDATES: '0', HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } });
  await sp.start();
  try {
    const W = web.address().port;
    assert.equal((await inspect(sp, { url: `https://localhost..:${W}/z.zip` })).body.code, 'BAD_SOURCE');
    assert.equal((await inspect(sp, { url: `https://localhost.:${W}/z.zip` })).body.code, 'BAD_SOURCE');
    assert.equal((await inspect(sp, { url: `https://algo.localhost:${W}/z.zip` })).body.code, 'SOURCE_BLOCKED');
    assert.equal(seen.length, 0, 'ni llegan al proxy');
    // a managed skill whose origin only the proxy resolves: a background check does not tunnel it by name
    const f = await sp.flow('Solo proxy', [], []);
    const d = path.join(sp.dirs.data, 'flow-skills', f.id, '.claude', 'skills', 'interna'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), md('interna'));
    fs.writeFileSync(path.join(d, '.afs-origin.json'), JSON.stringify({ type: 'url', kind: 'zip', source: `https://solo-proxy.invalid:${W}/z.zip`, sha256: 'c'.repeat(64), name: 'interna' }));
    const r = await sp.uiOk('POST', `/api/flows/${f.id}/skills/check-updates`, { background: true });
    assert.match(r.flow.interna.error, /solo lo resuelve el proxy/); assert.equal(seen.length, 0);
  } finally { await sp.stop(); proxy.close(); }
});

test('revisión 13f: una revisión en segundo plano no pisa lo que encontró una manual; borrar el flujo durante la revisión no deja estado; el origen de un paquete se normaliza y no se revisa solo hasta una revisión manual', async () => {
  // two zip skills; the second source is slow
  const f = await s.flow('Merge', [], []);
  zipVersion = 20; await installFlow(s, f.id, { url: `${webBase}/z.zip` });
  await check(s, f.id, { background: true }); // zipada checked now → throttled in the next background check
  const slowZip = buildZip([{ name: 'l/SKILL.md', data: md('lenta', 'v1') }]);
  const slow = https.createServer({ key: fs.readFileSync(path.join(TLS, 'localhost.key')), cert: fs.readFileSync(path.join(TLS, 'localhost.crt')) }, async (q, res) => { if (slow.delay) await sleep(slow.delay); res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(slowZip); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    await installFlow(s, f.id, { url: `https://127.0.0.1:${slow.address().port}/l.zip` });
    slow.delay = 2500;
    const bg = check(s, f.id, { background: true });
    await sleep(300);
    zipVersion = 21;
    const manual = await s.uiOk('POST', `/api/skills/zipada/update?scope=flow&flowId=${f.id}`, {});
    assert.equal(manual.changed, true);
    await bg;
    assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/skills/updates`)).flow.zipada.available, true, 'lo manual se conserva');
    // deleting the flow while a check is running leaves no state file behind
    const g2 = await s.flow('Borrar', [], []);
    await installFlow(s, g2.id, { url: `https://127.0.0.1:${slow.address().port}/l.zip` });
    const running = check(s, g2.id);
    await sleep(300);
    await s.uiOk('DELETE', `/api/flows/${g2.id}`);
    await running.catch(() => {});
    assert.ok(!fs.existsSync(path.join(s.dirs.data, 'skill-updates', `${g2.id}.json`)));
  } finally { slow.close(); }
  // a crafted bundle origin: kind/url/head come from parsing its source; background waits for a manual check
  const src = await s.flow('Origen', [], []);
  zipVersion = 22; await installFlow(s, src.id, { url: `${webBase}/z.zip` });
  const bundle = await s.uiOk('GET', `/api/flows/${src.id}/export`);
  bundle.skills[0].origin = { ...bundle.skills[0].origin, kind: 'git', url: 'https://otro.example/', head: 'z'.repeat(40), ref: 'a'.repeat(40) };
  const imp = await s.uiOk('POST', '/api/flows/import', { bundle });
  await s.uiOk('POST', '/api/skills/install', { token: imp.skillReview.token, scope: 'flow', flowId: imp.flow.id });
  const o = JSON.parse(fs.readFileSync(path.join(s.dirs.data, 'flow-skills', imp.flow.id, '.claude', 'skills', 'zipada', '.afs-origin.json'), 'utf8'));
  assert.equal(o.importedFrom.kind, 'zip'); assert.equal(o.importedFrom.url, `${webBase}/z.zip`); assert.ok(!o.importedFrom.head); assert.equal(o.importedFrom.ref, '');
  const before = hits.zip;
  assert.deepEqual((await check(s, imp.flow.id, { background: true })).flow, {}, 'en segundo plano espera a una revisión manual');
  assert.equal(hits.zip, before);
  await s.uiOk('POST', `/api/skills/zipada/update?scope=flow&flowId=${imp.flow.id}`, {});
  assert.ok((await s.uiOk('GET', `/api/flows/${imp.flow.id}/skills/updates`)).flow.zipada, 'tras la manual, sí');
});

test('revisión 13f: una skill de tu Claude Code que usa un flujo en ejecución no se reemplaza ni se quita bajo sus pies', async () => {
  const z = (v) => buildZip([{ name: 'g/SKILL.md', data: md('glob-en-uso', `v${v}`) }]).toString('base64');
  await s.uiOk('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(1) })).body.token, scope: 'user', confirmUser: true });
  const f = await s.flow('Usa global', [cmd('Lento', 'Start-Sleep -Seconds 6; Write-Output ok', { id: 's_w' }), skill('Global', 'glob-en-uso', 'x', { id: 's_k' })], [['s_w', 's_k']]);
  const run = await s.ext('POST', `/flows/${f.id}/run`, { input: 'x' });
  await until(async () => (await s.ui('GET', `/api/flows/${f.id}/runs`)).body.some?.((x) => x.status === 'running'), 5000);
  try {
    const rep = await s.ui('POST', '/api/skills/install', { token: (await inspect(s, { zipBase64: z(2) })).body.token, scope: 'user', confirmUser: true, resolve: { 'glob-en-uso': { action: 'replace' } } });
    assert.equal(rep.body.code, 'FLOW_RUNNING');
    assert.equal((await s.ui('DELETE', '/api/skills/glob-en-uso?scope=user&confirm=1')).body.code, 'FLOW_RUNNING');
  } finally { await s.ext('POST', `/flows/${f.id}/runs/${run.body.runId}/cancel`, {}); }
});
