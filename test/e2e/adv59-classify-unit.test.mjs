// D58 adversarial review of D59 (server/items.js) — deterministic parts, no server needed.
// Each test asserts the DESIRED behaviour, so a failing test = a proved defect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-adv59-'));
process.env.AFS_DATA = dataDir;
let I; let store;
before(async () => { I = await import('../../server/items.js'); store = await import('../../server/store.js'); });
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// how «Al terminar» reports (nonce of the run + only ids that were handed to it)
const pub = (F, runId, what, id, ref) => { const n = `n-${runId}`; const d = { questions: new Set(what === 'PUBLISHED' ? [id] : []), resolved: new Set(what === 'CLOSED' ? [id] : []) }; I.markPublished(F, runId, `AFS-${what} ${n} ${id} ${ref}`, { nonce: n, delivered: d }); };
const CORPUS = 'SBK-1: El trader asignado puede editar el juego desde Edit Game.';
const q = (text, extra = {}) => I.classify({ kind: 'question', item: 'SBK-1', for: 'PO', text, quote: 'El trader asignado puede editar el juego', ...extra }, CORPUS);

// 1a. flow-machinery problems worded so MACHINERY does not see them: they stay "question/open" → reach the ticket
const MACHINE_LEAKS = [
  '¿Ya se abrió el PR con los cambios?',
  'No tengo permisos para escribir en la carpeta C:/Users/qa/Documents/automation',
  'El conector de Jira no responde, ¿podés reconectarlo?',
  'Python no está instalado en la máquina, ¿quién lo instala?',
  'El comando terminó con código de salida 1, ¿lo revisás?',
  '¿En qué plan de pruebas agrego los casos?',
  'Falta el token de Bitbucket para poder continuar',
  'No pude editar el archivo SKILL de la habilidad de QA',
  '¿Podés darme acceso de escritura a la carpeta del workspace?',
  'La herramienta Bash fue denegada, ¿la habilitás?',
];
test('1a MACHINERY: problemas del flujo que se escapan como pregunta del ticket', () => {
  const leaked = MACHINE_LEAKS.filter((t) => { const c = q(t); return c.kind === 'question' && c.state !== 'review'; });
  assert.deepEqual(leaked, [], `${leaked.length}/${MACHINE_LEAKS.length} llegan a AFS_QUESTIONS_JSON:\n${leaked.join('\n')}`);
});

// 1b. legitimate business questions demoted to "blocker" (never reach the person who can answer)
const BUSINESS = [
  '¿Las ramas del árbol de deportes se muestran colapsadas por defecto?',
  '¿El límite aplica también a la branch de Panamá?',
  '¿Los skill games entran en el bono de casino?',
  '¿Se mergean las cuentas duplicadas del cliente o se bloquean?',
  '¿El jugador puede clonar una apuesta ya colocada?',
  '¿El endpoint de exportación devuelve .json o CSV?',
  '¿El script del comercial menciona el bono de bienvenida?',
  '¿Las opciones binarias se ofrecen en el mercado de BTC?',
  '¿Hay que reinstalar la app móvil para ver el cambio?',
  '¿Las operaciones repo se incluyen en el reporte de tesorería?',
  '¿El commit de la apuesta ocurre antes o después del cambio de cuota?',
  '¿El node padre del árbol de mercados hereda el límite?',
];
test('1b MACHINERY: preguntas de negocio legítimas degradadas a blocker', () => {
  const demoted = BUSINESS.filter((t) => q(t).kind === 'blocker');
  assert.deepEqual(demoted, [], `${demoted.length}/${BUSINESS.length} degradadas:\n${demoted.join('\n')}`);
});

// 1c. the quote check: a quote that normalizes to "" or to a common word always "appears" in the corpus
test('1c cita trivial: puntuación o una palabra común pasan el control de la cita', () => {
  for (const quote of ['¿?', '...', '—', 'el', 'de']) {
    const c = q('¿El permiso de pago aplica a menores?', { quote });
    assert.equal(c.state, 'review', `cita "${quote}" debería ir a revisión, quedó ${c.state || 'open'}`);
  }
});

// 3a. any step can resolve any item by id (no stepId check)
test('3a un step resuelve (y hace anunciar el cierre de) la pregunta PUBLICADA de otro step', () => {
  const F = 'f_ref';
  const [a] = I.recordRaised(F, { runId: 'r1', stepId: 's_A', stepName: 'A', raised: [{ kind: 'question', item: 'SBK-1', text: '¿Aplica a vivo?', quote: 'El trader asignado puede editar el juego' }], corpus: CORPUS });
  pub(F, 'r1', 'PUBLISHED', a.id, 'C-1');
  I.recordRaised(F, { runId: 'r2', stepId: 's_B', stepName: 'B', raised: [{ id: a.id, resolved: 'ya no hace falta' }], corpus: '' });
  const it = store.getItems(F).find((x) => x.id === a.id);
  assert.equal(it.state, 'open', `B resolvió la pregunta de A → AFS_RESOLVED_JSON=${JSON.stringify(I.publishable(F).resolved.map((x) => x.id))}`);
});

// 3b. the id is a deterministic sha1 of kind|item|text: untrusted text can compute and target it
test('3b el id es predecible desde el texto (sha1 público)', async () => {
  const crypto = await import('node:crypto');
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const predicted = `q_${crypto.createHash('sha1').update(`question|SBK-1|${norm('¿Aplica a vivo?')}`).digest('hex').slice(0, 10)}`;
  const it = store.getItems('f_ref').find((x) => x.id === predicted);
  if (!it) return;
  const before = JSON.stringify(it.published || null);
  I.markPublished('f_ref', 'rX', `AFS-PUBLISHED adivinado ${predicted} X-1`, { nonce: 'el-de-la-corrida', delivered: { questions: new Set([predicted]), resolved: new Set() } });
  assert.equal(JSON.stringify(store.getItems('f_ref').find((x) => x.id === predicted).published || null), before, 'sin el nonce de la corrida, conocer el id no alcanza');
});

// 6a. published → resolved (closed notice sent) → raised again: reopened but never published again
test('6a pregunta cerrada en el ticket y vuelta a levantar: reabierta pero NUNCA se vuelve a publicar', () => {
  const F = 'f_reopen';
  const raise = (runId) => I.recordRaised(F, { runId, stepId: 's_A', stepName: 'A', raised: [{ kind: 'question', item: 'SBK-1', text: '¿Aplica a vivo?', quote: 'El trader asignado puede editar el juego' }], corpus: CORPUS });
  const [a] = raise('r1');
  pub(F, 'r1', 'PUBLISHED', a.id, 'C-1');
  I.recordRaised(F, { runId: 'r2', stepId: 's_A', stepName: 'A', raised: [{ id: a.id, resolved: 'el ticket lo aclara' }], corpus: '' });
  I.setState(F, a.id, 'resolved', 'confirmado');
  pub(F, 'r2', 'CLOSED', a.id, 'C-2'); // ticket now says "ya no hace falta responder"
  raise('r3'); // the doubt comes back
  const it = store.getItems(F).find((x) => x.id === a.id);
  assert.equal(it.state, 'open');
  assert.ok(I.publishable(F).questions.some((x) => x.id === a.id), 'reabierta y el ticket dice "ya no hace falta": debería volver a AFS_QUESTIONS_JSON');
});

// 2a. markPublished trusts ANY id printed on stdout, also ids it never handed out (review question, blocker)
test('2a AFS-PUBLISHED de un id que no estaba en AFS_QUESTIONS_JSON (pregunta en revisión) la marca publicada para siempre', () => {
  const F = 'f_forge';
  const [r] = I.recordRaised(F, { runId: 'r1', stepId: 's_A', stepName: 'A', raised: [{ kind: 'question', item: 'SBK-1', text: '¿Y los usuarios sin rol?' }], corpus: CORPUS });
  assert.equal(r.state, 'review');
  I.markPublished(F, 'r1', `AFS-PUBLISHED ${r.id} forjado`); // e.g. a line echoed from a step output / Jira text
  I.setState(F, r.id, 'open', 'la promuevo');
  assert.ok(I.publishable(F).questions.some((x) => x.id === r.id), 'la promovida por el usuario nunca sale: ya figura publicada');
});

// 4. secrets: journalFromEvents stores the command line and the tool result verbatim
test('4 journal: un curl con Authorization y la respuesta con un token quedan en claro en journal.jsonl', () => {
  const TOKEN = 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789';
  const ev = [
    { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -s -X POST -H "Authorization: Bearer ${TOKEN}" https://jira/rest/api/3/issue/SBK-1/comment -d @c.json` } },
    { kind: 'tool_result', id: 't1', content: `{"ok":true,"echo":"token=${TOKEN}"}` },
    { kind: 'tool_use', id: 't2', name: 'mcp__atl__createJiraIssue', input: { projectKey: 'SBK', description: 'x' } },
    { kind: 'tool_result', id: 't2', content: `created SBK-77 with api key ${TOKEN}` },
  ];
  const out = I.journalFromEvents(ev, { runId: 'r1', step: 'A' });
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes(TOKEN), `el token aparece ${raw.split(TOKEN).length - 1} veces en el registro`);
});

// 5. growth: items.json is never pruned; every rewording is a new item
test('5 items.json crece sin límite (1 ítem nuevo por cada redacción distinta)', () => {
  const F = 'f_grow';
  for (let i = 0; i < 1500; i++) I.recordRaised(F, { runId: `r${i}`, stepId: 's_A', stepName: 'A', raised: [{ kind: 'blocker', text: `La herramienta falló (intento ${i})` }], corpus: '' });
  const n = store.getItems(F).length;
  assert.ok(n <= 1000, `items.json tiene ${n} ítems (${fs.statSync(store.flowFile(F, 'items.json')).size} bytes), sin poda`);
});
