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
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
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

export function listSkills(projectDir) {
  const roots = [path.join(HOME, 'skills'), path.join(HOME, 'plugins', 'cache')];
  if (projectDir) roots.push(path.join(projectDir, '.claude', 'skills'));
  const seen = new Map();
  for (const r of roots) {
    for (const f of walk(r, (_p, n) => n === 'SKILL.md')) {
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
