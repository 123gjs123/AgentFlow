// Prompt composition for step runs, step chats, flow chat and the global router.
import crypto from 'node:crypto';
import { findAgent, findSkill } from './catalog.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n… [recortado, ${s.length - n} chars más]` : s || '');
const KIND_LABEL = { role: 'Rol', agent: 'Agente', skill: 'Skill', command: 'Comando' };

export const getPath = (obj, p) => (!p ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));
const show = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** Data a step exposes to others: this run's result if available, else its pinned or last successful output.
 *  Always says where it came from (source: run | pinned | last | none) so handoffs are traceable. */
export function stepData(step, data, runId, opts = {}) {
  const d = data?.get?.(step.id);
  if (d) return { ...d, source: d.source || 'run', fromRunId: d.fromRunId || runId || null };
  if (step.pinned && opts.usePins !== false) return { output: step.pinned.output || '', json: step.pinned.json, files: [], actions: [], source: 'pinned', fromRunId: step.pinned.runId || null, at: step.pinned.at };
  const lr = step.lastRun;
  if (!lr || lr.status !== 'success') return { output: '', json: undefined, files: [], actions: [], source: 'none', fromRunId: lr?.runId || null };
  return { output: lr.output || '', json: lr.json, files: lr.files || [], actions: lr.actions || [], source: 'lastRun', fromRunId: lr.runId || null, at: lr.endedAt };
}

/** Resolves "Name.json.a.b" | "Name.output" | "Name.files" | "Name.actions" | "Name.a.b" (json shorthand).
 *  ctx.allowed (Set of step ids): inside a full run only earlier steps may be referenced (others would race).
 *  ctx.refs (array): receives {ref, step, source, fromRunId} for provenance. */
export function resolveStepRef(flow, rest, data, ctx = {}) {
  const steps = [...flow.steps].sort((a, b) => b.name.length - a.name.length);
  for (const s of steps) {
    for (const label of [s.name, s.id]) {
      if (rest !== label && !rest.startsWith(label + '.')) continue;
      if (ctx.allowed && !ctx.allowed.has(s.id)) {
        throw Object.assign(new Error(`{{steps.${rest}}}: "${s.name}" no es un step anterior (ninguna flecha lo conecta antes de este). En una ejecución completa solo se usan datos de steps anteriores; conéctalo o ejecuta este step solo.`), { refError: true });
      }
      const d = stepData(s, data, ctx.runId, { usePins: ctx.usePins });
      if (d.source === 'pinned') ctx.onPinned?.(s.name);
      const sub = rest.slice(label.length + 1) || 'output';
      if (ctx.refs && !ctx.refs.some((r) => r.ref === rest)) ctx.refs.push({ ref: rest, step: s.name, source: d.source, fromRunId: d.fromRunId || null });
      const [head, ...tail] = sub.split('.');
      if (head === 'output' || head === 'text') return show(d.output);
      if (head === 'json') return show(getPath(d.json, tail.join('.')));
      if (head === 'files') return (d.files || []).join('\n');
      if (head === 'actions') return show(d.actions || []);
      return show(getPath(d.json, sub));
    }
  }
  return null;
}

function resolveKey(key, ctx) {
  if (key === 'input') return ctx.input ?? '';
  // Run identity for names that must be unique per run (branch, compose project, labels, artifact folders) — spec 22
  if (key === 'run.id') return ctx.runId ?? '';
  if (key === 'run.short') return String(ctx.runId ?? '').replace(/^r_/, '');
  if (key === 'run.date') return new Date().toISOString().slice(0, 10);
  if (key === 'upstream') return ctx.upstream ?? '';
  if (key.startsWith('vars.')) { const k = key.slice(5); return show(ctx.vars?.[k] ?? getPath(ctx.vars, k)); }
  if (key.startsWith('steps.') && ctx.flow) return resolveStepRef(ctx.flow, key.slice(6), ctx.data, ctx);
  return null;
}

const TPL_RE = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g;

/** Fills {{…}} templates. With ctx.quote (command steps) every value goes through it, so data never becomes code.
 *  {{{…}}} (triple braces) splices the value verbatim — opt-out for authors who template command fragments on purpose. */
export function render(tpl, ctx) {
  return String(tpl || '').replace(TPL_RE, (m, raw, key, offset) => {
    const k = raw ?? key;
    const v = resolveKey(k, ctx);
    if (v === null) return m;
    if (raw !== undefined) { ctx.onRaw?.(k); return v; }
    return ctx.quote ? ctx.quote(v, k, offset) : v;
  });
}

/**
 * Quote state at each offset of a shell command: 'none' | 'single' | 'double'.
 * bash: \ escapes, '…' literal, "…" with \ escapes. PowerShell: ` escapes, '' inside '…', "" inside "…". cmd: only "…".
 */
export function quoteStateAt(cmd, shell = 'powershell') {
  const s = String(cmd || ''); const st = new Array(s.length + 1); let q = 'none';
  const bash = shell === 'bash';
  for (let i = 0; i < s.length; i++) {
    st[i] = q; const ch = s[i];
    if (shell === 'cmd') { if (ch === '"') q = q === 'double' ? 'none' : 'double'; continue; }
    const esc = bash ? ch === '\\' : ch === '`';
    if (q === 'single') { if (ch === "'") { if (!bash && s[i + 1] === "'") { st[++i] = q; continue; } q = 'none'; } continue; }
    if (q === 'double') {
      if (esc) { st[++i] = q; continue; }
      if (ch === '"') { if (!bash && s[i + 1] === '"') { st[++i] = q; continue; } q = 'none'; }
      continue;
    }
    if (esc) { st[++i] = q; continue; }
    if (ch === "'") q = 'single'; else if (ch === '"') q = 'double';
  }
  st[s.length] = q;
  return (offset) => st[offset] ?? q;
}

/** Raw ({{{…}}}) placeholders used in a text. */
export const rawPlaceholders = (tpl) => [...String(tpl || '').matchAll(/\{\{\{\s*([^{}]+?)\s*\}\}\}/g)].map((m) => m[1]);

/** Command steps: each template value travels as an environment variable; the command only references it.
 *  PowerShell: $env:AFS_V0 · bash: "$AFS_V0" · cmd: !AFS_V0! (delayed expansion happens after parsing). */
export function shellQuoter(shell, template = '') {
  const env = {}; const values = []; let i = 0;
  const at = quoteStateAt(template, shell);
  const quote = (v, key, offset) => {
    const k = `AFS_V${i++}`;
    env[k] = String(v);
    values.push({ name: k, ref: key, value: clip(String(v), 2000) });
    // Inside the author's own "…" the reference must be bare: our quotes would close theirs and leave the value
    // unquoted (bash word-splitting/globbing, cmd argument splitting). Braced forms: {{x}}.json, {{a}}_{{b}}.
    const inDouble = offset !== undefined && at(offset) === 'double';
    if (shell === 'bash') return inDouble ? `\${${k}}` : `"\${${k}}"`;
    if (shell === 'cmd') return inDouble ? `!${k}!` : `"!${k}!"`;
    return `\${env:${k}}`;
  };
  return { quote, env, values };
}

/** Placeholders written inside single quotes would never expand (PowerShell/bash): flag them instead of silently passing the literal. */
export function placeholdersInSingleQuotes(cmd, shell) {
  if (shell === 'cmd') return [];
  const at = quoteStateAt(cmd, shell || 'powershell');
  return [...String(cmd || '').matchAll(/\{\{(?!\{)\s*([^{}]+?)\s*\}\}/g)].filter((m) => at(m.index) === 'single').map((m) => m[1]);
}

const memList = (items) => (items?.length ? items.map((m) => `- ${m.text}`).join('\n') : '(vacía)');

export function neighbors(flow, step) {
  const up = flow.edges.filter((e) => e.target === step.id).map((e) => flow.steps.find((s) => s.id === e.source)).filter(Boolean);
  const down = flow.edges.filter((e) => e.source === step.id).map((e) => flow.steps.find((s) => s.id === e.target)).filter(Boolean);
  return { up, down };
}

function describeKind(step, flow) {
  switch (step.kind) {
    case 'agent': {
      const a = findAgent(step.agentRef, flow.cwd);
      return `Tipo: Agente de Claude Code "${step.agentRef}"${a ? ` (archivo: ${a.path})` : ' (no encontrado en el catálogo)'}`;
    }
    case 'skill': {
      const s = findSkill(step.skillRef, flow.cwd);
      return `Tipo: Skill "${step.skillRef}"${s ? ` (archivo: ${s.path})` : ' (no encontrada en el catálogo)'}`;
    }
    case 'command':
      return `Tipo: Comando (${step.shell}): ${step.command}`;
    default:
      return 'Tipo: Rol definido por el usuario';
  }
}

/**
 * Labelled pieces of the system prompt for RUNNING a step (spec 17 CTX-1). The engine joins them; the context
 * preview shows them one by one — same code, so the preview is exactly what gets sent.
 */
export function systemSections(flow, step, rctx = {}) {
  const S = (id, label, source, text) => ({ id, label, source, toModel: 'system', text });
  const ref = step.kind === 'skill' ? step.skillRef : step.kind === 'agent' ? step.agentRef : '';
  const out = [S('header', 'Encabezado y tipo', `step.kind${ref ? ` · ${ref}` : ''}`, `# Step "${step.name}" del flujo "${flow.name}"\n\nEres el ejecutor de este step dentro de un flujo de agentes. ${describeKind(step, flow)}.`)];
  if (step.kind === 'skill' && step.skillRef) out.push(S('skillHint', 'Instrucción de usar la skill', 'step.skillRef', `Usa la skill "${step.skillRef}" (vía la herramienta Skill) para realizar la tarea.`));
  if (step.role) out.push(S('role', 'Rol / cómo trabaja', 'step.role', `## Rol\n${step.role}`));
  if (step.context) out.push(S('context', 'Contexto (renderizado)', 'step.context', `## Contexto\n${render(step.context, { flow, vars: flow.vars, ...rctx })}`));
  // Attached context sources (spec 21), already resolved by sources.resolveContext (same in runs and preview).
  for (const c of rctx.contextSources || []) out.push(S(c.id, c.label, c.source, c.text));
  out.push(S('memoryStep', `Memoria del step (${step.memory?.length || 0})`, 'step.memory', `## Memoria de este step\n${memList(step.memory)}`));
  if (flow.memory?.length) out.push(S('memoryFlow', `Memoria del flujo (${flow.memory.length})`, 'flow.memory', `## Memoria general del flujo\n${memList(flow.memory)}`));
  if (step.output?.format === 'json') {
    const sc = step.output.schema?.trim();
    out.push(S('outputFormat', 'Formato de salida: JSON' + (sc ? ' + schema' : ''), 'step.output', '## Formato de salida: JSON\nAdemás de una explicación breve, TERMINA tu respuesta con UN único bloque ```json con los datos estructurados (JSON válido, sin comentarios). Los steps siguientes consumen ese JSON campo por campo.' + (sc ? '\nEl JSON debe cumplir este JSON Schema:\n```json\n' + sc + '\n```' : '')));
  }
  // Outgoing arrows where this step decides the destination (spec 18).
  const routed = (flow.edges || []).filter((e) => e.source === step.id && e.when?.type === 'route').map((e) => ({ e, t: flow.steps.find((s) => s.id === e.target) })).filter((x) => x.t);
  if (routed.length) {
    out.push(S('routes', `Destinos que decide este step (${routed.length})`, 'flechas de salida "lo decide el step"', `## Destinos
Tu salida puede ir a estos steps; TÚ decides a cuáles. Al final de tu respuesta agrega una línea por destino elegido:
- <route to="Nombre"/> → le llega tu salida completa
- <route to="Nombre">contenido</route> → le llega SOLO ese contenido (texto o JSON), distinto para cada destino si hace falta
Los destinos que no nombres no se ejecutan en esta ejecución (no es un error).
Destinos posibles:
${routed.map(({ e, t }) => `- ${t.name}${e.label ? `: ${e.label}` : ''}`).join('\n')}`));
  }
  out.push(S('rules', 'Reglas de salida (fijas)', 'app', `## Reglas de salida
- Tu respuesta final ES la salida de este step y se pasa a los steps siguientes: concreta y accionable.
- Si descubres un hecho duradero útil para futuras ejecuciones de este step, agrégalo al final como <remember>hecho</remember> (uno por línea).
- No inventes datos: si te falta información o una herramienta fue denegada, dilo explícitamente.`));
  return out;
}

/** System prompt appended to Claude Code's default when RUNNING a step. */
export function runSystemPrompt(flow, step, rctx = {}) {
  return systemSections(flow, step, rctx).map((s) => s.text).join('\n\n');
}

/** JSON for prompts is never cut in the middle (that would hand invalid JSON to the next step). */
const jsonBlock = (v, max) => {
  let s = JSON.stringify(v, null, 2);
  if (s.length > max) s = JSON.stringify(v);
  if (s.length > max) return `(JSON de ${s.length} chars: supera el límite de ${max}. Usa referencias {{steps.<nombre>.json.<campo>}} en la tarea o sube "máx. caracteres".)`;
  return '```json\n' + s + '\n```';
};
// ---------- edges: what passes through each arrow and when (spec 18) ----------
/** `<route to="Destino"/>` or `<route to="Destino">contenido solo para ese destino</route>`. */
const ROUTE_RE = /<route\s+to\s*=\s*"([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/route>)/g;
export function extractRoutes(text) {
  const routes = [...String(text || '').matchAll(ROUTE_RE)].map((m) => ({ to: m[1].trim(), payload: m[2] === undefined ? null : m[2].trim() }));
  return { routes, clean: String(text || '').replace(ROUTE_RE, '').trim() };
}
export const EDGE_WHEN_TYPES = ['always', 'route', 'contains', 'notContains', 'regex', 'json'];
const routeFor = (routes, target) => (routes || []).find((r) => r.to.toLowerCase() === String(target.name).toLowerCase() || r.to === target.id);
/** Edge label shown in prompts and on the canvas: "campo casos", "si json.riesgo equals alto"… */
export function edgeVia(edge) {
  const parts = [];
  if (edge.label) parts.push(edge.label);
  if (edge.pick) parts.push(`campo ${edge.pick}`);
  return parts.join(' · ');
}
/**
 * Whether an arrow carries data in this run and what it carries.
 * d = source data {output, json, routes}; evalCond(when, output, json) -> {pass, message} (assertion evaluator).
 * Returns {active, reason, output, json, routed}.
 */
export function edgePayload(edge, d, target, evalCond) {
  const when = edge.when && edge.when.type && edge.when.type !== 'always' ? edge.when : null;
  let output = d.output || ''; let json = d.json; let routed = false;
  if (when?.type === 'route') {
    const r = routeFor(d.routes, target);
    if (!r) return { active: false, reason: `el step no lo eligió como destino (<route to="${target.name}"/>)` };
    routed = true;
    if (r.payload !== null && r.payload !== '') { output = r.payload; try { json = JSON.parse(r.payload); } catch { json = undefined; } }
  } else if (when) {
    let res;
    try { res = evalCond(when, d.output, d.json); } catch (e) { res = { pass: false, message: `condición inválida: ${e.message}` }; }
    if (!res.pass) return { active: false, reason: `no se cumple: ${res.message}` };
  }
  if (edge.pick) {
    const v = getPath(json, edge.pick);
    if (v === undefined) return { active: true, output: '', json: undefined, routed, warning: `"${edge.pick}" no existe en el JSON de la salida` };
    json = v; output = show(v);
  }
  return { active: true, output, json, routed };
}

/** Upstream section according to the step's input mode: full | json | summary | refs. */
export function upstreamSection(step, upstream) {
  const mode = step.input?.mode || 'full';
  const max = Number(step.input?.maxChars) || 12000;
  if (!upstream.length || mode === 'refs') return '';
  const parts = ['## Salidas de los steps anteriores'];
  for (const u of upstream) {
    const hasJson = u.json !== undefined && u.json !== null;
    let body;
    if (mode === 'json') body = hasJson ? jsonBlock(u.json, max) : clip(u.output, max);
    else if (mode === 'summary') body = u.summary || clip(u.output, max);
    else body = [clip(u.output, max), hasJson ? 'Datos (JSON):\n' + jsonBlock(u.json, max) : ''].filter(Boolean).join('\n\n');
    const src = u.source && u.source !== 'run' ? ` (${u.source === 'pinned' ? 'salida fijada' : u.source === 'lastRun' ? 'de una ejecución anterior' : 'sin datos'})` : '';
    parts.push(`### ${u.name}${u.via ? ` → ${u.via}` : ''}${src}\n${body || '(sin salida)'}`);
  }
  return parts.join('\n\n');
}

/** Labelled pieces of the user prompt (task, upstream, input, vars). */
export function userSections(flow, step, input, upstream, data, rctx = {}) {
  const U = (id, label, source, text) => ({ id, label, source, toModel: 'user', text });
  const out = [U('task', 'Tarea (renderizada)', 'step.task', `## Tarea\n${render(step.task, { flow, vars: flow.vars, input, data, ...rctx }) || '(sin tarea definida: usa tu rol y el input)'}`)];
  const up = upstreamSection(step, upstream);
  if (up) out.push(U('upstream', `Lo que recibe de steps anteriores (${({ full: 'todo', json: 'solo JSON', summary: 'resumen', refs: 'referencias' })[step.input?.mode || 'full']}, ${upstream.length})`, `upstream: ${upstream.map((u) => u.name).join(', ')}`, up));
  if (input) out.push(U('input', 'Input del flujo', 'run input', `## Input del flujo\n${clip(input, 8000)}`));
  if (rctx.reviewFeedback) out.push(U('review', 'Corrección pedida en el break', 'revisor (break)', `## Corrección pedida por el revisor\nTu salida anterior fue revisada y hay que rehacerla con esta indicación:\n${rctx.reviewFeedback}${rctx.previousOutput ? `\n\nSalida anterior:\n${clip(rctx.previousOutput, 6000)}` : ''}`));
  if (Object.keys(flow.vars || {}).length) out.push(U('vars', `Variables (${Object.keys(flow.vars).length})`, 'flow.vars + vars de la ejecución', `## Variables\n${JSON.stringify(flow.vars, null, 2)}`));
  return out;
}

export function runUserPrompt(flow, step, input, upstream, data, rctx = {}) {
  return userSections(flow, step, input, upstream, data, rctx).map((s) => s.text).join('\n\n');
}

/** Static system prompt for a step chat (kept stable so the resumed session stays coherent). */
export function stepChatSystem() {
  return `# Chat de step
Eres la interfaz conversacional de UN step de un flujo de agentes de IA. En cada mensaje recibirás un bloque <step-context> con la configuración vigente del step (nombre, tipo, rol, tarea, contexto, herramientas, hooks, última ejecución y memoria). Responde SIEMPRE dentro del alcance de ese step: su rol, su skill/agente y su tarea.

- Explica qué haces y por qué. Puedes usar herramientas cuando aporten (lectura por defecto).
- La memoria relacionada de otros steps (<related-memory>) es solo referencia: úsala si es pertinente y dilo.
- Para proponer cambios a la configuración del step, emite UN bloque exactamente así (solo los campos que cambian; JSON válido):
<step-update>{"role":"...","task":"...","context":"...","allowedTools":"...","model":"...","effort":"...","permissionMode":"...","hooks":"...","command":"...","shell":"powershell|bash|cmd","output":{"format":"text|json","schema":"<JSON Schema como texto>"},"vars":{"nombre":"valor"}}</step-update>
  El usuario lo aplica con un botón. Explica el cambio antes del bloque. "command"/"shell" solo para steps de tipo Comando (el texto COMPLETO del comando, no un fragmento). "vars" cambia o agrega variables del flujo (afectan a todos los steps que las usan; dilo). Nunca pongas valores de secretos en "vars".
- Si llega un bloque <run-review>, el usuario está revisando una ejecución REAL de este step en un break: basa tu análisis y tus propuestas en esa entrada y esa salida concretas (qué recibió, qué produjo, qué error dio) y en lo que el usuario dice que debería pasar. Después de aplicar, el usuario re-ejecuta el step con los cambios.
- Para guardar un hecho duradero en la memoria de este step: <remember>hecho</remember>. Si el usuario te pide recordar/tener en cuenta algo de forma permanente, SIEMPRE emite ese tag.
- Si el usuario activó "modo mejora", puedes editar directamente los archivos de la skill o del agente indicados en el contexto; describe el cambio.
- Responde en el idioma del usuario.`;
}

export function stepContextBlock(flow, step, attached = []) {
  const { up, down } = neighbors(flow, step);
  const lr = step.lastRun;
  const body = [
    `Flujo: ${flow.name}${flow.description ? ` — ${flow.description}` : ''}`,
    `Step: ${step.name} (${KIND_LABEL[step.kind] || step.kind})`,
    describeKind(step, flow),
    `Rol:\n${step.role || '(vacío)'}`,
    `Tarea:\n${step.task || '(vacía)'}`,
    `Contexto:\n${step.context || '(vacío)'}`,
    `Contexto adjunto (documentos, carpetas, páginas, Jira, Confluence; léelos con tus herramientas si hace falta):\n${attached.join('\n') || '(ninguno)'}`,
    `Modelo: ${step.model || 'por defecto'} | Effort: ${step.effort || 'por defecto'} | Permisos: ${step.permissionMode || 'por defecto'} | Tools permitidas: ${step.allowedTools || '(ninguna extra)'}`,
    `Hooks (código):\n${clip(step.hooks, 3000) || '(ninguno)'}`,
    `Steps anteriores: ${up.map((s) => s.name).join(', ') || '—'} | Steps siguientes: ${down.map((s) => s.name).join(', ') || '—'}`,
    `Última ejecución: ${lr ? `${lr.status} ${lr.endedAt || lr.startedAt ? ` (${new Date(lr.endedAt || lr.startedAt).toISOString()})` : ''}\nSalida:\n${clip(lr.output, 6000)}${lr.json !== undefined ? `\nDatos JSON:\n${clip(JSON.stringify(lr.json, null, 2), 4000)}` : ''}${lr.error ? `\nError: ${clip(lr.error, 1500)}` : ''}` : 'nunca'}`,
    `Formato de salida: ${step.output?.format === 'json' ? 'JSON' : 'texto'} | Recibe de anteriores: ${step.input?.mode || 'full'}${step.pinned ? ' | 📌 salida fijada (no se ejecuta en el flujo)' : ''}`,
    `Memoria del step:\n${memList(step.memory)}`,
    `Memoria general del flujo:\n${memList(flow.memory)}`,
    `Variables: ${JSON.stringify(flow.vars || {})}`,
  ].join('\n\n');
  return { text: `<step-context>\n${body}\n</step-context>`, hash: crypto.createHash('sha1').update(body).digest('hex') };
}

/**
 * The real input/output of one execution of a step, for the chat opened from a break (or from a run): what it received,
 * what it produced, the error and the commands it ran. `pause` = the pending break, if any; `sr` = run.steps[stepId].
 */
export function runReviewBlock(step, run, pause, sr) {
  const lines = [`Ejecución ${run.id} (${new Date(run.startedAt).toISOString()}) — estado del step: ${sr?.status || pause?.when || 'desconocido'}${pause ? ` · en pausa (${pause.when === 'before' ? 'antes de ejecutarse' : 'después de ejecutarse'})` : ''}`];
  if (run.input) lines.push(`Input del flujo:\n${clip(run.input, 3000)}`);
  const inputs = pause?.inputs || sr?.inputs;
  if (inputs?.length) lines.push(`Lo que recibe de otros steps:\n${inputs.map((i) => `### ${i.step}${i.via ? ` (${i.via})` : ''}\n${clip(i.output || (i.json !== undefined ? JSON.stringify(i.json, null, 2) : ''), 4000) || '(vacío)'}`).join('\n')}`);
  if (pause?.when !== 'before') {
    const out = pause?.output ?? sr?.output;
    const json = pause ? pause.json : sr?.json;
    lines.push(`Salida producida:\n${clip(out, 8000) || '(vacía)'}`);
    if (json !== undefined) lines.push(`Datos JSON:\n${clip(JSON.stringify(json, null, 2), 4000)}`);
    if (sr?.error) lines.push(`Error: ${clip(sr.error, 2000)}`);
  }
  const cmds = (sr?.events || []).filter((e) => e.kind === 'tool_use' && /^shell:|^Bash$/.test(e.name || '')).slice(-3);
  if (cmds.length) lines.push(`Comando ejecutado (las variables {{vars.x}} se pasan como $env:AFS_V0…; sus valores están en "Variables"):\n${cmds.map((e) => clip(e.input?.cmd || e.input?.command || JSON.stringify(e.input), 3000)).join('\n---\n')}`);
  const errs = (sr?.events || []).filter((e) => e.isError || e.kind === 'error').slice(-3);
  if (errs.length) lines.push(`Errores en la actividad:\n${errs.map((e) => clip(e.text || e.content, 1500)).join('\n')}`);
  return `<run-review>\n${lines.join('\n\n')}\n</run-review>`;
}

/** Naive keyword relevance over other steps' memory. */
export function relatedMemory(flow, step, message, limit = 6) {
  const words = new Set(String(message).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g) || []);
  if (!words.size) return [];
  const hits = [];
  for (const s of flow.steps) {
    if (s.id === step?.id) continue;
    for (const m of s.memory || []) {
      const t = m.text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      let score = 0;
      for (const w of words) if (t.includes(w)) score++;
      if (score) hits.push({ score, step: s.name, text: m.text });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function flowChatSystem() {
  return `# Chat general del flujo
Eres el asistente de un flujo de agentes de IA. Recibirás un <flow-context> con los steps (tipo, rol, tarea, estado, memoria) y la memoria general. Responde sobre el flujo en conjunto, explica qué hace cada step y cómo se relacionan. Guarda hechos generales duraderos con <remember>hecho</remember>. Responde en el idioma del usuario.`;
}

export function flowContextBlock(flow) {
  const steps = flow.steps.map((s) => {
    const { up } = neighbors(flow, s);
    return `- [${s.id}] ${s.name} (${KIND_LABEL[s.kind]}${s.agentRef ? `: ${s.agentRef}` : ''}${s.skillRef ? `: ${s.skillRef}` : ''}) ← ${up.map((u) => u.name).join(', ') || 'inicio'}\n  Rol: ${clip(s.role, 300) || '—'}\n  Tarea: ${clip(s.task, 300) || '—'}\n  Última ejecución: ${s.lastRun ? `${s.lastRun.status}: ${clip(s.lastRun.output, 600)}` : 'nunca'}\n  Memoria: ${(s.memory || []).map((m) => m.text).join(' | ') || '—'}`;
  }).join('\n');
  const body = `Flujo: ${flow.name}\n${flow.description || ''}\nVariables: ${JSON.stringify(flow.vars || {})}\n\nSteps:\n${steps || '(sin steps)'}\n\nMemoria general:\n${memList(flow.memory)}`;
  return { text: `<flow-context>\n${body}\n</flow-context>`, hash: crypto.createHash('sha1').update(body).digest('hex') };
}

export function routerSystem() {
  return `Eres el enrutador de un flujo de agentes de IA. Dado el catálogo de steps y el mensaje del usuario, decide quién responde o qué acción ejecutar. Devuelve SOLO un objeto JSON, sin texto ni bloques de código:
{"action":"ask"|"run_step"|"run_flow","target":"<id de step>"|"flow","reason":"<por qué, 1 frase>","message":"<mensaje a enviar al destino, reformulado si ayuda>","input":"<input para la ejecución, si aplica>"}
Reglas:
- "ask" con target=id de step cuando la pregunta cae en el dominio de un step (su rol, skill, agente, tarea o memoria).
- "ask" con target="flow" para preguntas generales, del flujo completo o que cruzan varios steps.
- "run_step"/"run_flow" SOLO si el usuario pide explícitamente ejecutar/correr/lanzar algo.`;
}

export function routerPrompt(flow, history, message) {
  const catalog = flow.steps.map((s) => ({
    id: s.id, name: s.name, kind: s.kind, agent: s.agentRef || undefined, skill: s.skillRef || undefined,
    role: clip(s.role, 240), task: clip(s.task, 240), memory: (s.memory || []).slice(-5).map((m) => clip(m.text, 120)),
  }));
  const recent = history.slice(-6).map((m) => `${m.role === 'user' ? 'Usuario' : `Asistente${m.routedTo ? ` (${m.routedTo})` : ''}`}: ${clip(m.text, 400)}`).join('\n');
  return `Catálogo de steps:\n${JSON.stringify(catalog, null, 1)}\n\nConversación reciente:\n${recent || '(vacía)'}\n\nMensaje nuevo del usuario:\n${message}`;
}

// ---------- tag parsing ----------
export function extractTags(text) {
  const remember = [...String(text).matchAll(/<remember>([\s\S]*?)<\/remember>/g)].map((m) => m[1].trim()).filter(Boolean);
  const updates = [];
  for (const m of String(text).matchAll(/<step-update>([\s\S]*?)<\/step-update>/g)) {
    try { updates.push(JSON.parse(m[1].trim().replace(/^```(?:json)?|```$/g, ''))); } catch { updates.push({ __invalid: m[1].trim() }); }
  }
  const clean = String(text)
    .replace(/<remember>[\s\S]*?<\/remember>/g, '')
    .replace(/<step-update>[\s\S]*?<\/step-update>/g, '')
    .trim();
  return { remember, updates, clean };
}

/** Pulls the last ```json block (or a bare JSON answer) out of a step's text. */
export function extractJson(text) {
  const t = String(text || '');
  const re = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let m, last = null;
  while ((m = re.exec(t))) last = m;
  if (last) {
    try { return { json: JSON.parse(last[1]), text: (t.slice(0, last.index) + t.slice(last.index + last[0].length)).trim() }; }
    catch (e) { return { error: 'JSON inválido: ' + e.message, text: t }; }
  }
  const x = t.trim();
  if (/^[[{]/.test(x)) { try { return { json: JSON.parse(x), text: '' }; } catch (e) { return { error: 'JSON inválido: ' + e.message, text: t }; } }
  return { error: 'No se encontró un bloque ```json en la respuesta', text: t };
}

export function parseJsonLoose(text) {
  const t = String(text).replace(/```(?:json)?/g, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}
