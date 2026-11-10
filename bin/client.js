// Shared HTTP client for the CLI and the MCP server. Auto-starts the local server if needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASE = (process.env.AFS_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');

export function token() {
  if (process.env.AFS_TOKEN) return process.env.AFS_TOKEN;
  try { return JSON.parse(fs.readFileSync(path.join(process.env.AFS_DATA || path.join(ROOT, 'data'), 'config.json'), 'utf8')).token; } catch { return ''; }
}

export async function call(method, url, body) {
  const r = await fetch(BASE + '/api/ext' + url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the server in the background if it's local and not responding. */
export async function ensureServer(log = () => {}) {
  try { await call('GET', '/ping'); return; } catch (e) {
    if (/Token/.test(e.message)) throw e;
    if (!/127\.0\.0\.1|localhost/.test(BASE)) throw new Error(`No responde ${BASE}: ${e.message}`);
  }
  log('Iniciando Agent Flow Studio en segundo plano…');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await call('GET', '/ping'); return; } catch {}
  }
  throw new Error('El servidor no arrancó (revisa `npm start` en ' + ROOT + ')');
}

export const flowPath = (f) => `/flows/${encodeURIComponent(f)}`;

/** Start a run and poll until done, reporting step status changes. */
export async function runAndWait(flow, body, { timeoutSec = 900, onStep = () => {} } = {}) {
  const { runId } = await call('POST', `${flowPath(flow)}/run`, { ...body, wait: false });
  const seen = {};
  const t0 = Date.now();
  for (;;) {
    const s = await call('GET', `${flowPath(flow)}/runs/${runId}`);
    for (const st of s.steps || []) if (seen[st.step] !== st.status) { seen[st.step] = st.status; onStep(st); }
    if (s.status !== 'running') return s;
    if (Date.now() - t0 > timeoutSec * 1000) return { ...s, timedOut: true };
    await sleep(1500);
  }
}
