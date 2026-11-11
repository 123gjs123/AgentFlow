// Context box (spec 17 CTX): live preview of what a step would send, by section, labelled by source and destination.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const DEST = {
  system: ['→ instrucciones de sistema', 'sys'],
  user: ['→ mensaje del step', 'usr'],
  cli: ['flags de la CLI', 'cli'],
  'claude-code': ['lo agrega Claude Code', 'cc'],
  none: ['no va al modelo', 'none'],
};
const DRAFT_KEYS = ['name', 'kind', 'role', 'task', 'context', 'skillRef', 'agentRef', 'allowedTools', 'permissionMode', 'model', 'effort', 'output', 'input', 'assertions', 'timeoutSec', 'retry', 'allowDenials', 'allowEmpty', 'hooks', 'command', 'shell'];
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function lineDiff(a, b) {
  const A = String(a || '').split('\n'); const Bl = String(b || '').split('\n');
  const setA = new Set(A); const setB = new Set(Bl);
  return [...A.filter((l) => !setB.has(l)).map((l) => ({ t: '-', l })), ...Bl.filter((l) => !setA.has(l)).map((l) => ({ t: '+', l }))];
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b className="grow">{title}</b><button className="ghost small" onClick={onClose}>✕</button></div>
        <div className="modal-scroll">{children}</div>
      </div>
    </div>
  );
}
const Copy = ({ text }) => { const [ok, setOk] = useState(false); return <button className="ghost small" onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1000); }}>{ok ? '✓' : 'copiar'}</button>; };

export default function ContextBox({ flow, step, target = 'run' }) {
  const [open, setOpen] = useState(ls.get('afs.ctxOpen') === '1');
  const [mode, setMode] = useState(target);
  const [sample, setSample] = useState('ui');
  const [sampleInput, setSampleInput] = useState('');
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [openSec, setOpenSec] = useState({});
  const [modal, setModal] = useState(null);
  const seq = useRef(0);
  useEffect(() => setMode(target), [target]);

  const draft = useMemo(() => Object.fromEntries(DRAFT_KEYS.map((k) => [k, step[k]])), [step]);
  const draftKey = JSON.stringify(draft);
  const deps = `${draftKey}|${mode}|${sample}|${sampleInput}|${step.lastRun?.endedAt}|${step.memory?.length}|${flow.memory?.length}|${JSON.stringify(flow.edges)}|${JSON.stringify(flow.vars)}|${!!step.pinned}`;
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      const body = { draft, target: mode, sample: sample === 'last' ? { runId: step.lastRun?.runId } : { mode: sample, ...(sampleInput.trim() ? { input: sampleInput } : {}) } };
      api.post(`/api/flows/${flow.id}/steps/${step.id}/preview`, body)
        .then((r) => { if (my === seq.current) { setP(r); setErr(''); } })
        .catch((e) => { if (my === seq.current) setErr(e.message); })
        .finally(() => { if (my === seq.current) setBusy(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [deps, flow.id, step.id]);

  const toggle = () => { setOpen(!open); ls.set('afs.ctxOpen', open ? '0' : '1'); };
  const warns = p?.warnings || [];
  const def = p?.definition;
  const isCmd = step.kind === 'command';

  const chips = [];
  if (p) {
    if (isCmd) chips.push(`Comando ${step.shell || 'powershell'}`);
    else if (def) chips.push(`${def.kind === 'skill' ? 'Skill' : 'Agente'} ${def.ref || '—'}${def.found ? '' : ' (no encontrada)'}`);
    else chips.push('Rol');
    if (p.cli) chips.push(`Acceso: ${p.cli.tools === null ? 'del agente' : p.cli.tools || 'sin herramientas'}${p.cli.allowedTools.some((t) => t.startsWith('mcp__')) ? ' + MCP' : ''}`);
    if (p.upstream?.length) chips.push(`Recibe de ${p.upstream.length} step${p.upstream.length > 1 ? 's' : ''}${p.upstream.some((u) => u.source !== 'run' && u.source !== 'lastRun') ? ` (${p.upstream.filter((u) => u.source === 'pinned').length ? '📌 ' : ''}${p.upstream.filter((u) => u.source === 'none').length ? 'sin datos' : ''})` : ''}`);
    if (!isCmd) chips.push(`Memoria ${step.memory?.length || 0}+${flow.memory?.length || 0}`);
    if (p.totals) chips.push(`≈ ${fmtTok(p.totals.ours.tokensEst)} tokens + Claude Code`);
  }

  const lastIv = step.lastRun?.runId;
  async function compare() {
    try {
      const [run, prev] = await Promise.all([api.get(`/api/flows/${flow.id}/runs/${lastIv}`), api.post(`/api/flows/${flow.id}/steps/${step.id}/preview`, { draft, target: 'run', sample: { runId: lastIv } })]);
      const iv = run?.steps?.[step.id]?.inputView;
      if (!iv || iv.kind !== 'ai') return setModal({ type: 'diff', none: 'La última ejecución no guardó un prompt comparable (comando, salida fijada o error previo).' });
      setModal({ type: 'diff', sys: lineDiff(iv.system, prev.system), usr: lineDiff(iv.prompt, prev.user) });
    } catch (e) { setModal({ type: 'diff', none: e.message }); }
  }
  async function showFile() {
    try { setModal({ type: 'file', file: await api.get(`/api/catalog/file?kind=${def.kind}&name=${encodeURIComponent(def.ref)}&flow=${flow.id}`) }); } catch (e) { setErr(e.message); }
  }

  return (
    <div className={`ctx-box ${open ? 'open' : ''}`}>
      <div className="ctx-head" onClick={toggle} title="Qué contexto recibe este step: se arma igual que al ejecutar">
        <span className="caret">{open ? '▾' : '▸'}</span>
        <b>Contexto</b>
        <span className="ctx-chips">{chips.map((c, i) => <span key={i} className="chip">{c}</span>)}</span>
        {warns.length > 0 && <span className="chip warn" title={warns.map((w) => w.message).join('\n')}>⚠ {warns.length}</span>}
        {busy && <span className="muted small">actualizando…</span>}
      </div>
      {open && (
        <div className="ctx-body">
          {err && <div className="error-bar">{err}</div>}
          <div className="row wrap ctx-bar">
            {!isCmd && <div className="seg small">{[['run', 'Ejecución'], ['chat', 'Chat']].map(([k, l]) => <button key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>}
            {mode === 'run' && (
              <label className="small">Datos de ejemplo:{' '}
                <select value={sample} onChange={(e) => setSample(e.target.value)}>
                  <option value="ui">como al ejecutar desde la UI</option>
                  <option value="external">como ejecución externa (sin 📌)</option>
                  {lastIv && <option value="last">exactamente la última ejecución ({lastIv})</option>}
                </select>
              </label>
            )}
            {mode === 'run' && sample !== 'last' && <input className="small" style={{ minWidth: 170 }} value={sampleInput} onChange={(e) => setSampleInput(e.target.value)} placeholder="input de prueba (p. ej. SBK-123)" title="Por defecto se usa el input de la última ejecución" />}
            {p && !isCmd && mode === 'run' && <button className="ghost small" onClick={() => setModal({ type: 'full' })}>Ver prompt completo</button>}
            {p && !isCmd && mode === 'run' && lastIv && <button className="ghost small" onClick={compare}>Comparar con la última ejecución</button>}
          </div>
          {warns.length > 0 && <ul className="ctx-warns">{warns.map((w, i) => <li key={i} className="warn-text small">⚠ <code>{w.code}</code> {w.message}</li>)}</ul>}
          {p?.chat && <div className="small muted">El bloque de contexto {p.chat.willResend ? <b>se reenviará completo</b> : 'no cambió y no se reenvía'} en tu próximo mensaje de chat.</div>}
          {p?.upstream?.length > 0 && mode === 'run' && (
            <div className="small ctx-up">De dónde salen los datos: {p.upstream.map((u) => (
              <span key={u.id} className={`chip ${u.source === 'run' || u.source === 'lastRun' ? '' : 'warn'}`} title={[u.fromRunId && `ejecución ${u.fromRunId}`, u.note].filter(Boolean).join(' · ')}>
                {u.name}: {u.sample && u.source === 'lastRun' ? 'se ejecutará (ejemplo: su última salida)' : ({ run: 'esta ejecución', pinned: '📌 fijada', lastRun: 'última salida', none: 'sin datos' })[u.source]}{u.summary === 'pending' ? ' · se resumirá' : ''}
              </span>))}
            </div>
          )}
          {p?.sections?.map((s) => {
            const [dl, dc] = DEST[s.toModel] || DEST.none;
            const isOpen = !!openSec[s.id];
            return (
              <div key={s.id} className="ctx-sec">
                <div className="ctx-sec-head" onClick={() => setOpenSec({ ...openSec, [s.id]: !isOpen })}>
                  <span className="caret">{isOpen ? '▾' : '▸'}</span>
                  <span className="grow">{s.label}</span>
                  <span className="chip src" title="de dónde sale">{s.source}</span>
                  <span className={`chip dest-${dc}`}>{dl}</span>
                  <span className="muted small tok">{s.toModel === 'system' || s.toModel === 'user' ? `≈ ${fmtTok(s.tokensEst)}` : ''}</span>
                </div>
                {isOpen && (
                  <div className="ctx-sec-body">
                    <pre className="small">{s.text}</pre>
                    {s.id === 'definition' && def?.found && <button className="ghost small" onClick={showFile}>Ver archivo completo</button>}
                    {s.id === 'access' && p.mcp?.servers === null && <button className="ghost small" onClick={() => api.post('/api/catalog/probe', { cwd: flow.cwd }).then(() => setSample((x) => x)).catch(() => {})}>Comprobar MCPs</button>}
                  </div>
                )}
              </div>
            );
          })}
          {p?.command && <div className="small muted">Los valores van como variables de entorno ({p.command.env.map((v) => v.name).join(', ') || 'ninguna'}): nunca se pegan como código.</div>}
          {p?.totals && <div className="small muted">Esta app envía ≈ {fmtTok(p.totals.ours.tokensEst)} tokens ({p.totals.ours.chars.toLocaleString()} caracteres). Claude Code suma su prompt base, CLAUDE.md ({p.totals.claudeCodeKnownChars.toLocaleString()} caracteres conocidos) y las definiciones de herramientas: no se pueden medir antes de ejecutar.</div>}
        </div>
      )}
      {modal?.type === 'full' && p && (
        <Modal title="Prompt completo (lo que envía esta app)" onClose={() => setModal(null)}>
          <h4>Instrucciones de sistema (se agregan a las de Claude Code) <Copy text={p.system} /></h4><pre className="small">{p.system}</pre>
          <h4>Mensaje del step <Copy text={p.user} /></h4><pre className="small">{p.user}</pre>
          <h4>Comando <Copy text={`claude ${p.cli.args.join(' ')}`} /></h4><pre className="small mono">claude {p.cli.args.join(' ')}</pre>
        </Modal>
      )}
      {modal?.type === 'file' && (
        <Modal title={`${modal.file.kind === 'skill' ? 'Skill' : 'Agente'}: ${modal.file.name}`} onClose={() => setModal(null)}>
          <div className="muted small mono">{modal.file.path}</div><pre className="small">{modal.file.content}</pre>
        </Modal>
      )}
      {modal?.type === 'diff' && (
        <Modal title="Diferencias con lo enviado en la última ejecución" onClose={() => setModal(null)}>
          {modal.none ? <p className="muted">{modal.none}</p> : !modal.sys.length && !modal.usr.length ? <p>Sin diferencias: con los mismos datos, hoy se enviaría exactamente lo mismo.</p> : (
            <>
              {[['Instrucciones de sistema', modal.sys], ['Mensaje del step', modal.usr]].map(([t, d]) => d.length > 0 && (
                <div key={t}><h4>{t}</h4><pre className="small diff">{d.map((x, i) => <div key={i} className={x.t === '+' ? 'add' : 'del'}>{x.t} {x.l}</div>)}</pre></div>
              ))}
              <p className="muted small">− lo que se envió · + lo que se enviaría ahora (mismos datos de entrada).</p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
