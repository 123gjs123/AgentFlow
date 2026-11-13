// Spec 24: chat inside a break. From the review window you talk to the paused step with the REAL input/output of that
// execution, apply its proposals (step fields, output format, flow variables) and re-execute the step with them.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cmd, sleep } from './helpers/harness.mjs';
import { openUi, captureOnFailure } from './helpers/browser.mjs';

let s;
before(async () => { s = await startServer({ name: 'breakchat' }); await s.start(); });
after(async () => { await s?.stop(); });

const edge = (source, target) => ({ id: `e_${source}_${target}`, source, target });
const flowE = async (name, steps, edges, extra = {}) => {
  const f = await s.uiOk('POST', '/api/flows', { name });
  return s.uiOk('PUT', `/api/flows/${f.id}`, { ...f, ...extra, steps, edges });
};
const pausedAt = (f, runId, stepId, round = 0) => s.waitRun(f, runId, 30000, (r) => r.status !== 'running' && (r.status !== 'paused' || r.pauses?.some((p) => p.stepId === stepId && (p.round || 0) === round)));
async function chatDone(flowId, key, message, runId) {
  await s.uiOk('POST', `/api/flows/${flowId}/chat/${key}`, { message, runId });
  for (let i = 0; i < 100; i++) {
    const msgs = await s.uiOk('GET', `/api/flows/${flowId}/chat/${key}`);
    const last = msgs[msgs.length - 1];
    if (last?.role === 'assistant' && last.status !== 'running') return last;
    await sleep(150);
  }
  throw new Error(`el chat no terminó\n${s.output.slice(-3000)}`);
}

test('break después: el chat ve la entrada y la salida reales, propone variables y comando; re-ejecutar con los cambios', async () => {
  const a = cmd('Pull', 'Write-Output "filtro={{vars.filtro}}"', { id: 's_p', breakpoint: 'after' });
  const b = cmd('Usar', '$input | ForEach-Object { "recibí: $_" }', { id: 's_u', breakpoint: 'before' });
  const f = await flowE('Chat en break', [a, b], [edge('s_p', 's_u')], { vars: { filtro: 'viejo', otra: 'igual' } });
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: 'entrada del flujo' })).runId;
  let run = await pausedAt(f.id, runId, 's_p');
  assert.match(run.pauses[0].output, /filtro=viejo/);

  const before = s.calls().length;
  const proposal = { command: 'Write-Output "nuevo filtro={{vars.filtro}}"', vars: { filtro: 'equipo-checkout' } };
  const msg = await chatDone(f.id, 's_p', `el filtro está mal [[mock:propose ${JSON.stringify(proposal)}]]`, runId);
  const call = s.calls().slice(before).find((c) => /# Chat de step/.test(c.append));
  assert.ok(call, 'se llamó al chat del step');
  assert.match(call.prompt, /<run-review>[\s\S]*filtro=viejo[\s\S]*<\/run-review>/, 'el chat recibe la salida real');
  assert.match(call.prompt, /Input del flujo:\nentrada del flujo/);
  assert.match(call.prompt, /Comando ejecutado/);
  assert.match(call.append, /"vars":\{"nombre":"valor"\}/, 'el system prompt explica cómo cambiar variables');
  assert.equal(msg.proposals.length, 1);
  assert.deepEqual(msg.proposals[0].patch, proposal);

  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_p/apply`, { messageId: msg.id, proposalId: msg.proposals[0].id });
  const fl = await s.getFlow(f.id);
  assert.deepEqual(fl.vars, { filtro: 'equipo-checkout', otra: 'igual' }, 'las variables se fusionan');
  assert.equal(fl.steps.find((x) => x.id === 's_p').command, proposal.command);

  // without reload the run keeps its snapshot (REL-4); with reload it takes the saved definition
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_p', action: 'retry', reload: true });
  run = await pausedAt(f.id, runId, 's_p', 1);
  assert.match(run.pauses[0].output, /nuevo filtro=equipo-checkout/);
  assert.equal(run.vars.filtro, 'equipo-checkout');
  assert.ok(run.steps.s_p.events.some((e) => /definición del step y las variables actualizadas/.test(e.text || '')));
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_p', action: 'continue' });

  // break BEFORE the next step: improve its command and run it with the change
  run = await pausedAt(f.id, runId, 's_u');
  assert.equal(run.pauses[0].when, 'before');
  const m2 = await chatDone(f.id, 's_u', `[[mock:propose ${JSON.stringify({ command: '$input | ForEach-Object { "procesado: $_" }' })}]]`, runId);
  assert.match(s.calls().filter((c) => /# Chat de step/.test(c.append)).pop().prompt, /Lo que recibe de otros steps:\n### Pull[\s\S]*nuevo filtro=equipo-checkout/);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_u/apply`, { messageId: m2.id, proposalId: m2.proposals[0].id });
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { step: 's_u', action: 'continue', reload: true });
  run = await s.waitRun(f.id, runId);
  assert.equal(run.status, 'success');
  assert.match(run.steps.s_u.output, /procesado: nuevo filtro=equipo-checkout/);
  assert.equal(run.steps.s_p.reviewRounds, 1);
});

test('sin "reload" un cambio aplicado durante la pausa no altera esta ejecución; propuestas inválidas se filtran', async () => {
  const a = cmd('Fijo', 'Write-Output "v={{vars.x}}"', { id: 's_f', breakpoint: 'after' });
  const f = await flowE('Snapshot', [a], [], { vars: { x: '1' } });
  const runId = (await s.uiOk('POST', `/api/flows/${f.id}/run`, { input: '' })).runId;
  await pausedAt(f.id, runId, 's_f');
  const bad = { vars: { x: '2', 'mal nombre!': 'y', n: 5 }, shell: 'zsh', output: { format: 'json', schema: { type: 'object' } } };
  const m = await chatDone(f.id, 's_f', `[[mock:propose ${JSON.stringify(bad)}]]`, runId);
  await s.uiOk('POST', `/api/flows/${f.id}/chat/s_f/apply`, { messageId: m.id, proposalId: m.proposals[0].id });
  const fl = await s.getFlow(f.id);
  assert.deepEqual(fl.vars, { x: '2', n: '5' }, 'nombres inválidos fuera; valores como texto');
  const st = fl.steps[0];
  assert.equal(st.shell, 'powershell', 'shell desconocido ignorado');
  assert.equal(st.output.format, 'json');
  assert.equal(JSON.parse(st.output.schema).type, 'object', 'schema objeto → texto');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'retry', feedback: 'otra vez' });
  const run = await pausedAt(f.id, runId, 's_f', 1);
  assert.match(run.pauses[0].output, /v=1/, 'retry sin reload usa la copia del inicio');
  await s.uiOk('POST', `/api/flows/${f.id}/runs/${runId}/resume`, { action: 'stop' });
  await s.waitRun(f.id, runId);
});

// ---------- UI ----------
let ui = {}; let page;
test('UI: en el break, "Mejorar con chat" → aplicar → "Re-ejecutar con los cambios" → aprobar', async (t) => {
  ui = await openUi('breakchat-ui');
  if (ui.skipReason) { t.skip(ui.skipReason); return; }
  page = ui.page;
  try {
    const a = cmd('Pull Jira', 'Write-Output "JQL: project = {{vars.proyecto}}"', { id: 's_j', breakpoint: 'after', position: { x: 100, y: 100 } });
    const f = await ui.s.flow('Break chat UI', [a], [], { vars: { proyecto: 'SBK' } });
    await page.goto(ui.s.base + '/');
    await page.locator('header select').selectOption(f.id);
    await page.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
    await page.getByRole('button', { name: 'Ejecutar', exact: true }).click();
    await page.getByText('Break: validar antes de seguir').waitFor();
    await page.getByText('JQL: project = SBK').first().waitFor();
    await page.getByRole('button', { name: /Mejorar con chat/ }).click();
    const box = page.getByTestId('pause-chat');
    await box.locator('textarea').fill(`usa el proyecto SBF [[mock:propose ${JSON.stringify({ vars: { proyecto: 'SBF' } })}]]`);
    await box.locator('textarea').press('Enter');
    await box.getByText('variable del flujo "proyecto"').waitFor();
    await box.getByRole('button', { name: 'Aplicar' }).click();
    await page.getByTestId('changed-bar').waitFor();
    await page.getByRole('button', { name: '↻ Re-ejecutar con los cambios' }).click();
    await page.getByText('(intento 2)').waitFor();
    await page.getByText('JQL: project = SBF').first().waitFor();
    await page.getByRole('button', { name: '✔ Aprobar y seguir' }).click();
    const runs = await ui.s.uiOk('GET', `/api/flows/${f.id}/runs`);
    const run = await ui.s.waitRun(f.id, runs[0].id);
    assert.equal(run.status, 'success');
    assert.match(run.steps.s_j.output, /project = SBF/);
    assert.equal((await ui.s.getFlow(f.id)).vars.proyecto, 'SBF');
    assert.deepEqual(page.errors, []);
  } catch (e) { await captureOnFailure(page, { name: t.name, passed: false }); throw e; }
  finally { await ui.close?.(); }
});

test('UI: reemplazar la salida de un step de texto en el break (sin cuadro JSON; texto en "Datos JSON" → "Usarlo como salida")', async (t) => {
  const u = await openUi('break-edit-ui');
  if (u.skipReason) { t.skip(u.skipReason); return; }
  const pg = u.page;
  try {
    const a = cmd('Pull Jira', 'Write-Output "0 tickets"', { id: 's_pj', breakpoint: 'after', position: { x: 100, y: 100 } });
    const b = cmd('Interpretar', '$input | ForEach-Object { "recibí: $_" }', { id: 's_in', position: { x: 100, y: 400 } });
    const f = await u.s.flow('Reemplazar salida', [a, b], [['s_pj', 's_in']]);
    await pg.goto(u.s.base + '/');
    await pg.locator('header select').selectOption(f.id);
    await pg.getByRole('button', { name: '▶ Ejecutar flujo' }).click();
    await pg.getByRole('button', { name: 'Ejecutar', exact: true }).click();
    await pg.getByText('Break: validar antes de seguir').waitFor();
    await pg.getByRole('button', { name: '✎ Editar salida' }).click();
    assert.equal(await pg.getByTestId('edit-json').count(), 0, 'un step de texto no muestra el cuadro JSON');
    await pg.getByText('Agregar datos JSON').click();
    await pg.getByTestId('edit-json').fill('JQL Ready: Key= SBK-949');
    await pg.getByRole('button', { name: 'Guardar y seguir' }).click();
    await pg.getByText(/no es JSON/).waitFor();
    await pg.getByRole('button', { name: 'Usarlo como salida' }).click();
    assert.equal(await pg.getByTestId('edit-output').inputValue(), 'JQL Ready: Key= SBK-949');
    await pg.getByRole('button', { name: 'Guardar y seguir' }).click();
    const runs = await u.s.uiOk('GET', `/api/flows/${f.id}/runs`);
    const run = await u.s.waitRun(f.id, runs[0].id);
    assert.equal(run.status, 'success');
    assert.equal(run.steps.s_pj.output, 'JQL Ready: Key= SBK-949');
    assert.match(run.steps.s_in.output, /recibí: JQL Ready: Key= SBK-949/);
    assert.deepEqual(pg.errors, []);
  } catch (e) { await captureOnFailure(pg, { name: t.name, passed: false }); throw e; }
  finally { await u.close?.(); }
});
