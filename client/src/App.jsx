import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, onWs } from './api.js';
import Canvas, { autoLayout, wouldCycle } from './Canvas.jsx';
import { StepPanel, FlowPanel } from './Panels.jsx';
import { StepPicker, AiFlowModal, HelpMenu, HelpModal, Tour } from './Help.jsx';

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const rid = (p) => p + Math.random().toString(36).slice(2, 10);

function newStep(kind, name) {
  return {
    id: rid('s_'), name, kind, role: '', agentRef: '', skillRef: '', command: '', shell: 'powershell', task: '', context: '',
    model: '', effort: '', permissionMode: '', allowedTools: 'Read Grep Glob WebFetch WebSearch Skill', hooks: '',
    position: { x: 0, y: 0 }, memory: [], lastRun: null,
  };
}

function activityOf(ev) {
  if (ev.kind === 'tool_use') return `🔧 ${ev.name}`;
  if (ev.kind === 'thinking_tokens') return `🧠 pensando (~${ev.tokens} tk)`;
  if (ev.kind === 'text') return `💬 ${ev.text.slice(0, 60)}`;
  if (ev.kind === 'hook' || ev.kind === 'hook_log') return `🪝 ${ev.text.slice(0, 60)}`;
  return null;
}

export default function App() {
  const [flows, setFlows] = useState([]);
  const [flow, setFlow] = useState(null);
  const [catalog, setCatalog] = useState({ skills: [], agents: [], tools: [], mcpServers: [] });
  const [live, setLive] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [stepTab, setStepTab] = useState('config');
  const [flowTab, setFlowTab] = useState('chat');
  const [rate, setRate] = useState(null);
  const [runInput, setRunInput] = useState('');
  const [showRun, setShowRun] = useState(false);
  const [toast, setToast] = useState('');
  const [saveState, setSaveState] = useState('');
  const [modal, setModal] = useState(null); // 'picker' | 'ai' | {help: section}
  const [tourStep, setTourStep] = useState(ls.get('afs.tourDone') ? null : 0);
  const endTour = () => { setTourStep(null); ls.set('afs.tourDone', '1'); };
  const [leftovers, setLeftovers] = useState(null);
  const [resetNonce, setResetNonce] = useState(0);
  const [autoOrder, setAutoOrder] = useState(ls.get('afs.autoOrder') !== '0');
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const flowRef = useRef(null);
  flowRef.current = flow;

  const notify = (t) => { setToast(t); setTimeout(() => setToast(''), 4000); };
  const loadFlows = () => api.get('/api/flows').then(setFlows);
  const loadCatalog = (cwd) => api.get(`/api/catalog${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`).then((c) => { setCatalog(c); if (c.rateLimit) setRate(c.rateLimit); });

  useEffect(() => {
    loadFlows().then(() => {});
    const last = ls.get('afs.flow');
    api.get('/api/flows').then((list) => {
      const id = list.find((f) => f.id === last)?.id || list[0]?.id;
      if (id) openFlow(id);
    });
  }, []);
  useEffect(() => { loadCatalog(flow?.cwd); }, [flow?.id, flow?.cwd]);
  // When the canvas is empty, show what is still attached to the flow (description, vars, chats, runs…).
  const noSteps = flow && flow.steps.length === 0;
  useEffect(() => {
    if (!noSteps) { setLeftovers(null); return; }
    const t = setTimeout(() => api.get(`/api/flows/${flow.id}/leftovers`).then(setLeftovers).catch(() => {}), 700);
    return () => clearTimeout(t);
  }, [flow?.id, noSteps, resetNonce]);

  async function openFlow(id) {
    let f = await api.get(`/api/flows/${id}`);
    if (f.steps.length && f.steps.every((s) => !s.position?.x && !s.position?.y)) { f = { ...f, steps: autoLayout(f.steps, f.edges) }; api.put(`/api/flows/${f.id}`, f); }
    setFlow(f); setSelectedId(null); setLive({}); ls.set('afs.flow', id);
  }

  // ---- persistence (debounced) ----
  const scheduleSave = useCallback(() => {
    dirty.current = true; setSaveState('…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const f = flowRef.current;
      try { await api.put(`/api/flows/${f.id}`, f); setSaveState('guardado'); loadFlows(); }
      catch (e) { setSaveState('error'); notify(e.message); }
      dirty.current = false;
    }, 500);
  }, []);

  const mutate = useCallback((fn, { layout = false } = {}) => {
    setFlow((cur) => {
      let next = fn(structuredClone(cur));
      if (layout && autoOrder) next = { ...next, steps: autoLayout(next.steps, next.edges) };
      return next;
    });
    scheduleSave();
  }, [scheduleSave, autoOrder]);

  // ---- websocket ----
  useEffect(() => onWs((m) => {
    const cur = flowRef.current;
    if (m.type === 'run.event' && m.event.kind === 'rate_limit') setRate(m.event.info);
    if (m.type === 'chat.event' && m.event.kind === 'rate_limit') setRate(m.event.info);
    if (!cur || m.flowId !== cur.id) return;
    switch (m.type) {
      case 'flow.updated':
        setFlow((c) => {
          if (!c || c.id !== m.flow.id) return c;
          const srv = new Map(m.flow.steps.map((s) => [s.id, s]));
          return {
            ...c, memory: m.flow.memory, globalSessionId: m.flow.globalSessionId, vars: dirty.current ? c.vars : m.flow.vars,
            steps: c.steps.map((s) => {
              const p = srv.get(s.id);
              if (!p) return s;
              return dirty.current ? { ...s, memory: p.memory, lastRun: p.lastRun, chatSessionId: p.chatSessionId } : { ...p, position: s.position };
            }),
          };
        });
        break;
      case 'step.status':
        setLive((l) => ({ ...l, [m.stepId]: { ...(m.status === 'running' ? { events: [] } : l[m.stepId]), status: m.status, runId: m.runId } }));
        break;
      case 'run.event': {
        const ev = m.event;
        if (ev.kind === 'delta' || ev.kind === 'thinking_delta') return;
        setLive((l) => {
          const cur2 = l[m.stepId] || { status: 'running', events: [] };
          return { ...l, [m.stepId]: { ...cur2, events: [...(cur2.events || []), ev], activity: activityOf(ev) || cur2.activity } };
        });
        break;
      }
      case 'run.started':
        notify(m.only ? 'Ejecutando step…' : `Flujo en ejecución (${m.trigger})`);
        break;
      case 'run.finished':
        notify(`Ejecución ${m.status}${m.error ? `: ${m.error}` : ''}`);
        break;
      default:
    }
  }), []);

  // ---- actions ----
  async function createFlow(template) {
    const name = prompt('Nombre del flujo', template === 'demo' ? 'Demo QA: requerimiento → casos → revisión' : 'Nuevo flujo');
    if (!name) return;
    const f = await api.post('/api/flows', { name, template });
    await loadFlows();
    const laid = { ...f, steps: autoLayout(f.steps, f.edges) };
    await api.put(`/api/flows/${f.id}`, laid);
    openFlow(f.id);
  }
  async function deleteFlow() {
    if (!confirm(`¿Eliminar el flujo "${flow.name}" con sus chats y ejecuciones?`)) return;
    await api.del(`/api/flows/${flow.id}`);
    const list = await api.get('/api/flows'); setFlows(list);
    if (list[0]) openFlow(list[0].id); else setFlow(null);
  }
  function addStep(preset) {
    setModal(null);
    const s = { ...newStep(preset.step.kind, preset.group === 'En blanco' ? preset.name.replace(/ vacío| vacía/, '') : preset.name), ...preset.step };
    const sel = flow.steps.find((x) => x.id === selectedId);
    mutate((f) => {
      if (sel) { s.position = { x: sel.position.x + 300, y: sel.position.y }; }
      f.steps.push(s);
      if (sel) f.edges.push({ id: rid('e_'), source: sel.id, target: s.id });
      return f;
    }, { layout: true });
    setSelectedId(s.id); setStepTab('config');
  }
  const onConnect = (source, target) => {
    if (flow.edges.some((e) => e.source === source && e.target === target)) return;
    if (wouldCycle(flow.edges, source, target)) return notify('Esa relación crearía un ciclo.');
    mutate((f) => { f.edges.push({ id: rid('e_'), source, target }); return f; }, { layout: true });
  };
  const onDeleteSteps = (ids) => { mutate((f) => { f.steps = f.steps.filter((s) => !ids.includes(s.id)); f.edges = f.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)); return f; }, { layout: true }); setSelectedId(null); };
  const onDeleteEdges = (ids) => mutate((f) => { f.edges = f.edges.filter((e) => !ids.includes(e.id)); return f; }, { layout: true });
  const onMove = (id, pos) => mutate((f) => { const s = f.steps.find((x) => x.id === id); if (s) s.position = pos; return f; });
  const patchStep = (id, patch) => mutate((f) => { const s = f.steps.find((x) => x.id === id); Object.assign(s, patch); return f; });
  const relayout = () => { setFlow((f) => ({ ...f, steps: autoLayout(f.steps, f.edges) })); scheduleSave(); };

  async function runFlow() {
    setShowRun(false);
    try { await flushSave(); await api.post(`/api/flows/${flow.id}/run`, { input: runInput }); } catch (e) { notify(e.message); }
  }
  async function runStep(id, input) {
    try { await flushSave(); await api.post(`/api/flows/${flow.id}/steps/${id}/run`, { input }); } catch (e) { notify(e.message); }
  }
  async function flushSave() {
    if (!dirty.current) return;
    clearTimeout(saveTimer.current);
    await api.put(`/api/flows/${flowRef.current.id}`, flowRef.current);
    dirty.current = false; setSaveState('guardado');
  }
  async function resetFlow(parts, ask = true) {
    const labels = { steps: 'steps y relaciones', description: 'descripción', vars: 'variables', memory: 'memoria del flujo', chats: 'chats', runs: 'historial de ejecuciones', schedule: 'programación' };
    if (ask && !confirm(`Se va a borrar: ${parts.map((p) => labels[p]).join(', ')}.
Se conserva el nombre, el directorio de trabajo y la URL/token de invocación.

¿Continuar?`)) return;
    try {
      clearTimeout(saveTimer.current); dirty.current = false;
      const f = await api.post(`/api/flows/${flow.id}/reset`, { parts });
      setFlow(f); setSelectedId(null); setLive({}); setResetNonce((n) => n + 1); loadFlows();
      notify('Flujo limpio');
    } catch (e) { notify(e.message); }
  }
  async function probe() {
    notify('Detectando tools y MCPs de tu Claude Code…');
    await api.post('/api/catalog/probe', { cwd: flow?.cwd });
    await loadCatalog(flow?.cwd);
    notify('Catálogo actualizado');
  }

  const step = flow?.steps.find((s) => s.id === selectedId);
  const anyRunning = Object.values(live).some((l) => l.status === 'running');
  const win = rate?.unifiedWindows;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">⛓️ Agent Flow Studio</div>
        <select value={flow?.id || ''} onChange={(e) => openFlow(e.target.value)}>
          {!flow && <option value="">— sin flujos —</option>}
          {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <span data-tour="flows" className="row">
          <button onClick={() => createFlow()}>+ Flujo</button>
          <button className="ghost" onClick={() => setModal('ai')} title="Describe el flujo y la IA lo arma con tus skills">✨ Con IA</button>
          <button className="ghost" onClick={() => createFlow('demo')} title="Crea un flujo de ejemplo con tus skills de QA">Demo</button>
        </span>
        {flow && <button className="ghost danger" onClick={deleteFlow} title="Eliminar flujo">🗑</button>}
        <div className="sep" />
        {flow && (
          <>
            <button data-tour="add-step" onClick={() => setModal('picker')}>＋ Step</button>
            <div className="sep" />
            <button className="ghost" onClick={relayout}>⇄ Ordenar</button>
            <label className="toggle small"><input type="checkbox" checked={autoOrder} onChange={(e) => { setAutoOrder(e.target.checked); ls.set('afs.autoOrder', e.target.checked ? '1' : '0'); }} /> auto</label>
            <div className="grow" />
            {win && (
              <span className="rate" data-tour="rate" title="Uso de tu suscripción (ventanas de 5 h y 7 días)">
                5h {Math.round((win.five_hour?.utilization || 0) * 100)}% · 7d {Math.round((win.seven_day?.utilization || 0) * 100)}%
              </span>
            )}
            <span className="muted small save">{saveState}</span>
            <div className="run-wrap" data-tour="run">
              <button className="primary" onClick={() => setShowRun(!showRun)} disabled={!flow.steps.length}>▶ Ejecutar flujo</button>
              {showRun && (
                <div className="popover">
                  <textarea rows={5} autoFocus value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="Input del flujo (requerimiento, ticket, URL, JSON…)" />
                  <div className="row"><button className="ghost" onClick={() => setShowRun(false)}>Cancelar</button><button className="primary" onClick={runFlow}>Ejecutar</button></div>
                </div>
              )}
            </div>
            {anyRunning && <button className="danger" onClick={() => api.post(`/api/flows/${flow.id}/stop`)}>■ Detener</button>}
          </>
        )}
        {!flow && <div className="grow" />}
        <HelpMenu onTour={() => setTourStep(0)} onGuide={(sec) => setModal({ help: sec })} />
      </header>

      {flow ? (
        <main className="main">
          <section className="canvas" data-tour="canvas">
            <ReactFlowProvider>
              <Canvas flow={flow} live={live} selectedId={selectedId} onSelect={(id) => setSelectedId(id)} onConnect={onConnect}
                onDeleteSteps={onDeleteSteps} onDeleteEdges={onDeleteEdges} onMove={onMove} />
            </ReactFlowProvider>
            {!flow.steps.length && (
              <div className="empty">
                <div>Agrega steps desde la barra superior y conéctalos arrastrando del borde derecho de un step al izquierdo de otro.</div>
                {leftovers && (leftovers.description || leftovers.vars || leftovers.memory || leftovers.chats || leftovers.runs || leftovers.schedule) ? (
                  <div className="leftovers">
                    <div>El flujo no tiene steps, pero todavía conserva:{' '}
                      {[leftovers.description && 'descripción', leftovers.vars && `${leftovers.vars} variable${leftovers.vars > 1 ? 's' : ''}`, leftovers.memory && `${leftovers.memory} recuerdo${leftovers.memory > 1 ? 's' : ''}`, leftovers.chats && 'historial de chat', leftovers.runs && `${leftovers.runs} ejecucion${leftovers.runs > 1 ? 'es' : ''}`, leftovers.schedule && 'programación activa'].filter(Boolean).join(' · ')}
                    </div>
                    <div className="row center">
                      <button className="danger" onClick={() => resetFlow(['description', 'vars', 'memory', 'chats', 'runs', 'schedule'], false)}>Limpiar todo</button>
                      <button className="ghost" onClick={() => { setSelectedId(null); setFlowTab('settings'); }}>Revisar en “Flujo”</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            <div className="hint-bar small muted">Arrastra entre puntos para relacionar · Supr borra lo seleccionado · Click en el fondo = chat general</div>
          </section>
          <aside className="side" data-tour="side">
            {step ? (
              <StepPanel key={step.id} flow={flow} step={step} catalog={catalog} live={live[step.id]} tab={stepTab} setTab={setStepTab}
                onChange={(p) => patchStep(step.id, p)} onDelete={() => onDeleteSteps([step.id])} onRun={(inp) => runStep(step.id, inp)} onProbe={probe}
                onOpenStep={(id) => { setSelectedId(id); setStepTab('chat'); }} />
            ) : (
              <FlowPanel key={`${flow.id}:${resetNonce}`} onReset={resetFlow} flow={flow} tab={flowTab} setTab={setFlowTab} onChange={(p) => mutate((f) => ({ ...f, ...p }))}
                onOpenStep={(id) => { setSelectedId(id); setStepTab('chat'); }} />
            )}
          </aside>
        </main>
      ) : (
        <div className="welcome">
          <h2>Crea tu primer flujo</h2>
          <p className="muted">Cada step es un rol, agente, skill o comando. Corre con tu Claude Code (tu suscripción, skills y MCPs).</p>
          <div className="row"><button className="primary" onClick={() => setModal('ai')}>✨ Describirlo y que la IA lo arme</button><button onClick={() => createFlow('demo')}>Flujo demo QA</button><button className="ghost" onClick={() => createFlow()}>+ Flujo vacío</button></div>
          <p className="muted small">¿Primera vez? <a onClick={() => setTourStep(0)}>Haz el recorrido guiado</a> o abre <a onClick={() => setModal({ help: 'start' })}>Ayuda</a>.</p>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {modal === 'picker' && <StepPicker catalog={catalog} onPick={addStep} onClose={() => setModal(null)} />}
      {modal === 'ai' && <AiFlowModal cwd={flow?.cwd} onClose={() => setModal(null)} onCreated={async (f) => { setModal(null); await loadFlows(); openFlow(f.id); notify(`Flujo “${f.name}” creado: revisa cada step y ejecútalo`); }} />}
      {modal?.help && <HelpModal section={modal.help} setSection={(k) => setModal({ help: k })} onClose={() => setModal(null)} flow={flow} flows={flows} onTour={() => { setModal(null); setTourStep(0); }} />}
      {tourStep !== null && <Tour step={tourStep} setStep={setTourStep} onClose={endTour} />}
    </div>
  );
}
