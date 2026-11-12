// Requirements of a flow (spec 23): what must be installed/available to run it, checked automatically and explained
// to whoever uses the flow. The editor lives in Flujo; the modal appears when a run is blocked or from the header chip.
import React, { useEffect, useState } from 'react';
import { api, pendingSave } from './api.js';
import { Modal } from './Help.jsx';

const TYPES = [
  { type: 'tool', icon: '🧰', label: 'Herramienta', fields: [['name', 'Nombre (docker, git, python, kubectl, argo…)'], ['check', 'Comando de comprobación (opcional, p. ej. docker info)']] },
  { type: 'file', icon: '📄', label: 'Archivo', fields: [['path', 'Ruta (admite {{vars.x}}, %USERPROFILE%, ~)']], template: true },
  { type: 'env', icon: '🔑', label: 'Variable de entorno', fields: [['name', 'Nombre de la variable']] },
  { type: 'url', icon: '🌐', label: 'Servicio / red', fields: [['url', 'URL que debe responder (p. ej. el ambiente de QA, requiere VPN)']] },
  { type: 'mcp', icon: '🔌', label: 'Conector MCP', fields: [['server', 'Nombre del conector (p. ej. Atlassian)']] },
];
const T = Object.fromEntries(TYPES.map((t) => [t.type, t]));
const rid = () => `rq_${Math.random().toString(36).slice(2, 9)}`;
const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '?');

/** One row of check results (shared by the editor and the modal). */
function ResultRow({ r, flowId, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function create() {
    setBusy(true);
    try { const x = await api.post(`/api/flows/${flowId}/requirements/${r.id}/create-file`, {}); setMsg(`Creado: ${x.path}. Ábrelo y completa los valores.`); onCreated?.(); } catch (e) { setMsg(e.message); }
    setBusy(false);
  }
  return (
    <li className={`req-result ${r.ok === true ? 'ok' : r.ok === false ? (r.optional ? 'warn' : 'bad') : 'unknown'}`}>
      <div><b>{mark(r.ok)} {T[r.type]?.icon} {r.label}</b>{r.optional && <span className="muted small"> (recomendado)</span>} <span className="muted small">— {r.detail}</span></div>
      {r.ok !== true && <div className="small req-help">{r.help}</div>}
      {r.canCreate && <button className="small" disabled={busy} onClick={create}>📄 Crear desde plantilla</button>}
      {msg && <div className="small muted">{msg}</div>}
    </li>
  );
}

/** "Antes de ejecutar este flujo": what is missing and how to fix it. */
export function PreflightModal({ flow, onClose, onReady }) {
  const [pf, setPf] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = async (probe = false) => { setBusy(true); try { const r = await api.get(`/api/flows/${flow.id}/preflight?fresh=1${probe ? '&probe=1' : ''}`); setPf(r); } catch {} setBusy(false); };
  useEffect(() => { check(); }, [flow.id]);
  return (
    <Modal title="Antes de ejecutar este flujo" onClose={onClose} wide>
      <p className="muted small">Este flujo necesita algunas cosas en esta máquina. Lo marcado con ✗ es obligatorio; lo recomendado no bloquea.</p>
      {!pf ? <div className="muted">Comprobando…</div> : <ul className="req-results">{pf.results.map((r) => <ResultRow key={r.id} r={r} flowId={flow.id} onCreated={() => check()} />)}</ul>}
      <div className="review-actions">
        <button disabled={busy} onClick={() => check(true)}>{busy ? 'Comprobando…' : '↻ Comprobar de nuevo'}</button>
        {pf?.ok && <button className="primary" onClick={() => { onClose(); onReady?.(); }}>✔ Todo listo</button>}
      </div>
    </Modal>
  );
}

/** Editor in Flujo → "Requisitos para usar este flujo". */
export default function RequirementsEditor({ flow, onChange }) {
  const list = Array.isArray(flow.requirements) ? flow.requirements : [];
  const [pf, setPf] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState(null);
  const set = (id, patch) => onChange(list.map((r) => { if (r.id !== id) return r; const n = { ...r, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete n[k]; return n; }));
  const check = async (probe = false) => { setBusy(true); try { await pendingSave.flush(); setPf(await api.get(`/api/flows/${flow.id}/preflight?fresh=1${probe ? '&probe=1' : ''}`)); } catch (e) { setPf({ error: e.message }); } setBusy(false); };
  const suggest = async () => { try { await pendingSave.flush(); const s = await api.get(`/api/flows/${flow.id}/requirements/suggest`); setSugg(s); } catch (e) { setSugg([]); } };
  useEffect(() => { if (list.length) { const t = setTimeout(() => check(), 700); return () => clearTimeout(t); } setPf(null); }, [JSON.stringify(list), JSON.stringify(flow.vars)]);
  const byId = Object.fromEntries((pf?.results || []).map((r) => [r.id, r]));
  return (
    <div className="requirements">
      <p className="muted small">Qué necesita tener instalado o disponible quien ejecute este flujo (Docker, git, un archivo de secretos, la VPN, un conector…). Se comprueba antes de cada ejecución: si falta algo obligatorio, el flujo no arranca y la persona ve qué le falta y cómo resolverlo.</p>
      {list.length > 0 && (
        <ul className="req-list">
          {list.map((r) => {
            const t = T[r.type]; const res = byId[r.id];
            return (
              <li key={r.id} className="req-item" data-type={r.type}>
                <div className="row">
                  <span title={t.label}>{t.icon}</span>
                  <input className="src-label" value={r.label || ''} onChange={(e) => set(r.id, { label: e.target.value || undefined })} placeholder={`Nombre visible (opcional): ${t.label.toLowerCase()}`} />
                  <label className="toggle small" title="Recomendado: avisa pero no bloquea la ejecución"><input type="checkbox" checked={!!r.optional} onChange={(e) => set(r.id, { optional: e.target.checked || undefined })} /> solo recomendado</label>
                  <button className="ghost small danger" onClick={() => onChange(list.filter((x) => x.id !== r.id))} title="Quitar">✕</button>
                </div>
                {t.fields.map(([k, ph]) => <input key={k} className="mono" value={r[k] || ''} onChange={(e) => set(r.id, { [k]: e.target.value })} placeholder={ph} />)}
                {t.template && <textarea className="mono small" rows={3} value={r.template || ''} onChange={(e) => set(r.id, { template: e.target.value || undefined })} placeholder={'Plantilla (opcional) para "Crear desde plantilla": nombres de las claves sin valores, p. ej.\nAPI_USER=\nAPI_PASSWORD='} />}
                <textarea className="small" rows={2} value={r.help || ''} onChange={(e) => set(r.id, { help: e.target.value || undefined })} placeholder="Cómo conseguirlo (opcional; si lo dejas vacío se usa una ayuda por defecto)" />
                {res && <div className={`small ${res.ok === true ? 'ok-text' : 'warn-text'}`}>{mark(res.ok)} {res.detail}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row wrap src-add">
        {TYPES.map((t) => <button key={t.type} className="small" onClick={() => onChange([...list, { id: rid(), type: t.type }])}>+ {t.icon} {t.label}</button>)}
        <button className="small" onClick={suggest} title="Detecta lo que usa el flujo: herramientas en comandos, Jira/Confluence, archivos en variables">✨ Sugerir</button>
        {list.length > 0 && <button className="small" disabled={busy} onClick={() => check(true)}>{busy ? 'Comprobando…' : '↻ Comprobar'}</button>}
      </div>
      {sugg && (
        <div className="req-sugg">
          {!sugg.length ? <div className="muted small">No hay nada nuevo que sugerir.</div> : (
            <>
              <div className="small">Sugeridos a partir de lo que usa el flujo:</div>
              <ul className="small">{sugg.map((s, i) => <li key={i}>{T[s.type]?.icon} {s.label || s.name || s.path || s.url || s.server}{s.check ? <span className="muted"> (comprueba: {s.check})</span> : null}</li>)}</ul>
              <div className="row"><button className="small primary" onClick={() => { onChange([...list, ...sugg.map((s) => ({ id: rid(), ...s }))]); setSugg(null); }}>Agregar todos</button><button className="small ghost" onClick={() => setSugg(null)}>Descartar</button></div>
            </>
          )}
        </div>
      )}
      {pf?.error && <div className="warn-text small">{pf.error}</div>}
    </div>
  );
}
