// Credenciales (spec 26; lives in ⚙ Configuración since spec 27): the tokens flows need, in one place. Values are encrypted on this machine and never come
// back to the browser; flows use them only in commands as {{cred.<nombre>.<campo>}}.
import React, { useEffect, useState } from 'react';
import { api } from './api.js';

/** Opens the credentials window from anywhere (preflight rows, command editor). */
export const openCredentials = (name) => window.dispatchEvent(new CustomEvent('afs:open-credentials', { detail: { name } }));

/** The credentials list + form (used by ⚙ Configuración › Credenciales). */
export function CredentialsPanel({ focusName }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null); // {id?, type, name, fields, note}
  const [err, setErr] = useState('');
  const load = () => api.get('/api/credentials').then((d) => { setData(d); return d; }).catch((e) => setErr(e.message));
  useEffect(() => {
    load().then((d) => {
      if (!focusName || !d) return;
      const c = d.items.find((x) => x.name === focusName);
      setEdit(c ? toEdit(c) : { type: 'jira', name: focusName, fields: {}, note: '' });
    });
  }, []);
  const toEdit = (c) => ({ id: c.id, type: c.type, name: c.name, note: c.note, fields: Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, typeof v === 'object' ? '' : v])), secretSet: Object.fromEntries(Object.entries(c.fields).filter(([, v]) => typeof v === 'object').map(([k, v]) => [k, v.set])) });
  if (!data) return err ? <div className="error-bar">{err}</div> : <p className="muted">Cargando…</p>;
  return (
    <div data-testid="credentials-panel">
      <p className="muted small">Los tokens que usan tus flujos (Jira, Bitbucket, GitHub, Jenkins…). Se guardan cifrados en esta máquina, nunca se muestran ni se exportan y nunca llegan a un prompt de IA. En un step de comando se usan como <code>{'{{cred.nombre.campo}}'}</code>: el valor viaja en una variable de entorno y, si el comando lo imprime, la app lo tapa con ••••.</p>
      {err && <div className="error-bar">{err}</div>}
      {edit ? <CredentialForm types={data.types} value={edit} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />
        : (
          <>
            {!data.items.length && <p className="muted">Todavía no hay credenciales.</p>}
            <ul className="cred-list" data-testid="cred-list">
              {data.items.map((c) => <CredentialRow key={c.id} c={c} onEdit={() => setEdit(toEdit(c))} onChanged={load} />)}
            </ul>
            <div className="review-actions"><button className="primary" onClick={() => setEdit({ type: 'jira', name: '', fields: {}, note: '' })}>+ Nueva credencial</button></div>
          </>
        )}
    </div>
  );
}

function CredentialRow({ c, onEdit, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(c.lastTest);
  async function run() { setBusy(true); try { setTest(await api.post(`/api/credentials/${c.id}/test`, {})); } catch (e) { setTest({ ok: false, detail: e.message }); } setBusy(false); }
  async function del() { if (!confirm(`¿Borrar la credencial "${c.name}"? Los flujos que la usan no podrán ejecutarse hasta que la vuelvas a cargar.`)) return; await api.del(`/api/credentials/${c.id}`); onChanged(); }
  const missing = Object.entries(c.fields).filter(([, v]) => (typeof v === 'object' ? !v.set : !v)).map(([k]) => k);
  return (
    <li className="cred-row" data-testid={`cred-${c.name}`}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div><b>{c.name}</b> <span className="muted small">{c.label}</span>{missing.length > 0 && <span className="chip warn"> falta: {missing.join(', ')}</span>}</div>
        <div className="row">
          <button className="small" disabled={busy} onClick={run}>{busy ? 'Probando…' : 'Probar conexión'}</button>
          <button className="small" onClick={onEdit}>Editar</button>
          <button className="ghost small danger" onClick={del}>Borrar</button>
        </div>
      </div>
      <div className="small muted">{Object.entries(c.fields).map(([k, v]) => `${k}: ${typeof v === 'object' ? (v.set ? '••••' : '—') : v || '—'}`).join(' · ')}</div>
      <div className="small">Úsala en comandos: {c.refs.map((r) => <code key={r} className="cred-ref" title="Copiar" onClick={() => navigator.clipboard?.writeText(r)}>{r}</code>)}</div>
      {test && <div className={`small ${test.ok ? 'ok-text' : 'error-text'}`}>{test.ok ? '✓' : '✗'} {test.detail}</div>}
    </li>
  );
}

function CredentialForm({ types, value, onCancel, onSaved }) {
  const [v, setV] = useState(value);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [envFile, setEnvFile] = useState('');
  const [envKeys, setEnvKeys] = useState(null);
  const [envPick, setEnvPick] = useState({});
  const t = types[v.type];
  const setField = (k, x) => setV({ ...v, fields: { ...v.fields, [k]: x } });
  async function save() {
    setBusy(true); setErr('');
    try {
      const body = { type: v.type, name: v.name, note: v.note, fields: v.fields };
      const saved = v.id ? await api.put(`/api/credentials/${v.id}`, body) : await api.post('/api/credentials', body);
      // values picked from a .env file are copied on the server (they never pass through the browser)
      for (const [field, key] of Object.entries(envPick)) if (key) await api.post(`/api/credentials/${saved.id}/import-env`, { file: envFile, key, field });
      onSaved();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function readEnv() { setErr(''); try { setEnvKeys((await api.post('/api/credentials/env-keys', { file: envFile })).keys); } catch (e) { setErr(e.message); setEnvKeys(null); } }
  return (
    <div className="cred-form" data-testid="cred-form">
      <div className="row">
        <label className="field">Tipo
          <select value={v.type} disabled={!!v.id} onChange={(e) => setV({ ...v, type: e.target.value, fields: {} })}>{Object.entries(types).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
        </label>
        <label className="field">Nombre <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value.toLowerCase() })} placeholder="jira" data-testid="cred-name" /></label>
      </div>
      <div className="muted small">El nombre es el que usas en los comandos: <code>{`{{cred.${v.name || 'nombre'}.campo}}`}</code></div>
      {t.fields.map((f) => (
        <label key={f.k} className="field">{f.label}{f.secret && v.secretSet?.[f.k] && <span className="muted small"> (cargado: déjalo vacío para no cambiarlo)</span>}
          <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={v.fields[f.k] || ''} placeholder={f.secret ? (v.secretSet?.[f.k] ? '••••••••' : '') : f.placeholder || ''} onChange={(e) => setField(f.k, e.target.value)} data-testid={`cred-field-${f.k}`} />
          {f.help && <span className="muted small">{f.help}</span>}
          {f.secret && envKeys && (
            <select value={envPick[f.k] || ''} onChange={(e) => setEnvPick({ ...envPick, [f.k]: e.target.value })} data-testid={`cred-env-${f.k}`}>
              <option value="">— o tomarlo del archivo .env —</option>
              {envKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </label>
      ))}
      <details className="small">
        <summary>Importar desde un archivo .env</summary>
        <div className="row"><input value={envFile} onChange={(e) => setEnvFile(e.target.value)} placeholder="C:\Users\yo\Desktop\.env" data-testid="cred-env-file" /><button className="small" onClick={readEnv}>Leer claves</button></div>
        <div className="muted small">Solo se leen los nombres de las claves; el valor elegido se copia en el servidor sin pasar por el navegador. Después puedes borrar el .env.</div>
      </details>
      <label className="field">Nota (opcional) <input value={v.note || ''} onChange={(e) => setV({ ...v, note: e.target.value })} /></label>
      {err && <div className="error-bar">{err}</div>}
      <div className="review-actions"><button className="ghost" onClick={onCancel}>Cancelar</button><button className="primary" disabled={busy} onClick={save}>Guardar</button></div>
    </div>
  );
}
