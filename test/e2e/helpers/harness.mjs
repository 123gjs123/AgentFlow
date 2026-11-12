// E2E harness: starts an isolated Agent Flow Studio (temp data dir, temp HOME with its own skills/agents,
// mock Claude CLI, free port) and offers clients for every way in: UI API, external API, WebSocket, afs CLI, MCP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MOCK = path.join(ROOT, 'test', 'e2e', 'mocks', 'claude-mock.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

/** Writes a skill / agent definition into a .claude dir (user HOME or a project). */
export function writeSkill(claudeDir, name, description = `Skill ${name} de prueba`) {
  const d = path.join(claudeDir, 'skills', name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nInstrucciones de prueba de la skill ${name}.\n`);
}
export function writeAgent(claudeDir, name, description = `Agente ${name} de prueba`) {
  const d = path.join(claudeDir, 'agents'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep\n---\n\nEres ${name}, un agente de prueba.\n`);
}

export async function startServer({ env = {}, name = 'e2e' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `afs-${name}-`));
  const dirs = { data: path.join(tmp, 'data'), home: path.join(tmp, 'home'), project: path.join(tmp, 'project'), state: path.join(tmp, 'mock-state'), work: path.join(tmp, 'work') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  writeSkill(path.join(dirs.home, '.claude'), 'qa-test-architect', 'Diseño de pruebas por riesgo');
  writeAgent(path.join(dirs.home, '.claude'), 'reviewer', 'Revisor de código');
  writeSkill(path.join(dirs.project, '.claude'), 'project-skill', 'Skill del proyecto');
  writeAgent(path.join(dirs.project, '.claude'), 'project-agent', 'Agente del proyecto');
  const mockLog = path.join(tmp, 'claude-calls.jsonl');
  const port = await freePort();
  const prod = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
  const fullEnv = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', AFS_DATA: dirs.data, CLAUDE_BIN: MOCK, AFS_MOCK_LOG: mockLog, AFS_MOCK_STATE: dirs.state,
    AFS_TIME_SCALE: '0.01', USERPROFILE: dirs.home, HOME: dirs.home, NODE_ENV: prod ? 'production' : 'development', ...env,
  };
  const base = `http://127.0.0.1:${port}`;
  const srv = { base, port, tmp, dirs, mockLog, env: fullEnv, proc: null, output: '' };

  srv.start = async () => {
    srv.proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: fullEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.proc.stdout.on('data', (d) => { srv.output += d; });
    srv.proc.stderr.on('data', (d) => { srv.output += d; });
    for (let i = 0; i < 120; i++) {
      if (srv.proc.exitCode !== null) throw new Error(`El servidor terminó al arrancar:\n${srv.output}`);
      try { const r = await fetch(base + '/api/ext/ping'); if (r.status === 401) break; } catch {}
      await sleep(250);
    }
    srv.uiKey = JSON.parse(fs.readFileSync(path.join(dirs.data, 'config.json'), 'utf8')).uiKey; // UI access key
    srv.token = (await srv.ui('GET', '/api/info')).body.token;
    return srv;
  };
  /** Hard kill (simulates a crash): no cleanup runs in the server. */
  srv.kill = async () => {
    if (!srv.proc || srv.proc.exitCode !== null) return;
    const p = srv.proc;
    const done = new Promise((r) => p.once('exit', r));
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else p.kill('SIGKILL');
    await done;
  };
  srv.stop = async ({ keep = !!process.env.AFS_E2E_KEEP } = {}) => {
    await srv.kill();
    for (const ws of srv.sockets || []) try { ws.terminate(); } catch {}
    if (!keep) { await sleep(200); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  };

  // ---------- UI API (loopback, JSON) ----------
  srv.ui = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(srv.uiKey ? { 'X-AFS-UI': srv.uiKey } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, body: json ?? text, headers: r.headers };
  };
  srv.uiOk = async (method, url, body) => { const r = await srv.ui(method, url, body); if (r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

  // ---------- external API (token) ----------
  srv.ext = async (method, url, body, headers = {}, { auth = true } = {}) => {
    const h = { ...(auth ? { Authorization: `Bearer ${srv.token}` } : {}), ...headers };
    let payload;
    if (body !== undefined) { if (typeof body === 'string' && !h['Content-Type']) h['Content-Type'] = 'text/plain'; else if (!h['Content-Type']) h['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const r = await fetch(base + '/api/ext' + url, { method, headers: h, body: payload });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, body: json ?? text };
  };

  // ---------- flows ----------
  /** Creates a flow with steps/edges. Steps: {id,name,kind,...}. edges: [[from,to]] by id. */
  srv.flow = async (name, steps = [], edges = [], extra = {}) => {
    const f = await srv.uiOk('POST', '/api/flows', { name });
    return srv.uiOk('PUT', `/api/flows/${f.id}`, { ...f, ...extra, steps, edges: edges.map(([source, target], i) => ({ id: `e_${i}`, source, target })) });
  };
  srv.getFlow = (id) => srv.uiOk('GET', `/api/flows/${id}`);
  /** UI run → waits for the end → stored run. */
  srv.runUi = async (flowId, input = '', { stepId, timeoutMs = 60000 } = {}) => {
    const { runId } = await srv.uiOk('POST', stepId ? `/api/flows/${flowId}/steps/${stepId}/run` : `/api/flows/${flowId}/run`, { input });
    return srv.waitRun(flowId, runId, timeoutMs);
  };
  srv.waitRun = async (flowId, runId, timeoutMs = 60000, until = (r) => r.status !== 'running') => {
    const t0 = Date.now();
    for (;;) {
      const r = await srv.uiOk('GET', `/api/flows/${flowId}/runs/${runId}`);
      if (r && until(r)) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} no terminó en ${timeoutMs} ms (estado ${r?.status})`);
      await sleep(150);
    }
  };
  /** External run with wait:true → run summary. */
  srv.runExt = async (flowRef, body = {}, headers = {}) => srv.ext('POST', `/flows/${encodeURIComponent(flowRef)}/run`, { wait: true, timeoutSec: 60, ...body }, headers);

  // ---------- mock Claude log ----------
  srv.calls = () => { try { return fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  srv.callsSince = (n) => srv.calls().slice(n);
  srv.callsFor = (needle) => srv.calls().filter((c) => `${c.prompt}\n${c.append}\n${c.system}`.includes(needle));
  srv.argOf = (call, name) => { const i = call.argv.indexOf(name); return i >= 0 ? call.argv[i + 1] : undefined; };

  // ---------- WebSocket ----------
  srv.sockets = [];
  srv.ws = (headers = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: `afs_ui=${srv.uiKey}`, ...headers } });
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch {} });
    ws.on('open', () => { srv.sockets.push(ws); resolve({ ws, msgs, close: () => ws.close(), waitFor: async (pred, ms = 20000) => { const t0 = Date.now(); for (;;) { const m = msgs.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error('ws: mensaje no recibido'); await sleep(50); } } }); });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`ws rechazado: ${res.statusCode}`)));
  });

  // ---------- child processes (afs CLI, MCP, generated clients) ----------
  srv.exec = (file, args, { env: e = {}, input, cwd, timeoutMs = 90000 } = {}) => new Promise((resolve) => {
    const c = spawn(file, args, { cwd: cwd || ROOT, env: { ...process.env, AFS_URL: base, AFS_DATA: dirs.data, ...e }, windowsHide: true });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.on('error', (err) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    c.stdin.end(input ?? '');
  });
  srv.afs = (args, opts = {}) => srv.exec(process.execPath, [path.join(ROOT, 'bin', 'afs.js'), ...args], opts);
  /** MCP client over stdio (bin/mcp.js). */
  srv.mcp = () => {
    const c = spawn(process.execPath, [path.join(ROOT, 'bin', 'mcp.js')], { cwd: ROOT, env: { ...process.env, AFS_URL: base, AFS_DATA: dirs.data }, windowsHide: true });
    let buf = ''; let id = 0; const waiting = new Map();
    c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {} } });
    const request = (method, params) => new Promise((res, rej) => { const n = ++id; const t = setTimeout(() => rej(new Error(`MCP ${method} sin respuesta`)), 90000); waiting.set(n, (m) => { clearTimeout(t); res(m); }); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    return { request, notify: (method, params) => c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'), close: () => { try { c.stdin.end(); c.kill(); } catch {} } };
  };
  return srv;
}

// ---------- step builders ----------
let n = 0;
const sid = (p) => `s_${p}${++n}`;
export const role = (name, task, more = {}) => ({ id: more.id || sid('r'), name, kind: 'role', role: more.role ?? `Rol de ${name}`, task, ...more });
export const skill = (name, skillRef, task, more = {}) => ({ id: more.id || sid('k'), name, kind: 'skill', skillRef, task, ...more });
export const agent = (name, agentRef, task, more = {}) => ({ id: more.id || sid('a'), name, kind: 'agent', agentRef, task, ...more });
export const cmd = (name, command, more = {}) => ({ id: more.id || sid('c'), name, kind: 'command', shell: 'powershell', command, ...more });
/** Finds a step (by name) inside a run (UI run object) or a run summary (external). */
export const stepOf = (run, name, flow) => {
  if (Array.isArray(run.steps)) return run.steps.find((s) => s.step === name);
  const id = flow ? flow.steps.find((s) => s.name === name)?.id : Object.keys(run.steps).find((k) => k === name);
  return run.steps[id];
};
export const hasBin = async (file, args) => new Promise((res) => { const c = spawn(file, args, { windowsHide: true, stdio: 'ignore' }); c.on('error', () => res(false)); c.on('close', (code) => res(code === 0)); });
