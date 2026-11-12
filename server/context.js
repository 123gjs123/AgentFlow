// Context box (spec 17 CTX): what a step would send to the model NOW, assembled by the same functions the engine
// uses, split into labelled sections. Pure: no claude process, no memory write, no Haiku summary, no run file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import * as P from './prompt.js';
import { parseSchema } from './schema.js';
import { findAgent, findSkill } from './catalog.js';
import { buildArgs, lastInit } from './claude.js';
import { cliOptions, ancestorsOf, evalAssertion } from './engine.js';

const est = (n) => Math.ceil(n / 4);
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars más]` : s || '');
const SECRET_NAME = /token|secret|password|passwd|apikey|api_key|pwd|credential/i;

function readDefinition(step, flow) {
  const kind = step.kind === 'skill' ? 'skill' : step.kind === 'agent' ? 'agent' : null;
  if (!kind) return null;
  const ref = kind === 'skill' ? step.skillRef : step.agentRef;
  const hit = ref ? (kind === 'skill' ? findSkill(ref, flow.cwd) : findAgent(ref, flow.cwd)) : null;
  if (!hit) return { kind, ref, found: false };
  let txt = '';
  try { txt = fs.readFileSync(hit.path, 'utf8'); } catch {}
  const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = {};
  if (fm) for (const line of fm[1].split(/\r?\n/)) { const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/); if (kv) frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, ''); }
  const body = fm ? txt.slice(fm[0].length) : txt;
  const lines = body.split(/\r?\n/);
  return {
    kind, ref, found: true, name: hit.name, description: hit.description, path: hit.path, source: hit.source, frontmatter,
    excerpt: lines.slice(0, 40).join('\n'), lines: lines.length, chars: txt.length,
    note: kind === 'skill'
      ? 'Claude Code siempre lista el nombre y la descripción de la skill. El cuerpo del SKILL.md entra al contexto solo cuando el step invoca la herramienta Skill (el prompt de sistema se lo pide).'
      : 'El cuerpo del archivo del agente es su prompt de sistema (--agent); nuestro prompt se agrega después. Las herramientas son las del agente: --tools no se aplica.',
  };
}

function claudeCodeSection(flow) {
  const cwd = flow.cwd && fs.existsSync(flow.cwd) ? flow.cwd : os.homedir();
  const files = [path.join(os.homedir(), '.claude', 'CLAUDE.md'), path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')]
    .filter((f, i, a) => a.indexOf(f) === i)
    .map((f) => { try { const st = fs.statSync(f); return { path: f, chars: st.size }; } catch { return null; } })
    .filter(Boolean);
  const text = [
    'Claude Code agrega por su cuenta (no lo controla esta app y no se mide exacto):',
    '- su prompt de sistema base (herramientas, entorno, fecha, estado de git)',
    ...files.map((f) => `- ${f.path} (${f.chars.toLocaleString()} caracteres)`),
    '- la lista de skills disponibles (nombre + descripción)',
    '- las definiciones de herramientas de los MCP conectados',
    '- memoria automática y hooks propios de Claude Code, si los tienes configurados',
  ].join('\n');
  return { section: { id: 'claudeCode', label: 'Lo agrega Claude Code', source: 'Claude Code', toModel: 'claude-code', text }, knownChars: files.reduce((n, f) => n + f.chars, 0), files };
}

/**
 * Preview of a step invocation.
 * opts: { draft?: partial step (not saved), target?: 'run'|'chat', sample?: { mode: 'ui'|'external', input?, vars?, runId? } }
 */
export function previewStep(flowId, stepId, { draft = null, target = 'run', sample = {} } = {}) {
  const stored = store.getFlow(flowId);
  if (!stored) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  const base = stored.steps.find((s) => s.id === stepId);
  if (!base) throw Object.assign(new Error('Step no encontrado'), { status: 404 });
  const step = { ...base, ...(draft && typeof draft === 'object' ? draft : {}), id: base.id, memory: base.memory, pinned: base.pinned, lastRun: base.lastRun };
  const flow = { ...stored, steps: stored.steps.map((s) => (s.id === stepId ? step : s)) };
  const warnings = [];
  const warn = (code, message, section) => warnings.push({ code, message, section });
  const mode = sample.mode === 'external' ? 'external' : 'ui';

  // Sample data: a past run (exact reproduction) or what a run would use now.
  const run = sample.runId ? store.getRun(flowId, sample.runId) : null;
  if (sample.runId && !run) throw Object.assign(new Error('Ejecución no encontrada'), { status: 404 });
  const lastRunInput = base.lastRun?.runId ? store.getRun(flowId, base.lastRun.runId)?.input : '';
  const input = sample.input ?? (run ? run.input : lastRunInput) ?? '';
  const vars = run ? { ...(run.vars || {}) } : { ...(flow.vars || {}), ...(sample.vars || {}) };
  const rflow = { ...flow, vars };
  const data = new Map();
  if (run) for (const [id, rs] of Object.entries(run.steps || {})) if (rs.status === 'success' || (rs.status === 'skipped' && rs.skipReason === 'hook')) data.set(id, { output: rs.output, json: rs.json, files: rs.files || [], actions: rs.actions || [], source: rs.pinned ? 'pinned' : 'run', fromRunId: run.id });

  const inEdges = flow.edges.filter((e) => e.target === stepId);
  const max = Number(step.input?.maxChars) || 12000;
  // Same arrow rules as the engine (spec 18): inactive arrows carry nothing; pick/route payloads replace the output.
  const upstream = inEdges.map((edge) => {
    const u = edge.source;
    const s = flow.steps.find((x) => x.id === u);
    let d; let note;
    if (data.has(u)) d = { ...data.get(u), source: data.get(u).source };
    else {
      d = s ? P.stepData(s, null, null, { usePins: mode !== 'external' }) : { output: '', source: 'none' };
      if (d.source === 'none') note = 'todavía no tiene una salida exitosa: el step recibiría "(sin salida)"';
      // External runs ignore the pin and execute the step: what it receives is produced in that run.
      if (mode === 'external' && s?.pinned) note = `se ejecutará: la salida real no se conoce aún${d.source === 'none' ? '' : ' (ejemplo: su última salida)'}`;
    }
    if ((d.output || '').length > max) warn('UPSTREAM_TRUNCATED', `"${s?.name || u}" entrega ${(d.output || '').length.toLocaleString()} caracteres; se recortan a ${max.toLocaleString()} ("máx. caracteres").`, 'upstream');
    const summaryState = step.input?.mode === 'summary' && (d.output || '').length > 1500 ? 'pending' : undefined;
    // In a full run, an upstream that is not pinned runs fresh: its data comes from 'run'. The preview uses its last output as a SAMPLE
    // but labels the prompt as the engine would (no '(de una ejecución anterior)' header that a real run never has).
    const willRun = !data.has(u) && d.source !== 'pinned';
    const routes = run ? run.steps?.[u]?.routes : s?.lastRun?.routes;
    const ep = P.edgePayload(edge, { ...d, routes }, step, evalAssertion);
    if (!ep.active) { warn('EDGE_INACTIVE', `Con los datos de ejemplo la flecha desde "${s?.name || u}" no pasa: ${ep.reason}. En una ejecución real se decide con la salida de ese momento.`, 'upstream'); return null; }
    if (ep.warning) warn('EDGE_PICK_MISSING', `Flecha desde "${s?.name || u}": ${ep.warning}.`, 'upstream');
    return { id: u, name: s?.name || u, output: ep.output || '', json: ep.json, source: willRun ? 'run' : d.source, origin: d.source, sample: willRun, fromRunId: d.fromRunId || null, at: d.at || null, note, summaryState, via: P.edgeVia(edge) || (ep.routed ? 'elegido por el step' : ''), edgeId: edge.id };
  }).filter(Boolean);
  if (upstream.some((u) => u.summaryState === 'pending')) warn('SUMMARY_PENDING', 'Modo resumen: las salidas largas se resumirán con Haiku al ejecutar; aquí se ve el texto original recortado.', 'upstream');

  const refs = [];
  const pinsUsed = [];
  const ancestors = ancestorsOf(flow, stepId);
  const rctx = (strict) => ({ runId: run?.id, refs, allowed: strict && !step.input?.allowNonUpstream ? ancestors : null, usePins: mode !== 'external', onPinned: (n) => pinsUsed.push(n) });

  const result = { kind: step.kind, target, sample: { mode, runId: run?.id || null, input }, warnings, upstream: upstream.map(({ output, json, source, origin, sample, summaryState, ...u }) => ({ ...u, source: sample ? origin : source, sample, summary: summaryState, chars: (output || '').length, hasJson: json !== undefined && json !== null })), refs };

  // ---- chat target (spec 17 CTX-14) ----
  if (target === 'chat') {
    const block = P.stepContextBlock(flow, step);
    const system = P.stepChatSystem();
    result.chat = { system, block: block.text, hash: block.hash, willResend: !base.chatSessionId || block.hash !== base.chatContextHash };
    result.sections = [
      { id: 'chatSystem', label: 'Instrucciones del chat (fijas)', source: 'app', toModel: 'system', text: system },
      { id: 'stepContext', label: `Bloque <step-context> ${result.chat.willResend ? '(se reenvía completo en el próximo mensaje)' : '(sin cambios: no se reenvía)'}`, source: 'config del step + última ejecución + memoria', toModel: 'user', text: block.text },
      { id: 'relatedMemory', label: 'Memoria relacionada de otros steps', source: 'según tu mensaje', toModel: 'user', text: 'Hasta 6 hechos de la memoria de otros steps que coincidan con las palabras de tu mensaje (se calcula al enviar).' },
    ];
  }

  // ---- command step ----
  else if (step.kind === 'command') {
    const up = upstream.map((u) => u.output || (u.json != null ? JSON.stringify(u.json, null, 2) : '')).filter(Boolean).join('\n\n');
    const q = P.shellQuoter(step.shell, step.command);
    let rendered = '';
    const raws = [];
    const quoted = P.placeholdersInSingleQuotes(step.command, step.shell);
    if (quoted.length) warn('TEMPLATE_IN_SINGLE_QUOTES', `{{${quoted[0]}}} está entre comillas simples: al ejecutar el step fallará.`, 'command');
    try { rendered = P.render(step.command, { flow: rflow, vars, input, upstream: up, data, ...rctx(true), quote: q.quote, onRaw: (k) => raws.push(k) }); }
    catch (e) { if (!e.refError) throw e; warn('NON_UPSTREAM_REF', e.message, 'command'); rendered = P.render(step.command, { flow: rflow, vars, input, upstream: up, data, ...rctx(false), quote: q.quote, onRaw: (k) => raws.push(k) }); }
    for (const k of raws) warn('RAW_TEMPLATE', `{{{${k}}}} se inserta sin protección: una ejecución externa con datos de fuera se rechaza (422).`, 'command');
    result.command = { rendered, shell: step.shell || 'powershell', env: q.values, stdin: clip(up || input || '', 4000), envUpstream: { STEP_UPSTREAM: up.length, FLOW_INPUT: (input || '').length } };
    result.sections = [{ id: 'command', label: `Comando (${step.shell || 'powershell'})`, source: 'step.command', toModel: 'none', text: `${rendered}\n\n${q.values.map((v) => `${v.name} = {{${v.ref}}} → ${v.value}`).join('\n') || '(sin valores insertados)'}` }];
  }

  // ---- AI step ----
  else {
    let sys; let usr;
    try { sys = P.systemSections(rflow, step, rctx(true)); usr = P.userSections(rflow, step, input, upstream, data, rctx(true)); }
    catch (e) {
      if (!e.refError) throw e;
      warn('NON_UPSTREAM_REF', e.message, 'task');
      refs.length = 0;
      sys = P.systemSections(rflow, step, rctx(false)); usr = P.userSections(rflow, step, input, upstream, data, rctx(false));
    }
    const system = sys.map((s) => s.text).join('\n\n');
    const user = usr.map((s) => s.text).join('\n\n');
    result.system = system; result.user = user;
    const cli = cliOptions(step);
    const args = buildArgs({ ...cli, appendSystem: system }, (k) => (k === 'append' ? '<system>' : '<file>'));
    const builtins = cli.tools === undefined ? null : cli.tools ? cli.tools.split(',') : [];
    const allowed = (String(step.allowedTools || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || []);
    result.cli = { model: cli.model || null, effort: cli.effort || null, permissionMode: cli.permissionMode || null, agent: cli.agent || null, tools: cli.tools ?? null, allowedTools: allowed, args };
    result.mcp = lastInit.at ? { servers: lastInit.mcpServers.map((m) => ({ name: m.name, status: m.status })), probedAt: lastInit.at } : { servers: null, probedAt: null };
    const def = readDefinition(step, flow);
    result.definition = def;
    if (def && !def.found) warn(def.kind === 'skill' ? 'SKILL_NOT_FOUND' : 'AGENT_NOT_FOUND', `${def.kind === 'skill' ? 'La skill' : 'El agente'} "${def.ref || '(sin elegir)'}" no está en el catálogo: Claude Code no lo encontrará.`, 'definition');
    const cc = claudeCodeSection(flow);
    const accessText = [
      builtins === null ? 'Herramientas integradas: las del agente (su archivo define tools; --tools no se aplica).' : `Herramientas integradas disponibles (--tools): ${builtins.join(', ') || 'ninguna'}`,
      `Pre-aprobadas (--allowedTools): ${allowed.join(', ') || 'ninguna'}`,
      `Modo de permisos: ${cli.permissionMode || 'por defecto'}${cli.model ? ` · modelo ${cli.model}` : ''}${cli.effort ? ` · effort ${cli.effort}` : ''}`,
      'Todo lo demás pide permiso y, al ejecutar sin interacción, se deniega: el step falla con PERMISSION_DENIED salvo que actives "Permitir permisos denegados".',
      `MCP: ${result.mcp.servers ? result.mcp.servers.map((m) => `${m.name} (${m.status})`).join(', ') || 'ninguno conectado' : 'sin datos aún (usa "Comprobar")'}. Las herramientas MCP no las limita --tools: dependen de "Tools permitidas" y del modo de permisos.`,
      '', `claude ${args.join(' ')}`,
    ].join('\n');
    const sections = [...sys, ...usr];
    if (def?.found) sections.push({ id: 'definition', label: `${def.kind === 'skill' ? 'Skill' : 'Agente'}: ${def.name}`, source: `${def.kind}:${def.name} (${def.source})`, toModel: 'claude-code', text: `${def.description || ''}\n\n${def.note}\n\n${def.path}\n\n${def.excerpt}${def.lines > 40 ? `\n… (${def.lines - 40} líneas más: "Ver archivo completo")` : ''}` });
    sections.push(cc.section);
    sections.push({ id: 'access', label: 'Acceso y herramientas', source: 'step.allowedTools / permisos / modelo', toModel: 'cli', text: accessText });
    result.sections = sections;
    result.totals = { ours: { chars: system.length + user.length, tokensEst: est(system.length + user.length) }, claudeCodeKnownChars: cc.knownChars };
    if (system.length + user.length > 100000) warn('LARGE_PROMPT', `El prompt de esta app ocupa ${(system.length + user.length).toLocaleString()} caracteres: considera modo "solo JSON", "resumen" o referencias.`, 'upstream');
    for (const s of usr.concat(sys)) for (const m of s.text.matchAll(/\{\{\s*steps\.([^{}]+?)\s*\}\}/g)) warn('UNRESOLVED_REF', `{{steps.${m[1]}}} no corresponde a ningún step: quedará tal cual en el prompt.`, s.id);
    for (const [k, v] of Object.entries(vars)) {
      const tokenLike = SECRET_NAME.test(k) || (typeof v === 'string' && v && v === store.getConfig().token);
      if (tokenLike) warn('SECRET_IN_PROMPT', `La variable "${k}" parece un secreto y se envía al modelo (sección Variables).`, 'vars');
    }
  }

  // ---- around the model call (not sent) ----
  const hooks = ['onStart', 'onSuccess', 'onFailure'].filter((h) => new RegExp(`function\\s+${h}\\s*\\(`).test(step.hooks || ''));
  if (hooks.includes('onStart')) warn('HOOK_MAY_CHANGE', 'Este step tiene un hook onStart: puede cambiar el input u omitir el step, y la vista previa no lo refleja.', 'around');
  if (step.output?.format === 'json') {
    const { error } = parseSchema(step.output.schema);
    if (error) warn('INVALID_SCHEMA', error, 'outputFormat');
    else if (!step.output.schema?.trim()) warn('JSON_NO_SCHEMA', 'Entrega JSON sin schema: no se valida la estructura (solo que sea JSON).', 'outputFormat');
  }
  const assertions = Array.isArray(step.assertions) ? step.assertions : [];
  const around = [
    `Tiempo máximo del step: ${step.timeoutSec || 900} s · de la ejecución completa: ${flow.runTimeoutSec || 3600} s`,
    step.kind === 'command' ? `Reintentos si falla: ${step.retry?.max || 0}` : 'Reintentos automáticos ante errores transitorios: hasta 2 (si el intento no hizo cambios)',
    `Aserciones: ${assertions.length ? assertions.map((a) => `${a.type}${a.severity === 'warn' ? ' (aviso)' : ''}`).join(', ') : 'ninguna'}`,
    `Hooks: ${hooks.join(', ') || 'ninguno'}`,
    step.pinned ? `📌 Salida fijada: en ejecuciones desde la UI este step no corre${mode === 'external' ? ' (en externas sí)' : ''}` : 'Sin salida fijada',
    step.kind !== 'command' ? `Permisos denegados: ${step.allowDenials ? 'permitidos' : 'hacen fallar el step'} · Salida vacía: ${step.allowEmpty ? 'permitida' : 'hace fallar el step'}` : '',
  ].filter(Boolean).join('\n');
  result.sections.push({ id: 'around', label: 'Alrededor de la llamada (no va al modelo)', source: 'step', toModel: 'none', text: around });
  for (const s of result.sections) { s.chars = s.text.length; s.tokensEst = est(s.text.length); }
  result.pinsUsed = [...new Set(pinsUsed)];
  return result;
}

/** Full skill/agent file, only for entries of the catalog (no arbitrary paths). */
export function definitionFile(kind, name, flowId) {
  const flow = flowId ? store.getFlow(flowId) : null;
  const hit = kind === 'skill' ? findSkill(name, flow?.cwd) : kind === 'agent' ? findAgent(name, flow?.cwd) : null;
  if (!hit) throw Object.assign(new Error('No está en el catálogo'), { status: 404 });
  const txt = fs.readFileSync(hit.path, 'utf8');
  return { kind, name: hit.name, path: hit.path, source: hit.source, content: txt.slice(0, 50000), truncated: txt.length > 50000 };
}
