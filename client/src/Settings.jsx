// ⚙ Configuración (spec 27): one place for what is global to this machine. Reuses the existing panels (credentials,
// external invocation) and adds the installation check, desktop notifications and where the numbers come from.
import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal, ExternalInvoke } from './Help.jsx';
import { CredentialsPanel } from './Credentials.jsx';

export const SETTINGS_TABS = [
  ['credentials', 'Credenciales'],
  ['integrations', 'Integraciones'],
  ['cli', 'Claude Code CLI'],
  ['notifications', 'Notificaciones'],
  ['numbers', 'De dónde salen los números'],
];
/** Opens ⚙ Configuración at a tab from anywhere (inbox items, preflight rows, command editor). */
export const openSettings = (tab, extra = {}) => window.dispatchEvent(new CustomEvent('afs:open-settings', { detail: { tab, ...extra } }));

export function SettingsModal({ tab, setTab, onClose, flow, focusName }) {
  return (
    <Modal title="⚙ Configuración" onClose={onClose} wide>
      <div className="help settings" data-testid="settings">
        <nav role="tablist" aria-label="Secciones de configuración">
          {SETTINGS_TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`ghost ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)} data-testid={`settings-tab-${k}`}>{l}</button>
          ))}
        </nav>
        <div className="help-body" role="tabpanel">
          {tab === 'credentials' && <><h3>Credenciales</h3><CredentialsPanel focusName={focusName} /></>}
          {tab === 'integrations' && (
            <>
              <h3>Integraciones</h3>
              <p className="muted small">Cómo invocar tus flujos desde fuera (Claude Code por MCP, terminal, HTTP, Jenkins, webhooks) y el token de la API externa. El asistente usa el flujo abierto{flow ? ` (“${flow.name}”)` : ''}.</p>
              <ExternalInvoke flow={flow} />
            </>
          )}
          {tab === 'cli' && <SystemCheck flow={flow} />}
          {tab === 'notifications' && <Notifications />}
          {tab === 'numbers' && <Numbers />}
        </div>
      </div>
    </Modal>
  );
}

const MARK = { true: '✓', false: '✗', null: '?' };
function SystemCheck({ flow }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = (fresh) => api.get(`/api/system/check?${new URLSearchParams({ ...(flow ? { flow: flow.id } : {}), ...(fresh ? { fresh: '1' } : {}) })}`).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(false); }, [flow?.id]);
  async function recheck() {
    setBusy(true); setErr('');
    try { await api.post('/api/catalog/probe', { cwd: flow?.cwd }); } catch (e) { setErr(e.message); }
    await load(true); setBusy(false);
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Claude Code CLI</h3>
        <button className="small" disabled={busy} onClick={recheck} data-testid="system-recheck">{busy ? 'Revisando…' : '↻ Volver a revisar'}</button>
      </div>
      <p className="muted small">Lo que tu Claude Code tiene de verdad en esta máquina: es lo que usan los flujos al ejecutarse. {flow ? `Los conectores se comparan con los que usa “${flow.name}”.` : 'Abre un flujo para comparar sus conectores.'}</p>
      {err && <div className="error-bar">{err}</div>}
      {!data ? <p className="muted">Revisando…</p> : (
        <ul className="req-results" data-testid="system-check">
          {data.rows.map((r) => (
            <li key={r.id} className={`req-result ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'unknown'}`} data-testid={`check-${r.id}`}>
              <div><b>{MARK[r.ok]} {r.label}</b> <span className="muted small">— {r.detail}</span></div>
              {r.fix && <details className="small"><summary>Cómo arreglarlo</summary><div className="req-help">{r.fix}</div></details>}
            </li>
          ))}
        </ul>
      )}
      {data && <p className="muted small">Revisado {new Date(data.checkedAt).toLocaleTimeString()}{data.probedAt ? ` · última sesión del CLI ${new Date(data.probedAt).toLocaleTimeString()}` : ''}.</p>}
    </>
  );
}

function Notifications() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/settings').then(setS).catch((e) => setMsg(e.message)); }, []);
  if (!s) return <p className="muted">{msg || 'Cargando…'}</p>;
  async function toggle(os) { setMsg(''); try { const r = await api.put('/api/settings/notify', { os }); setS({ ...s, notify: r.notify }); setMsg('Guardado'); } catch (e) { setMsg(e.message); } }
  async function test() { setBusy(true); setMsg(''); try { const r = await api.post('/api/settings/notify/test', {}); setMsg(r.ok ? 'Enviada: debería aparecer en la esquina de tu pantalla. Si no la ves, revisa “No molestar” o Configuración de Windows › Sistema › Notificaciones.' : r.hint || r.error || 'No se pudo mostrar.'); } catch (e) { setMsg(e.message); } setBusy(false); }
  return (
    <>
      <h3>Notificaciones</h3>
      <p className="muted small">Lo que necesita atención (un break esperando, una ejecución que falló, un flujo bloqueado o importado en revisión) aparece siempre en 🔔, también si ocurre en otro flujo. Además, la app puede avisarte con una notificación de Windows aunque no tengas el navegador abierto: la envía el servidor, así que también cubre las ejecuciones programadas y las que llegan desde fuera.</p>
      <label className="toggle" data-testid="notify-os">
        <input type="checkbox" checked={!!s.notify.os} disabled={!s.osSupported} onChange={(e) => toggle(e.target.checked)} /> Notificación de Windows para breaks y fallos
      </label>
      {!s.osSupported && <p className="muted small">Solo disponible en Windows.</p>}
      <ul className="small muted">
        <li>Un aviso por break o por fallo; si una ejecución programada falla cada hora, avisa la primera vez y cuando vuelve a funcionar.</li>
        <li>Si llegan varios a la vez, se juntan en uno. Solo muestra el nombre del flujo y del step, nunca datos de la ejecución.</li>
        <li>Aparece como “Windows PowerShell” (así no hace falta instalar ni registrar nada). Al hacer clic se abre el flujo.</li>
      </ul>
      <div className="row"><button className="small" disabled={busy || !s.osSupported} onClick={test} data-testid="notify-test">Probar notificación</button></div>
      {msg && <p className="small" role="status">{msg}</p>}
    </>
  );
}

function Numbers() {
  const rows = [
    ['5h', 'Porcentaje usado de tu ventana de 5 horas de la suscripción de Claude. Al llegar al 100 % Claude te frena hasta que la ventana se reinicia.', 'Lo informa el propio Claude Code en cada ejecución (límites de uso). La app no lo calcula.'],
    ['7d', 'Lo mismo, para la ventana semanal.', 'Igual que 5h.'],
    ['Tokens', 'Texto que Claude leyó (entrada, incluida la caché) y escribió (salida) en cada step.', 'El contador de uso que devuelve Claude Code al terminar cada step; la app los suma por ejecución.'],
    ['≈ US$ equiv. API', 'Lo que habría costado ese consumo pagando por API. No es un cobro: tu suscripción tiene precio fijo.', 'La estimación que da Claude Code con los precios públicos de la API; puede quedar desactualizada.'],
  ];
  return (
    <>
      <h3>De dónde salen los números</h3>
      <p className="muted small">Para que nadie confunda una estimación con una factura.</p>
      <table className="nums-table" data-testid="numbers-table">
        <thead><tr><th>Número</th><th>Qué significa</th><th>De dónde sale</th></tr></thead>
        <tbody>{rows.map(([a, b, c]) => <tr key={a}><td><b>{a}</b></td><td>{b}</td><td className="muted">{c}</td></tr>)}</tbody>
      </table>
    </>
  );
}
