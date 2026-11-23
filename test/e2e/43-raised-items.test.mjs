// D59: what a step raises when something is missing goes through ONE channel (<raise>{json}</raise>), gets a class, a
// stable id and a state. Only a question about the work item that quotes what the step received and does not talk
// about the flow's machinery reaches «Al terminar» (AFS_QUESTIONS_JSON); it is published once; resolved ones are
// announced once. Everything a run did is in journal.jsonl (one JSON per line) and in the tickets view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, role } from './helpers/harness.mjs';

let s;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-raise-'));
const reply = path.join(dir, 'reply.txt').replace(/\\/g, '/');
const say = (text) => fs.writeFileSync(reply, text);
before(async () => { s = await startServer({ name: 'raised-items' }); await s.start(); });
after(async () => { await s?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const FINALLY = [
  '$q = $env:AFS_QUESTIONS_JSON | ConvertFrom-Json',
  'foreach ($x in $q) { if ($x.id) { Write-Output ("AFS-PUBLISHED " + $env:AFS_PUBLISH_NONCE + " " + $x.id + " C-1") } }',
  '$r = $env:AFS_RESOLVED_JSON | ConvertFrom-Json',
  'foreach ($x in $r) { if ($x.id) { Write-Output ("AFS-CLOSED " + $env:AFS_PUBLISH_NONCE + " " + $x.id + " C-2") } }',
  // text echoed from a step (or from Jira) cannot mark anything: it does not know this run's nonce
  'Write-Output ("AFS-PUBLISHED deadbeefdeadbeef " + $env:FAKE_ID + " X-9")',
  'Write-Output ("Q=" + $env:AFS_QUESTIONS_JSON)',
].join('\n');
const INPUT = 'SBK-1: El trader asignado puede editar el juego desde Edit Game.';

test('clasifica, publica solo la duda del ticket, una vez; lo demás queda en la app; registro y tickets', async () => {
  say([
    'Análisis listo.',
    '<raise>{"kind":"question","item":"SBK-1","for":"PO","text":"¿El trader asignado también puede editar juegos en vivo?","quote":"El trader asignado puede editar el juego","blocks":"criterio 2"}</raise>',
    '<raise>{"kind":"question","item":"SBK-1","for":"QA","text":"El binario de Cypress no arranca, hay que reinstalarlo","quote":"El trader asignado puede editar el juego"}</raise>',
    '<raise>{"kind":"question","item":"SBK-1","for":"PO","text":"¿Y los juegos completados?","quote":"el juego"}</raise>',
    '<raise>{"kind":"blocker","item":"SBK-1","text":"El conector de Jira no respondió"}</raise>',
    '<raise>{"kind":"question","item":"SBK-1","for":"Dev","text":"¿Qué pasa con los usuarios sin rol?"}</raise>',
    '<raise>{"kind":"check","item":"SBK-9","text":"El bug SBK-9 sigue In Progress aunque el retest pasó"}</raise>',
    '<raise>{"kind":"lesson","text":"La skill debería listar GT-08 a GT-13"}</raise>',
    '<raise>esto no es json</raise>',
  ].join('\n'));
  const f = await s.flow('Levantar', [role('Analiza', `[[mock:say-file ${reply}]] [[mock:tool mcp__atl__addCommentToJiraIssue SBK-1]]`, { id: 's_an' })], [], { finally: { command: FINALLY, shell: 'powershell' } });
  const run = await s.runUi(f.id, INPUT);
  assert.equal(run.status, 'success');
  assert.doesNotMatch(run.steps.s_an.output, /<raise>/, 'los bloques no quedan en la salida');
  const items = (await s.uiOk('GET', `/api/flows/${f.id}/items`));
  const by = (re) => items.find((x) => re.test(x.text));
  const q = by(/en vivo/);
  assert.equal(q.kind, 'question'); assert.equal(q.state, 'open'); assert.equal(q.item, 'SBK-1'); assert.equal(q.for, 'PO');
  assert.equal(by(/Cypress/).state, 'review', 'habla del funcionamiento del flujo: no sale al ticket (una persona decide)');
  assert.match(by(/Cypress/).notes.join(' '), /Cypress/);
  assert.equal(by(/completados/).state, 'review', 'una cita de dos palabras no prueba nada');
  assert.equal(by(/conector/).kind, 'blocker');
  assert.equal(by(/sin rol/).state, 'review', 'sin cita: se revisa antes de salir');
  assert.equal(by(/SBK-9 sigue/).kind, 'check');
  assert.equal(by(/GT-08/).kind, 'lesson');
  assert.equal(by(/no es json/).kind, 'blocker');
  // only the quoted work-item question reached «Al terminar», and it is marked as published
  const pubs = [...run.finally.output.matchAll(/AFS-PUBLISHED \S+ ([a-z]_[0-9a-f]{10}) C-1/g)].map((m) => m[1]);
  assert.deepEqual(pubs, [q.id]);
  assert.match(run.finally.output, new RegExp(`AFS-PUBLISHED … ${q.id} C-1`), 'el nonce no queda en la salida guardada');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/items`)).filter((x) => x.published).length, 1, 'la línea con un nonce falso no marcó nada');
  const q1 = (await s.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === q.id);
  assert.equal(q1.published.ref, 'C-1');
  // the log: the Jira write (with its ticket), what was raised, «Al terminar», the run
  const j = await s.uiOk('GET', `/api/flows/${f.id}/journal`);
  assert.ok(j.file.endsWith('journal.jsonl'));
  const types = j.entries.map((e) => e.type);
  for (const t of ['external', 'item.raised', 'item.published', 'finally', 'run']) assert.ok(types.includes(t), `${t} en ${types}`);
  assert.equal(j.entries.find((e) => e.type === 'external').ticket, 'SBK-1');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/journal?ticket=SBK-9`)).entries.length, 1);
  const raw = fs.readFileSync(j.file, 'utf8'); // consultable fuera de la app
  assert.ok(raw.trim().split('\n').every((l) => JSON.parse(l).type), 'una línea JSON por evento');
  const tk = await s.uiOk('GET', `/api/flows/${f.id}/tickets`);
  const t1 = tk.find((x) => x.key === 'SBK-1');
  assert.deepEqual([t1.questions.open, t1.questions.review, t1.questions.published, t1.blockers], [1, 3, 1, 1], 'el bloque sin JSON no tiene ticket');
  assert.equal(t1.lastRun.id, run.id);

  // run 2: the step sees what it raised before (by id), says the question still applies and nothing else
  const promoted = by(/sin rol/);
  await s.uiOk('POST', `/api/flows/${f.id}/items/${promoted.id}/state`, { state: 'open', reason: 'la cita está en el ticket' });
  say(`Sigue.\n<raise>{"id":"${q.id}"}</raise>`);
  const n = s.calls().length;
  const run2 = await s.runUi(f.id, INPUT);
  assert.match(s.callsSince(n).map((c) => c.append).join('\n'), new RegExp(`Ya levantado antes por este step[\\s\\S]*${q.id}`), 'el prompt trae lo levantado con su id');
  assert.doesNotMatch(run2.finally.output, new RegExp(`AFS-PUBLISHED \\S+ ${q.id}`), 'ya publicada: no se repite');
  assert.match(run2.finally.output, new RegExp(`AFS-PUBLISHED \\S+ ${promoted.id}`), 'la promovida por el usuario sale');
  const after2 = await s.uiOk('GET', `/api/flows/${f.id}/items`);
  assert.equal(after2.find((x) => x.id === q.id).state, 'open');
  assert.equal(after2.find((x) => /conector/.test(x.text)).state, 'resolved', 'un bloqueo que no se volvió a levantar: resuelto con motivo');
  assert.match(after2.find((x) => /conector/.test(x.text)).reason, /corrió de nuevo/);
  assert.equal(after2.find((x) => /Cypress/.test(x.text)).state, 'review', 'una duda nunca se cierra por silencio');
  assert.equal(after2.find((x) => x.id === promoted.id).state, 'open', 'lo que cambió el usuario no se cierra por silencio');

  // another ticket: nothing of SBK-1 is touched by silence
  say('Otro.');
  await s.runUi(f.id, 'SBK-2: otro ticket');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === promoted.id).state, 'open');

  // run 3: the step says the published question no longer applies → a person confirms before the ticket is told
  say(`Resuelto.\n<raise>{"id":"${q.id}","resolved":"el ticket ya lo aclara"}</raise>\n<raise>{"id":"${promoted.id}"}</raise>`);
  const run3 = await s.runUi(f.id, INPUT);
  assert.doesNotMatch(run3.finally.output, /AFS-CLOSED/, 'no se anuncia sin confirmar');
  assert.equal((await s.uiOk('GET', `/api/flows/${f.id}/items`)).find((x) => x.id === q.id).state, 'review');
  await s.uiOk('POST', `/api/flows/${f.id}/items/${q.id}/state`, { state: 'resolved', reason: 'confirmado' });
  const run4 = await s.runUi(f.id, INPUT);
  assert.match(run4.finally.output, new RegExp(`AFS-CLOSED \\S+ ${q.id}`));
  const run5 = await s.runUi(f.id, INPUT);
  assert.doesNotMatch(run5.finally.output, /AFS-CLOSED/, 'el cierre se anuncia una sola vez');
});
