// Flow execution, step hooks, step/flow chats and the global router.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as store from './store.js';
import { runClaude } from './claude.js';
import { findAgent, findSkill } from './catalog.js';
import * as P from './prompt.js';
import { validate, parseSchema } from './schema.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const emit = (msg) => bus.emit('msg', msg);
const flowChanged = (flow) => emit({ type: 'flow.updated', flowId: flow.id, flow });

const MAX_PARALLEL = Number(process.env.AFS_MAX_PARALLEL || 2);
const activeRuns = new Map(); // runId -> { controller, flowId }
const activeChats = new Map(); // `${flowId}:${key}` -> controller

const now = () => Date.now();
const flowCwd = (flow) => (flow.cwd && fs.existsSync(flow.cwd) ? flow.cwd : os.homedir());

// ---------- graph ----------
export function topoLevels(flow) {
  const indeg = new Map(flow.steps.map((s) => [s.id, 0]));
  for (const e of flow.edges) if (indeg.has(e.target) && indeg.has(e.source)) indeg.set(e.target, indeg.get(e.target) + 1);
  const levels = [];
  let frontier = flow.steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const seen = new Set();
  while (frontier.length) {
    levels.push(frontier);
    frontier.forEach((id) => seen.add(id));
    const next = [];
    for (const id of frontier) {
      for (const e of flow.edges.filter((x) => x.source === id)) {
        if (!indeg.has(e.target)) continue;
        indeg.set(e.target, indeg.get(e.target) - 1);
        if (indeg.get(e.target) === 0) next.push(e.target);
      }
    }
    frontier = next;
  }
  if (seen.size !== flow.steps.length) throw new Error('El flujo tiene un ciclo; quita alguna relación.');
  return levels;
}

// ---------- shell ----------
export function sh(cmd, { cwd, shell = 'powershell', input, env, signal } = {}) {
  return new Promise((resolve) => {
    let file, args;
    if (shell === 'bash') { file = 'bash'; args = ['-lc', cmd]; }
    else if (shell === 'cmd') { file = 'cmd.exe'; args = ['/d', '/s', '/c', cmd]; }
    else { file = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'; args = ['-NoProfile', '-NonInteractive', '-Command', cmd]; }
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    signal?.addEventListener?.('abort', () => { try { child.kill(); } catch {} }, { once: true });
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------- hooks ----------
function loadHooks(code) {
  if (!code?.trim()) return {};
  const names = ['onStart', 'onSuccess', 'onFailure'];
  const body = `${code}\n;return { ${names.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : undefined`).join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

function hookCtx({ flow, step, run, input, signal, log, upstream = [] }) {
  const ctx = {
    flow: { id: flow.id, name: flow.name, vars: flow.vars },
    step: { id: step.id, name: step.name, kind: step.kind },
    runId: run?.id, input, output: undefined, json: undefined, error: undefined,
    upstream: Object.fromEntries(upstream.map((u) => [u.name, { output: u.output, json: u.json }])),
    vars: flow.vars || {},
    log: (...a) => log({ kind: 'hook_log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }),
    sh: async (cmd, o = {}) => {
      log({ kind: 'tool_use', name: 'hook.sh', input: { cmd } });
      const r = await sh(cmd, { cwd: flowCwd(flow), signal, ...o });
      log({ kind: 'tool_result', content: (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).slice(0, 4000), isError: r.code !== 0 });
      return r;
    },
    ai: async (prompt, o = {}) => {
      log({ kind: 'tool_use', name: 'hook.ai', input: { prompt: String(prompt).slice(0, 500), tools: o.tools } });
      const r = await runClaude({ prompt, model: o.model, allowedTools: o.tools, permissionMode: o.permissionMode, cwd: flowCwd(flow), signal, onEvent: (ev) => ev.kind !== 'delta' && ev.kind !== 'thinking_delta' && log({ ...ev, sub: true }) });
      return r.text;
    },
    runStep: async (nameOrId, inp) => {
      const f = store.getFlow(flow.id);
      const s = f.steps.find((x) => x.id === nameOrId || x.name === nameOrId);
      if (!s) throw new Error(`Step no encontrado: ${nameOrId}`);
      const r = await executeStep(f, s, inp ?? ctx.output ?? '', run, signal, []);
      return r.output;
    },
    remember: (text) => addMemory(flow.id, step.id, text, 'hook'),
    setVar: (k, v) => { ctx.vars[k] = v; store.updateFlow(flow.id, (f) => { f.vars = { ...(f.vars || {}), [k]: v }; }); },
  };
  return ctx;
}

// ---------- memory ----------
export function addMemory(flowId, scope, text, source = 'manual') {
  const item = { id: store.uid('m_'), text: String(text).trim(), source, at: now() };
  if (!item.text) return null;
  const flow = store.updateFlow(flowId, (f) => {
    const target = scope === '_flow' ? f : f.steps.find((s) => s.id === scope);
    if (!target) return;
    target.memory = target.memory || [];
    if (!target.memory.some((m) => m.text === item.text)) target.memory.push(item);
  });
  if (flow) flowChanged(flow);
  return item;
}
export function removeMemory(flowId, scope, memId) {
  const flow = store.updateFlow(flowId, (f) => {
    const target = scope === '_flow' ? f : f.steps.find((s) => s.id === scope);
    if (target) target.memory = (target.memory || []).filter((m) => m.id !== memId);
  });
  if (flow) flowChanged(flow);
}

// ---------- step execution ----------
function setStepRun(flowId, stepId, patch) {
  const flow = store.updateFlow(flowId, (f) => {
    const s = f.steps.find((x) => x.id === stepId);
    if (s) s.lastRun = { ...(s.lastRun || {}), ...patch };
  });
  if (flow) flowChanged(flow);
  return flow;
}

const clipS = (x, n) => (typeof x === 'string' && x.length > n ? x.slice(0, n) + `\n… [${x.length - n} chars más]` : x);
const EFFECT_RE = /^(create|add|edit|update|transition|delete|send|share|trash|copy|move|upload|post)/i;

/** Side effects seen in a run: files written by Claude, write-type MCP calls (Jira, Confluence, Drive…). */
function trackEffect(rs, use, res) {
  const name = use.name || '';
  if (['Write', 'Edit', 'NotebookEdit'].includes(name) && use.input?.file_path && !res.isError) {
    if (!rs.files.includes(use.input.file_path)) rs.files.push(use.input.file_path);
  } else if (name.startsWith('mcp__')) {
    const tool = name.split('__').pop();
    if (EFFECT_RE.test(tool)) {
      rs.actions.push({ tool, server: (name.split('__')[1] || '').replace(/^claude_ai_/, ''), ok: !res.isError, input: JSON.stringify(use.input || {}).slice(0, 600), result: String(res.content || '').slice(0, 400) });
    }
  }
}

function schemaErrors(step, json, log) {
  const { schema, error } = parseSchema(step.output?.schema);
  if (error) { log({ kind: 'error', text: `${error} (se omite la validación)` }); return []; }
  return schema ? validate(schema, json) : [];
}

async function summarize(text, signal, log) {
  log({ kind: 'tool_use', name: 'resumen (haiku)', input: { chars: text.length } });
  const r = await runClaude({
    systemPrompt: 'Resume el texto para que otro agente lo use como input. Conserva los datos concretos: ids, keys de Jira, números, nombres, decisiones y conclusiones. Máximo 15 líneas, sin preámbulo.',
    prompt: text.slice(0, 60000), model: 'haiku', tools: '', strictMcp: true, noPersist: true, cwd: os.homedir(), signal,
  });
  log({ kind: 'tool_result', content: (r.text || r.error || '').slice(0, 2000), isError: r.isError });
  return r.isError ? null : r.text.trim();
}

async function executeStep(flow, step, input, run, signal, upstream, opts = {}) {
  const data = opts.data || new Map();
  const rs = run.steps[step.id] = { status: 'running', startedAt: now(), events: [], output: '', files: [], actions: [] };
  const pending = new Map();
  const log = (ev) => {
    const e = { ...ev, t: now() };
    if (ev.kind === 'tool_use' && ev.id) pending.set(ev.id, { name: ev.name, input: ev.input });
    if (ev.kind === 'tool_result' && pending.has(ev.id)) trackEffect(rs, pending.get(ev.id), ev);
    if (ev.kind !== 'delta' && ev.kind !== 'thinking_delta') { rs.events.push(e); if (rs.events.length > 1500) rs.events.splice(0, 200); }
    emit({ type: 'run.event', flowId: flow.id, runId: run.id, stepId: step.id, event: e });
  };
  setStepRun(flow.id, step.id, { status: 'running', startedAt: rs.startedAt, endedAt: null, runId: run.id, error: null });
  emit({ type: 'step.status', flowId: flow.id, runId: run.id, stepId: step.id, status: 'running' });

  // Pinned output: the step is not executed (n8n-style "pin data"), downstream gets the frozen data.
  if (step.pinned && !opts.force) {
    log({ kind: 'hook_log', text: '📌 Salida fijada: este step no se ejecuta. Desfíjala en la pestaña Datos para volver a ejecutarlo.' });
    rs.status = 'success'; rs.pinned = true; rs.output = step.pinned.output || ''; rs.json = step.pinned.json; rs.inputView = { pinned: true };
    return finish();
  }

  const upMeta = upstream.map((u) => ({ name: u.name, chars: (u.output || '').length, json: u.json !== undefined && u.json !== null }));
  let hooks = {};
  try { hooks = loadHooks(step.hooks); } catch (e) { log({ kind: 'error', text: `Error compilando hooks: ${e.message}` }); }
  const ctx = hookCtx({ flow, step, run, input, signal, log, upstream });

  let output = ''; let json; let error = null; let sessionId = null;
  const wantsJson = step.output?.format === 'json';
  try {
    if (hooks.onStart) {
      log({ kind: 'hook', text: 'onStart' });
      const r = await hooks.onStart(ctx);
      if (r?.skip) { rs.status = 'skipped'; rs.output = r.output ?? input; return finish(); }
      if (typeof r?.input === 'string') ctx.input = r.input;
    }

    if (step.kind === 'command') {
      const up = upstream.map((u) => u.output || (u.json != null ? JSON.stringify(u.json, null, 2) : '')).filter(Boolean).join('\n\n');
      const upJson = Object.fromEntries(upstream.filter((u) => u.json != null).map((u) => [u.name, u.json]));
      const cmd = P.render(step.command, { flow, vars: flow.vars, input: ctx.input, upstream: up, data });
      rs.inputView = { kind: 'command', command: cmd, stdin: clipS(up || ctx.input || '', 20000), upstream: upMeta };
      log({ kind: 'tool_use', name: `shell:${step.shell}`, input: { cmd } });
      // stdin = output of previous steps (or the flow input for the first step)
      const r = await sh(cmd, { cwd: flowCwd(flow), shell: step.shell, input: up || ctx.input, env: { FLOW_INPUT: ctx.input || '', STEP_UPSTREAM: up, STEP_UPSTREAM_JSON: JSON.stringify(upJson) }, signal });
      log({ kind: 'tool_result', content: (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).slice(0, 8000), isError: r.code !== 0 });
      output = r.stdout.trim();
      if (r.code !== 0) error = `exit ${r.code}: ${r.stderr.slice(0, 2000)}`;
      else if (wantsJson) {
        const ex = P.extractJson(output);
        const errs = ex.error ? [ex.error] : schemaErrors(step, ex.json, log);
        if (errs.length) error = `Salida JSON inválida: ${errs.join('; ')}`; else json = ex.json;
      }
    } else {
      if ((step.input?.mode || 'full') === 'summary') {
        for (const u of upstream) {
          if ((u.output || '').length <= 1500) continue;
          const key = `${u.id}`;
          if (!opts.summaries?.has(key)) opts.summaries?.set(key, await summarize(u.output, signal, log));
          u.summary = opts.summaries?.get(key) || null;
        }
      }
      const prompt = P.runUserPrompt(flow, step, ctx.input, upstream, data);
      const system = P.runSystemPrompt(flow, step);
      rs.inputView = { kind: 'ai', mode: step.input?.mode || 'full', prompt: clipS(prompt, 40000), system: clipS(system, 20000), upstream: upMeta.map((m, i) => ({ ...m, summarized: !!upstream[i].summary })) };
      const common = {
        model: step.model || undefined, effort: step.effort || undefined,
        agent: step.kind === 'agent' && step.agentRef ? step.agentRef : undefined,
        permissionMode: step.permissionMode || undefined, allowedTools: step.allowedTools,
        cwd: flowCwd(flow), signal, onEvent: log,
      };
      const r = await runClaude({ prompt, appendSystem: system, ...common });
      sessionId = r.sessionId;
      const tags = P.extractTags(r.text);
      output = tags.clean;
      for (const m of tags.remember) addMemory(flow.id, step.id, m, 'run');
      if (r.isError) error = r.error || 'error';
      else if (wantsJson) {
        const ex = P.extractJson(output);
        const text = ex.error ? output : ex.text;
        let got = ex.json;
        let errs = ex.error ? [ex.error] : schemaErrors(step, ex.json, log);
        if (errs.length && sessionId && !signal?.aborted) {
          log({ kind: 'hook_log', text: `Salida JSON inválida (${errs[0]}). Pidiendo la corrección una vez…` });
          const r2 = await runClaude({ prompt: `Tu salida no cumple el formato JSON requerido:\n- ${errs.join('\n- ')}\n\nDevuelve SOLO el bloque ${'```'}json corregido.`, resume: sessionId, ...common });
          const ex2 = P.extractJson(P.extractTags(r2.text).clean);
          errs = ex2.error ? [ex2.error] : schemaErrors(step, ex2.json, log);
          got = ex2.json;
        }
        if (errs.length) error = `Salida JSON inválida: ${errs.join('; ')}`;
        else { json = got; output = text; }
      }
    }
    ctx.output = output; ctx.json = json;
    if (error) {
      ctx.error = error;
      if (hooks.onFailure) { log({ kind: 'hook', text: 'onFailure' }); await hooks.onFailure(ctx); }
    } else if (hooks.onSuccess) {
      log({ kind: 'hook', text: 'onSuccess' });
      const r = await hooks.onSuccess(ctx);
      if (typeof r === 'string') output = r;
      else if (r && typeof r === 'object') { if (typeof r.output === 'string') output = r.output; if ('json' in r) json = r.json; }
    }
  } catch (e) {
    error = e.message;
    log({ kind: 'error', text: `Hook/step error: ${e.message}` });
  }
  rs.status = error ? (signal?.aborted ? 'stopped' : 'error') : 'success';
  rs.output = output; rs.json = json; rs.error = error; rs.sessionId = sessionId;
  return finish();

  function finish() {
    rs.endedAt = now();
    const jsonFits = rs.json === undefined || JSON.stringify(rs.json).length < 300000;
    setStepRun(flow.id, step.id, {
      status: rs.status, endedAt: rs.endedAt, output: rs.output, json: jsonFits ? rs.json : undefined, files: rs.files, actions: rs.actions,
      pinned: !!rs.pinned, error: rs.error || null, sessionId: rs.sessionId || null,
    });
    emit({ type: 'step.status', flowId: flow.id, runId: run.id, stepId: step.id, status: rs.status });
    store.saveRun(run);
    return rs;
  }
}

/** Freeze a step's output: full runs reuse it instead of executing the step. */
export function pinStep(flowId, stepId, body = {}) {
  const flow = store.updateFlow(flowId, (f) => {
    const s = f.steps.find((x) => x.id === stepId);
    if (!s) throw new Error('Step no encontrado');
    if (body.fromLast) {
      if (!s.lastRun || (!s.lastRun.output && s.lastRun.json === undefined)) throw new Error('El step todavía no tiene una salida para fijar');
      s.pinned = { output: s.lastRun.output || '', json: s.lastRun.json, at: now(), source: 'last', runId: s.lastRun.runId };
    } else {
      s.pinned = { output: String(body.output ?? ''), json: body.json === undefined ? undefined : body.json, at: now(), source: 'edited' };
    }
  });
  flowChanged(flow);
  return flow;
}
export function unpinStep(flowId, stepId) {
  const flow = store.updateFlow(flowId, (f) => { const s = f.steps.find((x) => x.id === stepId); if (s) delete s.pinned; });
  flowChanged(flow);
  return flow;
}

/** Run the whole flow (or a single step with `only`). Returns runId immediately. */
export function startRun(flowId, { input = '', only = null, trigger = 'manual' } = {}) {
  const flow = store.getFlow(flowId);
  if (!flow) throw new Error('Flujo no encontrado');
  const levels = only ? [[only]] : topoLevels(flow);
  const run = { id: store.uid('r_'), flowId, input, only, trigger, status: 'running', startedAt: now(), steps: {} };
  const controller = new AbortController();
  activeRuns.set(run.id, { controller, flowId });
  store.saveRun(run);
  emit({ type: 'run.started', flowId, runId: run.id, only, trigger });

  (async () => {
    const data = new Map(); // stepId -> { output, json, files, actions } produced in this run
    const summaries = new Map();
    const failed = new Set();
    try {
      for (const level of levels) {
        const queue = [...level];
        const worker = async () => {
          while (queue.length && !controller.signal.aborted) {
            const id = queue.shift();
            const fresh = store.getFlow(flowId);
            const step = fresh.steps.find((s) => s.id === id);
            if (!step) continue;
            const ups = fresh.edges.filter((e) => e.target === id).map((e) => e.source);
            if (!only && ups.some((u) => failed.has(u))) {
              failed.add(id);
              run.steps[id] = { status: 'skipped', output: '', events: [{ kind: 'error', text: 'Omitido: falló un step anterior.', t: now() }] };
              setStepRun(flowId, id, { status: 'skipped', endedAt: now(), runId: run.id });
              emit({ type: 'step.status', flowId, runId: run.id, stepId: id, status: 'skipped' });
              continue;
            }
            const upstream = ups.map((u) => {
              const s = fresh.steps.find((x) => x.id === u);
              const d = data.get(u) || (s ? P.stepData(s) : { output: '' });
              return { id: u, name: s?.name || u, output: d.output || '', json: d.json };
            });
            const r = await executeStep(fresh, step, input, run, controller.signal, upstream, { data, summaries, force: !!only });
            data.set(id, { output: r.output, json: r.json, files: r.files || [], actions: r.actions || [] });
            if (r.status === 'error' || r.status === 'stopped') failed.add(id);
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));
        if (controller.signal.aborted) break;
      }
      run.status = controller.signal.aborted ? 'stopped' : failed.size ? 'error' : 'success';
    } catch (e) {
      run.status = 'error'; run.error = e.message;
    }
    run.endedAt = now();
    store.saveRun(run);
    activeRuns.delete(run.id);
    emit({ type: 'run.finished', flowId, runId: run.id, status: run.status, error: run.error });
  })();
  return run.id;
}

export function stopRuns(flowId) {
  let n = 0;
  for (const [, r] of activeRuns) if (r.flowId === flowId) { r.controller.abort(); n++; }
  for (const [k, c] of activeChats) if (k.startsWith(flowId + ':')) { c.abort(); n++; }
  return n;
}
export const isRunning = (flowId) => [...activeRuns.values()].some((r) => r.flowId === flowId);

// ---------- chats ----------
async function chatTurn({ flowId, key, message, origin = 'direct', improve = false, mirrorKey = null }) {
  const flow = store.getFlow(flowId);
  const isFlow = key === '_flow';
  const step = isFlow ? null : flow.steps.find((s) => s.id === key);
  if (!isFlow && !step) throw new Error('Step no encontrado');

  const userMsg = store.appendChat(flowId, key, { id: store.uid('c_'), role: 'user', text: message, at: now(), origin });
  emit({ type: 'chat.message', flowId, key, message: userMsg });
  const asst = { id: store.uid('c_'), role: 'assistant', text: '', at: now(), origin, events: [], status: 'running', proposals: [], remembered: [] };
  store.appendChat(flowId, key, asst);
  emit({ type: 'chat.message', flowId, key, message: asst });

  const controller = new AbortController();
  const ck = `${flowId}:${key}`;
  activeChats.get(ck)?.abort();
  activeChats.set(ck, controller);

  // Context: send full block only when it changed since this session last saw it.
  const sessionId = isFlow ? flow.globalSessionId : step.chatSessionId;
  const lastHash = isFlow ? flow.globalContextHash : step.chatContextHash;
  const block = isFlow ? P.flowContextBlock(flow) : P.stepContextBlock(flow, step);
  const parts = [];
  if (!sessionId || block.hash !== lastHash) parts.push(block.text);
  else parts.push(isFlow ? '<flow-context>(sin cambios desde el último mensaje)</flow-context>' : '<step-context>(sin cambios desde el último mensaje)</step-context>');
  if (!isFlow) {
    const rel = P.relatedMemory(flow, step, message);
    if (rel.length) parts.push(`<related-memory>\n${rel.map((r) => `- [${r.step}] ${r.text}`).join('\n')}\n</related-memory>`);
    if (improve) parts.push('<mode>modo mejora ACTIVO: puedes editar los archivos de la skill/agente de este step.</mode>');
  }
  if (origin === 'global') parts.push('(Este mensaje llegó desde el chat general y fue enrutado a ti.)');
  parts.push(message);

  let allowedTools = isFlow ? 'Read Grep Glob WebFetch WebSearch Skill' : step.allowedTools;
  const addDirs = [];
  let permissionMode;
  if (improve && step) {
    const ref = step.kind === 'skill' ? findSkill(step.skillRef, flow.cwd) : step.kind === 'agent' ? findAgent(step.agentRef, flow.cwd) : null;
    if (ref) addDirs.push(path.dirname(ref.path));
    allowedTools = `${allowedTools || ''} Edit Write`;
    permissionMode = 'acceptEdits';
  }

  const keys = [key, ...(mirrorKey ? [mirrorKey] : [])];
  const onEvent = (ev) => {
    const e = { ...ev, t: now() };
    if (ev.kind !== 'delta' && ev.kind !== 'thinking_delta') asst.events.push(e);
    for (const k of keys) emit({ type: 'chat.event', flowId, key: k, messageId: asst.id, event: e, mirrorOf: k !== key ? key : undefined });
  };

  let r = await runClaude({
    prompt: parts.join('\n\n'),
    appendSystem: isFlow ? P.flowChatSystem() : P.stepChatSystem(),
    model: step?.model || undefined,
    effort: step?.effort || undefined,
    agent: step?.kind === 'agent' && step.agentRef ? step.agentRef : undefined,
    resume: sessionId || undefined,
    allowedTools, addDirs, permissionMode,
    cwd: flowCwd(flow), signal: controller.signal, onEvent,
  });
  // Resumed session may have been deleted/expired: retry once fresh with the full context.
  if (r.isError && sessionId && !controller.signal.aborted && /session|conversation/i.test(r.error || '')) {
    onEvent({ kind: 'hook_log', text: 'Sesión anterior no disponible; iniciando una nueva.' });
    parts[0] = block.text;
    r = await runClaude({ prompt: parts.join('\n\n'), appendSystem: isFlow ? P.flowChatSystem() : P.stepChatSystem(), model: step?.model || undefined, agent: step?.kind === 'agent' && step.agentRef ? step.agentRef : undefined, allowedTools, addDirs, permissionMode, cwd: flowCwd(flow), signal: controller.signal, onEvent });
  }
  activeChats.delete(ck);

  const tags = P.extractTags(r.text);
  asst.text = tags.clean || (r.isError ? `⚠️ ${r.error || 'Error'}` : '');
  asst.status = r.isError ? 'error' : 'done';
  asst.proposals = tags.updates.map((u) => ({ id: store.uid('p_'), patch: u, applied: false }));
  for (const m of tags.remember) { addMemory(flowId, isFlow ? '_flow' : key, m, 'chat'); asst.remembered.push(m); }
  store.updateChatMsg(flowId, key, asst.id, (m) => Object.assign(m, asst));

  const updated = store.updateFlow(flowId, (f) => {
    if (isFlow) { if (r.sessionId) f.globalSessionId = r.sessionId; f.globalContextHash = block.hash; }
    else {
      const s = f.steps.find((x) => x.id === key);
      if (s) { if (r.sessionId) s.chatSessionId = r.sessionId; s.chatContextHash = block.hash; }
    }
  });
  if (updated) flowChanged(updated);
  for (const k of keys) emit({ type: 'chat.done', flowId, key: k, message: asst });
  return asst;
}

export function stepChat(flowId, key, message, opts = {}) {
  return chatTurn({ flowId, key, message, ...opts });
}

export async function applyProposal(flowId, key, messageId, proposalId) {
  const msg = store.getChat(flowId, key).find((m) => m.id === messageId);
  const p = msg?.proposals?.find((x) => x.id === proposalId);
  if (!p || p.patch.__invalid) throw new Error('Propuesta inválida');
  const allowed = ['role', 'task', 'context', 'allowedTools', 'model', 'effort', 'permissionMode', 'hooks', 'name', 'command', 'shell'];
  const flow = store.updateFlow(flowId, (f) => {
    const s = f.steps.find((x) => x.id === key);
    if (s) for (const k of allowed) if (k in p.patch) s[k] = p.patch[k];
  });
  store.updateChatMsg(flowId, key, messageId, (m) => { const q = m.proposals.find((x) => x.id === proposalId); if (q) q.applied = true; });
  flowChanged(flow);
  return flow;
}

/** General chat: route the message to a step / the flow, or trigger runs. */
export async function globalChat(flowId, message) {
  const key = '_global';
  const flow = store.getFlow(flowId);
  const history = store.getChat(flowId, key);
  const userMsg = store.appendChat(flowId, key, { id: store.uid('c_'), role: 'user', text: message, at: now() });
  emit({ type: 'chat.message', flowId, key, message: userMsg });

  const routing = { id: store.uid('c_'), role: 'router', text: 'Decidiendo quién responde…', at: now(), status: 'running', events: [] };
  store.appendChat(flowId, key, routing);
  emit({ type: 'chat.message', flowId, key, message: routing });

  let decision = null;
  if (flow.steps.length) {
    const r = await runClaude({
      systemPrompt: P.routerSystem(), prompt: P.routerPrompt(flow, history, message),
      model: 'haiku', tools: '', strictMcp: true, noPersist: true, cwd: os.homedir(),
      onEvent: (ev) => { if (ev.kind === 'result' || ev.kind === 'error') routing.events.push({ ...ev, t: now() }); },
    });
    decision = P.parseJsonLoose(r.text);
  }
  if (!decision || (decision.target !== 'flow' && !flow.steps.some((s) => s.id === decision.target))) {
    decision = { action: 'ask', target: 'flow', reason: flow.steps.length ? 'No se pudo determinar un step; responde el flujo general.' : 'El flujo no tiene steps todavía.', message };
  }
  const targetStep = flow.steps.find((s) => s.id === decision.target);
  const targetName = targetStep ? targetStep.name : 'Flujo general';
  routing.status = 'done';
  routing.decision = decision;
  routing.text = `→ ${decision.action === 'ask' ? 'Responde' : decision.action === 'run_step' ? 'Ejecutar step' : 'Ejecutar flujo'}: **${decision.action === 'run_flow' ? flow.name : targetName}** — ${decision.reason || ''}`;
  store.updateChatMsg(flowId, key, routing.id, (m) => Object.assign(m, routing));
  emit({ type: 'chat.done', flowId, key, message: routing });

  if (decision.action === 'run_flow' || (decision.action === 'run_step' && targetStep)) {
    const runId = startRun(flowId, { input: decision.input || '', only: decision.action === 'run_step' ? targetStep.id : null, trigger: 'chat' });
    const m = store.appendChat(flowId, key, { id: store.uid('c_'), role: 'assistant', text: `Ejecución iniciada (${runId}). Sigue el progreso en el canvas y en la pestaña Actividad.`, at: now(), status: 'done', routedTo: targetName });
    emit({ type: 'chat.message', flowId, key, message: m });
    return m;
  }

  // Answer through the target's own chat session (keeps per-step context & memory), mirrored here.
  const targetKey = targetStep ? targetStep.id : '_flow';
  const mirror = { id: store.uid('c_'), role: 'assistant', text: '', at: now(), status: 'running', routedTo: targetName, routedKey: targetKey, events: [] };
  store.appendChat(flowId, key, mirror);
  emit({ type: 'chat.message', flowId, key, message: mirror });
  const relay = (msg) => {
    if (msg.type === 'chat.event' && msg.flowId === flowId && msg.key === key && msg.mirrorOf === targetKey) {
      if (msg.event.kind !== 'delta' && msg.event.kind !== 'thinking_delta') mirror.events.push(msg.event);
      emit({ type: 'chat.event', flowId, key, messageId: mirror.id, event: msg.event, relayed: true });
    }
  };
  bus.on('msg', relay);
  try {
    const ans = await chatTurn({ flowId, key: targetKey, message: decision.message || message, origin: 'global', mirrorKey: key });
    Object.assign(mirror, { text: ans.text, status: ans.status, proposals: ans.proposals, remembered: ans.remembered, originMessageId: ans.id });
  } catch (e) {
    Object.assign(mirror, { text: `⚠️ ${e.message}`, status: 'error' });
  } finally {
    bus.off('msg', relay);
  }
  store.updateChatMsg(flowId, key, mirror.id, (m) => Object.assign(m, mirror));
  emit({ type: 'chat.done', flowId, key, message: mirror });
  return mirror;
}

// ---------- external helpers ----------
/** Resolves when the run finishes (or after timeoutMs with status 'running'). */
export function waitRun(flowId, runId, timeoutMs = 15 * 60000) {
  return new Promise((resolve) => {
    const finished = () => { const r = store.getRun(flowId, runId); return r && r.status !== 'running' ? r : null; };
    const already = finished();
    if (already) return resolve(already);
    const onMsg = (m) => { if (m.type === 'run.finished' && m.runId === runId) { cleanup(); resolve(store.getRun(flowId, runId)); } };
    const timer = setTimeout(() => { cleanup(); resolve(store.getRun(flowId, runId)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); bus.off('msg', onMsg); };
    bus.on('msg', onMsg);
  });
}

/** Compact, caller-friendly view of a run: per-step outputs + final result (outputs of the last steps). */
export function runSummary(flow, run) {
  if (!run) return null;
  const name = (id) => flow.steps.find((s) => s.id === id)?.name || id;
  const steps = Object.entries(run.steps || {}).map(([id, s]) => ({ step: name(id), status: s.status, output: s.output || '', json: s.json, files: s.files?.length ? s.files : undefined, actions: s.actions?.length ? s.actions : undefined, pinned: s.pinned || undefined, error: s.error || undefined }));
  const sinks = run.only ? [run.only] : flow.steps.filter((s) => !flow.edges.some((e) => e.source === s.id)).map((s) => s.id);
  const result = sinks.map((id) => run.steps?.[id]).filter((s) => s?.output).map((s) => s.output).join('\n\n---\n\n');
  const sinkJson = sinks.map((id) => run.steps?.[id]?.json).filter((j) => j !== undefined);
  return { flow: flow.name, flowId: flow.id, runId: run.id, status: run.status, trigger: run.trigger, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error, result, json: sinkJson.length === 1 ? sinkJson[0] : sinkJson.length ? sinkJson : undefined, steps };
}

/** Builds a flow from a natural-language description, using the user's skills/agents catalog. */
export async function generateFlow(description, catalog) {
  const sys = `Diseñas flujos de agentes de IA. Devuelve SOLO JSON válido (sin texto, sin bloques de código) con esta forma:
{"name":"...","description":"...","vars":{"clave":"valor de ejemplo"},
 "steps":[{"key":"a","name":"Nombre corto","kind":"role|skill|agent|command","skillRef":"","agentRef":"","role":"quién es y cómo trabaja","task":"qué hace en cada ejecución; puede usar {{input}} y {{vars.x}}","command":"","shell":"powershell","access":"read|atlassian-read|atlassian|edit|dev|none"}],
 "edges":[["a","b"]]}
Reglas:
- Usa kind "skill" con skillRef EXACTO del catálogo cuando una skill encaje; "agent" con agentRef exacto si un agente encaja; si no, "role".
- "command" solo para comandos de shell concretos (tests, git, scripts).
- access: read (por defecto), atlassian-read (leer Jira/Confluence), atlassian (escribir en Jira/Confluence), edit (editar archivos), dev (editar + Bash), none.
- 2 a 7 steps, nombres cortos en español, edges sin ciclos; steps independientes pueden ir en paralelo.`;
  const cat = `Skills disponibles:\n${catalog.skills.map((s) => `- ${s.name}: ${s.description.slice(0, 140)}`).join('\n')}\n\nAgentes disponibles:\n${catalog.agents.map((a) => `- ${a.name}: ${a.description.slice(0, 140)}`).join('\n') || '(ninguno)'}`;
  const r = await runClaude({ systemPrompt: sys, prompt: `${cat}\n\nFlujo que quiere el usuario:\n${description}`, model: 'sonnet', tools: '', strictMcp: true, noPersist: true, cwd: os.homedir() });
  const spec = P.parseJsonLoose(r.text);
  if (!spec?.steps?.length) throw new Error(`No se pudo generar el flujo${r.error ? `: ${r.error}` : ''}`);
  const flow = store.newFlow(spec.name || 'Flujo generado');
  flow.description = spec.description || description;
  flow.vars = spec.vars && typeof spec.vars === 'object' ? spec.vars : {};
  const ids = {};
  for (const s of spec.steps) {
    const acc = ACCESS[s.access] || ACCESS.read;
    const step = store.newStep({
      name: s.name || 'Step', kind: ['role', 'skill', 'agent', 'command'].includes(s.kind) ? s.kind : 'role',
      skillRef: s.skillRef || '', agentRef: s.agentRef || '', role: s.role || '', task: s.task || '',
      command: s.command || '', shell: s.shell || 'powershell', allowedTools: acc.tools, permissionMode: acc.perm,
    });
    ids[s.key ?? step.name] = step.id;
    flow.steps.push(step);
  }
  for (const [a, b] of spec.edges || []) if (ids[a] && ids[b] && ids[a] !== ids[b]) flow.edges.push({ id: store.uid('e_'), source: ids[a], target: ids[b] });
  try { topoLevels(flow); } catch { flow.edges = []; }
  return store.saveFlow(flow);
}

const READ = 'Read Grep Glob WebFetch WebSearch Skill';
const RA = 'mcp__claude_ai_Atlassian_Rovo';
export const ACCESS = {
  read: { tools: READ, perm: '' },
  'atlassian-read': { tools: `${READ} ${RA}__getAccessibleAtlassianResources ${RA}__getJiraIssue ${RA}__searchJiraIssuesUsingJql ${RA}__getConfluencePage ${RA}__searchConfluenceUsingCql ${RA}__search ${RA}__fetch`, perm: '' },
  atlassian: { tools: `${READ} ${RA}`, perm: '' },
  edit: { tools: `${READ} Edit Write`, perm: 'acceptEdits' },
  dev: { tools: `${READ} Edit Write Bash`, perm: 'acceptEdits' },
  none: { tools: '', perm: '' },
};

// ---------- schedules ----------
const timers = new Map();
export function syncSchedule(flow) {
  clearInterval(timers.get(flow.id));
  timers.delete(flow.id);
  const s = flow.schedule;
  if (s?.enabled && Number(s.everyMinutes) >= 1) {
    timers.set(flow.id, setInterval(() => {
      if (!isRunning(flow.id)) { try { startRun(flow.id, { input: s.input || '', trigger: 'schedule' }); } catch {} }
    }, Number(s.everyMinutes) * 60000));
  }
}
export function clearSchedule(flowId) { clearInterval(timers.get(flowId)); timers.delete(flowId); }
