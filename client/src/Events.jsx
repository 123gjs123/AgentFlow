import React, { useState } from 'react';

const short = (v, n = 140) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

function toolSummary(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  return input.command || input.cmd || input.pattern || input.file_path || input.path || input.url || input.query || input.skill || input.description || input.prompt || input.jql || input.cql || short(input, 120);
}

const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Renders the internal activity of a Claude turn: init, thinking, tools (with results), hooks, result. */
export default function Events({ events = [], running }) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result' && e.id) results.set(e.id, e);
  const useIds = new Set(events.filter((x) => x.kind === 'tool_use').map((x) => x.id));
  const rows = [];
  let thinking = null;
  for (const e of events) {
    if (e.kind === 'rate_limit' || (e.kind === 'tool_result' && e.id && useIds.has(e.id))) continue;
    if (e.kind === 'thinking_tokens') { thinking = e; continue; }
    rows.push(e);
  }
  return (
    <div className="events">
      {rows.map((e, i) => <EventRow key={i} e={e} result={e.kind === 'tool_use' ? results.get(e.id) : null} />)}
      {running && (
        <div className="ev ev-live"><span className="spinner" /> {thinking ? `Pensando… ~${thinking.tokens} tokens de razonamiento` : 'Trabajando…'}</div>
      )}
      {!rows.length && !running && <div className="muted small">Sin actividad todavía.</div>}
    </div>
  );
}

function EventRow({ e, result }) {
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case 'init':
      return (
        <div className="ev ev-init">
          ⚙️ Sesión <code>{e.sessionId?.slice(0, 8)}</code> · {e.model} · {e.tools} tools
          {e.mcp?.length ? <> · MCP: {e.mcp.map((m) => <span key={m.name} className={`chip ${m.status === 'connected' ? 'ok' : 'warn'}`}>{m.name}</span>)}</> : null}
        </div>
      );
    case 'thinking':
      return <div className="ev ev-thinking" onClick={() => setOpen(!open)}>🧠 {open ? e.text : short(e.text, 200)}</div>;
    case 'text':
      return <div className={`ev ev-text ${e.sub ? 'sub' : ''}`}>💬 {e.sub ? '[subagente] ' : ''}{short(e.text, 400)}</div>;
    case 'tool_use': {
      const err = result?.isError;
      return (
        <div className={`ev ev-tool ${e.sub ? 'sub' : ''}`}>
          <div className="ev-head" onClick={() => setOpen(!open)}>
            <span className={`dot ${result ? (err ? 'err' : 'ok') : 'run'}`} />
            🔧 <b>{e.name}</b> <span className="muted">{short(toolSummary(e.name, e.input), 110)}</span>
            <span className="caret">{open ? '▾' : '▸'}</span>
          </div>
          {open && (
            <div className="ev-body">
              <div className="label">input</div>
              <pre>{JSON.stringify(e.input, null, 2)}</pre>
              {result && <><div className="label">{err ? 'error' : 'resultado'}</div><pre className={err ? 'err' : ''}>{result.content}</pre></>}
            </div>
          )}
        </div>
      );
    }
    case 'tool_result':
      return <div className={`ev ${e.isError ? 'ev-error' : ''}`} onClick={() => setOpen(!open)}>↳ {open ? <pre>{e.content}</pre> : short(e.content, 160)}</div>;
    case 'hook':
      return <div className="ev ev-hook">🪝 hook <b>{e.text}</b></div>;
    case 'hook_log':
      return <div className="ev ev-hook">🪝 {e.text}</div>;
    case 'result': {
      const u = e.usage || {};
      return (
        <div className={`ev ${e.isError ? 'ev-error' : 'ev-result'}`}>
          {e.isError ? '✖' : '✔'} {e.isError ? `Error (${e.subtype})` : 'Terminado'} · {fmtMs(e.durationMs)} · {e.numTurns} turnos · in {u.input_tokens ?? 0}+{(u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} cache / out {u.output_tokens ?? 0}
          {e.denials?.length ? <div className="warn-text">Permisos denegados: {e.denials.map((d) => d.tool_name).join(', ')} — agrégalos a "Tools permitidas" o cambia el modo de permisos.</div> : null}
        </div>
      );
    }
    case 'error':
      return <div className="ev ev-error">⚠️ {e.text}</div>;
    case 'queued':
      return <div className="ev ev-hook">⏳ {e.text}</div>;
    case 'retry':
      return <div className="ev ev-hook">↻ {e.text?.replace(/^↻\s*/, '')}</div>;
    case 'timeout':
      return <div className="ev ev-error">⏱ {e.text?.replace(/^⏱\s*/, '')}</div>;
    default:
      return null;
  }
}
