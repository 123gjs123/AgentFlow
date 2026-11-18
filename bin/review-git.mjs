#!/usr/bin/env node
// 🩺 Read-only git for the flow reviewer (spec 28) and the flow coordinator (spec 30): lets them investigate ("is this
// already fixed in another branch?", "does the ticket's branch have new commits?") without changing anything.
//   node bin/review-git.mjs repos                       → the repositories it may read
//   node bin/review-git.mjs <repo> <subcommand> [args]  → git -C <repo> <subcommand> [args]
// - Only repositories listed in AFS_REVIEW_REPOS (set by the app: the flow's folder and folders in its variables).
// - ALLOWLIST, not blocklist: every option must be one this file names for that subcommand, written in full (git
//   accepts abbreviations: "--open=sh" is --open-files-in-pager; a blocklist missed it — adversarial review). Values
//   go attached (--format=x) or as the next argument for the options marked as taking one.
// - Positional arguments are revisions, paths or patterns; paths outside the repo are refused by git itself.
// - No shell: arguments go straight to git. Output capped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// flags: exact options. val: options that take a value (attached "--x=v" for long ones, "-xv" for short ones, or the
// next argument). num: "-<n>" allowed (log -20).
const LOGLIKE = {
  flags: ['--oneline', '--all', '--graph', '--decorate', '--no-decorate', '--stat', '--shortstat', '--name-only', '--name-status', '--no-merges', '--merges', '--first-parent', '--reverse', '-p', '--patch', '--no-patch', '-s', '--follow', '-i', '--regexp-ignore-case', '-E', '--extended-regexp', '-F', '--fixed-strings', '--remotes', '--branches', '--tags', '--source', '--left-right', '--cherry-pick', '--abbrev-commit', '--pickaxe-all', '--count', '-w', '--ignore-all-space'],
  val: ['--date', '--format', '--pretty', '--since', '--until', '--after', '--before', '--author', '--committer', '--grep', '-S', '-G', '-n', '--max-count', '--skip', '--diff-filter', '--abbrev'],
  num: true,
};
const ALLOW = {
  log: LOGLIKE, 'rev-list': LOGLIKE, shortlog: { ...LOGLIKE, flags: [...LOGLIKE.flags, '-s', '--summary', '-n', '--numbered', '-e', '--email'] },
  show: { flags: ['--stat', '--shortstat', '--name-only', '--name-status', '--oneline', '-p', '--patch', '--no-patch', '-s', '--quiet', '--abbrev-commit', '-w'], val: ['--format', '--pretty', '--date', '--diff-filter'] },
  diff: { flags: ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--cached', '--staged', '-w', '--ignore-all-space', '--minimal', '--word-diff', '--merge-base'], val: ['-U', '--unified', '--diff-filter'] },
  branch: { flags: ['-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'], val: ['--sort', '--format'] },
  tag: { flags: ['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'], val: ['--sort', '--format'] },
  // untracked listings are out: a junction inside the working tree would list file NAMES outside the repo (adversarial, round 4)
  status: { flags: ['-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2', '-uno'] },
  'rev-parse': { flags: ['--abbrev-ref', '--short', '--verify', '--quiet', '-q', '--symbolic-full-name', '--show-toplevel', '--is-inside-work-tree'] },
  'ls-files': { flags: ['--cached', '-c', '-m', '--modified', '-d', '--deleted'] },
  grep: { flags: ['-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '-L', '--files-without-match', '-c', '--count', '-w', '--word-regexp', '-v', '--invert-match', '-E', '--extended-regexp', '-F', '--fixed-strings', '-I', '--cached', '-h', '-H', '--heading', '--break', '--and', '--or', '--not', '--all-match'], val: ['-e', '-C', '-A', '-B', '--max-depth', '--context', '--after-context', '--before-context'] },
  'for-each-ref': { flags: [], val: ['--format', '--sort', '--count', '--contains', '--merged', '--no-merged', '--points-at'] },
  'merge-base': { flags: ['--is-ancestor', '--all', '--fork-point'] },
  blame: { flags: ['-w', '-M', '-C', '--porcelain', '--line-porcelain', '-e', '--show-email', '-s', '-l'], val: ['-L', '--date'] },
  describe: { flags: ['--tags', '--always', '--contains', '--all', '--long'], val: ['--abbrev'] },
  'cat-file': { flags: ['-t', '-s', '-p', '-e'] },
  'name-rev': { flags: ['--name-only', '--tags', '--always'] },
};
// branch/tag with a positional name would CREATE one: only with an explicit list mode (tag -a would ANNOTATE: not allowed)
const LIST_MODE = { branch: /^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at)$/, tag: /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/ };
const MAX = 60000;

const repos = String(process.env.AFS_REVIEW_REPOS || '').split(path.delimiter).map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r));
const [repoArg, sub, ...rest] = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(2); };

if (!repoArg || repoArg === 'repos') { console.log(repos.length ? repos.join('\n') : '(ningún repositorio habilitado)'); process.exit(0); }
const repo = path.resolve(repoArg);
const allowed = repos.find((r) => r.toLowerCase() === repo.toLowerCase());
if (!allowed) fail(`Repositorio no habilitado: ${repoArg}. Habilitados:\n${repos.join('\n') || '(ninguno)'}`);
if (!fs.existsSync(path.join(allowed, '.git'))) fail(`${allowed} no es un repositorio git`);
const spec = ALLOW[sub];
if (!spec) fail(`Solo lectura: ${Object.keys(ALLOW).join(', ')}`);

/**
 * A positional argument (revision, path, pattern) never points outside the repo: no absolute, drive or UNC path (git
 * diff falls back to --no-index by itself with an outside path, and a UNC path talks to the network), no ".." segment.
 */
const OUTSIDE = /^([a-zA-Z]:|[\\/])|(^|[\\/:])\.\.([\\/]|$)/;
/**
 * Validates the arguments against the allowlist; returns the positional ones.
 * Values ONLY attached (--format=x, -n20, -Stext): an option whose value is "the next argument" for this helper but not
 * for git (-U, --pretty, --abbrev take it optionally/attached only) let the next argument through unchecked, and git
 * read it as an option (--output=… → wrote a hook: code execution — adversarial review, round 3).
 */
export function check(sub, args) {
  const s = ALLOW[sub]; const flags = new Set(s.flags || []); const val = new Set(s.val || []);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { positional.push(a); continue; }
    if (flags.has(a)) continue;
    if (s.num && /^-\d{1,6}$/.test(a)) continue;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && val.has(a.slice(0, eq))) continue; // --format=x
    if (/^-[A-Za-z]/.test(a) && !a.startsWith('--') && val.has(a.slice(0, 2)) && a.length > 2) continue; // -n20, -Stext, -U5
    if (val.has(a)) return { error: `Escribe el valor pegado a la opción: ${a.startsWith('--') ? `${a}=valor` : `${a}valor (p. ej. ${a}20)`}` };
    return { error: `Opción no permitida en modo lectura: ${a} (se aceptan solo las de la lista, escritas completas)` };
  }
  for (const p of positional) {
    if (OUTSIDE.test(String(p))) return { error: `Solo rutas y revisiones dentro del repositorio (sin rutas absolutas, de red ni ".."): ${p}` };
  }
  return { positional };
}
const r = check(sub, rest);
if (r.error) fail(r.error);
if (LIST_MODE[sub] && r.positional.length && !rest.some((a) => LIST_MODE[sub].test(a))) fail(`git ${sub} solo para listar: con un nombre o patrón usa --list (o -a, -r, --contains…)`);

try {
  const out = execFileSync('git', ['-C', allowed, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.fsmonitor=false', '--no-pager', sub, ...(['diff', 'show', 'log'].includes(sub) ? ['--no-ext-diff', '--no-textconv'] : sub === 'blame' || sub === 'grep' ? ['--no-textconv'] : []), ...rest], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000, windowsHide: true,
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '' },
  });
  process.stdout.write(out.length > MAX ? `${out.slice(0, MAX)}\n… (recortado: ${out.length} caracteres; acota con -n, --stat o una ruta)\n` : out);
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  fail(String(e.stderr || e.message).slice(0, 2000));
}
