#!/usr/bin/env node
// Fake Claude Code CLI for the e2e suite (CLAUDE_BIN=<this file>). Speaks `-p --output-format stream-json`.
// - Logs every invocation (argv, prompt, system prompt files, cwd) as JSON lines to AFS_MOCK_LOG.
// - Remembers the sessions it created in AFS_MOCK_STATE (so --resume of an unknown session fails like the real CLI).
// - Behaviour is chosen by the kind of call (judge, summary, router, flow generator, integration adapter, chats)
//   and by directives written in the step's task/role: [[mock:<name> <arg>]] (see DIRECTIVES below).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const LOG = process.env.AFS_MOCK_LOG;
const STATE = process.env.AFS_MOCK_STATE;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFile = (f) => { try { return f ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; } };
const statePath = (k) => path.join(STATE || '.', k.replace(/[^\w.-]/g, '_'));
const bump = (k) => { if (!STATE) return 1; const f = statePath(`count-${k}`); const n = Number(readFile(f) || 0) + 1; fs.writeFileSync(f, String(n)); return n; };

let prompt = '';
for await (const c of process.stdin) prompt += c;

const system = readFile(opt('--system-prompt-file'));
const append = readFile(opt('--append-system-prompt-file'));
const resume = opt('--resume');
const model = opt('--model') || 'claude-mock-default';
const all = `${system}\n${append}\n${prompt}`;
if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, argv, prompt, system, append, cwd: process.cwd(), resume: resume || null, model }) + '\n');

// ---- session handling ----
if (resume && STATE && !fs.existsSync(statePath(`session-${resume}`))) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume });
  process.exit(1);
}
const sessionId = resume || crypto.randomUUID();
if (STATE) fs.writeFileSync(statePath(`session-${sessionId}`), '1');

// MCP servers the CLI "loaded": [[mock:mcp name=status,name=status]] replaces the default list
const mcpDir = (prompt.match(/\[\[mock:mcp\s+([^\]]*)\]\]/) || [])[1];
const mcpServers = mcpDir !== undefined ? mcpDir.split(',').filter(Boolean).map((x) => { const [name, status = 'connected'] = x.split('='); return { name: name.trim(), status: status.trim() }; }) : [{ name: 'mock-mcp', status: 'connected' }, { name: 'claude.ai Atlassian Rovo', status: 'connected' }];
out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: ['Read', 'Grep', 'Bash', 'Skill', 'ToolSearch'], mcp_servers: mcpServers, permissionMode: opt('--permission-mode') || 'default' });
if (prompt.trim() === '.') { await sleep(30000); process.exit(0); } // catalog probe: the server kills us after init

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
const denials = [];
let isError = false;
const text = (t) => out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: t }] } });
const toolUse = (name, input, result, isErr = false) => {
  const id = `tu_${crypto.randomBytes(4).toString('hex')}`;
  out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isErr }] } });
};
const finish = async (result, extra = {}) => {
  if (result && !isError) {
    out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: String(result).slice(0, 40) } } });
    text(result);
  }
  out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result, session_id: sessionId, num_turns: 1, duration_ms: 12, duration_api_ms: 10, total_cost_usd: 0.0012, usage, permission_denials: denials, ...extra });
  process.exit(extra.exitCode || 0);
};
const fail = (msg, code = 1) => { isError = true; return finish(msg, { exitCode: code }); };

// ---- directives: last occurrence wins (history may contain older ones) ----
// In chats only the user message counts (the step config inside <step-context> must not trigger its run directives).
const isChat = /^# Chat (de step|general del flujo)/.test(append);
const chatMsg = prompt.split(/<\/step-context>|<\/flow-context>|<\/related-memory>|<\/mode>|<\/run-review>|enrutado a ti\.\)/).pop();
const scope = isChat ? chatMsg : all;
const dir = (name) => { const all2 = [...scope.matchAll(new RegExp(`\\[\\[mock:${name}(?:\\s+([\\s\\S]*?))?\\]\\]`, 'g'))]; return all2.length ? (all2[all2.length - 1][1] ?? '') : null; };

// ---------------- special callers (by system prompt) ----------------
if (/verificador estricto/.test(system)) { // assertion judge
  const m = prompt.match(/<<DATA-([0-9a-f]+)>>([\s\S]*)<<\/DATA-\1>>/);
  const data = m ? m[2] : '';
  if (/JUEZ-ROTO/.test(data)) await finish('no es json');
  const pass = /APROBADO/.test(data);
  await finish(JSON.stringify({ pass, score: pass ? 9 : 2, reason: pass ? 'cumple' : 'no cumple los criterios' }));
}
if (/^Resume el texto/.test(system)) await finish(`RESUMEN(${prompt.length} chars): ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`);
if (/enrutador de un flujo/.test(system)) {
  const msg = prompt.split('Mensaje nuevo del usuario:\n').pop(); // the history may hold older directives
  // greedy up to the last "]]": the routed message may carry its own directive ([[mock:route ask flow x [[mock:propose-flow {…}]]]])
  const r = (msg.match(/\[\[mock:route\s+([\s\S]*)\]\]/) || [])[1] ?? null;
  if (r === null) await finish('{"action":"ask","target":"flow","reason":"pregunta general","message":""}'.replace('""}', `${JSON.stringify(prompt.split('\n').pop())}}`));
  const [action, target = 'flow', ...rest] = r.trim().split(/\s+/);
  await finish(JSON.stringify({ action, target, reason: `mock route ${action}`, message: rest.join(' ') || 'pregunta enrutada', input: rest.join(' ') }));
}
if (/Diseñas flujos de agentes/.test(system)) {
  if (/\[\[mock:gen-fail\]\]/.test(prompt)) await finish('No puedo.');
  const skill = (prompt.match(/Skills disponibles:\n- ([^:\n]+):/) || [])[1] || '';
  const agent = (prompt.match(/Agentes disponibles:\n- ([^:\n]+):/) || [])[1] || '';
  await finish(JSON.stringify({
    name: 'Flujo generado (mock)', description: 'Generado por el mock', vars: { issue: 'SBK-1' },
    steps: [
      { key: 'a', name: 'Analizar', kind: 'role', role: 'Analista', task: 'Analiza {{input}}', access: 'read' },
      { key: 'b', name: 'Diseñar', kind: skill ? 'skill' : 'role', skillRef: skill, task: 'Diseña casos', access: 'atlassian-read' },
      { key: 'c', name: 'Revisar', kind: agent ? 'agent' : 'role', agentRef: agent, task: 'Revisa', access: 'edit' },
      { key: 'd', name: 'Comprobar', kind: 'command', command: 'Write-Output ok', shell: 'powershell', access: 'none' },
    ],
    edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
  }));
}
if (/Adaptas integraciones/.test(system)) {
  const m = prompt.match(/Plantilla de partida \(correcta\):\n([\s\S]*?)\n\n<descripcion-del-usuario>\n([\s\S]*?)\n<\/descripcion-del-usuario>/);
  const tpl = m ? JSON.parse(m[1]) : { files: [], setup: [], notes: [], mapping: {} };
  const desc = m ? m[2] : '';
  const correcting = /Tu respuesta anterior tenía estos errores/.test(prompt);
  if (/\[\[mock:adapt-garbage\]\]/.test(desc)) await finish('esto no es JSON');
  const files = tpl.files.map((f) => ({ ...f }));
  if (/\[\[mock:adapt-token\]\]/.test(desc) && !correcting && files[0]) files[0].content += '\n# Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n';
  await finish('```json\n' + JSON.stringify({ files, setup: [...tpl.setup, 'Paso adaptado por IA (mock)'], notes: [...tpl.notes, `Adaptado a: ${desc.slice(0, 80)}`], assumptions: ['mock'], mapping: tpl.mapping }) + '\n```');
}

// ---------------- runs, chats, hook.ai: directives ----------------
const correcting = /no cumple el formato requerido/.test(prompt) && resume;
const sleepSec = dir('sleep');
if (sleepSec !== null) await sleep(Number(sleepSec) * 1000);

if (dir('crash') !== null) { process.stderr.write('mock crash: boom\n'); process.exit(3); }
const transientOnce = dir('transient-once');
if (transientOnce !== null && bump(`transient-${transientOnce}`) === 1) await fail('API Error: 500 Internal server error (mock)');
if (dir('transient-always') !== null) await fail('API Error: 529 overloaded (mock)');
if (dir('write-then-transient') !== null) { toolUse('Write', { file_path: 'C:/tmp/mock-written.txt', content: 'x' }, 'ok'); await fail('API Error: 500 after write (mock)'); }
if (dir('error') !== null) await fail(`mock fatal error: ${dir('error')}`);

for (const t of [...scope.matchAll(/\[\[mock:tool\s+([^\s\]]+)(?:\s+([^\]]*))?\]\]/g)]) toolUse(t[1], { mock: t[2] || '' }, `resultado de ${t[1]}`);
for (const w of [...scope.matchAll(/\[\[mock:write\s+([^\]]+)\]\]/g)]) toolUse('Write', { file_path: w[1].trim(), content: 'mock' }, 'File created');
if (dir('deny') !== null) { denials.push({ tool_name: dir('deny').trim() || 'Bash', tool_use_id: 'x', tool_input: { command: 'rm -rf build' } }); }

let reply;
if (dir('empty') !== null) reply = '';
else if (correcting) {
  // the correction turn only carries the correction message: the payload was saved with the session
  const fix = readFile(statePath(`fix-${sessionId}`));
  reply = fix && !/^never/.test(fix) ? `Corregido.\n\`\`\`json\n${fix}\n\`\`\`` : 'Sigo sin JSON.';
} else if (dir('badjson-then-fix') !== null) { if (STATE) fs.writeFileSync(statePath(`fix-${sessionId}`), dir('badjson-then-fix')); reply = 'Aquí va, pero sin bloque JSON.'; }
else if (dir('json') !== null) reply = `Resultado del step.\n\`\`\`json\n${dir('json')}\n\`\`\``;
else if (dir('say') !== null) reply = dir('say');
else if (dir('echo') !== null) reply = `ECHO>>${prompt}<<ECHO`;
else if (isChat) reply = `Respuesta de chat (mock) a: ${prompt.split('\n').pop().slice(0, 120)}`;
else reply = `MOCK-OK model=${model} agent=${opt('--agent') || '-'}`;

// <route> chosen in the reply of the first turn (a JSON correction turn may omit it)
if (dir('emit-route') !== null && !correcting) reply += `\n<route to="${dir('emit-route').trim()}"/>`;
if (dir('propose') !== null) reply += `\n<step-update>${dir('propose')}</step-update>`;
if (dir('propose-invalid') !== null) reply += '\n<step-update>{no es json</step-update>';
// spec 25 proposal kinds (chats only propose; the user confirms)
if (dir('propose-flow') !== null) reply += `\n<flow-update>${dir('propose-flow')}</flow-update>`;
if (dir('propose-file') !== null) { const [p, ...c] = dir('propose-file').split('|'); reply += `\n<file-update path="${p.trim()}">\n${c.join('|')}</file-update>`; }
if (dir('propose-output') !== null) reply += `\n<output-update>${dir('propose-output')}</output-update>`;
if (dir('propose-run') !== null) reply += `\n<run-request>${dir('propose-run')}</run-request>`;
if (dir('ask-back') !== null) reply = `Antes de proponer algo: ${dir('ask-back')}`;
for (const r of [...scope.matchAll(/\[\[mock:remember\s+([^\]]+)\]\]/g)]) if (!correcting) reply += `\n<remember>${r[1]}</remember>`;
await finish(reply);
