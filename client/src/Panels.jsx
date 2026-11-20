import React, { useEffect, useState } from 'react';
import { openCredentials } from './Credentials.jsx';
import { api, pendingSave } from './api.js';
import Chat from './Chat.jsx';
import Events from './Events.jsx';
import { ACCESS, accessOf } from './presets.js';
import { ExternalInvoke } from './Help.jsx';
import { TplField, IoSettings, DataTab, VerifySettings, RunStats } from './Data.jsx';
import ContextBox from './Context.jsx';
import StepInvoke from './StepInvoke.jsx';
import SkillPicker from './SkillPicker.jsx';
import ContextSources, { FsPicker } from './Sources.jsx';
import RequirementsEditor from './Requirements.jsx';
import ReviewPanel from './ReviewPanel.jsx';

const MODELS = [['', 'Por defecto'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMS = [
  ['', 'Por defecto (solo tools permitidas)'], ['plan', 'plan (solo planifica)'], ['acceptEdits', 'acceptEdits (edita archivos)'],
  ['auto', 'auto (clasificador decide)'], ['dontAsk', 'dontAsk'], ['bypassPermissions', 'bypassPermissions (⚠️ todo permitido)'],
];
const QUICK_TOOLS = ['Bash', 'Edit', 'Write', 'mcp__claude_ai_Atlassian_Rovo', 'mcp__claude_ai_Google_Drive', 'mcp__playwright'];

export const HOOKS_TEMPLATE = `// Hooks del step (JavaScript, se ejecutan en el servidor local).
// ctx: input, output, error, vars, step, flow
//   ctx.sh(cmd, {shell:'powershell'|'bash'|'cmd'}) -> {code, stdout, stderr}
//   ctx.ai(prompt, { tools, model }) -> texto   (Claude con tu suscripción + MCPs)
//   ctx.runStep(nombreOId, input) -> salida de otro step
//   ctx.upstream['Nombre step'] -> { output, json }   ctx.json = JSON de salida de este step
//   ctx.log(...), ctx.remember(texto), ctx.setVar(k, v)

async function onStart(ctx) {
  // return { skip: true }  para omitir el step
  // return { input: '...' } para transformar el input
}

async function onSuccess(ctx) {
  // return 'texto' para reemplazar la salida, o { output, json } para reemplazar texto y/o JSON
}

async function onFailure(ctx) {
  ctx.log('Falló:', ctx.error);
}
`;

const SNIPPETS = {
  'Comentar en Jira': `
  // Jira (MCP Atlassian Rovo de tu suscripción)
  await ctx.ai(\`Agrega un comentario en el issue \${ctx.vars.issue} con este resultado (resumido, en español):\\n\\n\${ctx.output}\`,
    { tools: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue mcp__claude_ai_Atlassian_Rovo__getAccessibleAtlassianResources' });`,
  'Página Confluence': `
  await ctx.ai(\`Crea una página en Confluence, espacio \${ctx.vars.space}, titulada "\${ctx.step.name} - \${new Date().toISOString().slice(0,10)}" con este contenido:\\n\\n\${ctx.output}\`,
    { tools: 'mcp__claude_ai_Atlassian_Rovo__createConfluencePage mcp__claude_ai_Atlassian_Rovo__getConfluenceSpaces mcp__claude_ai_Atlassian_Rovo__getAccessibleAtlassianResources' });`,
  'Bitbucket (git)': `
  // Bitbucket: vía git en el repo del flujo (cwd)
  const r = await ctx.sh('git status --short; git log -1 --oneline');
  ctx.log(r.stdout);`,
  'Comando shell': `
  const r = await ctx.sh('npm test --silent');
  if (r.code !== 0) throw new Error('Tests fallaron: ' + r.stderr.slice(0, 500));`,
  'Encadenar step': `
  const extra = await ctx.runStep('Nombre de otro step', ctx.output);
  return ctx.output + '\\n\\n' + extra;`,
};

export function Memory({ flowId, scope, items = [] }) {
  const [text, setText] = useState('');
  const add = async () => { if (!text.trim()) return; await api.post(`/api/flows/${flowId}/memory/${scope}`, { text }); setText(''); };
  return (
    <div className="memory pad">
      <p className="muted small">Hechos duraderos que el agente recibe como contexto. Se agregan solos (cuando el agente emite &lt;remember&gt;) o a mano.</p>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Nuevo hecho…" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add}>Agregar</button>
      </div>
      <ul className="mem-list">
        {[...items].reverse().map((m) => (
          <li key={m.id}>
            <span className={`chip src-${m.source}`}>{m.source}</span>
            <span className="grow">{m.text}</span>
            <span className="muted small">{new Date(m.at).toLocaleDateString()}</span>
            <button className="ghost small" onClick={() => api.del(`/api/flows/${flowId}/memory/${scope}/${m.id}`)}>✕</button>
          </li>
        ))}
        {!items.length && <li className="muted small">Vacía.</li>}
      </ul>
    </div>
  );
}

/** spec 11 ISO-3: the effective working folder and, without a custom one, the "own folder" choice. */
/** spec 11 ISO-6: a step that runs another flow (only the input crosses; its result is this step's output). */
function FlowStepEditor({ flow, step, onChange }) {
  const [flows, setFlows] = useState([]);
  const [target, setTarget] = useState(null);
  useEffect(() => { api.get('/api/flows').then((l) => setFlows(l.filter((x) => x.id !== flow.id))).catch(() => {}); }, [flow.id]);
  useEffect(() => { if (step.flowRef) api.get(`/api/flows/${step.flowRef}`).then(setTarget).catch(() => setTarget(null)); else setTarget(null); }, [step.flowRef]);
  return (
    <div className="ctx-block" data-testid="flow-step">
      <div className="ctx-title">🔀 Invoca otro flujo</div>
      <p className="muted small">Solo pasa el input: el otro flujo corre con sus variables, su memoria y su carpeta. Su resultado es la salida de este step. Llamadas circulares o de más de 5 niveles fallan.</p>
      <Field label="Flujo">
        <select data-testid="flow-step-ref" value={step.flowRef || ''} onChange={(e) => onChange({ flowRef: e.target.value, flowStep: '' })}>
          <option value="">— elegir —</option>
          {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {step.flowRef && !target && <div className="warn-text small">Ese flujo ya no existe: elige otro.</div>}
      </Field>
      {target && (
        <Field label="Step" hint="vacío = el flujo entero">
          <div className="row">
            <select data-testid="flow-step-step" value={step.flowStep || ''} onChange={(e) => onChange({ flowStep: e.target.value })}>
              <option value="">— el flujo entero —</option>
              {target.steps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {step.flowStep && <div className="seg small"><button className={step.flowScope !== 'from' ? 'active' : ''} onClick={() => onChange({ flowScope: 'only' })}>solo ese</button><button className={step.flowScope === 'from' ? 'active' : ''} onClick={() => onChange({ flowScope: 'from' })}>ese y los que siguen</button></div>}
          </div>
        </Field>
      )}
      <Field label="Input que le pasa" hint="vacío = la salida de los steps anteriores (o el input del flujo). Admite {{input}}, {{vars.x}}, {{steps.X.output}}">
        <TplField flow={flow} step={step} rows={3} value={step.flowInput || ''} onChange={(v) => onChange({ flowInput: v })} placeholder="{{steps.Preparar.output}}" />
      </Field>
      <label className="toggle small"><input type="checkbox" data-testid="flow-step-wait" checked={step.waitResult !== false} onChange={(e) => onChange({ waitResult: e.target.checked })} /> Esperar su resultado <span className="muted">(si no, lo lanza y sigue: la salida es el id de esa ejecución; detener este flujo no lo detiene)</span></label>
      {target && <div className="small"><a href={`/?flow=${target.id}`}>Abrir «{target.name}» →</a></div>}
    </div>
  );
}

/** spec 11 ISO-9: which flows this one calls and which call it. */
function FlowCalls({ flow }) {
  const [c, setC] = useState(null);
  useEffect(() => { api.get(`/api/flows/${flow.id}/calls`).then(setC).catch(() => setC(null)); }, [flow.id, flow.rev]);
  if (!c || (!c.calls.length && !c.calledBy.length)) return null;
  const link = (x) => (x.flowId ? <a href={`/?flow=${x.flowId}`}>{x.name || x.flowId}</a> : <span className="warn-text">{x.name || '(sin elegir)'}</span>);
  return (
    <div className="ctx-block" data-testid="flow-calls">
      <div className="ctx-title">🔀 Llamadas entre flujos</div>
      {c.calls.length > 0 && <div className="small">Invoca: {c.calls.map((x, i) => <span key={i}>{i ? ' · ' : ''}{link(x)} <span className="muted">(desde «{x.stepName}»{x.via === 'hook' ? ', hook' : ''})</span>{x.broken ? <span className="warn-text"> ⚠ no existe</span> : null}</span>)}</div>}
      {c.calledBy.length > 0 && <div className="small">La invocan: {c.calledBy.map((x, i) => <span key={i}>{i ? ' · ' : ''}{link(x)} <span className="muted">(«{x.stepName}»)</span></span>)}</div>}
    </div>
  );
}

function WorkspaceInfo({ flow, onChange }) {
  const [ws, setWs] = useState(null);
  useEffect(() => { api.get(`/api/flows/${flow.id}/workspace`).then(setWs).catch(() => setWs(null)); }, [flow.id, flow.cwd, flow.workspace]);
  if (!ws) return null;
  const writes = flow.steps.some((s) => s.kind === 'command' || /(^|\s)(Edit|Write|Bash)/.test(s.allowedTools || '') || s.permissionMode === 'acceptEdits');
  return (
    <div className="small" data-testid="flow-workspace">
      <div className="muted">Trabaja en: <code>{ws.path}</code>{ws.mode === 'own' ? ' (carpeta propia del flujo)' : ws.mode === 'home' ? ' (tu carpeta de usuario)' : ''}</div>
      {!flow.cwd && (
        <label className="toggle"><input type="checkbox" data-testid="flow-own-folder" checked={ws.mode === 'own'} onChange={(e) => onChange({ workspace: e.target.checked ? 'own' : 'home' })} /> Usar una carpeta propia para este flujo (recomendado)
          <span className="muted"> — las sesiones de Claude y lo que escriban los comandos no se mezclan con otros flujos ni con tu carpeta de usuario. Cambiarla empieza conversaciones nuevas.</span></label>
      )}
      {!flow.cwd && ws.mode === 'home' && writes && <div className="warn-text">⚠ Los steps que editan o ejecutan comandos trabajarán en tu carpeta de usuario.</div>}
      <div className="muted">Las herramientas de archivos de Claude las limitan los permisos de cada step, no esta carpeta.</div>
    </div>
  );
}

function Field({ label, hint, children, div }) {
  const Tag = div ? 'div' : 'label';
  return <Tag className="field"><span className="field-label">{label}{hint && <span className="hint"> — {hint}</span>}</span>{children}</Tag>;
}

export function StepPanel({ flow, step, catalog, live, watch = {}, running, tab, setTab, onChange, onDelete, onRun, onProbe, onOpenStep, onDuplicate, onSaveLib }) {
  const [runInput, setRunInput] = useState('');
  const [runEvents, setRunEvents] = useState(null);
  const set = (k) => (e) => onChange({ [k]: e.target.value });

  useEffect(() => {
    setRunEvents(null);
    if (tab === 'activity' && !live?.events?.length && step.lastRun?.runId) {
      api.get(`/api/flows/${flow.id}/runs/${step.lastRun.runId}`).then((r) => setRunEvents(r?.steps?.[step.id]?.events || [])).catch(() => {});
    }
  }, [tab, step.id, step.lastRun?.runId]);

  const tools = new Set(String(step.allowedTools || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || []);
  const toggleTool = (t) => { tools.has(t) ? tools.delete(t) : tools.add(t); onChange({ allowedTools: [...tools].join(' ') }); };
  const status = live?.status || step.lastRun?.status;

  return (
    <div className="panel">
      <div className="panel-head">
        <input className="title-input" value={step.name} onChange={set('name')} />
        <button className="ghost small" onClick={onDuplicate} title="Crea una copia de esta caja con la misma configuración">Duplicar</button>
        <button className="ghost small" onClick={onSaveLib} title="Guárdala en “Mis steps” para insertarla en cualquier flujo">📚 Guardar</button>
        <button className="ghost danger small" onClick={() => confirm(`¿Eliminar "${step.name}"?`) && onDelete()}>Eliminar</button>
      </div>
      <div className="tabs">
        {[['config', 'Config'], ['chat', 'Chat'], ['activity', `Actividad${status === 'running' ? ' ●' : ''}`], ['data', `Datos${step.pinned ? ' 📌' : ''}`], ['memory', `Memoria (${step.memory?.length || 0})`], ['hooks', 'Hooks'], ['invoke', '🔌 Invocar']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {(tab === 'config' || tab === 'chat') && <ContextBox flow={flow} step={step} target={tab === 'chat' ? 'chat' : 'run'} />}

      {tab === 'config' && (
        <div className="panel-body pad">
          <Field label="Tipo">
            <div className="seg">
              {[['role', '🎭 Rol'], ['agent', '🤖 Agente'], ['skill', '🧩 Skill'], ['command', '⌨️ Comando'], ['flow', '🔀 Flujo']].map(([k, l]) => (
                <button key={k} className={step.kind === k ? 'active' : ''} onClick={() => onChange({ kind: k })}>{l}</button>
              ))}
            </div>
          </Field>
          {step.kind !== 'command' && step.kind !== 'flow' && (
            <label className="toggle" data-testid="coordinator-toggle" title="El coordinador atiende el chat general: responde, consulta al step que corresponda o propone ejecutar. Hay uno por flujo.">
              <input type="checkbox" checked={!!step.coordinator} onChange={(e) => onChange({ coordinator: e.target.checked || undefined })} /> 🧭 Coordinador del flujo <span className="muted small">(atiende el chat general y decide qué step responde{flow.steps.some((x) => x.coordinator && x.id !== step.id) ? `; hoy lo es «${flow.steps.find((x) => x.coordinator && x.id !== step.id).name}» y dejará de serlo` : ''})</span>
            </label>
          )}
          <ForEachBox flow={flow} step={step} onChange={onChange} />
          <WatchBox flow={flow} step={step} watch={watch} onChange={onChange} />
          <OutputsBox step={step} onChange={onChange} />
          <div className="ctx-block" data-testid="step-context">
            <div className="ctx-title">📎 Contexto{(step.contextSources || []).length ? ` (${step.contextSources.length})` : ''}</div>
            {step.kind === 'command'
              ? <p className="muted small">Los comandos no usan fuentes de consulta (léelas en el propio comando con su ruta).</p>
              : <ContextSources flow={flow} value={step.contextSources} onChange={(v) => onChange({ contextSources: v })} inherited={(flow.contextSources || []).filter((x) => !x.disabled).length} />}
          </div>
          <Field label="Break" hint="pausa la ejecución aquí para validar (solo ejecuciones desde la app, o externas con breakpoints:true)">
            <select value={step.breakpoint || ''} onChange={(e) => onChange({ breakpoint: e.target.value })}>
              <option value="">Sin break</option>
              <option value="after">⏸ Después: revisar su salida antes de seguir</option>
              <option value="before">⏸ Antes: revisar lo que va a recibir</option>
              <option value="both">⏸ Antes y después</option>
            </select>
          </Field>
          {step.kind === 'agent' && (
            <Field label="Agente" hint="de ~/.claude/agents, plugins o el proyecto">
              <select value={step.agentRef} onChange={set('agentRef')}>
                <option value="">— elegir —</option>
                {catalog.agents.map((a) => <option key={a.path} value={a.name}>{a.name} · {a.source}</option>)}
              </select>
              <div className="muted small">{catalog.agents.find((a) => a.name === step.agentRef)?.description}</div>
            </Field>
          )}
          {step.kind === 'skill' && (
            <Field div label="Skill" hint="de este flujo, tus skills, claude.ai o plugins; ＋ Agregar trae una desde URL, carpeta o zip">
              <SkillPicker flow={flow} catalog={catalog} value={step.skillRef} onChange={(v) => onChange({ skillRef: v })} />
            </Field>
          )}
          {step.kind === 'flow' && <FlowStepEditor flow={flow} step={step} onChange={onChange} />}
          {step.kind === 'flow' ? null : step.kind === 'command' ? (
            <>
              <Field div label="Comando" hint="stdin = salida de los steps anteriores ($env:STEP_UPSTREAM, JSON en $env:STEP_UPSTREAM_JSON); input del flujo en $env:FLOW_INPUT">
                <TplField flow={flow} step={step} command className="mono" rows={4} value={step.command} onChange={(v) => onChange({ command: v })} placeholder="npx playwright test --grep @sanity" />
              </Field>
              <div className="muted small">Tokens: usa <code>{'{{cred.nombre.token}}'}</code> (y <code>.url</code>, <code>.user</code>) en vez de leer un .env; nunca quedan escritos en el comando ni en la salida. <a onClick={() => openCredentials()}>🔑 Credenciales</a></div>
              <Field label="Shell">
                <select value={step.shell} onChange={set('shell')}><option value="powershell">PowerShell</option><option value="bash">bash</option><option value="cmd">cmd</option></select>
              </Field>
              <IoSettings step={step} onChange={onChange} />
              <VerifySettings step={step} onChange={onChange} />
            </>
          ) : (
            <>
              <Field div label="¿Qué hace?" hint="lo que debe producir en cada ejecución; con { } insertas datos de otros steps, variables o el input">
                <TplField flow={flow} step={step} rows={4} value={step.task} onChange={(v) => onChange({ task: v })} placeholder="Ej: Lee el ticket {{vars.issue}} y lista criterios de aceptación y riesgos." />
              </Field>
              <Field label="¿Cómo trabaja?" hint={step.kind === 'role' ? 'quién es: rol, criterio, tono' : 'opcional: instrucciones extra para la skill/agente'}>
                <textarea rows={3} value={step.role} onChange={set('role')} placeholder="Ej: Eres un QA lead senior, directo, que prioriza por riesgo." />
              </Field>
              <Field label="Acceso" hint="qué puede tocar este step">
                <select value={accessOf(step)?.id || 'custom'} onChange={(e) => { const a = ACCESS.find((x) => x.id === e.target.value); if (a) onChange({ allowedTools: a.tools, permissionMode: a.perm }); }}>
                  {ACCESS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  {!accessOf(step) && <option value="custom">Personalizado (ver Avanzado)</option>}
                </select>
                <div className="muted small">{accessOf(step)?.desc || `Tools: ${step.allowedTools || '(ninguna)'}${step.permissionMode ? ` · modo ${step.permissionMode}` : ''}`}</div>
              </Field>
              <IoSettings step={step} onChange={onChange} />
              <VerifySettings step={step} onChange={onChange} />
              <details className="advanced">
                <summary>Avanzado: notas fijas, modelo, permisos y tools exactas</summary>
              <Field div label="Notas fijas en el prompt" hint="texto corto que SÍ va siempre en el prompt (p. ej. proyecto Jira, convenciones). Para documentos, carpetas, páginas, Jira o Confluence usa 📎 Contexto arriba">
                <TplField flow={flow} step={step} rows={3} value={step.context} onChange={(v) => onChange({ context: v })} />
              </Field>
              <div className="grid3">
                <Field label="Modelo"><select value={step.model} onChange={set('model')}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
                <Field label="Effort"><select value={step.effort} onChange={set('effort')}>{EFFORTS.map((v) => <option key={v} value={v}>{v || 'Por defecto'}</option>)}</select></Field>
                <Field label="Permisos"><select value={step.permissionMode} onChange={set('permissionMode')}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              </div>
              <Field label="Tools permitidas" hint="separadas por espacio; un prefijo mcp__servidor habilita todo ese MCP">
                <input className="mono" list="tool-list" value={step.allowedTools} onChange={set('allowedTools')} />
                <datalist id="tool-list">{catalog.tools.map((t) => <option key={t} value={t} />)}</datalist>
                <div className="chips">
                  {QUICK_TOOLS.map((t) => <button key={t} className={`chip btn ${tools.has(t) ? 'on' : ''}`} onClick={() => toggleTool(t)}>{t}</button>)}
                  <button className="chip btn" onClick={onProbe} title="Lee tools y MCPs de tu Claude Code sin gastar una llamada al modelo">↻ detectar tools/MCPs</button>
                </div>
                {catalog.mcpServers?.length > 0 && (
                  <div className="small muted">MCP: {catalog.mcpServers.map((m) => <span key={m.name} className={`chip ${m.status === 'connected' ? 'ok' : 'warn'}`}>{m.name}</span>)}</div>
                )}
              </Field>
              </details>
            </>
          )}
          <div className="run-box">
            <textarea rows={2} value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="Input para ejecutar solo este step (opcional)" />
            <button className="primary" onClick={() => { onRun(runInput); setTab('activity'); }} disabled={status === 'running' || status === 'queued' || status === 'paused'}>▶ Ejecutar step</button>
          </div>
          {step.lastRun?.output && (
            <details className="last-out"><summary>Última salida ({step.lastRun.status})</summary><pre>{step.lastRun.output}</pre></details>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <Chat flowId={flow.id} chatKey={step.id} step={step} vars={flow.vars} onOpenStep={onOpenStep}
          runId={live?.status === 'paused' ? live.runId : undefined}
          locked={running && live?.status !== 'paused' ? 'El flujo se está ejecutando y sigue su proceso: puedes conversar con este step cuando esté detenido o en un break.' : ''}
          placeholder={`Conversa con "${step.name}" (habla con su rol, agente o skill): pregúntale, pídele que evalúe algo o que mejore su tarea, su contexto, su skill o su agente. Discutan lo que haga falta: cada cambio llega como propuesta y solo se aplica cuando pulsas Aplicar.`} />
      )}

      {tab === 'activity' && (
        <div className="panel-body pad">
          {status !== 'running' && step.lastRun && <RunStats rs={step.lastRun} />}
          {live?.events?.length ? <Events events={live.events} running={live.status === 'running'} /> : runEvents ? <Events events={runEvents} /> : <div className="muted small">Ejecuta el step o el flujo para ver su proceso interno.</div>}
          {step.lastRun?.output && status !== 'running' && <details className="last-out" open><summary>Salida</summary><pre>{step.lastRun.output}</pre></details>}
          {step.lastRun?.error && status !== 'running' && <div className="error-bar">{step.lastRun.error}</div>}
        </div>
      )}

      {tab === 'data' && <DataTab flow={flow} step={step} live={live} />}
      {tab === 'invoke' && <StepInvoke flow={flow} step={step} />}

      {tab === 'memory' && <Memory flowId={flow.id} scope={step.id} items={step.memory} />}

      {tab === 'hooks' && (
        <div className="panel-body pad">
          <p className="muted small">Triggers por código: <code>onStart</code>, <code>onSuccess</code>, <code>onFailure</code>. Insertá un snippet dentro de la función que corresponda.</p>
          <div className="chips">
            {!step.hooks?.trim() && <button className="chip btn on" onClick={() => onChange({ hooks: HOOKS_TEMPLATE })}>Usar plantilla</button>}
            {Object.entries(SNIPPETS).map(([k, v]) => <button key={k} className="chip btn" onClick={() => onChange({ hooks: insertIntoSuccess(step.hooks || HOOKS_TEMPLATE, v) })}>+ {k}</button>)}
          </div>
          <textarea className="mono code" rows={24} spellCheck={false} value={step.hooks} onChange={set('hooks')} placeholder={HOOKS_TEMPLATE}
            onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const s = t.selectionStart; onChange({ hooks: t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd) }); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; }); } }} />
        </div>
      )}
    </div>
  );
}

function insertIntoSuccess(code, snippet) {
  const i = code.indexOf('async function onSuccess(ctx) {');
  if (i < 0) return code + `\nasync function onSuccess(ctx) {${snippet}\n}\n`;
  const at = i + 'async function onSuccess(ctx) {'.length;
  return code.slice(0, at) + snippet + code.slice(at);
}

export function FlowPanel({ flow, running, focusRun, tab, setTab, onChange, onOpenStep, onReset }) {
  const [varsText, setVarsText] = useState(JSON.stringify(flow.vars || {}, null, 2));
  const [varsErr, setVarsErr] = useState('');
  const [runs, setRuns] = useState([]);
  const [runDetail, setRunDetail] = useState(null);
  const [cwdPicker, setCwdPicker] = useState(false);
  const [varsFocus, setVarsFocus] = useState(false);
  // Follow server-side changes (e.g. a hook's ctx.setVar) unless the user is editing the JSON or it holds an invalid draft.
  useEffect(() => { if (!varsFocus && !varsErr) setVarsText(JSON.stringify(flow.vars || {}, null, 2)); }, [flow.id, JSON.stringify(flow.vars || {})]);
  useEffect(() => { if (tab === 'runs') api.get(`/api/flows/${flow.id}/runs`).then(setRuns); }, [tab, flow.id]);
  // "Ver ejecución" from 🔔 (spec 27): open that run's detail
  useEffect(() => { if (focusRun?.runId) api.get(`/api/flows/${flow.id}/runs/${focusRun.runId}`).then(setRunDetail).catch(() => {}); }, [focusRun?.n]);
  const set = (k) => (e) => onChange({ [k]: e.target.value });

  return (
    <div className="panel">
      <div className="panel-head"><b>{flow.name}</b><span className="muted small">{flow.steps.length} steps</span></div>
      <div className="tabs">
        {[['chat', 'Chat general'], ['settings', 'Flujo'], ['review', '🩺 Revisión'], ['memory', `Memoria (${flow.memory?.length || 0})`], ['runs', 'Ejecuciones'], ['versions', 'Versiones'], ['external', 'Invocar']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)} data-testid={`flow-tab-${k}`}>{l}</button>
        ))}
      </div>
      {tab === 'chat' && (
        <Chat flowId={flow.id} chatKey="_global" flow={flow} vars={flow.vars} onOpenStep={onOpenStep}
          locked={running ? 'El flujo se está ejecutando y sigue su proceso. El chat vuelve cuando termine; los steps en break se conversan desde su ventana de revisión.' : ''}
          placeholder="Habla en lenguaje natural. Un enrutador (Haiku) decide qué step, agente, skill o rol responde —o si conviene ejecutar algo, que te propone para que confirmes— y verás por qué. La respuesta queda también en el chat de ese step." />
      )}
      {tab === 'settings' && (
        <div className="panel-body pad">
          <Field label="Nombre"><input value={flow.name} onChange={set('name')} /></Field>
          <Field label="Descripción"><textarea rows={2} value={flow.description} onChange={set('description')} /></Field>
          <div className="ctx-block" data-testid="flow-requirements">
            <div className="ctx-title">✅ Requisitos para usar este flujo{(flow.requirements || []).length ? ` (${flow.requirements.length})` : ''} <span className="muted small">— lo que debe tener instalado quien lo ejecute</span></div>
            <RequirementsEditor flow={flow} onChange={(v) => onChange({ requirements: v })} />
          </div>
          <div className="ctx-block" data-testid="flow-context">
            <div className="ctx-title">📎 Contexto del flujo{(flow.contextSources || []).length ? ` (${flow.contextSources.length})` : ''} <span className="muted small">— lo pueden consultar todos los steps</span></div>
            <ContextSources flow={flow} scope="flow" value={flow.contextSources} onChange={(v) => onChange({ contextSources: v })} />
          </div>
          <FlowCalls flow={flow} />
          <Field label="Directorio de trabajo" hint="dónde trabajan Claude y los comandos (repo, proyecto). Vacío = la carpeta propia del flujo. Si no existe, la ejecución no arranca">
            <div className="row">
              <input className="mono" style={{ flex: 1 }} value={flow.cwd || ''} onChange={set('cwd')} placeholder="C:\Users\...\mi-repo" />
              <button className="small" onClick={() => setCwdPicker(true)}>Explorar…</button>
            </div>
            <WorkspaceInfo flow={flow} onChange={onChange} />
            {cwdPicker && <FsPicker flow={flow} want="folder" start={flow.cwd} onClose={() => setCwdPicker(false)} onPick={(p) => { onChange({ cwd: p }); setCwdPicker(false); }} />}
          </Field>
          <div className="ctx-block" data-testid="flow-finally">
            <div className="ctx-title">🧹 Al terminar (siempre) <span className="muted small">— opcional</span></div>
            <p className="muted small">Un comando que corre al final de cada ejecución completa, salga bien, mal, se cancele o se agote el tiempo (y también si el servidor se reinició a mitad). Útil para limpiar contenedores, datos de prueba o archivos temporales, o para avisar. Recibe <code>$env:AFS_RUN_ID</code>, <code>$env:AFS_RUN_STATUS</code> (success, error, stopped, timeout, interrupted), <code>$env:AFS_RUN_STEPS_JSON</code> y admite <code>{'{{vars.x}}'}</code>, <code>{'{{run.id}}'}</code>, <code>{'{{steps.X.json.y}}'}</code>.</p>
            <textarea className="mono" rows={3} value={flow.finally?.command || ''} onChange={(e) => onChange({ finally: { shell: 'powershell', timeoutSec: 300, ...(flow.finally || {}), command: e.target.value } })} placeholder={'docker compose -p afs-$env:AFS_RUN_ID down -v --remove-orphans'} />
            <div className="row">
              <select value={flow.finally?.shell || 'powershell'} onChange={(e) => onChange({ finally: { timeoutSec: 300, ...(flow.finally || {}), shell: e.target.value } })}><option value="powershell">PowerShell</option><option value="bash">bash</option><option value="cmd">cmd</option></select>
              <label className="small">máx. <input type="number" min={5} max={3600} style={{ width: 80 }} value={flow.finally?.timeoutSec || 300} onChange={(e) => onChange({ finally: { shell: 'powershell', ...(flow.finally || {}), timeoutSec: Number(e.target.value) || 300 } })} /> s</label>
            </div>
          </div>
          <Field label="Variables (JSON)" hint="{{vars.x}} en tareas/comandos, ctx.vars en hooks">
            <textarea className="mono" rows={5} value={varsText} onFocus={() => setVarsFocus(true)} onBlur={() => setVarsFocus(false)} onChange={(e) => { setVarsText(e.target.value); try { onChange({ vars: JSON.parse(e.target.value || '{}') }); setVarsErr(''); } catch (er) { setVarsErr(er.message); } }} />
            {varsErr && <div className="warn-text small">{varsErr}</div>}
          </Field>
          <Field label="Programación">
            <div className="row">
              <label className="toggle"><input type="checkbox" checked={!!flow.schedule?.enabled} onChange={(e) => onChange({ schedule: { ...flow.schedule, enabled: e.target.checked } })} /> cada</label>
              <input type="number" min={1} style={{ width: 80 }} value={flow.schedule?.everyMinutes ?? 60} onChange={(e) => onChange({ schedule: { ...flow.schedule, everyMinutes: Number(e.target.value) } })} /> min
            </div>
            <input value={flow.schedule?.input || ''} onChange={(e) => onChange({ schedule: { ...flow.schedule, input: e.target.value } })} placeholder="Input para ejecuciones programadas" />
          </Field>
          <Field label="🔔 Revisar novedades" hint="comprueba las fuentes que vigilan los steps y aplica lo que cada una tenga configurado al cambiar (mínimo 5 min)">
            <div className="row">
              <label className="toggle"><input type="checkbox" data-testid="watch-polling" checked={!!flow.watchPolling?.enabled} onChange={(e) => onChange({ watchPolling: { everyMinutes: 30, ...flow.watchPolling, enabled: e.target.checked } })} /> cada</label>
              <input type="number" min={5} style={{ width: 80 }} value={flow.watchPolling?.everyMinutes ?? 30} onChange={(e) => onChange({ watchPolling: { ...flow.watchPolling, everyMinutes: Number(e.target.value) } })} /> min
            </div>
            {flow.watchPolling?.enabled && !flow.steps.some((x) => x.watches?.length) && <div className="muted small">Ningún step vigila fuentes todavía (step › Configuración › 🔔 Novedades).</div>}
          </Field>
          <Field label="Tiempo máximo de una ejecución (s)" hint="al agotarse se detiene; los steps pendientes quedan omitidos. Por llamada externa: deadlineSec">
            <input type="number" min={10} max={14400} style={{ width: 120 }} value={flow.runTimeoutSec ?? 3600} onChange={(e) => onChange({ runTimeoutSec: Number(e.target.value) || 3600 })} />
          </Field>
          <p className="muted small">Para dispararlo desde Claude Code, terminal, API, Jenkins o webhooks: pestaña <a onClick={() => setTab('external')}>Invocar</a>.</p>
          <details className="advanced danger-zone">
            <summary>Zona de limpieza</summary>
            <p className="muted small">Borrar steps no borra lo que el flujo acumuló. Desde acá lo limpias por partes o todo junto (conserva nombre, directorio y la forma de invocarlo).</p>
            <div className="chips">
              <button className="chip btn" onClick={() => onReset(['description', 'vars'])}>Descripción y variables</button>
              <button className="chip btn" onClick={() => onReset(['memory'])}>Memoria</button>
              <button className="chip btn" onClick={() => onReset(['chats'])}>Chats</button>
              <button className="chip btn" onClick={() => onReset(['runs'])}>Ejecuciones</button>
            </div>
            <button className="danger" onClick={() => onReset(['steps', 'description', 'vars', 'memory', 'chats', 'runs', 'schedule'])}>Vaciar flujo (empezar de cero)</button>
          </details>
        </div>
      )}
      {tab === 'review' && <ReviewPanel flow={flow} running={running} onChange={onChange} />}
      {tab === 'external' && <div className="panel-body pad"><ExternalInvoke flow={flow} /></div>}
      {tab === 'versions' && <div className="panel-body pad"><Versions flow={flow} onChange={onChange} /></div>}
      {tab === 'memory' && <Memory flowId={flow.id} scope="_flow" items={flow.memory} />}
      {tab === 'runs' && (
        <div className="panel-body pad">
          {runDetail ? (
            <div>
              <button className="ghost small" onClick={() => setRunDetail(null)}>← volver</button>
              <h4>{runDetail.id} · <span className={`status s-${runDetail.status}`}>{runDetail.status}</span> {runDetail.status === 'running' && <button className="danger small" onClick={() => api.post(`/api/flows/${flow.id}/runs/${runDetail.id}/cancel`).then(() => api.get(`/api/flows/${flow.id}/runs/${runDetail.id}`).then(setRunDetail)).catch(() => {})}>■ Cancelar</button>}</h4>
              <div className="muted small">
                {runDetail.trigger}{runDetail.usePins === false ? ' · ignoró salidas fijadas' : ''}{runDetail.usedPins?.length ? ` · usó fijadas: ${runDetail.usedPins.join(', ')}` : ''}
                {runDetail.totals ? ` · ${Math.round((runDetail.totals.durationMs || 0) / 1000)} s · tokens ${runDetail.totals.inputTokens}/${runDetail.totals.outputTokens}${runDetail.totals.costUsd ? ` · ≈ US$${runDetail.totals.costUsd.toFixed(4)} equiv. API` : ''}` : ''}
                {runDetail.error ? ` · ${runDetail.error}` : ''}
              </div>
              {runDetail.finally && <div className={`small ${runDetail.finally.status === 'success' ? 'ok-text' : 'warn-text'}`}>🧹 Al terminar: {runDetail.finally.status}{runDetail.finally.exitCode != null ? ` (exit ${runDetail.finally.exitCode})` : ''}{runDetail.finally.error ? ` — ${runDetail.finally.error}` : ''}</div>}
              {runDetail.input && <details><summary>Input</summary><pre>{runDetail.input}</pre></details>}
              {runDetail.vars && Object.keys(runDetail.vars).length > 0 && <details><summary>Variables de esta ejecución</summary><pre className="mono small">{JSON.stringify(runDetail.vars, null, 2)}</pre></details>}
              {Object.entries(runDetail.steps).map(([sid, s]) => (
                <details key={sid} className="run-step">
                  <summary><span className={`status s-${s.status}`}>{s.status}</span> {flow.steps.find((x) => x.id === sid)?.name || sid}{s.code ? <span className="chip warn">{s.code}</span> : null}</summary>
                  <RunStats rs={s} />
                  {s.error && <div className="error-bar">{s.error}</div>}
                  <Events events={s.events} />
                  {s.output && <pre className="last-out">{s.output}</pre>}
                </details>
              ))}
            </div>
          ) : (
            <ul className="runs">
              {runs.map((r) => (
                <li key={r.id} onClick={() => api.get(`/api/flows/${flow.id}/runs/${r.id}`).then(setRunDetail)}>
                  <span className={`status s-${r.status}`}>{r.status}</span>
                  <span>{new Date(r.startedAt).toLocaleString()}</span>
                  <span className="chip">{r.rehearsal || r.trigger === 'rehearsal' ? `🧪 ensayo${r.trigger?.startsWith('flow:') ? ' (llamado por otro flujo)' : ''}` : r.trigger}{r.only ? ' · 1 step' : r.from ? ` · desde ${flow.steps.find((s) => s.id === r.from)?.name || r.from}` : ''}</span>
                  <span className="muted small grow">{r.input}</span>
                  {r.totals && <span className="muted small">{Math.round((r.totals.durationMs || 0) / 1000)} s{r.totals.costUsd ? ` · ≈US$${r.totals.costUsd.toFixed(3)}` : ''}</span>}
                  {r.status === 'running' && <button className="danger small" onClick={(e) => { e.stopPropagation(); api.post(`/api/flows/${flow.id}/runs/${r.id}/cancel`).then(() => api.get(`/api/flows/${flow.id}/runs`).then(setRuns)).catch(() => {}); }}>■ Cancelar</button>}
                </li>
              ))}
              {!runs.length && <li className="muted small">Sin ejecuciones.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- arrow (edge) settings: spec 18 ----------------
/** Steps that always run before `id` (its ancestors): a condition can look at one of their decisions. */
// Spec 14: ⚡ declared actions and 📄 deliverables of a step (what it CHANGES and what it PRODUCES)
const ACTION_DEFS = {
  'jira.comment': { label: '💬 Comentar en Jira', fields: [['issue', 'Issue', 'SBK-123 o {{vars.issue}}'], ['body', 'Comentario', '{{output}}', true]] },
  'jira.createSubtask': { label: '🧩 Crear sub-task', fields: [['parent', 'Issue padre', '{{vars.issue}}'], ['summary', 'Resumen', 'QA: {{vars.issue}}'], ['description', 'Descripción', '{{output}}', true]] },
  'jira.createIssue': { label: '🐞 Crear issue / bug', fields: [['project', 'Proyecto', 'SBK'], ['issueType', 'Tipo', 'Bug'], ['summary', 'Resumen', '{{output.json.defects.0.title}}'], ['description', 'Descripción', '{{output}}', true], ['fields', 'Campos extra (JSON)', '{"environment":"QA, PPD"}', true]] },
  'jira.transition': { label: '➡ Transicionar issue', fields: [['issue', 'Issue', '{{vars.issue}}'], ['to', 'A estado', 'Ready For Testing']] },
  'jira.link': { label: '🔗 Vincular issues', fields: [['from', 'Desde (inward: la que bloquea / duplica / clona)', '{{vars.issue}}'], ['to', 'Hacia (outward: la bloqueada / duplicada)', 'SBK-456'], ['type', 'Tipo de vínculo (Blocks, Relates, Duplicate…)', 'Relates']] },
  'confluence.createPage': { label: '📘 Crear página Confluence', fields: [['space', 'Espacio', 'QA'], ['parent', 'Página padre (id)', '123456'], ['title', 'Título', 'Análisis {{vars.issue}}'], ['body', 'Contenido', '{{output}}', true]] },
  'confluence.updatePage': { label: '📘 Actualizar página Confluence', fields: [['page', 'Página (id)', '123456'], ['title', 'Título (opcional)', ''], ['body', 'Contenido', '{{output}}', true]] },
  'http.post': { label: '🌐 HTTP POST (webhook)', fields: [['url', 'URL (fija o {{vars.x}}; nunca de la salida)', 'https://hooks.slack.com/…'], ['body', 'Cuerpo (si es JSON, los valores se escapan solos)', '{"text":"{{output}}"}', true], ['credential', 'Credencial (opcional)', '']] },
};
const DEFAULT_APPROVAL = (t) => (t === 'jira.comment' ? 'auto' : 'confirm');
const FORMATS = [['md', 'Markdown'], ['txt', 'Texto'], ['json', 'JSON'], ['csv', 'CSV'], ['html', 'HTML'], ['feature', 'Gherkin (.feature)'], ['yaml', 'YAML'], ['junit-xml', 'JUnit XML']];
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

function OutputsBox({ step, onChange }) {
  const actions = step.actions || []; const dels = step.deliverables || [];
  const setA = (i, patch) => onChange({ actions: actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const setD = (i, patch) => onChange({ deliverables: dels.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  return (
    <div className="ctx-block" data-testid="outputs-box">
      <div className="ctx-title">⚡ Acciones y 📄 entregables{actions.length + dels.length ? ` (${actions.length + dels.length})` : ''}</div>
      <p className="muted small">Lo que el step <b>cambia</b> afuera (Jira, Confluence, un webhook) y los <b>archivos</b> que deja. Las acciones las ejecuta la app con solo la herramienta de esa acción; «confirmar» espera a que alguien la apruebe en Datos, sin frenar la ejecución. Re-ejecutar con la misma entrada no duplica.</p>
      {actions.map((a, i) => {
        const def = ACTION_DEFS[a.type];
        return (
          <div key={a.id} className="src-item out-item" data-testid="action-item" data-type={a.type}>
            <div className="row">
              <b>{def?.label || a.type}</b><div className="grow" />
              <select value={a.approval || DEFAULT_APPROVAL(a.type)} onChange={(e) => setA(i, { approval: e.target.value })} title="Aprobación" data-testid="action-approval">
                <option value="confirm">Confirmar antes</option><option value="auto">Automática</option><option value="dryRun">Solo mostrar (no envía)</option>
              </select>
              <select value={a.when || 'success'} onChange={(e) => setA(i, { when: e.target.value })} title="Cuándo">
                <option value="success">si sale bien</option><option value="failure">si falla</option><option value="always">siempre</option>
              </select>
              <button className="ghost small" onClick={() => onChange({ actions: actions.filter((_, j) => j !== i) })} title="Quitar">✕</button>
            </div>
            {def?.fields.map(([k, label, ph, multi]) => (
              <label key={k} className="out-field"><span className="small muted">{label}</span>
                {multi ? <textarea rows={2} className="mono" value={typeof a.params?.[k] === 'object' ? JSON.stringify(a.params[k]) : a.params?.[k] || ''} placeholder={ph} onChange={(e) => setA(i, { params: { ...a.params, [k]: e.target.value } })} />
                  : <input data-testid={`action-${k}`} value={a.params?.[k] || ''} placeholder={ph} onChange={(e) => setA(i, { params: { ...a.params, [k]: e.target.value } })} />}
              </label>
            ))}
            <label className="out-field"><span className="small muted">Clave para no repetirla (opcional; por defecto, el destino: issue padre + resumen, issue + estado…)</span><input value={a.idempotencyKey || ''} placeholder="{{vars.issue}}-qa" onChange={(e) => setA(i, { idempotencyKey: e.target.value || undefined })} /></label>
            <label className="toggle small"><input type="checkbox" checked={!!a.optional} onChange={(e) => setA(i, { optional: e.target.checked || undefined })} /> si falla, el step igual sale bien</label>
          </div>
        );
      })}
      {dels.map((d, i) => (
        <div key={d.id} className="src-item out-item" data-testid="deliverable-item">
          <div className="row">
            <b>📄</b>
            <select value={d.format} onChange={(e) => setD(i, { format: e.target.value })}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input data-testid="deliverable-path" value={d.path || ''} placeholder="{{vars.issue}}.feature" onChange={(e) => setD(i, { path: e.target.value })} />
            <button className="ghost small" onClick={() => onChange({ deliverables: dels.filter((_, j) => j !== i) })} title="Quitar">✕</button>
          </div>
          <div className="row">
            <input value={d.from || 'output'} title="De dónde sale: output (la salida) o json.campo" onChange={(e) => setD(i, { from: e.target.value })} style={{ width: 160 }} />
            <input value={d.destination?.[0]?.path || ''} placeholder="copiar también a (carpeta absoluta fija, opcional)" onChange={(e) => setD(i, { destination: e.target.value ? [{ path: e.target.value }] : undefined })} />
            {d.destination?.length > 0 && <label className="toggle small"><input type="checkbox" checked={!!d.overwrite} onChange={(e) => setD(i, { overwrite: e.target.checked || undefined })} /> sobrescribir</label>}
          </div>
        </div>
      ))}
      <div className="row wrap">
        <select value="" data-testid="action-add" onChange={(e) => e.target.value && onChange({ actions: [...actions, { id: rid('a'), type: e.target.value, params: {}, approval: DEFAULT_APPROVAL(e.target.value), when: 'success' }] })}>
          <option value="">＋ Acción…</option>{Object.entries(ACTION_DEFS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
        </select>
        <select value="" data-testid="deliverable-add" onChange={(e) => e.target.value && onChange({ deliverables: [...dels, { id: rid('d'), format: e.target.value, path: '', from: 'output' }] })}>
          <option value="">＋ Archivo…</option>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
    </div>
  );
}

const WATCH_TYPES = [
  ['git', '🌿 Rama git', 'C:\\repos\\mi-repo', 'Carpeta del repo (o {{vars.repo}}); abajo, la rama. Hace fetch y lista los commits nuevos. Sin modelo.'],
  ['jira', '🎫 Jira', 'SBK-123, SBK-124  ·  o JQL: project = SBK AND status = "Ready For Testing"', 'Claves o JQL. Avisa cambios de estado y comentarios nuevos. Usa Haiku con herramientas de solo lectura.'],
  ['confluence', '📘 Confluence', '123456  ·  tree:123456', 'Id o URL de página; tree:<id> incluye sus descendientes. Avisa la nueva versión.'],
  ['url', '🌐 URL / artefacto', 'https://jenkins…/lastSuccessfulBuild/artifact/x.zip', 'Mira ETag/Last-Modified (o el contenido). Credencial opcional para Jenkins y similares.'],
  ['file', '📄 Archivos', 'reports/*.xml', 'Ruta o patrón, relativo a la carpeta del flujo.'],
  ['command', '⌨️ Comando', 'git ls-remote origin', 'Su salida es la versión; un JSON con id por elemento se compara elemento por elemento.'],
  ['ai', '🤖 Lo que ven sus herramientas', 'bugs abiertos vinculados a SBK-123', 'Con las herramientas de este step, solo lectura.'],
];
const ON_CHANGE = [['notify', 'Solo avisar'], ['run_step', 'Ejecutar este step'], ['run_from_step', 'Ejecutar desde este step'], ['run_flow', 'Ejecutar el flujo']];
const STATE_TEXT = { first: 'primera foto (referencia)', same: 'sin cambios', new: 'hay novedades', error: 'error' };
/** Spec 10: "🔔 Novedades" — what this step's work depends on; a check reports what changed since the last one. */
function WatchBox({ flow, step, watch, onChange }) {
  const list = step.watches || [];
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (i, patch) => onChange({ watches: list.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const add = (type) => onChange({ watches: [...list, { id: `w_${Math.random().toString(36).slice(2, 10)}`, type, target: '', onChange: 'notify' }] });
  const mine = Object.entries(watch).filter(([, v]) => v.stepId === step.id);
  const pending = mine.reduce((a, [, v]) => a + (v.pending?.length || 0), 0);
  const check = async () => { setBusy(true); setErr(''); try { await pendingSave.flush(); await api.post(`/api/flows/${flow.id}/watch/check`, { stepId: step.id }); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="ctx-block" data-testid="watch-box">
      <div className="ctx-title">🔔 Novedades{list.length ? ` (${list.length})` : ''}{pending ? <span className="news"> · {pending} sin ver</span> : null}</div>
      <p className="muted small">Lo que el trabajo de este step necesita seguir: una rama, un ticket, una página, un artefacto. Al comprobar se compara con la vez anterior y se dice qué cambió. Nunca escribe nada afuera.</p>
      {list.map((w, i) => {
        const def = WATCH_TYPES.find((x) => x[0] === w.type) || WATCH_TYPES[0];
        const st = watch[w.id];
        return (
          <div key={w.id} className="src-item watch-item" data-type={w.type}>
            <div className="row">
              <b>{def[1]}</b>
              <div className="grow" />
              <select value={w.onChange || 'notify'} onChange={(e) => set(i, { onChange: e.target.value })} title="Qué hacer cuando hay novedades" data-testid="watch-onchange">
                {ON_CHANGE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <button className="ghost small" onClick={() => onChange({ watches: list.filter((_, j) => j !== i) })} title="Quitar">✕</button>
            </div>
            <input className="watch-target" data-testid="watch-target" value={w.target} placeholder={def[2]} onChange={(e) => set(i, { target: e.target.value })} />
            {w.type === 'git' && <input value={w.options?.branch || ''} placeholder="rama (vacío = la actual)" onChange={(e) => set(i, { options: { ...w.options, branch: e.target.value } })} />}
            {w.type === 'url' && <input value={w.options?.credential || ''} placeholder="credencial (opcional, nombre de ⚙ Credenciales)" onChange={(e) => set(i, { options: { ...w.options, credential: e.target.value } })} />}
            <div className="muted small">{def[3]}</div>
            {st && (
              <div className={`watch-state ws-${st.state}`} data-testid="watch-state">
                {STATE_TEXT[st.state] || st.state} · {new Date(st.checkedAt).toLocaleString()}{st.count != null ? ` · ${st.count} elemento(s)` : ''}{st.note || ''}
                {st.error && <div className="warn-text small">{st.error}</div>}
                {st.pending?.length > 0 && <ul className="watch-changes">{st.pending.slice(-10).map((c, k) => <li key={k} className={`ch-${c.kind}`}>{c.text}</li>)}</ul>}
                {st.action && <div className="small">{st.action.runId ? `▶ Se lanzó: ${ON_CHANGE.find((x) => x[0] === st.action.kind)?.[1].toLowerCase()} (${st.action.runId})` : st.action.error}</div>}
              </div>
            )}
          </div>
        );
      })}
      <div className="row wrap">
        <select value="" onChange={(e) => e.target.value && add(e.target.value)} data-testid="watch-add">
          <option value="">＋ Vigilar…</option>
          {WATCH_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {list.length > 0 && <button className="ghost small" onClick={check} disabled={busy} data-testid="watch-check">{busy ? 'Comprobando…' : 'Comprobar ahora'}</button>}
        {pending > 0 && <button className="ghost small" data-testid="watch-ack" onClick={() => api.post(`/api/flows/${flow.id}/watch/ack`, { stepId: step.id }).catch((e) => setErr(e.message))}>✓ Visto</button>}
      </div>
      {err && <div className="warn-text small">{err}</div>}
    </div>
  );
}

/** Spec 15 DATA-10: "🔁 Para cada" — the step runs once per element of a JSON list from a step before it. */
function ForEachBox({ flow, step, onChange }) {
  const fe = step.forEach;
  const set = (patch) => onChange({ forEach: { path: '', parallel: 1, max: 20, ...(fe || {}), ...patch } });
  return (
    <div className="ctx-block" data-testid="foreach-box">
      <label className="toggle" title="Corre este step una vez por cada elemento de una lista (por ejemplo, cada ticket que eligió el coordinador). Lo que sigue recibe la lista de resultados.">
        <input type="checkbox" data-testid="foreach-toggle" checked={!!fe} onChange={(e) => onChange({ forEach: e.target.checked ? { path: '', parallel: 1, max: 20 } : undefined })} /> 🔁 Para cada elemento de una lista
      </label>
      {fe && (
        <div className="foreach-fields">
          <Field label="Lista" hint="ruta dentro del JSON (ej.: automatizacion, tickets, data.items); vacío = el JSON entero">
            <input data-testid="foreach-path" value={fe.path || ''} placeholder="automatizacion" onChange={(e) => set({ path: e.target.value })} />
          </Field>
          <Field label="De la salida de" hint="por defecto, la primera entrada que trae una lista en esa ruta">
            <select data-testid="foreach-from" value={fe.from || ''} onChange={(e) => set({ from: e.target.value || undefined })}>
              <option value="">La entrada que la traiga</option>
              {ancestorSteps(flow, step.id).map((x) => <option key={x.id} value={x.id}>“{x.name}”</option>)}
            </select>
          </Field>
          <Field label="A la vez" hint="1 = de a uno (ambientes compartidos); hasta 4">
            <select value={fe.parallel || 1} onChange={(e) => set({ parallel: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? '1 (de a uno)' : n}</option>)}
            </select>
          </Field>
          <Field label="Máximo" hint="elementos por ejecución (1–50)">
            <input type="number" min="1" max="50" value={fe.max || 20} onChange={(e) => set({ max: Number(e.target.value) || 20 })} />
          </Field>
          <p className="muted small">En la tarea o el comando: <code>{'{{item}}'}</code>, <code>{'{{item.key}}'}</code>, <code>{'{{item.index}}'}</code>/<code>{'{{item.total}}'}</code>. Los comandos también reciben <code>$env:AFS_ITEM</code>. Si la lista viene vacía, este step y lo que sigue no corren.</p>
        </div>
      )}
    </div>
  );
}

function ancestorSteps(flow, id) {
  const seen = new Set(); const stack = [id];
  while (stack.length) { const cur = stack.pop(); for (const e of flow.edges) if (e.target === cur && !seen.has(e.source)) { seen.add(e.source); stack.push(e.source); } }
  return flow.steps.filter((x) => seen.has(x.id) && x.id !== id);
}
const WHEN_OPTS = [['always', 'Siempre'], ['route', '🧭 Lo decide el step de origen'], ['json', 'Si un campo del JSON…'], ['contains', 'Si la salida contiene…'], ['notContains', 'Si la salida NO contiene…'], ['regex', 'Si la salida cumple una regex…']];
const JSON_OPS = [['equals', '='], ['notEquals', '≠'], ['gte', '≥'], ['lte', '≤'], ['exists', 'existe'], ['matches', 'cumple regex'], ['lengthGte', 'largo ≥'], ['lengthLte', 'largo ≤']];
export function EdgePanel({ flow, edge, onChange, onDelete, onClose }) {
  const from = flow.steps.find((s) => s.id === edge.source);
  const to = flow.steps.find((s) => s.id === edge.target);
  const w = edge.when || { type: 'always' };
  // Changing the type starts from that type's defaults (the select shows "=": it must also be what is saved).
  const setWhen = (p) => {
    let n = p.type && p.type !== w.type ? { type: p.type, ...(p.type === 'json' ? { op: 'equals' } : {}) } : { ...w, ...p };
    if (n.type === 'json' && !n.op) n = { ...n, op: 'equals' };
    if (n.op === 'exists') delete n.value;
    onChange({ when: n.type === 'always' ? undefined : n });
  };
  const siblings = flow.edges.filter((e) => e.source === edge.source && e.id !== edge.id).length;
  return (
    <div className="panel edge-panel">
      <div className="panel-head"><b>Flecha: {from?.name} → {to?.name}</b><button className="ghost small" onClick={onClose}>Cerrar</button></div>
      <div className="panel-body pad">
        <p className="muted small">Cada flecha decide <b>qué</b> pasa y <b>cuándo</b>. Así una misma caja reparte su salida entre varios destinos{siblings ? ` (esta caja tiene ${siblings + 1} salidas)` : ''}. Arrastra el extremo de la flecha a otro punto de la caja para cambiar el lado.</p>
        <Field label="Etiqueta" hint="se ve sobre la flecha y el destino la recibe como título">
          <input value={edge.label || ''} onChange={(e) => onChange({ label: e.target.value || undefined })} placeholder="Ej: casos de riesgo alto" />
        </Field>
        <Field label="Qué pasa" hint="vacío = toda la salida (texto + JSON). Con un campo, pasa solo esa parte del JSON">
          <input className="mono" value={edge.pick || ''} onChange={(e) => onChange({ pick: e.target.value || undefined })} placeholder="Ej: casos  ·  riesgos.alto  ·  items.0" />
        </Field>
        <Field label="Cuándo pasa">
          <select value={w.type} onChange={(e) => setWhen({ type: e.target.value })}>{WHEN_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {w.type === 'route' && <div className="muted small">El step “{from?.name}” verá en sus instrucciones la lista de destinos y elegirá con &lt;route to="{to?.name}"/&gt; (toda su salida) o &lt;route to="{to?.name}"&gt;contenido&lt;/route&gt; (solo ese contenido para este destino).</div>}
          {w.type === 'json' && (
            <div className="row wrap">
              <input className="mono" value={w.path || ''} onChange={(e) => setWhen({ path: e.target.value })} placeholder="campo (riesgo)" />
              <select value={w.op || 'equals'} onChange={(e) => setWhen({ op: e.target.value })}>{JSON_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {w.op !== 'exists' && <input className="mono" value={w.value ?? ''} onChange={(e) => setWhen({ value: e.target.value })} placeholder="valor (alto)" />}
            </div>
          )}
          {(w.type === 'contains' || w.type === 'notContains') && <input value={w.value || ''} onChange={(e) => setWhen({ value: e.target.value })} placeholder="texto" />}
          {w.type === 'regex' && <input className="mono" value={w.pattern || ''} onChange={(e) => setWhen({ pattern: e.target.value })} placeholder="^APROBADO" />}
          {w.type !== 'always' && w.type !== 'route' && (
            <label className="small row" style={{ marginTop: 4 }}>Mirar la salida de
              <select value={w.from || ''} onChange={(e) => setWhen({ from: e.target.value || undefined })} data-testid="edge-when-from">
                <option value="">“{from?.name}” (origen de la flecha)</option>
                {ancestorSteps(flow, edge.source).map((x) => <option key={x.id} value={x.id}>“{x.name}” (decide antes en el flujo)</option>)}
              </select>
            </label>
          )}
          {w.type !== 'always' && <div className="muted small">Si no se cumple, “{to?.name}” no recibe nada por esta flecha; si ninguna de sus flechas pasa, queda “no enrutado” (no es un error) y tampoco corre lo que depende de él.</div>}
        </Field>
        <div className="row"><button className="ghost danger small" onClick={onDelete}>Eliminar flecha</button></div>
      </div>
    </div>
  );
}

// ---------------- versions (spec 20) ----------------
function Versions({ flow, onChange }) {
  const [list, setList] = useState(null);
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.get(`/api/flows/${flow.id}/versions`).then(setList).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [flow.id, flow.rev]);
  const every = flow.versionEveryMin ?? 5;
  async function saveNow() {
    try { await pendingSave.flush(); await api.post(`/api/flows/${flow.id}/versions`, { label: label.trim() || 'Versión guardada' }); setLabel(''); setMsg('Versión guardada'); load(); } catch (e) { setMsg(e.message); }
  }
  async function restore(v) {
    if (!confirm(`¿Restaurar la versión del ${new Date(v.at).toLocaleString()}${v.label ? ` (“${v.label}”)` : ''}?\n\nEl estado actual se guarda antes como versión, así que puedes volver.`)) return;
    try { await pendingSave.flush(); await api.post(`/api/flows/${flow.id}/versions/${v.id}/restore`, {}); setMsg('Versión restaurada'); load(); } catch (e) { setMsg(e.message); }
  }
  async function remove(v) { try { await api.del(`/api/flows/${flow.id}/versions/${v.id}`); load(); } catch (e) { setMsg(e.message); } }
  return (
    <div className="versions">
      <p className="muted small">Mientras editas, se guarda una versión automática como máximo cada {every || '—'} minutos (y el estado inicial antes del primer cambio). Las versiones con nombre no se borran; de las automáticas se guardan las últimas 30. Ctrl+Z / Ctrl+Y deshacen y rehacen cambios recientes.</p>
      <Field label="Versión automática cada (minutos)" hint="0 = desactivada">
        <input type="number" min={0} max={1440} value={every} onChange={(e) => onChange({ versionEveryMin: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 90 }} />
      </Field>
      <div className="row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nombre de la versión (opcional)" onKeyDown={(e) => e.key === 'Enter' && saveNow()} />
        <button className="primary" onClick={saveNow}>Guardar versión</button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {!list ? <div className="muted small">Cargando…</div> : !list.length ? <div className="muted small">Todavía no hay versiones.</div> : (
        <ul className="version-list">
          {list.map((v) => (
            <li key={v.id}>
              <div><b>{new Date(v.at).toLocaleString()}</b> {v.label ? <span>· {v.label}</span> : null} <span className="muted small">· {v.auto ? 'automática' : 'guardada'} · {v.steps} steps, {v.edges} flechas</span></div>
              <div className="row"><button className="small" onClick={() => restore(v)}>Restaurar</button><button className="ghost small danger" onClick={() => remove(v)} title="Borrar esta versión">✕</button></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
