// Breaks (spec 18): a paused run waits here for a decision on each paused step.
import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './Help.jsx';

const show = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function PauseCard({ flowId, runId, p, onDone }) {
  const [mode, setMode] = useState(null); // 'edit' | 'retry'
  const [text, setText] = useState(p.output || '');
  const [json, setJson] = useState(p.json === undefined ? '' : JSON.stringify(p.json, null, 2));
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function act(action, extra = {}) {
    setBusy(true); setErr('');
    try { await api.post(`/api/flows/${flowId}/runs/${runId}/resume`, { step: p.stepId, action, ...extra }); onDone(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  function saveEdit() {
    let parsed;
    if (json.trim()) { try { parsed = JSON.parse(json); } catch (e) { setErr(`JSON inválido: ${e.message}`); return; } }
    // Only send what changed: an untouched (possibly clipped) output must never replace the real one.
    const outChanged = text !== (p.output || '');
    if (outChanged && p.outputClipped) { setErr('La salida es muy larga y aquí se ve recortada: no se puede editar el texto completo. Edita solo el JSON o usa “Re-ejecutar con corrección”.'); return; }
    const jsonChanged = json.trim() !== (p.json === undefined ? '' : JSON.stringify(p.json, null, 2)).trim();
    if (!outChanged && !jsonChanged) { act('continue'); return; }
    act('edit', { ...(outChanged ? { output: text } : {}), ...(jsonChanged && json.trim() ? { json: parsed } : {}) });
  }
  return (
    <div className="pause-card">
      <h4>⏸ “{p.step}” — {p.when === 'before' ? 'antes de ejecutarse' : `después de ejecutarse${p.round ? ` (intento ${p.round + 1})` : ''}`}</h4>
      {p.when === 'before' ? (
        <>
          <div className="muted small">Lo que va a recibir:</div>
          {p.input && <><b className="small">Input del flujo</b><pre className="review-out mono small">{p.input}</pre></>}
          {(p.inputs || []).map((i) => <div key={i.step}><b className="small">{i.step}{i.via ? ` → ${i.via}` : ''}</b><pre className="review-out mono small">{i.output || show(i.json) || '(sin salida)'}</pre></div>)}
          {!p.inputs?.length && !p.input && <div className="muted small">(no recibe datos de otros steps)</div>}
        </>
      ) : mode === 'edit' ? (
        <>
          <div className="muted small">Corrige la salida: los steps siguientes recibirán esta versión.</div>
          <textarea rows={8} className="mono" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="muted small">JSON (opcional)</div>
          <textarea rows={6} className="mono" value={json} onChange={(e) => setJson(e.target.value)} placeholder="{ }" />
        </>
      ) : mode === 'retry' ? (
        <>
          <div className="muted small">Qué hay que corregir: el step se vuelve a ejecutar con esta indicación y su salida anterior, y se pausa otra vez.</div>
          <textarea rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Ej: faltan los casos negativos; usa formato Gherkin" autoFocus />
        </>
      ) : (
        <>
          <div className="muted small">Salida a validar:</div>
          <pre className="review-out mono small">{p.output || '(sin texto)'}</pre>
          {p.json !== undefined && <><div className="muted small">JSON</div><pre className="review-out mono small">{show(p.json)}</pre></>}
          {p.routes?.length > 0 && <div className="muted small">Destinos elegidos: {p.routes.map((r) => r.to).join(', ')}</div>}
        </>
      )}
      {err && <div className="error-bar">{err}</div>}
      <div className="review-actions">
        {p.when === 'before' ? (
          <>
            <button className="danger" disabled={busy} onClick={() => act('stop')}>■ Detener ejecución</button>
            <button disabled={busy} onClick={() => act('skip')}>Omitir este step</button>
            <button className="primary" disabled={busy} onClick={() => act('continue')}>▶ Ejecutar y seguir</button>
          </>
        ) : mode === 'edit' ? (
          <><button className="ghost" onClick={() => setMode(null)}>Cancelar</button><button className="primary" disabled={busy} onClick={saveEdit}>Guardar y seguir</button></>
        ) : mode === 'retry' ? (
          <><button className="ghost" onClick={() => setMode(null)}>Cancelar</button><button className="primary" disabled={busy || !feedback.trim()} onClick={() => act('retry', { feedback })}>↻ Re-ejecutar con la corrección</button></>
        ) : (
          <>
            <button className="danger" disabled={busy} onClick={() => act('stop')}>■ Detener ejecución</button>
            <button disabled={busy} onClick={() => setMode('retry')}>↻ Re-ejecutar con corrección</button>
            <button disabled={busy} onClick={() => setMode('edit')}>✎ Editar salida</button>
            <button className="primary" disabled={busy} onClick={() => act('continue')}>✔ Aprobar y seguir</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ReviewModal({ flowId, runId, refresh, onClose }) {
  const [run, setRun] = useState(null);
  const load = () => api.get(`/api/flows/${flowId}/runs/${runId}`).then(setRun).catch(() => {});
  useEffect(() => { load(); }, [runId, refresh]);
  if (!run) return null;
  const pauses = run.pauses || [];
  return (
    <Modal title="Break: validar antes de seguir" onClose={onClose} wide>
      {!pauses.length ? <p className="muted">La ejecución ya no está en pausa ({run.status}).</p>
        : pauses.map((p) => <PauseCard key={`${p.stepId}:${p.at}`} flowId={flowId} runId={runId} p={p} onDone={() => { load(); }} />)}
      <p className="muted small">Mientras está en pausa no corre el tiempo máximo de la ejecución. Puedes cerrar esta ventana y volver con “Revisar”.</p>
    </Modal>
  );
}
