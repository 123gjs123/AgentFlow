// Flow requirements / preflight (spec 23): what a flow needs on the machine where it runs (tools, files such as a
// secrets file, environment variables, reachable services, MCP connectors), checked automatically and explained to
// whoever uses the flow, not only to its author. Required ones block the start of a run with the instructions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as P from './prompt.js';
import { lastInit, probeInit } from './claude.js';

export const REQ_TYPES = ['tool', 'file', 'env', 'url', 'mcp'];
export const ICON = { tool: '🧰', file: '📄', env: '🔑', url: '🌐', mcp: '🔌' };

/** Known tools: default check and install help (Windows-first, with links). */
export const KNOWN_TOOLS = {
  docker: { check: 'docker info --format "{{.ServerVersion}}"', help: 'Instala Docker Desktop (https://www.docker.com/products/docker-desktop/) y ábrelo: tiene que estar corriendo (ícono de la ballena) antes de ejecutar.' },
  git: { check: 'git --version', help: 'Instala Git for Windows (https://git-scm.com/download/win). Configura tus credenciales del repositorio (Git Credential Manager) haciendo un git clone a mano una vez.' },
  python: { check: 'python --version', help: 'Instala Python 3 (https://www.python.org/downloads/) marcando "Add python to PATH".' },
  node: { check: 'node --version', help: 'Instala Node.js LTS (https://nodejs.org/).' },
  npm: { check: 'npm --version', help: 'Viene con Node.js LTS (https://nodejs.org/).' },
  npx: { check: 'npx --version', help: 'Viene con Node.js LTS (https://nodejs.org/).' },
  java: { check: 'java -version', help: 'Instala un JDK (por ejemplo https://adoptium.net/).' },
  mvn: { check: 'mvn -v', help: 'Instala Maven (https://maven.apache.org/download.cgi) y agrégalo al PATH.' },
  gradle: { check: 'gradle -v', help: 'Instala Gradle (https://gradle.org/install/) o usa el wrapper del repo.' },
  dotnet: { check: 'dotnet --version', help: 'Instala el SDK de .NET (https://dotnet.microsoft.com/download).' },
  kubectl: { check: 'kubectl version --client', help: 'Instala kubectl (https://kubernetes.io/docs/tasks/tools/) y configura el contexto del clúster.' },
  helm: { check: 'helm version', help: 'Instala Helm (https://helm.sh/docs/intro/install/).' },
  argo: { check: 'argo version', help: 'Instala el CLI de Argo Workflows (https://github.com/argoproj/argo-workflows/releases) y configura el acceso al clúster.' },
  az: { check: 'az --version', help: 'Instala Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli) y ejecuta az login.' },
  aws: { check: 'aws --version', help: 'Instala AWS CLI (https://aws.amazon.com/cli/) y configura tus credenciales.' },
  gh: { check: 'gh --version', help: 'Instala GitHub CLI (https://cli.github.com/) y ejecuta gh auth login.' },
  pwsh: { check: 'pwsh -v', help: 'Instala PowerShell 7 (https://aka.ms/powershell).' },
  bash: { check: '', help: 'Instala Git for Windows (incluye Git Bash).' },
};

/** Paths may use {{vars.x}}, %VAR%, $env:VAR and ~. */
export function expandPath(p, flow) {
  let s = P.render(String(p || ''), { flow, vars: flow.vars || {} }).trim();
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m).replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => process.env[k] ?? m);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return s;
}

function run(file, args, { timeoutMs = 20000, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    let child;
    try { child = spawn(file, args, { windowsHide: true, shell }); } catch (e) { resolve({ code: -1, out: e.message }); return; }
    const t = setTimeout(() => { if (done) return; done = true; try { child.kill(); } catch {} resolve({ code: -2, out: 'tiempo agotado' }); }, timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(t); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out }); });
    child.stdin?.end();
  });
}
const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
const which = async (name) => {
  const r = process.platform === 'win32' ? await run('where.exe', [name], { timeoutMs: 8000 }) : await run('sh', ['-c', `command -v ${JSON.stringify(name)}`], { timeoutMs: 8000 });
  return r.code === 0 ? firstLine(r.out) : null;
};

/** Default label and help for a requirement. */
export function describe(req, flow) {
  const t = KNOWN_TOOLS[String(req.name || '').toLowerCase()];
  switch (req.type) {
    case 'tool': return { label: req.label || `${req.name} instalado${req.check ?? t?.check ? '' : ''}`, help: req.help || t?.help || `Instala ${req.name} y asegúrate de que está en el PATH.` };
    case 'file': return { label: req.label || `Archivo ${expandPath(req.path, flow)}`, help: req.help || (req.template ? 'Créalo con "Crear desde plantilla" y completa los valores (no lo subas a git).' : 'Crea este archivo antes de ejecutar.') };
    case 'env': return { label: req.label || `Variable de entorno ${req.name}`, help: req.help || `Define la variable ${req.name} (setx ${req.name} "valor") y reinicia Agent Flow Studio para que la vea.` };
    case 'url': return { label: req.label || `Acceso a ${req.url}`, help: req.help || 'Conéctate a la red/VPN de la empresa o revisa que el servicio esté arriba.' };
    case 'mcp': return { label: req.label || `Conector MCP "${req.server}" conectado`, help: req.help || `Conecta "${req.server}" en Claude Code (claude.ai → Settings → Connectors, o claude mcp add) y pulsa "Comprobar".` };
    default: return { label: req.label || req.type, help: req.help || '' };
  }
}

/** Checks one requirement → {id, type, label, help, ok: true|false|null(unknown), detail, optional, canCreate}. */
export async function checkRequirement(req, flow, { probe = false } = {}) {
  const d = describe(req, flow);
  const out = { id: req.id, type: req.type, label: d.label, help: d.help, optional: !!req.optional, ok: false, detail: '' };
  try {
    switch (req.type) {
      case 'tool': {
        const name = String(req.name || '').trim();
        if (!name) { out.detail = 'falta el nombre de la herramienta'; break; }
        const where = await which(name);
        if (!where) { out.detail = `no está instalada o no está en el PATH`; break; }
        const check = req.check ?? KNOWN_TOOLS[name.toLowerCase()]?.check ?? '';
        if (!check) { out.ok = true; out.detail = where; break; }
        const r = await run(check, [], { shell: true, timeoutMs: 20000 });
        out.ok = r.code === 0;
        out.detail = out.ok ? firstLine(r.out) || where : `instalada, pero "${check}" falla: ${firstLine(r.out) || `exit ${r.code}`}`;
        break;
      }
      case 'file': {
        const p = expandPath(req.path, flow);
        if (!p) { out.detail = 'falta la ruta'; break; }
        let st = null; try { st = fs.statSync(p); } catch {}
        out.path = p;
        if (!st) { out.detail = `no existe: ${p}`; out.canCreate = !!req.template; break; }
        out.ok = true; out.detail = st.isDirectory() ? `carpeta ${p}` : `${p} (${st.size} bytes)`;
        if (!st.isDirectory() && req.template) {
          // Keys declared in the template that are still empty in the file
          const keys = String(req.template).split(/\r?\n/).map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean);
          const have = fs.readFileSync(p, 'utf8');
          // [ \t] instead of \s: with CRLF files "\s*" would jump to the next line and take an empty key as filled
          const empty = keys.filter((k) => !new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*[^\\s#]`, 'm').test(have));
          if (empty.length) { out.ok = false; out.detail = `faltan valores en ${p}: ${empty.join(', ')}`; }
        }
        break;
      }
      case 'env': {
        const v = process.env[String(req.name || '')];
        out.ok = !!(v && v.trim()); out.detail = out.ok ? 'definida' : 'no está definida para Agent Flow Studio';
        break;
      }
      case 'url': {
        const u = expandPath(req.url, flow);
        try {
          const r = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
          out.ok = r.status < 500; out.detail = `HTTP ${r.status}`;
        } catch (e) {
          const code = e.cause?.code || '';
          // A certificate error means the host answered: the TLS chain is not trusted (typically a corporate proxy).
          if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) { out.ok = true; out.detail = `responde (certificado no verificable: ${code}; suele ser el proxy corporativo)`; }
          else out.detail = `no responde (${code || e.message})`;
        }
        break;
      }
      case 'mcp': {
        if (probe && !lastInit.at) await probeInit(flow.cwd);
        if (!lastInit.at) { out.ok = null; out.detail = 'sin comprobar todavía (pulsa "Comprobar")'; break; }
        const name = String(req.server || '').toLowerCase();
        const m = (lastInit.mcpServers || []).find((x) => String(x.name || '').toLowerCase().includes(name));
        out.ok = !!m && m.status === 'connected';
        out.detail = m ? `${m.name}: ${m.status}` : `no aparece entre los conectores (${(lastInit.mcpServers || []).map((x) => x.name).join(', ') || 'ninguno'})`;
        break;
      }
      default: out.detail = `tipo desconocido "${req.type}"`;
    }
  } catch (e) { out.ok = false; out.detail = e.message; }
  return out;
}

const cache = new Map(); // flowId -> {at, key, results}
/** All requirements of a flow (cached 30 s unless fresh). blocking = required ones that failed (ok === false). */
export async function preflight(flow, { fresh = false, probe = false } = {}) {
  const reqs = (flow.requirements || []).filter((r) => r && REQ_TYPES.includes(r.type) && !r.disabled);
  const key = JSON.stringify([reqs, flow.vars]);
  const hit = cache.get(flow.id);
  if (!fresh && hit && hit.key === key && Date.now() - hit.at < 30000) return hit.value;
  const results = [];
  for (const r of reqs) results.push(await checkRequirement(r, flow, { probe }));
  const value = { ok: results.every((r) => r.ok !== false || r.optional), results, blocking: results.filter((r) => r.ok === false && !r.optional), checkedAt: Date.now() };
  cache.set(flow.id, { at: Date.now(), key, value });
  return value;
}
export const clearPreflightCache = (flowId) => cache.delete(flowId);

/** The message a caller gets when a run cannot start. */
export const preflightMessage = (pf) => `Antes de ejecutar este flujo falta: ${pf.blocking.map((b) => `${ICON[b.type] || ''} ${b.label} (${b.detail}) → ${b.help}`).join(' · ')}`;

/** Creates a requirement's file from its template (never overwrites). */
export function createFromTemplate(req, flow) {
  if (req.type !== 'file' || !req.template) throw Object.assign(new Error('Este requisito no tiene plantilla'), { status: 400, code: 'NO_TEMPLATE' });
  const p = expandPath(req.path, flow);
  if (fs.existsSync(p)) throw Object.assign(new Error(`Ya existe ${p}: no se sobrescribe`), { status: 409, code: 'FILE_EXISTS' });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(req.template).replace(/\r?\n/g, os.EOL), { flag: 'wx' });
  clearPreflightCache(flow.id);
  return { path: p };
}

/** Suggestions from what the flow uses (tools in commands and access lists, Atlassian, file-like vars). */
export function suggestRequirements(flow) {
  const have = new Set((flow.requirements || []).map((r) => `${r.type}:${String(r.name || r.path || r.url || r.server || '').toLowerCase()}`));
  const out = [];
  const add = (r) => { const k = `${r.type}:${String(r.name || r.path || r.url || r.server || '').toLowerCase()}`; if (!have.has(k)) { have.add(k); out.push(r); } };
  const texts = [...flow.steps.map((s) => `${s.kind === 'command' ? s.command : ''} ${s.allowedTools || ''} ${(s.assertions || []).map((a) => a.command || '').join(' ')}`), flow.finally?.command || ''].join('\n');
  for (const name of Object.keys(KNOWN_TOOLS)) {
    if (['npm', 'npx', 'bash'].includes(name)) continue;
    const re = new RegExp(`(^|[\\s;|&(\`'"])${name}(\\s|:|\\)|$)`, 'im');
    if (re.test(texts)) add({ type: 'tool', name, ...(KNOWN_TOOLS[name].check ? { check: KNOWN_TOOLS[name].check } : {}) });
  }
  if (flow.steps.some((s) => s.kind === 'command' && s.shell === 'bash') || flow.finally?.shell === 'bash') add({ type: 'tool', name: 'bash' });
  const usesAtlassian = flow.steps.some((s) => /mcp__claude_ai_Atlassian/.test(s.allowedTools || '') || (s.contextSources || []).some((c) => c.type === 'jira' || c.type === 'confluence')) || (flow.contextSources || []).some((c) => c.type === 'jira' || c.type === 'confluence');
  if (usesAtlassian) add({ type: 'mcp', server: 'Atlassian' });
  for (const [k, v] of Object.entries(flow.vars || {})) {
    const val = String(v || '');
    if (/(^[A-Za-z]:\\|^~|^%[A-Z_]+%|^\/)/.test(val) && /\.(env|json|ya?ml|ini|properties|txt|pem|crt|key)$/i.test(val)) add({ type: 'file', path: `{{vars.${k}}}`, label: `Archivo de ${k}`, ...(/env|secret|cred/i.test(k + val) ? { template: '# Secretos para este flujo: completa los valores. NO subas este archivo a git.\n# CLAVE=valor\n' } : {}) });
    if (/^https?:\/\//i.test(val) && !/\.git$/i.test(val)) add({ type: 'url', url: `{{vars.${k}}}`, label: `Acceso a ${k}`, optional: true });
  }
  return out;
}
