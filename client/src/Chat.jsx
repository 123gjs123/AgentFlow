import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, onWs, pendingSave } from './api.js';
import Events from './Events.jsx';

// Model output is untrusted: no images (silent requests can leak data), forms, inputs or inline styles; links open outside.
const PURIFY = { FORBID_TAGS: ['img', 'form', 'input', 'button', 'textarea', 'select', 'option', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'svg', 'math'], FORBID_ATTR: ['style', 'srcset'] };
DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });
const md = (t) => ({ __html: DOMPurify.sanitize(marked.parse(t || '', { breaks: true }), PURIFY) });

/**
 * Chat bound to a key: a step id, '_flow' or '_global'.
 * Shows the internal process (tools/thinking) of each answer, proposals to apply and remembered facts.
 */
export default function Chat({ flowId, chatKey, placeholder, step, onOpenStep, runId, vars, onApplied, compact, locked }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const live = useRef({}); // messageId -> streaming text
  const endRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setMsgs([]); setErr('');
    api.get(`/api/flows/${flowId}/chat/${chatKey}`).then((m) => alive && setMsgs(m)).catch((e) => setErr(e.message));
    const off = onWs((m) => {
      if (m.flowId !== flowId || m.key !== chatKey) return;
      if (m.type === 'chat.message' || m.type === 'chat.done') {
        setMsgs((list) => { const i = list.findIndex((x) => x.id === m.message.id); if (i < 0) return [...list, m.message]; const c = [...list]; c[i] = { ...c[i], ...m.message, events: m.message.events?.length ? m.message.events : c[i].events }; return c; });
        if (m.type === 'chat.done') delete live.current[m.message.id];
      } else if (m.type === 'chat.event') {
        if (m.mirrorOf) return; // the relayed copy carries the right message id
        const ev = m.event;
        setMsgs((list) => list.map((x) => {
          if (x.id !== m.messageId) return x;
          if (ev.kind === 'delta') { live.current[x.id] = (live.current[x.id] || '') + ev.text; return { ...x, streaming: live.current[x.id] }; }
          if (ev.kind === 'thinking_delta') return x;
          if (ev.kind === 'text' && !ev.sub) { live.current[x.id] = ''; return { ...x, streaming: '', lastText: ev.text, events: [...(x.events || []), ev] }; }
          return { ...x, events: [...(x.events || []), ev] };
        }));
      }
    });
    return () => { alive = false; off(); };
  }, [flowId, chatKey]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  const running = msgs.some((m) => m.status === 'running');

  async function send() {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr('');
    try { await pendingSave.flush(); await api.post(`/api/flows/${flowId}/chat/${chatKey}`, { message: t, ...(runId ? { runId } : {}) }); setText(''); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function reset() {
    if (!confirm('¿Borrar esta conversación y empezar una sesión nueva? (la memoria se conserva)')) return;
    await api.del(`/api/flows/${flowId}/chat/${chatKey}`); setMsgs([]);
  }
  // proposals of a routed answer live in the target step's chat; run proposals of the general chat live here
  const ownerKey = (msg) => (chatKey === '_global' && msg.routedKey ? msg.routedKey : chatKey);
  const mark = (msg, p, fields) => setMsgs((l) => l.map((x) => (x.id === msg.id ? { ...x, proposals: x.proposals.map((q) => (q.id === p.id ? { ...q, ...fields } : q)) } : x)));
  async function apply(msg, p) {
    setErr('');
    try {
      await pendingSave.flush();
      const r = await api.post(`/api/flows/${flowId}/chat/${ownerKey(msg)}/apply`, { messageId: findOrigin(msg), proposalId: p.id, ...(runId ? { runId } : {}) });
      mark(msg, p, { applied: true, ...(r?.runId ? { runId: r.runId } : {}) });
      onApplied?.(p, r);
    } catch (e) { setErr(e.message); }
  }
  async function discard(msg, p) {
    try { await api.post(`/api/flows/${flowId}/chat/${ownerKey(msg)}/discard`, { messageId: findOrigin(msg), proposalId: p.id }); mark(msg, p, { discarded: true }); }
    catch (e) { setErr(e.message); }
  }
  // proposals shown in the global chat live in the target step's chat; find that message by proposal id
  function findOrigin(msg) { return msg.originMessageId || msg.id; }

  return (
    <div className={`chat${compact ? ' chat-compact' : ''}`}>
      <div className="chat-list">
        {!msgs.length && <div className="muted small pad">{placeholder}</div>}
        {msgs.map((m) => <Msg key={m.id} m={m} step={step} vars={vars} onApply={apply} onDiscard={discard} onOpenStep={onOpenStep} inBreak={!!runId} locked={!!locked} />)}
        <div ref={endRef} />
      </div>
      {err && <div className="error-bar">{err}</div>}
      {locked && <div className="chat-locked small" data-testid="chat-locked">⏵ {locked}</div>}
      <div className="chat-input">
        <textarea value={text} disabled={!!locked} onChange={(e) => setText(e.target.value)} placeholder="Escribe… (Enter envía · Alt+Enter nueva línea)" rows={3}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            // Alt+Enter (or Shift+Enter) = new line; Enter alone = send.
            if (e.altKey) {
              e.preventDefault();
              // Native insertion: keeps the caret where it is (even while typing fast) and the browser's own undo.
              if (!document.execCommand?.('insertText', false, '\n')) {
                const t = e.target; const a = t.selectionStart; const b = t.selectionEnd;
                t.setRangeText('\n', a, b, 'end');
                setText(t.value);
              }
              return;
            }
            if (e.shiftKey) return;
            e.preventDefault();
            if (!busy && !locked && text.trim()) send();
          }} />
        <div className="chat-actions">
          <button className="ghost" onClick={reset} title="Nueva sesión">↺</button>
          {running && <button className="ghost danger" title="Cancela solo esta respuesta del chat (nunca una ejecución)" onClick={() => api.post(`/api/flows/${flowId}/chat/${chatKey}/cancel`)}>Cancelar respuesta</button>}
          <button className="primary" disabled={busy || !!locked || !text.trim()} onClick={send}>Enviar</button>
        </div>
      </div>
    </div>
  );
}

function Msg({ m, step, vars, onApply, onDiscard, onOpenStep, inBreak, locked }) {
  const [showProc, setShowProc] = useState(false);
  if (m.role === 'user') return <div className="msg user"><div className="bubble">{m.text}</div></div>;
  if (m.role === 'router') {
    return (
      <div className="msg router">
        {m.status === 'running' ? <><span className="spinner" /> {m.text}</> : <span dangerouslySetInnerHTML={md(m.text)} />}
      </div>
    );
  }
  const running = m.status === 'running';
  const open = showProc || running;
  return (
    <div className="msg assistant">
      {m.routedTo && (
        <div className="routed">vía <a onClick={() => m.routedKey && m.routedKey !== '_flow' && onOpenStep?.(m.routedKey)}>{m.routedTo}</a></div>
      )}
      {(m.events?.length > 0 || running) && (
        <div className="proc">
          <div className="proc-head" onClick={() => setShowProc(!showProc)}>
            {open ? '▾' : '▸'} Proceso interno ({(m.events || []).filter((e) => e.kind === 'tool_use').length} herramientas)
          </div>
          {open && <Events events={m.events} running={running} />}
        </div>
      )}
      {running && m.streaming ? <div className="bubble md" dangerouslySetInnerHTML={md(m.streaming)} /> : null}
      {!running && m.text ? <div className={`bubble md ${m.status === 'error' ? 'err' : ''}`} dangerouslySetInnerHTML={md(m.text)} /> : null}
      {m.proposals?.map((p) => <Proposal key={p.id} p={p} step={step} vars={vars} inBreak={inBreak} locked={locked} onApply={() => onApply(m, p)} onDiscard={() => onDiscard(m, p)} />)}
      {m.remembered?.length > 0 && (
        <div className="remembered">🧷 Guardado en memoria: {m.remembered.map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
      )}
    </div>
  );
}

const txt = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const srcText = (c) => `${c.type}: ${c.label ? `${c.label} — ` : ''}${c.path || c.url || c.ref || ''}`;
/** Rows "label / old / new" of a step patch (also used per step inside a flow proposal). */
function stepRows(patch, step, vars, prefix = '') {
  return Object.entries(patch || {}).flatMap(([k, v]) => {
    if (k === 'vars' && v && typeof v === 'object') return Object.entries(v).map(([n, val]) => ({ key: `${prefix}vars.${n}`, label: `variable del flujo "${n}"`, old: vars?.[n], val }));
    if (k === 'addContext' && Array.isArray(v)) return [{ key: `${prefix}ctx`, label: `${prefix}agregar contexto`, val: v.map(srcText).join('\n') }];
    return [{ key: prefix + k, label: prefix + k, old: step?.[k], val: v }];
  });
}
const TITLES = { step: '✏️ Cambio propuesto al step', flow: '✏️ Cambio propuesto al flujo', file: '📝 Cambio propuesto a un archivo', output: '📦 Entregable corregido', memory: '🧷 Guardar en memoria', run: '▶ Ejecución propuesta' };

/**
 * A proposal from a chat (spec 25): nothing changes until the user presses the button. The conversation can go on:
 * a refined proposal comes as a new one; old ones can be discarded.
 */
function Proposal({ p, step, vars, inBreak, locked, onApply, onDiscard }) {
  const kind = p.kind || 'step';
  const [showOld, setShowOld] = useState(false);
  if (p.patch?.__invalid) return <div className="proposal err">Propuesta inválida:<pre>{txt(p.patch.__invalid)}</pre></div>;
  let body; let action = 'Aplicar'; let blocked = '';
  if (kind === 'step') body = stepRows(p.patch, step, vars).map((r) => <Diff key={r.key} {...r} />);
  else if (kind === 'flow') {
    const { steps, ...rest } = p.patch || {};
    body = [
      ...stepRows(rest, null, vars).map((r) => <Diff key={r.key} {...r} />),
      ...Object.entries(steps || {}).flatMap(([name, patch]) => stepRows(patch, null, vars, `${name} · `).map((r) => <Diff key={r.key} {...r} />)),
    ];
  } else if (kind === 'file') {
    blocked = p.error || '';
    body = (
      <div className="diff">
        <div className="label">{p.target || p.path}{p.current === null ? ' (archivo nuevo)' : ''}</div>
        {p.current !== null && p.current !== undefined && <><a className="small" onClick={() => setShowOld(!showOld)}>{showOld ? 'ocultar versión actual' : 'ver versión actual'}</a>{showOld && <pre className="old">{p.current}</pre>}</>}
        <pre className="new">{p.content}</pre>
      </div>
    );
  } else if (kind === 'output') {
    if (!inBreak) blocked = 'Se aplica desde la ventana del break.';
    action = 'Usar esta salida';
    body = <div className="diff"><pre className="new">{p.output}</pre>{p.json !== undefined && <div className="muted small">Incluye los datos JSON del bloque.</div>}</div>;
  } else if (kind === 'memory') {
    action = 'Guardar';
    body = <div className="diff"><pre className="new">{p.text}</pre></div>;
  } else if (kind === 'run') {
    action = 'Ejecutar';
    body = <div className="diff"><div className="label">{p.patch?.stepName ? `step “${p.patch.stepName}”` : 'flujo completo'}</div>{p.patch?.input ? <pre className="new">{p.patch.input}</pre> : <div className="muted small">sin input</div>}</div>;
  }
  const done = p.applied || p.discarded;
  return (
    <div className={`proposal${p.discarded ? ' discarded' : ''}`} data-kind={kind}>
      <div className="proposal-head">{TITLES[kind] || TITLES.step}
        {p.applied && <span className="chip ok">{kind === 'run' ? `ejecutado${p.runId ? ` (${p.runId})` : ''}` : 'aplicado'}</span>}
        {p.discarded && <span className="chip">descartado</span>}
      </div>
      {body}
      {blocked && <div className="muted small">⚠ {blocked}</div>}
      {!done && (
        <div className="proposal-actions">
          <button className="primary small" disabled={!!blocked || locked} title={locked ? 'El flujo se está ejecutando' : undefined} onClick={onApply}>{action}</button>
          <button className="ghost small" onClick={onDiscard}>Descartar</button>
          <span className="muted small">o sigue conversando para ajustarla</span>
        </div>
      )}
    </div>
  );
}
function Diff({ label, old, val }) {
  return (
    <div className="diff">
      <div className="label">{label}</div>
      {txt(old) ? <pre className="old">{txt(old)}</pre> : null}
      <pre className="new">{txt(val)}</pre>
    </div>
  );
}
