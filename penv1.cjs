const fs = require('fs');
const edit = (f, pairs) => { let c = fs.readFileSync(f, 'utf8'); for (const [a, b] of pairs) { if (!c.includes(a)) throw new Error(`${f} missing: ${a.slice(0, 100)}`); c = c.split(a).join(b); } fs.writeFileSync(f, c); };

// ---------- B3: {{run.id}} / {{run.short}} / {{run.date}} ----------
edit('server/prompt.js', [
  ["  if (key === 'input') return ctx.input ?? '';", "  if (key === 'input') return ctx.input ?? '';\n  // Run identity for names that must be unique per run (branch, compose project, labels, artifact folders) — spec 22\n  if (key === 'run.id') return ctx.runId ?? '';\n  if (key === 'run.short') return String(ctx.runId ?? '').replace(/^r_/, '');\n  if (key === 'run.date') return new Date().toISOString().slice(0, 10);"],
]);
edit('server/sources.js', [
  ["const renderRef = (v, flow, input) => P.render(String(v || ''), { flow, vars: flow.vars, input }).trim();", "const renderRef = (v, flow, input, runId) => P.render(String(v || ''), { flow, vars: flow.vars, input, runId }).trim();"],
  ["export function resolveSource(src, { flow, input = '' } = {}) {", "export function resolveSource(src, { flow, input = '', runId } = {}) {"],
  ["export function resolveContext(flow, step, { input = '' } = {}) {", "export function resolveContext(flow, step, { input = '', runId } = {}) {"],
  ["    const r = resolveSource(s, { flow, input });", "    const r = resolveSource(s, { flow, input, runId });"],
]);
let src = fs.readFileSync('server/sources.js', 'utf8');
src = src.replace(/renderRef\((src\.(?:path|url|ref)), flow, input\)/g, 'renderRef($1, flow, input, runId)');
fs.writeFileSync('server/sources.js', src);

// ---------- engine: B1 cwd, B2 finally, B3 runId in context ----------
edit('server/engine.js', [
  ["const flowCwd = (flow) => (flow.cwd && fs.existsSync(flow.cwd) ? flow.cwd : os.homedir());",
   `const flowCwd = (flow) => (flow.cwd && fs.existsSync(flow.cwd) ? flow.cwd : os.homedir());
/** Spec 22 (B1): a configured working directory that does not exist is an error, never a silent fallback to home. */
export function cwdProblem(flow) {
  if (flow.cwd && !fs.existsSync(flow.cwd)) return { status: 422, code: 'CWD_MISSING', error: \`El directorio de trabajo del flujo no existe: \${flow.cwd}. Créalo o corrige "Directorio de trabajo" (los steps no se ejecutan en tu carpeta de usuario por error).\` };
  return null;
}
/** Steps that can change files or run commands. */
export const stepWrites = (step) => step.kind === 'command' || /(^|[\\s,])(Edit|Write|Bash|NotebookEdit)\\b/.test(String(step.allowedTools || '')) || step.permissionMode === 'acceptEdits' || step.permissionMode === 'bypassPermissions';
export const cwdWarning = (flow, step) => (!flow.cwd && stepWrites(step) ? \`El flujo no tiene directorio de trabajo: este step puede editar o ejecutar comandos y lo hará en tu carpeta de usuario (\${os.homedir()}). Define "Directorio de trabajo" en la pestaña Flujo.\` : null);`],
  ["      const cx = await resolveContext(flow, step, { input: ctx.input });", "      const cx = await resolveContext(flow, step, { input: ctx.input, runId: run.id });"],
  ["    if (hookCompileError) throw hookCompileError;", "    if (hookCompileError) throw hookCompileError;\n    { const cp = cwdProblem(flow); if (cp) throw Object.assign(new Error(cp.error), { code: cp.code }); const cw = cwdWarning(flow, step); if (cw) rs.warnings.push(cw); }"],
  ["  const flow = store.getFlow(flowId);\n  if (!flow) throw new Error('Flujo no encontrado');\n  if (only && !flow.steps.some((s) => s.id === only)) throw new Error('Step no encontrado');",
   "  const flow = store.getFlow(flowId);\n  if (!flow) throw new Error('Flujo no encontrado');\n  if (only && !flow.steps.some((s) => s.id === only)) throw new Error('Step no encontrado');\n  { const cp = cwdProblem(flow); if (cp) throw Object.assign(new Error(cp.error), { status: cp.status, code: cp.code }); }"],
  ["    clearTimeout(deadline); clearInterval(flusher);\n    for (const k of [...pendingReviews.keys()])",
   "    clearTimeout(deadline);\n    // Spec 22 (B2): \"Al terminar\" runs after every full run, whatever its status (cleanup, notifications).\n    if (!only && hasFinally(rflow)) { try { run.finally = await runFinally(rflow, run, { input, data, status: run.status }); } catch (e) { run.finally = { status: 'error', error: e.message }; } }\n    clearInterval(flusher);\n    for (const k of [...pendingReviews.keys()])"],
  ["/** Paused runs waiting for a review decision:", `// ---------- "Al terminar" (spec 22, B2) ----------
const hasFinally = (flow) => !!(flow.finally && !flow.finally.disabled && String(flow.finally.command || '').trim());
/** Runs the flow's final command. Env: AFS_RUN_ID, AFS_RUN_STATUS, AFS_RUN_STEPS_JSON ({step: status}), FLOW_INPUT, AFS_FLOW. */
export async function runFinally(flow, run, { input = '', data = new Map(), status = run.status } = {}) {
  const f = flow.finally;
  const shell = f.shell || 'powershell';
  const q = P.shellQuoter(shell, f.command);
  const cmd = P.render(f.command, { flow, vars: flow.vars, input, data, runId: run.id, quote: q.quote });
  const steps = Object.fromEntries(Object.entries(run.steps || {}).filter(([id]) => !id.includes('~')).map(([id, s]) => [flow.steps.find((x) => x.id === id)?.name || id, s.status]));
  const ctl = new AbortController();
  const limit = clampInt(f.timeoutSec, 5, 3600, 300);
  const t = setTimeout(() => ctl.abort(), limit * 1000);
  const startedAt = now();
  emit({ type: 'run.finally', flowId: flow.id, runId: run.id, status: 'running' });
  const r = await sh(cmd, { cwd: flowCwd(flow), shell, input: '', env: { ...q.env, AFS_RUN_ID: run.id, AFS_RUN_STATUS: status, AFS_RUN_STEPS_JSON: JSON.stringify(steps), FLOW_INPUT: input || '', AFS_FLOW: flow.name }, signal: ctl.signal, delayed: q.values.length > 0 });
  clearTimeout(t);
  const res = { status: ctl.signal.aborted ? 'timeout' : r.code === 0 ? 'success' : 'error', exitCode: r.code, output: clipS(r.stdout.trim(), 4000), error: r.code === 0 ? undefined : clipS((r.stderr || r.stdout).trim(), 2000), startedAt, endedAt: now(), runStatus: status };
  emit({ type: 'run.finally', flowId: flow.id, runId: run.id, status: res.status });
  return res;
}

/** Paused runs waiting for a review decision:`],
  // stale runs: run "Al terminar" for runs interrupted by a crash (cleanup must still happen)
  ["      r.totals = runTotals(r);\n      delete r.dirty;\n      store.saveRun(r); n++;",
   "      r.totals = runTotals(r);\n      delete r.dirty;\n      store.saveRun(r); n++;\n      const fl = store.getFlow(f.id);\n      if (fl && hasFinally(fl) && !r.only && !r.finally) {\n        runFinally({ ...fl, vars: r.vars || fl.vars }, r, { input: r.input, status: 'interrupted' }).then((res) => { const cur = store.getRun(f.id, r.id); if (cur) { cur.finally = res; store.saveRun(cur); } }).catch(() => {});\n      }"],
  // summary exposes it
  ["vars: run.vars, usedPins: run.usedPins || [], pauses: nz(run.pauses),", "vars: run.vars, usedPins: run.usedPins || [], finally: run.finally || undefined, pauses: nz(run.pauses),"],
]);
// externalRunProblem: raw templates in "Al terminar" with external data are rejected too
let e = fs.readFileSync('server/engine.js', 'utf8');
const ep = "export function externalRunProblem(flow, { only = null, vars = null } = {}) {\n  const steps = only ? flow.steps.filter((s) => s.id === only) : flow.steps;\n  const reqVars = new Set(Object.keys(vars || {}));";
if (!e.includes(ep)) throw new Error('externalRunProblem');
e = e.replace(ep, ep + "\n  const cp = cwdProblem(flow); if (cp) return cp;\n  if (!only && hasFinally(flow)) {\n    for (const k of P.rawPlaceholders(flow.finally.command)) {\n      if (k === 'input' || k.startsWith('steps.') || (k.startsWith('vars.') && reqVars.has(k.slice(5).split('.')[0]))) return { status: 422, code: 'RAW_TEMPLATE_EXTERNAL', error: `\"Al terminar\" inserta {{{${k}}}} sin protección: no se permite con datos que vienen de fuera. Usa {{${k}}}.` };\n    }\n  }");
fs.writeFileSync('server/engine.js', e);

// ACCESS presets (engine, used by the AI flow generator)
edit('server/engine.js', [
  ["  dev: { tools: `${READ} Edit Write Bash`, perm: 'acceptEdits' },", "  dev: { tools: `${READ} Edit Write Bash`, perm: 'acceptEdits' },\n  // Spec 22 (B4): terminal limited to git (no push) and docker; no web (prompt injection through pages)\n  'dev-restricted': { tools: `Read Grep Glob Skill Edit Write ${RESTRICTED_BASH}`, perm: 'acceptEdits' },\n  'read-local': { tools: 'Read Grep Glob Skill', perm: '' },"],
  ["const READ = 'Read Grep Glob WebFetch WebSearch Skill';", "const READ = 'Read Grep Glob WebFetch WebSearch Skill';\nexport const RESTRICTED_BASH = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git switch', 'git checkout', 'git fetch', 'git branch', 'git rev-parse', 'docker', 'docker compose'].map((c) => `Bash(${c}:*)`).join(' ');"],
]);

// context.js preview: warnings + runId sample
edit('server/context.js', [
  ["import { cliOptions, ancestorsOf, evalAssertion } from './engine.js';", "import { cliOptions, ancestorsOf, evalAssertion, cwdProblem, cwdWarning } from './engine.js';"],
  ["  : await resolveContext(rflow, step, { input });", "  : await resolveContext(rflow, step, { input, runId: run?.id || 'r_ejemplo' });\n  { const cp = cwdProblem(flow); if (cp) warn('CWD_MISSING', cp.error, 'around'); const cw = cwdWarning(flow, step); if (cw) warn('CWD_EMPTY', cw, 'around'); }"],
  ["  const rctx = (strict) => ({ runId: run?.id, refs,", "  const rctx = (strict) => ({ runId: run?.id || 'r_ejemplo', refs,"],
]);

// index.js: PUT keeps "finally"; UI run start errors carry code; versions include it
edit('server/index.js', [
  ["contextSources: cleanSources(body.contextSources) ?? cur.contextSources, steps, edges };", "contextSources: cleanSources(body.contextSources) ?? cur.contextSources, finally: cleanFinally(body.finally) ?? cur.finally, steps, edges };"],
  ["// Context sources (spec 21): only known types and fields, bounded sizes.", "/** \"Al terminar\" (spec 22): one command run after every full run. */\nfunction cleanFinally(f) {\n  if (f === null) return null;\n  if (!f || typeof f !== 'object') return undefined;\n  return { command: String(f.command || '').slice(0, 20000), shell: ['powershell', 'bash', 'cmd'].includes(f.shell) ? f.shell : 'powershell', timeoutSec: Math.min(3600, Math.max(5, Number(f.timeoutSec) || 300)), ...(f.disabled ? { disabled: true } : {}) };\n}\n\n// Context sources (spec 21): only known types and fields, bounded sizes."],
  ["schedule: d.schedule, runTimeoutSec: d.runTimeoutSec, versionEveryMin: d.versionEveryMin, contextSources: d.contextSources, steps,", "schedule: d.schedule, runTimeoutSec: d.runTimeoutSec, versionEveryMin: d.versionEveryMin, contextSources: d.contextSources, finally: d.finally, steps,"],
]);
edit('server/store.js', [
  ["versionEveryMin: f.versionEveryMin, contextSources: f.contextSources,", "versionEveryMin: f.versionEveryMin, contextSources: f.contextSources, finally: f.finally,"],
]);
edit('client/src/merge.js', [
  ["'versionEveryMin', 'contextSources'];", "'versionEveryMin', 'contextSources', 'finally'];"],
]);
