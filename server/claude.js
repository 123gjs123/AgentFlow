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
        numTurns: msg.num_turns, sessionId: msg.session_id, usage: msg.usage, denials: msg.permission_denials || [],
      });
      ctx.result = msg;
      break;
    default:
  }
  return out;
}

/**
 * Run one Claude Code turn.
 * @returns {Promise<{text:string, sessionId:string|null, isError:boolean, usage:any}>}
 */
export function runClaude(opts) {
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
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  if (list(addDirs).length) args.push('--add-dir', ...list(addDirs));
  if (list(allowedTools).length) args.push('--allowedTools', list(allowedTools).join(','));
  if (list(disallowedTools).length) args.push('--disallowedTools', list(disallowedTools).join(','));

  return new Promise((resolve) => {
    const ctx = { result: null, text: '', sessionId: null, stderr: '' };
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const child = spawn(claudeBin(), args, { cwd: workDir, env: { ...process.env }, windowsHide: true });
    const kill = () => { try { child.kill(); } catch {} };
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
      resolve({ text, sessionId: ctx.sessionId, isError, usage: r?.usage, error: isError ? (aborted ? 'aborted' : clip(ctx.stderr, 2000) || r?.subtype) : null });
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
