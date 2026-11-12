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
  afs cancel <flujo> <runId>                 Cancela una ejecución en curso
  afs resume <flujo> <runId> [opciones]      Decide en un break: --action continue|edit|retry|skip|stop
                                             (--step S, --output "texto", --feedback "corrección")

Opciones de run:
  -i, --input "<texto>"     Input del flujo   (o -f archivo, o por stdin:  echo x | afs run F)
  -f, --file <ruta>         Lee el input de un archivo
  -s, --step <nombre>       Ejecuta solo ese step
  --var clave=valor         Variable SOLO para esta ejecución (repetible; no se guarda en el flujo)
  --pins                    Usa las salidas fijadas (📌). Por defecto se ignoran y todo se ejecuta
  --deadline <seg>          Tiempo máximo de la ejecución en el servidor (por defecto el del flujo, 3600)
  --key <clave>             Idempotency-Key: reintentar con la misma clave no lanza otra ejecución
  --follow                  Muestra la actividad de cada step mientras corre (stderr)
  --dry-run                 Solo comprueba (flujo, step, variables, token) sin ejecutar nada
  --breaks                  Respeta los breaks (⏸) de los steps: se detiene en estado paused (exit 4) y se sigue con afs resume
  --no-wait                 No espera: devuelve el runId
  --json                    Salida JSON completa
  --timeout <seg>           Máximo a esperar aquí (900)

<flujo> puede ser el nombre (entre comillas) o el id.
Entorno: AFS_URL (${BASE}), AFS_TOKEN (por defecto se lee de data/config.json)
Código de salida: 0 ok · 1 falló/detenido/interrumpido · 2 uso incorrecto · 3 tiempo agotado · 4 en pausa (break).`;

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
  else if (a === '--pins') opts.pins = true;
  else if (a === '--deadline') opts.deadline = Number(argv[++i]);
  else if (a === '--key') opts.key = argv[++i];
  else if (a === '--follow') opts.follow = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--breaks') opts.breaks = true;
  else if (a === '--action') opts.action = argv[++i];
  else if (a === '--output') opts.output = argv[++i];
  else if (a === '--feedback') opts.feedback = argv[++i];
  else if (a === '--no-wait') opts.noWait = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  else pos.push(a);
}
const err = (...a) => console.error(...a);
const ICON = { running: '…', success: '✔', error: '✖', skipped: '↷', stopped: '■', timeout: '⏱', interrupted: '⚡', queued: '⏳', paused: '⏸' };
const exitOf = (r) => (r.timedOut || r.status === 'timeout' ? 3 : r.status === 'success' ? 0 : r.status === 'paused' ? 4 : 1);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

function printEvent(e) {
  const what = e.kind === 'tool_use' ? `→ ${e.name}` : e.kind === 'tool_result' ? `← ${e.isError ? 'error ' : ''}${(e.text || '').split('\n')[0].slice(0, 160)}` : (e.text || e.kind || '').split('\n')[0].slice(0, 200);
  if (e.kind === 'text' || e.kind === 'thinking' || e.kind === 'init' || e.kind === 'result') return;
  err(`  [${e.step}] ${what}`);
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
    const body = { input, step: opts.step, vars: Object.keys(opts.vars).length ? opts.vars : undefined, source: 'cli', usePins: !!opts.pins, deadlineSec: opts.deadline || undefined, breakpoints: !!opts.breaks };
    if (opts.dryRun) {
      const r = await call('POST', `${flowPath(flow)}/run`, { ...body, dryRun: true }, opts.key ? { 'Idempotency-Key': opts.key } : {});
      if (opts.json) console.log(JSON.stringify(r, null, 2)); else { console.log(`OK (dry run): se ejecutarían ${r.steps.length} step(s): ${r.steps.join(' → ')}`); for (const w of r.warnings) err(`⚠ ${w}`); }
      return 0;
    }
    if (opts.noWait) { const r = await call('POST', `${flowPath(flow)}/run`, { ...body, wait: false }, opts.key ? { 'Idempotency-Key': opts.key } : {}); console.log(opts.json ? JSON.stringify(r) : r.runId); return 0; }
    const r = await runAndWait(flow, body, { timeoutSec: opts.timeout || 900, idempotencyKey: opts.key, onStep: (s) => err(`${ICON[s.status] || '·'} ${s.step} ${s.status}${s.code ? ` (${s.code})` : ''}`), onEvent: opts.follow ? printEvent : null });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else {
      if (r.idempotentReplay) err(`(misma Idempotency-Key: se reutilizó la ejecución ${r.runId})`);
      if (r.timedOut) err(`Tiempo de espera agotado; sigue corriendo. Consulta: afs status "${flow}" ${r.runId}  ·  cancela: afs cancel "${flow}" ${r.runId}`);
      for (const p of r.pauses || []) err(`⏸ En pausa en "${p.step}" (${p.when}). Revisa y decide: afs resume "${flow}" ${r.runId} --step "${p.step}" --action ${p.actions.join('|')}`);
      console.log(r.status === 'paused' ? (r.pauses?.[0]?.output || '') : r.result || '(sin salida)');
      for (const s of r.steps.filter((x) => x.error)) err(`\n[${s.step}] ${s.code ? `${s.code}: ` : ''}${s.error}`);
      if (r.usedPins?.length) err(`\n📌 Usó salidas fijadas: ${r.usedPins.join(', ')}`);
      if (r.totals) err(`\n${Math.round((r.totals.durationMs || 0) / 1000)}s · tokens ${r.totals.inputTokens}/${r.totals.outputTokens} · costo equiv. API US$${r.totals.costUsd}`);
    }
    return exitOf(r);
  }
  if (cmd === 'ask') {
    const [flow, ...q] = pos;
    if (!flow || !q.length) { err('Uso: afs ask <flujo> "<pregunta>"'); return 2; }
    const r = await call('POST', `${flowPath(flow)}/ask`, { message: q.join(' '), step: opts.step });
    if (opts.json) console.log(JSON.stringify(r, null, 2)); else { err(`(responde: ${r.routedTo})`); console.log(r.answer); }
    return r.status === 'error' ? 1 : 0;
  }
  if (cmd === 'status') {
    if (pos.length < 2) { err('Uso: afs status <flujo> <runId>'); return 2; }
    const r = await call('GET', `${flowPath(pos[0])}/runs/${pos[1]}`);
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else { console.log(`${r.status}`); for (const s of r.steps) console.log(`${ICON[s.status] || '·'} ${s.step}${s.code ? ` (${s.code})` : ''}`); if (r.result) console.log('\n' + r.result); }
    return r.status === 'running' ? 0 : exitOf(r);
  }
  if (cmd === 'resume') {
    if (pos.length < 2) { err('Uso: afs resume <flujo> <runId> --action continue|edit|retry|skip|stop [--step S] [--output T] [--feedback T]'); return 2; }
    const r = await call('POST', `${flowPath(pos[0])}/runs/${pos[1]}/resume`, { action: opts.action || 'continue', step: opts.step, output: opts.output, feedback: opts.feedback });
    console.log(opts.json ? JSON.stringify(r) : `${r.stepId}: ${r.action}`);
    return 0;
  }
  if (cmd === 'cancel') {
    if (pos.length < 2) { err('Uso: afs cancel <flujo> <runId>'); return 2; }
    const r = await call('POST', `${flowPath(pos[0])}/runs/${pos[1]}/cancel`, {});
    console.log(opts.json ? JSON.stringify(r) : `${r.runId} ${r.status}`);
    return 0;
  }
  err(`Comando desconocido: ${cmd}\n`); console.log(HELP); return 2;
}

main().then((c) => { process.exitCode = c; }).catch((e) => { err(`Error: ${e.message}${e.code ? ` (${e.code})` : ''}`); process.exitCode = 1; });
