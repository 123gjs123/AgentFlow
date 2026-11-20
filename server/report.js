// 📋 Informe de una ejecución: qué pasó, por qué terminó así, cada step con su motivo, avisos, "Al terminar" y entregables.
// Markdown armado solo con lo guardado de la ejecución (sin IA, sin red): siempre disponible, también para las viejas.
// Los secretos ya están tapados en lo guardado (las salidas pasan por maskSecrets al ejecutar).

const STATUS = { success: '✅ completa', error: '❌ con error', stopped: '■ detenida', timeout: '⏱ se le acabó el tiempo', interrupted: '⚠ interrumpida (reinicio)', running: '▶ en curso', paused: '⏸ en pausa (break)' };
const STEP = { success: '✅ ok', error: '❌ error', skipped: '⏭ no corrió', stopped: '■ detenido', timeout: '⏱ tiempo', interrupted: '⚠ interrumpido', running: '▶ corriendo', paused: '⏸ en break', queued: '⏳ en cola', pending: '· pendiente' };
const SKIP = {
  upstream_failed: 'no corrió porque falló un paso anterior',
  not_routed: 'el Coordinador no lo eligió para esta ejecución',
  condition: 'la condición de su flecha no se cumplió',
  empty: 'no recibió datos',
  pinned: 'usó su salida fijada',
  hook: 'lo salteó un hook',
  rehearsal: 'ensayo: no se ejecuta',
};
const CODE = {
  EXIT_NONZERO: 'el comando terminó con error',
  PERMISSION_DENIED: 'Claude intentó usar una herramienta que el step no tiene permitida',
  MCP_UNAVAILABLE: 'faltó un conector (MCP) que el step necesita',
  CREDENTIAL_MISSING: 'falta una credencial',
  INVALID_JSON: 'la salida no era el JSON pedido',
  SCHEMA_MISMATCH: 'la salida no cumple el formato pedido',
  TIMEOUT: 'se le acabó el tiempo',
  STOPPED: 'se detuvo a mano',
  INTERRUPTED: 'el servidor se reinició en medio',
  QUARANTINED: 'el flujo está en revisión',
  CWD_MISSING: 'no existe el directorio de trabajo',
  HOOK_ERROR: 'falló un hook del step',
  ASSERTION_FAILED: 'no pasó una verificación del step',
};
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const cell = (s) => clip(String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|'), 220);
const fence = (s) => `\`\`\`\n${String(s ?? '').replace(/```/g, "'''")}\n\`\`\``;
const dur = (a, b) => { if (!a || !b) return ''; const s = Math.round((b - a) / 1000); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
const when = (t) => (t ? new Date(t).toLocaleString('es-AR', { hour12: false }) : '');
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[#`|-]+$/.test(l)) || '';

/** The run's report as Markdown. `ticket` is the turn label shown in the office (A + 3 digits). */
export function runReport(flow, run, { ticket } = {}) {
  const name = (id) => flow.steps.find((s) => s.id === id)?.name || id;
  const keys = Object.keys(run.steps || {}).filter((k) => !k.includes('~'));
  // the steps that ran, in the order they started; then the ones that did not run, in the flow's order
  const flowOrder = flow.steps.map((s) => s.id).filter((id) => keys.includes(id)).concat(keys.filter((k) => !flow.steps.some((s) => s.id === k)));
  const ran = flowOrder.filter((k) => run.steps[k].startedAt).sort((a, b) => run.steps[a].startedAt - run.steps[b].startedAt);
  const order = [...ran, ...flowOrder.filter((k) => !run.steps[k].startedAt)];
  const steps = order.map((id) => ({ id, ...run.steps[id] }));
  const failed = steps.filter((s) => ['error', 'timeout', 'stopped', 'interrupted'].includes(s.status)).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  const skippedBy = steps.filter((s) => s.status === 'skipped' && s.skipReason === 'upstream_failed').length;
  const out = [];
  out.push(`# Informe de ejecución${ticket ? ` ${ticket}` : ''} — «${flow.name}»`, '');
  out.push(`- **Resultado:** ${STATUS[run.status] || run.status}`);
  out.push(`- **Cuándo:** ${when(run.startedAt)}${run.endedAt ? ` → ${when(run.endedAt)} (${dur(run.startedAt, run.endedAt)})` : ''}`);
  out.push(`- **Disparada por:** ${run.trigger || 'manual'}${run.rehearsal ? ' (ensayo)' : ''} · id \`${run.id}\``);
  if (String(run.input || '').trim()) out.push(`- **Entrada:** ${cell(run.input)}`);
  out.push('');
  out.push('## Por qué terminó así', '');
  if (!failed.length && run.status === 'success') out.push('Todos los pasos que tocaban terminaron bien.');
  else if (!failed.length) out.push(run.error ? clip(run.error, 800) : `La ejecución quedó ${STATUS[run.status] || run.status}.`);
  for (const s of failed.slice(0, 3)) {
    out.push(`**Se cortó en «${name(s.id)}»** — ${CODE[s.code] || s.code || s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}.`);
    if (s.error) out.push('', fence(clip(s.error, 1500)));
    const tail = String(s.output || '').trim().split(/\r?\n/).slice(-12).join('\n');
    if (tail && !String(s.error || '').includes(tail.slice(0, 80))) out.push('', 'Lo último que mostró:', '', fence(clip(tail, 1500)));
    out.push('');
  }
  if (skippedBy) out.push(`Por eso **${skippedBy} paso(s)** no corrieron (dependían de ese resultado). Cuando se corrija, se puede volver a ejecutar desde el paso que falló.`, '');
  out.push('## Paso por paso', '', '| # | Paso | Estado | Duración | Detalle |', '|---|---|---|---|---|');
  steps.forEach((s, i) => {
    const detail = s.status === 'skipped' ? (SKIP[s.skipReason] || s.skipReason || '')
      : s.error ? `${CODE[s.code] || s.code || ''}: ${firstLine(s.error)}`
        : firstLine(s.output);
    out.push(`| ${i + 1} | ${cell(name(s.id))} | ${STEP[s.status] || s.status} | ${dur(s.startedAt, s.endedAt)} | ${cell(detail)} |`);
  });
  out.push('');
  const warns = steps.flatMap((s) => [...(s.warnings || []).map((w) => `«${name(s.id)}»: ${w}`), ...(s.denials || []).map((d) => `«${name(s.id)}»: herramienta denegada ${d.tool}`)]);
  if (warns.length) { out.push('## Avisos', '', ...[...new Set(warns)].slice(0, 30).map((w) => `- ${clip(w, 300)}`), ''); }
  if (run.finally) {
    out.push('## Al terminar', '', `${run.finally.status === 'success' ? '✅' : '⚠'} ${run.finally.status}${run.finally.exitCode != null ? ` (exit ${run.finally.exitCode})` : ''}`);
    if (run.finally.output) out.push('', fence(clip(run.finally.output, 3000)));
    if (run.finally.error) out.push('', fence(clip(run.finally.error, 1500)));
    out.push('');
  }
  const files = steps.flatMap((s) => (s.deliverables || []).map((d) => `- ${name(s.id)}: ${d.name}`));
  if (files.length) out.push('## Entregables', '', ...files, '');
  const outputs = steps.filter((s) => s.status === 'success' && String(s.output || '').trim());
  if (outputs.length) {
    out.push('## Salidas', '');
    for (const s of outputs) out.push(`<details><summary>${name(s.id).replace(/[<>&]/g, '')}</summary>`, '', fence(clip(s.output, 6000)), '', '</details>', '');
  }
  return out.join('\n');
}
