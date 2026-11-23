// Credentials (spec 26): one place for the tokens flows need (Jira, Bitbucket, GitHub, Jenkins, any secret).
// - Stored in data/credentials.json, secret fields encrypted with AES-256-GCM. The key lives OUTSIDE the data folder
//   (~/.afs/credentials.key, or AFS_CRED_KEY_FILE), so copying, exporting or committing data/ never leaks a token.
// - The API never returns a secret value (only whether it is set). Exports never include credentials.
// - Flows use them only in COMMANDS ({{cred.<name>.<field>}}): the value travels in an environment variable, is never
//   written in the command text, and is masked in outputs and activity. AI prompts can never receive them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './store.js';

const FILE = () => path.join(DATA, 'credentials.json');
const KEY_FILE = () => process.env.AFS_CRED_KEY_FILE || path.join(os.homedir(), '.afs', 'credentials.key');

/** Field definitions per type. secret: encrypted, never returned. test: how "Probar conexión" checks it. */
export const TYPES = {
  jira: { label: 'Jira / Confluence (Atlassian Cloud)', fields: [{ k: 'url', label: 'URL del sitio', placeholder: 'https://empresa.atlassian.net' }, { k: 'user', label: 'Email de tu cuenta' }, { k: 'token', label: 'API token', secret: true, help: 'id.atlassian.com → Seguridad → Crear token de API' }] },
  bitbucket: { label: 'Bitbucket Server / Data Center', fields: [{ k: 'url', label: 'URL', placeholder: 'https://bitbucket.empresa.com' }, { k: 'user', label: 'Usuario' }, { k: 'token', label: 'HTTP access token', secret: true }] },
  github: { label: 'GitHub', fields: [{ k: 'url', label: 'URL de la API', placeholder: 'https://api.github.com' }, { k: 'token', label: 'Token', secret: true }] },
  jenkins: { label: 'Jenkins', fields: [{ k: 'url', label: 'URL', placeholder: 'https://jenkins.empresa.com' }, { k: 'user', label: 'Usuario' }, { k: 'token', label: 'API token', secret: true }] },
  generic: { label: 'Otro secreto', fields: [{ k: 'user', label: 'Usuario (opcional)' }, { k: 'value', label: 'Valor', secret: true }] },
};
const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const fail = (status, msg, code) => Object.assign(new Error(msg), { status, code });

function key() {
  const f = KEY_FILE();
  try { const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64'); if (k.length === 32) return k; } catch {}
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('base64'), { mode: 0o600 });
  return k;
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}
// spec 11: per-flow tokens use the same machine key (sealed to reveal, HMAC to validate)
export const sealText = (t) => seal(t);
export const openText = (b) => open(b);
export const macText = (t) => crypto.createHmac('sha256', key()).update(`afs-flow-token:${t}`).digest('hex');
function readAll() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')).items || []; } catch { return []; } }
function writeAll(items) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 }); }

/** Public view: never a secret value. */
const view = (c) => ({
  id: c.id, name: c.name, type: c.type, label: TYPES[c.type]?.label || c.type, note: c.note || '',
  fields: Object.fromEntries((TYPES[c.type]?.fields || []).map((f) => [f.k, f.secret ? { set: !!c.secrets?.[f.k] } : (c.fields?.[f.k] || '')])),
  refs: (TYPES[c.type]?.fields || []).map((f) => `{{cred.${c.name}.${f.k}}}`),
  createdAt: c.createdAt, updatedAt: c.updatedAt, lastTest: c.lastTest || null,
});
export const listCredentials = () => readAll().map(view);
export const credentialNames = () => new Set(readAll().map((c) => c.name));

function clean(body, prev) {
  const type = prev?.type || body.type;
  const t = TYPES[type];
  if (!t) throw fail(400, `Tipo desconocido: ${type}. Usa ${Object.keys(TYPES).join(', ')}`, 'BAD_CREDENTIAL');
  const name = String(body.name ?? prev?.name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw fail(400, 'Nombre inválido: minúsculas, números, - o _ (empieza con letra, hasta 40). Es el que usas en {{cred.nombre.campo}}.', 'BAD_CREDENTIAL');
  const fields = { ...(prev?.fields || {}) }; const secrets = { ...(prev?.secrets || {}) };
  for (const f of t.fields) {
    const v = body.fields?.[f.k];
    if (v === undefined || v === null) continue;
    if (f.secret) { if (String(v) !== '') secrets[f.k] = seal(String(v)); } // empty = keep the current secret
    else fields[f.k] = String(v).trim().replace(/\/+$/, f.k === 'url' ? '' : '$&');
  }
  if (body.clear && Array.isArray(body.clear)) for (const k of body.clear) delete secrets[k];
  return { type, name, fields, secrets, note: typeof body.note === 'string' ? body.note.slice(0, 300) : prev?.note || '' };
}
export function createCredential(body) {
  const items = readAll();
  const c = clean(body || {});
  if (items.some((x) => x.name === c.name)) throw fail(409, `Ya existe una credencial "${c.name}"`, 'CREDENTIAL_EXISTS');
  const item = { id: `cr_${crypto.randomBytes(6).toString('hex')}`, ...c, createdAt: Date.now(), updatedAt: Date.now() };
  writeAll([...items, item]);
  return view(item);
}
export function updateCredential(id, body) {
  const items = readAll();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) throw fail(404, 'Credencial no encontrada', 'CREDENTIAL_NOT_FOUND');
  const c = clean(body || {}, items[i]);
  if (items.some((x, j) => j !== i && x.name === c.name)) throw fail(409, `Ya existe una credencial "${c.name}"`, 'CREDENTIAL_EXISTS');
  items[i] = { ...items[i], ...c, updatedAt: Date.now(), lastTest: null };
  writeAll(items);
  return view(items[i]);
}
export function deleteCredential(id) {
  const items = readAll();
  if (!items.some((x) => x.id === id)) throw fail(404, 'Credencial no encontrada', 'CREDENTIAL_NOT_FOUND');
  writeAll(items.filter((x) => x.id !== id));
  return { deleted: true };
}

/** Value of {{cred.name.field}} → {value, secret} | {error}. Only the engine calls this, only for commands. */
export function resolveCredential(name, field) {
  const c = readAll().find((x) => x.name === name);
  if (!c) return { error: `La credencial "${name}" no existe: cárgala en ⚙ Configuración › Credenciales.` };
  const f = TYPES[c.type]?.fields.find((x) => x.k === field);
  if (!f) return { error: `La credencial "${name}" (${c.type}) no tiene el campo "${field}": usa ${TYPES[c.type].fields.map((x) => x.k).join(', ')}.` };
  if (f.secret) {
    if (!c.secrets?.[field]) return { error: `A la credencial "${name}" le falta "${f.label}": complétala en ⚙ Configuración › Credenciales.` };
    try { return { value: open(c.secrets[field]), secret: true }; }
    catch { return { error: `No se pudo descifrar "${name}.${field}" (¿cambió la clave ${KEY_FILE()}?): vuelve a cargarla en ⚙ Configuración › Credenciales.` }; }
  }
  const v = c.fields?.[field] || '';
  if (!v) return { error: `A la credencial "${name}" le falta "${f.label}": complétala en ⚙ Configuración › Credenciales.` };
  return { value: v, secret: false };
}

/** Every secret value (decrypted), to MASK it in logs. Cached briefly: the journal masks on every entry. Never shown. */
let secretCache = { at: 0, values: [] };
export function secretValues() {
  if (Date.now() - secretCache.at < 30000) return secretCache.values;
  const values = [];
  for (const c of readAll()) for (const f of TYPES[c.type]?.fields || []) if (f.secret && c.secrets?.[f.k]) { try { values.push(open(c.secrets[f.k])); } catch { /* unreadable: nothing to mask */ } }
  secretCache = { at: Date.now(), values };
  return values;
}

/** {{cred.x.y}} references used by a flow's command steps and "Al terminar". */
export const CRED_RE = /\{\{\{?\s*cred\.([a-z][a-z0-9_-]*)\.([a-z]+)\s*\}?\}\}/gi;
export function credentialRefs(flow, only = null) {
  const texts = [];
  for (const s of flow.steps || []) {
    if (only && (only instanceof Set ? !only.has(s.id) : s.id !== only)) continue;
    if (s.kind === 'command') texts.push(s.command);
  }
  if (!only || only instanceof Set) texts.push(flow.finally?.disabled ? '' : flow.finally?.command); // a "from" run also runs "Al terminar"
  const refs = new Map();
  for (const t of texts) for (const m of String(t || '').matchAll(CRED_RE)) refs.set(`${m[1].toLowerCase()}.${m[2]}`, { name: m[1].toLowerCase(), field: m[2] });
  return [...refs.values()];
}
/** Preflight items for the credentials a flow uses (implicit requirements: nobody has to declare them). */
export function credentialChecks(flow, only = null) {
  return credentialRefs(flow, only).map((r) => {
    const v = resolveCredential(r.name, r.field);
    return { id: `cred:${r.name}.${r.field}`, type: 'credential', implicit: true, label: `Credencial ${r.name}.${r.field}`, ok: !v.error, detail: v.error ? 'falta' : 'cargada', help: v.error || '', optional: false };
  });
}

/** "Probar conexión": a harmless read with the credential. */
export async function testCredential(id) {
  const items = readAll();
  const c = items.find((x) => x.id === id);
  if (!c) throw fail(404, 'Credencial no encontrada', 'CREDENTIAL_NOT_FOUND');
  const get = (f) => { const r = resolveCredential(c.name, f); if (r.error) throw fail(400, r.error, 'CREDENTIAL_INCOMPLETE'); return r.value; };
  const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  let url; let headers = { Accept: 'application/json' }; let who = (j) => '';
  if (c.type === 'jira') { url = `${get('url')}/rest/api/3/myself`; headers.Authorization = basic(get('user'), get('token')); who = (j) => j.displayName || j.emailAddress; }
  else if (c.type === 'bitbucket') { url = `${get('url')}/rest/api/1.0/users/${encodeURIComponent(get('user'))}`; headers.Authorization = `Bearer ${get('token')}`; who = (j) => j.displayName || j.name; }
  else if (c.type === 'github') { url = `${(c.fields?.url || 'https://api.github.com')}/user`; headers.Authorization = `Bearer ${get('token')}`; who = (j) => j.login; }
  else if (c.type === 'jenkins') { url = `${get('url')}/me/api/json`; headers.Authorization = basic(get('user'), get('token')); who = (j) => j.fullName || j.id; }
  else { get('value'); return saveTest(items, c, { ok: true, detail: 'Guardado (este tipo no tiene prueba de conexión)' }); }
  let res;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    res = r.ok ? { ok: true, detail: `Conectado como ${who(j) || 'usuario válido'}` } : { ok: false, detail: r.status === 401 || r.status === 403 ? `Rechazado (${r.status}): revisa usuario y token` : `Respondió ${r.status}` };
  } catch (e) { res = { ok: false, detail: `No responde: ${e.cause?.code || e.message}` }; }
  return saveTest(items, c, res);
}
function saveTest(items, c, res) {
  c.lastTest = { ...res, at: Date.now() };
  writeAll(items);
  return { ...res, credential: view(c) };
}

/** Lists the KEY NAMES of a .env file (never values), so the user can pick which one to import. */
export function envKeys(file) {
  const p = String(file || '').replace(/^~(?=$|[\\/])/, os.homedir());
  if (!p || !fs.existsSync(p)) throw fail(400, `No existe el archivo ${file}`, 'FILE_NOT_FOUND');
  return parseEnv(fs.readFileSync(p, 'utf8')).map(([k]) => k);
}
/** Copies one value of a .env file into a credential field (the value never leaves the server). */
export function importFromEnv(id, { file, key: envKey, field }) {
  const p = String(file || '').replace(/^~(?=$|[\\/])/, os.homedir());
  if (!p || !fs.existsSync(p)) throw fail(400, `No existe el archivo ${file}`, 'FILE_NOT_FOUND');
  const hit = parseEnv(fs.readFileSync(p, 'utf8')).find(([k]) => k === envKey);
  if (!hit) throw fail(400, `"${envKey}" no está en ${file}`, 'ENV_KEY_NOT_FOUND');
  return updateCredential(id, { fields: { [field]: hit[1] } });
}
function parseEnv(text) {
  return String(text).split(/\r?\n/).filter((l) => /^\s*[^#\s][^=]*=/.test(l)).map((l) => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^(['"])(.*)\1$/, '$2')]; });
}
