// Spec 11 ISO-4/5/10: one external token per flow. It opens that flow only. Stored machine-bound in
// <DATA>/tokens.json: an HMAC with this machine's key (spec 26) to validate (a copied data folder validates nothing)
// and an AES-GCM box with the same key so the UI can reveal and copy it. Never exported, rotatable, revocable.
// The global token (config.json) is the admin token: every flow, can be disabled.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './store.js';
import { sealText, openText, macText } from './credentials.js';

const FILE = () => path.join(DATA, 'tokens.json');
const fail = (status, error, code) => Object.assign(new Error(error), { status, code });
function readAll() {
  if (!fs.existsSync(FILE())) return { version: 1, flows: {} };
  let j; try { j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { j = null; }
  if (j && j.flows && typeof j.flows === 'object' && !Array.isArray(j.flows)) return j;
  {
    throw fail(500, 'tokens.json está dañado: no se valida ningún token de flujo hasta que se corrija o se regeneren', 'TOKENS_CORRUPT'); }
}
function writeAll(j) { fs.mkdirSync(DATA, { recursive: true }); const tmp = `${FILE()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 }); fs.renameSync(tmp, FILE()); }
export const isFlowToken = (t) => /^afsf_[A-Za-z0-9_-]{30,}$/.test(String(t || ''));

/** Creates or rotates the token of a flow; returns it (the only time it travels in a response besides reveal). */
export function issue(flowId) {
  const j = readAll();
  const token = `afsf_${crypto.randomBytes(32).toString('base64url')}`;
  const prev = j.flows[flowId];
  j.flows[flowId] = { mac: macText(token), box: sealText(token), createdAt: prev?.createdAt || Date.now(), ...(prev ? { rotatedAt: Date.now() } : {}) };
  writeAll(j);
  return token;
}
export function revoke(flowId) { const j = readAll(); if (j.flows[flowId]) { delete j.flows[flowId]; writeAll(j); } }
/** What the UI shows; with reveal, the token itself (409 when this machine's key changed: regenerate it). */
export function meta(flowId, { reveal = false } = {}) {
  const e = readAll().flows[flowId];
  if (!e) return { exists: false };
  const out = { exists: true, createdAt: e.createdAt, rotatedAt: e.rotatedAt || null, lastUsedAt: e.lastUsedAt || null };
  if (reveal) {
    let t; try { t = openText(e.box); } catch { t = null; }
    if (!t || macText(t) !== e.mac) throw fail(409, 'La clave de esta máquina cambió: regenera el token del flujo', 'TOKEN_KEY_CHANGED');
    out.token = t;
  }
  return out;
}
/** The flow a presented token opens, or null. Constant-time comparison of fixed-length MACs. */
export function resolve(presented) {
  if (!isFlowToken(presented)) return null;
  let j; try { j = readAll(); } catch { return null; }
  const m = Buffer.from(macText(presented), 'hex');
  let hit = null;
  for (const [id, e] of Object.entries(j.flows)) { if (!e || typeof e !== 'object') continue; const b = Buffer.from(String(e.mac || ''), 'hex'); if (b.length === m.length && crypto.timingSafeEqual(b, m)) hit = id; }
  if (hit) {
    const e = j.flows[hit];
    if (!e.lastUsedAt || Date.now() - e.lastUsedAt > 5 * 60 * 1000) { e.lastUsedAt = Date.now(); try { writeAll(j); } catch {} }
  }
  return hit;
}
export function all() { try { return Object.keys(readAll().flows); } catch { return []; } }
