// Spec 29: what happens in the office, from the events the app already emits (live over /ws, or rebuilt from a stored
// run for "Ver la jornada"). Pure and deterministic: time comes only from the messages (`t`), never from the clock.
//
// Messages: run.started {runId, trigger, rehearsal} · step.status {runId, stepId, status} · run.event {runId, stepId,
// event:{kind, t, seq, name, input, isError, denials, …}} · run.paused / run.resumed · run.finally · run.finished ·
// review.started / review.done.

const MAX_LOG = 30;
export const ACTIVE = new Set(['running', 'paused']);
export const ticketOf = (runId) => { const h = String(runId || '').replace(/[^a-f0-9]/gi, '').slice(-4) || '0'; return `A${String(parseInt(h, 16) % 1000).padStart(3, '0')}`; };
const baseStep = (id) => id.split('~')[0];
export const initialScene = () => ({ runs: {}, order: [], focusRunId: null, inspector: false, log: [], trace: [] });

/** What a tool call looks like in the office. */
export function toolActivity(name, input = {}) {
  const n = String(name || '');
  if (/^shell:/.test(n)) return { activity: 'terminal', spot: 'seat', computer: 'running' };
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(n)) {
    const p = String(input?.file_path || input?.path || input?.pattern || '');
    return { activity: 'reading', spot: /runs|outputs|expedientes/i.test(p) ? 'shelf:expedientes' : 'shelf:contexto', bubble: n === 'Read' ? '📄 leyendo' : '🔎 buscando' };
  }
  if (n === 'Skill') return { activity: 'reading', spot: 'shelf:contexto', bubble: '📘 skill' };
  if (/^(Edit|Write|MultiEdit|NotebookEdit|TodoWrite)$/.test(n)) return { activity: 'typing', spot: 'seat', bubble: '⌨ escribiendo' };
  if (/^(Bash|PowerShell|BashOutput)$/.test(n)) return { activity: 'terminal', spot: 'seat', bubble: `> ${String(input?.command || '').replace(/\s+/g, ' ').slice(0, 24)}` };
  if (/^(WebFetch|WebSearch)$/.test(n)) return { activity: 'phone', spot: 'seat', bubble: '🌐 web…' };
  if (/^mcp__/.test(n)) {
    const srv = n.split('__')[1] || '';
    const who = /jira/i.test(n) ? 'Jira' : /confluence/i.test(n) ? 'Confluence' : /slack/i.test(n) ? 'Slack' : /mail|gmail/i.test(n) ? 'Correo' : srv.replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return { activity: 'phone', spot: 'seat', bubble: `📞 ${who}…` };
  }
  if (/^(Task|Agent)$/.test(n)) return { activity: 'consulting', spot: 'seat', bubble: '💬 consulta a un colega' };
  return { activity: 'thinking', spot: 'seat', bubble: `🛠 ${n.slice(0, 20)}` };
}

const LOCKED_RE = /permission|denied|haven't granted|not allowed/i;
function logLine(s, t, text) { s.log = [...s.log, { t, text }].slice(-MAX_LOG); }
function pickFocus(s) {
  const active = s.order.filter((id) => ACTIVE.has(s.runs[id]?.status));
  s.focusRunId = active.length ? active[active.length - 1] : s.order[s.order.length - 1] || null;
}

/**
 * The reducer. `ctx = {flow, names?: Map(stepId → name), trace?}`. Returns a NEW scene (inputs are not mutated).
 */
export function officeReduce(prev, msg, ctx = {}) {
  if (!msg || !msg.type) return prev;
  const s = { ...prev, runs: { ...prev.runs }, order: [...prev.order], log: prev.log, trace: prev.trace };
  const t = Number(msg.t ?? msg.event?.t ?? 0);
  const flow = ctx.flow || { steps: [], edges: [] };
  const who = (id) => ctx.names?.get(id) || flow.steps?.find((x) => x.id === id)?.name || id;
  const stepOf = (id) => flow.steps?.find((x) => x.id === id);
  if (msg.type === 'review.started') { s.inspector = true; return s; }
  if (msg.type === 'review.done') { s.inspector = false; return s; }
  const runId = msg.runId; if (!runId) return prev;
  let run = s.runs[runId];
  if (msg.type === 'run.started') {
    if (run) return prev;
    run = { runId, ticket: ticketOf(runId), trigger: msg.trigger || 'manual', rehearsal: !!msg.rehearsal, status: 'running', startedAt: t, lastSeq: -1, steps: {}, computers: {}, papers: [{ from: 'entrada', to: 'window', t }], bell: null, finally: null, stamp: null };
    s.runs[runId] = run; s.order.push(runId);
    if (s.order.length > 20) { const drop = s.order.shift(); delete s.runs[drop]; }
    pickFocus(s);
    logLine(s, t, `Turno ${run.ticket}: entra una ejecución (${run.trigger})${run.rehearsal ? ' — simulacro' : ''}.`);
    return s;
  }
  if (!run && ctx.autoRun && ['step.status', 'run.event', 'run.paused'].includes(msg.type)) {
    // a run already going whose catch-up failed: follow it from here
    run = { runId, ticket: ticketOf(runId), trigger: '?', rehearsal: false, status: 'running', startedAt: t, lastSeq: -1, steps: {}, computers: {}, papers: [], bell: null, finally: null, stamp: null };
    s.runs[runId] = run; s.order.push(runId); pickFocus(s);
  }
  if (!run) return prev; // events of a run the office never saw start (the catch-up rebuilds it first)
  run = { ...run, steps: { ...run.steps }, computers: { ...run.computers }, papers: run.papers };
  s.runs[runId] = run;
  const setStep = (id, patch) => {
    const cur = run.steps[id] || { status: 'idle', activity: 'idle', spot: 'seat', bubble: null, since: t, locked: false, item: null, handed: false };
    const next = { ...cur, ...patch };
    if (patch.activity && patch.activity !== cur.activity) next.since = t;
    run.steps[id] = next;
    if (ctx.trace && patch.activity) s.trace = [...s.trace, { stepId: id, activity: patch.activity, spot: next.spot, t }];
    return next;
  };
  switch (msg.type) {
    case 'step.status': {
      const id = baseStep(String(msg.stepId || '')); const st = msg.status;
      if (!id || msg.stepId !== id) break; // for-each items do not change the desk
      if (run.steps[id]?.status === st) return prev; // the engine may repeat a status (e.g. success after a break): once is enough
      if (st === 'running') {
        const cur = run.steps[id];
        if (cur?.status === 'paused') setStep(id, { status: 'running', activity: 'thinking', spot: 'seat' });
        else { setStep(id, { status: 'running', activity: 'receiving', spot: 'seat', bubble: '📁', locked: false, handed: false, done: false }); logLine(s, t, `${who(id)} recibe la carpeta.`); }
        if (stepOf(id)?.kind === 'command') run.computers[id] = 'running';
      } else if (st === 'queued') setStep(id, { status: 'queued', activity: 'waiting', spot: 'seat', bubble: '⏳ espera turno' });
      else if (st === 'paused') { setStep(id, { status: 'paused', activity: 'raised-hand', spot: 'seat', bubble: '🙋 revisión' }); run.bell = id; logLine(s, t, `${who(id)} levanta la mano: break, espera tu revisión.`); }
      else if (st === 'success') {
        if (run.steps[id]?.done) { setStep(id, { status: 'success', activity: 'done', spot: 'seat', bubble: '✓' }); if (run.bell === id) run.bell = null; break; }
        setStep(id, { status: 'success', activity: 'done', spot: 'seat', bubble: '✓', done: true });
        if (stepOf(id)?.kind === 'command') run.computers[id] = 'ok';
        const outs = (flow.edges || []).filter((e) => e.source === id);
        run.papers = [...run.papers, ...(outs.length ? outs.map((e) => ({ edgeId: e.id, from: id, to: e.target, t })) : [{ from: id, to: 'salida', t }])].slice(-40);
        if (run.bell === id) run.bell = null;
        logLine(s, t, `${who(id)} terminó y pasa la carpeta.`);
      } else if (st === 'error' || st === 'timeout') {
        setStep(id, { status: st, activity: 'storm', spot: 'seat', bubble: st === 'timeout' ? '⏱ se le acabó el tiempo' : '⛈ error' });
        if (stepOf(id)?.kind === 'command') run.computers[id] = 'err';
        run.papers = [...run.papers, { from: id, to: 'window', t, red: true }].slice(-40);
        logLine(s, t, `${who(id)} tuvo un problema (${st === 'timeout' ? 'tiempo agotado' : 'error'}).`);
      } else if (st === 'skipped') setStep(id, { status: 'skipped', activity: 'skipped', spot: 'seat', bubble: null });
      else if (st === 'stopped' || st === 'interrupted') setStep(id, { status: st, activity: 'stopped', spot: 'seat', bubble: '■' });
      break;
    }
    case 'run.event': {
      const ev = msg.event || {};
      if (typeof ev.seq === 'number') { if (ev.seq <= run.lastSeq) return prev; run.lastSeq = ev.seq; }
      const id = baseStep(String(msg.stepId || ''));
      if (!id) break;
      const isItem = msg.stepId !== id;
      const cur = run.steps[id];
      if (cur && !cur.handed) run.steps[id] = { ...cur, handed: true };
      const k = ev.kind;
      if (k === 'tool_use') {
        if (ev.sub) { setStep(id, { activity: 'consulting', spot: 'seat', bubble: '💬 consulta a un colega' }); break; }
        const a = toolActivity(ev.name, ev.input);
        if (a.computer) { run.computers[id] = 'running'; setStep(id, { activity: 'terminal', spot: 'seat', bubble: `> ${String(stepOf(id)?.command || '').replace(/\s+/g, ' ').slice(0, 24)}` }); }
        else setStep(id, { activity: a.activity, spot: a.spot, bubble: a.bubble || null });
        if (a.spot.startsWith('shelf:')) logLine(s, t, `${who(id)} va a la estantería ${a.spot === 'shelf:expedientes' ? 'Expedientes' : 'Contexto'}.`);
        else if (a.activity === 'phone') logLine(s, t, `${who(id)} hace una llamada (${a.bubble.replace(/^📞 /, '')}).`);
      } else if (k === 'tool_result') {
        if (stepOf(id)?.kind === 'command' && !isItem) run.computers[id] = ev.isError ? 'err' : 'ok';
        else if (ev.isError && LOCKED_RE.test(String(ev.content || ''))) setStep(id, { locked: true, bubble: '🔒 cajón cerrado' });
        // the character stays where the tool took them (still reading what they fetched) until the next event
      } else if (k === 'result') { if ((ev.denials || []).length) { setStep(id, { locked: true, bubble: '🔒 cajón cerrado' }); logLine(s, t, `${who(id)} encontró un cajón cerrado (permiso denegado).`); } }
      else if (k === 'thinking' || k === 'thinking_tokens') setStep(id, { activity: 'thinking', spot: 'seat', bubble: '💭' });
      else if (k === 'text') setStep(id, { activity: 'writing', spot: 'seat', bubble: '✍' });
      else if (k === 'queued') setStep(id, { activity: 'waiting', spot: 'seat', bubble: '⏳ espera turno' });
      else if (k === 'retry') setStep(id, { bubble: '↻ reintenta' });
      else if (k === 'timeout') setStep(id, { activity: 'storm', bubble: '⏱' });
      else if (k === 'hook' || k === 'hook_log') {
        const txt = String(ev.text || '');
        const m = txt.match(/▶\s*(\d+)\s*\/\s*(\d+)/);
        if (m) setStep(id, { item: { i: Number(m[1]), total: Number(m[2]) } });
        else if (ev.childRun) setStep(id, { activity: 'phone', spot: 'seat', bubble: '📞 llamando a otro flujo' });
        else setStep(id, { bubble: '🪝' });
      } else if (k === 'error') setStep(id, { bubble: '⚠' });
      break;
    }
    case 'run.paused': { const id = baseStep(String(msg.stepId || '')); if (id) { setStep(id, { status: 'paused', activity: 'raised-hand', spot: 'seat', bubble: '🙋 revisión' }); run.bell = id; } run.status = 'paused'; pickFocus(s); break; }
    case 'run.resumed': { const id = baseStep(String(msg.stepId || '')); if (id && run.steps[id]) setStep(id, { status: 'running', activity: 'thinking', spot: 'seat', bubble: null }); run.bell = null; run.status = 'running'; break; }
    case 'run.finally': run.finally = msg.status || 'running'; if (msg.status === 'running' || !msg.status) logLine(s, t, `${'Tomás'} lleva el expediente a Archivo ("Al terminar").`); break;
    case 'run.finished': {
      run.status = msg.status || 'success';
      // «CON ERROR», not «RECHAZADO»: nobody rejected it, something failed (the stamp opens the step that failed)
      run.stamp = run.status === 'success' ? 'APROBADO' : run.status === 'stopped' ? 'DETENIDO' : 'CON ERROR';
      run.failedStep = run.status !== 'success' && run.status !== 'stopped' ? Object.keys(run.steps).find((k) => ['error', 'timeout', 'interrupted'].includes(run.steps[k].status)) || null : null;
      run.bell = null;
      if (run.finally === 'running') run.finally = run.status;
      logLine(s, t, `Turno ${run.ticket}: ${run.stamp} (${run.status}).`);
      pickFocus(s);
      break;
    }
    default: return prev;
  }
  return s;
}

/** Where the coordinator wants to be (derived from the focus run, in priority order). */
export function coordinatorTarget(scene, layout) {
  const run = scene.runs[scene.focusRunId];
  const desk = (id) => layout.desks.find((d) => d.id === id);
  if (scene.inspector && !run) return { key: 'window', tile: layout.chair };
  if (!run || !ACTIVE.has(run.status)) return { key: 'chair', tile: layout.chair };
  if (run.bell && desk(run.bell)) return { key: `desk:${run.bell}`, tile: desk(run.bell).visit };
  const steps = Object.entries(run.steps);
  if (steps.some(([, x]) => x.status === 'error' || x.status === 'timeout')) return { key: 'window', tile: layout.chair };
  if (run.finally === 'running') return { key: 'archivo', tile: layout.furniture.find((f) => f.id === 'archivo')?.access || layout.chair };
  const running = steps.filter(([id, x]) => (x.status === 'running' || x.status === 'queued') && desk(id));
  const fresh = running.find(([, x]) => !x.handed);
  if (fresh) return { key: `desk:${fresh[0]}`, tile: desk(fresh[0]).visit };
  if (running.length > 1) { const lv = desk(running[0][0]).level; return { key: `hub:${lv}`, tile: layout.hubOf(lv) }; }
  if (running.length === 1) return { key: `desk:${running[0][0]}`, tile: desk(running[0][0]).visit };
  return { key: 'window', tile: layout.chair };
}

/** A stored run (GET /api/flows/:id/runs/:runId) as the messages the office would have seen, sorted by time. */
export function timelineOfRun(run) {
  if (!run) return [];
  const out = []; let n = 0;
  const push = (t, m, last = 0) => out.push({ ...m, runId: run.id, t: Number(t) || 0, _o: n++, _last: last });
  const t0 = Number(run.startedAt) || 0;
  push(t0, { type: 'run.started', trigger: run.trigger, rehearsal: !!run.rehearsal });
  for (const [key, rs] of Object.entries(run.steps || {})) {
    const evs = (rs.events || []).filter((e) => e && typeof e.t === 'number');
    const start = Number(rs.startedAt) || evs[0]?.t || t0;
    const isItem = key.includes('~');
    if (!isItem) {
      if (rs.status === 'skipped' && !rs.startedAt) { push(evs[0]?.t || start, { type: 'step.status', stepId: key, status: 'skipped' }); continue; }
      push(start, { type: 'step.status', stepId: key, status: rs.pausedWhen === 'before' ? 'paused' : rs.status === 'queued' ? 'queued' : 'running' });
    }
    for (const ev of evs) push(ev.t, { type: 'run.event', stepId: key, event: ev });
    if (!isItem && rs.status && !['running', 'paused', 'queued'].includes(rs.status)) push(Math.max(Number(rs.endedAt) || 0, evs[evs.length - 1]?.t || 0) || start, { type: 'step.status', stepId: key, status: rs.status }, 1);
    else if (!isItem && rs.status === 'paused') push(Number(rs.endedAt) || evs[evs.length - 1]?.t || start, { type: 'step.status', stepId: key, status: 'paused' });
  }
  const end = Number(run.endedAt) || out.reduce((m, x) => Math.max(m, x.t), t0);
  if (run.finally?.status) push(end - 1, { type: 'run.finally', status: run.finally.status });
  if (run.status && !ACTIVE.has(run.status)) push(end, { type: 'run.finished', status: run.status });
  out.sort((a, b) => a.t - b.t || a._last - b._last || (a.event?.seq ?? -1) - (b.event?.seq ?? -1) || a._o - b._o);
  // seq order inside the stored run is not global across steps: replay keeps time order and drops the dedup seq
  return out.map(({ _o, _last, ...m }) => (m.event ? { ...m, event: { ...m.event, seq: undefined } } : m));
}
/** How many timeline messages are due at `virtualMs` after the first one; gaps longer than maxGapMs are squeezed. */
export function replayClock(timeline, maxGapMs = 1500) {
  const marks = []; let acc = 0;
  for (let i = 0; i < timeline.length; i++) { if (i) acc += Math.min(maxGapMs, Math.max(0, timeline[i].t - timeline[i - 1].t)); marks.push(acc); }
  return { total: acc, due: (v) => { let k = 0; while (k < marks.length && marks[k] <= v) k++; return k; } };
}
const ACT_TEXT = { idle: 'en su escritorio', waiting: 'espera turno', receiving: 'recibe la carpeta', thinking: 'piensa', writing: 'redacta', typing: 'escribe', reading: 'consulta la estantería', terminal: 'trabaja en la computadora', phone: 'está al teléfono', consulting: 'consulta a un colega', 'raised-hand': 'levanta la mano (break)', storm: 'tuvo un problema', done: 'terminó', skipped: 'no le tocó', stopped: 'se detuvo' };
export const activityText = (a) => ACT_TEXT[a] || a;
/** A short text of the scene for screen readers. */
export function describeScene(scene, cast, flow) {
  const run = scene.runs[scene.focusRunId];
  if (!run) return `Oficina de «${flow?.name || ''}»: sin ejecuciones en curso.`;
  const parts = [`Ejecución ${run.ticket} ${ACTIVE.has(run.status) ? 'en curso' : run.stamp ? `terminada: ${run.stamp}` : run.status}.`];
  for (const [id, st] of Object.entries(run.steps)) {
    if (['idle', 'done', 'skipped'].includes(st.activity) && !ACTIVE.has(run.status)) continue;
    const step = flow?.steps?.find((x) => x.id === id); if (!step) continue;
    parts.push(`${cast?.get(id)?.name || step.name} (${step.name}) ${activityText(st.activity)}${st.spot === 'shelf:expedientes' ? ' Expedientes' : st.spot === 'shelf:contexto' ? ' Contexto' : ''}.`);
  }
  return parts.join(' ');
}
/** Activity → character pose. */
export function poseOf(activity, moving) {
  if (moving) return 'walk';
  return { typing: 'type', terminal: 'type', writing: 'type', reading: 'read', phone: 'phone', 'raised-hand': 'raise', storm: 'storm', waiting: 'wait', consulting: 'phone' }[activity] || 'sit';
}
