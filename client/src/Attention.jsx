// 🔔 "Necesita atención" (spec 27): what waits for a person in ANY flow. NAVIGATION ONLY (D48): every button takes
// you to the place (break review, run, quarantine banner, Configuración); nothing here resumes, applies or trusts.
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const ICON = { break: '⏸', run_failed: '✗', quarantine: '⛔', blocked: '⛔' };
const ACTION = { review: 'Revisar ahora', run: 'Ver ejecución', quarantine: 'Revisar importación', preflight: 'Ver qué falta', settings: { cli: 'Revisar CLI', credentials: 'Abrir Credenciales' } };
export const actionLabel = (t) => (t.open === 'settings' ? ACTION.settings[t.tab] || 'Abrir Configuración' : ACTION[t.open] || 'Abrir');
const sevClass = (s) => (s === 'error' ? 'sev-err' : s === 'action' ? 'sev-warn' : 'sev-info');
export function age(ts, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return 'ahora';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
/** Worst severity among pending (not dismissed) items: 'err' | 'warn' | null. */
export const worst = (items) => (items.some((i) => !i.dismissed && i.severity === 'error') ? 'err' : items.some((i) => !i.dismissed) ? 'warn' : null);
/** Prefix for a flow in the native <select> (options cannot be styled). */
export function flowPrefix(items, flowId) {
  const mine = items.filter((i) => i.flowId === flowId && !i.dismissed);
  if (mine.some((i) => i.kind === 'break')) return '⏸ ';
  if (mine.some((i) => i.kind === 'run_failed')) return '✗ ';
  if (mine.length) return '⛔ ';
  return '';
}

export function AttentionButton({ items, onClick }) {
  const n = items.filter((i) => !i.dismissed).length;
  const w = worst(items);
  return (
    <button className="ghost icon-btn att-btn" onClick={onClick} aria-label={n ? `Necesita atención: ${n} pendiente${n > 1 ? 's' : ''}` : 'Necesita atención: nada pendiente'} title="Necesita atención (Ctrl+Shift+A)" data-testid="attention-btn">
      🔔{n > 0 && <span className={`att-count ${w === 'err' ? 'err' : ''}`} data-testid="attention-count">{n}</span>}
    </button>
  );
}

function Item({ it, onGo, onDismiss, now }) {
  return (
    <li className={`att-item ${sevClass(it.severity)} ${it.dismissed ? 'seen' : ''}`} data-testid={`att-${it.kind}`}>
      <div className="att-head"><b>{ICON[it.kind]} {it.title}</b><span className="att-age" title={new Date(it.createdAt).toLocaleString()}>{age(it.createdAt, now)}</span></div>
      <div className="muted small">{it.flowName}{it.stepName ? ` · step ${it.stepName}` : ''}{it.trigger && it.trigger !== 'manual' ? ` · ${it.trigger === 'schedule' ? 'programada' : it.trigger}` : ''}</div>
      <div className="small">{it.detail}</div>
      {it.code && <div className="mono muted small">{it.code}</div>}
      <div className="att-acts">
        <button className="primary small" onClick={() => onGo(it)}>{actionLabel(it.target)}</button>
        {!it.dismissed && <button className="ghost small" onClick={() => onDismiss(it)}>Marcar visto</button>}
      </div>
    </li>
  );
}

export function AttentionDrawer({ items, onClose, onGo }) {
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const ref = useRef(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    ref.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, []);
  async function dismiss(it) { setErr(''); try { await api.post('/api/attention/dismiss', { id: it.id, stateKey: it.stateKey }); } catch (e) { setErr(e.message); } }
  const pending = items.filter((i) => !i.dismissed);
  const seen = items.filter((i) => i.dismissed);
  return (
    <aside className="drawer" role="dialog" aria-labelledby="att-title" ref={ref} data-testid="attention-drawer">
      <div className="drawer-head">
        <b id="att-title">Necesita atención ({pending.length})</b>
        <button className="ghost small" onClick={onClose} aria-label="Cerrar">✕</button>
      </div>
      <p className="muted small pad-x">Lo más grave y lo más antiguo primero. Desde aquí solo navegas: nada se aplica solo.</p>
      {err && <div className="error-bar">{err}</div>}
      {!pending.length && <p className="muted att-empty">✓ Nada pendiente. Te avisamos aquí cuando un flujo se pause, falle o necesite algo.</p>}
      <ul className="att-list">{pending.map((it) => <Item key={it.id} it={it} now={now} onGo={onGo} onDismiss={dismiss} />)}</ul>
      {seen.length > 0 && (
        <details className="pad-x small">
          <summary>Vistos ({seen.length})</summary>
          <ul className="att-list">{seen.map((it) => <Item key={it.id} it={it} now={now} onGo={onGo} onDismiss={dismiss} />)}</ul>
        </details>
      )}
    </aside>
  );
}

/** Toasts for NEW items (bottom right). Errors stay until closed; the rest leave after 8 s (paused on hover/focus). */
export function AttentionToasts({ toasts, onGo, onClose }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite" data-testid="attention-toasts">
      {toasts.slice(0, 3).map((t) => <Toast key={t.key} t={t} onGo={onGo} onClose={onClose} />)}
    </div>
  );
}
function Toast({ t, onGo, onClose }) {
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (t.item.severity === 'error' || hold) return undefined;
    const h = setTimeout(() => onClose(t.key), 8000);
    return () => clearTimeout(h);
  }, [hold]);
  const it = t.item;
  return (
    <div className={`att-item ${sevClass(it.severity)}`} onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={() => setHold(false)} data-testid="attention-toast">
      <div className="att-head"><b>{ICON[it.kind]} {it.title}</b><button className="ghost small" aria-label="Cerrar aviso" onClick={() => onClose(t.key)}>✕</button></div>
      <div className="muted small">{it.flowName}{it.stepName ? ` · ${it.stepName}` : ''}</div>
      <div className="att-acts"><button className="primary small" onClick={() => { onGo(it); onClose(t.key); }}>Abrir</button></div>
    </div>
  );
}
