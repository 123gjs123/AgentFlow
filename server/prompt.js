// Prompt composition for step runs, step chats, flow chat and the global router.
import crypto from 'node:crypto';
import { findAgent, findSkill } from './catalog.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n… [recortado, ${s.length - n} chars más]` : s || '');
const KIND_LABEL = { role: 'Rol', agent: 'Agente', skill: 'Skill', command: 'Comando' };

export function render(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key === 'input') return ctx.input ?? '';
    if (key === 'upstream') return ctx.upstream ?? '';
    const [head, ...rest] = key.split('.');
    if (head === 'vars') return String(ctx.vars?.[rest.join('.')] ?? '');
    if (head === 'steps') {
      const name = rest.slice(0, -1).join('.');
      const s = ctx.flow?.steps.find((x) => x.name === name || x.id === name);
      return s?.lastRun?.output ?? '';
    }
    return `{{${key}}}`;
  });
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

/** System prompt appended to Claude Code's default when RUNNING a step. */
export function runSystemPrompt(flow, step) {
  const parts = [
    `# Step "${step.name}" del flujo "${flow.name}"`,
    `Eres el ejecutor de este step dentro de un flujo de agentes. ${describeKind(step, flow)}.`,
  ];
  if (step.kind === 'skill' && step.skillRef) parts.push(`Usa la skill "${step.skillRef}" (vía la herramienta Skill) para realizar la tarea.`);
  if (step.role) parts.push(`## Rol\n${step.role}`);
  if (step.context) parts.push(`## Contexto\n${render(step.context, { flow, vars: flow.vars })}`);
  parts.push(`## Memoria de este step\n${memList(step.memory)}`);
  if (flow.memory?.length) parts.push(`## Memoria general del flujo\n${memList(flow.memory)}`);
  parts.push(`## Reglas de salida
- Tu respuesta final ES la salida de este step y se pasa a los steps siguientes: concreta y accionable.
- Si descubres un hecho duradero útil para futuras ejecuciones de este step, agrégalo al final como <remember>hecho</remember> (uno por línea).
- No inventes datos: si te falta información o una herramienta fue denegada, dilo explícitamente.`);
  return parts.join('\n\n');
}

export function runUserPrompt(flow, step, input, upstream) {
  const parts = [`## Tarea\n${render(step.task, { flow, vars: flow.vars, input }) || '(sin tarea definida: usa tu rol y el input)'}`];
  if (upstream.length) {
    parts.push('## Salidas de los steps anteriores');
    for (const u of upstream) parts.push(`### ${u.name}\n${clip(u.output, 12000)}`);
  }
  if (input) parts.push(`## Input del flujo\n${clip(input, 8000)}`);
  if (Object.keys(flow.vars || {}).length) parts.push(`## Variables\n${JSON.stringify(flow.vars, null, 2)}`);
  return parts.join('\n\n');
}

/** Static system prompt for a step chat (kept stable so the resumed session stays coherent). */
export function stepChatSystem() {
  return `# Chat de step
Eres la interfaz conversacional de UN step de un flujo de agentes de IA. En cada mensaje recibirás un bloque <step-context> con la configuración vigente del step (nombre, tipo, rol, tarea, contexto, herramientas, hooks, última ejecución y memoria). Responde SIEMPRE dentro del alcance de ese step: su rol, su skill/agente y su tarea.

- Explica qué haces y por qué. Puedes usar herramientas cuando aporten (lectura por defecto).
- La memoria relacionada de otros steps (<related-memory>) es solo referencia: úsala si es pertinente y dilo.
- Para proponer cambios a la configuración del step, emite UN bloque exactamente así (solo los campos que cambian; JSON válido):
<step-update>{"role":"...","task":"...","context":"...","allowedTools":"...","model":"...","effort":"...","permissionMode":"...","hooks":"..."}</step-update>
  El usuario lo aplica con un botón. Explica el cambio antes del bloque.
- Para guardar un hecho duradero en la memoria de este step: <remember>hecho</remember>. Si el usuario te pide recordar/tener en cuenta algo de forma permanente, SIEMPRE emite ese tag.
- Si el usuario activó "modo mejora", puedes editar directamente los archivos de la skill o del agente indicados en el contexto; describe el cambio.
- Responde en el idioma del usuario.`;
}

export function stepContextBlock(flow, step) {
  const { up, down } = neighbors(flow, step);
  const lr = step.lastRun;
  const body = [
    `Flujo: ${flow.name}${flow.description ? ` — ${flow.description}` : ''}`,
    `Step: ${step.name} (${KIND_LABEL[step.kind] || step.kind})`,
    describeKind(step, flow),
    `Rol:\n${step.role || '(vacío)'}`,
    `Tarea:\n${step.task || '(vacía)'}`,
    `Contexto:\n${step.context || '(vacío)'}`,
    `Modelo: ${step.model || 'por defecto'} | Effort: ${step.effort || 'por defecto'} | Permisos: ${step.permissionMode || 'por defecto'} | Tools permitidas: ${step.allowedTools || '(ninguna extra)'}`,
    `Hooks (código):\n${clip(step.hooks, 3000) || '(ninguno)'}`,
    `Steps anteriores: ${up.map((s) => s.name).join(', ') || '—'} | Steps siguientes: ${down.map((s) => s.name).join(', ') || '—'}`,
    `Última ejecución: ${lr ? `${lr.status} (${new Date(lr.endedAt || lr.startedAt).toISOString()})\nSalida:\n${clip(lr.output, 6000)}${lr.error ? `\nError: ${clip(lr.error, 1500)}` : ''}` : 'nunca'}`,
    `Memoria del step:\n${memList(step.memory)}`,
    `Memoria general del flujo:\n${memList(flow.memory)}`,
    `Variables: ${JSON.stringify(flow.vars || {})}`,
  ].join('\n\n');
  return { text: `<step-context>\n${body}\n</step-context>`, hash: crypto.createHash('sha1').update(body).digest('hex') };
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

export function parseJsonLoose(text) {
  const t = String(text).replace(/```(?:json)?/g, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}
