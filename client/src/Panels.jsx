import React, { useEffect, useState } from 'react';
import { api, pendingSave } from './api.js';
import Chat from './Chat.jsx';
import Events from './Events.jsx';
import { ACCESS, accessOf } from './presets.js';
import { ExternalInvoke } from './Help.jsx';
import { TplField, IoSettings, DataTab, VerifySettings, RunStats } from './Data.jsx';
import ContextBox from './Context.jsx';
import ContextSources, { FsPicker } from './Sources.jsx';
import RequirementsEditor from './Requirements.jsx';

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

export function StepPanel({ flow, step, catalog, live, running, tab, setTab, onChange, onDelete, onRun, onProbe, onOpenStep, onDuplicate, onSaveLib }) {
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
        {[['config', 'Config'], ['chat', 'Chat'], ['activity', `Actividad${status === 'running' ? ' ●' : ''}`], ['data', `Datos${step.pinned ? ' 📌' : ''}`], ['memory', `Memoria (${step.memory?.length || 0})`], ['hooks', 'Hooks']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {(tab === 'config' || tab === 'chat') && <ContextBox flow={flow} step={step} target={tab === 'chat' ? 'chat' : 'run'} />}

      {tab === 'config' && (
        <div className="panel-body pad">
          <Field label="Tipo">
            <div className="seg">
              {[['role', '🎭 Rol'], ['agent', '🤖 Agente'], ['skill', '🧩 Skill'], ['command', '⌨️ Comando']].map(([k, l]) => (
                <button key={k} className={step.kind === k ? 'active' : ''} onClick={() => onChange({ kind: k })}>{l}</button>
              ))}
            </div>
          </Field>
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

export function FlowPanel({ flow, running, tab, setTab, onChange, onOpenStep, onReset }) {
  const [varsText, setVarsText] = useState(JSON.stringify(flow.vars || {}, null, 2));
  const [varsErr, setVarsErr] = useState('');
  const [runs, setRuns] = useState([]);
  const [runDetail, setRunDetail] = useState(null);
  const [cwdPicker, setCwdPicker] = useState(false);
  const [varsFocus, setVarsFocus] = useState(false);
  // Follow server-side changes (e.g. a hook's ctx.setVar) unless the user is editing the JSON or it holds an invalid draft.
  useEffect(() => { if (!varsFocus && !varsErr) setVarsText(JSON.stringify(flow.vars || {}, null, 2)); }, [flow.id, JSON.stringify(flow.vars || {})]);
  useEffect(() => { if (tab === 'runs') api.get(`/api/flows/${flow.id}/runs`).then(setRuns); }, [tab, flow.id]);
  const set = (k) => (e) => onChange({ [k]: e.target.value });

  return (
    <div className="panel">
      <div className="panel-head"><b>{flow.name}</b><span className="muted small">{flow.steps.length} steps</span></div>
      <div className="tabs">
        {[['chat', 'Chat general'], ['settings', 'Flujo'], ['memory', `Memoria (${flow.memory?.length || 0})`], ['runs', 'Ejecuciones'], ['versions', 'Versiones'], ['external', 'Invocar']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'chat' && (
        <Chat flowId={flow.id} chatKey="_global" vars={flow.vars} onOpenStep={onOpenStep}
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
          <Field label="Directorio de trabajo" hint="dónde trabajan Claude y los comandos (repo, proyecto). Si no existe, la ejecución no arranca">
            <div className="row">
              <input className="mono" style={{ flex: 1 }} value={flow.cwd || ''} onChange={set('cwd')} placeholder="C:\Users\...\mi-repo" />
              <button className="small" onClick={() => setCwdPicker(true)}>Explorar…</button>
            </div>
            {!flow.cwd && flow.steps.some((s) => s.kind === 'command' || /(^|\s)(Edit|Write|Bash)/.test(s.allowedTools || '') || s.permissionMode === 'acceptEdits') && <div className="warn-text small">⚠ Sin directorio: los steps que editan o ejecutan comandos trabajarán en tu carpeta de usuario.</div>}
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
                  <span className="chip">{r.trigger}{r.only ? ' · 1 step' : ''}</span>
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
