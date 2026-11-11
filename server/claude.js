// Runs the local Claude Code CLI headless (uses the user's subscription login,
// skills, agents and MCP connectors) and normalizes its stream-json output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let cachedBin = null;
export function claudeBin() {
  if (cachedBin) return cachedBin;
  if (process.env.CLAUDE_BIN) return (cachedBin = process.env.CLAUDE_BIN);
  if (process.platform === 'win32') {
    const exe = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return (cachedBin = exe);
  }
  return (cachedBin = 'claude');
}

const TMP = path.join(os.tmpdir(), 'agent-flow-studio');
fs.mkdirSync(TMP, { recursive: true });

function tmpFile(content) {
  const f = path.join(TMP, `sp-${crypto.randomUUID()}.md`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

/** Kills a process and all its children (Windows: taskkill /T). */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch {}
  }
  try { child.kill(); } catch {}
}

/** Errors worth retrying: rate limit / overload / API 5xx / CLI died without a result. */
export const isTransient = (r) => !!r && r.isError && !r.aborted && (r.noResult || /rate.?limit|overloaded|API Error: 5dd|(529|503|502)|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(r.error || '') + ' ' + String(r.text || '').slice(0, 300)));

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars more]` : s);

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

/** Last init info seen (tools + MCP servers), exposed to the UI catalog. */
export const lastInit = { tools: [], mcpServers: [], model: null, at: null };
/** Last rate-limit info (subscription usage windows). */
export const lastRateLimit = { info: null, at: null };

function normalize(msg, ctx) {
  const out = [];
  const sub = !!msg.parent_tool_use_id;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        Object.assign(lastInit, { tools: msg.tools || [], mcpServers: msg.mcp_servers || [], model: msg.model, at: Date.now() });
        out.push({ kind: 'init', model: msg.model, sessionId: msg.session_id, tools: (msg.tools || []).length, mcp: (msg.mcp_servers || []).map((m) => ({ name: m.name, status: m.status })), permissionMode: msg.permissionMode });
      } else if (msg.subtype === 'thinking_tokens') {
        out.push({ kind: 'thinking_tokens', tokens: msg.estimated_tokens });
      }
      break;
    case 'rate_limit_event':
      lastRateLimit.info = msg.rate_limit_info; lastRateLimit.at = Date.now();
      out.push({ kind: 'rate_limit', info: msg.rate_limit_info });
      break;
    case 'stream_event': {
      const e = msg.event || {};
      if (e.type === 'content_block_delta' && !sub) {
        if (e.delta?.type === 'text_delta') out.push({ kind: 'delta', text: e.delta.text });
        else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) out.push({ kind: 'thinking_delta', text: e.delta.thinking });
      }
      break;
    }
    case 'assistant':
      for (const b of msg.message?.content || []) {
        if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking, sub });
        else if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text, sub });
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input, sub });
      }
      break;
    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') out.push({ kind: 'tool_result', id: b.tool_use_id, content: clip(toolResultText(b.content), 4000), isError: !!b.is_error, sub });
        }
      }
      break;
    }
    case 'result':
      out.push({
        kind: 'result', isError: !!msg.is_error, subtype: msg.subtype, text: msg.result ?? '', durationMs: msg.duration_ms,
        numTurns: msg.num_turns, sessionId: msg.session_id, usage: msg.usage, costUsd: msg.total_cost_usd, denials: msg.permission_denials || [],
      });
      ctx.result = msg;
      break;
    default:
  }
  return out;
}

// ---------- global limit of concurrent claude processes (runs, chats, router, summaries, judge) ----------
const MAX_CLAUDE = Math.max(1, Number(process.env.AFS_MAX_CLAUDE || 3));
let slotsUsed = 0;
const slotQueue = [];
function acquire(signal) {
  if (slotsUsed < MAX_CLAUDE) { slotsUsed++; return Promise.resolve(true); }
  return new Promise((res) => {
    const w = { res };
    slotQueue.push(w);
    signal?.addEventListener?.('abort', () => { const i = slotQueue.indexOf(w); if (i >= 0) { slotQueue.splice(i, 1); res(false); } }, { once: true });
  });
}
function release() { const next = slotQueue.shift(); if (next) next.res(true); else slotsUsed--; }
export const claudeSlots = () => ({ used: slotsUsed, max: MAX_CLAUDE, queued: slotQueue.length });

/**
 * Run one Claude Code turn (waits for a free slot first; opts.onStart fires when the process starts).
 * @returns {Promise<{text:string, sessionId:string|null, isError:boolean, usage:any}>}
 */
export async function runClaude(opts) {
  const onEvent = opts.onEvent || (() => {});
  if (opts.signal?.aborted) return { text: '', isError: true, aborted: true, error: 'aborted', denials: [] };
  if (slotsUsed >= MAX_CLAUDE) { try { onEvent({ kind: 'queued', text: `⏳ En cola: ${slotsUsed} procesos de Claude en curso (máximo ${MAX_CLAUDE}, AFS_MAX_CLAUDE).` }); } catch {} }
  const ok = await acquire(opts.signal);
  if (!ok) return { text: '', isError: true, aborted: true, error: 'aborted', denials: [] };
  try { opts.onStart?.(); } catch {}
  try { return await runClaudeNow(opts); } finally { release(); }
}

function runClaudeNow(opts) {
  const {
    prompt, appendSystem, systemPrompt, model, effort, agent, resume, permissionMode,
    allowedTools, disallowedTools, tools, addDirs, cwd, onEvent = () => {}, signal, noPersist, strictMcp,
  } = opts;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const files = [];
  if (systemPrompt) { const f = tmpFile(systemPrompt); files.push(f); args.push('--system-prompt-file', f); }
  if (appendSystem) { const f = tmpFile(appendSystem); files.push(f); args.push('--append-system-prompt-file', f); }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (agent) args.push('--agent', agent);
  if (resume) args.push('--resume', resume);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (noPersist) args.push('--no-session-persistence');
  if (strictMcp) args.push('--strict-mcp-config');
  if (tools !== undefined) args.push('--tools', tools);
  // Tool lists: space/comma separated, but a space inside parentheses belongs to the pattern: Bash(git status:*)
  const list = (v) => (Array.isArray(v) ? v : String(v || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || []).map((s) => s.trim()).filter(Boolean);
  if (list(addDirs).length) args.push('--add-dir', ...list(addDirs));
  if (list(allowedTools).length) args.push('--allowedTools', list(allowedTools).join(','));
  if (list(disallowedTools).length) args.push('--disallowedTools', list(disallowedTools).join(','));

  return new Promise((resolve) => {
    const ctx = { result: null, text: '', sessionId: null, stderr: '', model: null };
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const child = spawn(claudeBin(), args, { cwd: workDir, env: { ...process.env }, windowsHide: true });
    if (child.pid) { try { opts.onSpawn?.(child.pid); } catch {} }
    const kill = () => killTree(child);
    signal?.addEventListener?.('abort', kill, { once: true });

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.session_id) ctx.sessionId = msg.session_id;
        if (msg.type === 'system' && msg.subtype === 'init' && msg.model) ctx.model = msg.model;
        for (const ev of normalize(msg, ctx)) {
          if (ev.kind === 'text' && !ev.sub) ctx.text = ev.text; // last top-level text block
          try { onEvent(ev); } catch {}
        }
      }
    });
    child.stderr.on('data', (d) => { ctx.stderr += d.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt ?? '');

    const done = (code) => {
      for (const f of files) fs.rm(f, { force: true }, () => {});
      const aborted = signal?.aborted;
      const r = ctx.result;
      const text = r?.result ?? ctx.text ?? '';
      const isError = aborted || !r || !!r.is_error || (code !== 0 && !r);
      if (!r && !aborted) onEvent({ kind: 'error', text: clip(ctx.stderr || `claude exited with code ${code}`, 3000) });
      if (aborted) onEvent({ kind: 'error', text: 'Detenido por el usuario.' });
      resolve({
        text, sessionId: ctx.sessionId, isError, aborted: !!aborted, noResult: !r && !aborted,
        error: isError ? (aborted ? 'aborted' : clip(ctx.stderr, 2000) || (r?.is_error ? clip(String(r.result || ''), 600) : '') || r?.subtype || `exit ${code}`) : null,
        usage: r?.usage, model: ctx.model, costUsd: r?.total_cost_usd ?? null, durationMs: r?.duration_ms ?? null, durationApiMs: r?.duration_api_ms ?? null, numTurns: r?.num_turns ?? null,
        denials: (r?.permission_denials || []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input || {}).slice(0, 300) })),
      });
    };
    child.on('error', (err) => { onEvent({ kind: 'error', text: `No se pudo lanzar claude (${claudeBin()}): ${err.message}` }); done(-1); });
    child.on('close', done);
  });
}

/** Spawn claude only until the init event, to discover tools/MCPs without spending a model call. */
export function probeInit(cwd) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), ['-p', '--output-format', 'stream-json', '--verbose'], { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), windowsHide: true });
    let buf = ''; let finished = false;
    const finish = () => { if (finished) return; finished = true; try { child.kill(); } catch {} resolve({ ...lastInit }); };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.type === 'system' && m.subtype === 'init') { normalize(m, {}); finish(); }
        } catch {}
      }
    });
    child.stdin.on('error', () => {});
    // init is emitted before the first model request; we kill the process as soon as we see it
    child.stdin.end('.');
    setTimeout(finish, 45000);
    child.on('close', finish);
  });
}
