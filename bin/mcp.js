#!/usr/bin/env node
// MCP server (stdio) exposing Agent Flow Studio flows as tools, so Claude Code / other agents can invoke them.
//   claude mcp add agent-flows -s user -- node <ruta>\bin\mcp.js
import { call, ensureServer, flowPath, runAndWait } from './client.js';

const TOOLS = [
  {
    name: 'list_flows',
    description: 'Lista los flujos de agentes de Agent Flow Studio con sus steps y variables.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_flow',
    description: 'Ejecuta un flujo (o un solo step) de Agent Flow Studio y devuelve el resultado final y la salida de cada step. Puede tardar minutos.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Nombre o id del flujo' },
        input: { type: 'string', description: 'Input del flujo (requerimiento, ticket, texto, JSON…)' },
        step: { type: 'string', description: 'Opcional: ejecutar solo este step (nombre o id)' },
        vars: { type: 'object', description: 'Opcional: variables SOLO para esta ejecución (no se guardan en el flujo)', additionalProperties: { type: 'string' } },
        wait: { type: 'boolean', description: 'Esperar el resultado (default true). Si false devuelve el runId.' },
        timeoutSec: { type: 'number', description: 'Máximo a esperar (default 600)' },
        usePins: { type: 'boolean', description: 'Usar salidas fijadas (📌) en vez de ejecutar esos steps (default false)' },
        deadlineSec: { type: 'number', description: 'Tiempo máximo de la ejecución en el servidor (default el del flujo, 3600)' },
        idempotencyKey: { type: 'string', description: 'Si repites la llamada con la misma clave no se lanza otra ejecución' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_run',
    description: 'Estado y salidas de una ejecución previa de un flujo.',
    inputSchema: { type: 'object', properties: { flow: { type: 'string' }, runId: { type: 'string' } }, required: ['flow', 'runId'], additionalProperties: false },
  },
  {
    name: 'cancel_run',
    description: 'Cancela una ejecución en curso de un flujo (las demás ejecuciones siguen).',
    inputSchema: { type: 'object', properties: { flow: { type: 'string' }, runId: { type: 'string' } }, required: ['flow', 'runId'], additionalProperties: false },
  },
  {
    name: 'ask_flow',
    description: 'Pregunta en lenguaje natural a un flujo: el enrutador elige el step/agente/skill que responde (o usa "step" para uno específico).',
    inputSchema: { type: 'object', properties: { flow: { type: 'string' }, message: { type: 'string' }, step: { type: 'string' } }, required: ['flow', 'message'], additionalProperties: false },
  },
];

const FENCE = '`'.repeat(3);
function fmtRun(r) {
  const lines = [`Flujo: ${r.flow} · ejecución ${r.runId} · estado: ${r.status}${r.timedOut ? ' (sigue corriendo; usa get_run o cancel_run)' : ''}`];
  for (const s of r.steps || []) lines.push(`- ${s.step}: ${s.status}${s.code ? ` [${s.code}]` : ''}${s.error ? ` — ${s.error.slice(0, 300)}` : ''}${s.pinned ? ' (📌 salida fijada)' : ''}`);
  if (r.usedPins?.length) lines.push(`Usó salidas fijadas: ${r.usedPins.join(', ')}`);
  if (r.result) lines.push('', 'Resultado final:', r.result);
  if (r.json !== undefined) lines.push('', 'Resultado estructurado:', FENCE + 'json', JSON.stringify(r.json, null, 2), FENCE);
  const others = (r.steps || []).filter((s) => s.output && !(r.result || '').includes(s.output));
  if (others.length) { lines.push('', 'Salidas intermedias:'); for (const s of others) lines.push(`### ${s.step}`, s.output.slice(0, 4000)); }
  return lines.join('\n');
}
/** Tool result for a run: isError unless it succeeded; full summary as structuredContent. */
const runResult = (r) => ({ content: [{ type: 'text', text: fmtRun(r) }], structuredContent: r, isError: r.status !== 'success' || !!r.timedOut });

async function callTool(name, a = {}) {
  await ensureServer();
  switch (name) {
    case 'list_flows': {
      const flows = await call('GET', '/flows');
      return flows.map((f) => `• ${f.name} (${f.id})${f.description ? ` — ${f.description}` : ''}\n  steps: ${f.steps.map((s) => s.name).join(' → ') || '—'}${Object.keys(f.vars || {}).length ? `\n  vars: ${JSON.stringify(f.vars)}` : ''}`).join('\n') || 'No hay flujos.';
    }
    case 'run_flow': {
      const body = { input: a.input || '', step: a.step, vars: a.vars, source: 'mcp', usePins: !!a.usePins, deadlineSec: a.deadlineSec };
      const headers = a.idempotencyKey ? { 'Idempotency-Key': String(a.idempotencyKey) } : {};
      if (a.wait === false) { const r = await call('POST', `${flowPath(a.flow)}/run`, { ...body, wait: false }, headers); return { content: [{ type: 'text', text: `Ejecución iniciada: ${r.runId}. Consulta con get_run o cancela con cancel_run.` }], structuredContent: r }; }
      return runResult(await runAndWait(a.flow, body, { timeoutSec: a.timeoutSec || 600, idempotencyKey: a.idempotencyKey }));
    }
    case 'get_run': {
      const r = await call('GET', `${flowPath(a.flow)}/runs/${a.runId}`);
      return r.status === 'running' ? { content: [{ type: 'text', text: fmtRun(r) }], structuredContent: r } : runResult(r);
    }
    case 'cancel_run': {
      const r = await call('POST', `${flowPath(a.flow)}/runs/${a.runId}/cancel`, {});
      return { content: [{ type: 'text', text: `Ejecución ${r.runId}: ${r.status}` }], structuredContent: r };
    }
    case 'ask_flow': {
      const r = await call('POST', `${flowPath(a.flow)}/ask`, { message: a.message, step: a.step });
      return `(responde: ${r.routedTo})\n\n${r.answer}`;
    }
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-flow-studio', version: '0.2.0' } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') {
      try {
        const out = await callTool(params.name, params.arguments);
        result = typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
      } catch (e) { result = { content: [{ type: 'text', text: `Error: ${e.message}${e.code ? ` (${e.code})` : ''}` }], isError: true }; }
    } else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
