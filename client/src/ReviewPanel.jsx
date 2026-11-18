import React, { useEffect, useRef, useState } from 'react';
import { api, onWs, pendingSave } from './api.js';
import Chat, { PolicyView } from './Chat.jsx';

// 🩺 Revisión del flujo (spec 28). It only proposes: every change is applied by the person, one by one; what widens
// access is confirmed apart; it never says "approved" (what could not be verified is listed).
const SEV = { block: { icon: '⛔', label: 'va a fallar' }, risk: { icon: '⚠', label: 'riesgo' }, improve: { icon: '💡', label: 'mejora' } };
const REASONS = ['no aplica', 'es intencional', 'riesgo aceptado', 'lo hago después'];
const ROLE = { constructive: 'Producto + Arquitecto', adversarial: 'Adversarial' };
const confirmWiden = (list) => window.confirm(`Este cambio AMPLÍA EL ACCESO:\n\n${list.map((w) => `• ${w}`).join('\n')}\n\n¿Aplicarlo igual?`);

export default function ReviewPanel({ flow, running, onChange }) {
  const [lint, setLint] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [reviews, setReviews] = useState({ items: [], active: null });
  const [rv, setRv] = useState(null);
  const [progress, setProgress] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [rehearsal, setRehearsal] = useState({ open: false, input: '', runId: null });
  const [safe, setSafe] = useState({ busy: false, result: '' });
  const timer = useRef(null);

  const load = async (fresh = false) => {
    try { setLint(await api.get(`/api/flows/${flow.id}/lint${fresh ? '?fresh=1' : ''}`)); setErr(''); } catch (e) { setErr(e.message); }
  };
  const loadReviews = async () => {
    try {
      const r = await api.get(`/api/flows/${flow.id}/reviews`);
      setReviews(r);
      if (r.items[0]) setRv(await api.get(`/api/flows/${flow.id}/reviews/${r.items[0].id}`)); else setRv(null);
    } catch {}
  };
  useEffect(() => { setLint(null); setRv(null); load(true); loadReviews(); }, [flow.id]);
  useEffect(() => onWs((m) => {
    if (m.flowId !== flow.id) return;
    if (m.type === 'review.progress') setProgress(m.role === 'adversarial' ? 'Revisor adversarial…' : 'Revisor de producto y arquitectura…');
    if (m.type === 'review.started') { setProgress('Preparando el dossier…'); loadReviews(); }
    if (m.type === 'review.done') { setProgress(''); loadReviews(); load(); }
    if (m.type === 'run.finished') { if (m.runId === rehearsal.runId) setRehearsal((r) => ({ ...r, runId: null, done: m.status })); clearTimeout(timer.current); timer.current = setTimeout(() => load(), 600); }
    if (m.type === 'flow.updated') { clearTimeout(timer.current); timer.current = setTimeout(() => load(), 1500); }
  }), [flow.id, rehearsal.runId]);

  async function applyFix(f) {
    setErr('');
    if (f.widens?.length && !confirmWiden(f.widens)) return;
    setBusy(f.fp);
    try {
      await pendingSave.flush();
      try { await api.post(`/api/flows/${flow.id}/lint/apply`, { fp: f.fp, ...(f.widens?.length ? { confirmWiden: f.widens } : {}) }); }
      catch (e) { if (e.code !== 'WIDEN_CONFIRM' || !confirmWiden(e.body?.widens || [e.message])) throw e; await api.post(`/api/flows/${flow.id}/lint/apply`, { fp: f.fp, confirmWiden: e.body?.widens || [] }); }
      await load();
    } catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function dismiss(f, reason) {
    try { await api.post(`/api/flows/${flow.id}/review/suppress`, { fp: f.fp, reason, anchor: f.anchor }); await load(); } catch (e) { setErr(e.message); }
  }
  async function discuss(text) {
    try { await pendingSave.flush(); await api.post(`/api/flows/${flow.id}/chat/_review`, { message: text }); document.querySelector('[data-testid="review-chat"]')?.scrollIntoView({ behavior: 'smooth' }); } catch (e) { setErr(e.message); }
  }
  async function startAi() {
    setErr('');
    try { await pendingSave.flush(); await api.post(`/api/flows/${flow.id}/reviews`, {}); setProgress('Preparando el dossier…'); loadReviews(); } catch (e) { setErr(e.message); }
  }
  const applySafe = async () => {
    setSafe({ busy: true, result: '' });
    try {
      await pendingSave.flush();
      const r = await api.post(`/api/flows/${flow.id}/reviews/${rv.id}/apply-safe`, {});
      setSafe({ busy: false, result: r.applied.length ? `Aplicadas ${r.applied.length}. Versión guardada antes: «${r.version?.label}».${r.skipped.length ? ` Quedan ${r.skipped.length} para decidir aparte (amplían acceso, quitan algo o tienen un problema).` : ''}` : `Nada seguro para aplicar${r.skipped.length ? `: las ${r.skipped.length} abiertas amplían acceso o quitan algo, decídelas una por una.` : '.'}` });
      load(); loadReviews();
    } catch (e) { setSafe({ busy: false, result: '' }); setErr(e.message); }
  };
  async function startRehearsal() {
    setErr('');
    try { await pendingSave.flush(); const r = await api.post(`/api/flows/${flow.id}/rehearsal`, { input: rehearsal.input }); setRehearsal((x) => ({ ...x, open: false, runId: r.runId, done: null })); } catch (e) { setErr(e.message); }
  }
  async function applyAi(f) {
    const msgs = await api.get(`/api/flows/${flow.id}/chat/_review`);
    const msg = msgs.find((m) => m.id === rv?.messageId);
    const p = msg?.proposals?.find((x) => x.id === f.proposalId);
    if (!p) return setErr('No encuentro la propuesta: revisa el chat de abajo.');
    if (p.applied || p.discarded) return setErr('Esa propuesta ya se aplicó o se descartó.');
    if (p.widens?.length && !confirmWiden(p.widens)) return;
    try {
      await pendingSave.flush();
      await api.post(`/api/flows/${flow.id}/chat/_review/apply`, { messageId: msg.id, proposalId: p.id, ...(p.widens?.length ? { confirmWiden: p.widens } : {}) });
      await loadReviews(); await load();
    } catch (e) { setErr(e.message); }
  }
  async function dismissAi(f, reason) {
    try {
      if (f.proposalId && rv?.messageId) await api.post(`/api/flows/${flow.id}/chat/_review/discard`, { messageId: rv.messageId, proposalId: f.proposalId }).catch(() => {});
      await api.post(`/api/flows/${flow.id}/review/suppress`, { fp: f.fp, reason, anchor: f.anchor });
      await loadReviews();
    } catch (e) { setErr(e.message); }
  }

  const findings = lint?.findings || [];
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const visible = showAll ? findings : findings.slice(0, 7);
  const aiRunning = !!reviews.active || rv?.status === 'running';
  const estChars = (findings.length * 300) + JSON.stringify(flow.steps).length;

  return (
    <div className="panel-body pad review-panel" data-testid="review-panel">
      <div className="ctx-block">
        <div className="ctx-title">🩺 Revisión del flujo <span className="muted small">— encuentra lo que lo haría fallar antes de que lo descubra quien lo usa</span></div>
        <div className="row wrap">
          <span className="chip sev-block" title="va a fallar">⛔ {count('block')}</span>
          <span className="chip sev-risk" title="riesgo">⚠ {count('risk')}</span>
          <span className="chip sev-improve" title="mejora">💡 {count('improve')}</span>
          <button className="ghost small" onClick={() => load(true)} title="Chequeo instantáneo: reglas, máquina y últimas ejecuciones (no usa Claude)">↻ Revisar ahora</button>
          <button className="small" disabled={running || !!rehearsal.runId} onClick={() => setRehearsal((r) => ({ ...r, open: !r.open }))} data-testid="rehearsal-btn">🧪 Ensayo</button>
          <button className="primary small" disabled={running || aiRunning} onClick={startAi} data-testid="ai-review-btn" title={`2 llamadas independientes a Claude (${'Sonnet'}): producto+arquitecto y adversarial. ≈ ${Math.round(Math.min(40000, estChars + 8000) / 4 / 1000 * 2)}k tokens de entrada.`}>🤖 Revisión con IA</button>
        </div>
        <p className="muted small">Nunca dice «aprobado»: lo que no se pudo comprobar aparece abajo. Nada cambia hasta que aplicas cada propuesta; lo que amplía el acceso se confirma aparte.</p>
        {running && <div className="chat-locked small">⏵ El flujo se está ejecutando: la revisión con IA, el ensayo y los cambios esperan a que termine.</div>}
        {rehearsal.open && (
          <div className="rehearsal-box">
            <p className="small">El <b>ensayo</b> corre el flujo entero para ver qué haría: los steps de IA en modo plan y sin herramientas de escritura (describen lo que harían y lo que les falta); no corren hooks ni aserciones con comando; se omiten los comandos que reconoce como escritura, borrado, despliegue o suites/herramientas sobre ambientes (la lista queda en la ejecución). <b>Un comando que no reconoce sí corre</b> (con tope de tiempo): revisa los steps de comando antes. No toca la última ejecución real.</p>
            <div className="row"><input style={{ flex: 1 }} value={rehearsal.input} onChange={(e) => setRehearsal((r) => ({ ...r, input: e.target.value }))} placeholder="Input del ensayo (por ejemplo, un ticket ya terminado)" /><button className="primary small" onClick={startRehearsal}>Ensayar</button></div>
          </div>
        )}
        {rehearsal.runId && <div className="small">🧪 Ensayo en curso ({rehearsal.runId})… los hallazgos se actualizan al terminar.</div>}
        {rehearsal.done && <div className="small ok-text">🧪 Ensayo terminado ({rehearsal.done}). Mira los hallazgos de abajo.</div>}
        {err && <div className="error-bar">{err}</div>}
      </div>

      <div className="ctx-block" data-testid="lint-findings">
        <div className="ctx-title">Chequeo instantáneo <span className="muted small">— reglas, máquina y últimas ejecuciones · sin costo</span></div>
        {!lint && <div className="muted small"><span className="spinner" /> revisando…</div>}
        {lint && !findings.length && <div className="small ok-text">Sin hallazgos en lo que se puede comprobar sin ejecutar. Eso no significa que el flujo funcione: prueba un 🧪 ensayo.</div>}
        {visible.map((f) => (
          <Finding key={f.fp} f={f} busy={busy === f.fp} locked={running}
            onApply={f.fix ? () => applyFix(f) : null} onDismiss={(r) => dismiss(f, r)}
            onDiscuss={() => discuss(`Hablemos de este hallazgo${f.stepName ? ` en «${f.stepName}»` : ''}: ${f.title}. ${f.detail}`)} />
        ))}
        {findings.length > 7 && <a className="small" onClick={() => setShowAll(!showAll)}>{showAll ? 'ver menos' : `ver ${findings.length - 7} más`}</a>}
        {lint?.hidden?.length > 0 && (
          <details className="small"><summary>Descartados ({lint.hidden.length})</summary>
            {lint.hidden.map((h) => <div key={h.fp} className="row"><span>{h.title} — <i>{h.reason}</i></span><a onClick={() => api.post(`/api/flows/${flow.id}/review/unsuppress`, { fp: h.fp }).then(() => load())}>volver a mostrar</a></div>)}
          </details>
        )}
      </div>

      <div className="ctx-block" data-testid="ai-review">
        <div className="ctx-title">Revisión con IA <span className="muted small">— dos revisores independientes; el código une sus hallazgos y muestra los desacuerdos</span></div>
        {aiRunning && <div className="small"><span className="spinner" /> {progress || 'Revisando…'} <a onClick={() => api.post(`/api/flows/${flow.id}/reviews/${reviews.active || rv?.id}/cancel`, {}).then(loadReviews).catch(() => {})}>cancelar</a></div>}
        {!rv && !aiRunning && <div className="muted small">Todavía no se pidió. Úsala cuando el chequeo instantáneo y el ensayo no muestran problemas, o para discutir el diseño.</div>}
        {rv && !aiRunning && (
          <>
            <div className="small muted">{rv.id} · {rv.status}{rv.stale ? ' · ⚠ el flujo cambió desde esta revisión' : ''}{rv.totals?.inputTokens ? ` · tokens ${rv.totals.inputTokens}/${rv.totals.outputTokens}` : ''}{rv.error ? ` · ${rv.error}` : ''}</div>
            {(rv.findings || []).some((f) => f.proposalId) && (
              <div className="row small">
                <button className="small" disabled={running || safe.busy} onClick={applySafe} data-testid="apply-safe" title="Aplica las propuestas que no amplían acceso ni quitan nada. Antes guarda una versión del flujo (se restaura desde 🕘 Versiones).">✅ Aplicar las seguras</button>
                {safe.result && <span data-testid="apply-safe-result">{safe.result}</span>}
              </div>
            )}
            {(rv.facts || []).length > 0 && (
              <details className="small" data-testid="review-facts"><summary>🔎 Hechos investigados ({rv.facts.length}) — verificados contra la evidencia de las ejecuciones y git</summary>
                <ol>{rv.facts.map((x, i) => <li key={i}>{x.step ? <b>{x.step}: </b> : null}{x.claim}{x.evidence.filter((e) => e.verified).map((e, j) => <div key={j} className="muted">{e.ref}: «{e.quote}»</div>)}</li>)}</ol>
              </details>
            )}
            {(rv.findings || []).map((f) => (
              <Finding key={f.id} f={{ ...f, title: f.claim, detail: f.check ? `Cómo se comprueba: ${f.check}` : '' }} ai locked={running}
                onApply={f.proposalId ? () => applyAi(f) : null} onDismiss={(r) => dismissAi(f, r)}
                onDiscuss={() => discuss(`Sobre el hallazgo ${f.id}${f.stepName ? ` en «${f.stepName}»` : ''}: ${f.claim}${f.dissent ? ` (hay desacuerdo: ${f.dissent})` : ''}. ¿Qué recomiendan?`)} />
            ))}
          </>
        )}
      </div>

      {((lint?.notVerifiable || []).length > 0 || (rv?.notVerifiable || []).length > 0) && (
        <div className="ctx-block" data-testid="not-verifiable">
          <div className="ctx-title">No se pudo verificar</div>
          <ul className="small">{[...new Set([...(lint?.notVerifiable || []), ...(rv?.notVerifiable || [])])].map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}

      <div className="ctx-block" data-testid="flow-policies">
        <div className="ctx-title">📜 Reglas (políticas) <span className="muted small">— lo que el equipo no quiere repetir en cada flujo</span></div>
        <PoliciesEditor scope="flow" value={flow.policies || []} onSave={(list) => onChange({ policies: list })} />
        {lint?.policies?.machine?.length > 0 && (
          <details className="small"><summary>De esta instalación ({lint.policies.machine.length}) — se editan en ⚙ Configuración › Reglas</summary>
            {lint.policies.machine.map((p) => <PolicyView key={p.id} policy={p} />)}
          </details>
        )}
      </div>

      <div className="ctx-block" data-testid="review-chat">
        <div className="ctx-title">💬 Discutir la revisión <span className="muted small">— con @producto, @arquitecto o @adversarial</span></div>
        <Chat flowId={flow.id} chatKey="_review" vars={flow.vars} compact onApplied={() => { load(); loadReviews(); }}
          locked={running ? 'El flujo se está ejecutando y sigue su proceso: la revisión vuelve cuando termine.' : ''}
          placeholder="Pregunta por un hallazgo, pide alternativas o una regla nueva. Las tres miradas responden; el desacuerdo se muestra y decides tú. Nada cambia hasta que aplicas una propuesta." />
      </div>
    </div>
  );
}

function Finding({ f, ai, busy, locked, onApply, onDismiss, onDiscuss }) {
  const [ev, setEv] = useState(false);
  const [why, setWhy] = useState(false);
  const s = SEV[f.severity] || SEV.risk;
  return (
    <div className={`finding sev-${f.severity}`} data-testid="finding" data-rule={f.rule || f.category}>
      <div className="finding-head">
        <span title={s.label}>{s.icon}</span>
        <b>{f.title}</b>
        {f.stepName && <span className="chip">{f.stepName}</span>}
        {ai && (f.sources || []).map((r) => <span key={r} className="chip">{ROLE[r] || r}</span>)}
        {ai && !f.verified && <span className="chip warn" title="ninguna de sus citas se encontró en el flujo o en las ejecuciones">sin evidencia verificable</span>}
      </div>
      {f.detail && <div className="small">{f.detail}</div>}
      {f.dissent && <div className="small dissent">↔ {f.dissent}</div>}
      {f.also && <div className="small muted">También: {f.also}</div>}
      {f.evidence?.length > 0 && <a className="small" onClick={() => setEv(!ev)}>{ev ? 'ocultar evidencia' : `evidencia (${f.evidence.length})`}</a>}
      {ev && <ul className="small evidence">{f.evidence.map((e, i) => <li key={i}><span className="chip">{e.type}{e.runId ? ` ${e.runId}` : ''}</span>{e.verified === false ? ' ✗ ' : ' '}<code>{e.quote}</code></li>)}</ul>}
      {f.fix?.label && <div className="small">Arreglo: {f.fix.label}{f.check ? ` · se comprueba: ${f.check}` : ''}</div>}
      {f.widens?.length > 0 && <div className="widens small" data-testid="widens">⚠ Amplía el acceso (se confirma aparte): {f.widens.join(' · ')}</div>}
      <div className="proposal-actions">
        {onApply && <button className={`${f.widens?.length ? 'danger' : 'primary'} small`} disabled={busy || locked} onClick={onApply}>{f.fix?.kind === 'action' ? f.fix.label : f.widens?.length ? 'Aplicar (amplía acceso)' : 'Aplicar'}</button>}
        <button className="ghost small" onClick={onDiscuss}>Discutir</button>
        {!why ? <button className="ghost small" onClick={() => setWhy(true)}>Descartar</button> : (
          <select autoFocus defaultValue="" onChange={(e) => { if (e.target.value) onDismiss(e.target.value); setWhy(false); }} onBlur={() => setWhy(false)}>
            <option value="" disabled>¿Por qué?</option>
            {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

const TYPES = {
  noExternalWrites: { label: 'No escribir en sistemas externos sin pedido', params: [] },
  defaultEnv: { label: 'Ambiente por defecto', params: [['var', 'variable (p. ej. env)'], ['value', 'valor (p. ej. qa)']] },
  noCoAuthorTrailer: { label: 'Commits y PRs sin Co-Authored-By', params: [] },
  gitAuthor: { label: 'Autor de los commits', params: [['name', 'nombre'], ['email', 'email']] },
  ticketStatus: { label: 'Estado requerido del ticket', params: [['statuses', 'estados (p. ej. Ready For Testing)']] },
  noParallelRuns: { label: 'Nunca dos ejecuciones a la vez', params: [] },
  note: { label: 'Regla o lección (texto)', params: [] },
};
/** Editor of a policy list (flow: saved with the flow; machine: PUT /api/policies). */
let typesCache = null; // what each type guarantees and what not (server: policies.js POLICY_TYPES)
export function PoliciesEditor({ scope, value, onSave }) {
  const [draft, setDraft] = useState({ type: 'noExternalWrites', text: '', params: {} });
  const [err, setErr] = useState('');
  const [types, setTypes] = useState(typesCache);
  useEffect(() => { if (!typesCache) api.get('/api/policies').then((r) => { typesCache = r.types; setTypes(r.types); }).catch(() => {}); }, []);
  const def = TYPES[draft.type];
  const add = async () => {
    setErr('');
    for (const [k] of def.params) if (!String(draft.params[k] || '').trim()) return setErr(`Falta «${k}»`);
    if (draft.type === 'note' && !draft.text.trim()) return setErr('Escribe la regla');
    try { await onSave([...(value || []), { type: draft.type, text: draft.text.trim() || def.label, params: draft.params, scope }]); setDraft({ type: draft.type, text: '', params: {} }); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="policies">
      {!(value || []).length && <div className="muted small">Sin reglas{scope === 'flow' ? ' propias de este flujo' : ''}.</div>}
      {(value || []).map((p) => (
        <div key={p.id || p.text} className="policy-row">
          <PolicyView policy={{ ...p, label: TYPES[p.type]?.label || p.type, guarantee: p.guarantee || types?.[p.type]?.guarantee, notGuaranteed: p.notGuaranteed || types?.[p.type]?.notGuaranteed }} />
          <div className="row">
            <label className="small"><input type="checkbox" checked={p.enabled !== false} onChange={(e) => onSave(value.map((x) => (x === p ? { ...x, enabled: e.target.checked } : x)))} /> activa</label>
            <a className="small" onClick={() => onSave(value.filter((x) => x !== p))}>quitar</a>
          </div>
        </div>
      ))}
      <div className="row wrap policy-add">
        <select value={draft.type} onChange={(e) => setDraft({ type: e.target.value, text: '', params: {} })}>{Object.entries(TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select>
        {def.params.map(([k, ph]) => <input key={k} placeholder={ph} value={draft.params[k] || ''} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [k]: e.target.value } })} />)}
        <input style={{ flex: 1, minWidth: 160 }} placeholder={draft.type === 'note' ? 'La regla o lección, en una frase' : 'Texto (opcional)'} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <button className="small" onClick={add}>Agregar regla</button>
      </div>
      {err && <div className="warn-text small">{err}</div>}
    </div>
  );
}
