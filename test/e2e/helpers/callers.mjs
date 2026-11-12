// Simulators of the external systems that call Agent Flow Studio. Each one takes the files the integration
// helper generated for that caller and executes them the way the real system would (Jira Automation renders smart
// values and sends the web request; Jenkins/GitHub/Bitbucket/GitLab run their script with their env variables;
// the scheduled task / cron / Python run the scripts; Claude Code spawns the MCP; a webhook POSTs its body).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseYaml } from '../../../scripts/verify/yaml-lite.mjs';

const WIN = process.platform === 'win32';
export const BASH = WIN ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

/** Directory with a `python3` that runs the real python (on Windows `python3` is usually the Store stub). */
let shim = null;
function pythonShim() {
  if (shim || !WIN) return shim;
  shim = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-py-'));
  process.on('exit', () => { try { fs.rmSync(shim, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(shim, 'python3'), '#!/bin/sh\nexec python "$@"\n');
  return shim;
}

export function run(file, args, { cwd, env = {}, input = '', timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const p = pythonShim();
    const c = spawn(file, args, { cwd, env: { ...process.env, ...(p ? { PATH: `${p}${path.delimiter}${process.env.PATH}` } : {}), ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, runId: (stderr.match(/runId=(r_\w+)/) || [])[1] }); });
    c.stdin.end(input);
  });
}
const bash = (script, o) => run(BASH, ['-c', script], o);
const ps = (script, o) => run(WIN ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${script}; exit $LASTEXITCODE`], o);

/** Writes the generated files into a fresh working dir (as if committed to the caller's repo). */
export function checkout(files, root, baseFrom, baseTo) {
  const dir = fs.mkdtempSync(path.join(root, 'repo-'));
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, baseFrom ? f.content.split(baseFrom).join(baseTo) : f.content);
  }
  return dir;
}
const file = (g, name) => g.files.find((f) => f.name === name)?.content;
const fromGroovy = (s) => s.replace(/\\'\\'\\'/g, "'''").replace(/\\\\/g, '\\');

// ---------------- Jira Automation ----------------
/** Renders the smart values Jira would: issue.key, issue.summary(.jsonEncode), issue.updated.format("…"). */
export function renderJira(tpl, issue) {
  return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, e) => {
    if (e === 'issue.key') return issue.key;
    if (e === 'issue.id') return issue.id;
    if (/^issue\.updated\.format\(/.test(e)) return issue.updated;
    const enc = e.endsWith('.jsonEncode');
    const field = e.replace(/\.jsonEncode$/, '').replace(/^issue\.(fields\.)?/, '');
    if (!(field in issue)) throw new Error(`smart value no simulado: ${m}`);
    return enc ? JSON.stringify(String(issue[field])).slice(1, -1) : String(issue[field]);
  });
}
export async function jira(g, { token, issue, base }) {
  const rule = file(g, 'configuracion-regla.txt');
  let url = rule.match(/Web request URL: (\S+)/)[1];
  if (base) url = url.replace(g.reachability.base, base);
  const key = renderJira(rule.match(/Idempotency-Key: (.+)/)[1].trim(), issue);
  const body = renderJira(file(g, 'cuerpo-web-request.json'), issue);
  JSON.parse(body); // Jira would refuse to send an invalid body
  // Cloud reaches the PC through a tunnel: the request arrives with forwarding headers.
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key, 'User-Agent': 'Automation for Jira', ...(base ? { 'X-Forwarded-For': '18.1.2.3' } : {}) };
  const r = await fetch(url, { method: 'POST', headers, body });
  const json = await r.json();
  return { code: r.status, body: json, runId: json.runId, key };
}

// ---------------- CI systems ----------------
export async function jenkins(g, { root, env, unix = true, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  const jf = file(g, 'Jenkinsfile').split(baseFrom || '\u0000').join(baseTo || '');
  if (unix) return bash(fromGroovy(jf.match(/sh '''\n([\s\S]*?)\n\s*'''/)[1]), { cwd: dir, env });
  return ps(fromGroovy(jf.match(/powershell '''\n\s*([\s\S]*?)\n\s*'''/)[1]), { cwd: dir, env });
}

/** GitHub Actions: env: entries are evaluated by GitHub (${{ … }}), then `run:` executes with them. */
export async function github(g, { root, ctx, token, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  const wf = parseYaml(file(g, '.github/workflows/agent-flow.yml').split(baseFrom || '\u0000').join(baseTo || ''));
  const step = wf.jobs['agent-flow'].steps.find((x) => x.run);
  const evalGh = (v) => String(v).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, e) => (e === 'secrets.AFS_TOKEN' ? token : ctx[e.replace(/^github\./, '')] ?? ''));
  const env = Object.fromEntries(Object.entries(step.env || {}).map(([k, v]) => [k, evalGh(v)]));
  return step.shell === 'powershell' ? ps(step.run, { cwd: dir, env }) : bash(step.run, { cwd: dir, env });
}
export async function bitbucket(g, { root, env, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  const y = parseYaml(file(g, 'bitbucket-pipelines.yml').split(baseFrom || '\u0000').join(baseTo || ''));
  const st = y.pipelines.custom['agent-flow'][0].step;
  return st['runs-on'] ? ps(st.script[0], { cwd: dir, env }) : bash(st.script[0], { cwd: dir, env });
}
export async function gitlab(g, { root, env, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  const job = parseYaml(file(g, '.gitlab-ci.yml').split(baseFrom || '\u0000').join(baseTo || ''))['agent-flow'];
  return job.tags ? ps(job.script[0], { cwd: dir, env }) : bash(job.script[0], { cwd: dir, env });
}

// ---------------- local schedulers / scripts ----------------
export async function scheduledTask(g, { root, env }) {
  const dir = checkout(g.files, root);
  return run(WIN ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'ejecutar-flujo.ps1')], { cwd: dir, env });
}
export async function cron(g, { root, token, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  fs.writeFileSync(path.join(home, '.afs_token'), token);
  return bash('./ejecutar-flujo.sh', { cwd: dir, env: { HOME: home } });
}
export async function python(g, { root, env, baseFrom, baseTo }) {
  const dir = checkout(g.files, root, baseFrom, baseTo);
  return run('python', ['ejemplo.py'], { cwd: dir, env });
}

// ---------------- Claude Code (MCP) ----------------
/** Spawns the MCP exactly as registrar-mcp.txt registers it and calls run_flow like the example prompt asks. */
export async function claudeMcp(g, { env, flow, input }) {
  const [, node, mcp] = file(g, 'registrar-mcp.txt').match(/-- "([^"]+)" "([^"]+)"/);
  const c = spawn(node, [mcp], { env: { ...process.env, ...env }, windowsHide: true });
  let buf = '';
  const res = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('MCP sin respuesta')), 90000);
    c.stdout.on('data', (d) => { buf += d; for (const l of buf.split('\n')) { try { const m = JSON.parse(l); if (m.id === 2) { clearTimeout(t); resolve(m.result); } } catch {} } });
  });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } } }) + '\n');
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { flow, input } } }) + '\n');
  try { const r = await res; return { code: r.isError ? 1 : 0, runId: r.structuredContent?.runId, result: r }; } finally { c.kill(); }
}

// ---------------- generic webhook ----------------
export async function webhook(g, { token, payload, viaQuery = false }) {
  const txt = file(g, 'webhook.txt');
  const url = txt.match(/URL: (\S+)/)[1];
  const body = payload ?? JSON.parse(txt.slice(txt.indexOf('Cuerpo:') + 7, txt.indexOf('\n\nSi la herramienta')).trim());
  const r = await fetch(viaQuery ? `${url}?source=webhook&token=${token}` : url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(viaQuery ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  const json = await r.json();
  return { code: r.status, body: json, runId: json.runId };
}
