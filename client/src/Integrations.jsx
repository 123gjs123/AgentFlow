// Integration helper (spec 17 INT): pick who calls, describe it, get ready-to-paste code (templates or AI), test it.
import React, { useEffect, useState } from 'react';
import { api, pendingSave } from './api.js';

const ICON = { 'jira-cloud': '🟦', 'jira-dc': '🟦', 'jenkins-declarative': '🧔', 'jenkins-scripted': '🧔', 'github-actions': '🐙', 'bitbucket-pipelines': '🪣', 'gitlab-ci': '🦊', 'powershell-task': '⏰', 'bash-cron': '🐚', python: '🐍', 'claude-mcp': '🤖', webhook: '🔗' };
const LOC = { cloud: 'en la nube', onprem: 'en otra máquina de tu red', local: 'en esta PC' };
const REACH = { 'ok-local': ['ok', 'Llega directo (misma PC)'], 'ok-lan': ['ok', 'Llega por tu red local'], 'ok-public': ['ok', 'Llega por tu URL pública'], 'needs-host': ['warn', 'Todavía no llega'], 'needs-tunnel': ['warn', 'Todavía no llega: necesita una URL pública'] };

const CopyBtn = ({ text, onCopy }) => { const [ok, setOk] = useState(false); return <button className="small" onClick={() => { navigator.clipboard.writeText(text); setOk(true); onCopy?.(); setTimeout(() => setOk(false), 1200); }}>{ok ? '✓ copiado' : 'Copiar'}</button>; };

export default function IntegrationWizard({ flow }) {
  const [callers, setCallers] = useState([]);
  const [caller, setCaller] = useState(null);
  const [desc, setDesc] = useState('');
  const [opt, setOpt] = useState({ step: '', location: '', mode: '', input: '', vars: {}, idempotencyKey: '', timeoutSec: 1800 });
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [fileTab, setFileTab] = useState(0);
  const [publicUrl, setPublicUrl] = useState('');
  const [test, setTest] = useState(null);
  const [inbound, setInbound] = useState([]);
  const [info, setInfo] = useState(null);

  useEffect(() => { api.get('/api/integrations/callers').then(setCallers); api.get('/api/info').then((i) => { setInfo(i); setPublicUrl(i.publicUrl || ''); }); }, []);
  // Inbound calls: turns green when the first real call with this source arrives.
  useEffect(() => {
    if (!out) return;
    const since = Date.now() - 5 * 60000;
    const tick = () => api.get(`/api/integrations/inbound?since=${since}`).then(setInbound).catch(() => {});
    tick(); const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [out]);

  const c = callers.find((x) => x.id === caller);
  const varKeys = Object.keys(flow.vars || {});
  const pick = (id) => { setCaller(id); setOut(null); setTest(null); setOpt((o) => ({ ...o, location: '', mode: '', input: '', idempotencyKey: '' })); };

  async function generate(ai) {
    setErr(''); setBusy(ai ? 'ai' : 'tpl'); setTest(null);
    try {
      const vars = Object.fromEntries(Object.entries(opt.vars).filter(([, v]) => String(v).trim()));
      const options = { ...opt, vars, step: opt.step || undefined, location: opt.location || undefined, mode: opt.mode || undefined, input: opt.input || undefined, idempotencyKey: opt.idempotencyKey || undefined };
      const r = await api.post('/api/integrations/generate', { flow: flow.id, caller, description: desc, options, ai });
      setOut(r); setFileTab(0);
    } catch (e) { setErr(e.message); }
    setBusy('');
  }

  async function dryRun(real) {
    await pendingSave.flush().catch(() => {});
    setTest({ busy: true });
    try {
      const m = out.mapping || {};
      const sampleOf = (s) => String(s ?? '').replace(/\{\{[^}]+\}\}/g, 'EJEMPLO-1').replace(/\{[A-Z_][A-Z0-9_]*\}/g, 'ejemplo');
      const body = { input: sampleOf(m.input), vars: Object.fromEntries(Object.entries(m.vars || {}).map(([k, v]) => [k, sampleOf(v)])), source: caller || 'test', ...(opt.step ? { step: opt.step } : {}), ...(real ? {} : { dryRun: true }) };
      const keyHdr = m.idempotencyKey ? { 'Idempotency-Key': `${sampleOf(m.idempotencyKey)}-${Date.now()}` } : {};
      const r = await fetch(`/api/ext/flows/${encodeURIComponent(flow.id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}`, ...keyHdr }, body: JSON.stringify(body) });
      setTest({ status: r.status, body: await r.json().catch(() => ({})), real, sent: body });
    } catch (e) { setTest({ error: e.message }); }
  }

  const reach = out?.reachability;
  const files = out?.files || [];
  const lintErr = out?.lint?.errors || [];
  const src = caller || '';
  // The MCP server is not generated per caller: it always sends source "mcp".
  const seen = inbound.filter((e) => e.source === src || (caller === 'claude-mcp' && e.source === 'mcp'));
  const lastSeen = seen[seen.length - 1];

  return (
    <div className="wizard">
      <h4>Asistente de integración</h4>
      <p className="muted small">Elige desde dónde se va a llamar a este flujo y describe cuándo. Te genero el código o la configuración listos para pegar; el token nunca queda escrito en el código.</p>

      <div className="wz-step"><b>1 · ¿Quién llama?</b></div>
      <div className="caller-grid">
        {callers.map((x) => (
          <button key={x.id} className={`caller ${caller === x.id ? 'on' : ''}`} onClick={() => pick(x.id)} title={`${LOC[x.location]} · secreto: ${x.secretStore}`}>
            <span className="ic">{ICON[x.id]}</span><span>{x.label}</span>
          </button>
        ))}
      </div>

      {c && (
        <>
          <div className="wz-step"><b>2 · ¿Qué tiene que pasar?</b></div>
          <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={c.id.startsWith('jira') ? 'Ej: cuando un ticket de SBK pasa a "QA", ejecutar el flujo con la clave del ticket y comentar el resultado en el ticket.' : c.id.startsWith('jenkins') || /github|bitbucket|gitlab/.test(c.id) ? 'Ej: después de desplegar en staging, correr el flujo con el número de build y el commit; si falla, que falle el pipeline.' : 'Ej: todos los días a las 8, revisar los tickets pendientes y dejar el resumen.'} />
          <div className="row wrap">
            <label className="field small"><span className="field-label">Dónde corre</span>
              <select value={opt.location || c.location} onChange={(e) => setOpt({ ...opt, location: e.target.value })}>
                {Object.entries(LOC).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="field small"><span className="field-label">Qué ejecutar</span>
              <select value={opt.step} onChange={(e) => setOpt({ ...opt, step: e.target.value })}>
                <option value="">todo el flujo</option>
                {flow.steps.map((s) => <option key={s.id} value={s.name}>solo "{s.name}"</option>)}
              </select></label>
            <label className="field small"><span className="field-label">¿Espera el resultado?</span>
              <select value={opt.mode} onChange={(e) => setOpt({ ...opt, mode: e.target.value })}>
                <option value="">automático</option>
                <option value="wait">sí, espera (CI: falla el job si falla)</option>
                <option value="async-poll">sí, consultando cada 10 s (largos)</option>
                <option value="fire-and-forget">no, solo dispara</option>
              </select></label>
          </div>
          {varKeys.length > 0 && (
            <div className="field small"><span className="field-label">Variables del flujo ← qué dato del que llama <span className="hint">(vacío = valor por defecto del flujo)</span></span>
              {varKeys.map((k) => (
                <div key={k} className="row"><code style={{ minWidth: 90 }}>{k}</code>
                  <input className="mono" value={opt.vars[k] || ''} onChange={(e) => setOpt({ ...opt, vars: { ...opt.vars, [k]: e.target.value } })} placeholder={c.id.startsWith('jira') ? '{{issue.key}}' : c.id.startsWith('jenkins') ? '${BUILD_NUMBER}' : c.id === 'github-actions' ? '${{ github.sha }}' : 'valor'} />
                </div>
              ))}
            </div>
          )}
          <details className="advanced"><summary>Más opciones</summary>
            <label className="field small"><span className="field-label">Input del flujo (expresión del que llama)</span><input className="mono" value={opt.input} onChange={(e) => setOpt({ ...opt, input: e.target.value })} placeholder="por defecto, uno típico para este origen" /></label>
            <label className="field small"><span className="field-label">Idempotency-Key <span className="hint">— evita ejecuciones duplicadas si el que llama reintenta</span></span><input className="mono" value={opt.idempotencyKey} onChange={(e) => setOpt({ ...opt, idempotencyKey: e.target.value })} placeholder={`por defecto: ${c.naturalId}`} /></label>
            <label className="field small"><span className="field-label">Tiempo máximo de espera (s)</span><input type="number" style={{ width: 110 }} value={opt.timeoutSec} onChange={(e) => setOpt({ ...opt, timeoutSec: Number(e.target.value) })} /></label>
          </details>

          <div className="wz-step"><b>3 · Generar</b></div>
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={() => generate(false)}>{busy === 'tpl' ? 'Generando…' : 'Generar (plantilla)'}</button>
            <button disabled={!!busy || !desc.trim()} onClick={() => generate(true)} title={desc.trim() ? 'Claude adapta la plantilla a tu descripción (disparador, condiciones, mapeo) y se valida' : 'Escribe arriba qué tiene que pasar'}>{busy === 'ai' ? <><span className="spinner" /> Adaptando con IA…</> : '✨ Adaptar con IA a mi descripción'}</button>
          </div>
          {err && <div className="error-bar">{err}</div>}
        </>
      )}

      {out && (
        <div className="wz-out">
          {reach && (
            <div className={`reach ${REACH[reach.status]?.[0]}`}>
              <b>Cómo llega la llamada: {REACH[reach.status]?.[1]}</b>
              <div className="small">{reach.explanation}</div>
              {reach.options?.length > 0 && (
                <ol className="small">{reach.options.map((o) => <li key={o.id}><b>{o.title}</b> — {o.detail} <span className="muted">(expone: {o.exposes})</span>{o.config && <details><summary>config.yml de cloudflared</summary><pre className="mono small">{o.config}</pre><CopyBtn text={o.config} /></details>}</li>)}</ol>
              )}
              {(reach.status === 'needs-tunnel' || reach.status === 'ok-public') && (
                <div className="row small">URL pública (la de tu túnel): <input className="mono" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://afs.tu-dominio.com" /><button className="small" onClick={async () => { try { await api.put('/api/info/public-url', { url: publicUrl }); generate(false); } catch (e) { setErr(e.message); } }}>Usar y regenerar</button></div>
              )}
            </div>
          )}
          {out.ai?.used && <div className="muted small">✨ Adaptado con IA ({out.ai.model}{out.ai.corrected ? ', con 1 corrección automática' : ''}) · tokens {out.ai.usage?.inputTokens}/{out.ai.usage?.outputTokens}. Revísalo antes de usarlo.</div>}
          {lintErr.length > 0 && <div className="error-bar">El código generado tiene problemas y no se puede copiar: {lintErr.map((e) => e.message).join(' · ')}. Usa "Generar (plantilla)".</div>}
          {out.lint?.warnings?.length > 0 && <ul className="small">{out.lint.warnings.map((w, i) => <li key={i} className="warn-text">⚠ {w.message}</li>)}</ul>}

          {out.setup?.length > 0 && <><h5>Pasos</h5><ol className="small">{out.setup.map((s, i) => <li key={i}>{s}</li>)}</ol></>}
          <div className="tabs small">{files.map((f, i) => <button key={f.name} className={fileTab === i ? 'active' : ''} onClick={() => setFileTab(i)}>{f.name}</button>)}</div>
          {files[fileTab] && (
            <div className="wz-file">
              <div className="row end">{!lintErr.length && <CopyBtn text={files[fileTab].content} onCopy={() => { try { localStorage.setItem('afs.didExternal', '1'); } catch {} }} />}</div>
              <pre className="mono small">{files[fileTab].content}</pre>
            </div>
          )}
          {out.notes?.length > 0 && <><h5>Notas</h5><ul className="small">{out.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
          {out.assumptions?.length > 0 && <><h5>Supuestos de la IA</h5><ul className="small muted">{out.assumptions.map((n, i) => <li key={i}>{n}</li>)}</ul></>}

          <h5>Probar</h5>
          <div className="row">
            <button className="small" onClick={() => dryRun(false)} disabled={test?.busy}>Probar (sin ejecutar)</button>
            <button className="small ghost" disabled={!test || test.busy || test.status !== 200 || test.real} onClick={() => confirm('Esto ejecuta el flujo de verdad (usa tu suscripción y hace las acciones del flujo, p. ej. comentarios en Jira). ¿Seguir?') && dryRun(true)}>Ejecutar de verdad</button>
          </div>
          {test && !test.busy && (
            <div className={`small ${test.status === 200 ? 'ok-text' : 'warn-text'}`}>
              {test.error ? `Error: ${test.error}` : test.real ? `HTTP ${test.status}: ejecución ${test.body.runId} iniciada (mírala en Ejecuciones).` : test.status === 200 ? `✓ La llamada es válida: ejecutaría ${test.body.steps.join(' → ')}${test.body.warnings?.length ? ` · ⚠ ${test.body.warnings.join(', ')}` : ''}` : `HTTP ${test.status}: ${test.body.code || ''} ${test.body.error || ''}`}
              {test.sent && <details><summary>cuerpo enviado (datos de ejemplo)</summary><pre className="mono small">{JSON.stringify(test.sent, null, 2)}</pre></details>}
            </div>
          )}
          <div className={`inbound small ${lastSeen ? (lastSeen.status < 300 ? 'ok' : 'warn') : ''}`}>
            {lastSeen
              ? <>Última llamada recibida desde "{lastSeen.source}": {new Date(lastSeen.at).toLocaleTimeString()} · HTTP {lastSeen.status}{lastSeen.status === 401 ? ' (llegó, pero sin token válido)' : ''}{lastSeen.dryRun ? ' · prueba' : ''}{lastSeen.forwardedFor ? ` · vía proxy/túnel (${lastSeen.forwardedFor})` : ''}</>
              : <>⏳ Esperando la primera llamada real desde {c?.label}… (configura el origen y dispáralo)</>}
          </div>
        </div>
      )}
    </div>
  );
}
