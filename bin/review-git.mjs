#!/usr/bin/env node
// 🩺 Read-only git for the flow reviewer (spec 28, round 2): lets it investigate WHY a run failed ("is this already
// fixed in another branch?") without being able to change anything.
//   node bin/review-git.mjs repos                       → the repositories it may read
//   node bin/review-git.mjs <repo> <subcommand> [args]  → git -C <repo> <subcommand> [args]
// - Only repositories listed in AFS_REVIEW_REPOS (set by the app: the flow's folder and folders in its variables).
// - Only read subcommands; arguments that write files, run programs or touch the network are refused.
// - No shell: arguments go straight to git. Output capped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const READ = new Set(['log', 'show', 'branch', 'diff', 'status', 'rev-parse', 'ls-files', 'grep', 'for-each-ref', 'merge-base', 'blame', 'shortlog', 'describe', 'tag', 'cat-file', 'name-rev', 'rev-list']);
// writes a file, runs a program (pager, textconv, external diff, hooks), changes config, or creates/deletes refs
const BAD_ARG = /^(--no-index|--filters|--textconv|--batch-command|--output|-o$|--open-files-in-pager|-O|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|-c$|--config|--git-dir|--work-tree|-C$|--set-upstream|--unset-upstream|--edit-description|-[dDmMcC]$|--delete|--move|--copy|--force|-f$|--create-reflog|--track|--no-track)/;
const MAX = 60000;

const repos = String(process.env.AFS_REVIEW_REPOS || '').split(path.delimiter).map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r));
const [repoArg, sub, ...rest] = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(2); };

if (!repoArg || repoArg === 'repos') { console.log(repos.length ? repos.join('\n') : '(ningún repositorio habilitado)'); process.exit(0); }
const repo = path.resolve(repoArg);
const allowed = repos.find((r) => r.toLowerCase() === repo.toLowerCase());
if (!allowed) fail(`Repositorio no habilitado: ${repoArg}. Habilitados:\n${repos.join('\n') || '(ninguno)'}`);
if (!fs.existsSync(path.join(allowed, '.git'))) fail(`${allowed} no es un repositorio git`);
if (!READ.has(sub)) fail(`Solo lectura: ${[...READ].join(', ')}`);
// branch/tag with a bare name would CREATE one: a positional name is only allowed with an explicit list mode
// (--sort/--format do NOT put git in list mode: "tag --sort=x evil" creates the tag — found by the adversarial review)
if ((sub === 'branch' || sub === 'tag') && rest.some((a) => !a.startsWith('-'))) {
  // for tag, -a means ANNOTATE (creates a tag): only branch accepts -a/-r as list mode
  const listRe = sub === 'tag' ? /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/ : /^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
  const listing = rest.some((a) => listRe.test(a));
  if (!listing) fail(`git ${sub} solo para listar: con un nombre o patrón usa --list (o -a, -r, --contains…)`);
}
// diff/grep outside the repo (--no-index) would read any file on disk
if (rest.includes('--no-index')) fail('Argumento no permitido en modo lectura: --no-index');
for (const a of rest) if (BAD_ARG.test(a)) fail(`Argumento no permitido en modo lectura: ${a}`);

try {
  const out = execFileSync('git', ['-C', allowed, '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager', sub, ...(['diff', 'show', 'log'].includes(sub) ? ['--no-ext-diff', '--no-textconv'] : []), ...rest], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000, windowsHide: true,
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '' },
  });
  process.stdout.write(out.length > MAX ? `${out.slice(0, MAX)}\n… (recortado: ${out.length} caracteres; acota con -n, --stat o una ruta)\n` : out);
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  fail(String(e.stderr || e.message).slice(0, 2000));
}
