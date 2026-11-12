// Export / import of flows (spec 09) and the review banner of imported flows (quarantine).
import React, { useState } from 'react';
import { api, pendingSave } from './api.js';
import { Modal } from './Help.jsx';

/** Download the flow as <name>.afsflow.json with the chosen options. */
export function ExportModal({ flow, onClose }) {
  const [o, setO] = useState({ memory: true, chats: false, runs: false, pins: false, secrets: false });
  const [err, setErr] = useState('');
  const hasSecretVars = Object.keys(flow.vars || {}).some((k) => /(token|secret|password|passwd|pwd|apikey|api_key|credential|private|auth)/i.test(k));
  async function download() {
    setErr('');
    try {
      await pendingSave.flush();
      const q = new URLSearchParams({ memory: o.memory ? '1' : '0', chats: o.chats ? '1' : '0', runs: o.runs ? '1' : '0', pins: o.pins ? '1' : '0', secrets: o.secrets ? '1' : '0' });
      const r = await fetch(`/api/flows/${flow.id}/export?${q}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'flujo.afsflow.json';
      const blob = new Blob([JSON.stringify(await r.json(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      onClose();
    } catch (e) { setErr(e.message); }
  }
  const box = (k, label, hint) => <label className="toggle" title={hint}><input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.checked })} /> {label}{hint && <span className="muted small"> — {hint}</span>}</label>;
  return (
    <Modal title={`Exportar “${flow.name}”`} onClose={onClose}>
      <p className="muted small">Se descarga un archivo <code>.afsflow.json</code> con los steps, flechas, variables, contexto, requisitos y “Al terminar”. Nunca incluye sesiones de Claude, ejecuciones en curso, tu token ni la clave de la interfaz. La programación se exporta desactivada. Quien lo importe verá los requisitos y, si trae comandos o acceso a terminal, lo tendrá que revisar antes de ejecutarlo.</p>
      <div className="col">
        {box('memory', 'Incluir memoria', 'hechos aprendidos por los steps')}
        {box('chats', 'Incluir chats')}
        {box('runs', 'Incluir historial de ejecuciones', 'las últimas 50')}
        {box('pins', 'Incluir salidas fijadas', 'pueden contener datos reales')}
        {hasSecretVars && box('secrets', '⚠ Incluir valores de variables que parecen secretos', 'por defecto se exportan vacías')}
      </div>
      {err && <div className="error-bar">{err}</div>}
      <div className="review-actions"><button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" onClick={download}>⬇ Descargar</button></div>
    </Modal>
  );
}

/** Reads a .afsflow.json file and imports it. Returns {flow, quarantine, warnings}. */
export async function importFile(file) {
  const text = await file.text();
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error(`${file.name} no es un JSON válido`); }
  return api.post('/api/flows/import', { bundle });
}

/** Banner for an imported flow under review: what would execute here, and the button to enable it. */
export function QuarantineBanner({ flow, onTrusted }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!flow?.quarantine) return null;
  const q = flow.quarantine;
  async function trust() {
    if (!confirm('¿Revisaste los comandos, hooks y accesos de este flujo? Al habilitarlo se podrán ejecutar en esta máquina.')) return;
    setBusy(true);
    try { const f = await api.post(`/api/flows/${flow.id}/trust`, {}); onTrusted?.(f); } catch (e) { alert(e.message); }
    setBusy(false);
  }
  return (
    <div className="quarantine-bar" data-testid="quarantine">
      <div>🔒 <b>Flujo importado en revisión:</b> contiene {q.reasons.length} cosa{q.reasons.length > 1 ? 's' : ''} que se ejecutaría{q.reasons.length > 1 ? 'n' : ''} en esta máquina. No se puede ejecutar ni chatear hasta que lo revises. <button className="ghost small" onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Ver qué'}</button> <button className="primary small" disabled={busy} onClick={trust}>Revisé este flujo, habilitar</button></div>
      {open && <ul className="small">{q.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}
