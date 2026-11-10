import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import Chat from './Chat.jsx';
import Events from './Events.jsx';
import { ACCESS, accessOf } from './presets.js';
import { ExternalInvoke } from './Help.jsx';
import { TplField, IoSettings, DataTab } from './Data.jsx';

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

function Field({ label, hint, children, div }) {
  const Tag = div ? 'div' : 'label';
  return <Tag className="field"><span className="field-label">{label}{hint && <span className="hint"> — {hint}</span>}</span>{children}</Tag>;
}

export function StepPanel({ flow, step, catalog, live, tab, setTab, onChange, onDelete, onRun, onProbe, onOpenStep }) {
  const [runInput, setRunInput] = useState('');
  const [runEvents, setRunEvents] = useState(null);
  const set = (k) => (e) => onChange({ [k]: e.target.value });

  useEffect(() => {
    setRunEvents(null);
    if (tab === 'activity' && !live?.events?.length && step.lastRun?.runId) {
      api.get(`/api/flows/${flow.id}/runs/${step.lastRun.runId}`).then((r) => setRunEvents(r?.steps?.[step.id]?.events || [])).catch(() => {});
    }
  }, [tab, step.id, step.lastRun?.runId]);

  const tools = new Set(String(step.allowedTools || '').split(/[\s,]+/).filter(Boolean));
  const toggleTool = (t) => { tools.has(t) ? tools.delete(t) : tools.add(t); onChange({ allowedTools: [...tools].join(' ') }); };
  const status = live?.status || step.lastRun?.status;

  return (
    <div className="panel">
      <div className="panel-head">
        <input className="title-input" value={step.name} onChange={set('name')} />
        <button className="ghost danger small" onClick={() => confirm(`¿Eliminar "${step.name}"?`) && onDelete()}>Eliminar</button>
      </div>
      <div className="tabs">
        {[['config', 'Config'], ['chat', 'Chat'], ['activity', `Actividad${status === 'running' ? ' ●' : ''}`], ['data', `Datos${step.pinned ? ' 📌' : ''}`], ['memory', `Memoria (${step.memory?.length || 0})`], ['hooks', 'Hooks']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'config' && (
        <div className="panel-body pad">
          <Field label="Tipo">
            <div className="seg">
              {[['role', '🎭 Rol'], ['agent', '🤖 Agente'], ['skill', '🧩 Skill'], ['command', '⌨️ Comando']].map(([k, l]) => (
                <button key={k} className={step.kind === k ? 'active' : ''} onClick={() => onChange({ kind: k })}>{l}</button>
              ))}
            </div>
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
            <Field label="Skill" hint="tus skills de Claude Code / claude.ai / plugins">
              <select value={step.skillRef} onChange={set('skillRef')}>
                <option value="">— elegir —</option>
                {catalog.skills.map((s) => <option key={s.path} value={s.name}>{s.name} · {s.source}</option>)}
              </select>
              <div className="muted small">{catalog.skills.find((s) => s.name === step.skillRef)?.description}</div>
            </Field>
          )}
          {step.kind === 'command' ? (
            <>
              <Field div label="Comando" hint="stdin = salida de los steps anteriores ($env:STEP_UPSTREAM, JSON en $env:STEP_UPSTREAM_JSON); input del flujo en $env:FLOW_INPUT">
                <TplField flow={flow} step={step} command className="mono" rows={4} value={step.command} onChange={(v) => onChange({ command: v })} placeholder="npx playwright test --grep @sanity" />
              </Field>
              <Field label="Shell">
                <select value={step.shell} onChange={set('shell')}><option value="powershell">PowerShell</option><option value="bash">bash</option><option value="cmd">cmd</option></select>
              </Field>
              <IoSettings step={step} onChange={onChange} />
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
              <details className="advanced">
                <summary>Avanzado: contexto, modelo, permisos y tools exactas</summary>
              <Field div label="Contexto" hint="datos fijos: links, proyecto Jira, reglas, etc.">
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
            <button className="primary" onClick={() => { onRun(runInput); setTab('activity'); }} disabled={status === 'running'}>▶ Ejecutar step</button>
          </div>
          {step.lastRun?.output && (
            <details className="last-out"><summary>Última salida ({step.lastRun.status})</summary><pre>{step.lastRun.output}</pre></details>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <Chat flowId={flow.id} chatKey={step.id} step={step} allowImprove={step.kind === 'skill' || step.kind === 'agent'} onOpenStep={onOpenStep}
          placeholder={`Chat en el contexto de "${step.name}": pregunta qué hizo, por qué, pídele que mejore su rol/tarea/hooks (te propone el cambio y lo aplicas), o activa "modo mejora" para que edite la skill/agente.`} />
      )}

      {tab === 'activity' && (
        <div className="panel-body pad">
          {live?.events?.length ? <Events events={live.events} running={live.status === 'running'} /> : runEvents ? <Events events={runEvents} /> : <div className="muted small">Ejecuta el step o el flujo para ver su proceso interno.</div>}
          {step.lastRun?.output && status !== 'running' && <details className="last-out" open><summary>Salida</summary><pre>{step.lastRun.output}</pre></details>}
          {step.lastRun?.error && status !== 'running' && <div className="error-bar">{step.lastRun.error}</div>}
        </div>
      )}

      {tab === 'data' && <DataTab flow={flow} step={step} live={live} />}

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

export function FlowPanel({ flow, tab, setTab, onChange, onOpenStep, onReset }) {
  const [varsText, setVarsText] = useState(JSON.stringify(flow.vars || {}, null, 2));
  const [varsErr, setVarsErr] = useState('');
  const [runs, setRuns] = useState([]);
  const [runDetail, setRunDetail] = useState(null);
  useEffect(() => { setVarsText(JSON.stringify(flow.vars || {}, null, 2)); }, [flow.id]);
  useEffect(() => { if (tab === 'runs') api.get(`/api/flows/${flow.id}/runs`).then(setRuns); }, [tab, flow.id]);
  const set = (k) => (e) => onChange({ [k]: e.target.value });
  const hook = `${location.origin}/api/flows/${flow.id}/trigger`;

  return (
    <div className="panel">
      <div className="panel-head"><b>{flow.name}</b><span className="muted small">{flow.steps.length} steps</span></div>
      <div className="tabs">
        {[['chat', 'Chat general'], ['settings', 'Flujo'], ['memory', `Memoria (${flow.memory?.length || 0})`], ['runs', 'Ejecuciones'], ['external', 'Invocar']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'chat' && (
        <Chat flowId={flow.id} chatKey="_global" onOpenStep={onOpenStep}
          placeholder="Habla en lenguaje natural. Un enrutador (Haiku) decide qué step, agente, skill o rol responde —o si debe ejecutar algo— y verás por qué. La respuesta queda también en el chat de ese step." />
      )}
      {tab === 'settings' && (
        <div className="panel-body pad">
          <Field label="Nombre"><input value={flow.name} onChange={set('name')} /></Field>
          <Field label="Descripción"><textarea rows={2} value={flow.description} onChange={set('description')} /></Field>
          <Field label="Directorio de trabajo" hint="cwd de Claude y comandos (repo, proyecto). Vacío = tu home">
            <input className="mono" value={flow.cwd} onChange={set('cwd')} placeholder="C:\Users\...\mi-repo" />
          </Field>
          <Field label="Variables (JSON)" hint="{{vars.x}} en tareas/comandos, ctx.vars en hooks">
            <textarea className="mono" rows={5} value={varsText} onChange={(e) => { setVarsText(e.target.value); try { onChange({ vars: JSON.parse(e.target.value || '{}') }); setVarsErr(''); } catch (er) { setVarsErr(er.message); } }} />
            {varsErr && <div className="warn-text small">{varsErr}</div>}
          </Field>
          <Field label="Programación">
            <div className="row">
              <label className="toggle"><input type="checkbox" checked={!!flow.schedule?.enabled} onChange={(e) => onChange({ schedule: { ...flow.schedule, enabled: e.target.checked } })} /> cada</label>
              <input type="number" min={1} style={{ width: 80 }} value={flow.schedule?.everyMinutes ?? 60} onChange={(e) => onChange({ schedule: { ...flow.schedule, everyMinutes: Number(e.target.value) } })} /> min
            </div>
            <input value={flow.schedule?.input || ''} onChange={(e) => onChange({ schedule: { ...flow.schedule, input: e.target.value } })} placeholder="Input para ejecuciones programadas" />
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
      {tab === 'external' && <div className="panel-body pad"><ExternalInvoke flow={flow} /></div>}
      {tab === 'memory' && <Memory flowId={flow.id} scope="_flow" items={flow.memory} />}
      {tab === 'runs' && (
        <div className="panel-body pad">
          {runDetail ? (
            <div>
              <button className="ghost small" onClick={() => setRunDetail(null)}>← volver</button>
              <h4>{runDetail.id} · {runDetail.status}</h4>
              {runDetail.input && <details><summary>Input</summary><pre>{runDetail.input}</pre></details>}
              {Object.entries(runDetail.steps).map(([sid, s]) => (
                <details key={sid} className="run-step">
                  <summary><span className={`status s-${s.status}`}>{s.status}</span> {flow.steps.find((x) => x.id === sid)?.name || sid}</summary>
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
                  <span className="chip">{r.trigger}{r.only ? ' · 1 step' : ''}</span>
                  <span className="muted small grow">{r.input}</span>
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
