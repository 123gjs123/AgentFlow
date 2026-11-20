// Spec 12: how to call THIS step from outside (CI, scripts, schedulers, webhooks, Claude Code). The server builds the
// snippets (real host, port, flow id and the step's stable slug); the token is never inside them (AFS_TOKEN).
import React, { useEffect, useState } from 'react';
import { api, pendingSave } from './api.js';
import IntegrationWizard from './Integrations.jsx';

const slugify = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const Copy = ({ text, testId }) => { const [ok, setOk] = useState(false); return <button className="small" data-testid={testId} onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>{ok ? '✓ copiado' : 'Copiar'}</button>; };

export default function StepInvoke({ flow, step }) {
  const [scope, setScope] = useState('only');
  const [inv, setInv] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('curl');
  const [draft, setDraft] = useState('');
  const [token, setToken] = useState(null);
  const [slugErr, setSlugErr] = useState('');
  const [bump, setBump] = useState(0);
  // the slug lives on the server (the flow saved by the canvas never carries it): shown and edited from there
  useEffect(() => { if (inv?.slug) setDraft(inv.slug); }, [inv?.slug]);
  useEffect(() => {
    let off = false;
    (async () => {
      try { await pendingSave.flush(); const r = await api.get(`/api/flows/${flow.id}/steps/${step.id}/invoke?scope=${scope}`); if (!off) { setInv(r); setErr(''); } }
      catch (e) { if (!off) setErr(e.message); }
    })();
    return () => { off = true; };
  }, [flow.id, step.id, scope, flow.rev, bump]);

  const v = slugify(draft);
  const saveSlug = async () => {
    if (!inv || v === inv.slug) { setSlugErr(''); setDraft(inv?.slug || ''); return; }
    if (!SLUG_RE.test(v)) { setSlugErr('Letras, números y guiones'); return; }
    try { await api.put(`/api/flows/${flow.id}/steps/${step.id}/slug`, { slug: v }); setSlugErr(''); setBump((n) => n + 1); }
    catch (e) { setSlugErr(e.message); }
  };
  const sn = inv?.snippets?.find((x) => x.id === tab) || inv?.snippets?.[0];
  const c = inv?.contract;
  return (
    <div className="panel-body pad" data-testid="step-invoke">
      <p className="muted small">Llama a este step desde Jenkins, un script, un programador de tareas, un webhook o Claude Code. Lo que pegues ya trae el host, el puerto, el flujo y el step.</p>
      <label className="field small"><span className="field-label">Slug (dirección estable del step: no cambia si lo renombras)</span>
        <div className="row">
          <input className="mono" data-testid="invoke-slug" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={saveSlug} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          {slugErr && <span className="warn-text small">{slugErr}</span>}
        </div>
      </label>
      <div className="seg" data-testid="invoke-scope">
        <button className={scope === 'only' ? 'active' : ''} onClick={() => setScope('only')}>Solo este step</button>
        <button className={scope === 'from' ? 'active' : ''} onClick={() => setScope('from')}>Este y los que siguen</button>
      </div>
      {err && <div className="warn-text small">{err}</div>}
      {inv && (<>
        {['needs-host', 'needs-tunnel'].includes(inv.reach.status) && (
          <div className="callout warn small" data-testid="invoke-reach">
            <b>Desde otra máquina todavía no llega.</b> {inv.reach.explanation}
            <ul>{inv.reach.options.map((o) => <li key={o.id}><b>{o.title}:</b> {o.detail}{o.exposes ? <span className="muted"> (expone: {o.exposes})</span> : null}</li>)}</ul>
            <span className="muted">Además: abre el puerto en el firewall solo para la IP que llama; si es por VPN, usa la IP de la VPN.</span>
          </div>
        )}
        <div className="ctx-block" data-testid="invoke-contract">
          <div className="ctx-title">Qué recibe y qué devuelve</div>
          <ul className="small">
            <li><b>input</b>: {c.usesInput ? 'el texto o JSON que mandes llega como {{input}}' : 'este step no usa {{input}} (puedes mandarlo vacío)'}</li>
            {c.vars.length > 0 && <li><b>vars</b>: {c.vars.map((x) => <code key={x.name} title={x.inFlow ? 'tiene valor por defecto en el flujo' : 'no tiene valor en el flujo: mándala'}>{x.name}{x.inFlow ? '' : ' (sin valor por defecto)'} </code>)}</li>}
            {c.upstream.length > 0 && <li><b>antes</b>: usa la última salida de {c.upstream.map((x) => `«${x}»`).join(', ')} (no se vuelven a ejecutar)</li>}
            <li><b>se ejecuta</b>: {c.steps.map((x) => `«${x}»`).join(' → ')}</li>
            <li><b>devuelve</b>: salida en {c.output}{c.deliverables.length ? ` · 📄 ${c.deliverables.join(', ')}` : ''}</li>
            {c.writesOutside.length > 0 && <li className="warn-text"><b>⚡ escribe fuera</b>: {c.writesOutside.join('; ')}</li>}
          </ul>
        </div>
        <div className="tabs small" data-testid="invoke-tabs">
          {inv.snippets.map((x) => <button key={x.id} className={sn?.id === x.id ? 'active' : ''} onClick={() => setTab(x.id)}>{x.label}</button>)}
        </div>
        {sn && (<div data-testid="invoke-snippet" data-id={sn.id}>
          <div className="row"><span className="muted small grow">{sn.note} {sn.where === 'remote' ? `· ${inv.reach.base}` : '· esta PC'}</span><Copy text={sn.content} testId="invoke-copy" /></div>
          <pre className="mono small code">{sn.content}</pre>
        </div>)}
        <div className="small muted">
          El token no va dentro del código: guárdalo como <code>AFS_TOKEN</code> (en Jenkins, una credencial <i>Secret text</i> llamada <code>{inv.credId || 'afs-token'}</code>). Es el <b>token de este flujo</b>: solo abre este flujo.{' '}
          {token ? <><code className="mono" data-testid="invoke-token">{token}</code> <Copy text={token} /> <button className="ghost small danger" onClick={async () => { if (confirm('¿Regenerar el token de este flujo? Lo que use el anterior dejará de funcionar.')) setToken((await api.post(`/api/flows/${flow.id}/token`, {})).token); }}>regenerar</button></>
            : <button className="ghost small" data-testid="invoke-show-token" onClick={async () => { try { const m = await api.get(`/api/flows/${flow.id}/token?reveal=1`); setToken(m.exists ? m.token : (await api.post(`/api/flows/${flow.id}/token`, {})).token); } catch (e) { setErr(e.message); } }}>Mostrar token del flujo</button>}
          {' · '}<a href={`/api/flows/${flow.id}/invoke.md`} target="_blank" rel="noreferrer">INVOKE.md del flujo</a>
        </div>
        <details className="small"><summary>GitHub Actions, Bitbucket, GitLab, Jira… (asistente de integración)</summary>
          <IntegrationWizard flow={flow} initialStep={step.id} initialScope={scope} key={`${step.id}-${scope}-${inv.slug}`} />
        </details>
      </>)}
    </div>
  );
}
