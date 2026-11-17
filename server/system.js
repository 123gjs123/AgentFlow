// "Chequeo de instalación" (spec 27, Configuración › Claude Code CLI): what THIS machine really has, so a colleague
// installing the app (or you, when a step fails with MCP_UNAVAILABLE) sees it in one place. Never returns secrets:
// environment variables are reported as present/absent (a proxy URL may carry credentials).
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { lastInit, claudeSpawn, claudeBin } from './claude.js';

let versionCache = null; // {at, value}
function cliVersion(fresh) {
  if (!fresh && versionCache && Date.now() - versionCache.at < 5 * 60e3) return Promise.resolve(versionCache.value);
  return new Promise((resolve) => {
    let out = ''; let done = false;
    const finish = (v) => { if (done) return; done = true; versionCache = { at: Date.now(), value: v }; resolve(v); };
    try {
      const [file, argv] = claudeSpawn(['--version']);
      const c = spawn(file, argv, { windowsHide: true });
      const t = setTimeout(() => { try { c.kill(); } catch {} finish({ ok: false, detail: 'No respondió en 8 s' }); }, 8000);
      c.stdout.on('data', (d) => (out += d));
      c.stdin.on('error', () => {}); c.stdin.end(); // nothing to read: never wait for input
      c.on('error', (e) => { clearTimeout(t); finish({ ok: false, detail: e.code === 'ENOENT' ? 'No se encontró el CLI de Claude Code' : e.message }); });
      c.on('close', (code) => { clearTimeout(t); finish(code === 0 ? { ok: true, detail: out.trim().split(/\r?\n/)[0] } : { ok: false, detail: `Terminó con código ${code}` }); });
    } catch (e) { finish({ ok: false, detail: e.message }); }
  });
}

const norm = (x) => String(x).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();

/** One row per check: {id, label, ok:true|false|null, detail, fix?}. */
export async function checkSystem({ flow = null, fresh = false } = {}) {
  const rows = [];
  const add = (id, label, ok, detail, fix) => rows.push({ id, label, ok, detail, ...(fix ? { fix } : {}) });

  const v = await cliVersion(fresh);
  add('cli', 'Claude Code CLI instalado', v.ok, v.ok ? `${v.detail} · ${claudeBin()}` : v.detail,
    v.ok ? null : 'Instala Claude Code (npm install -g @anthropic-ai/claude-code) y abre una terminal nueva. Si usas un CLI propio, define CLAUDE_BIN.');

  const init = lastInit.at ? lastInit : null;
  if (!init) add('login', 'Sesión de Claude Code', null, 'Sin datos todavía: pulsa "Volver a revisar" o ejecuta un step.', null);
  else {
    const sub = init.apiKeySource === 'none' || init.apiKeySource === null;
    add('login', 'Sesión de Claude Code', true, sub ? 'Suscripción (sesión iniciada, sin API key)' : `API key (${init.apiKeySource})`, null);
  }

  // MCP connectors: what the CLI really loads vs. what the open flow's steps use
  if (init) {
    const loaded = (init.mcpServers || []).map((m) => ({ name: m.name, status: m.status }));
    const used = new Map();
    for (const s of flow?.steps || []) for (const t of String(s.allowedTools || '').match(/mcp__[^\s,()]+/g) || []) {
      const srv = t.slice(5).split('__')[0];
      if (!used.has(srv)) used.set(srv, new Set());
      used.get(srv).add(s.name);
    }
    for (const r of flow?.requirements || []) if (r.type === 'mcp' && r.server && !used.has(r.server)) used.set(r.server, new Set(['(requisito del flujo)']));
    const have = new Map(loaded.map((m) => [norm(m.name), m.status]));
    const missing = [...used.entries()].filter(([srv]) => !['connected', 'pending'].includes(have.get(norm(srv))));
    add('mcp', 'Conectores MCP', flow ? !missing.length : loaded.length ? true : null,
      `${loaded.length ? loaded.map((m) => `${m.name} (${m.status})`).join(', ') : 'ninguno cargado'}${missing.length ? ` · usados por este flujo y NO cargados: ${missing.map(([srv, steps]) => `${srv.replace(/_/g, ' ')} (${[...steps].join(', ')})`).join('; ')}` : ''}`,
      missing.length ? 'Ejecuta "claude mcp list" en una terminal. Los conectores de claude.ai que ves en el IDE o en la web no siempre los carga "claude -p": agrégalo al CLI (claude mcp add …) y autorízalo con /mcp, o usa una credencial y un step de comando.' : null);
  }

  // corporate TLS proxy: Node ≥ 22.15 can trust the OS certificate store (server/certs.js)
  const sysCa = typeof tls.getCACertificates === 'function';
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  add('tls', 'Certificados (proxy corporativo)', sysCa || (extra ? fs.existsSync(extra) : null),
    `Node ${process.versions.node}${sysCa ? ' · usa los certificados del sistema' : ' · NO puede usar los certificados del sistema'}${extra ? ` · NODE_EXTRA_CA_CERTS ${fs.existsSync(extra) ? 'definido' : 'apunta a un archivo que no existe'}` : ''}${process.env.HTTPS_PROXY || process.env.https_proxy ? ' · proxy HTTPS configurado' : ''}`,
    sysCa ? null : 'Detrás de un proxy que inspecciona TLS, usa Node 22.15 o superior, o define NODE_EXTRA_CA_CERTS con el certificado raíz de tu empresa.');

  let writable = false;
  try { fs.mkdirSync(store.DATA, { recursive: true }); const t = path.join(store.DATA, `.write-check-${process.pid}`); fs.writeFileSync(t, 'ok'); fs.rmSync(t); writable = true; } catch {}
  add('data', 'Carpeta de datos', writable, store.DATA, writable ? null : 'La app no puede escribir en su carpeta de datos: revisa los permisos o define AFS_DATA.');

  return { rows, checkedAt: Date.now(), probedAt: init?.at || null };
}
