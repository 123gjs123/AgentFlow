// Discovers the user's Claude Code skills and agents (user, synced, plugins, project).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA } from './store.js';

const HOME = path.join(os.homedir(), '.claude');

export function frontmatter(file, text) {
  try {
    const txt = text ?? fs.readFileSync(file, 'utf8');
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = {};
    if (m) {
      const lines = m[1].split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!kv) continue;
        let v = kv[2];
        // YAML block scalars (description: >- / |): the indented lines that follow are the value (the QA framework's format)
        if (/^[>|][+-]?\s*$/.test(v)) {
          const block = [];
          while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
          v = v.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
        } else if (v === '' && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
          const items = [];
          while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s+/, '').trim());
          v = items.join(', ');
        } else if (v !== '') {
          // a plain/quoted scalar folded over indented lines: YAML reads them as the same value (what Claude Code sees)
          while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+[A-Za-z_-]+:\s/.test(lines[i + 1])) v += ` ${lines[++i].trim()}`;
        }
        const q = v.match(/^(["'])([\s\S]*)\1$/);
        meta[kv[1]] = q ? q[2] : v;
      }
    }
    return meta;
  } catch { return {}; }
}

function walk(root, match, depth = 6, out = []) {
  if (depth < 0 || !fs.existsSync(root)) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.git') && !e.name.startsWith('.afs-')) walk(p, match, depth - 1, out); }
    else if (match(p, e.name)) out.push(p);
  }
  return out;
}

function sourceOf(p) {
  if (p.includes(`${path.sep}plugins${path.sep}`)) {
    const m = p.split(path.sep);
    const i = m.indexOf('cache');
    return i >= 0 ? `plugin:${m[i + 2] || m[i + 1]}` : 'plugin';
  }
  if (p.includes(`${path.sep}synced${path.sep}`)) return 'claude.ai';
  if (p.startsWith(HOME)) return 'user';
  return 'project';
}

/**
 * Plugins Claude Code really loads for `projectDir` (installed_plugins.json): user scope everywhere, project/local scope
 * only inside that project. A plugin in the cache but installed for another project is NOT available (seen for real:
 * qa-domain-sportsbook installed for automation-api-sportsbook looked available in every flow).
 * Returns null when the file cannot be read (then every cached plugin counts, as before).
 */
function loadedPlugins(projectDir) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(HOME, 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return null; }
  const all = j?.plugins && typeof j.plugins === 'object' ? j.plugins : j;
  const proj = projectDir ? path.resolve(projectDir).toLowerCase() : null;
  const inside = (p) => { const r = path.resolve(p).toLowerCase(); return proj && (proj === r || proj.startsWith(r + path.sep)); };
  const out = new Set();
  for (const [key, v] of Object.entries(all || {})) {
    for (const e of Array.isArray(v) ? v : [v]) {
      if (!e || typeof e !== 'object') continue;
      if (!e.scope || e.scope === 'user' || (e.projectPath && inside(e.projectPath))) out.add(key.split('@')[0]);
    }
  }
  return out;
}
const pluginOf = (f) => { const m = f.split(path.sep); const i = m.indexOf('cache'); return i >= 0 ? m[i + 2] || m[i + 1] : null; };

// spec 13: skills of ONE flow (<DATA>/flow-skills/<flow>/.claude/skills; copies and linked folders = junctions)
const flowSkillsDir = (flowId) => path.join(DATA, 'flow-skills', String(flowId).replace(/[^a-zA-Z0-9_-]/g, '_'), '.claude', 'skills');
function listFlowSkills(flowId) {
  if (!flowId) return [];
  const dir = flowSkillsDir(flowId); let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.startsWith('.afs-')) continue;
    const f = path.join(dir, e, 'SKILL.md');
    let linked = false; try { linked = fs.lstatSync(path.join(dir, e)).isSymbolicLink(); } catch {}
    if (!fs.existsSync(f)) continue;
    const meta = frontmatter(f);
    out.push({ name: meta.name || e, description: (meta.description || '').slice(0, 300), path: f, source: linked ? 'linked' : 'flow' });
  }
  return out;
}
const RANK = { flow: 0, linked: 1, project: 2, user: 3, 'claude.ai': 4 };
const rank = (s) => RANK[s.source] ?? 5;

export function listSkills(projectDir, flowId) {
  const own = listFlowSkills(flowId);
  const roots = [path.join(HOME, 'skills'), path.join(HOME, 'plugins', 'cache')];
  if (projectDir) roots.push(path.join(projectDir, '.claude', 'skills'));
  const loaded = loadedPlugins(projectDir);
  const seen = new Map();
  for (const r of roots) {
    for (const f of walk(r, (_p, n) => n === 'SKILL.md')) {
      if (loaded && f.includes(`${path.sep}plugins${path.sep}cache${path.sep}`) && !loaded.has(pluginOf(f))) continue;
      const meta = frontmatter(f);
      const name = meta.name || path.basename(path.dirname(f));
      const src = sourceOf(f);
      const key = `${src}:${name}`;
      const managed = src === 'user' && path.dirname(path.dirname(f)) === path.join(HOME, 'skills') && fs.existsSync(path.join(path.dirname(f), '.afs-origin.json'));
      if (!seen.has(key)) seen.set(key, { name, description: (meta.description || '').slice(0, 300), path: f, source: src, ...(managed ? { managed: true } : {}) });
    }
  }
  return [...own, ...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || rank(a) - rank(b));
}

export function listAgents(projectDir) {
  const roots = [path.join(HOME, 'agents'), path.join(HOME, 'plugins', 'cache')];
  if (projectDir) roots.push(path.join(projectDir, '.claude', 'agents'));
  const out = [];
  for (const r of roots) {
    for (const f of walk(r, (p, n) => n.endsWith('.md') && path.basename(path.dirname(p)) === 'agents')) {
      const meta = frontmatter(f);
      out.push({ name: meta.name || path.basename(f, '.md'), description: (meta.description || '').slice(0, 300), path: f, source: sourceOf(f) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The skill a step uses: this flow's first, then linked, project, user, claude.ai, plugins (spec 13). */
export function findSkill(name, projectDir, flowId) { return listSkills(projectDir, flowId).filter((s) => s.name === name).sort((a, b) => rank(a) - rank(b))[0]; }
export function findAgent(name, projectDir) { return listAgents(projectDir).find((a) => a.name === name); }
