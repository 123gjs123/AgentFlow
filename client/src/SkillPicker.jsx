// Spec 13: searchable skill picker grouped by source + "＋ Agregar skill" (URL / carpeta / zip → revisión → instalar
// para este flujo o para tu Claude Code), quitar y actualizar las del flujo.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, onWs } from './api.js';
import { Modal } from './Help.jsx';
import { FsPicker } from './Sources.jsx';

const GROUPS = [['flow', 'Este flujo'], ['linked', 'Vinculadas (carpeta en vivo)'], ['project', 'Proyecto'], ['user', 'Mis skills'], ['claude.ai', 'claude.ai'], ['plugin', 'Plugins']];
const groupOf = (s) => (String(s.source).startsWith('plugin') ? 'plugin' : s.source);
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Combobox: filters by name and description; shows the description of the selected one (SKSRC-13). */
export default function SkillPicker({ flow, catalog, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [msg, setMsg] = useState('');
  const box = useRef(null);
  const [upd, setUpd] = useState({ flow: {}, user: {} });
  const loadUpd = () => api.get(`/api/flows/${encodeURIComponent(flow.id)}/skills/updates`).then(setUpd).catch(() => {});
  useEffect(() => { loadUpd(); return onWs((m) => { if (m.type === 'skills.updates' || m.type === 'catalog.changed') loadUpd(); }); }, [flow.id]);
  const updOf = (s) => (s.source === 'flow' ? upd.flow[s.name] : s.source === 'user' && s.managed ? upd.user[s.name] : null);
  const scopeOf = (s) => (s.source === 'user' ? 'user' : 'flow');
  useEffect(() => { const h = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const skills = catalog.skills || [];
  const sel = useMemo(() => { const order = ['flow', 'linked', 'project', 'user', 'claude.ai']; return skills.filter((s) => s.name === value).sort((a, b) => (order.indexOf(groupOf(a)) + 1 || 9) - (order.indexOf(groupOf(b)) + 1 || 9))[0]; }, [skills, value]);
  const needle = q.trim().toLowerCase();
  const hits = skills.filter((s) => !needle || s.name.toLowerCase().includes(needle) || String(s.description || '').toLowerCase().includes(needle));
  const pick = (name) => { onChange(name); setOpen(false); setQ(''); };
  async function removeIt() {
    const user = sel.source === 'user';
    if (!confirm(user ? `¿Quitar «${sel.name}» de tu Claude Code? Dejará de estar en TODAS tus sesiones.` : `¿Quitar «${sel.name}» de este flujo?${sel.source === 'linked' ? ' (tu carpeta no se toca)' : ''}`)) return;
    try { await api.del(`/api/skills/${encodeURIComponent(sel.name)}?scope=${user ? 'user&confirm=1' : 'flow'}&flowId=${encodeURIComponent(flow.id)}`); setMsg(user ? 'Quitada de tu Claude Code' : 'Quitada del flujo'); } catch (e) { setMsg(e.message); }
  }
  async function checkAll() {
    setMsg('Buscando actualizaciones de las skills de este flujo…');
    try { const r = await api.post(`/api/flows/${encodeURIComponent(flow.id)}/skills/check-updates`, {}); setUpd({ flow: r.flow, user: r.user }); const n = Object.values(r.flow).filter((x) => x.available).length; setMsg(n ? `${n} con actualización (⬆)` : 'Todas al día'); } catch (e) { setMsg(e.message); }
  }
  async function checkUpdate() {
    setMsg('Buscando actualización…');
    try { const u = await api.post(`/api/skills/${encodeURIComponent(sel.name)}/update?scope=${scopeOf(sel)}&flowId=${encodeURIComponent(flow.id)}`, {}); setMsg(''); loadUpd(); if (!u.changed) setMsg('Ya está al día'); else setUpdating(u); } catch (e) { setMsg(e.message); }
  }
  return (
    <div className="skill-picker" ref={box} data-testid="skill-picker">
      <div className="row">
        <input data-testid="skill-search" style={{ flex: 1 }} placeholder={value ? `${value} — escribe para buscar otra` : 'Buscar skill por nombre o descripción…'} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && hits[0]) pick(hits[0].name); }} />
        <button className="small" data-testid="skill-add" onClick={() => setAdding(true)}>＋ Agregar skill</button>
        {Object.keys(upd.flow).length + skills.filter((s) => s.managed).length > 0 && <button className="ghost small" data-testid="skill-check-all" title="Busca actualizaciones de las skills de este flujo" onClick={checkAll}>⟳</button>}
      </div>
      {open && (
        <div className="skill-list" role="listbox" data-testid="skill-list">
          {GROUPS.map(([g, label]) => {
            const list = hits.filter((s) => groupOf(s) === g);
            if (!list.length) return null;
            return (
              <div key={g}>
                <div className="skill-group">{label}</div>
                {list.map((s) => (
                  <button key={s.path} role="option" aria-selected={s.name === value} className={`skill-opt ${s.name === value ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(s.name); }} title={s.description}>
                    <b>{s.name}{updOf(s)?.available && <span className="badge warn" title="Hay una versión nueva en su origen"> ⬆</span>}</b><span className="muted small">{s.source !== g ? ` · ${s.source}` : ''} {String(s.description || '').slice(0, 140)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {!hits.length && <div className="muted small pad">Nada coincide. <button className="ghost small" onMouseDown={(e) => { e.preventDefault(); setAdding(true); }}>＋ Agregar skill…</button></div>}
        </div>
      )}
      {value && !sel && <div className="warn-text small" data-testid="skill-missing">La skill «{value}» no está en esta máquina. <button className="ghost small" onClick={() => setAdding(true)}>Agregar skill…</button></div>}
      {sel && (
        <div className="muted small" data-testid="skill-desc">
          <b>{sel.name}</b> · {sel.source}{sel.description ? ` — ${sel.description}` : ''}
          {updOf(sel)?.available && <span className="badge warn" data-testid="skill-update-badge"> ⬆ actualización disponible</span>}
          {updOf(sel)?.error && <span className="warn-text" title={updOf(sel).error}> ⚠ no se pudo revisar su origen</span>}
          {(sel.source === 'flow' || sel.source === 'linked') && <> {' '}{sel.source === 'flow' && <button className="ghost small" onClick={checkUpdate}>Buscar actualización</button>}<button className="ghost small" onClick={removeIt}>Quitar del flujo</button></>}
          {sel.source === 'user' && sel.managed && <> {' '}<button className="ghost small" onClick={checkUpdate}>Buscar actualización</button><button className="ghost small" data-testid="skill-remove-user" onClick={removeIt}>Quitar de mi Claude Code</button></>}
        </div>
      )}
      {msg && <div className="muted small" data-testid="skill-msg">{msg}</div>}
      {adding && <AddSkillModal flow={flow} onClose={() => setAdding(false)} onDone={(inst) => { setAdding(false); if (inst.length === 1) onChange(inst[0].name); setMsg(`Instalada${inst.length > 1 ? 's' : ''}: ${inst.map((x) => x.name).join(', ')}`); }} />}
      {updating && <UpdateModal flow={flow} u={updating} onClose={() => setUpdating(null)} onDone={() => { setUpdating(null); setMsg('Actualizada'); }} />}
    </div>
  );
}

const toB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('No se pudo leer el archivo')); r.readAsDataURL(file); });

/** "＋ Agregar skill": source → review → scope → install (SKSRC-1..8). `initial` = an inspection already made (import). */
export function AddSkillModal({ flow, initial = null, initialUrl = '', expectSha = null, onClose, onDone }) {
  const [tab, setTab] = useState('url');
  const [url, setUrl] = useState(initialUrl);
  const [fetching, setFetching] = useState(null); // a skill of an imported bundle that travels as a reference
  const [folder, setFolder] = useState('');
  const [mode, setMode] = useState('copy');
  const [zipPath, setZipPath] = useState('');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [insp, setInsp] = useState(initial);
  const [chosen, setChosen] = useState(() => new Set((initial?.skills || []).filter((s) => !s.problems?.length).map((s) => s.name)));
  const [scope, setScope] = useState('flow');
  const [confirmUser, setConfirmUser] = useState(false);
  const [conflicts, setConflicts] = useState([]);
  const [resolve, setResolve] = useState({});
  const [drag, setDrag] = useState(false);
  async function run(body) {
    setBusy(true); setErr(''); setConflicts([]); setResolve({});
    try { const r = await api.post('/api/skills/inspect', body); setInsp(r); setChosen(new Set(r.skills.filter((s) => !s.problems.length).map((s) => s.name))); if (body.path && tab === 'folder') setInsp({ ...r, folder: true }); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function onFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { setErr('Elige un archivo .zip'); return; }
    if (file.size > 20 * 1024 * 1024) { setErr('El zip supera 20 MB'); return; }
    run({ zipBase64: await toB64(file), fileName: file.name });
  }
  async function doInstall() {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/api/skills/install', { token: insp.token, names: [...chosen], scope, flowId: flow.id, mode: insp.folder ? mode : 'copy', confirmUser, resolve });
      onDone(r.installed);
    } catch (e) {
      if (e.code === 'SKILL_EXISTS') { setConflicts(e.body.conflicts || []); setErr('Hay nombres que ya existen: elige qué hacer con cada uno.'); }
      else setErr(e.message);
    }
    setBusy(false);
  }
  const setRes = (name, v) => setResolve((r) => ({ ...r, [name]: { ...(r[name] || {}), ...v } }));
  return (
    <Modal title="Agregar skill" onClose={onClose} wide>
      {!insp && (
        <>
          <div className="tabs small" data-testid="skill-add-tabs">
            {[['url', 'Desde URL'], ['folder', 'Desde carpeta'], ['zip', 'Desde zip']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => { setTab(k); setErr(''); }}>{l}</button>)}
          </div>
          {tab === 'url' && (
            <div className="pad">
              <p className="muted small">Repo git (https), carpeta de GitHub/Bitbucket/GitLab (URL "tree"), un <code>.zip</code> o un <code>SKILL.md</code>. Rama y carpeta: <code>https://host/repo.git#rama:ruta/skill</code>. Los repos privados usan tu git (administrador de credenciales).</p>
              <div className="row"><input data-testid="skill-url" className="mono" style={{ flex: 1 }} placeholder="https://github.com/org/repo/tree/main/skills/mi-skill" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && run({ url })} />
                <button className="primary small" disabled={!url || busy} onClick={() => run({ url })}>{busy ? 'Descargando…' : 'Revisar'}</button></div>
            </div>
          )}
          {tab === 'folder' && (
            <div className="pad">
              <div className="row"><input data-testid="skill-folder" className="mono" style={{ flex: 1 }} placeholder="C:\ruta\a\mis-skills" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button className="small" onClick={() => setPicker(true)}>Examinar…</button>
                <button className="primary small" disabled={!folder || busy} onClick={() => run({ path: folder })}>Revisar</button></div>
              <div className="seg small" style={{ marginTop: 8 }}>
                <button className={mode === 'copy' ? 'active' : ''} onClick={() => setMode('copy')}>Copiar (instantánea)</button>
                <button className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Vincular (en vivo)</button>
              </div>
              <p className="muted small">{mode === 'link' ? 'Vincular: el flujo usa tu carpeta tal cual; lo que edites se nota en la próxima ejecución. Solo para este flujo.' : 'Copiar: se guarda una copia; cambios posteriores en tu carpeta no afectan al flujo.'}</p>
              {picker && <FsPicker flow={flow} want="folder" start={folder} onClose={() => setPicker(false)} onPick={(p) => { setFolder(p); setPicker(false); }} />}
            </div>
          )}
          {tab === 'zip' && (
            <div className="pad">
              <label className={`dropzone ${drag ? 'over' : ''}`} data-testid="skill-drop" onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files?.[0]); }}>
                Arrastra un .zip aquí o <u>elige un archivo</u> (máx. 20 MB, 500 archivos)
                <input data-testid="skill-zip" type="file" accept=".zip" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <div className="row" style={{ marginTop: 8 }}><input className="mono" style={{ flex: 1 }} placeholder="o la ruta: C:\descargas\skill.zip" value={zipPath} onChange={(e) => setZipPath(e.target.value)} />
                <button className="small" disabled={!zipPath || busy} onClick={() => run({ path: zipPath })}>Revisar</button></div>
            </div>
          )}
        </>
      )}
      {insp && (
        <div className="pad" data-testid="skill-review">
          <p className="muted small">Revisa antes de instalar: nada se escribió todavía. Las skills pueden traer scripts que Claude podría ejecutar cuando la use.</p>
          {expectSha && <div className={insp.skills.some((s) => s.sha256 === expectSha) ? 'small' : 'warn-text small'} data-testid="skill-sha-check">{insp.skills.some((s) => s.sha256 === expectSha) ? '✓ Coincide con la versión que se exportó' : '⚠ Cambió desde que se exportó el flujo: revisa los archivos'}</div>}
          <div className="small muted">Origen: {insp.origin?.type === 'bundle' ? 'paquete importado' : insp.origin?.source}{insp.origin?.ref ? ` · rama ${insp.origin.ref}` : ''}{insp.origin?.subPath ? ` · ${insp.origin.subPath}` : ''}</div>
          {(insp.notEmbedded || []).length > 0 && (
            <div className="callout warn small" data-testid="skill-not-embedded">No vinieron dentro del paquete:
              <ul>{insp.notEmbedded.map((x) => <li key={x.name}><b>{x.name}</b>{x.fetchable ? <> — origen <code>{x.source}</code> <button className="small" data-testid={`fetch-${x.name}`} onClick={() => setFetching(x)}>Traer desde {(() => { try { return new URL(x.source).host; } catch { return 'el origen'; } })()}</button></> : ' — sin URL de origen: agrégala a mano'}</li>)}</ul>
              <span className="muted">Traer descarga desde esa dirección (puede ser de tu red interna) y te muestra la revisión antes de instalar.</span>
            </div>
          )}
          <ul className="skill-review-list">
            {insp.skills.map((s) => (
              <li key={s.relDir + s.name} data-testid={`review-${s.name}`}>
                <label className="row">
                  <input type="checkbox" disabled={s.problems.length > 0} checked={chosen.has(s.name)} onChange={(e) => setChosen((c) => { const n = new Set(c); e.target.checked ? n.add(s.name) : n.delete(s.name); return n; })} />
                  <b>{s.name}</b>{s.hasScripts && <span className="badge warn" title="Contiene scripts o ejecutables">⚠ contiene scripts</span>}<span className="muted small">{s.files.length} archivo(s) · {kb(s.size)}</span>
                </label>
                <div className="small">{s.description}</div>
                {s.importedFrom && <div className="small muted">Se buscarán actualizaciones en: <code>{s.importedFrom}</code></div>}
                {s.allowedTools && <div className="small muted">allowed-tools: <code>{s.allowedTools}</code></div>}
                {(s.warnings || []).map((w) => <div key={w} className="warn-text small">⚠ {w}</div>)}
                <details className="small" open={(s.warnings || []).length > 0}><summary>Front matter (lo que Claude Code aplica)</summary><pre className="mono small">{s.frontmatter}</pre></details>
                {s.problems.map((p) => <div key={p} className="warn-text small">✖ {p}</div>)}
                <details className="small"><summary>Archivos</summary><ul>{s.files.map((f) => <li key={f.path} className={f.script ? 'warn-text' : ''}><code>{f.path}</code> {kb(f.size)}{f.script ? ' ⚠ script' : ''}</li>)}</ul></details>
              </li>
            ))}
          </ul>
          <div className="seg small" data-testid="skill-scope">
            <button className={scope === 'flow' ? 'active' : ''} onClick={() => setScope('flow')}>Este flujo</button>
            <button className={scope === 'user' ? 'active' : ''} disabled={insp.folder && mode === 'link'} onClick={() => setScope('user')}>Mi Claude Code</button>
          </div>
          {scope === 'user' && <label className="small warn-text"><input type="checkbox" data-testid="skill-confirm-user" checked={confirmUser} onChange={(e) => setConfirmUser(e.target.checked)} /> Entiendo que queda en ~/.claude/skills y la verán todas mis sesiones de Claude Code</label>}
          {scope === 'flow' && <p className="muted small">Solo este flujo la ve (se guarda con el flujo y viaja al exportarlo).</p>}
          {conflicts.map((c0) => { const c = { ...c0, name: c0.source || c0.name, shown: c0.name }; return (
            <div key={c.name} className="callout warn small" data-testid={`conflict-${c.name}`}>
              «{c.shown}» ya existe ({c.existing.map((x) => x.source).join(', ')}){c.canReplace ? '' : ' y no la instaló esta app: renombra o no la instales'}.
              <div className="row">
                <button className={resolve[c.name]?.action === 'rename' ? 'active small' : 'small'} onClick={() => setRes(c.name, { action: 'rename' })}>Renombrar</button>
                {c.canReplace && <button className={resolve[c.name]?.action === 'replace' ? 'active small' : 'small'} onClick={() => setRes(c.name, { action: 'replace' })}>Reemplazar</button>}
                <button className={resolve[c.name]?.action === 'cancel' ? 'active small' : 'small'} onClick={() => setRes(c.name, { action: 'cancel' })}>No instalar</button>
                {resolve[c.name]?.action === 'rename' && <input className="mono" data-testid={`rename-${c.name}`} placeholder="nuevo-nombre" value={resolve[c.name]?.to || ''} onChange={(e) => setRes(c.name, { to: e.target.value })} />}
              </div>
            </div>
          ); })}
        </div>
      )}
      {err && <div className="error-bar" data-testid="skill-error">{err}</div>}
      <div className="review-actions">
        {insp && !initial && <button className="ghost" onClick={() => { setInsp(null); setErr(''); setConflicts([]); }}>← Otra fuente</button>}
        <button className="ghost" onClick={onClose}>Cancelar</button>
        {insp && <button className="primary" data-testid="skill-install" disabled={busy || !chosen.size || (scope === 'user' && !confirmUser)} onClick={doInstall}>{busy ? 'Instalando…' : `Instalar ${chosen.size}`}</button>}
      </div>
      {fetching && <AddSkillModal flow={flow} initialUrl={fetching.source} expectSha={fetching.sha256} onClose={() => setFetching(null)} onDone={(inst) => { setFetching(null); setInsp((i) => ({ ...i, notEmbedded: (i.notEmbedded || []).filter((x) => x.name !== fetching.name) })); onDone && insp.skills.length === 0 && (insp.notEmbedded || []).length <= 1 ? onDone(inst) : null; }} />}
    </Modal>
  );
}

/** Order-aware line diff (LCS); big files fall back to showing both versions whole. */
function lineDiff(a, b) {
  if (a.length * b.length > 4e6) return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  const m = a.length; const n = b.length; const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < m && j < n) { if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]); }
  while (i < m) out.push(['-', a[i++]]); while (j < n) out.push(['+', b[j++]]);
  return out;
}

/** Line diff of SKILL.md (previous → new) and "Reemplazar" (SKSRC-11 v1). */
function UpdateModal({ flow, u, onClose, onDone }) {
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(u.scope !== 'user');
  const a = u.previous.split(/\r?\n/); const b = u.current.split(/\r?\n/);
  const lines = lineDiff(a, b);
  async function apply() {
    try {
      const resolve = { [u.sourceName]: u.sourceName === u.name ? { action: 'replace' } : { action: 'rename', to: u.name, replace: true } };
      const r = await api.post('/api/skills/install', { token: u.token, names: [u.sourceName], scope: u.scope || 'flow', flowId: flow.id, resolve, ...(u.scope === 'user' ? { confirmUser: true } : {}) });
      if (r.shadows?.length) alert(`Actualizada. Ojo: ${r.shadows.length} flujo(s) tienen su propia skill «${u.name}».`);
      onDone();
    } catch (e) { setErr(e.message); }
  }
  return (
    <Modal title={`Actualizar «${u.name}»`} onClose={onClose} wide>
      <p className="muted small">Cambios en SKILL.md (− antes, + ahora). Los demás archivos de la skill también se reemplazan.</p>
      <pre className="mono small diff" data-testid="skill-diff">{lines.length ? lines.map(([k, l], i) => <div key={i} className={k === '+' ? 'add' : 'del'}>{k} {l}</div>) : 'SKILL.md no cambia'}</pre>
      <div className="small" data-testid="skill-update-files"><b>Archivos que cambian</b> (revísalos: pueden ser scripts que Claude ejecute)
        <ul>{(u.files || []).map((f) => <li key={f.path} className={f.script ? 'warn-text' : ''}><code>{f.path}</code> — {f.status === 'added' ? 'nuevo' : f.status === 'removed' ? 'se quita' : 'cambia'}{f.script ? ' ⚠ script' : ''}</li>)}</ul>
      </div>
      {u.candidate?.allowedTools && <div className="small muted">allowed-tools: <code>{u.candidate.allowedTools}</code></div>}
      {(u.candidate?.warnings || []).map((w) => <div key={w} className="warn-text small">⚠ {w}</div>)}
      {(u.candidate?.problems || []).map((p) => <div key={p} className="warn-text small">✖ {p}</div>)}
      {err && <div className="error-bar">{err}</div>}
      <div className="review-actions"><button className="ghost" onClick={onClose}>Cancelar</button>{u.scope === 'user' && <label className="small warn-text"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Entiendo que cambia la skill en todas mis sesiones de Claude Code</label>}<button className="primary" data-testid="skill-update-apply" disabled={!ok || (u.candidate?.problems || []).length > 0} onClick={apply}>Reemplazar</button></div>
    </Modal>
  );
}
