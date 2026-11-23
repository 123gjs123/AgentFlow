// D59 — 🎫 Tickets and 🧾 Registro of the open flow, and «Lo que levantó este paso» in the step panel.
// What a step raises (<raise>{json}</raise>) has a class and a state; only a «Duda del ticket» in state "open" goes to
// the ticket (through «Al terminar»). Here the person promotes, dismisses or reopens; everything else is read-only.
import React, { useEffect, useRef, useState } from 'react';
import { api, onWs } from './api.js';
import { age } from './Attention.jsx';

export const KIND = { question: 'Duda del ticket', blocker: 'Problema del flujo', check: 'Control de cierre', action: 'Acción pendiente', lesson: 'Aprendizaje' };
export const KIND_ICON = { question: '❓', blocker: '⛔', check: '☑', action: '➜', lesson: '💡' };
const KIND_ORDER = ['question', 'blocker', 'check', 'action', 'lesson'];
export const STATE = { open: 'abierto', review: 'a revisar', answered: 'respondido', resolved: 'resuelto', dismissed: 'descartado' };
const STATE_CLS = { open: 'warn', review: 'warn', answered: 'ok', resolved: 'ok', dismissed: '' };
const RUN_STATUS = { success: 'bien', error: 'con error', stopped: 'detenida', timeout: 'sin tiempo', interrupted: 'interrumpida', running: 'corriendo', paused: 'en pausa', queued: 'en cola' };
const TYPES = [
  ['run', 'Ejecuciones'], ['finally', '«Al terminar»'], ['external', 'Escrituras afuera'], ['command', 'Comandos'], ['files', 'Archivos'],
  ['memory', 'Memoria'], ['version', 'Versiones'], ['change', 'Cambios'], ['item.raised', 'Levantado'], ['item.resolved', 'Resuelto'],
  ['item.reopened', 'Reabierto'], ['item.published', 'Publicado'], ['item.closed', 'Cierre avisado'], ['item.state', 'Cambio de estado'],
];
const when = (ts) => (ts ? new Date(ts).toLocaleString() : '');
const stateWord = (s) => STATE[s] || s;

/** Reloads when the open flow changes or a run of it finishes (debounced: flow.updated comes often during a run). */
function useFlowRefresh(flowId, reload) {
  const timer = useRef(null);
  const fn = useRef(reload); fn.current = reload;
  useEffect(() => onWs((m) => {
    if (m.flowId !== flowId || !['run.finished', 'flow.updated'].includes(m.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn.current(), m.type === 'run.finished' ? 300 : 1200);
  }), [flowId]);
  useEffect(() => () => clearTimeout(timer.current), []);
}

/** One journal entry in words. */
export function sentence(e) {
  const k = KIND[e.kind] ? KIND[e.kind].toLowerCase() : 'ítem';
  const t = e.text ? ` «${e.text}»` : '';
  switch (e.type) {
    case 'run': return e.what || `Ejecución: ${e.status || ''}`;
    case 'finally': return e.what || '«Al terminar»';
    case 'external': return `Escribió afuera: ${e.what || e.tool || ''}${e.ticket ? ` (${e.ticket})` : ''}`;
    case 'command': return `Ejecutó: ${e.what || ''}`;
    case 'files': return e.what || 'Escribió archivos';
    case 'memory': return `${e.what || 'Memoria agregada'}${e.detail ? `: ${e.detail}` : ''}`;
    case 'version': return e.what || 'Versión guardada';
    case 'change': return e.what || 'Cambio aplicado';
    case 'item.raised': return `Levantó ${k}:${t}`;
    case 'item.resolved': return `Se resolvió ${k}:${t}`;
    case 'item.reopened': return `Se reabrió ${k}:${t}`;
    case 'item.published': return `Se llevó al ticket ${k}:${t}${e.detail ? ` (ref ${e.detail})` : ''}`;
    case 'item.closed': return `Se avisó en el ticket que se cerró ${k}:${t}${e.detail ? ` (ref ${e.detail})` : ''}`;
    case 'item.state': {
      const m = /^(\w+) → (\w+)(?::\s*(.*))?$/s.exec(e.detail || '');
      return `${e.by === 'user' ? 'Cambiaste' : 'Cambió'} ${k}${t}${m ? `: ${stateWord(m[1])} → ${stateWord(m[2])}${m[3] ? ` (${m[3]})` : ''}` : ''}`;
    }
    default: return e.what || e.text || e.type;
  }
}
// detail that is not already in the sentence
const extraDetail = (e) => (['external', 'command', 'finally', 'item.resolved'].includes(e.type) ? e.detail : e.type === 'files' ? (e.files || []).join('\n') : '');

function JournalList({ entries, onOpenRun }) {
  if (!entries.length) return <p className="muted small" data-testid="journal-empty">Nada registrado todavía.</p>;
  return (
    <ul className="journal-list" data-testid="journal-list">
      {entries.map((e, i) => {
        const extra = extraDetail(e);
        return (
          <li key={`${e.at}:${i}`} className="journal-entry" data-testid="journal-entry" data-type={e.type}>
            <div className="je-line">
              <span className="muted small je-time" title={when(e.at)}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {e.ok === true && <span className="ok-text" title="salió bien">✓</span>}
              {e.ok === false && <span className="danger" title="falló">✗</span>}
              <span className="grow je-text">{sentence(e)}</span>
            </div>
            <div className="muted small je-meta">
              {when(e.at)}
              {e.step ? ` · ${e.step}` : ''}
              {(e.tickets?.length ? e.tickets : e.ticket ? [e.ticket] : []).map((k) => <span key={k} className="chip">{k}</span>)}
              {e.runId && (onOpenRun ? <> · <a onClick={() => onOpenRun(e.runId)} title="Abrir esta ejecución">{e.runId}</a></> : ` · ${e.runId}`)}
            </div>
            {extra ? <div className="muted small je-detail" title={extra}>{extra}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ItemCard({ it, busy, onState }) {
  const dismiss = () => { const r = window.prompt('¿Por qué lo descartás?', ''); if (r === null) return; onState(it, 'dismissed', r.trim() || 'descartado por el usuario'); };
  return (
    <li className={`tk-item st-${it.state}`} data-testid={`item-${it.id}`}>
      <div className="row">
        <span className={`chip ${STATE_CLS[it.state] || ''}`} data-testid="item-state">{stateWord(it.state)}</span>
        {it.kind === 'question' && it.for ? <span className="muted small">para {it.for}</span> : null}
        {it.published ? <span className="chip ok" data-testid="item-published">publicada{it.published.ref ? ` (${it.published.ref})` : ''}</span> : null}
        <span className="grow" />
        <span className="muted small" title={`Visto por primera vez: ${when(it.firstSeen)}`}>{it.step || ''}{it.lastSeen ? ` · ${age(it.lastSeen)}` : ''}</span>
      </div>
      <div className="tk-text">{it.text}</div>
      {it.quote ? <blockquote className="tk-quote small" data-testid="item-quote">{it.quote}</blockquote> : null}
      {it.blocks ? <div className="muted small">Bloquea: {it.blocks}</div> : null}
      {(it.notes || []).map((n, i) => <div key={i} className="muted small">ⓘ {n}</div>)}
      {it.reason ? <div className="small" data-testid="item-reason">Motivo: {it.reason}</div> : null}
      {it.notRaisedIn && ['open', 'review'].includes(it.state) ? <div className="muted small">La última ejecución ({it.notRaisedIn}) ya no lo levantó: decidí vos si sigue.</div> : null}
      <div className="row tk-acts">
        {it.state === 'review' && <button className="small primary" disabled={busy} data-testid="item-promote" onClick={() => onState(it, 'open', 'revisada: va al ticket')} title="Pasa a «abierto»: «Al terminar» la publica en el ticket">Llevar al ticket</button>}
        {['open', 'review'].includes(it.state) && <button className="small ghost" disabled={busy} data-testid="item-dismiss" onClick={dismiss}>Descartar</button>}
        {['resolved', 'dismissed'].includes(it.state) && <button className="small" disabled={busy} data-testid="item-reopen" onClick={() => onState(it, 'open', 'reabierto por el usuario')}>Reabrir</button>}
      </div>
    </li>
  );
}

const NONE = '__none__';
/** 🎫 Tickets: one row per work item key the flow touched; selecting one shows what was raised about it and its log. */
export function TicketsPanel({ flow, focusTicket, onOpenRun }) {
  const [tickets, setTickets] = useState(null);
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(focusTicket?.key || null);
  const [journal, setJournal] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const selRef = useRef(sel); selRef.current = sel;

  const loadJournal = async (key = selRef.current) => {
    if (!key || key === NONE) { setJournal(null); return; }
    try { setJournal(await api.get(`/api/flows/${flow.id}/journal?ticket=${encodeURIComponent(key)}&limit=200`)); } catch (e) { setErr(e.message); }
  };
  const load = async () => {
    try {
      const [t, it] = await Promise.all([api.get(`/api/flows/${flow.id}/tickets`), api.get(`/api/flows/${flow.id}/items`)]);
      setTickets(t); setItems(it); setErr('');
      await loadJournal();
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { setTickets(null); load(); }, [flow.id]);
  useEffect(() => { if (focusTicket?.n) { setSel(focusTicket.key || null); } }, [focusTicket?.n]);
  useEffect(() => { loadJournal(sel); }, [sel]);
  useFlowRefresh(flow.id, load);

  async function setState(it, state, reason) {
    setBusy(it.id); setErr('');
    try {
      const up = await api.post(`/api/flows/${flow.id}/items/${it.id}/state`, { state, reason });
      setItems((l) => l.map((x) => (x.id === up.id ? up : x)));
      await load();
    } catch (e) { setErr(e.message); }
    setBusy('');
  }

  const loose = items.filter((x) => !x.item);
  const mine = sel === NONE ? loose : items.filter((x) => x.item === sel);
  const q = (t) => t.questions || {};
  return (
    <div className="panel-body pad" data-testid="tickets-view">
      <p className="muted small">Cada ticket que tocó el flujo: lo que levantaron los pasos y lo que se hizo. Solo una <b>duda del ticket</b> en estado «abierto» sale al ticket (la publica «Al terminar»); lo demás se resuelve acá.</p>
      {err && <div className="error-bar">{err}</div>}
      {tickets === null ? <p className="muted small">Cargando…</p> : !tickets.length && !loose.length ? (
        <p className="muted small" data-testid="tickets-empty">Todavía no hay tickets. Aparecen cuando una ejecución recibe una clave (p. ej. SBK-123) o un paso levanta algo sobre ella.</p>
      ) : (
        <ul className="tk-list" data-testid="tickets-list">
          {tickets.map((t) => (
            <li key={t.key} className={`tk-row ${sel === t.key ? 'on' : ''}`} data-testid={`ticket-row-${t.key}`} onClick={() => setSel(sel === t.key ? null : t.key)}>
              <div className="row">
                <b className="tk-key">{t.key}</b>
                <span className="muted small" title={when(t.lastAt)}>{t.lastAt ? `hace ${age(t.lastAt)}` : ''}</span>
                <span className="grow" />
                {t.lastRun && (
                  <a className={`status s-${t.lastRun.status} small`} data-testid="ticket-last-run" title={`Última ejecución ${t.lastRun.id} · ${when(t.lastRun.startedAt)}${t.runs > 1 ? ` · ${t.runs} ejecuciones` : ''}`}
                    onClick={(e) => { e.stopPropagation(); onOpenRun?.(t.lastRun.id); }}>▶ {RUN_STATUS[t.lastRun.status] || t.lastRun.status}</a>
                )}
              </div>
              <div className="tk-counts small" data-testid="ticket-counts">
                <span data-testid="tk-questions" title="Dudas del ticket">❓ <b data-testid="tk-q-open">{q(t).open || 0}</b> abiertas · <b data-testid="tk-q-review">{q(t).review || 0}</b> a revisar · <b data-testid="tk-q-published">{q(t).published || 0}</b> publicadas · <b data-testid="tk-q-closed">{q(t).closed || 0}</b> cerradas</span>
                <span title="Problemas del flujo abiertos">⛔ <b data-testid="tk-blockers">{t.blockers || 0}</b> bloqueos</span>
                <span title="Controles de cierre abiertos">☑ <b data-testid="tk-checks">{t.checks || 0}</b> controles</span>
                <span title="Acciones pendientes">➜ <b data-testid="tk-actions">{t.actions || 0}</b> acciones</span>
                <span title="Aprendizajes">💡 <b data-testid="tk-lessons">{t.lessons || 0}</b> aprendizajes</span>
              </div>
            </li>
          ))}
          {loose.length > 0 && (
            <li className={`tk-row ${sel === NONE ? 'on' : ''}`} data-testid="ticket-row-none" onClick={() => setSel(sel === NONE ? null : NONE)}>
              <div className="row"><b className="tk-key muted">Sin ticket</b><span className="muted small">{loose.length} ítem{loose.length === 1 ? '' : 's'} que no nombran un ticket</span></div>
            </li>
          )}
        </ul>
      )}
      {sel && (
        <div className="tk-detail" data-testid="ticket-detail">
          <h4>{sel === NONE ? 'Sin ticket' : sel}</h4>
          {!mine.length && <p className="muted small">Ningún paso levantó nada sobre este ticket.</p>}
          {KIND_ORDER.map((k) => {
            const list = mine.filter((x) => x.kind === k).sort((a, b) => (['open', 'review'].includes(b.state) - ['open', 'review'].includes(a.state)) || (b.lastSeen || 0) - (a.lastSeen || 0));
            if (!list.length) return null;
            return (
              <div key={k} className="tk-group" data-testid={`tk-group-${k}`}>
                <div className="ctx-title">{KIND_ICON[k]} {KIND[k]} ({list.length})</div>
                <ul className="tk-items">{list.map((it) => <ItemCard key={it.id} it={it} busy={busy === it.id} onState={setState} />)}</ul>
              </div>
            );
          })}
          {sel !== NONE && (
            <div className="tk-group" data-testid="ticket-journal">
              <div className="ctx-title">🧾 Registro de {sel}{journal ? ` (${journal.total})` : ''}</div>
              {journal ? <JournalList entries={journal.entries} onOpenRun={onOpenRun} /> : <p className="muted small">Cargando…</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 🧾 Registro: everything the flow did, newest first, with filters; the file is journal.jsonl (one JSON per line). */
export function JournalPanel({ flow, onOpenRun }) {
  const [f, setF] = useState({ type: '', ticket: '', run: '' });
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState({ tickets: [], runs: [] });
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const fRef = useRef(f); fRef.current = f;

  const load = async () => {
    const cur = fRef.current;
    const qs = new URLSearchParams({ limit: '500', ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)) });
    try {
      const [j, t, r] = await Promise.all([api.get(`/api/flows/${flow.id}/journal?${qs}`), api.get(`/api/flows/${flow.id}/tickets`), api.get(`/api/flows/${flow.id}/runs`)]);
      setData(j); setOpts({ tickets: t.map((x) => x.key), runs: (r || []).slice(0, 50) }); setErr('');
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [flow.id, f.type, f.ticket, f.run]);
  useFlowRefresh(flow.id, load);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const copy = () => { try { navigator.clipboard?.writeText(data?.file || ''); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const filtered = f.type || f.ticket || f.run;

  return (
    <div className="panel-body pad" data-testid="journal-view">
      <p className="muted small">Todo lo que hizo el flujo: ejecuciones, lo que escribió afuera (Jira, PRs), archivos, «Al terminar», lo que levantaron los pasos y lo que cambiaste vos. Lo más nuevo primero.</p>
      {err && <div className="error-bar">{err}</div>}
      {data?.file && (
        <div className="row small journal-file">
          <code className="grow mono" data-testid="journal-file" title={data.file}>{data.file}</code>
          <button className="ghost small" data-testid="journal-copy" onClick={copy}>{copied ? '✓ Copiada' : 'Copiar ruta'}</button>
          <a className="btn ghost small" data-testid="journal-download" href={`/api/flows/${flow.id}/journal.jsonl`} download={`registro-${flow.id}.jsonl`}>⬇ Descargar (.jsonl)</a>
        </div>
      )}
      <div className="row journal-filters">
        <select value={f.type} onChange={set('type')} data-testid="journal-filter-type" aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={f.ticket} onChange={set('ticket')} data-testid="journal-filter-ticket" aria-label="Ticket">
          <option value="">Todos los tickets</option>
          {[...new Set([...opts.tickets, ...(f.ticket ? [f.ticket] : [])])].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={f.run} onChange={set('run')} data-testid="journal-filter-run" aria-label="Ejecución">
          <option value="">Todas las ejecuciones</option>
          {opts.runs.map((r) => <option key={r.id} value={r.id}>{when(r.startedAt)} · {RUN_STATUS[r.status] || r.status}</option>)}
        </select>
        {filtered ? <button className="ghost small" onClick={() => setF({ type: '', ticket: '', run: '' })}>Quitar filtros</button> : null}
      </div>
      {data ? (
        <>
          <div className="muted small" data-testid="journal-total">{data.total} entrada{data.total === 1 ? '' : 's'}{data.total > data.entries.length ? ` (se muestran las ${data.entries.length} más nuevas)` : ''}</div>
          <JournalList entries={data.entries} onOpenRun={onOpenRun} />
        </>
      ) : <p className="muted small">Cargando…</p>}
    </div>
  );
}

/** «Lo que levantó este paso» (step panel): what the step raised in its last run, also when it went well. */
export function RaisedItems({ step, onOpenTickets }) {
  const list = step.lastRun?.raised || [];
  if (!list.length) return null;
  return (
    <div className="raised-items" data-testid="raised-items">
      <div className="row"><b className="grow">Lo que levantó este paso</b>{onOpenTickets && <a className="small" data-testid="raised-open-tickets" onClick={() => onOpenTickets()}>Ver en Tickets →</a>}</div>
      <ul>
        {list.map((r) => (
          <li key={r.id} data-testid={`raised-${r.id}`} className="raised-item">
            <div><span className="chip">{KIND_ICON[r.kind]} {KIND[r.kind] || r.kind}</span>{r.again ? <span className="muted small"> otra vez</span> : null}</div>
            <div className="small">{r.text}</div>
            {r.kind === 'question' && (r.state === 'open'
              ? <div className="small ok-text" data-testid="raised-goes">→ Va al ticket (la publica «Al terminar»)</div>
              : r.state === 'review'
                ? <div className="small warn-text" data-testid="raised-review">⚠ Necesita revisión antes de ir al ticket</div>
                : <div className="muted small">{stateWord(r.state)}</div>)}
            {r.kind !== 'question' && r.state && !['open'].includes(r.state) ? <div className="muted small">{stateWord(r.state)}</div> : null}
            {(r.notes || []).map((n, i) => <div key={i} className="muted small">ⓘ {n}</div>)}
          </li>
        ))}
      </ul>
    </div>
  );
}
