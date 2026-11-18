// Windows desktop notifications (spec 27), sent by the SERVER (always running): they reach the person even with no
// browser tab open, for any flow, including schedules and external triggers. Opt-in (config.notify.os).
// - Only breaks waiting and failed runs. Never step input/output, errors or values: flow, step and a generic cause.
// - Dedupe per item+state; schedules only on change (first failure, then "volvió a funcionar"); per-flow limit (breaks
//   exempt); global cap. While a toast is being shown, new ones are COMBINED into one ("N avisos"), never dropped.
// - PowerShell 5.1 + WinRT, constant script (-EncodedCommand), texts via environment variables, XML built with the DOM.
// - Tests: AFS_NOTIFY_SINK=<file> writes JSONL instead of showing toasts; AFS_NOTIFY_PLATFORM overrides the platform.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import * as attention from './attention.js';

const PLATFORM = () => process.env.AFS_NOTIFY_PLATFORM || process.platform;
export const osSupported = () => PLATFORM() === 'win32';
const TIME_SCALE = Number(process.env.AFS_TIME_SCALE) > 0 ? Number(process.env.AFS_TIME_SCALE) : 1;
const GLOBAL_CAP = 6; const GLOBAL_WINDOW = 10 * 60e3;
export const DEFAULTS = { os: false, minIntervalSec: 120 };
export const settings = () => ({ ...DEFAULTS, ...(store.getConfig().notify || {}) });
export function setSettings(patch) {
  const cur = settings();
  if ('os' in patch && typeof patch.os !== 'boolean') throw Object.assign(new Error('"os" debe ser true o false'), { status: 400, code: 'BAD_REQUEST' });
  if ('minIntervalSec' in patch && !(Number.isInteger(patch.minIntervalSec) && patch.minIntervalSec >= 0 && patch.minIntervalSec <= 3600)) throw Object.assign(new Error('"minIntervalSec" entre 0 y 3600'), { status: 400, code: 'BAD_REQUEST' });
  const next = { ...cur, ...('os' in patch ? { os: patch.os } : {}), ...('minIntervalSec' in patch ? { minIntervalSec: patch.minIntervalSec } : {}) };
  store.setConfig({ notify: next });
  return next;
}

// Display names only: no control characters, bounded.
const clean = (s, n) => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const CODE_TEXT = { MCP_UNAVAILABLE: 'Claude Code no cargó un conector (MCP)', CREDENTIAL_MISSING: 'falta una credencial', INTERRUPTED: 'el servidor se reinició', DEADLINE: 'se agotó el tiempo', TIMEOUT: 'se agotó el tiempo' };
export function textFor(item) {
  const flow = clean(item.flowName, 60); const step = clean(item.stepName, 40);
  if (item.kind === 'break') return { title: '⏸ Break esperando revisión', body: `${flow}${step ? ` · ${step}` : ''}. La ejecución sigue pausada hasta que la revises.` };
  if (item.kind === 'news') return { title: '🔔 Novedades', body: `${flow}${step ? ` · ${step}` : ''}: ${clean(item.detail, 120)}` };
  if (item.kind === 'recovered') return { title: '✓ Volvió a funcionar', body: `${flow}: ${item.recovered?.trigger === 'schedule' ? 'la ejecución programada' : 'una ejecución completa'} terminó bien.` };
  const why = CODE_TEXT[item.code] || 'terminó con error';
  return { title: item.code === 'INTERRUPTED' ? 'Ejecución interrumpida' : '✗ Falló un flujo', body: `${flow}${step ? ` · ${step}` : ''}: ${why}.` };
}

let baseUrl = () => '';
let inFlight = false;
let pending = [];
const sentAt = []; // global cap

const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode($env:AFS_N_TITLE)) | Out-Null
$t.Item(1).AppendChild($xml.CreateTextNode($env:AFS_N_BODY)) | Out-Null
if ($env:AFS_N_URL) { $xml.DocumentElement.SetAttribute('activationType', 'protocol'); $xml.DocumentElement.SetAttribute('launch', $env:AFS_N_URL) }
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
Write-Output $notifier.Setting`;
const ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

/** Shows one toast. Resolves {ok, setting?, error?}; never throws, never blocks the engine longer than the timeout. */
function show({ title, body, url, kind }) {
  return new Promise((resolve) => {
    if (process.env.AFS_NOTIFY_SINK) {
      try { fs.appendFileSync(process.env.AFS_NOTIFY_SINK, JSON.stringify({ at: Date.now(), kind, title, body, url }) + '\n'); } catch {}
      return resolve({ ok: true, setting: 'Enabled', sink: true });
    }
    if (!osSupported()) return resolve({ ok: false, unsupported: true });
    let out = ''; let err = '';
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], { windowsHide: true, env: { ...process.env, AFS_N_TITLE: title, AFS_N_BODY: body, AFS_N_URL: url || '' } });
    const timer = setTimeout(() => { try { c.kill(); } catch {} }, 10000);
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    c.on('close', (code) => {
      clearTimeout(timer);
      const setting = out.trim().split(/\r?\n/).pop() || '';
      resolve(code === 0 ? { ok: setting === 'Enabled' || setting === '', setting: setting || 'Enabled' } : { ok: false, error: clean(err, 300) || `exit ${code}` });
    });
  });
}

/** Queue: one PowerShell at a time; what arrives meanwhile is combined into a single toast. */
async function enqueue(n) {
  pending.push(n);
  if (inFlight) return;
  inFlight = true;
  try {
    while (pending.length) {
      const batch = pending; pending = [];
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] > GLOBAL_WINDOW) sentAt.shift();
      const hasBreak = batch.some((x) => x.kind === 'break');
      if (sentAt.length >= GLOBAL_CAP && !hasBreak) { console.warn(`notificaciones: tope de ${GLOBAL_CAP} cada 10 min alcanzado, ${batch.length} sin mostrar (siguen en 🔔)`); continue; }
      sentAt.push(now);
      const one = batch.length === 1 ? batch[0] : {
        kind: 'batch', title: `Agent Flow Studio: ${batch.length} avisos`,
        body: clean([...new Set(batch.map((x) => x.flowName))].join(', '), 110) + '. Ábrelo para ver qué necesita atención.',
        url: batch.find((x) => x.kind === 'break')?.url || batch[0].url,
      };
      const r = await show(one);
      if (!r.ok && !r.unsupported) console.error('notificación de Windows no mostrada:', r.error || r.setting);
    }
  } finally { inFlight = false; }
}

const urlFor = (item) => { const b = baseUrl(); if (!b) return ''; const q = new URLSearchParams({ flow: item.flowId, open: item.kind === 'break' ? 'review' : 'attention' }); return `${b}/?${q}`; };

/** Decides what deserves a toast among the items attention just added (or removed). */
function onChange(added, removed) {
  const cfg = settings();
  if (!cfg.os) return;
  const st = attention.getState();
  const now = Date.now();
  let dirty = false;
  for (const it of added) {
    if (it.kind !== 'break' && it.kind !== 'run_failed' && it.kind !== 'news') continue;
    if (st.notified[it.id] === it.stateKey) continue; // already told
    // schedules: only the first failure (a failing hourly job is one problem, not one per hour)
    if (it.kind === 'run_failed' && it.trigger === 'schedule' && st.notified[it.id]) { st.notified[it.id] = it.stateKey; dirty = true; continue; }
    if (it.kind !== 'break') {
      const last = st.lastNotifyAt[it.flowId] || 0;
      if (now - last < cfg.minIntervalSec * 1000 * TIME_SCALE) { st.notified[it.id] = it.stateKey; dirty = true; continue; }
    }
    st.notified[it.id] = it.stateKey; st.lastNotifyAt[it.flowId] = now; dirty = true;
    const t = textFor(it);
    enqueue({ ...t, kind: it.kind, flowName: it.flowName, url: urlFor(it) });
  }
  // recovery of a scheduled job that had been reported as failing: only after a REAL success (a failure that just aged
  // out of the window is forgotten silently)
  for (const it of removed) {
    if (it.kind !== 'run_failed' || !st.notified[it.id]) continue;
    delete st.notified[it.id]; dirty = true;
    if (it.trigger === 'schedule' && it.recovered) enqueue({ ...textFor({ ...it, kind: 'recovered' }), kind: 'recovered', flowName: it.flowName, url: urlFor(it) });
  }
  if (dirty) attention.save();
}

/** Boot: one summary toast when the restart interrupted runs (they are news, but not one toast each). */
export function bootSummary(interrupted) {
  if (!interrupted || !settings().os) return;
  enqueue({ kind: 'boot', title: 'Agent Flow Studio se reinició', body: `El reinicio interrumpió ${interrupted} ejecución${interrupted > 1 ? 'es' : ''}. Revísalas en "Necesita atención".`, flowName: '', url: baseUrl() ? `${baseUrl()}/?open=attention` : '' });
}

/** "Probar notificación". */
export async function test() {
  if (!osSupported() && !process.env.AFS_NOTIFY_SINK) return { ok: false, unsupported: true, error: 'Las notificaciones de escritorio solo están disponibles en Windows.' };
  const r = await show({ kind: 'test', title: 'Prueba de Agent Flow Studio', body: 'Si ves esto, los avisos de breaks y fallos te llegarán aunque no tengas la app abierta.', url: baseUrl() ? `${baseUrl()}/?open=attention` : '' });
  return { ...r, hint: r.ok ? undefined : r.setting && r.setting !== 'Enabled' ? `Windows tiene las notificaciones desactivadas para esta app (${r.setting}). Revisa Configuración de Windows › Sistema › Notificaciones.` : undefined };
}

export function init({ getBaseUrl }) {
  baseUrl = getBaseUrl || baseUrl;
  attention.onAdded(onChange);
}
