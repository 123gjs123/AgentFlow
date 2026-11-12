// "📎 Contexto" (spec 21): consultation sources attached to a step or to the whole flow. They are NOT pasted into
// the prompt: the model gets a short index and the access (Read on folders/files, WebFetch, Atlassian MCP) and
// consults them when its skill/agent/role needs them.
import React, { useEffect, useRef, useState } from 'react';
import { api, pendingSave } from './api.js';
import { Modal } from './Help.jsx';

const TYPES = [
  { type: 'file', icon: '📄', label: 'Documento', hint: 'Un archivo: .md, .txt, PDF, Word, Excel, código… El modelo lo abre con Read cuando lo necesita.', field: 'path', placeholder: 'C:\\docs\\requerimientos.md   ·   {{vars.carpeta}}\\spec.pdf' },
  { type: 'folder', icon: '📁', label: 'Carpeta', hint: 'Una carpeta con documentos: el modelo la explora con Glob/Grep y abre lo que necesita.', field: 'path', placeholder: 'C:\\repos\\mi-proyecto\\docs' },
  { type: 'url', icon: '🌐', label: 'Página web', hint: 'El modelo la consulta con WebFetch. Para Confluence o Jira usa su tipo (con WebFetch piden login).', field: 'url', placeholder: 'https://…' },
  { type: 'jira', icon: '🎫', label: 'Jira', hint: 'Un ticket, varios, una iniciativa/épica (marca “incluir hijos”) o una consulta JQL. Se consulta con tu MCP de Atlassian.', field: 'ref', placeholder: 'SBK-123   ·   SBK-1, SBK-2   ·   {{vars.issue}}   ·   project = SBK AND status = "QA"' },
  { type: 'confluence', icon: '📘', label: 'Confluence', hint: 'Una página por URL, id o título (y opcionalmente sus hijas). Se consulta con tu MCP de Atlassian.', field: 'ref', placeholder: 'https://tu-sitio.atlassian.net/wiki/spaces/…   ·   123456789   ·   Título de la página' },
];
const T = Object.fromEntries(TYPES.map((t) => [t.type, t]));
const rid = () => `cs_${Math.random().toString(36).slice(2, 9)}`;

/** One source with an automatic ✓/✗ check (debounced). */
function SourceItem({ flow, src, onChange, onRemove, onBrowse }) {
  const t = T[src.type];
  const [check, setCheck] = useState(null);
  const value = src[t.field] || '';
  useEffect(() => {
    if (!value.trim()) { setCheck(null); return; }
    const h = setTimeout(async () => {
      try { await pendingSave.flush(); setCheck(await api.post('/api/context/check', { flow: flow.id, source: src })); } catch (e) { setCheck({ ok: false, detail: e.message, warnings: [] }); }
    }, 600);
    return () => clearTimeout(h);
  }, [value, src.type, src.children]);
  return (
    <li className={`src-item ${src.disabled ? 'off' : ''}`} data-type={src.type}>
      <div className="row">
        <span className="src-icon" title={t.label}>{t.icon}</span>
        <input className="src-label" value={src.label || ''} onChange={(e) => onChange({ label: e.target.value || undefined })} placeholder={`Nombre (opcional): ${t.label.toLowerCase()}`} />
        <label className="toggle small" title="Desactivar sin borrar"><input type="checkbox" checked={!src.disabled} onChange={(e) => onChange({ disabled: e.target.checked ? undefined : true })} /> activa</label>
        <button className="ghost small danger" onClick={onRemove} title="Quitar">✕</button>
      </div>
      <div className="row">
        <input className="mono src-ref" value={value} onChange={(e) => onChange({ [t.field]: e.target.value })} placeholder={t.placeholder} />
        {(src.type === 'file' || src.type === 'folder') && <button className="small" onClick={onBrowse}>Explorar…</button>}
      </div>
      {(src.type === 'jira' || src.type === 'confluence') && (
        <label className="toggle small"><input type="checkbox" checked={!!src.children} onChange={(e) => onChange({ children: e.target.checked || undefined })} /> {src.type === 'jira' ? 'incluir hijos (iniciativa / épica)' : 'incluir páginas hijas'}</label>
      )}
      <input className="small src-note" value={src.note || ''} onChange={(e) => onChange({ note: e.target.value || undefined })} placeholder="Para qué sirve (opcional, lo ve el modelo): p. ej. “reglas de negocio de apuestas”" />
      {check && (
        <div className={`small ${check.ok && !check.warnings?.length ? 'ok-text' : 'warn-text'}`}>
          {check.ok ? '✓' : '✗'} {check.detail || (check.ok ? 'disponible' : '')}
          {check.warnings?.map((w) => <div key={w}>⚠ {w.replace(/^\S+\s[^:]*:\s/, '')}</div>)}
        </div>
      )}
    </li>
  );
}

/** Folder browser: navigate this machine's folders and pick a file or a folder. */
export function FsPicker({ flow, want, start, onPick, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const load = (p) => api.get(`/api/fs/list?flow=${encodeURIComponent(flow.id)}&path=${encodeURIComponent(p || '')}`).then((d) => { setData(d); setTyped(d.path); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(start || ''); }, []);
  const sep = data?.path?.includes('\\') ? '\\' : '/';
  const join = (n) => `${data.path.replace(/[\\/]+$/, '')}${sep}${n}`;
  return (
    <Modal title={want === 'folder' ? 'Elegir carpeta' : 'Elegir documento'} onClose={onClose} wide>
      <div className="row">
        <input className="mono" style={{ flex: 1 }} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(typed)} />
        <button className="small" onClick={() => load(typed)}>Ir</button>
        {data?.parent && <button className="small" onClick={() => load(data.parent)} title="Subir un nivel">⬆</button>}
        <button className="small ghost" onClick={() => load(data?.home)}>Inicio</button>
      </div>
      {err && <div className="error-bar">{err}</div>}
      {want === 'folder' && data && <div className="row"><button className="primary small" onClick={() => onPick(data.path)}>Usar esta carpeta: {data.path}</button></div>}
      <ul className="fs-list">
        {data?.entries.map((e) => (
          <li key={e.name}>
            {e.dir
              ? <button className="ghost fs-entry" onClick={() => load(join(e.name))}>📁 {e.name}</button>
              : <button className="ghost fs-entry" disabled={want === 'folder'} onClick={() => onPick(join(e.name))}>📄 {e.name} <span className="muted small">{e.size != null ? `${Math.max(1, Math.round(e.size / 1024))} KB` : ''}</span></button>}
          </li>
        ))}
        {data && !data.entries.length && <li className="muted small">(vacía)</li>}
      </ul>
    </Modal>
  );
}

/**
 * The 📎 Contexto section. value = list of sources; scope 'step' | 'flow'.
 */
export default function ContextSources({ flow, value, onChange, scope = 'step', inherited = 0 }) {
  const list = Array.isArray(value) ? value : [];
  const [picker, setPicker] = useState(null); // {id, want}
  const [upErr, setUpErr] = useState('');
  const fileInput = useRef(null);
  const set = (id, patch) => onChange(list.map((s) => { if (s.id !== id) return s; const n = { ...s, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete n[k]; return n; }));
  const add = (type, extra = {}) => onChange([...list, { id: rid(), type, ...extra }]);
  async function upload(files) {
    setUpErr('');
    for (const f of files) {
      if (f.size > 3.5 * 1024 * 1024) { setUpErr(`${f.name}: máximo 3,5 MB por archivo (para más, usa una carpeta o una ruta).`); continue; }
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
      try { const r = await api.post(`/api/flows/${flow.id}/context-files`, { name: f.name, data }); add('file', { path: r.path, label: f.name }); } catch (e) { setUpErr(`${f.name}: ${e.message}`); }
    }
  }
  return (
    <div className="ctx-sources">
      <p className="muted small">
        Fuentes que {scope === 'flow' ? 'todos los steps de este flujo' : 'este step'} puede consultar: documentos, carpetas, páginas, Jira, Confluence.
        <b> No se meten en el prompt</b>: el modelo recibe la lista y el acceso, y las consulta cuando su skill, agente o rol lo necesita.
        Admiten plantillas como <code>{'{{vars.issue}}'}</code> o <code>{'{{input}}'}</code>.
        {inherited > 0 && <> Además recibe {inherited} fuente(s) del flujo (Flujo → 📎 Contexto del flujo).</>}
      </p>
      {list.length > 0 && <ul className="src-list">{list.map((s) => <SourceItem key={s.id} flow={flow} src={s} onChange={(p) => set(s.id, p)} onRemove={() => onChange(list.filter((x) => x.id !== s.id))} onBrowse={() => setPicker({ id: s.id, want: s.type, start: s.path })} />)}</ul>}
      <div className="row wrap src-add">
        {TYPES.map((t) => <button key={t.type} className="small" title={t.hint} onClick={() => add(t.type)}>+ {t.icon} {t.label}</button>)}
        <button className="small" title="Sube un documento desde tu PC (se guarda junto al flujo)" onClick={() => fileInput.current?.click()}>⬆ Subir documento</button>
        <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </div>
      {upErr && <div className="warn-text small">{upErr}</div>}
      {picker && <FsPicker flow={flow} want={picker.want} start={picker.start} onClose={() => setPicker(null)} onPick={(p) => { set(picker.id, { path: p }); setPicker(null); }} />}
    </div>
  );
}
