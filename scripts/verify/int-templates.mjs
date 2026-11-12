// Spec 17 criterion 15: every caller template parses.
// Usage: AFS_URL=http://127.0.0.1:4319 node scripts/verify/int-templates.mjs   (use an isolated instance: it creates and deletes 2 fixture flows)
// - YAML (GitHub, Bitbucket, GitLab, cloudflared): parsed with the small block-YAML subset parser below (no dependencies).
//   It covers what the templates use (block maps/sequences, flow sequences, plain/quoted scalars, | and >- block scalars)
//   and rejects what would break a real parser (": " inside plain scalars, tabs, bad indentation, duplicate keys).
// - Jira body: JSON.parse after replacing {{smart values}} with sample strings.
// - PowerShell: System.Management.Automation.Language.Parser. Python: py_compile. bash: bash -n. (skipped if the tool is missing)
// Exit 0 when every check passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const B = process.env.AFS_URL || 'http://127.0.0.1:4319';
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };

import { parseYaml } from './yaml-lite.mjs';

// ---------- checks ----------
const results = [];
const check = (id, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`); };
const has = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0; };
const tools = { ps: has('powershell', ['-NoProfile', '-Command', 'exit 0']), py: has('python', ['-c', 'pass']), bash: has('bash', ['-c', 'exit 0']) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-int-'));
const syntax = (f) => {
  const p = path.join(tmp, path.basename(f.name)); fs.writeFileSync(p, f.content);
  if (f.language === 'powershell' && tools.ps) { const r = spawnSync('powershell', ['-NoProfile', '-Command', `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${p}',[ref]$null,[ref]$e);if($e){$e|%{$_.Message};exit 1}`], { encoding: 'utf8' }); return r.status === 0 ? null : r.stdout.trim(); }
  if (f.language === 'python' && tools.py) { const r = spawnSync('python', ['-m', 'py_compile', p], { encoding: 'utf8' }); return r.status === 0 ? null : r.stderr.trim(); }
  if (f.language === 'bash' && tools.bash) { const r = spawnSync('bash', ['-n', p.replace(/\\/g, '/')], { encoding: 'utf8' }); return r.status === 0 ? null : r.stderr.trim(); }
  if (f.language === 'yaml') { try { parseYaml(f.content); return null; } catch (e) { return e.message; } }
  if (f.language === 'json') { try { JSON.parse(f.content.replace(/\{\{[^}]+\}\}/g, 'X')); return null; } catch (e) { return e.message; } }
  return null;
};

const fixtures = [];
try {
  const { token } = await j('GET', '/api/info');
  for (const name of ['Revisar ticket QA', "Smoke: QA #1 'x'"]) {
    const f = await j('POST', '/api/flows', { name }); fixtures.push(f.id);
    await j('PUT', `/api/flows/${f.id}`, { ...f, vars: { issue: '' }, steps: [{ id: 's_1', name: 'Uno', kind: 'command', shell: 'powershell', command: 'Write-Output ok' }], edges: [] });
  }
  const callers = await j('GET', '/api/integrations/callers');
  check('12 callers', callers.length === 12, callers.map((c) => c.id).join(','));
  for (const [fi, fid] of fixtures.entries()) {
    const hostile = fi === 1;
    for (const c of callers) for (const location of [undefined, 'local']) {
      const g = await j('POST', '/api/integrations/generate', { flow: fid, caller: c.id, options: { location, vars: c.id.startsWith('jira') ? { issue: '{{issue.key}}' } : { issue: 'X-1' } } });
      const tag = `${hostile ? '[hostile name] ' : ''}${c.id}${location ? ' (local)' : ''}`;
      const problems = [];
      if (!g.files?.length) problems.push('no files');
      if (g.lint?.errors?.length) problems.push('lint: ' + g.lint.errors.map((e) => e.code).join(','));
      if (JSON.stringify(g).includes(token)) problems.push('TOKEN in output');
      for (const f of g.files || []) { const e = syntax(f); if (e) problems.push(`${f.name}: ${e}`); }
      // structure
      const y = (n) => parseYaml(g.files.find((f) => f.name === n).content);
      try {
        if (c.id === 'github-actions') { const d = y('.github/workflows/agent-flow.yml'); const st = d.jobs['agent-flow'].steps; if (!st.some((s) => /afs_call\.py|afs-call\.ps1|afs run/.test(s.run || ''))) problems.push('no run step'); if (!location && st[1].env?.AFS_TOKEN !== '${{ secrets.AFS_TOKEN }}') problems.push('no secret env'); if (!st.some((s) => s.with?.path === 'afs-result.json')) problems.push('no artifact'); }
        if (c.id === 'bitbucket-pipelines') { const d = y('bitbucket-pipelines.yml'); const s = d.pipelines.custom['agent-flow'][0].step; // one command: either a single line or bash continuation lines ("\" at the end of each line but the last)
        const cmdText = String(s.script[0]).trim();
        if (!/--key|-Key /.test(cmdText) || /\n/.test(cmdText.replace(/ \\\n/g, ' '))) problems.push('script not one command with --key'); if (!s.artifacts.includes('afs-result.json')) problems.push('no artifact'); }
        if (c.id === 'gitlab-ci') { const d = y('.gitlab-ci.yml'); const s = d['agent-flow']; if (!/--key|-Key /.test(s.script[0])) problems.push('no --key'); if (!s.artifacts.paths.includes('afs-result.json')) problems.push('no artifact'); }
        if (c.id === 'jira-cloud' && !location && !hostile) { const cf = g.reachability.options.find((o) => o.id === 'cloudflare').config; const d = parseYaml(cf); if (d.ingress[0].path !== '^/api/ext/' || d.ingress[d.ingress.length - 1].service !== 'http_status:404') problems.push('cloudflared ingress'); }
      } catch (e) { problems.push('structure: ' + e.message); }
      check(tag, !problems.length, problems.join(' | ').slice(0, 400));
    }
  }
} finally {
  for (const id of fixtures) await j('DELETE', `/api/flows/${id}`).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed (tools: ${JSON.stringify(tools)})`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
