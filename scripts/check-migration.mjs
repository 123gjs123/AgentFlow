#!/usr/bin/env node
// Spec 09: try the folder-per-flow migration on a COPY of a data folder and compare what is there before and after.
// Usage: node scripts/check-migration.mjs <path-to-a-copy-of-data>   (never point it at the live data folder)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'config.json'))) { console.error('Uso: node scripts/check-migration.mjs <copia-de-data>'); process.exit(2); }
const count = (p) => { try { return fs.readdirSync(p, { recursive: true }).filter((f) => fs.statSync(path.join(p, f)).isFile()).length; } catch { return 0; } };
const before = {};
for (const f of fs.readdirSync(path.join(dir, 'flows')).filter((x) => x.endsWith('.json'))) {
  const id = f.slice(0, -5);
  before[id] = Object.fromEntries(['chats', 'runs', 'versions', 'reviews', 'outputs'].map((d) => [d, count(path.join(dir, d, id))]));
}
process.env.AFS_DATA = dir;
const store = await import('../server/store.js');
store.ensureLayout();
let bad = 0;
for (const [id, b] of Object.entries(before)) {
  const f = store.getFlow(id);
  const after = Object.fromEntries(Object.keys(b).map((d) => [d, count(store.flowFile(id, d))]));
  const ok = !!f && Object.keys(b).every((d) => b[d] === after[d]);
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'MAL'} ${id} ${f?.name ?? '(no se lee)'} → ${path.basename(store.flowDir(id))}  antes ${JSON.stringify(b)} después ${JSON.stringify(after)}`);
}
console.log(bad ? `${bad} flujo(s) con diferencias` : 'Todo coincide.');
process.exit(bad ? 1 : 0);
