// Data passing between steps: insert-data picker, input/output settings and the Input/Output ("Datos") tab with pinning.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/** All steps that run before `stepId` (transitively), closest first. */
export function ancestorsOf(flow, stepId) {
  const out = []; const seen = new Set([stepId]); let frontier = [stepId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) for (const e of flow.edges) if (e.target === id && !seen.has(e.source)) { seen.add(e.source); next.push(e.source); }
    out.push(...next); frontier = next;
  }
  return out.map((id) => flow.steps.find((s) => s.id === id)).filter(Boolean);
}

export const dataOf = (s) => (s.pinned ? { output: s.pinned.output, json: s.pinned.json, files: [], actions: [] } : { output: s.lastRun?.output, json: s.lastRun?.json, files: s.lastRun?.files || [], actions: s.lastRun?.actions || [] });

/** Field paths of a JSON value (first array element as a sample), with a preview of each value. */
export function flattenPaths(v, prefix = '', depth = 0, out = []) {
  if (out.length > 80 || depth > 4 || v === null || typeof v !== 'object') return out;
  const entries = Array.isArray(v) ? (v.length ? [['0', v[0]]] : []) : Object.entries(v);
  for (const [k, x] of entries) {
    const p = prefix ? `${prefix}.${k}` : k;
    const preview = x !== null && typeof x === 'object' ? (Array.isArray(x) ? `lista (${x.length})` : 'objeto') : clip(String(x), 40);
    out.push({ path: p, preview });
    flattenPaths(x, p, depth + 1, out);
  }
  return out;
}

export function inferSchema(v) {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferSchema(v[0]) : {} };
  if (v === null) return { type: 'null' };
  if (typeof v === 'object') return { type: 'object', required: Object.keys(v), properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inferSchema(x)])) };
  return { type: Number.isInteger(v) ? 'integer' : typeof v };
}

function stepItems(s, tag) {
  const d = dataOf(s);
  const items = [{ value: `{{steps.${s.name}.output}}`, label: 'texto de salida', hint: clip(d.output, 50) || 'sin ejecutar todavía', tag }];
  if (d.json !== undefined && d.json !== null) {
    items.push({ value: `{{steps.${s.name}.json}}`, label: 'JSON completo', hint: Array.isArray(d.json) ? `lista (${d.json.length})` : 'objeto', tag });
    for (const f of flattenPaths(d.json)) items.push({ value: `{{steps.${s.name}.json.${f.path}}}`, label: `json.${f.path}`, hint: f.preview, tag });
  } else if (s.output?.format === 'json') items.push({ value: null, label: 'campos JSON', hint: 'ejecútalo una vez (o fija una salida) para ver sus campos', tag });
  if (d.files?.length) items.push({ value: `{{steps.${s.name}.files}}`, label: 'archivos escritos', hint: `${d.files.length}`, tag });
  if (d.actions?.length) items.push({ value: `{{steps.${s.name}.actions}}`, label: 'acciones realizadas', hint: `${d.actions.length}`, tag });
  return items;
}

export function DataPicker({ flow, step, onInsert, command }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const groups = useMemo(() => {
    const anc = ancestorsOf(flow, step.id);
    const others = flow.steps.filter((s) => s.id !== step.id && !anc.includes(s));
    const g = [{ title: 'Flujo', items: [{ value: '{{input}}', label: 'input del flujo', hint: 'lo que recibe la ejecución' }, ...(command ? [{ value: '{{upstream}}', label: 'salidas anteriores (texto)', hint: 'todo lo que entra por stdin' }] : [])] }];
    const vars = Object.keys(flow.vars || {});
    if (vars.length) g.push({ title: 'Variables', items: vars.flatMap((k) => [{ value: `{{vars.${k}}}`, label: k, hint: clip(typeof flow.vars[k] === 'string' ? flow.vars[k] : JSON.stringify(flow.vars[k]), 40) }]) });
    for (const s of anc) g.push({ title: `${s.name}${s.pinned ? ' 📌' : ''}`, items: stepItems(s) });
    if (others.length) g.push({ title: 'Otros steps (no corren antes: usan su última salida)', muted: true, items: others.flatMap((s) => stepItems(s, s.name)) });
    return g;
  }, [flow, step.id, command]);
  const match = (it) => !q || `${it.label} ${it.value} ${it.tag || ''}`.toLowerCase().includes(q.toLowerCase());
  return (
    <span className="dp" ref={ref}>
      <button type="button" className="chip btn" onClick={() => setOpen(!open)} title="Insertar un dato de otro step, una variable o el input">{'{ }'} Insertar dato</button>
      {open && (
        <div className="dp-pop">
          <input autoFocus placeholder="Buscar campo…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="dp-list">
            {groups.map((g) => {
              const items = g.items.filter(match);
              if (!items.length) return null;
              return (
                <div key={g.title} className={g.muted ? 'dp-group muted' : 'dp-group'}>
                  <div className="dp-title">{g.title}</div>
                  {items.map((it, i) => (
                    <button type="button" key={i} disabled={!it.value} className="dp-item" onClick={() => { onInsert(it.value); setOpen(false); setQ(''); }}>
                      <span>{it.tag ? <span className="muted">{it.tag} · </span> : null}{it.label}</span>
                      <span className="muted small">{it.hint}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}

/** Textarea with an "Insert data" button that inserts the template at the cursor. */
export function TplField({ flow, step, value, onChange, command, ...rest }) {
  const ta = useRef(null);
  const pos = useRef(null); // last cursor position; null = never focused -> append at the end
  const track = (e) => { pos.current = [e.target.selectionStart, e.target.selectionEnd]; };
  const insert = (tok) => {
    const el = ta.current; const v = value || '';
    const [a, b] = pos.current ? [Math.min(pos.current[0], v.length), Math.min(pos.current[1], v.length)] : [v.length, v.length];
    pos.current = [a + tok.length, a + tok.length];
    onChange(v.slice(0, a) + tok + v.slice(b));
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = a + tok.length; } });
  };
  return (
    <div className="tpl">
      <textarea ref={ta} value={value || ''} onChange={(e) => { onChange(e.target.value); track(e); }} onSelect={track} onKeyUp={track} onClick={track} {...rest} />
      <div className="tpl-bar"><DataPicker flow={flow} step={step} onInsert={insert} command={command} /></div>
    </div>
  );
}

const MODES = [
  ['full', 'Todo: texto + JSON de los steps anteriores'],
  ['json', 'Solo los datos JSON (si existen)'],
  ['summary', 'Resumen de cada salida larga (Haiku)'],
  ['refs', 'Solo lo que referencio con { } en la tarea'],
];

/** "What it receives / what it delivers" settings. */
export function IoSettings({ step, onChange }) {
  const out = step.output || { format: 'text', schema: '' };
  const inp = step.input || { mode: 'full', maxChars: 12000 };
  const [example, setExample] = useState(null);
  const [err, setErr] = useState('');
  const schemaErr = (() => { if (!out.schema?.trim()) return ''; try { JSON.parse(out.schema); return ''; } catch (e) { return e.message; } })();
  return (
    <details className="advanced io">
      <summary>Datos: qué recibe y qué entrega <span className="muted small">— {step.kind !== 'command' ? `recibe ${({ full: 'todo', json: 'solo JSON', summary: 'resumen', refs: 'solo referencias' })[inp.mode] || 'todo'} · ` : ''}entrega {out.format === 'json' ? 'JSON' : 'texto'}</span></summary>
      {step.kind !== 'command' && (
        <label className="field"><span className="field-label">Recibe de los steps anteriores <span className="hint">— menos contexto = menos tokens y menos confusión</span></span>
          <div className="row">
            <select value={inp.mode} onChange={(e) => onChange({ input: { ...inp, mode: e.target.value } })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <input type="number" min={500} step={500} style={{ width: 100 }} title="Máximo de caracteres por step anterior" value={inp.maxChars ?? 12000} onChange={(e) => onChange({ input: { ...inp, maxChars: Number(e.target.value) } })} />
          </div>
        </label>
      )}
      <label className="field"><span className="field-label">Entrega <span className="hint">— JSON permite que otros steps usen campos sueltos</span></span>
        <div className="seg">
          {[['text', 'Texto'], ['json', 'JSON estructurado']].map(([k, l]) => <button key={k} type="button" className={out.format === k ? 'active' : ''} onClick={() => onChange({ output: { ...out, format: k } })}>{l}</button>)}
        </div>
      </label>
      {out.format === 'json' && (
        <div className="field">
          <span className="field-label">Estructura esperada (JSON Schema, opcional) <span className="hint">— si no cumple, se pide la corrección una vez y si no, el step falla</span></span>
          <textarea className="mono" rows={5} value={out.schema || ''} onChange={(e) => onChange({ output: { ...out, schema: e.target.value } })} placeholder='{"type":"object","required":["cases"],"properties":{"cases":{"type":"array"}}}' />
          {schemaErr && <div className="warn-text small">Schema inválido: {schemaErr}</div>}
          {example === null ? (
            <button type="button" className="chip btn" onClick={() => setExample('')}>Generar desde un ejemplo</button>
          ) : (
            <div className="field">
              <textarea className="mono" rows={4} value={example} onChange={(e) => setExample(e.target.value)} placeholder='Pega un JSON de ejemplo: {"cases":[{"title":"...","priority":"high"}]}' />
              {err && <div className="warn-text small">{err}</div>}
              <div className="row">
                <button type="button" className="ghost small" onClick={() => { setExample(null); setErr(''); }}>Cancelar</button>
                <button type="button" className="small" onClick={() => { try { onChange({ output: { ...out, schema: JSON.stringify(inferSchema(JSON.parse(example)), null, 2) } }); setExample(null); setErr(''); } catch (e) { setErr(e.message); } }}>Generar schema</button>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="ghost small" onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1000); }}>{ok ? '✓' : 'copiar'}</button>;
}

/** Input/Output view of the last run + pin/unpin (n8n-style pin data). */
export function DataTab({ flow, step, live }) {
  const [view, setView] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const runId = step.lastRun?.runId;
  const running = (live?.status || step.lastRun?.status) === 'running';
  useEffect(() => {
    setView(null);
    if (runId && !running) api.get(`/api/flows/${flow.id}/runs/${runId}`).then((r) => setView(r?.steps?.[step.id] || null)).catch(() => {});
  }, [runId, step.lastRun?.endedAt, running]);

  const pinned = step.pinned;
  const out = pinned ? { output: pinned.output, json: pinned.json, files: [], actions: [] } : { output: view?.output ?? step.lastRun?.output, json: view?.json ?? step.lastRun?.json, files: view?.files || step.lastRun?.files || [], actions: view?.actions || step.lastRun?.actions || [] };
  const iv = view?.inputView;
  const hasOut = !!(out.output || out.json !== undefined);

  async function pin(body) {
    setErr('');
    try { await api.post(`/api/flows/${flow.id}/steps/${step.id}/pin`, body); setEdit(null); } catch (e) { setErr(e.message); }
  }
  function saveEdit() {
    let json;
    if (edit.json.trim()) { try { json = JSON.parse(edit.json); } catch (e) { return setErr(`JSON inválido: ${e.message}`); } }
    pin({ output: edit.output, json });
  }

  return (
    <div className="panel-body pad data-tab">
      <div className={`pin-bar ${pinned ? 'on' : ''}`}>
        {pinned ? (
          <>
            <span>📌 <b>Salida fijada</b> {pinned.source === 'edited' ? '(editada a mano)' : 'de la última ejecución'} · {new Date(pinned.at).toLocaleString()}. Al ejecutar el flujo este step <b>no corre</b>: los siguientes reciben estos datos.</span>
            <div className="row">
              <button className="small" onClick={() => setEdit({ output: pinned.output || '', json: pinned.json !== undefined ? JSON.stringify(pinned.json, null, 2) : '' })}>Editar</button>
              <button className="ghost small" onClick={() => api.del(`/api/flows/${flow.id}/steps/${step.id}/pin`)}>Desfijar</button>
            </div>
          </>
        ) : (
          <>
            <span className="muted small">Fija una salida para probar los steps siguientes sin volver a ejecutar (ni gastar) este step.</span>
            <div className="row">
              <button className="small" disabled={!hasOut} onClick={() => pin({ fromLast: true })}>📌 Fijar esta salida</button>
              <button className="ghost small" onClick={() => setEdit({ output: out.output || '', json: out.json !== undefined ? JSON.stringify(out.json, null, 2) : '' })}>Escribir datos de prueba…</button>
            </div>
          </>
        )}
      </div>
      {err && <div className="error-bar">{err}</div>}
      {edit && (
        <div className="pin-edit">
          <label className="field"><span className="field-label">Texto de salida</span><textarea rows={5} value={edit.output} onChange={(e) => setEdit({ ...edit, output: e.target.value })} /></label>
          <label className="field"><span className="field-label">JSON (opcional)</span><textarea className="mono" rows={6} value={edit.json} onChange={(e) => setEdit({ ...edit, json: e.target.value })} placeholder='{"cases":[...]}' /></label>
          <div className="row end"><button className="ghost small" onClick={() => { setEdit(null); setErr(''); }}>Cancelar</button><button className="primary small" onClick={saveEdit}>📌 Fijar estos datos</button></div>
        </div>
      )}

      <h4 className="io-title">⬅ Entrada</h4>
      {running ? <div className="muted small"><span className="spinner" /> ejecutando…</div> : !iv ? (
        <div className="muted small">{pinned && view?.pinned ? 'La última ejecución usó la salida fijada.' : 'Ejecuta el step o el flujo para ver exactamente qué recibió.'}</div>
      ) : iv.pinned ? <div className="muted small">La última ejecución usó la salida fijada (no recibió entrada).</div> : (
        <>
          {iv.upstream?.length ? (
            <ul className="io-list">
              {iv.upstream.map((u) => <li key={u.name}><b>{u.name}</b> <span className="muted small">{u.chars.toLocaleString()} caracteres{u.json ? ' · JSON' : ''}{u.summarized ? ' · resumido' : ''}</span></li>)}
            </ul>
          ) : <div className="muted small">Sin steps anteriores: solo recibe el input del flujo.</div>}
          {iv.kind === 'ai' && <div className="muted small">Modo: {MODES.find((m) => m[0] === iv.mode)?.[1] || iv.mode} · prompt de {iv.prompt?.length?.toLocaleString()} caracteres</div>}
          {iv.kind === 'command' && <details open><summary>Comando ejecutado</summary><pre className="mono small">{iv.command}</pre></details>}
          {iv.kind === 'command' && iv.stdin && <details><summary>stdin</summary><pre className="small">{iv.stdin}</pre></details>}
          {iv.kind === 'ai' && <details><summary>Prompt enviado</summary><div className="row end"><CopyBtn text={iv.prompt} /></div><pre className="small">{iv.prompt}</pre></details>}
          {iv.kind === 'ai' && <details><summary>Instrucciones de sistema del step</summary><pre className="small">{iv.system}</pre></details>}
        </>
      )}

      <h4 className="io-title">Salida ➡ {pinned && <span className="chip">📌 fijada</span>}</h4>
      {!hasOut && !running ? <div className="muted small">Sin salida todavía.</div> : (
        <>
          {out.json !== undefined && out.json !== null && (
            <details open><summary>JSON <span className="muted small">— campos usables como {'{{'}steps.{step.name}.json.campo{'}}'}</span></summary><div className="row end"><CopyBtn text={JSON.stringify(out.json, null, 2)} /></div><pre className="mono small">{JSON.stringify(out.json, null, 2)}</pre></details>
          )}
          {out.output && <details open={out.json === undefined}><summary>Texto</summary><pre className="small">{out.output}</pre></details>}
          {out.files?.length > 0 && <details open><summary>Archivos escritos ({out.files.length})</summary><ul className="io-list">{out.files.map((f) => <li key={f} className="mono small">{f}</li>)}</ul></details>}
          {out.actions?.length > 0 && (
            <details open><summary>Acciones realizadas ({out.actions.length})</summary>
              <ul className="io-list">{out.actions.map((a, i) => <li key={i}><span className={`chip ${a.ok ? 'ok' : 'warn'}`}>{a.ok ? 'ok' : 'error'}</span> <b>{a.tool}</b> <span className="muted small">{a.server}</span><div className="mono small muted">{clip(a.input, 200)}</div></li>)}</ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
