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
export default function Chat({ flowId, chatKey, placeholder, step, allowImprove, onOpenStep }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [improve, setImprove] = useState(false);
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
    try { await pendingSave.flush(); await api.post(`/api/flows/${flowId}/chat/${chatKey}`, { message: t, improve }); setText(''); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function reset() {
    if (!confirm('¿Borrar esta conversación y empezar una sesión nueva? (la memoria se conserva)')) return;
    await api.del(`/api/flows/${flowId}/chat/${chatKey}`); setMsgs([]);
  }
  async function apply(msg, p) {
    try { await pendingSave.flush(); await api.post(`/api/flows/${flowId}/chat/${chatKey === '_global' ? msg.routedKey : chatKey}/apply`, { messageId: findOrigin(msg), proposalId: p.id }); setMsgs((l) => l.map((x) => (x.id === msg.id ? { ...x, proposals: x.proposals.map((q) => (q.id === p.id ? { ...q, applied: true } : q)) } : x))); }
    catch (e) { setErr(e.message); }
  }
  // proposals shown in the global chat live in the target step's chat; find that message by proposal id
  function findOrigin(msg) { return msg.originMessageId || msg.id; }

  return (
    <div className="chat">
      <div className="chat-list">
        {!msgs.length && <div className="muted small pad">{placeholder}</div>}
        {msgs.map((m) => <Msg key={m.id} m={m} step={step} onApply={apply} onOpenStep={onOpenStep} />)}
        <div ref={endRef} />
      </div>
      {err && <div className="error-bar">{err}</div>}
      <div className="chat-input">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe… (Enter envía · Alt+Enter nueva línea)" rows={3}
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
            if (!busy && text.trim()) send();
          }} />
        <div className="chat-actions">
          {allowImprove && (
            <label className="toggle" title="Permite que el agente edite los archivos de la skill/agente de este step (Edit/Write, acceptEdits)">
              <input type="checkbox" checked={improve} onChange={(e) => setImprove(e.target.checked)} /> modo mejora
            </label>
          )}
          <button className="ghost" onClick={reset} title="Nueva sesión">↺</button>
          {running && <button className="ghost danger" onClick={() => api.post(`/api/flows/${flowId}/stop`)}>Detener</button>}
          <button className="primary" disabled={busy || !text.trim()} onClick={send}>Enviar</button>
        </div>
      </div>
    </div>
  );
}

function Msg({ m, step, onApply, onOpenStep }) {
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
      {m.proposals?.map((p) => <Proposal key={p.id} p={p} step={step} onApply={() => onApply(m, p)} canApply={!m.routedKey || m.routedKey !== '_flow'} />)}
      {m.remembered?.length > 0 && (
        <div className="remembered">🧷 Guardado en memoria: {m.remembered.map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
      )}
    </div>
  );
}

function Proposal({ p, step, onApply, canApply }) {
  if (p.patch.__invalid) return <div className="proposal err">Propuesta con JSON inválido:<pre>{p.patch.__invalid}</pre></div>;
  return (
    <div className="proposal">
      <div className="proposal-head">✏️ Cambio propuesto al step {p.applied && <span className="chip ok">aplicado</span>}</div>
      {Object.entries(p.patch).map(([k, v]) => (
        <div key={k} className="diff">
          <div className="label">{k}</div>
          {step && step[k] ? <pre className="old">{String(step[k])}</pre> : null}
          <pre className="new">{String(v)}</pre>
        </div>
      ))}
      {!p.applied && canApply && <button className="primary small" onClick={onApply}>Aplicar</button>}
    </div>
  );
}
