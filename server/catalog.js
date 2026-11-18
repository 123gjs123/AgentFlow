// Discovers the user's Claude Code skills and agents (user, synced, plugins, project).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(os.homedir(), '.claude');

function frontmatter(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
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
        }
        meta[kv[1]] = v.replace(/^["']|["']$/g, '');
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
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.git')) walk(p, match, depth - 1, out); }
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

export function listSkills(projectDir) {
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
      if (!seen.has(key)) seen.set(key, { name, description: (meta.description || '').slice(0, 300), path: f, source: src });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
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

export function findSkill(name, projectDir) { return listSkills(projectDir).find((s) => s.name === name); }
export function findAgent(name, projectDir) { return listAgents(projectDir).find((a) => a.name === name); }
