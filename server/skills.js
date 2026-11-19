// Spec 13 — skill sources: bring a skill in from a URL (git repo / tree URL / zip / raw SKILL.md), a local folder
// (copy or link) or a zip, review it, and install it for ONE flow (<DATA>/flow-skills/<flow>/.claude/skills, passed to
// Claude with --add-dir) or for the user's whole Claude Code (~/.claude/skills, explicit confirmation).
// Nothing in a skill is executed at install: git runs without hooks/LFS/submodules/symlinks, zips are validated before
// anything is written, downloads use the system CAs (certs.js) and never skip TLS checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { DATA } from './store.js';
import { frontmatter, listSkills } from './catalog.js';
import { SAFE_GIT } from './safe.js';
import { readZip, safeRel, buildZip } from './unzip.js';

const fail = (status, error, code, extra = {}) => Object.assign(new Error(error), { status, code, ...extra });
const safeId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const SCALE = Number(process.env.AFS_TIME_SCALE || 1) || 1;
const TTL_MS = 15 * 60 * 1000 * SCALE;
const MAX_BYTES = 20 * 1024 * 1024; const MAX_FILES = 500;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = /\.(sh|bash|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|exe|dll|vbs|rb|pl|jar|com|msi|scr)$/i;
const USER_SKILLS = () => path.join(os.homedir(), '.claude', 'skills');

// ---------- where flow skills live ----------
export const flowSkillRoot = (flowId) => path.join(DATA, 'flow-skills', safeId(flowId));
export const flowSkillsDir = (flowId) => path.join(flowSkillRoot(flowId), '.claude', 'skills');
const linksFile = (flowId) => path.join(flowSkillRoot(flowId), 'links.json');
const readLinks = (flowId) => { try { const j = JSON.parse(fs.readFileSync(linksFile(flowId), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const writeLinks = (flowId, j) => { fs.mkdirSync(flowSkillRoot(flowId), { recursive: true }); fs.writeFileSync(linksFile(flowId), JSON.stringify(j, null, 2)); };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const unlinkDir = (p) => { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } }; // a junction/symlink only, never its target

/** Dirs to pass to Claude with --add-dir for a flow: the flow-skills root (+ the real folders of linked skills). */
export function flowSkillDirs(flow) {
  const id = typeof flow === 'string' ? flow : flow?.id;
  if (!id) return [];
  const dir = flowSkillsDir(id);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  if (!entries.length) return [];
  const out = [flowSkillRoot(id)];
  for (const e of entries) { const p = path.join(dir, e.name); if (isLink(p)) { try { out.push(fs.realpathSync(p)); } catch {} } }
  return out;
}

// ---------- tokens of an inspection (15 min) ----------
const pending = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) { pending.delete(k); if (v.tmp) fs.rm(v.tmp, { recursive: true, force: true }, () => {}); } }, Math.max(1000, 60000 * SCALE)).unref();
const remember = (token, v) => {
  pending.set(token, v);
  const same = [...pending].filter(([, o]) => !!o.flowId === !!v.flowId);
  while (same.length > 20) { const [k, o] = same.shift(); pending.delete(k); if (o.tmp) fs.rm(o.tmp, { recursive: true, force: true }, () => {}); }
};
// L4: temp folders of a previous run (crash, restart) are swept at startup; this run's are removed on exit
try { const now = Date.now(); for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('afs-skill-')) { const p = path.join(os.tmpdir(), d); try { if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch {} } } catch {}
for (const sig of ['SIGINT', 'SIGBREAK']) process.once(sig, () => process.exit(130));
process.on('exit', () => { for (const [, o] of pending) if (o.tmp) { try { fs.rmSync(o.tmp, { recursive: true, force: true }); } catch {} } });
const newTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afs-skill-'));

// ---------- scanning ----------
// links: 'error' (a source to copy/scan) | 'skip' (hash/export of an installed skill: never leave its folder)
function walkFiles(root, { followLinks = false, links = followLinks ? 'skip' : 'error' } = {}) {
  const files = []; let size = 0;
  root = fs.realpathSync(root); // a linked skill: its own folder, once
  const go = (d, rel, depth) => {
    if (depth > 12) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { if (links === 'skip') continue; throw fail(422, `La carpeta contiene un enlace simbólico: ${r}`, 'FOLDER_SYMLINK'); }
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (st.isDirectory()) go(p, r, depth + 1);
      else if (st.isFile()) {
        files.push({ path: r, size: st.size }); size += st.size;
        if (files.length > MAX_FILES) throw fail(413, `La fuente tiene más de ${MAX_FILES} archivos`, 'SOURCE_TOO_MANY');
        if (size > MAX_BYTES) throw fail(413, `La fuente supera ${MAX_BYTES / 1048576} MB`, 'SOURCE_TOO_BIG');
      }
    }
  };
  go(root, '', 0);
  return { files, size };
}
const looksScript = (abs, rel) => {
  if (SCRIPT_EXT.test(rel)) return true;
  try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b.toString() === '#!'; } catch { return false; }
};
export function skillHash(dir) {
  const h = crypto.createHash('sha256');
  const { files } = walkFiles(dir, { followLinks: true });
  const real = fs.realpathSync(dir);
  for (const f of files.filter((x) => x.path !== '.afs-origin.json').sort((a, b) => (a.path < b.path ? -1 : 1))) { h.update(f.path); h.update('\0'); h.update(fs.readFileSync(path.join(real, f.path))); h.update('\0'); }
  return h.digest('hex');
}

/** Every folder with a SKILL.md under dir → candidates with what the review shows (SKSRC-5/7/8). */
export function scan(dir, { followLinks = false } = {}) {
  walkFiles(dir, { followLinks }); // limits + symlinks for the whole source
  const found = [];
  const go = (d, rel, depth) => {
    if (depth > 6) return;
    let entries = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === 'SKILL.md' && e.isFile())) found.push(rel);
    for (const e of entries) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') go(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
  };
  go(dir, '', 0);
  return found.map((rel) => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    const nested = walkFiles(abs, { followLinks }).files.filter((f) => /(^|\/)SKILL\.md$/.test(f.path) && f.path !== 'SKILL.md').map((f) => f.path.replace(/\/?SKILL\.md$/, ''));
    const meta = frontmatter(path.join(abs, 'SKILL.md'));
    const { files, size } = walkFiles(abs, { followLinks });
    const problems = [];
    const txt = fs.readFileSync(path.join(abs, 'SKILL.md'), 'utf8');
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(txt)) problems.push('SKILL.md no tiene front matter (--- name / description ---)');
    if (!meta.name) problems.push('Falta "name" en el front matter');
    else if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(meta.name)) problems.push(`"name" es un nombre reservado de Windows (${meta.name})`);
    else if (!NAME_RE.test(meta.name)) problems.push(`"name" inválido (${meta.name}): minúsculas, números y guiones, hasta 64`);
    if (!meta.description) problems.push('Falta "description" en el front matter');
    if (nested.length) problems.push(`Contiene otra skill adentro (${nested.join(', ')}): instálalas por separado`);
    // M2: what Claude Code applies beyond name/description is shown (hooks run commands; non-scalar allowed-tools)
    const fmRaw = (txt.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const topKeys = fmRaw.split(/\r?\n/).filter((l) => !/^\s/.test(l)).map((l) => (l.match(/^([A-Za-z_-]+):/) || [])[1]).filter(Boolean);
    const warnings = [];
    // deny by default: every top-level line must be a plain "key: value" (no ? explicit keys, quoted/escaped keys, merge
    // keys, anchors, aliases, tags, flow mappings): what we review is then what any YAML parser reads
    for (const l of fmRaw.split(/\r?\n/)) {
      if (/^\s/.test(l) || !l.trim() || /^#/.test(l)) continue;
      const kv = l.match(/^[A-Za-z_-]+:(\s+(.*))?$/);
      if (!kv) { problems.push(`Línea del front matter con formato no admitido: ${l.trim().slice(0, 60)}`); continue; }
      if (/^[&*!]/.test(kv[2] || '')) problems.push(`Anclas, alias o etiquetas YAML no admitidos: ${l.trim().slice(0, 60)}`);
    }
    if (topKeys.includes('hooks')) warnings.push('Define hooks: comandos que Claude Code ejecuta mientras la skill está activa. Revísalos en el front matter.');
    for (const k of topKeys.filter((x) => !['name', 'description', 'allowed-tools', 'hooks', 'license', 'version', 'metadata'].includes(x))) warnings.push(`Clave adicional en el front matter: "${k}"`);
    { const fm = (txt.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''; const lines = fm.split(/\r?\n/).filter((l) => !/^\s/.test(l)); const keys = lines.map((l) => (l.match(/^["']?([A-Za-z_-]+)["']?\s*:/) || [])[1]).filter(Boolean); const odd = lines.find((l) => /^["']?[A-Za-z_-]+["']?\s*:/.test(l) && !/^[A-Za-z_-]+:/.test(l)); if (odd) problems.push(`Clave del front matter con formato no estándar: ${odd.trim().slice(0, 60)}`); const dup = keys.find((k, i) => keys.indexOf(k) !== i); if (dup) problems.push(`Clave repetida en el front matter: "${dup}"`); }
    const scripts = files.filter((f) => looksScript(path.join(abs, f.path), f.path)).map((f) => f.path);
    return {
      name: meta.name || path.basename(abs), description: String(meta.description || '').slice(0, 500), allowedTools: meta['allowed-tools'] || '', frontmatter: fmRaw.slice(0, 4000), warnings,
      relDir: rel, size, hasScripts: scripts.length > 0, files: files.map((f) => ({ ...f, script: scripts.includes(f.path) })), problems, hash: skillHash(abs),
    };
  });
}

// ---------- sources ----------
const BRANCH_RE = /^(?!.*\.\.)(?!-)[\w][\w./+-]{0,200}$/;
const SUB_RE = /^(?!.*(^|\/)\.\.?(\/|$))[\w .@+()-]+(\/[\w .@+()-]+)*$/;
const cleanSub = (s) => { const v = decodeURIComponent(String(s || '')).replace(/^\/+|\/+$/g, ''); if (v && (!SUB_RE.test(v) || safeRel(v))) throw fail(400, `Ruta dentro del repo no válida: ${v}`, 'BAD_SOURCE'); return v; };
const cleanBranch = (b) => { const v = decodeURIComponent(String(b || '')).replace(/^refs\/heads\//, ''); if (v && !BRANCH_RE.test(v)) throw fail(400, `Rama no válida: ${v}`, 'BAD_SOURCE'); return v; };
const strip = (u) => { try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString(); } catch { return String(u); } };

/** URL → { type: git|zip|file|http, url, branch, subPath } (SKSRC-2). */
export function parseSource(input) {
  const raw = String(input ?? '').trim();
  if (!raw || /\s/.test(raw) || raw.startsWith('-')) throw fail(400, 'Pega una URL https:// sin espacios', 'BAD_SOURCE');
  const [base, frag] = raw.split('#');
  let u; try { u = new URL(base); } catch { throw fail(400, 'No es una URL válida', 'BAD_SOURCE'); }
  if (u.protocol !== 'https:') throw fail(400, 'Solo se aceptan URLs https://', 'BAD_SOURCE');
  if (u.username || u.password) throw fail(400, 'La URL no puede llevar usuario o contraseña: el acceso a repos privados usa tu git (administrador de credenciales)', 'BAD_SOURCE');
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = u.hostname.toLowerCase();
  const gitUrl = (p) => `${u.origin}/${p}`;
  if (frag !== undefined) { // repo.git#branch:path
    const [b, sp] = frag.split(':');
    return { type: 'git', url: u.href.replace(/\/$/, ''), branch: cleanBranch(b), subPath: cleanSub(sp) };
  }
  if (/\.zip$/i.test(u.pathname)) return { type: 'zip', url: u.toString() };
  if (host === 'github.com' && segs.length >= 2) {
    const repo = gitUrl(`${segs[0]}/${segs[1].replace(/\.git$/, '')}.git`);
    if ((segs[2] === 'tree' || segs[2] === 'blob') && segs[3]) {
      let sub = segs.slice(4).join('/'); if (segs[2] === 'blob' && /(^|\/)SKILL\.md$/i.test(sub)) sub = sub.replace(/\/?SKILL\.md$/i, '');
      return { type: 'git', url: repo, branch: cleanBranch(segs[3]), subPath: cleanSub(sub) };
    }
    if (segs.length === 2) return { type: 'git', url: repo, branch: '', subPath: '' };
  }
  if (host === 'bitbucket.org' && segs.length >= 2) {
    const repo = gitUrl(`${segs[0]}/${segs[1].replace(/\.git$/, '')}.git`);
    if (segs[2] === 'src' && segs[3]) return { type: 'git', url: repo, branch: cleanBranch(segs[3]), subPath: cleanSub(segs.slice(4).join('/').replace(/\/?SKILL\.md$/i, '')) };
    if (segs.length === 2) return { type: 'git', url: repo, branch: '', subPath: '' };
  }
  // Bitbucket Server / Data Center: /projects/P/repos/R/browse/path?at=refs/heads/x
  const bi = segs.indexOf('repos');
  if (segs[0] === 'projects' && bi === 2 && segs[3]) {
    const repo = gitUrl(`scm/${segs[1].toLowerCase()}/${segs[3]}.git`);
    const sub = segs[4] === 'browse' ? segs.slice(5).join('/').replace(/\/?SKILL\.md$/i, '') : '';
    return { type: 'git', url: repo, branch: cleanBranch(u.searchParams.get('at') || ''), subPath: cleanSub(sub) };
  }
  // GitLab: /group/repo/-/tree/branch/path
  const di = segs.indexOf('-');
  if (di >= 2 && (segs[di + 1] === 'tree' || segs[di + 1] === 'blob') && segs[di + 2]) {
    return { type: 'git', url: gitUrl(`${segs.slice(0, di).join('/')}.git`), branch: cleanBranch(segs[di + 2]), subPath: cleanSub(segs.slice(di + 3).join('/').replace(/\/?SKILL\.md$/i, '')) };
  }
  if (/\.git$/i.test(u.pathname)) return { type: 'git', url: u.toString(), branch: '', subPath: '' };
  if (/(^|\/)SKILL\.md$/i.test(u.pathname)) return { type: 'file', url: u.toString() };
  return { type: 'http', url: u.toString() };
}

// SSRF (D7): private networks are fine (corporate Bitbucket/GitLab); this machine (loopback, any of its own addresses)
// and link-local (cloud metadata) are not. net.BlockList also matches IPv4-mapped IPv6 (::ffff:7f00:1 = 127.0.0.1).
function blockList() {
  const b = new net.BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4'); b.addSubnet('0.0.0.0', 8, 'ipv4'); b.addSubnet('169.254.0.0', 16, 'ipv4');
  b.addAddress('::1', 'ipv6'); b.addAddress('::', 'ipv6'); b.addSubnet('fe80::', 10, 'ipv6');
  b.addSubnet('::', 96, 'ipv6'); b.addSubnet('64:ff9b::', 96, 'ipv6'); b.addSubnet('64:ff9b:1::', 48, 'ipv6'); // IPv4-compatible / NAT64
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) { try { b.addAddress(a.address.split('%')[0], a.family === 'IPv6' || a.family === 6 ? 'ipv6' : 'ipv4'); } catch {} }
  return b;
}
export const blockedIp = (ip) => { const a = String(ip).split('%')[0]; const v = net.isIP(a); if (!v) return true; return blockList().check(a, v === 6 ? 'ipv6' : 'ipv4'); };
const seam = () => process.env.AFS_SKILLS_ALLOW_LOOPBACK === '1';
/** Resolves the host and checks EVERY address; returns the addresses (the connection is pinned to them). */
export async function checkHost(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw fail(502, `No se pudo resolver ${host}`, 'DOWNLOAD_FAILED'); })).map((x) => x.address);
  if (!seam() && ips.some(blockedIp)) throw fail(400, 'La URL apunta a esta máquina o a una dirección interna no permitida', 'SOURCE_BLOCKED');
  return ips;
}
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|UNABLE_TO_GET_ISSUER/i;
/** One HTTPS GET connected to an address that was checked (no DNS rebinding); system CAs via certs.js, TLS verified. */
const getOnce = (url, ips, { signal }) => new Promise((resolve, reject) => {
  const lookup = (hostname, opts, cb) => { const ip = ips[0]; const fam = net.isIP(ip); if (opts?.all) cb(null, [{ address: ip, family: fam }]); else cb(null, ip, fam); };
  const req = https.get(url, { lookup, headers: { 'User-Agent': 'agent-flow-studio' }, signal: signal || AbortSignal.timeout(60000), timeout: 60000 }, resolve);
  req.on('error', reject);
});
async function download(url, { signal: outer, max = MAX_BYTES } = {}) {
  let cur = url;
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  for (let hop = 0; hop <= 5; hop++) {
    if (!/^https:\/\//i.test(cur)) throw fail(400, 'La descarga redirigió a una URL que no es https://', 'BAD_SOURCE');
    const ips = await checkHost(cur);
    let r;
    try { r = await getOnce(cur, ips, { signal }); }
    catch (e) {
      const c = `${e?.code || ''} ${e?.message || ''}`;
      if (TLS_CODES.test(c)) throw fail(502, 'Certificado no confiable: revisa que el certificado del proxy esté en el almacén del sistema', 'TLS_ERROR');
      throw fail(502, `No se pudo descargar: ${e?.code || 'error de red'}`, 'DOWNLOAD_FAILED');
    }
    if ([301, 302, 303, 307, 308].includes(r.statusCode)) { r.resume(); const loc = r.headers.location; if (!loc) break; cur = new URL(loc, cur).toString(); continue; }
    if (r.statusCode < 200 || r.statusCode >= 300) { r.resume(); throw fail(502, `No se pudo descargar: HTTP ${r.statusCode}`, 'DOWNLOAD_FAILED'); }
    if (Number(r.headers['content-length'] || 0) > max) { r.destroy(); throw fail(413, `La descarga supera ${max / 1048576} MB`, 'ZIP_TOO_BIG'); }
    const chunks = []; let n = 0;
    try { for await (const c of r) { n += c.length; if (n > max) { r.destroy(); throw fail(413, `La descarga supera ${max / 1048576} MB`, 'ZIP_TOO_BIG'); } chunks.push(c); } }
    catch (e) { if (e.status) throw e; throw fail(502, `No se pudo descargar: la conexión se cortó o tardó demasiado (${e.code || 'error'})`, 'DOWNLOAD_FAILED'); }
    return { buf: Buffer.concat(chunks), type: String(r.headers['content-type'] || '') };
  }
  throw fail(502, 'Demasiadas redirecciones', 'DOWNLOAD_FAILED');
}

// git without hooks, templates, LFS filters, submodules or symlinks; only https (file:// for offline tests behind a
// flag); no redirects and the connection pinned to the checked addresses (http.curloptResolve).
const gitArgs = (hooks, pin = []) => [
  '-c', `core.hooksPath=${hooks}`, '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  ...(process.env.AFS_SKILLS_ALLOW_FILE_GIT === '1' ? ['-c', 'protocol.file.allow=always'] : []),
  '-c', 'http.followRedirects=false', ...pin.flatMap((p) => ['-c', `http.curloptResolve=${p}`]),
  '-c', 'submodule.recurse=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'core.longpaths=true', ...SAFE_GIT,
];
const git = (args, { cwd, signal } = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: signal || undefined, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' } },
    (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(fail(502, 'git no está instalado en esta PC', 'GIT_FAILED'));
      const last = String(stderr || err.message).trim().split(/\r?\n/).filter(Boolean).pop() || 'git falló';
      const tls = TLS_CODES.test(last) || /SSL certificate/i.test(last);
      reject(fail(502, tls ? `Certificado no confiable al clonar: ${last}` : `git: ${last}`, tls ? 'TLS_ERROR' : 'GIT_FAILED'));
    });
});
async function gitClone(src, dest, signal) {
  const ips = await checkHost(src.url);
  const u = new URL(src.url);
  const pin = !seam() && !net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? [`${u.hostname}:${u.port || 443}:${ips.map((ip) => (net.isIP(ip) === 6 ? `[${ip}]` : ip)).join(',')}`] : [];
  const hooks = newTmp();
  try {
    const base = gitArgs(hooks, pin);
    await git([...base, 'clone', '--template=', '--depth', '1', '--no-tags', '--single-branch', ...(src.branch ? ['--branch', src.branch] : []), ...(src.subPath ? ['--filter=blob:none', '--sparse'] : []), '--', src.url, dest], { signal });
    if (src.subPath) await git([...base, 'sparse-checkout', 'set', '--', src.subPath], { cwd: dest, signal });
    let head = ''; try { head = (await git([...base, 'rev-parse', 'HEAD'], { cwd: dest })).trim(); } catch {}
    fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
    return head;
  } finally { fs.rmSync(hooks, { recursive: true, force: true }); }
}

/** Writes validated zip entries under dir (zip-slip checked again on the real path); fs errors never leak paths. */
function writeEntries(dir, entries) {
  const root = fs.realpathSync(dir);
  for (const e of entries) {
    const target = path.join(root, ...e.name.split('/'));
    if (!path.resolve(target).startsWith(root + path.sep)) throw fail(422, `El zip contiene una ruta peligrosa: ${e.name}`, 'ZIP_UNSAFE');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data, { flag: 'wx' });
      if (!fs.realpathSync(target).startsWith(root + path.sep)) throw new Error('escape');
    } catch { throw fail(422, `El zip contiene una ruta que choca con otra o no es válida en Windows: ${e.name.slice(0, 200)}`, 'ZIP_UNSAFE'); }
  }
}

/**
 * Inspect a source (SKSRC-2/3/4/5/8): { url } | { path } | { zipBase64, fileName } → { token, origin, skills }.
 * Downloads/extracts into a temp folder kept for 15 minutes; nothing is installed.
 */
export async function inspect(body = {}, { signal } = {}) {
  let dir; let tmp = null; let origin;
  try {
    if (body.url !== undefined) {
      const src = parseSource(body.url);
      tmp = newTmp();
      if (src.type === 'git') {
        const dest = path.join(tmp, 'src'); const head = await gitClone(src, dest, signal);
        dir = src.subPath ? path.join(dest, ...src.subPath.split('/')) : dest;
        if (!fs.existsSync(dir)) throw fail(422, `La carpeta «${src.subPath}» no existe en el repo`, 'NO_SKILLS');
        origin = { type: 'url', kind: 'git', source: strip(body.url), url: strip(src.url), ref: src.branch || '', subPath: src.subPath || '', head };
      } else {
        const { buf, type } = await download(src.url, { signal });
        dir = path.join(tmp, 'src'); fs.mkdirSync(dir);
        const isZip = src.type === 'zip' || /zip/i.test(type) || buf.subarray(0, 2).toString() === 'PK';
        if (isZip) writeEntries(dir, readZip(buf));
        else {
          const txt = buf.toString('utf8');
          if (!/^---\r?\n/.test(txt)) throw fail(422, 'La URL no es un zip, un repo git ni un SKILL.md', 'NO_SKILLS');
          const name = frontmatter(null, txt).name;
          const sub = path.join(dir, NAME_RE.test(name || '') ? name : 'skill'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'SKILL.md'), txt);
        }
        origin = { type: 'url', kind: isZip ? 'zip' : 'file', source: strip(body.url), url: strip(src.url), ref: '', subPath: '' };
      }
    } else if (body.path !== undefined) {
      const p = String(body.path || '').trim();
      if (!p || !path.isAbsolute(p)) throw fail(400, 'Indica la ruta completa de la carpeta (o del .zip)', 'BAD_SOURCE');
      let st; try { st = fs.statSync(p); } catch { throw fail(404, `No existe: ${p}`, 'SOURCE_NOT_FOUND'); }
      if (st.isFile() && /\.zip$/i.test(p)) {
        if (st.size > MAX_BYTES) throw fail(413, `El zip supera ${MAX_BYTES / 1048576} MB`, 'ZIP_TOO_BIG');
        tmp = newTmp(); dir = path.join(tmp, 'src'); fs.mkdirSync(dir); writeEntries(dir, readZip(fs.readFileSync(p)));
        origin = { type: 'zip', source: p };
      } else if (st.isDirectory()) { dir = fs.realpathSync(p); origin = { type: 'folder', source: dir }; }
      else throw fail(400, 'La ruta debe ser una carpeta o un .zip', 'BAD_SOURCE');
    } else if (body.zipBase64 !== undefined) {
      const buf = Buffer.from(String(body.zipBase64 || ''), 'base64');
      tmp = newTmp(); dir = path.join(tmp, 'src'); fs.mkdirSync(dir); writeEntries(dir, readZip(buf));
      origin = { type: 'zip', source: String(body.fileName || 'subido.zip').slice(0, 200) };
    } else throw fail(400, 'Indica url, path o zipBase64', 'BAD_SOURCE');
    const skills = scan(dir);
    if (!skills.length) throw fail(422, 'No se encontró ninguna carpeta con SKILL.md', 'NO_SKILLS');
    const token = crypto.randomUUID();
    remember(token, { dir, tmp, origin, skills, expires: Date.now() + TTL_MS });
    return { token, origin, expiresInSec: Math.round(TTL_MS / 1000), skills: skills.map(({ hash, ...s }) => s) };
  } catch (e) { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}

// ---------- installed skills ----------
const rankOf = { flow: 0, linked: 1, project: 2, user: 3, 'claude.ai': 4 };
/** Where a name is already taken for the given scope (D3: a user/project skill would hide a flow skill). */
function conflictsFor(name, scope, flow) {
  const all = listSkills(flow?.cwd, flow?.id).filter((s) => s.name === name && !String(s.source).startsWith('plugin'));
  if (scope !== 'user') return all.filter((s) => ['flow', 'linked', 'user', 'project'].includes(s.source));
  const flows = []; try { for (const id of fs.readdirSync(path.join(DATA, 'flow-skills'))) { const p = path.join(DATA, 'flow-skills', id, '.claude', 'skills', name, 'SKILL.md'); if (fs.existsSync(p)) flows.push({ name, source: 'flow', path: p, flowId: id }); } } catch {}
  return [...all.filter((s) => s.source === 'user'), ...flows];
}
const readOrigin = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.afs-origin.json'), 'utf8')); } catch { return null; } };
function renameInSkill(dir, to) {
  const f = path.join(dir, 'SKILL.md'); const txt = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, txt.replace(/^(---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${to}`));
  if (frontmatter(f).name !== to) throw fail(422, 'No se pudo renombrar la skill (front matter)', 'SKILL_INVALID');
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) throw fail(422, `La carpeta contiene un enlace simbólico: ${e.name}`, 'FOLDER_SYMLINK');
    if (st.isDirectory()) copyDir(a, b); else if (st.isFile()) fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
  }
}

/**
 * Install reviewed skills (SKSRC-6/7/10). opts: { token, names[], scope: flow|user, flow, mode: copy|link,
 * confirmUser, resolve: { [name]: { action: rename|replace|cancel, to } } }. A conflict without a decision → 409.
 */
export function install({ token, names, scope = 'flow', flow = null, mode = 'copy', confirmUser = false, resolve = {} } = {}) {
  const p = pending.get(String(token || ''));
  if (p?.flowId && (scope !== 'flow' || flow?.id !== p.flowId)) throw fail(400, 'Esta revisión es para las skills del flujo importado: instálalas en ese flujo', 'TOKEN_SCOPE');
  if (!p || p.expires < Date.now()) throw fail(410, 'La revisión caducó (15 min) o no existe: vuelve a cargar la fuente', 'TOKEN_EXPIRED');
  if (!['flow', 'user'].includes(scope)) throw fail(400, '"scope" debe ser "flow" o "user"', 'BAD_SCOPE');
  if (!['copy', 'link'].includes(mode)) throw fail(400, '"mode" debe ser "copy" o "link"', 'BAD_MODE');
  if (scope === 'flow' && !flow) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND');
  if (scope === 'user' && confirmUser !== true) throw fail(400, 'Instalar en tu Claude Code afecta todas tus sesiones: confírmalo', 'CONFIRM_REQUIRED');
  if (mode === 'link' && (p.origin.type !== 'folder' || scope !== 'flow')) throw fail(400, 'Vincular solo se puede con una carpeta local y para este flujo', 'LINK_SCOPE');
  const want = Array.isArray(names) && names.length ? names.map(String) : p.skills.map((s) => s.name);
  const picked = want.map((n) => { const c = p.skills.find((s) => s.name === n); if (!c) throw fail(400, `La fuente no tiene la skill «${n}»`, 'SKILL_INVALID'); return c; });
  for (const c of picked) if (c.problems.length) throw fail(422, `«${c.name}»: ${c.problems.join('; ')}`, 'SKILL_INVALID');
  if (new Set(picked.map((c) => c.name)).size !== picked.length) throw fail(400, 'Hay dos skills con el mismo nombre en la selección', 'SKILL_INVALID');
  // folder sources are read in place: what is installed must be what was reviewed
  if (p.origin.type === 'folder') for (const c of picked) { const abs = c.relDir ? path.join(p.dir, ...c.relDir.split('/')) : p.dir; if (!fs.existsSync(abs) || skillHash(abs) !== c.hash) throw fail(409, `«${c.name}» cambió desde la revisión: vuelve a cargar la carpeta`, 'SOURCE_CHANGED'); }
  const target = scope === 'flow' ? flowSkillsDir(flow.id) : USER_SKILLS();
  const plan = []; const conflicts = []; const skipped = [];
  for (const c of picked) {
    const r = resolve?.[c.name] || null;
    if (r?.action === 'cancel') { skipped.push(c.name); continue; }
    let name = c.name;
    if (r?.action === 'rename') {
      name = String(r.to || '').trim();
      if (!NAME_RE.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) throw fail(400, `Nombre nuevo inválido para «${c.name}»: minúsculas, números y guiones`, 'BAD_NAME');
      if (mode === 'link') throw fail(400, 'Una skill vinculada no se puede renombrar (su carpeta es tuya): cópiala', 'LINK_SCOPE');
    }
    const replacing = r?.action === 'replace' || (r?.action === 'rename' && r.replace === true); // an update of a renamed skill
    const dest0 = path.join(target, name);
    const managedDir = (d) => (isLink(d) ? scope === 'flow' && !!readLinks(flow.id)[path.basename(d)] : !!readOrigin(d));
    const clash = conflictsFor(name, scope, flow).filter((s) => !(replacing && path.resolve(path.dirname(s.path)) === path.resolve(dest0) && managedDir(dest0)));
    if (clash.length) { conflicts.push({ name, source: c.name, existing: clash.map((s) => ({ source: s.source, path: s.path })), canReplace: clash.every((s) => path.resolve(path.dirname(s.path)) === path.resolve(dest0) && managedDir(dest0)) }); continue; }
    const dest = path.join(target, name);
    const exists = fs.existsSync(dest) || isLink(dest);
    const managed = exists && (isLink(dest) ? scope === 'flow' && !!readLinks(flow.id)[name] : !!readOrigin(dest));
    if (exists && !(replacing && managed)) { conflicts.push({ name, source: c.name, existing: [{ source: scope === 'user' ? 'user' : 'flow', path: path.join(dest, 'SKILL.md') }], canReplace: managed }); continue; }
    plan.push({ c, name, dest, replace: exists });
  }
  if (conflicts.length) throw fail(409, `Ya existe: ${conflicts.map((x) => x.name).join(', ')}. Elige renombrar, reemplazar o cancelar.`, 'SKILL_EXISTS', { conflicts });
  fs.mkdirSync(target, { recursive: true });
  const staging = path.join(path.dirname(target), '.afs-staging'); fs.mkdirSync(staging, { recursive: true });
  const busy = (e) => fail(409, `No se pudo reemplazar: un archivo de la skill está abierto (Claude, un editor o el antivirus). Ciérralo y reintenta. (${e.code || 'error'})`, 'SKILL_BUSY');
  const mv = (a, b) => { try { fs.renameSync(a, b); } catch (e) { throw busy(e); } };
  const installed = [];
  for (const { c, name, dest, replace } of plan) {
    const src = c.relDir ? path.join(p.dir, ...c.relDir.split('/')) : p.dir;
    const origin = { ...p.origin, mode, name, originalName: c.name, sha256: c.hash, installedAt: new Date().toISOString() };
    const backup = replace ? path.join(staging, `old-${name}-${crypto.randomBytes(4).toString('hex')}`) : null;
    if (mode === 'link') {
      if (backup) mv(dest, backup);
      try { fs.symlinkSync(fs.realpathSync(src), dest, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (e) { if (backup) fs.renameSync(backup, dest); throw fail(500, `No se pudo vincular la carpeta (${e.code || 'error'})`, 'LINK_FAILED'); }
      const links = readLinks(flow.id); links[name] = { ...origin, target: fs.realpathSync(src) }; writeLinks(flow.id, links);
    } else {
      const tmpDest = path.join(staging, `new-${crypto.randomBytes(6).toString('hex')}`);
      try {
        copyDir(src, tmpDest);
        if (name !== c.name) renameInSkill(tmpDest, name);
        fs.writeFileSync(path.join(tmpDest, '.afs-origin.json'), JSON.stringify(origin, null, 2));
        if (backup) mv(dest, backup);
        mv(tmpDest, dest);
      } catch (e) { fs.rmSync(tmpDest, { recursive: true, force: true }); if (backup && !fs.existsSync(dest) && fs.existsSync(backup)) { try { fs.renameSync(backup, dest); } catch {} } if (e.code && !e.status) throw busy(e); throw e; }
      if (scope === 'flow') { const links = readLinks(flow.id); if (links[name]) { delete links[name]; writeLinks(flow.id, links); } }
    }
    if (backup) { try { if (isLink(backup)) unlinkDir(backup); else fs.rmSync(backup, { recursive: true, force: true }); } catch {} } // best effort: staging is outside the skills folder
    installed.push({ name, scope, source: mode === 'link' ? 'linked' : scope === 'flow' ? 'flow' : 'user', path: path.join(dest, 'SKILL.md') });
  }
  pending.delete(String(token)); if (p.tmp) fs.rm(p.tmp, { recursive: true, force: true }, () => {});
  return { installed, skipped };
}

/** The installed skill of a scope → { dir, origin, linked } or a 403/404 error (SKSRC-14). */
function locate(name, scope, flow) {
  if (!NAME_RE.test(String(name || ''))) throw fail(404, 'Skill no encontrada', 'SKILL_NOT_FOUND');
  if (scope === 'flow') {
    if (!flow) throw fail(404, 'Flujo no encontrado', 'FLOW_NOT_FOUND');
    const dir = path.join(flowSkillsDir(flow.id), name);
    if (!fs.existsSync(dir) && !isLink(dir)) throw fail(404, `«${name}» no está en este flujo`, 'SKILL_NOT_FOUND');
    const linked = isLink(dir);
    return { dir, linked, origin: linked ? readLinks(flow.id)[name] || null : readOrigin(dir) };
  }
  if (scope === 'user') {
    const dir = path.join(USER_SKILLS(), name);
    if (!fs.existsSync(dir)) {
      const other = listSkills(flow?.cwd, flow?.id).find((s) => s.name === name);
      if (other) throw fail(403, `«${name}» la gestiona ${other.source} (no se borra desde aquí)`, 'SKILL_MANAGED_ELSEWHERE');
      throw fail(404, 'Skill no encontrada', 'SKILL_NOT_FOUND');
    }
    return { dir, linked: false, origin: readOrigin(dir) };
  }
  throw fail(403, 'Las skills de claude.ai, plugins o del proyecto se gestionan fuera de esta app', 'SKILL_MANAGED_ELSEWHERE');
}
export function originOf(name, scope, flow) { const l = locate(name, scope, flow); return { name, scope, linked: l.linked, origin: l.origin }; }

export function remove(name, scope, flow, { confirm = false } = {}) {
  const l = locate(name, scope, flow);
  if (scope === 'user') {
    if (!confirm) throw fail(400, 'Borrar una skill de tu Claude Code afecta todas tus sesiones: confírmalo', 'CONFIRM_REQUIRED');
    if (!l.origin) throw fail(403, `Esta skill no la instaló Agent Flow Studio: bórrala a mano en ${l.dir}`, 'SKILL_NOT_MANAGED');
  }
  if (l.linked) { unlinkDir(l.dir); const links = readLinks(flow.id); delete links[name]; writeLinks(flow.id, links); }
  else fs.rmSync(l.dir, { recursive: true, force: true });
  return { removed: name, scope };
}

/** Re-inspect the stored origin (SKSRC-11 v1): previous and new SKILL.md, changed = content differs. */
export async function checkUpdate(name, scope, flow, { signal } = {}) {
  const l = locate(name, scope, flow);
  if (l.linked) throw fail(400, 'Una carpeta vinculada se usa en vivo: no hace falta actualizarla', 'LINKED_LIVE');
  const o = l.origin;
  if (!o) throw fail(400, 'Esta skill no tiene origen registrado', 'NO_UPDATE_SOURCE');
  const body = o.type === 'url' ? { url: o.source } : o.type === 'folder' || (o.type === 'zip' && path.isAbsolute(o.source || '')) ? { path: o.source } : null;
  if (!body) throw fail(400, 'Este zip se subió desde el navegador: vuelve a subirlo para actualizar', 'NO_UPDATE_SOURCE');
  const r = await inspect(body, { signal });
  const cand = r.skills.find((s) => s.name === (o.originalName || name)) || (r.skills.length === 1 ? r.skills[0] : null);
  if (!cand) throw fail(422, `La fuente ya no tiene la skill «${o.originalName || name}»`, 'NO_SKILLS');
  const p = pending.get(r.token);
  const newDir = cand.relDir ? path.join(p.dir, ...cand.relDir.split('/')) : p.dir;
  const hash = p.skills.find((s) => s.relDir === cand.relDir).hash;
  const read = (d) => { try { return fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'); } catch { return ''; } };
  const sums = (d) => { const m = new Map(); try { for (const f of walkFiles(d, { followLinks: true }).files) if (f.path !== '.afs-origin.json') m.set(f.path, crypto.createHash('sha256').update(fs.readFileSync(path.join(fs.realpathSync(d), f.path))).digest('hex')); } catch {} return m; };
  const before = sums(l.dir); const after = sums(newDir); const scriptOf = new Map(cand.files.map((f) => [f.path, f.script]));
  const files = [...new Set([...before.keys(), ...after.keys()])].sort().map((pth) => ({ path: pth, status: !before.has(pth) ? 'added' : !after.has(pth) ? 'removed' : before.get(pth) !== after.get(pth) ? 'changed' : 'same', script: !!scriptOf.get(pth) })).filter((f) => f.status !== 'same');
  return { token: r.token, name, sourceName: cand.name, skills: r.skills, candidate: cand, files, previous: read(l.dir), current: read(newDir), changed: hash !== o.sha256 };
}

/** Removes a flow's skills when the flow is deleted: links are unlinked first, their targets are never touched. */
export function removeFlowSkills(flowId) {
  const dir = flowSkillsDir(flowId);
  try { for (const e of fs.readdirSync(dir)) { const p = path.join(dir, e); if (isLink(p)) unlinkDir(p); } } catch {}
  fs.rmSync(flowSkillRoot(flowId), { recursive: true, force: true });
}

/** The flow's skills for listing in the UI (with origin and update ability). */
export function flowSkills(flowId) {
  const dir = flowSkillsDir(flowId); const links = readLinks(flowId);
  let entries = []; try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((e) => !e.startsWith('.afs-')).map((e) => {
    const p = path.join(dir, e); const linked = isLink(p);
    const o = linked ? links[e] || null : readOrigin(p);
    return { name: e, linked, origin: o, broken: linked && !fs.existsSync(p) };
  });
}

// ---------- export / import (SKSRC-12 v1: embedded files, ≤5 MB per skill) ----------
const EMBED_MAX = 5 * 1024 * 1024;
export function embedForExport(flowId) {
  const out = [];
  for (const s of flowSkills(flowId)) {
    const dir = path.join(flowSkillsDir(flowId), s.name);
    if (s.broken) { out.push({ name: s.name, origin: s.origin, missing: true }); continue; }
    let files;
    try { files = walkFiles(dir, { followLinks: true }); } catch { out.push({ name: s.name, origin: s.origin, tooBig: true }); continue; }
    if (files.size > EMBED_MAX) { out.push({ name: s.name, origin: s.origin, tooBig: true }); continue; }
    const real = fs.realpathSync(dir);
    out.push({ name: s.name, origin: s.origin ? { ...s.origin, ...(s.linked ? { mode: 'copy', linkedFrom: s.origin.target } : {}) } : null, files: files.files.filter((f) => f.path !== '.afs-origin.json').map((f) => ({ path: f.path, b64: fs.readFileSync(path.join(real, f.path)).toString('base64') })) });
  }
  return out;
}
/** Imported bundle skills → an inspection token (same review as a zip) or null; skills that did not travel are listed. */
export function stageImport(skills, flowId = null) {
  if (!Array.isArray(skills) || !skills.length) return null;
  const entries = []; const notEmbedded = [];
  for (const s of skills) {
    if (!s || typeof s !== 'object') continue;
    if (!Array.isArray(s.files)) { notEmbedded.push({ name: String(s.name || ''), source: s.origin?.source || null }); continue; }
    if (!NAME_RE.test(String(s.name || ''))) continue;
    for (const f of s.files) entries.push({ name: `${s.name}/${f.path}`, data: Buffer.from(String(f.b64 || ''), 'base64') });
  }
  if (!entries.length) return { token: null, skills: [], notEmbedded };
  const zip = buildZip(entries); // the same validation as an uploaded zip (paths, limits)
  const tmp = newTmp(); const dir = path.join(tmp, 'src'); fs.mkdirSync(dir);
  try { writeEntries(dir, readZip(zip)); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  const found = scan(dir);
  if (!found.length) { fs.rmSync(tmp, { recursive: true, force: true }); return { token: null, skills: [], notEmbedded }; }
  const token = crypto.randomUUID();
  const origins = Object.fromEntries(skills.filter((s) => s?.origin).map((s) => [s.name, s.origin]));
  remember(token, { dir, tmp, flowId, origin: { type: 'bundle', source: 'importado', origins }, skills: found, expires: Date.now() + TTL_MS });
  return { token, skills: found.map(({ hash, ...s }) => s), notEmbedded };
}
export const _rank = rankOf;
