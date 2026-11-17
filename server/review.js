// 🩺 Flow review (spec 28): catches what makes a flow fail or give false confidence BEFORE its users find out.
// Layers (cheapest first; adversarial review: rules and probes catch more than a model reading prompts):
//   1. lint      — deterministic rules on the definition + machine probes (0 tokens, on demand and cached)
//   2. runs      — the same rules over a digest of the latest runs and rehearsals (denials, background, timeouts)
//   3. AI review — on demand: 2 INDEPENDENT calls (constructive = product+architect, adversarial = blind red team),
//                  merged by code (dedupe + dissent kept), every claim checked against real evidence
// Everything here only PROPOSES. Changes go through engine.applyChange (same checks as any chat proposal, spec 25).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import * as store from './store.js';
import * as P from './prompt.js';
import * as POL from './policies.js';
import { findSkill, findAgent } from './catalog.js';
import { lastInit, runClaude } from './claude.js';
import { credentialChecks } from './credentials.js';
import * as engine from './engine.js';
import { SECRET_NAME } from './bundle.js';

const sha = (s, n = 16) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const tokens = (list) => String(list || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || [];
const SEV = { block: 0, risk: 1, improve: 2 };
const LONG_TASK = /\b(suite|regresi[oó]n|regression|testcafe|gherkin|playwright|cypress|selenium|k6|jmeter|pytest|jest|mocha|npm (run )?test|mvn|gradle|dotnet test|ejecut\w* (los )?(tests|casos|pruebas)|run (the )?tests|e2e)\b/i;
const EXTERNAL_WRITE_RE = /\bgit\b[^\n]*\bpush\b|-Method\s+['"]?(Put|Patch|Delete)\b|-Method\s+['"]?Post\b(?![^\n]*\bsearch)|\bcurl\b[^\n]*(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b|\bcurl\b[^\n]*\s(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form)\s|\bdocker\s+push\b|\bnpm\s+publish\b|\bkubectl\s+(apply|delete|create)\b|\bbb\.mjs\s+(open-pr|update-pr|reply)\b|\bgh\s+(pr|issue|release)\s+(create|merge|edit|close|comment)\b/i;
// a step that really launches suites: a runner in its tools (generic `node` only when it runs tests/e2e)
const RUNNER_TOOL = /^Bash\((npx|npm|yarn|pnpm|testcafe|gherkin|k6|mvn|gradle|dotnet|pytest|docker|node\b[^)]*(run-e2e|\btests?\b|testcafe|playwright|jest|mocha))/i;
const READ_CMDS = ['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'find', 'tasklist', 'ps', 'tee', 'sort', 'uniq', 'diff', 'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse'];
const SHELL_RULE = 'Ejecuta cada comando tal cual, sin "cd …&&" (el directorio de trabajo ya es la raíz), sin variables delante (VAR=x comando) y sin heredocs: esas formas no coinciden con los permisos y se deniegan.';
const BG_RULE = 'Nunca uses la opción run_in_background ni termines tu respuesta con un comando en curso: si terminas, el comando muere con la sesión. Para corridas largas espera el resultado.';
const SECRET_RE = /\b(ATATT[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[\w-]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{30,}|Bearer\s+[A-Za-z0-9._-]{30,}|(password|passwd|pwd|token|apikey|api_key)\s*[:=]\s*['"]?[^\s'"{}]{8,})/i;

let deps = { emit: () => {} };
const stepName = (flow, id) => flow.steps.find((s) => s.id === id)?.name || id;
const flowAnchor = (flow) => sha(JSON.stringify({ v: flow.vars, p: flow.policies, s: flow.schedule, r: flow.runTimeoutSec, m: POL.machinePolicies() }));
const anchorOf = (flow, stepId) => (stepId ? engine.stepHash(flow.steps.find((s) => s.id === stepId)) || 'gone' : flowAnchor(flow));

/** One finding. fp is stable across rewordings: rule + step + subject (adversarial: never the model's words). */
function F(flow, { rule, severity, category, stepId = null, subject = '', title, detail, evidence = [], fix = null, check = '' }) {
  return { fp: sha(`${rule}|${stepId || 'flow'}|${subject}`), rule, source: 'rule', severity, category, stepId, stepName: stepId ? stepName(flow, stepId) : null, title, detail, evidence, fix, check, anchor: anchorOf(flow, stepId) };
}

// ---------------- machine probes (cached 2 min) ----------------
let probeCache = { at: 0, data: null };
function countHeadless() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || process.env.AFS_PROBE_HEADLESS === 'off') return resolve(Number(process.env.AFS_FAKE_HEADLESS) || 0);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'testcafe\\\\chrome-profile|puppeteer_dev_chrome_profile|playwright_chromiumdev_profile' } | Measure-Object).Count"], { windowsHide: true, timeout: 15000 }, (err, out) => resolve(err ? 0 : Number(String(out).trim()) || 0));
  });
}
export async function machineProbes({ fresh = false } = {}) {
  if (!fresh && probeCache.data && Date.now() - probeCache.at < 120000) return probeCache.data;
  const headless = await countHeadless();
  const data = { headless, bashMaxMs: Number(process.env.BASH_MAX_TIMEOUT_MS) || null, cliKnown: !!lastInit.at, mcp: (lastInit.mcpServers || []).map((m) => ({ name: m.name, status: m.status })), at: Date.now() };
  probeCache = { at: Date.now(), data };
  return data;
}
/** Closes only the headless Chromes test runners leave behind (never the person's own browser). */
export function cleanupHeadless() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ closed: 0, unsupported: true });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'testcafe\\\\chrome-profile|puppeteer_dev_chrome_profile|playwright_chromiumdev_profile' }); foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count"], { windowsHide: true, timeout: 30000 }, (err, out) => { probeCache = { at: 0, data: null }; resolve({ closed: err ? 0 : Number(String(out).trim()) || 0 }); });
  });
}

// ---------------- run digests (cached per run: finished runs never change) ----------------
const digestCache = new Map();
/** A compact view of one run for rules and reviewers: never the whole run (780 KB runs exist). */
export function runDigest(flow, run) {
  if (!run) return null;
  const key = `${run.id}:${run.status}:${run.endedAt || 0}`;
  if (digestCache.has(key)) return digestCache.get(key);
  const steps = Object.entries(run.steps || {}).filter(([id]) => !id.includes('~')).map(([id, s]) => {
    const ev = s.events || [];
    const hist = {};
    for (const e of ev) if (e.kind === 'tool_use') hist[e.name] = (hist[e.name] || 0) + 1;
    const denials = [];
    for (const d of s.denials || []) {
      // the CLI's input is JSON cut at 300 chars: take the command even from a truncated string
      let inp = d.input; try { inp = JSON.parse(d.input).command ?? d.input; } catch { const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(d.input)); if (m) inp = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
      const k = `${d.tool}|${clip(inp, 160)}`;
      const hit = denials.find((x) => x.k === k); if (hit) hit.n++; else denials.push({ k, tool: d.tool, input: clip(inp, 160), n: 1 });
    }
    const bash = ev.filter((e) => e.kind === 'tool_use' && e.name === 'Bash');
    const background = bash.filter((e) => e.input?.run_in_background).map((e) => clip(e.input?.command, 160));
    const results = ev.filter((e) => e.kind === 'tool_result').map((e) => String(e.content ?? e.text ?? ''));
    // only Bash's own limit (a 20 s search timeout of Grep is not this problem)
    const timedOut = ev.filter((e) => e.kind === 'tool_result').map((e, i) => String(e.content ?? e.text ?? '')).filter((t) => /^Command timed out|Command was moved to the background|exceeded the maximum (bash )?timeout/i.test(t.trim())).map((t) => clip(t, 200));
    const errors = ev.filter((e) => e.isError || e.kind === 'error').slice(-3).map((e) => clip(e.text ?? e.content, 300));
    return {
      stepId: id, step: stepName(flow, id), stepHash: run.stepHashes?.[id] || null, status: s.status, code: s.code || null, skipReason: s.skipReason || null, durationMs: s.durationMs || null, attempts: (s.attempts || []).length,
      denials: denials.map(({ k, ...d }) => d), mcpMissing: s.mcpMissing || [], warnings: (s.warnings || []).slice(0, 3).map((w) => clip(w, 240)), tools: hist,
      background, timedOut, errors, outputLen: String(s.output || '').length, outputHead: clip(s.output, 300), outputTail: clip(String(s.output || '').slice(-300), 300), error: clip(String(s.error || '').split('\n')[0], 240),
    };
  });
  const d = { runId: run.id, status: run.status, trigger: run.trigger, rehearsal: !!run.rehearsal, only: run.only || null, startedAt: run.startedAt, endedAt: run.endedAt, durationMs: (run.endedAt || 0) - (run.startedAt || 0), deadlineMs: run.deadlineAt && run.startedAt ? run.deadlineAt - run.startedAt + (run.pausedMs || 0) : null, input: clip(run.input, 200), steps };
  if (run.status !== 'running') { digestCache.set(key, d); if (digestCache.size > 300) digestCache.delete(digestCache.keys().next().value); }
  return d;
}
/** The runs worth looking at: last 5 non-rehearsal, last 2 rehearsals, failed in 14 days (max 10). */
export function recentDigests(flow) {
  const list = store.listRuns(flow.id).filter((r) => r.status !== 'running' && r.status !== 'paused');
  const pick = [];
  const add = (r) => { if (r && !pick.some((x) => x.id === r.id) && pick.length < 10) pick.push(r); };
  list.filter((r) => r.trigger !== 'rehearsal').slice(0, 5).forEach(add);
  list.filter((r) => r.trigger === 'rehearsal').slice(0, 2).forEach(add);
  list.filter((r) => ['error', 'timeout'].includes(r.status) && Date.now() - r.startedAt < 14 * 86400e3).forEach(add);
  // the digest cache is checked BEFORE reading the (possibly 1 MB) run file
  return pick.map((r) => digestCache.get(`${r.id}:${r.status}:${r.endedAt || 0}`) || runDigest(flow, store.getRun(flow.id, r.id))).filter(Boolean);
}

// ---------------- lint (deterministic) ----------------
/**
 * Rules over the definition, the policies, the machine and the latest runs. Each finding carries evidence and, when
 * possible, a fix that goes through engine.applyChange.
 */
export async function lintFlow(flow, { probes = true, fresh = false } = {}) {
  const out = []; const notVerifiable = [];
  const add = (x) => out.push(F(flow, x));
  const pol = POL.effective(flow);
  const has = (t) => pol.find((p) => p.type === t);
  const sys = probes ? await machineProbes({ fresh }) : { cliKnown: !!lastInit.at, mcp: lastInit.mcpServers || [], headless: 0 };
  const loaded = new Map((lastInit.mcpServers || []).map((m) => [String(m.name).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase(), m.status]));

  // --- policies that need something the flow does not have ---
  for (const p of pol) {
    if (p.type === 'defaultEnv' && !String(flow.vars?.[p.params.var] ?? '').trim()) add({ rule: 'POL-DEFAULT-ENV', severity: 'improve', category: 'env', subject: p.params.var, title: `La variable «${p.params.var}» no está definida en el flujo`, detail: `La política «${p.text}» la completa al ejecutar con «${p.params.value}». Definirla deja explícito qué ambiente usa el flujo.`, evidence: [{ type: 'policy', quote: p.text }], fix: { kind: 'flow', patch: { vars: { [p.params.var]: p.params.value } }, label: `Definir ${p.params.var} = ${p.params.value}` }, check: 'La variable aparece en Flujo › Variables.' });
    if (p.type === 'noParallelRuns' && flow.schedule?.enabled && (Number(flow.schedule.everyMinutes) || 60) * 60 < (Number(flow.runTimeoutSec) || 3600)) add({ rule: 'POL-PARALLEL-SCHEDULE', severity: 'risk', category: 'data-isolation', subject: 'schedule', title: 'La programación puede chocar consigo misma', detail: `Corre cada ${flow.schedule.everyMinutes} min pero una ejecución puede durar hasta ${Math.round((flow.runTimeoutSec || 3600) / 60)} min: con «nunca dos a la vez» las ejecuciones que se pisen se rechazan.`, evidence: [{ type: 'def', quote: `everyMinutes: ${flow.schedule.everyMinutes}` }] });
    if (p.type === 'ticketStatus') {
      const gate = flow.steps.some((s) => s.kind === 'command' && /exit\s+[1-9]|throw\b/i.test(s.command || '') && (norm(s.command).includes(norm(p.params.statuses).split(',')[0].trim()) || /status|estado/i.test(s.command || '')));
      if (!gate) add({ rule: 'POL-TICKET-GATE', severity: 'risk', category: 'gate', subject: p.params.statuses, title: 'Nada frena el flujo si el ticket no está en el estado esperado', detail: `La política pide «${p.params.statuses}». Una regla en el prompt no frena: el agente lo nota y sigue. Hace falta un step de control que termine con error. Pídelo en la revisión con IA o en el chat de revisión.`, evidence: [{ type: 'policy', quote: p.text }] });
    }
  }

  const ext = has('noExternalWrites');
  for (const s of flow.steps) {
    const isAi = s.kind !== 'command';
    const toks = tokens(s.allowedTools);
    // R-REF: a skill or agent that does not exist on this machine
    if (s.kind === 'skill' && s.skillRef && !findSkill(s.skillRef, flow.cwd)) add({ rule: 'R-REF', severity: 'block', category: 'ref', stepId: s.id, subject: s.skillRef, title: `La skill «${s.skillRef}» no existe en esta máquina`, detail: 'El step va a correr sin la skill (o fallar). Elige una skill existente o créala.', evidence: [{ type: 'def', stepId: s.id, quote: `skillRef: ${s.skillRef}` }] });
    if (s.kind === 'agent' && s.agentRef && !findAgent(s.agentRef, flow.cwd)) add({ rule: 'R-REF', severity: 'block', category: 'ref', stepId: s.id, subject: s.agentRef, title: `El agente «${s.agentRef}» no existe en esta máquina`, detail: 'Elige un agente existente o créalo.', evidence: [{ type: 'def', stepId: s.id, quote: `agentRef: ${s.agentRef}` }] });
    // R-MCP: connectors the CLI does not load
    const servers = [...new Set(toks.filter((t) => t.startsWith('mcp__')).map((t) => t.slice(5).split('__')[0]))];
    if (servers.length && !sys.cliKnown) notVerifiable.push(`Qué conectores MCP carga el CLI (lo usa «${s.name}»): abre ⚙ Configuración › Claude Code CLI para comprobarlo.`);
    for (const srv of servers) {
      const st = loaded.get(srv.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase());
      if (sys.cliKnown && st !== 'connected' && st !== 'pending') add({ rule: 'R-MCP', severity: 'block', category: 'mcp', stepId: s.id, subject: srv, title: `El CLI no carga el conector «${srv.replace(/_/g, ' ')}»`, detail: `Claude Code en esta máquina no lo tiene (${st || 'no configurado'}): el step va a fallar con MCP_UNAVAILABLE. Conéctalo al CLI, o reemplaza la lectura por un step de comando con una credencial (⚙ › Credenciales).`, evidence: [{ type: 'def', stepId: s.id, quote: clip(toks.filter((t) => t.includes(srv)).join(' '), 200) }, { type: 'system', quote: `conectores cargados: ${(lastInit.mcpServers || []).map((m) => `${m.name}=${m.status}`).join(', ') || 'ninguno'}` }] });
    }
    // R-CWD
    const cw = engine.cwdWarning(flow, s);
    if (cw) add({ rule: 'R-CWD', severity: 'risk', category: 'cwd', stepId: s.id, title: 'Trabajaría en tu carpeta de usuario', detail: cw, evidence: [{ type: 'def', quote: 'cwd: (vacío)' }] });
    // R-WRITE-EXT: writes to external systems
    const mcpWrites = toks.filter((t) => POL.MCP_WRITE_RE.test(t) || (t.startsWith('mcp__') && t.slice(5).split('__').length === 1 && /atlassian/i.test(t)));
    const bashWrites = toks.filter((t) => /^Bash\((git push|curl|Invoke-RestMethod|node .*bb\.mjs)/i.test(t));
    // only what leaves the machine counts as an external write (a local branch or commit is not)
    const cmdWrite = s.kind === 'command' ? (String(s.command || '').match(EXTERNAL_WRITE_RE) || [])[0] : null;
    const cmdExternal = !!cmdWrite;
    if (mcpWrites.length || bashWrites.length || cmdExternal) {
      const what = [...mcpWrites, ...bashWrites, ...(cmdExternal ? [`comando: ${clip(cmdWrite, 60)}`] : [])];
      if (ext) {
        if (s.kind === 'command' && cmdExternal) add({ rule: 'R-WRITE-EXT', severity: 'block', category: 'external-write', stepId: s.id, subject: 'command', title: 'Escribe fuera aunque la regla lo prohíbe', detail: `La política «${ext.text}» no puede frenar un step de comando: revísalo o quítalo.`, evidence: [{ type: 'def', stepId: s.id, quote: clip(cmdWrite, 200) }, { type: 'policy', quote: ext.text }] });
        else if (isAi && what.length) add({ rule: 'R-WRITE-EXT', severity: 'risk', category: 'external-write', stepId: s.id, subject: 'ai', title: 'Pide herramientas de escritura que la regla bloquea', detail: `Al ejecutar, la app las bloquea (${clip(what.join(' '), 140)}): si el step las necesita, va a fallar. Quítalas o cambia la tarea a "preparar el borrador para la persona".`, evidence: [{ type: 'def', stepId: s.id, quote: clip(what.join(' '), 200) }, { type: 'policy', quote: ext.text }], fix: mcpWrites.length ? { kind: 'flow', patch: { steps: { [s.id]: { allowedTools: toks.filter((t) => !mcpWrites.includes(t) && !bashWrites.includes(t)).join(' ') } } }, label: 'Quitar las herramientas de escritura' } : null, check: 'El step deja de pedir herramientas bloqueadas.' });
      } else {
        add({ rule: 'R-WRITE-EXT', severity: 'risk', category: 'external-write', stepId: s.id, subject: 'ask', title: 'Escribe en sistemas externos', detail: `Puede crear, editar o publicar (${clip(what.join(' '), 140)}). ¿Es intencional? Si no quieres escrituras sin pedido explícito, agrega la regla; si lo es, descarta este aviso con "es intencional".`, evidence: [{ type: 'def', stepId: s.id, quote: clip(what.join(' '), 200) }], fix: { kind: 'policy', policy: { scope: 'flow', type: 'noExternalWrites', text: POL.POLICY_TYPES.noExternalWrites.label, params: {} }, label: 'Agregar la regla "no escribir sin pedido"' } });
      }
    }
    // R-CRED / secrets written in prompt fields
    for (const k of ['role', 'task', 'context']) {
      const m = SECRET_RE.exec(String(s[k] || ''));
      if (m) add({ rule: 'R-SECRET', severity: 'block', category: 'credentials', stepId: s.id, subject: k, title: `Hay algo que parece un secreto en «${k}»`, detail: 'Los prompts viajan al modelo y se guardan en el historial: cárgalo en ⚙ › Credenciales y úsalo con {{cred.nombre.campo}} desde un step de comando.', evidence: [{ type: 'def', stepId: s.id, quote: `${k}: ${m[0].slice(0, 6)}••••` }] });
    }
    // R-LONG-BASH: long suites inside an AI step hit the CLI's 10-minute Bash limit
    if (isAi && (toks.some((t) => RUNNER_TOOL.test(t)) || (toks.some((t) => /^Bash$/.test(t)) && LONG_TASK.test(`${s.task} ${s.role}`))) && LONG_TASK.test(`${s.task} ${s.role}`) && !s.bashTimeoutMin && !(sys.bashMaxMs > 600000)) {
      add({ rule: 'R-LONG-BASH', severity: 'risk', category: 'timeout', stepId: s.id, title: 'Corre suites largas y el CLI corta cada comando a los 10 min', detail: 'Claude Code corta un comando de Bash a los 10 minutos (o lo manda a segundo plano y la sesión termina sin el resultado). Sube el límite de Bash de este step y su tiempo máximo.', evidence: [{ type: 'def', stepId: s.id, quote: clip((`${s.task}`.match(LONG_TASK) || [''])[0], 80) }, { type: 'system', quote: `BASH_MAX_TIMEOUT_MS: ${sys.bashMaxMs || 'sin definir (10 min)'}` }], fix: { kind: 'flow', patch: { steps: { [s.id]: { bashTimeoutMin: 60, ...(Number(s.timeoutSec) >= 3600 ? {} : { timeoutSec: 7200 }), context: `${s.context ? `${s.context}\n` : ''}${BG_RULE}` } } }, label: 'Bash hasta 60 min, step hasta 2 h y regla de no dejar comandos en segundo plano' }, check: 'En el ensayo o la próxima corrida no aparece "Command timed out" ni un comando en segundo plano.' });
    }
  }
  // credentials that are missing
  for (const c of credentialChecks(flow).filter((x) => x.ok === false)) add({ rule: 'R-CRED', severity: 'block', category: 'credentials', subject: c.id, title: `Falta la credencial ${c.label}`, detail: 'El flujo no arranca hasta cargarla en ⚙ › Credenciales.', evidence: [{ type: 'def', quote: c.label }] });

  // --- machine ---
  if (sys.headless > 0 && flow.steps.some((s) => LONG_TASK.test(`${s.task} ${s.command}`))) add({ rule: 'P-HEADLESS', severity: 'risk', category: 'other', subject: 'headless', title: `Hay ${sys.headless} procesos de navegador de pruebas abiertos`, detail: 'Los runners de tests (TestCafe, Puppeteer, Playwright) a veces dejan su Chrome sin cerrar, y el siguiente lanzamiento falla con "Cannot establish browser connections".', evidence: [{ type: 'system', quote: `procesos de Chrome con perfil de test: ${sys.headless}` }], fix: { kind: 'action', action: 'cleanup-headless', label: `Cerrar esos ${sys.headless} procesos (no toca tu Chrome)` }, check: 'El contador vuelve a 0.' });

  // --- runs and rehearsals ---
  const digests = recentDigests(flow);
  // once runs record step versions, older runs (without them) are noise: their step may have changed since
  const versioned = digests.some((d) => d.steps.some((x) => x.stepHash));
  const byStep = new Map();
  for (const d of digests.filter((x) => !versioned || x.steps.some((y) => y.stepHash))) for (const s of d.steps) { if (!byStep.has(s.stepId)) byStep.set(s.stepId, []); byStep.get(s.stepId).push({ ...s, runId: d.runId, rehearsal: d.rehearsal, trigger: d.trigger }); }
  for (const [stepId, all] of byStep) {
    const s = flow.steps.find((x) => x.id === stepId);
    if (!s) continue;
    // evidence from a version of the step that no longer exists is stale: a fix applied since must not keep the finding
    const cur = engine.stepHash(s);
    const list = all.filter((x) => !x.stepHash || x.stepHash === cur);
    if (!list.length) continue;
    // rehearsals run in plan mode, which denies writes on purpose: their denials are not a permissions problem
    const den = list.filter((x) => !x.rehearsal).flatMap((x) => x.denials.map((d) => ({ ...d, runId: x.runId })));
    if (den.length) {
      const shellForm = den.filter((d) => /(^|\s)cd\s+\S+\s*(&&|;)|^\s*[A-Z_][A-Z0-9_]*=\S*\s|<<\s*['"]?\w+/.test(d.input || ''));
      const heads = [...new Set(den.filter((d) => !shellForm.includes(d)).map((d) => READ_CMDS.find((c) => String(d.input || '').trim().startsWith(`${c} `) || String(d.input || '').trim() === c)).filter(Boolean))];
      const newTools = heads.map((h) => `Bash(${h}:*)`).filter((t) => !tokens(s.allowedTools).includes(t));
      const patch = {};
      if (shellForm.length && !String(s.context || '').includes('sin "cd')) patch.context = `${s.context ? `${s.context}\n` : ''}${SHELL_RULE}`;
      if (newTools.length) patch.allowedTools = `${s.allowedTools || ''} ${newTools.join(' ')}`.trim();
      // runs from before spec 28 carry no step version: if every fixable denial is already fixed, it is not news
      const unknown = den.filter((d) => !shellForm.includes(d) && !READ_CMDS.some((c) => String(d.input || '').trim().startsWith(`${c} `) || String(d.input || '').trim() === c));
      if (Object.keys(patch).length || unknown.length) add({ rule: 'R-DENY', severity: list.some((x) => x.code === 'PERMISSION_DENIED') ? 'block' : 'risk', category: 'permissions', stepId, subject: [...new Set(den.map((d) => d.tool))].sort().join(','), title: `Se le denegaron ${den.length} comandos o herramientas`, detail: `${shellForm.length ? `${shellForm.length} por la forma del comando (cd …&&, VAR=x, heredoc). ` : ''}${newTools.length ? `Comandos de lectura que no tenía permitidos: ${heads.join(', ')}. ` : ''}${Object.keys(patch).length ? '' : 'Revisa si esas herramientas hacen falta: dárselas amplía el acceso.'}`, evidence: den.slice(0, 3).map((d) => ({ type: 'denial', runId: d.runId, stepId, quote: `${d.tool}: ${d.input}` })), fix: Object.keys(patch).length ? { kind: 'flow', patch: { steps: { [stepId]: patch } }, label: [patch.context && 'regla de comandos en el contexto', patch.allowedTools && `permitir ${newTools.join(' ')}`].filter(Boolean).join(' + ') } : null, check: 'La próxima corrida o el ensayo no tiene denegaciones de esa forma.' });
    }
    const falseOk = list.find((x) => !x.rehearsal && x.status === 'success' && (x.background.length || /\b(espero|esperando|waiting|en curso|sigue corriendo)\b/i.test(x.outputTail)) && x.outputLen < 400 && s.kind !== 'command');
    if (falseOk) add({ rule: 'R-FALSE-SUCCESS', severity: 'block', category: 'false-success', stepId, title: 'Terminó "bien" sin el resultado', detail: 'El agente dejó un comando corriendo en segundo plano y terminó su turno: el comando muere con la sesión y el step queda en success con una salida que no sirve.', evidence: [{ type: 'run', runId: falseOk.runId, stepId, quote: clip(falseOk.outputHead || falseOk.outputTail, 200) }, ...(falseOk.background[0] ? [{ type: 'event', runId: falseOk.runId, stepId, quote: `Bash en segundo plano: ${falseOk.background[0]}` }] : [])], fix: { kind: 'flow', patch: { steps: { [stepId]: { bashTimeoutMin: Math.max(60, Number(s.bashTimeoutMin) || 0), context: `${s.context ? `${s.context}\n` : ''}${BG_RULE}` } } }, label: 'Bash hasta 60 min + regla de no dejar comandos en segundo plano' }, check: 'La próxima corrida trae la salida completa y ningún Bash en segundo plano.' });
    const to = list.find((x) => x.timedOut.length);
    if (to && !falseOk) add({ rule: 'R-BASH-TIMEOUT', severity: 'risk', category: 'timeout', stepId, title: 'Un comando se cortó por tiempo', detail: 'Claude Code corta cada comando de Bash a los 10 minutos salvo que el step suba el límite.', evidence: [{ type: 'event', runId: to.runId, stepId, quote: to.timedOut[0] }], fix: { kind: 'flow', patch: { steps: { [stepId]: { bashTimeoutMin: 60 } } }, label: 'Bash hasta 60 min' }, check: 'No vuelve a aparecer "timed out".' });
    const mcpRun = list.find((x) => x.mcpMissing?.length);
    if (mcpRun && !out.some((x) => x.rule === 'R-MCP' && x.stepId === stepId)) add({ rule: 'R-MCP', severity: 'block', category: 'mcp', stepId, subject: mcpRun.mcpMissing.map((m) => m.server).join(','), title: 'En la última corrida faltó un conector MCP', detail: 'El CLI no cargó el conector que el step usa. Conéctalo al CLI o reemplaza la lectura por un step de comando con credencial.', evidence: [{ type: 'run', runId: mcpRun.runId, stepId, quote: `MCP faltante: ${mcpRun.mcpMissing.map((m) => `${m.server} (${m.status})`).join(', ')}` }] });
    const fails = list.filter((x) => ['error', 'timeout'].includes(x.status) && !x.rehearsal);
    if (fails.length >= 2) add({ rule: 'R-FLAKY', severity: 'risk', category: 'other', stepId, subject: 'flaky', title: `Falló en ${fails.length} de las últimas ${list.filter((x) => !x.rehearsal).length} corridas`, detail: `Códigos: ${[...new Set(fails.map((x) => x.code || x.status))].join(', ')}.`, evidence: fails.slice(0, 2).map((x) => ({ type: 'run', runId: x.runId, stepId, quote: x.error || x.code || x.status })) });
    const slow = list.find((x) => x.status === 'timeout' && !x.rehearsal);
    if (slow) add({ rule: 'R-SLOW', severity: 'risk', category: 'timeout', stepId, title: 'Se quedó sin tiempo', detail: 'El step superó su tiempo máximo. Si el trabajo es largo por naturaleza (suites, regresiones), súbelo.', evidence: [{ type: 'run', runId: slow.runId, stepId, quote: slow.error || 'timeout' }], fix: Number(s.timeoutSec) >= 7200 ? null : { kind: 'flow', patch: { steps: { [stepId]: { timeoutSec: 7200 } } }, label: 'Tiempo máximo del step: 2 h' } });
    const reh = list.find((x) => x.rehearsal);
    if (reh?.skipReason === 'rehearsal') add({ rule: 'R-REHEARSAL-SKIP', severity: 'improve', category: 'other', stepId, title: 'El ensayo no lo ejecutó (escribe fuera o borra)', detail: 'Lo que hace este step no se probó en el ensayo: revísalo a mano o pruébalo en un ambiente de prueba.', evidence: [{ type: 'run', runId: reh.runId, stepId, quote: reh.warnings[0] || 'omitido en el ensayo' }] });
    const missing = reh && /me falta/i.test(reh.outputHead + reh.outputTail) ? clip((reh.outputTail.split(/me falta/i).pop() || '').trim(), 200) : '';
    if (missing) add({ rule: 'R-REHEARSAL-MISSING', severity: 'risk', category: 'permissions', stepId, title: 'En el ensayo dijo que le falta algo', detail: `Según el propio step: ${missing}`, evidence: [{ type: 'run', runId: reh.runId, stepId, quote: missing }] });
  }

  // suppression: dismissed findings stay hidden while their anchor holds
  const sup = store.getSuppressed(flow.id);
  const visible = []; const hidden = [];
  for (const f of out) (sup[f.fp] && sup[f.fp].anchor === f.anchor ? hidden : visible).push(f);
  visible.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  for (const f of visible) if (f.fix && ['flow', 'structure', 'policy'].includes(f.fix.kind)) { const w = widensFor(flow, f.fix); if (w.length) f.widens = w; }
  return { findings: visible, hidden: hidden.map((f) => ({ fp: f.fp, title: f.title, reason: sup[f.fp].reason })), notVerifiable: [...new Set(notVerifiable)], machine: sys, digests: digests.map((d) => ({ runId: d.runId, status: d.status, trigger: d.trigger, rehearsal: d.rehearsal })), at: Date.now() };
}
function widensFor(flow, fix) {
  if (fix.kind === 'flow') return Object.entries(fix.patch?.steps || {}).flatMap(([ref, patch]) => { const s = flow.steps.find((x) => x.id === ref || x.name === ref); return engine.widensOf(s, patch, `${s?.name || ref}: `); });
  if (fix.kind === 'policy' && fix.policy?.scope === 'machine') return ['afecta a todos los flujos de esta instalación'];
  return [];
}

/** Applies the fix of one lint finding (recomputed now: never a stale one). */
export async function applyLintFix(flowId, fp, { confirmWiden = false } = {}) {
  const flow = store.getFlow(flowId);
  if (!flow) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  if (engine.isRunning(flowId)) throw Object.assign(new Error('El flujo se está ejecutando y sigue su proceso: aplica los cambios cuando termine.'), { status: 409, code: 'FLOW_RUNNING' });
  const lint = await lintFlow(flow, { probes: true });
  const f = lint.findings.find((x) => x.fp === fp);
  if (!f) throw Object.assign(new Error('Ese hallazgo ya no está (el flujo cambió o se resolvió): vuelve a revisar.'), { status: 409, code: 'REVIEW_STALE' });
  if (!f.fix) throw Object.assign(new Error('Este hallazgo no tiene un arreglo automático'), { status: 400, code: 'NO_FIX' });
  let result;
  if (f.fix.kind === 'action' && f.fix.action === 'cleanup-headless') result = await cleanupHeadless();
  else result = await engine.applyChange(flowId, '_review', { kind: f.fix.kind, patch: f.fix.patch, policy: f.fix.policy }, { confirmWiden });
  invalidate(flowId);
  return { applied: true, fp, result: f.fix.kind === 'action' ? result : { rev: result?.rev } };
}

/** "Descartar" with a reason; the finding stays hidden while its anchor (the step, or the flow's vars/policies) holds. */
export function suppress(flowId, fp, reason, anchor) {
  const flow = store.getFlow(flowId);
  if (!flow) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  const REASONS = ['no aplica', 'es intencional', 'riesgo aceptado', 'lo hago después'];
  const sup = store.getSuppressed(flowId);
  sup[fp] = { anchor: String(anchor || ''), reason: REASONS.includes(reason) ? reason : 'no aplica', at: Date.now() };
  store.setSuppressed(flowId, sup);
  invalidate(flowId);
  return { fp, suppressed: true };
}
export function unsuppress(flowId, fp) { const sup = store.getSuppressed(flowId); delete sup[fp]; store.setSuppressed(flowId, sup); invalidate(flowId); return { fp, suppressed: false }; }

// ---------------- AI review ----------------
const active = new Map(); // flowId -> {controller, reviewId}
const REVIEW_MODEL = () => store.getConfig().review?.model || 'sonnet';
// a run's text cannot close the block early
const UNTRUSTED = (s) => `<untrusted-data>\n${String(s).replace(/<\/?untrusted-data>/gi, '[etiqueta]')}\n</untrusted-data>`;

/** Everything the reviewers see, bounded (40k chars) and with secrets masked. Priority: lint > failures > successes. */
export function buildDossier(flow, lint, digests) {
  const sup = store.getSuppressed(flow.id);
  // configuration first and whole (a long task must never hide allowedTools or the limits: real bug found on a real
  // flow); long texts are clipped one by one
  const def = flow.steps.map((s) => {
    const { lastRun, memory, chatSessionId, chatContextHash, position, pinned, role, task, context, command, hooks, ...cfg } = s;
    const txt = [['role', role, 1500], ['task', task, 2500], ['context', context, 1200], ['command', command, 2500], ['hooks', hooks, 800]].filter(([, v]) => String(v || '').trim()).map(([k, v, n]) => `${k}:\n${clip(v, n)}`).join('\n');
    return `### ${s.name} [${s.id}] (${s.kind}${s.skillRef ? `: ${s.skillRef}` : ''}${s.agentRef ? `: ${s.agentRef}` : ''})\nconfiguración: ${JSON.stringify(cfg)}\n${txt}`;
  }).join('\n\n');
  const edges = (flow.edges || []).map((e) => `${stepName(flow, e.source)} → ${stepName(flow, e.target)}${e.when?.type && e.when.type !== 'always' ? ` (si ${e.when.type})` : ''}`).join('\n');
  const pol = POL.effective(flow).map((p) => `- [${p.scope}] ${p.type}: ${p.text}${Object.keys(p.params || {}).length ? ` ${JSON.stringify(p.params)}` : ''}`).join('\n') || '(ninguna)';
  const lintTxt = lint.findings.map((f) => `- [${f.rule}] ${f.severity} · ${f.stepName || 'flujo'}: ${f.title}`).join('\n') || '(sin hallazgos)';
  const sys = `CLI: ${lastInit.version || '?'} · conectores MCP cargados: ${(lastInit.mcpServers || []).map((m) => `${m.name}=${m.status}`).join(', ') || 'desconocido'} · BASH_MAX_TIMEOUT_MS: ${lint.machine?.bashMaxMs || 'sin definir (10 min)'} · navegadores de prueba abiertos: ${lint.machine?.headless ?? '?'} · sistema: ${process.platform}`;
  const runTxt = digests.sort((a, b) => (a.status === 'success') - (b.status === 'success')).map((d) => `#### ${d.runId} ${d.rehearsal ? '(ENSAYO) ' : ''}${d.status} · ${d.trigger}${d.only ? ` · solo ${stepName(flow, d.only)}` : ''} · ${Math.round(d.durationMs / 1000)} s${d.deadlineMs ? ` de ${Math.round(d.deadlineMs / 1000)} s` : ''}\n${d.steps.map((s) => `- ${s.step}: ${s.status}${s.code ? ` ${s.code}` : ''}${s.skipReason ? ` (${s.skipReason})` : ''} · ${Math.round((s.durationMs || 0) / 1000)} s · intentos ${s.attempts}${Object.keys(s.tools).length ? ` · tools ${JSON.stringify(s.tools)}` : ''}${s.denials.length ? `\n  denegado: ${s.denials.map((x) => `${x.tool} «${x.input}» ×${x.n}`).join(' | ')}` : ''}${s.background.length ? `\n  Bash en segundo plano: ${s.background.join(' | ')}` : ''}${s.timedOut.length ? `\n  cortado por tiempo: ${s.timedOut[0]}` : ''}${s.mcpMissing.length ? `\n  MCP faltante: ${s.mcpMissing.map((m) => m.server).join(', ')}` : ''}${s.error ? `\n  error: ${s.error}` : ''}${s.warnings.length ? `\n  avisos: ${s.warnings.join(' | ')}` : ''}\n  salida (${s.outputLen} chars): ${s.outputHead}${s.outputLen > 600 ? ` … ${s.outputTail}` : ''}`).join('\n')}`).join('\n\n') || '(nunca se ejecutó)';
  const supTxt = Object.entries(sup).map(([fp, v]) => `- ${fp}: ${v.reason}`).join('\n') || '(ninguno)';
  const parts = [
    `# Flujo «${flow.name}»\n${flow.description || ''}\nDirectorio de trabajo: ${flow.cwd || '(vacío)'} · tiempo máximo de una ejecución: ${flow.runTimeoutSec || 3600} s · programación: ${flow.schedule?.enabled ? `cada ${flow.schedule.everyMinutes} min` : 'no'}\nVariables: ${clip(JSON.stringify(flow.vars || {}), 1500)}`,
    `## Políticas vigentes\n${pol}`,
    `## Lint determinista (ya se muestra a la persona)\n${lintTxt}`,
    `## Máquina\n${sys}`,
    `## Steps\n${def}\n\n## Flechas\n${edges || '(ninguna)'}`,
    `## Descartados por la persona (no repetir sin evidencia nueva)\n${supTxt}`,
    `## Últimas ejecuciones y ensayos\n${UNTRUSTED(runTxt)}`,
  ];
  let text = parts.join('\n\n');
  if (text.length > 40000) text = `${parts.slice(0, 6).join('\n\n')}\n\n## Últimas ejecuciones y ensayos\n${UNTRUSTED(clip(runTxt, Math.max(4000, 40000 - parts.slice(0, 6).join('\n\n').length - 200)))}`;
  if (text.length > 40000) text = clip(text, 40000);
  // secrets: variables whose NAME looks secret (bundle.SECRET_NAME) + anything shaped like a token (adversarial review)
  const secretVals = Object.entries(flow.vars || {}).filter(([k, v]) => SECRET_NAME.test(k) && String(v || '').length >= 6).map(([, v]) => String(v));
  return engine.maskSecrets(new Set(secretVals))(text).replace(new RegExp(SECRET_RE.source, 'gi'), (m) => `${m.slice(0, 6)}••••`);
}

/** The evidence a model cites must exist: the run, the step, and the quote (normalized) in that run or the definition. */
/** All string VALUES of an object (never its keys: "task" must not verify anything). */
function valuesText(o, out = []) {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => valuesText(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => valuesText(x, out));
  return out;
}
function verifyEvidence(flow, dossier, digests, ev) {
  if (!ev || typeof ev !== 'object') return false;
  const q = norm(ev.quote).replace(/[…]+$/, '').slice(0, 80);
  if (q.length < 12) return false; // a real quote, not a word that is everywhere (adversarial review)
  if (['run', 'event', 'denial'].includes(ev.type)) {
    const d = digests.find((x) => x.runId === ev.runId);
    return !!d && norm(valuesText(d).join(' ')).includes(q);
  }
  const { lastRun, memory, ...rest } = flow;
  return norm(valuesText({ ...rest, steps: flow.steps.map(({ lastRun: _l, memory: _m, chatSessionId, chatContextHash, ...s }) => s) }).join(' ')).includes(q) || norm(dossier.replace(/<untrusted-data>[\s\S]*<\/untrusted-data>/, '')).includes(q);
}
const resolveStep = (flow, ref) => (ref && !/^(flujo|flow)$/i.test(ref) ? flow.steps.find((s) => s.id === ref || s.name.toLowerCase() === String(ref).toLowerCase()) : null);

function cleanFinding(flow, dossier, digests, x, role) {
  if (!x || typeof x !== 'object' || !x.claim) return null;
  const s = resolveStep(flow, x.step);
  const evidence = (Array.isArray(x.evidence) ? x.evidence : []).slice(0, 4).map((e) => ({ type: String(e?.type || 'def'), runId: e?.runId || undefined, step: e?.step || undefined, quote: clip(e?.quote, 200), verified: verifyEvidence(flow, dossier, digests, e) }));
  const verified = evidence.some((e) => e.verified);
  let severity = SEV[x.severity] !== undefined ? x.severity : 'risk';
  if (!verified) severity = 'improve'; // adversarial: an unverifiable claim never blocks
  const category = P.REVIEW_CATEGORIES.includes(x.category) ? x.category : 'other';
  const fx = x.fix && typeof x.fix === 'object' ? x.fix : null;
  let fix = null;
  if (fx?.kind === 'flow' && fx.patch && typeof fx.patch === 'object') fix = { kind: 'flow', patch: { ...(fx.patch.steps ? { steps: fx.patch.steps } : {}), ...(fx.patch.vars ? { vars: fx.patch.vars } : {}) } };
  else if (fx?.kind === 'structure' && Array.isArray(fx.patch?.addSteps)) fix = { kind: 'structure', patch: { addSteps: fx.patch.addSteps.slice(0, 3) } };
  else if (fx?.kind === 'policy' && (fx.patch || fx.policy)) fix = { kind: 'policy', policy: fx.policy || fx.patch };
  if (fix && !Object.keys(fix.patch || fix.policy || {}).length) fix = null;
  return { role, severity, category, stepId: s?.id || null, stepName: s?.name || null, claim: clip(x.claim, 500), evidence, verified, fix, check: clip(fx?.check, 300) };
}

/** Same problem from both reviewers → one finding with both sources; different fixes → dissent shown, the
 *  verifiable/structural one recommended (adversarial: the rule decides, not the most convincing voice). */
function merge(flow, cons, adv) {
  const key = (f) => `${f.category}|${f.stepId || 'flow'}`;
  const out = new Map();
  const rank = (f) => (f.fix ? { structure: 0, policy: 1, flow: 2 }[f.fix.kind] ?? 3 : 4) - (f.check ? 0.5 : 0) - (f.verified ? 1 : 0);
  let n = 0;
  for (const f of [...cons, ...adv]) {
    const k = key(f);
    const cur = out.get(k);
    // only findings of DIFFERENT reviewers merge: two problems one reviewer found in the same step stay two (adversarial)
    if (!cur || cur.sources.includes(f.role)) { out.set(cur ? `${k}#${++n}` : k, { ...f, sources: [f.role] }); continue; }
    if (!cur.sources.includes(f.role)) cur.sources.push(f.role);
    if (SEV[f.severity] < SEV[cur.severity]) cur.severity = f.severity;
    cur.evidence = [...cur.evidence, ...f.evidence.filter((e) => !cur.evidence.some((c) => c.quote === e.quote))].slice(0, 5);
    cur.verified = cur.verified || f.verified;
    const sameFix = JSON.stringify(cur.fix) === JSON.stringify(f.fix);
    if (!sameFix && f.fix) {
      const [best, other] = rank(f) < rank(cur) ? [f, cur] : [cur, f];
      cur.dissent = `${other.role === 'adversarial' ? 'Adversarial' : 'Constructivo'} propone otra cosa: ${clip(other.claim, 220)}${other.fix ? ` (arreglo: ${other.fix.kind})` : ''}`;
      cur.fix = best.fix; cur.check = best.check || cur.check; cur.claim = best.claim;
    } else if (f.role !== cur.role && f.claim !== cur.claim) cur.also = clip(f.claim, 300);
  }
  return [...out.entries()].map(([k, f]) => ({ ...f, fp: sha(`ai|${k}|${f.fix?.kind || 'none'}`), anchor: anchorOf(flow, f.stepId) }));
}

export function activeReview(flowId) { return active.get(flowId)?.reviewId || null; }
export function cancelReview(flowId, reviewId) {
  const a = active.get(flowId);
  if (!a || (reviewId && a.reviewId !== reviewId)) return false;
  a.controller.abort(); return true;
}

/** Starts the AI review (async). Never while the flow runs; a run that starts meanwhile cancels it (it needs the slots). */
export async function startReview(flowId) {
  const flow = store.getFlow(flowId);
  if (!flow) throw Object.assign(new Error('Flujo no encontrado'), { status: 404 });
  if (flow.quarantine) throw Object.assign(new Error('El flujo importado está en revisión de seguridad: confírmalo antes.'), { status: 423, code: 'QUARANTINED' });
  if (engine.isRunning(flowId)) throw Object.assign(new Error('El flujo se está ejecutando y sigue su proceso: revísalo cuando termine.'), { status: 409, code: 'FLOW_RUNNING' });
  if (active.has(flowId)) throw Object.assign(new Error('Ya hay una revisión en curso de este flujo'), { status: 409, code: 'REVIEW_RUNNING' });
  // reserve the slot BEFORE the first await: a double click or a run starting meanwhile is seen (adversarial review)
  const controller = new AbortController();
  const slot = { controller, reviewId: null, rv: {} };
  active.set(flowId, slot);
  let lint; let digests; let dossier;
  try {
    lint = await lintFlow(flow, { probes: true });
    digests = recentDigests(flow);
    dossier = buildDossier(flow, lint, digests);
    if (controller.signal.aborted) throw Object.assign(new Error(slot.rv.cancelReason || 'Cancelada'), { status: 409, code: 'REVIEW_CANCELLED' });
  } catch (e) { active.delete(flowId); throw e; }
  const rv = { id: store.uid('rv_'), flowId, status: 'running', startedAt: Date.now(), flowHash: store.definitionHash(flow), stepHashes: Object.fromEntries(flow.steps.map((s) => [s.id, engine.stepHash(s)])), runIds: digests.map((d) => d.runId), lintCount: lint.findings.length, dossierChars: dossier.length, roles: {}, findings: [], notVerifiable: [...lint.notVerifiable], totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  store.saveReview(rv);
  slot.reviewId = rv.id; slot.rv = rv;
  deps.emit({ type: 'review.started', flowId, reviewId: rv.id });
  (async () => {
    const addDirs = [...new Set(flow.steps.map((s) => (s.kind === 'skill' ? findSkill(s.skillRef, flow.cwd) : s.kind === 'agent' ? findAgent(s.agentRef, flow.cwd) : null)).filter(Boolean).map((r) => path.dirname(r.path)))];
    const call = async (role) => {
      deps.emit({ type: 'review.progress', flowId, reviewId: rv.id, role });
      // an empty working folder (never the user's home: an injected "read ~/.ssh" finds nothing); skills/agents via addDirs
      const cwd = path.join(os.tmpdir(), 'afs-review'); fs.mkdirSync(cwd, { recursive: true });
      const r = await runClaude({ systemPrompt: P.reviewRoleSystem(role), prompt: dossier, model: REVIEW_MODEL(), tools: 'Read,Grep,Glob', allowedTools: 'Read Grep Glob', disallowedTools: engine.CHAT_DISALLOWED, strictMcp: true, noPersist: true, addDirs, cwd, signal: controller.signal });
      rv.totals.inputTokens += (r.usage?.input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0); rv.totals.outputTokens += r.usage?.output_tokens || 0; rv.totals.costUsd += r.costUsd || 0;
      const json = r.isError ? null : P.parseJsonLoose(r.text);
      rv.roles[role] = { ok: !!json, error: r.isError ? clip(r.error, 300) : json ? null : 'no devolvió JSON', raw: json ? undefined : clip(r.text, 1500) };
      if (json?.notVerifiable) rv.notVerifiable.push(...(Array.isArray(json.notVerifiable) ? json.notVerifiable : []).slice(0, 6).map((x) => clip(x, 240)));
      return (Array.isArray(json?.findings) ? json.findings : []).slice(0, 8).map((x) => cleanFinding(flow, dossier, digests, x, role)).filter(Boolean);
    };
    try {
      // serial, not parallel: 2 slots would starve a scheduled run (adversarial review); independent: the adversarial
      // reviewer never sees the constructive answer
      const cons = await call('constructive');
      if (controller.signal.aborted) throw new Error('aborted');
      const adv = await call('adversarial');
      if (controller.signal.aborted) throw new Error('aborted');
      const sup = store.getSuppressed(flowId);
      const cur = store.getFlow(flowId) || flow;
      let merged = merge(cur, cons, adv).filter((f) => !(sup[f.fp] && sup[f.fp].anchor === f.anchor));
      merged.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (b.verified - a.verified));
      merged = merged.slice(0, 10).map((f, i) => ({ ...f, id: `fd_${i + 1}` }));
      // findings with a fix become proposals of the '_review' chat (applied through the same checks as any proposal)
      const props = engine.prepareReviewProposals(cur, merged.filter((f) => f.fix).map((f) => ({ ...f.fix, findingId: f.id })));
      for (const p of props) { const f = merged.find((x) => x.id === p.findingId); if (f) f.proposalId = p.id; }
      rv.findings = merged;
      rv.notVerifiable = [...new Set(rv.notVerifiable)].slice(0, 12);
      const bothFailed = !rv.roles.constructive?.ok && !rv.roles.adversarial?.ok;
      rv.status = bothFailed ? 'error' : 'done';
      if (bothFailed) rv.error = rv.roles.constructive?.error || rv.roles.adversarial?.error || 'Los revisores no devolvieron un resultado válido';
      const text = summaryText(rv);
      const msg = store.appendChat(flowId, '_review', { id: store.uid('c_'), role: 'assistant', text, at: Date.now(), origin: 'review', status: 'done', events: [], proposals: props, remembered: [], reviewId: rv.id });
      rv.messageId = msg.id;
      deps.emit({ type: 'chat.message', flowId, key: '_review', message: msg });
    } catch (e) {
      rv.status = controller.signal.aborted ? 'cancelled' : 'error';
      rv.error = controller.signal.aborted ? (rv.cancelReason || 'Cancelada') : clip(e.message, 300);
    } finally {
      rv.endedAt = Date.now();
      store.saveReview(rv);
      if (active.get(flowId) === slot) active.delete(flowId);
      invalidate(flowId);
      deps.emit({ type: 'review.done', flowId, reviewId: rv.id, status: rv.status });
    }
  })();
  return { reviewId: rv.id, dossierChars: dossier.length };
}
function summaryText(rv) {
  if (rv.status === 'error') return `⚠️ La revisión no pudo completarse: ${rv.error}`;
  const n = (s) => rv.findings.filter((f) => f.severity === s).length;
  const lines = [`**Revisión ${rv.id}** — ${rv.findings.length} hallazgos (${n('block')} ⛔, ${n('risk')} ⚠, ${n('improve')} 💡) de dos revisiones independientes (constructiva y adversarial).`];
  for (const f of rv.findings) lines.push(`- ${f.severity === 'block' ? '⛔' : f.severity === 'risk' ? '⚠' : '💡'} **${f.stepName || 'Flujo'}** — ${f.claim}${f.verified ? '' : ' _(sin evidencia verificable)_'}${f.dissent ? `\n  ↔ ${f.dissent}` : ''}`);
  if (rv.notVerifiable.length) lines.push(`\n**No pude verificar:** ${rv.notVerifiable.join(' · ')}`);
  lines.push('\nLas propuestas de abajo no cambian nada hasta que las apliques. Puedes discutir cualquiera aquí (por ejemplo «@adversarial ¿y si…?»).');
  return lines.join('\n');
}

/** Context of the '_review' chat. */
export function reviewContextBlock(flow) {
  const latest = store.listReviews(flow.id)[0];
  const rv = latest ? store.getReview(flow.id, latest.id) : null;
  const cached = lintCache.get(flow.id)?.data;
  const pol = POL.effective(flow).map((p) => `- [${p.scope}] ${p.type}: ${p.text}`).join('\n') || '(ninguna)';
  const lintTxt = (cached?.findings || []).map((f) => `- [${f.rule}] ${f.severity} · ${f.stepName || 'flujo'}: ${f.title}`).join('\n') || '(no calculado o sin hallazgos)';
  const rvTxt = rv ? `${rv.id} (${rv.status}${rv.flowHash !== store.definitionHash(flow) ? ', el flujo cambió desde entonces' : ''})\n${(rv.findings || []).map((f) => `- ${f.id} ${f.severity} [${(f.sources || []).join('+')}] ${f.stepName || 'flujo'}: ${f.claim}${f.dissent ? ` | desacuerdo: ${f.dissent}` : ''}${f.verified ? '' : ' (sin evidencia verificable)'}`).join('\n')}\nNo verificable: ${(rv.notVerifiable || []).join(' · ') || '—'}` : '(no hubo revisión con IA todavía)';
  const sup = Object.entries(store.getSuppressed(flow.id)).map(([fp, v]) => `- ${fp}: ${v.reason}`).join('\n') || '(ninguno)';
  const body = `${P.flowContextBlock(flow).text}\n\nPolíticas vigentes:\n${pol}\n\nLint:\n${lintTxt}\n\nÚltima revisión:\n${rvTxt}\n\nDescartados:\n${sup}`;
  return { text: `<review-context>\n${body}\n</review-context>`, hash: sha(body, 40) };
}

// ---------------- cache + attention ----------------
// The 🔔 item needs the lint without blocking and without re-reading every run on each autosave: one computation in
// flight per flow, at most every 30 s while edits keep coming (the item may lag a few seconds; the panel is always fresh).
const lintCache = new Map(); // flowId -> {at, data, stale}
const inflight = new Map();
export function invalidate(flowId) { const c = lintCache.get(flowId); if (c) c.stale = true; schedule(flowId, 0); }
function schedule(flowId, waitMs) {
  if (inflight.has(flowId)) return;
  const t = setTimeout(async () => {
    try { const flow = store.getFlow(flowId); if (flow) lintCache.set(flowId, { at: Date.now(), data: await lintFlow(flow, { probes: false }), stale: false }); else lintCache.delete(flowId); }
    // a failing lint is cached as "nothing" (not stale): never a hot loop of retries (adversarial review)
    catch (e) { console.error('review lint', e.message); lintCache.set(flowId, { at: Date.now(), data: lintCache.get(flowId)?.data || { findings: [] }, stale: false, error: e.message }); }
    finally { inflight.delete(flowId); deps.refreshAttention?.(flowId); }
  }, waitMs);
  inflight.set(flowId, t);
}
export async function cachedLint(flowId) {
  const c = lintCache.get(flowId);
  if (c && !c.stale) return c.data;
  const flow = store.getFlow(flowId);
  if (!flow) return null;
  const data = await lintFlow(flow, { probes: false });
  lintCache.set(flowId, { at: Date.now(), data, stale: false });
  return data;
}
/** The 🔔 item of a flow (spec 27 kind 'review'): blocking findings, or a finished AI review with open proposals. */
export function attentionItem(flow) {
  const c0 = lintCache.get(flow.id);
  if (!c0) { schedule(flow.id, 0); return null; }
  if (c0.stale) schedule(flow.id, Math.max(0, 30000 - (Date.now() - c0.at)));
  const c = c0.data;
  const blocks = c.findings.filter((f) => f.severity === 'block');
  const latest = store.listReviews(flow.id)[0];
  let open = 0;
  if (latest?.status === 'done') { const rv = store.getReview(flow.id, latest.id); const msg = rv?.messageId && store.getChat(flow.id, '_review').find((m) => m.id === rv.messageId); open = (msg?.proposals || []).filter((p) => !p.applied && !p.discarded && !p.error).length; }
  if (!blocks.length && !open) return null;
  return {
    id: `review:${flow.id}`, kind: 'review', severity: blocks.length ? 'error' : 'warn', flowId: flow.id, flowName: flow.name,
    title: blocks.length ? `🩺 ${blocks.length} problema${blocks.length > 1 ? 's' : ''} que van a hacer fallar el flujo` : `🩺 Revisión lista: ${open} propuesta${open > 1 ? 's' : ''}`,
    detail: clip(blocks[0]?.title || 'Revisa y decide qué aplicar.', 160), createdAt: latest?.endedAt || c.at,
    stateKey: sha([...blocks.map((f) => f.fp)].sort().join('|') + `|${latest?.id || ''}:${open}`, 12), target: { flowId: flow.id, open: 'flowreview' },
  };
}

export function init(d) {
  deps = { ...deps, ...d };
  engine.setReviewContextProvider(reviewContextBlock);
  d.bus.on('msg', (m) => {
    if (!m?.flowId) { if (m?.type === 'flows.changed' || m?.type === 'credentials.changed') for (const c of lintCache.values()) c.stale = true; return; }
    if (m.type === 'flow.deleted') { lintCache.delete(m.flowId); return; }
    if (m.type === 'flow.updated' || m.type === 'run.finished') { const c = lintCache.get(m.flowId); if (c) c.stale = true; }
    // a run (scheduled, external, manual) has priority over a review: it needs the Claude slots
    if (m.type === 'run.started') { const a = active.get(m.flowId); if (a) { a.rv.cancelReason = 'Se canceló porque arrancó una ejecución del flujo (las ejecuciones tienen prioridad)'; a.controller.abort(); } }
  });
}
