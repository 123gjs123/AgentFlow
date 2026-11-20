// Spec 09 WS-2: the old layout (data/flows/<id>.json plus chats/<id>, runs/<id>, versions/<id>, reviews/<id>,
// outputs/<id>, watch/<id>.json, actions/, approvals/, copies/, invoke/) becomes one folder per flow:
// data/flows/<slug>--<id>/ (see store.js). Crash-safe and idempotent:
//  1. copy  — each flow is built in flows/.staging-<id>, verified (file count and sizes), then renamed into place in one
//             step, so a final folder that exists is complete. The originals are never touched in this phase.
//  2. backup — the old files and folders (also the runs of flows deleted long ago) are MOVED to _backup-pre09-<ts>/.
// A journal (.migration-09.json) says which phase to resume after a crash. A file that stays locked (antivirus, an
// editor) stops the start-up with MIGRATION_FAILED and leaves everything as it was: better than starting with flows missing.
import fs from 'node:fs';
import path from 'node:path';

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const retry = (fn) => { for (let n = 0; ; n++) { try { return fn(); } catch (e) { if (!BUSY.has(e.code) || n >= 10) throw e; sleepSync(200); } } };
const LEGACY_DIRS = ['chats', 'runs', 'versions', 'reviews', 'outputs']; // <dir>/<id>/  → <folder>/<dir>/
const LEGACY_FILES = [['watch', '.json', 'sources.json'], ['actions', '.json', 'actions.json'], ['approvals', '.json', 'approvals.json'], ['copies', '.json', 'copies.json'], ['invoke', '.md', 'INVOKE.md']];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const JOURNAL = '.migration-09.json';
// test seam: AFS_TEST_FAULT=migrate:after-stage:<n> | migrate:in-backup:<n> exits mid-migration (crash simulation)
const fault = (k, n) => { const m = String(process.env.AFS_TEST_FAULT || '').match(/^migrate:([\w-]+):(\d+)$/); if (m && m[1] === k && Number(m[2]) === n) process.exit(9); };
const failed = (msg) => Object.assign(new Error(`MIGRATION_FAILED: ${msg}`), { code: 'MIGRATION_FAILED' });

function legacyFlowFiles(DATA) {
  try { return fs.readdirSync(path.join(DATA, 'flows'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json') && ID_RE.test(e.name.slice(0, -5))).map((e) => e.name); } catch { return []; }
}
export function needsMigration(DATA) {
  if (fs.existsSync(path.join(DATA, JOURNAL)) || legacyFlowFiles(DATA).length) return true;
  return [...LEGACY_DIRS, ...LEGACY_FILES.map((x) => x[0])].some((d) => fs.existsSync(path.join(DATA, d)));
}
function walk(dir, base = dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p, base)); else if (e.isFile()) out.push([path.relative(base, p), fs.statSync(p).size]);
  }
  return out;
}
/** What the old layout has for a flow: [source, target name inside the folder, isDir]. */
function sourcesOf(DATA, id) {
  const out = [];
  for (const d of LEGACY_DIRS) { const p = path.join(DATA, d, id); if (fs.existsSync(p)) out.push([p, d, true]); }
  for (const [d, ext, name] of LEGACY_FILES) { const p = path.join(DATA, d, id + ext); if (fs.existsSync(p)) out.push([p, name, false]); }
  return out;
}
const copy = (src, dst, isDir) => retry(() => (isDir ? fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false }) : fs.copyFileSync(src, dst)));
function verify(src, dst, isDir) {
  const a = isDir ? walk(src) : [['', fs.statSync(src).size]];
  const b = new Map(isDir ? walk(dst) : [['', fs.statSync(dst).size]]);
  for (const [rel, size] of a) if (b.get(rel) !== size) throw failed(`la copia de ${path.join(src, rel)} no coincide`);
}
function takeLock(file) {
  for (let n = 0; n < 3; n++) {
    try { const fd = fs.openSync(file, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false; try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (alive) throw failed(`otro proceso (pid ${pid}) está migrando la carpeta de datos`);
    fs.rmSync(file, { force: true }); // a stale lock of a crashed start
  }
  throw failed('no se pudo tomar el candado de la migración');
}

/** Runs the migration if anything of the old layout is there. Returns a summary, or null when there was nothing to do. */
export function migrateLayout(DATA, { splitFlow, slugify, log = console.log }) {
  if (!needsMigration(DATA)) return null;
  fs.mkdirSync(path.join(DATA, 'flows'), { recursive: true });
  const lock = path.join(DATA, '.migration.lock');
  takeLock(lock);
  try {
    const jf = path.join(DATA, JOURNAL);
    let j = null; try { j = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch {}
    if (!j?.backup) {
      let prev = null; try { prev = JSON.parse(fs.readFileSync(path.join(DATA, 'layout.json'), 'utf8')).backup; } catch {}
      j = { phase: 'copy', backup: prev || `_backup-pre09-${new Date().toISOString().replace(/[:.]/g, '-')}`, startedAt: Date.now() };
      fs.writeFileSync(jf, JSON.stringify(j, null, 2));
    }
    const root = path.join(DATA, 'flows');
    const sum = { flows: 0, merged: 0, skipped: [], backup: j.backup, pending: [] };
    if (j.phase === 'copy') {
      const have = new Map();
      for (const n of fs.readdirSync(root)) { const i = n.indexOf('--'); if (i > 0 && !n.startsWith('.')) have.set(n.slice(i + 2), n); }
      let staged = 0;
      for (const file of legacyFlowFiles(DATA)) {
        const id = file.slice(0, -5);
        let old;
        try { old = JSON.parse(retry(() => fs.readFileSync(path.join(root, file), 'utf8'))); }
        catch (e) { if (BUSY.has(e.code)) throw failed(`no se pudo leer ${path.join(root, file)} (${e.code}): cierra el programa que lo usa y vuelve a arrancar`); sum.skipped.push(file); log(`Migración: ${file} no es JSON válido; queda solo en el respaldo.`); continue; }
        if (!old || typeof old !== 'object' || !Array.isArray(old.steps)) { sum.skipped.push(file); continue; }
        old.id = id;
        if (!old.createdAt) old.createdAt = 1; // from before isolation (spec 11): keeps working where it did
        if (have.has(id)) {
          // a restored old file next to a migrated folder: add only what is missing, never overwrite
          const dst = path.join(root, have.get(id));
          for (const [src, name, isDir] of sourcesOf(DATA, id)) { const to = path.join(dst, name); if (isDir) copy(src, to, true); else if (!fs.existsSync(to)) copy(src, to, false); }
          sum.merged++; continue;
        }
        const stage = path.join(root, `.staging-${id}`);
        try {
          retry(() => fs.rmSync(stage, { recursive: true, force: true }));
          fs.mkdirSync(stage, { recursive: true });
          const { def, state } = splitFlow(old);
          fs.writeFileSync(path.join(stage, 'flow.json'), `${JSON.stringify(def, null, 2)}\n`);
          fs.writeFileSync(path.join(stage, 'state.json'), JSON.stringify(state, null, 2));
          for (const [src, name, isDir] of sourcesOf(DATA, id)) { copy(src, path.join(stage, name), isDir); verify(src, path.join(stage, name), isDir); }
          JSON.parse(fs.readFileSync(path.join(stage, 'flow.json'), 'utf8')); JSON.parse(fs.readFileSync(path.join(stage, 'state.json'), 'utf8'));
          const name = `${slugify(old.name) || 'flujo'}--${id}`;
          retry(() => fs.renameSync(stage, path.join(root, name)));
          have.set(id, name);
        } catch (e) {
          try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
          if (e.code === 'MIGRATION_FAILED') throw e;
          throw failed(`no se pudo migrar el flujo ${id}: ${e.message}${BUSY.has(e.code) ? ' — cierra el programa que usa el archivo y vuelve a arrancar' : ''}`);
        }
        sum.flows++; staged++;
        fault('after-stage', staged);
      }
      j.phase = 'backup'; fs.writeFileSync(jf, JSON.stringify(j, null, 2));
    }
    // phase backup: move every old item aside (kept as-is; also runs of flows deleted long ago)
    const B = path.join(DATA, j.backup);
    let moved = 0;
    const move = (rel) => {
      const from = path.join(DATA, rel); if (!fs.existsSync(from)) return;
      let to = path.join(B, rel); if (fs.existsSync(to)) to = `${to}.${Date.now()}`;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try { retry(() => fs.renameSync(from, to)); moved++; fault('in-backup', moved); } catch (e) { sum.pending.push(rel); log(`Migración: no se pudo apartar ${from} (${e.code || e.message}); se reintenta al próximo inicio (no se usa).`); }
    };
    for (const f of legacyFlowFiles(DATA)) move(path.join('flows', f));
    for (const d of [...LEGACY_DIRS, ...LEGACY_FILES.map((x) => x[0])]) move(d);
    fs.writeFileSync(path.join(DATA, 'layout.json'), JSON.stringify({ layout: 2, migratedAt: Date.now(), backup: j.backup, pending: sum.pending }, null, 2));
    fs.rmSync(jf, { force: true });
    for (const n of fs.readdirSync(root)) if (n.startsWith('.staging-')) fs.rmSync(path.join(root, n), { recursive: true, force: true });
    log(`Migración a una carpeta por flujo (spec 09): ${sum.flows} flujo(s) migrados${sum.merged ? `, ${sum.merged} completados` : ''}. Lo anterior quedó en ${B}.`);
    return sum;
  } finally { fs.rmSync(lock, { force: true }); }
}
