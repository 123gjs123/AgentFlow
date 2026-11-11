// ---- server connection state (shown as a banner when the local server is not running) ----
let online = true;
const connSubs = new Set();
const setOnline = (v) => { if (v !== online) { online = v; connSubs.forEach((f) => f(v)); } };
export function onConn(fn) { connSubs.add(fn); fn(online); return () => connSubs.delete(fn); }

async function req(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { setOnline(false); throw new Error('El servidor de Agent Flow Studio no responde'); }
  setOnline(true);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export const api = {
  get: (u) => req('GET', u),
  post: (u, b = {}) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};

const subs = new Set();
export function onWs(fn) { subs.add(fn); return () => subs.delete(fn); }
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => setOnline(true);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } subs.forEach((f) => f(m)); };
  ws.onclose = () => { setOnline(false); setTimeout(connect, 1500); };
}
connect();
