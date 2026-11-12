import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, onWs, onConn, pendingSave, TAB_ID } from './api.js';
import { mergeFlows } from './merge.js';
import Canvas, { autoLayout, wouldCycle } from './Canvas.jsx';
import { StepPanel, FlowPanel, EdgePanel } from './Panels.jsx';
import ReviewModal from './Review.jsx';
import { StepPicker, AiFlowModal, HelpMenu, HelpModal, Tour } from './Help.jsx';

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// Per-tab memory: each browser tab keeps its own open flow (also in the URL, so reload and links work).
const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
const urlFlow = () => { try { return new URLSearchParams(location.search).get('flow'); } catch { return null; } };
const rid = (p) => p + Math.random().toString(36).slice(2, 10);

function newStep(kind, name) {
  return {
    id: rid('s_'), name, kind, role: '', agentRef: '', skillRef: '', command: '', shell: 'powershell', task: '', context: '',
    model: '', effort: '', permissionMode: '', allowedTools: 'Read Grep Glob WebFetch WebSearch Skill', hooks: '',
    output: { format: 'text', schema: '' }, input: { mode: 'full', maxChars: 12000 },
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
  const [selectedId, setSelectedIdRaw] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const setSelectedId = (id) => { setSelectedIdRaw(id); if (id) setSelectedEdge(null); };
  const [paused, setPaused] = useState(null); // {runId, step, when} of a run waiting at a break (spec 18)
  const [reviewOpen, setReviewOpen] = useState(false);
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
  const version = useRef(0); // bumped on every local edit: a save only clears `dirty` if nothing changed meanwhile
  const baseRef = useRef(null); // last version of the open flow this tab got from the server (base of the 3-way merge)
  const saveTimer = useRef(null);
  const flowRef = useRef(null);
  flowRef.current = flow;

  const notify = (t) => { setToast(t); setTimeout(() => setToast(''), 4000); };
  const loadFlows = () => api.get('/api/flows').then(setFlows);
  const loadCatalog = (cwd) => api.get(`/api/catalog${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`).then((c) => { setCatalog(c); if (c.rateLimit) setRate(c.rateLimit); });

  useEffect(() => {
    // This tab's flow: URL (?flow=) → this tab's session → the last one used in any tab → the first.
    const wanted = [urlFlow(), ss.get('afs.flow'), ls.get('afs.flow')];
    api.get('/api/flows').then((list) => {
      setFlows(list);
      const id = wanted.map((w) => list.find((f) => f.id === w)?.id).find(Boolean) || list[0]?.id;
      if (id) openFlow(id);
    }).catch(() => {});
  }, []);
  useEffect(() => { loadCatalog(flow?.cwd); }, [flow?.id, flow?.cwd]);
  // Tab title = flow name, to tell tabs apart.
  useEffect(() => { document.title = flow ? `${flow.name} · Agent Flow Studio` : 'Agent Flow Studio'; }, [flow?.name]);
  // When the canvas is empty, show what is still attached to the flow (description, vars, chats, runs…).
  const noSteps = flow && flow.steps.length === 0;
  useEffect(() => {
    if (!noSteps) { setLeftovers(null); return; }
    const t = setTimeout(() => api.get(`/api/flows/${flow.id}/leftovers`).then(setLeftovers).catch(() => {}), 700);
    return () => clearTimeout(t);
  }, [flow?.id, noSteps, resetNonce]);

  // Server down -> banner; back online -> reload the list and the open flow.
  const [online, setOnlineState] = useState(true);
  const wasOffline = useRef(false);
  useEffect(() => onConn((v) => {
    setOnlineState(v);
    if (!v) { wasOffline.current = true; return; }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    loadFlows().catch(() => {});
    // Unsaved local edits win: save them instead of reloading the flow from the server.
    if (dirty.current) { flushSave().catch(() => {}); return; }
    const id = flowRef.current?.id || ss.get('afs.flow') || ls.get('afs.flow');
    if (id) openFlow(id);
  }), []);

  async function openFlow(id) {
    if (!id) return;
    // Save pending edits of the current flow first (the debounced save would otherwise write the NEW flow).
    try { await flushSave(); } catch (e) { if (!confirm(`No se pudieron guardar los últimos cambios (${e.message}). ¿Abrir el otro flujo igual? Se perderán.`)) return; clearTimeout(saveTimer.current); dirty.current = false; }
    let f;
    try { f = await api.get(`/api/flows/${id}`); } catch (e) { notify(`No se pudo abrir el flujo: ${e.message}`); return; }
    if (f.steps.length && f.steps.every((s) => !s.position?.x && !s.position?.y)) {
      const laid = { ...f, steps: autoLayout(f.steps, f.edges) };
      f = await api.put(`/api/flows/${f.id}`, { ...laid, baseRev: f.rev || 0 }).catch(() => laid);
    }
    baseRef.current = f;
    setFlow(f); setSelectedId(null); setSelectedEdge(null); setLive({}); setPaused(null); setReviewOpen(false);
    ls.set('afs.flow', id); ss.set('afs.flow', id);
    try { history.replaceState(null, '', `?flow=${encodeURIComponent(id)}`); } catch {}
    // A run of this flow may be waiting at a break (e.g. after reloading the page).
    api.get(`/api/flows/${id}/runs`).then((runs) => { const p = (runs || []).find((r) => r.status === 'paused'); if (p) setPaused({ runId: p.id }); }).catch(() => {});
  }

  // ---- persistence (debounced) ----
  /** Saves the open flow now. `dirty` is cleared only if no edit happened while the PUT was in flight; on error it stays dirty. */
  /** Another version of the open flow exists on the server (other tab, chat proposal, hook): merge it into this tab. */
  function adoptRemote(remote) {
    const local = flowRef.current;
    if (!local || local.id !== remote.id) return;
    const { merged, conflicts } = dirty.current ? mergeFlows(baseRef.current, local, remote) : { merged: { ...remote, steps: remote.steps.map((s) => ({ ...s, position: s.position })) }, conflicts: [] };
    baseRef.current = remote;
    flowRef.current = merged;
    setFlow(merged);
    if (conflicts.length) notify(`También se cambió en otra pestaña: ${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? '…' : ''}. Se mantuvo lo tuyo.`);
  }
  /**
   * Saves the open flow with the revision it is based on. If the server has a newer one (409), merge and retry.
   * `dirty` is cleared only if no edit happened while the PUT was in flight; on error it stays dirty.
   */
  async function saveNow() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const f = flowRef.current;
      if (!f) return;
      const v = version.current;
      try {
        const saved = await api.put(`/api/flows/${f.id}`, { ...f, baseRev: baseRef.current?.id === f.id ? baseRef.current.rev || 0 : f.rev || 0 });
        baseRef.current = saved;
        if (version.current === v) { dirty.current = false; setSaveState('guardado'); }
        loadFlows().catch(() => {});
        return;
      } catch (e) {
        if (e.status === 409 && e.body?.flow) { adoptRemote(e.body.flow); continue; }
        setSaveState('error'); notify(`No se guardó: ${e.message}`); throw e;
      }
    }
    setSaveState('error'); notify('No se pudo guardar: el flujo cambia sin parar en otra pestaña. Reintenta.');
  }
  const scheduleSave = useCallback(() => {
    dirty.current = true; version.current++; setSaveState('…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveNow().catch(() => {}); }, 500);
  }, []);

  const mutate = useCallback((fn, { layout = false } = {}) => {
    setFlow((cur) => {
      let next = fn(structuredClone(cur));
      if (layout && autoOrder) next = { ...next, steps: autoLayout(next.steps, next.edges) };
      flowRef.current = next; // a flush right after an edit must send this version
      return next;
    });
    scheduleSave();
  }, [scheduleSave, autoOrder]);

  // ---- websocket ----
  useEffect(() => onWs((m) => {
    const cur = flowRef.current;
    if (m.type === 'run.event' && m.event.kind === 'rate_limit') setRate(m.event.info);
    if (m.type === 'chat.event' && m.event.kind === 'rate_limit') setRate(m.event.info);
    if (m.type === 'flows.changed') { loadFlows().catch(() => {}); return; } // created / renamed / deleted in another tab
    if (!cur || m.flowId !== cur.id) return;
    switch (m.type) {
      case 'flow.updated': {
        const base = baseRef.current;
        // A new revision = the definition changed elsewhere (other tab, chat proposal, ctx.setVar, reset): merge it.
        if (base && base.id === m.flow.id && (m.flow.rev || 0) !== (base.rev || 0)) {
          if (m.by !== TAB_ID || dirty.current) adoptRemote(m.flow); else baseRef.current = m.flow;
          break;
        }
        // Same revision: only run state changed (lastRun, memory, pins, chat sessions).
        baseRef.current = m.flow;
        setFlow((c) => {
          if (!c || c.id !== m.flow.id) return c;
          const srv = new Map(m.flow.steps.map((s) => [s.id, s]));
          return {
            ...c, memory: m.flow.memory, globalSessionId: m.flow.globalSessionId,
            steps: c.steps.map((s) => { const p = srv.get(s.id); return p ? { ...s, memory: p.memory, lastRun: p.lastRun, pinned: p.pinned, chatSessionId: p.chatSessionId, chatContextHash: p.chatContextHash } : s; }),
          };
        });
        break;
      }
      case 'flow.deleted':
        notify('Este flujo se eliminó en otra pestaña.');
        clearTimeout(saveTimer.current); dirty.current = false;
        api.get('/api/flows').then((list) => { setFlows(list); if (list[0]) openFlow(list[0].id); else setFlow(null); }).catch(() => {});
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
        setPaused((p) => (p?.runId === m.runId ? null : p));
        break;
      case 'run.paused':
        setPaused((p) => ({ runId: m.runId, step: m.step, when: m.when, nonce: Date.now(), ...(p?.runId === m.runId ? {} : {}) }));
        setReviewOpen(true);
        notify(`⏸ Break en “${m.step}”: valida para seguir`);
        break;
      case 'run.resumed':
        // Other branches may still be paused: keep the bar only while something waits.
        api.get(`/api/flows/${m.flowId}/runs/${m.runId}`).then((r) => {
          if (r?.pauses?.length) setPaused((p) => (p?.runId === m.runId ? { ...p, step: r.pauses[0].step, nonce: Date.now() } : p));
          else { setPaused((p) => (p?.runId === m.runId ? null : p)); setReviewOpen(false); }
        }).catch(() => {});
        break;
      default:
    }
  }), []);

  // ---- actions ----
  async function createFlow(template) {
    const name = prompt('Nombre del flujo', template === 'demo' ? 'Demo QA: requerimiento → casos → revisión' : 'Nuevo flujo');
    if (!name) return;
    try {
      const f = await api.post('/api/flows', { name, template });
      await loadFlows();
      const laid = { ...f, steps: autoLayout(f.steps, f.edges) };
      await api.put(`/api/flows/${f.id}`, { ...laid, baseRev: f.rev || 0 });
      openFlow(f.id);
    } catch (e) { notify(e.message); }
  }
  async function deleteFlow() {
    if (!confirm(`¿Eliminar el flujo "${flow.name}" con sus chats y ejecuciones?`)) return;
    try {
      clearTimeout(saveTimer.current); dirty.current = false;
      await api.del(`/api/flows/${flow.id}`);
      const list = await api.get('/api/flows'); setFlows(list);
      if (list[0]) openFlow(list[0].id); else setFlow(null);
    } catch (e) { notify(e.message); }
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
  const onConnect = (source, target, sourceHandle, targetHandle) => {
    if (flow.edges.some((e) => e.source === source && e.target === target)) return notify('Esas cajas ya están unidas: selecciona la flecha para cambiar qué pasa o el lado.');
    if (wouldCycle(flow.edges, source, target)) return notify('Esa relación crearía un ciclo.');
    const sides = { ...(sourceHandle ? { sourceHandle } : {}), ...(targetHandle ? { targetHandle } : {}) };
    // Arrows drawn on a chosen side keep the manual layout; plain left→right ones re-order if "auto" is on.
    const manual = (sourceHandle && sourceHandle !== 'out-right') || (targetHandle && targetHandle !== 'in-left');
    mutate((f) => { f.edges.push({ id: rid('e_'), source, target, ...sides }); return f; }, { layout: !manual });
  };
  const onReconnect = (edgeId, c2) => {
    const others = flow.edges.filter((e) => e.id !== edgeId);
    if (others.some((e) => e.source === c2.source && e.target === c2.target)) return notify('Esas cajas ya están unidas.');
    if (wouldCycle(others, c2.source, c2.target)) return notify('Esa relación crearía un ciclo.');
    mutate((f) => { const e = f.edges.find((x) => x.id === edgeId); if (e) Object.assign(e, { source: c2.source, target: c2.target, sourceHandle: c2.sourceHandle || undefined, targetHandle: c2.targetHandle || undefined }); return f; });
  };
  const patchEdge = (id, patch) => mutate((f) => { const e = f.edges.find((x) => x.id === id); if (e) { Object.assign(e, patch); for (const k of Object.keys(patch)) if (patch[k] === undefined) delete e[k]; } return f; });
  function duplicateStep(id) {
    const src = flow.steps.find((s) => s.id === id);
    if (!src) return;
    const { lastRun, memory, pinned, chatSessionId, chatContextHash, ...rest } = structuredClone(src);
    const copy = { ...rest, id: rid('s_'), name: `${src.name} (copia)`, memory: [], lastRun: null, position: { x: src.position.x + 40, y: src.position.y + 130 } };
    mutate((f) => { f.steps.push(copy); return f; });
    setSelectedId(copy.id);
    notify('Caja duplicada: conéctala donde la necesites');
  }
  async function saveToLibrary(id) {
    const name = prompt('Nombre en “Mis steps”', flow.steps.find((s) => s.id === id)?.name || '');
    if (!name) return;
    try { await flushSave(); await api.post('/api/library', { flow: flow.id, step: id, name }); notify(`Guardado en “Mis steps”: ＋ Step para insertarlo en cualquier flujo`); } catch (e) { notify(e.message); }
  }
  const onDeleteStepsRaw = (ids) => { mutate((f) => { f.steps = f.steps.filter((s) => !ids.includes(s.id)); f.edges = f.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)); return f; }, { layout: true }); setSelectedId(null); };
  const onDeleteEdges = (ids) => mutate((f) => { f.edges = f.edges.filter((e) => !ids.includes(e.id)); return f; }, { layout: true });
  const onMove = (id, pos) => mutate((f) => { const s = f.steps.find((x) => x.id === id); if (s) s.position = pos; return f; });
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
  /** Steps whose task/context/command/hooks reference {{steps.<name>…}}. */
  const refsTo = (f, name, exceptId) => f.steps.filter((s) => s.id !== exceptId && ['task', 'context', 'command', 'hooks', 'role'].some((k) => new RegExp(`\\{\\{\\{?\\s*steps\\.${reEsc(name)}(\\.|\\s*\\})`).test(s[k] || '')));
  const patchStep = (id, patch) => mutate((f) => {
    const s = f.steps.find((x) => x.id === id);
    const old = s.name;
    Object.assign(s, patch);
    // Renaming a box rewrites the references to it in the other boxes ({{steps.Old…}} → {{steps.New…}}).
    if (patch.name !== undefined && old && patch.name && patch.name !== old) {
      const re = new RegExp(`(\\{\\{\\{?\\s*steps\\.)${reEsc(old)}(?=\\.|\\s*\\})`, 'g');
      for (const o of f.steps) if (o.id !== id) for (const k of ['task', 'context', 'command', 'hooks', 'role']) if (o[k]) o[k] = o[k].replace(re, (_m, pre) => pre + patch.name); // function: a "$" in the name is literal
    }
    return f;
  });
  const onDeleteSteps = (ids) => {
    const users = ids.flatMap((id) => { const s = flow.steps.find((x) => x.id === id); return s ? refsTo(flow, s.name, id).filter((u) => !ids.includes(u.id)).map((u) => `"${u.name}" usa {{steps.${s.name}…}}`) : []; });
    if (users.length && !confirm(`Otros steps usan datos del que vas a borrar:\n${users.join('\n')}\n\nEsas referencias quedarán sin resolver. ¿Borrar igual?`)) return;
    onDeleteStepsRaw(ids);
  };
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
    await saveNow();
  }
  pendingSave.flush = flushSave;
  async function resetFlow(parts, ask = true) {
    try { await flushSave(); } catch {}
    const labels = { steps: 'steps y relaciones', description: 'descripción', vars: 'variables', memory: 'memoria del flujo', chats: 'chats', runs: 'historial de ejecuciones', schedule: 'programación' };
    if (ask && !confirm(`Se va a borrar: ${parts.map((p) => labels[p]).join(', ')}.
Se conserva el nombre, el directorio de trabajo y la URL/token de invocación.

¿Continuar?`)) return;
    try {
      clearTimeout(saveTimer.current); dirty.current = false;
      const f = await api.post(`/api/flows/${flow.id}/reset`, { parts });
      baseRef.current = f; setFlow(f); setSelectedId(null); setLive({}); setResetNonce((n) => n + 1); loadFlows();
      notify('Flujo limpio');
    } catch (e) { notify(e.message); }
  }
  async function probe() {
    notify('Detectando tools y MCPs de tu Claude Code…');
    try { await api.post('/api/catalog/probe', { cwd: flow?.cwd }); await loadCatalog(flow?.cwd); notify('Catálogo actualizado'); } catch (e) { notify(`No se pudo detectar: ${e.message}`); }
  }

  const step = flow?.steps.find((s) => s.id === selectedId);
  const anyRunning = Object.values(live).some((l) => ['running', 'paused', 'queued'].includes(l.status)) || !!paused;
  const edgeObj = flow?.edges.find((e) => e.id === selectedEdge);
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
        {flow && <button className="ghost" onClick={() => window.open(`?flow=${encodeURIComponent(flow.id)}`, '_blank')} title="Abrir este flujo en otra pestaña (cada pestaña puede tener su flujo; si dos editan el mismo, los cambios se combinan)">⧉</button>}
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
              <Canvas flow={flow} live={live} selectedId={selectedId} onSelect={(id) => setSelectedId(id)} onConnect={onConnect} onReconnect={onReconnect}
                selectedEdge={selectedEdge} onSelectEdge={setSelectedEdge}
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
            {edgeObj ? (
              <EdgePanel key={edgeObj.id} flow={flow} edge={edgeObj} onChange={(p) => patchEdge(edgeObj.id, p)} onDelete={() => { onDeleteEdges([edgeObj.id]); setSelectedEdge(null); }} onClose={() => setSelectedEdge(null)} />
            ) : step ? (
              <StepPanel key={step.id} onDuplicate={() => duplicateStep(step.id)} onSaveLib={() => saveToLibrary(step.id)} flow={flow} step={step} catalog={catalog} live={live[step.id]} tab={stepTab} setTab={setStepTab}
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
      {paused && flow && <div className="review-bar">⏸ Ejecución en pausa{paused.step ? ` en “${paused.step}”` : ''}: valida la salida para seguir <button className="primary small" onClick={() => setReviewOpen(true)}>Revisar</button></div>}
      {paused && reviewOpen && flow && <ReviewModal key={paused.runId} refresh={paused.nonce || 0} flowId={flow.id} runId={paused.runId} onClose={() => setReviewOpen(false)} />}
      {!online && <div className="offline-bar">⚠️ El servidor de Agent Flow Studio no responde. Arráncalo con <code>npm start</code> en la carpeta del proyecto (o con cualquier comando <code>afs</code>); esta página se reconecta sola.</div>}
      {toast && <div className="toast">{toast}</div>}
      {modal === 'picker' && <StepPicker catalog={catalog} onPick={addStep} onClose={() => setModal(null)} />}
      {modal === 'ai' && <AiFlowModal cwd={flow?.cwd} onClose={() => setModal(null)} onCreated={async (f) => { setModal(null); await loadFlows(); openFlow(f.id); notify(`Flujo “${f.name}” creado: revisa cada step y ejecútalo`); }} />}
      {modal?.help && <HelpModal section={modal.help} setSection={(k) => setModal({ help: k })} onClose={() => setModal(null)} flow={flow} flows={flows} onTour={() => { setModal(null); setTourStep(0); }} />}
      {tourStep !== null && <Tour step={tourStep} setStep={setTourStep} onClose={endTour} />}
    </div>
  );
}
