// Export / import of flows (spec 09) and the review banner of imported flows (quarantine).
import React, { useState } from 'react';
import { api, pendingSave } from './api.js';
import { Modal } from './Help.jsx';

/** Download the flow as <name>.afsflow.json with the chosen options. */
export function ExportModal({ flow, onClose }) {
  const [o, setO] = useState({ memory: true, chats: false, runs: false, pins: false, secrets: false, skills: 'embed' });
  const [err, setErr] = useState('');
  const hasSecretVars = Object.keys(flow.vars || {}).some((k) => /(token|secret|password|passwd|pwd|apikey|api_key|credential|private|auth)/i.test(k));
  async function download() {
    setErr('');
    try {
      await pendingSave.flush();
      const q = new URLSearchParams({ memory: o.memory ? '1' : '0', chats: o.chats ? '1' : '0', runs: o.runs ? '1' : '0', pins: o.pins ? '1' : '0', secrets: o.secrets ? '1' : '0', skills: o.skills === 'none' ? '0' : o.skills });
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
        <label className="small" data-testid="export-skills">Skills de este flujo:{' '}
          <select value={o.skills} onChange={(e) => setO({ ...o, skills: e.target.value })}>
            <option value="embed">incluir sus archivos (hasta 5 MB cada una)</option>
            <option value="ref">solo la URL de origen (quien importa la trae y la revisa)</option>
            <option value="none">no incluir</option>
          </select>
        </label>
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
    try { const f = await api.post(`/api/flows/${flow.id}/trust`, { baseRev: flow.rev || 0 }); onTrusted?.(f); } catch (e) { alert(e.message); }
    setBusy(false);
  }
  return (
    <div className="quarantine-bar" data-testid="quarantine">
      <div>🔒 <b>{q.from?.linked ? 'Flujo vinculado en revisión' : 'Flujo importado en revisión'}:</b> contiene {q.reasons.length} cosa{q.reasons.length > 1 ? 's' : ''} que se ejecutaría{q.reasons.length > 1 ? 'n' : ''} en esta máquina. No se puede ejecutar ni chatear hasta que lo revises. <button className="ghost small" onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Ver qué'}</button> <button className="primary small" disabled={busy} onClick={trust}>Revisé este flujo, habilitar</button></div>
      {open && <ul className="small">{q.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

/**
 * Spec 09 WS-8/9: where the flow lives. Link a folder with a flow.json (e.g. in a git repo), move this flow to a folder,
 * unlink it (the folder's files stay), write its README.md there.
 */
export function FlowFolderModal({ flow, flows, onClose, onChanged, notify }) {
  const linked = flows.find((f) => f.id === flow?.id)?.origin === 'linked';
  const where = flows.find((f) => f.id === flow?.id)?.path;
  const [p, setP] = useState('');
  const [asCopy, setAsCopy] = useState(false);
  const [keep, setKeep] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const run = async (fn) => { setErr(''); setMsg(''); try { await pendingSave.flush(); await fn(); } catch (e) { setErr(e.message); if (e.code === 'LINK_ID_TAKEN' || /ya está en la app/.test(e.message)) setAsCopy(true); } };
  const link = () => run(async () => { const r = await api.post('/api/flows/link', { path: p.trim(), asCopy }); await onChanged?.(r.flow.id); setMsg(`Vinculado: “${r.flow.name}”${r.quarantine ? ' — en revisión: revisa lo que ejecuta antes de habilitarlo' : ''}`); });
  const move = () => run(async () => { const r = await api.post(`/api/flows/${flow.id}/move-to`, { path: p.trim() }); await onChanged?.(flow.id); setMsg(`Ahora vive en ${r.path}`); });
  const unlink = () => run(async () => { if (!confirm(keep ? 'Se desvincula y queda una copia en la app. Los archivos de la carpeta no se tocan. ¿Seguir?' : 'Se desvincula: el flujo sale de la app (su historial queda guardado por si lo vuelves a vincular). Los archivos de la carpeta no se tocan. ¿Seguir?')) return; await api.del(`/api/flows/link/${flow.id}${keep ? '?keepLocalCopy=1' : ''}`); await onChanged?.(keep ? flow.id : null); onClose(); });
  const reveal = () => run(async () => { const r = await api.post(`/api/flows/${flow.id}/reveal`, {}); setMsg(r.opened ? `Abierta: ${r.path}` : `Carpeta: ${r.path}`); notify?.(`Carpeta: ${r.path}`); });
  const readme = () => run(async () => { const r = await api.post(`/api/flows/${flow.id}/readme`, {}); setMsg(r.status === 'same' ? 'README.md ya estaba al día' : `Escrito ${r.path}`); });
  return (
    <Modal title="Carpeta del flujo" onClose={onClose}>
      {flow && <div className="row" style={{ marginBottom: 8 }}><button data-testid="reveal-btn" onClick={reveal} title="Abrir la carpeta en el Explorador">📂 Abrir carpeta</button></div>}
      {flow && <p className="small" data-testid="flow-location">{linked ? <>🔗 <b>Vinculado</b> desde <code>{where}</code>. Ahí vive solo su <code>flow.json</code>; el historial, los chats y las sesiones quedan en la app.</> : <>Este flujo vive en la carpeta de datos de la app.</>}</p>}
      <label className="small col">Carpeta (ruta completa, en esta PC)
        <input data-testid="link-path" value={p} onChange={(e) => setP(e.target.value)} placeholder="C:\repos\mi-proyecto\.agent-flows\release-check" />
      </label>
      <p className="muted small">Una carpeta vinculada se usa en su lugar (no se copia), por ejemplo dentro de un repo git. Si su flow.json cambia fuera de la app y toca lo que se ejecuta, el flujo queda en revisión hasta que lo revises.</p>
      <div className="row wrap">
        <button data-testid="link-btn" disabled={!p.trim()} onClick={link}>🔗 Vincular esa carpeta</button>
        <label className="toggle small"><input type="checkbox" checked={asCopy} onChange={(e) => setAsCopy(e.target.checked)} /> como copia (id nuevo)</label>
        {flow && !linked && <button data-testid="move-btn" className="ghost" disabled={!p.trim()} onClick={move} title="Escribe su flow.json en esa carpeta (vacía de flujos) y lo deja vinculado">⤴ Mover este flujo ahí</button>}
      </div>
      {flow && linked && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="ghost" data-testid="readme-btn" onClick={readme}>📝 Escribir README.md en la carpeta</button>
          <label className="toggle small"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> dejar una copia en la app</label>
          <button className="ghost danger" data-testid="unlink-btn" onClick={unlink}>Desvincular</button>
        </div>
      )}
      {msg && <div className="ok-bar small" data-testid="link-msg">{msg}</div>}
      {err && <div className="error-bar" data-testid="link-err">{err}</div>}
    </Modal>
  );
}
