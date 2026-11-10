#!/usr/bin/env node
// afs — run Agent Flow Studio flows from a terminal, script or CI.
import fs from 'node:fs';
import { call, ensureServer, flowPath, runAndWait, BASE } from './client.js';

const HELP = `afs — invoca flujos de Agent Flow Studio

Uso:
  afs list                                   Lista flujos y sus steps
  afs run  <flujo> [opciones]                Ejecuta un flujo (espera y muestra el resultado)
  afs ask  <flujo> "<pregunta>" [--step S]   Pregunta al chat general (o a un step)
  afs status <flujo> <runId>                 Estado/salidas de una ejecución

Opciones de run:
  -i, --input "<texto>"     Input del flujo   (o -f archivo, o por stdin:  echo x | afs run F)
  -f, --file <ruta>         Lee el input de un archivo
  -s, --step <nombre>       Ejecuta solo ese step
  --var clave=valor         Setea variables del flujo (repetible)
  --no-wait                 No espera: devuelve el runId
  --json                    Salida JSON completa
  --timeout <seg>           Máximo a esperar (900)

<flujo> puede ser el nombre (entre comillas) o el id.
Entorno: AFS_URL (${BASE}), AFS_TOKEN (por defecto se lee de data/config.json)
Código de salida: 0 si terminó ok, 1 si falló.`;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = { vars: {} };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-i' || a === '--input') opts.input = argv[++i];
  else if (a === '-f' || a === '--file') opts.input = fs.readFileSync(argv[++i], 'utf8');
  else if (a === '-s' || a === '--step') opts.step = argv[++i];
  else if (a === '--var') { const [k, ...v] = argv[++i].split('='); opts.vars[k] = v.join('='); }
  else if (a === '--no-wait') opts.noWait = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  else pos.push(a);
}
const err = (...a) => console.error(...a);
const ICON = { running: '…', success: '✔', error: '✖', skipped: '↷', stopped: '■' };

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(HELP); return 0; }
  await ensureServer(err);
  if (cmd === 'list') {
    const flows = await call('GET', '/flows');
    if (opts.json) console.log(JSON.stringify(flows, null, 2));
    else for (const f of flows) console.log(`${f.name}  (${f.id})\n   ${f.steps.map((s) => s.name).join(' → ') || 'sin steps'}`);
    return 0;
  }
  if (cmd === 'run') {
    const flow = pos[0];
    if (!flow) { err('Falta <flujo>. Ver: afs help'); return 2; }
    const input = opts.input ?? (await readStdin());
    const body = { input, step: opts.step, vars: Object.keys(opts.vars).length ? opts.vars : undefined, source: 'cli' };
    if (opts.noWait) { const r = await call('POST', `${flowPath(flow)}/run`, { ...body, wait: false }); console.log(opts.json ? JSON.stringify(r) : r.runId); return 0; }
    const r = await runAndWait(flow, body, { timeoutSec: opts.timeout || 900, onStep: (s) => err(`${ICON[s.status] || '·'} ${s.step} ${s.status}`) });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else {
      if (r.timedOut) err(`Tiempo agotado; sigue corriendo. Consulta: afs status "${flow}" ${r.runId}`);
      console.log(r.result || '(sin salida)');
      for (const s of r.steps.filter((x) => x.error)) err(`\n[${s.step}] ${s.error}`);
    }
    return r.status === 'success' ? 0 : 1;
  }
  if (cmd === 'ask') {
    const [flow, ...q] = pos;
    if (!flow || !q.length) { err('Uso: afs ask <flujo> "<pregunta>"'); return 2; }
    const r = await call('POST', `${flowPath(flow)}/ask`, { message: q.join(' '), step: opts.step });
    if (opts.json) console.log(JSON.stringify(r, null, 2)); else { err(`(responde: ${r.routedTo})`); console.log(r.answer); }
    return r.status === 'error' ? 1 : 0;
  }
  if (cmd === 'status') {
    const r = await call('GET', `${flowPath(pos[0])}/runs/${pos[1]}`);
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else { console.log(`${r.status}`); for (const s of r.steps) console.log(`${ICON[s.status] || '·'} ${s.step}`); if (r.result) console.log('\n' + r.result); }
    return 0;
  }
  err(`Comando desconocido: ${cmd}\n`); console.log(HELP); return 2;
}

main().then((c) => { process.exitCode = c; }).catch((e) => { err(`Error: ${e.message}`); process.exitCode = 1; });
