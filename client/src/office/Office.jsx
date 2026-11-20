// Spec 29 — 🏢 Oficina: a second way of SEEING the flow. Desks from the steps, a character per step, the coordinator
// walking to whoever works, computers for commands, shelves, trays and a turn display. Live from /ws (with a catch-up
// of runs already going), or replaying a stored run ("Ver la jornada"). It never edits the flow: a click opens a panel.
// Animation: one requestAnimationFrame loop moves walkers through refs, only while mounted, visible and something moves.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, onWs } from '../api.js';
import { castOf, deskSign, KIND_LABEL, COORDINATOR, autoLook } from './model.js';
import { officeLayout, iso, depth, shelfAccess, furnitureAccess, TILE_W, TILE_H } from './layout.js';
import { pathCache, pointAlong } from './path.js';
import { initialScene, officeReduce, coordinatorTarget, timelineOfRun, replayClock, describeScene, poseOf, activityText, ACTIVE } from './scene.js';
import { renderer } from './characters.jsx';
import { Box, Floor, Sign, center } from './Furniture.jsx';

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} } };
const RELEVANT = new Set(['run.started', 'step.status', 'run.event', 'run.paused', 'run.resumed', 'run.finally', 'run.finished', 'review.started', 'review.done']);
const SPEED_TILES = 3; // tiles per second
const COORD_LOOK = { skin: 1, hair: 0, hairColor: 1, top: 7, bottom: 0, accessory: 1 };

function useReducedMotion() {
  const [pref, setPref] = useState(() => ls.get('afs.office.reducedMotion')); // '1' | '0' | null (follow the system)
  const [sys, setSys] = useState(() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } });
  useEffect(() => { let mq; try { mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; } const on = () => setSys(mq.matches); mq.addEventListener?.('change', on); return () => mq.removeEventListener?.('change', on); }, []);
  const effective = pref === '1' ? true : pref === '0' ? false : sys;
  return [effective, (v) => { const x = v ? '1' : '0'; ls.set('afs.office.reducedMotion', x); setPref(x); }];
}
function bell() { try { const C = window.AudioContext || window.webkitAudioContext; const c = new C(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.15, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.6); o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.6); setTimeout(() => c.close(), 800); } catch {} }

export default function Office({ flow, selectedId, paused, onOpenStep, onOpenEdge, onOpenRun, onOpenFlowTab, onOpenReview, onBackground }) {
  const layout = useMemo(() => officeLayout(flow), [flow.steps, flow.edges]); // eslint-disable-line react-hooks/exhaustive-deps
  const cast = useMemo(() => castOf(flow), [flow.steps]);
  const names = useMemo(() => new Map([...cast].map(([id, c]) => [id, c.name])), [cast]);
  const flowRef = useRef(flow); flowRef.current = flow;
  const namesRef = useRef(names); namesRef.current = names;
  const ctx = () => ({ flow: flowRef.current, names: namesRef.current, autoRun: true });
  const [reduced, setReduced] = useReducedMotion();
  const [sound, setSoundState] = useState(() => ls.get('afs.office.sound') === '1');
  const setSound = (v) => { ls.set('afs.office.sound', v ? '1' : '0'); setSoundState(v); };
  const [showLog, setShowLog] = useState(false);

  // ---------- live scene: catch-up of runs already going, then /ws ----------
  const [scene, setScene] = useState(initialScene);
  useEffect(() => {
    let alive = true; const buffer = []; let ready = false;
    setScene(initialScene());
    const off = onWs((m) => {
      if (!m || m.flowId !== flow.id || !RELEVANT.has(m.type)) return;
      const msg = m.t ? m : { ...m, t: Date.now() };
      if (!ready) { buffer.push(msg); return; }
      setScene((s) => officeReduce(s, msg, ctx()));
    });
    (async () => {
      let s = initialScene();
      try {
        const list = await api.get(`/api/flows/${flow.id}/runs`);
        for (const r of (list || []).filter((x) => ACTIVE.has(x.status)).reverse()) {
          const run = await api.get(`/api/flows/${flow.id}/runs/${r.id}`).catch(() => null);
          if (!run) continue;
          for (const msg of timelineOfRun(run)) s = officeReduce(s, msg, ctx());
          const maxSeq = Object.values(run.steps || {}).flatMap((x) => x.events || []).reduce((m, e) => Math.max(m, e?.seq ?? -1), -1);
          if (s.runs[run.id]) s = { ...s, runs: { ...s.runs, [run.id]: { ...s.runs[run.id], lastSeq: maxSeq, status: run.status } } };
        }
      } catch {}
      if (!alive) return;
      for (const msg of buffer) {
        if (msg.type === 'step.status' && s.runs[msg.runId]) {
          const cur = s.runs[msg.runId].steps[String(msg.stepId || '').split('~')[0]]?.status;
          if (cur && (cur === msg.status || (['running', 'queued'].includes(msg.status) && cur !== 'queued'))) continue; // already in the snapshot (a queued step that starts still counts)
        }
        s = officeReduce(s, msg, ctx());
      }
      ready = true; setScene(s);
    })();
    return () => { alive = false; off(); };
  }, [flow.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- replay ("Ver la jornada") ----------
  const [replay, setReplay] = useState(null); // {runId, timeline, clock, speed, v, i, scene, playing}
  const [runsList, setRunsList] = useState(null);
  const openReplay = async () => { try { const l = await api.get(`/api/flows/${flow.id}/runs`); setRunsList((l || []).filter((r) => !ACTIVE.has(r.status))); } catch { setRunsList([]); } };
  const startReplay = async (runId, speed = 8) => {
    const run = await api.get(`/api/flows/${flow.id}/runs/${runId}`).catch(() => null);
    if (!run) return;
    const timeline = timelineOfRun(run);
    setRunsList(null);
    setReplay({ runId, ticket: `A${String(runId).replace(/[^a-z0-9]/gi, '').slice(-3).toUpperCase()}`, timeline, clock: replayClock(timeline), speed, v: 0, i: 0, scene: initialScene(), playing: true });
  };
  useEffect(() => {
    if (!replay?.playing) return undefined;
    const iv = setInterval(() => setReplay((r) => {
      if (!r || !r.playing) return r;
      const v = r.v + 100 * r.speed; const due = r.clock.due(v);
      let sc = r.scene; for (let k = r.i; k < due; k++) sc = officeReduce(sc, r.timeline[k], ctx());
      return { ...r, v, i: due, scene: sc, playing: due < r.timeline.length };
    }), 100);
    return () => clearInterval(iv);
  }, [replay?.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = replay ? replay.scene : scene;
  const run = shown.runs[shown.focusRunId] || null;

  // ---------- sounds (off by default): the bell on a break or an error ----------
  const bellKey = run ? `${run.runId}:${run.bell || ''}:${Object.values(run.steps).filter((x) => x.status === 'error').length}` : '';
  const lastBell = useRef('');
  useEffect(() => { if (sound && !replay && bellKey && bellKey !== lastBell.current && (run?.bell || /:[1-9]/.test(bellKey))) bell(); lastBell.current = bellKey; }, [bellKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- walkers: where everybody wants to be ----------
  const deskOf = (id) => layout.desks.find((d) => d.id === id);
  const targets = {};
  const coord = coordinatorTarget(shown, layout);
  targets.coordinator = coord;
  for (const d of layout.desks) {
    const st = run?.steps[d.id];
    const spot = st && ACTIVE.has(run.status) ? st.spot : 'seat';
    targets[`step:${d.id}`] = spot.startsWith('shelf:') ? { key: spot, tile: shelfAccess(layout, spot.slice(6), d.room) } : { key: 'seat', tile: d.seat };
  }
  const walkers = useRef(new Map()); // key → {pos:{gx,gy}, from, path, dist, targetKey, tile, el}
  const cachePath = useMemo(() => pathCache(layout), [layout]);
  const [animating, setAnimating] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => { const on = () => setHidden(document.hidden); document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, []);
  // apply new targets (every render): a new target starts a walk, or a jump with reduced motion
  for (const [key, t] of Object.entries(targets)) {
    let w = walkers.current.get(key);
    if (!w) { w = { pos: { ...t.tile }, path: null, dist: 0, targetKey: t.key, tile: t.tile }; walkers.current.set(key, w); continue; }
    if (w.targetKey === t.key && w.tile.gx === t.tile.gx && w.tile.gy === t.tile.gy) continue;
    w.targetKey = t.key; w.tile = t.tile;
    const from = { gx: Math.round(w.pos.gx), gy: Math.round(w.pos.gy) };
    const path = reduced ? null : cachePath(from, t.tile);
    if (!path || !path.length) { w.pos = { ...t.tile }; w.path = null; } else { w.from = from; w.path = path; w.dist = 0; }
  }
  for (const key of [...walkers.current.keys()]) if (!(key in targets)) walkers.current.delete(key);
  const moving = [...walkers.current.values()].some((w) => w.path);
  const rafRef = useRef(0);
  useEffect(() => {
    if (!moving || hidden) { setAnimating(false); return undefined; }
    setAnimating(true);
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      let any = false;
      for (const w of walkers.current.values()) {
        if (!w.path) continue;
        w.dist += dt * SPEED_TILES * (replay ? Math.min(4, replay.speed / 2) : 1);
        const p = pointAlong(w.from, w.path, w.dist);
        w.pos = { gx: p.gx, gy: p.gy };
        if (p.done) { w.path = null; w.pos = { ...w.tile }; } else any = true;
        if (w.el) {
          const c = center(w.pos.gx, w.pos.gy);
          w.el.setAttribute('transform', `translate(${c.x},${c.y})`);
          w.el.setAttribute('data-tile', `${Math.round(w.pos.gx)},${Math.round(w.pos.gy)}`);
          w.el.setAttribute('data-moving', w.path ? '1' : '0');
        }
      }
      if (any) rafRef.current = requestAnimationFrame(tick); else { setAnimating(false); forceRender((n) => n + 1); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [moving, hidden, reduced, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, forceRender] = useState(0);
  const [frame, setFrame] = useState(0);
  useEffect(() => { if (reduced || hidden || !run || !ACTIVE.has(run.status)) return undefined; const iv = setInterval(() => setFrame((f) => (f + 1) % 4), 350); return () => clearInterval(iv); }, [reduced, hidden, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- geometry ----------
  const corners = [iso(0, 0), iso(layout.cols, 0), iso(layout.cols, layout.rows), iso(0, layout.rows)];
  const minX = Math.min(...corners.map((p) => p.x)) - 40; const maxX = Math.max(...corners.map((p) => p.x)) + 40;
  const minY = -120; const maxY = Math.max(...corners.map((p) => p.y)) + 40;
  const stepById = new Map(flow.steps.map((s) => [s.id, s]));
  const key = (e, fn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); } };
  const btn = (label, fn) => ({ role: 'button', tabIndex: 0, 'aria-label': label, onClick: (e) => { e.stopPropagation(); fn(); }, onKeyDown: (e) => key(e, fn) });
  const others = shown.order.filter((id) => id !== shown.focusRunId && ACTIVE.has(shown.runs[id]?.status)).slice(-5);
  const drill = !!run?.rehearsal;
  const summary = describeScene(shown, cast, flow);
  const [liveText, setLiveText] = useState(summary);
  useEffect(() => { const t = setTimeout(() => setLiveText(summary), 600); return () => clearTimeout(t); }, [summary]);

  const statusOf = (id) => run?.steps[id]?.status || (run ? 'idle' : stepById.get(id)?.lastRun?.status || 'idle');
  const activityOf = (id) => (run && ACTIVE.has(run.status) ? run.steps[id]?.activity || 'idle' : run?.steps[id]?.activity === 'storm' ? 'storm' : 'idle');

  const floorRooms = Array.from({ length: layout.rooms }, (_, r) => <Floor key={r} gx={0} gy={r * layout.roomH} w={layout.cols} h={layout.roomH} className={`office-floor${r % 2 ? ' alt' : ''}`} />);
  const edgeLines = flow.edges.map((e) => {
    const a = deskOf(e.source); const b = deskOf(e.target); if (!a || !b) return null;
    const p = center(a.visit.gx, a.visit.gy); const q = center(b.seat.gx, b.seat.gy);
    const hot = run && (run.steps[e.source]?.status === 'success') && ACTIVE.has(run.status);
    return (
      <g key={e.id} data-testid="office-edge" data-edge={e.id} className={`office-edge${hot ? ' hot' : ''}`} {...btn(`Flecha de ${stepById.get(e.source)?.name} a ${stepById.get(e.target)?.name}`, () => onOpenEdge(e.id))}>
        <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="office-edge-hit" />
        <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="office-edge-line" />
      </g>
    );
  });

  // static furniture and desks, sorted by depth (back to front)
  const items = [];
  for (const f of layout.furniture) {
    const d = depth(f.gx + f.w - 1, f.gy + f.h - 1);
    if (f.shelf) {
      const label = { contexto: 'Contexto', memoria: 'Memoria', expedientes: 'Expedientes' }[f.shelf];
      const open = () => (f.shelf === 'memoria' ? onOpenFlowTab('memory') : f.shelf === 'expedientes' ? onOpenRun(null) : onOpenFlowTab('settings'));
      items.push([d, <g key={f.id} data-testid={`office-shelf-${f.shelf}`} className="office-item" {...btn(`Estantería ${label}`, open)}>
        <Box gx={f.gx} gy={f.gy} w={f.w} h={f.h} height={46} top="var(--office-shelf-top)" left="var(--office-shelf)" right="var(--office-shelf-dark)" />
        {[0, 1, 2].map((k) => { const a = iso(f.gx + 0.2, f.gy + 1); return <rect key={k} x={a.x - 6 + k * 14} y={a.y - 38 + k * 2} width="10" height="12" className={`office-binder b${k}`} />; })}
        <Sign gx={f.gx} gy={f.gy} w={f.w} h={f.h} dy={-56}>{label}</Sign>
      </g>]);
    } else if (f.id === 'window') {
      const bellOn = !!run?.bell;
      items.push([d, <g key={f.id} data-testid="office-window" data-bell={bellOn ? '1' : '0'} className="office-item" {...btn(bellOn ? 'Ventanilla: hay un break esperando tu revisión' : 'Ventanilla del coordinador', () => (bellOn && paused ? onOpenReview() : onOpenRun(shown.focusRunId)))}>
        <Box gx={f.gx} gy={f.gy} w={f.w} h={f.h} height={34} top="var(--office-counter-top)" />
        <Sign gx={f.gx} gy={f.gy} w={f.w} h={f.h} dy={-46}>{bellOn ? '🔔 Ventanilla' : 'Ventanilla'}</Sign>
      </g>]);
    } else if (f.id === 'display') {
      items.push([d, <g key={f.id} data-testid="office-display" data-ticket={run && ACTIVE.has(run.status) ? run.ticket : ''} className="office-item" {...btn(`Turno ${run?.ticket || '—'}`, () => onOpenRun(shown.focusRunId))}>
        <Box gx={f.gx} gy={f.gy} height={58} top="#111827" left="#0b1220" right="#111827" />
        <text className="office-display-text" x={iso(f.gx + 0.5, f.gy + 0.5).x} y={iso(f.gx + 0.5, f.gy + 0.5).y - 44} textAnchor="middle">{run && ACTIVE.has(run.status) ? run.ticket : '—'}</text>
      </g>]);
    } else if (f.id === 'entrada' || f.id === 'salida') {
      const stamp = f.id === 'salida' ? run?.stamp || '' : '';
      items.push([d, <g key={f.id} data-testid={`office-${f.id}`} data-stamp={stamp} className="office-item" {...btn(f.id === 'entrada' ? 'Bandeja de Entrada (lo que recibe el flujo)' : `Bandeja de Salida${stamp ? `: ${stamp}` : ''}`, () => onOpenRun(shown.focusRunId))}>
        <Box gx={f.gx} gy={f.gy} height={14} top="var(--office-tray)" />
        <Sign gx={f.gx} gy={f.gy} dy={-24}>{f.id === 'entrada' ? 'Entrada' : 'Salida'}</Sign>
        {stamp && <text className={`office-stamp ${stamp === 'APROBADO' ? 'ok' : 'bad'}`} x={iso(f.gx + 0.5, f.gy + 0.5).x} y={iso(f.gx + 0.5, f.gy + 0.5).y - 34} textAnchor="middle">{stamp}</text>}
      </g>]);
    } else if (f.id === 'archivo') {
      items.push([d, <g key={f.id} data-testid="office-archivo" data-finally={run?.finally || ''} className="office-item" {...btn('Archivo ("Al terminar" y entregables)', () => onOpenFlowTab('settings'))}>
        <Box gx={f.gx} gy={f.gy} w={f.w} h={f.h} height={40} top="var(--office-shelf-top)" left="var(--office-shelf)" right="var(--office-shelf-dark)" />
        <Sign gx={f.gx} gy={f.gy} w={f.w} h={f.h} dy={-50}>Archivo</Sign>
      </g>]);
    }
  }
  for (const desk of layout.desks) {
    const s = stepById.get(desk.id); if (!s) continue;
    const c = cast.get(desk.id); const st = run?.steps[desk.id];
    const status = statusOf(desk.id); const activity = activityOf(desk.id);
    const walker = walkers.current.get(`step:${desk.id}`);
    const away = walker && (walker.path || walker.targetKey !== 'seat');
    const a = iso(desk.gx + 1, desk.gy + 0.5);
    const isCmd = s.kind === 'command';
    const comp = run?.computers[desk.id] || (isCmd ? (status === 'error' ? 'err' : status === 'success' ? 'ok' : 'idle') : null);
    const seat = center(desk.seat.gx, desk.seat.gy);
    const label = `${c?.name} · ${s.name} (${KIND_LABEL[s.kind] || s.kind}): ${activityText(activity)}`;
    items.push([depth(desk.seat.gx, desk.seat.gy), <g key={desk.id} data-testid="office-desk" data-step={desk.id} data-activity={activity} data-status={status} data-name={c?.name}
      className={`office-desk${selectedId === desk.id ? ' selected' : ''} st-${status}`} {...btn(label, () => onOpenStep(desk.id))}>
      <Box gx={desk.gx} gy={desk.gy} w={2} h={1} height={20} top={selectedId === desk.id ? 'var(--office-desk-sel)' : 'var(--office-desk-top)'} left="var(--office-desk)" right="var(--office-desk-dark)" />
      {isCmd ? (
        <g data-testid="office-computer" data-state={comp} className={`office-computer ${comp}`}>
          <rect x={a.x - 16} y={a.y - 48} width="32" height="22" rx="2" className="office-screen" />
          <text x={a.x} y={a.y - 34} textAnchor="middle" className="office-screen-text">{comp === 'err' ? '✗ error' : comp === 'ok' ? '✓ ok' : `> ${String(s.command || '').slice(0, 9)}`}</text>
        </g>
      ) : <rect x={a.x - 8} y={a.y - 28} width="16" height="5" className="office-papers" />}
      {s.kind === 'flow' && <text x={a.x} y={a.y - 30} textAnchor="middle">☎</text>}
      {!away && <g transform={`translate(${seat.x},${seat.y})`} className={`office-person${drill ? ' drill' : ''}`} data-testid="office-person" data-activity={activity}>{renderer.render({ look: c.look, pose: poseOf(activity, false), frame, drill })}</g>}
      <Sign gx={desk.gx} gy={desk.gy} w={2} h={1} dy={-60} className="office-desk-sign">{deskSign(s)}</Sign>
      <Sign gx={desk.gx} gy={desk.gy} w={2} h={1} dy={-48} className="office-name">{c?.name}{s.coordinator ? ' 🧭' : ''}</Sign>
      {st?.locked && <text x={a.x + 22} y={a.y - 18}>🔒</text>}
      {st?.item && <text x={a.x - 30} y={a.y - 18} className="office-item-badge">{st.item.i}/{st.item.total}</text>}
      {!run && s.lastRun?.status && <text x={a.x + 24} y={a.y - 28} className={`office-last ${s.lastRun.status}`}>{s.lastRun.status === 'success' ? '✓' : s.lastRun.status === 'error' ? '✗' : '·'}</text>}
    </g>]);
  }
  items.sort((x, y) => x[0] - y[0]);

  // walkers: the coordinator, people away from their seat
  const walkerEls = [];
  const placeWalker = (k, content, extra) => {
    const w = walkers.current.get(k); if (!w) return;
    const c = center(w.pos.gx, w.pos.gy);
    walkerEls.push([w.pos.gx + w.pos.gy, <g key={k} ref={(el) => { w.el = el; }} transform={`translate(${c.x},${c.y})`} data-tile={`${Math.round(w.pos.gx)},${Math.round(w.pos.gy)}`} data-moving={w.path ? '1' : '0'} {...extra}>{content(!!w.path)}</g>]);
  };
  placeWalker('coordinator', (mv) => renderer.render({ look: COORD_LOOK, pose: mv ? 'walk' : coord.key === 'chair' ? 'sit' : 'stand', frame, drill, coordinator: true }),
    { 'data-testid': 'office-coordinator', 'data-target': coord.key, className: 'office-walker', ...btn(`${COORDINATOR}, coordinador`, () => onOpenRun(shown.focusRunId)) });
  for (const desk of layout.desks) {
    const w = walkers.current.get(`step:${desk.id}`);
    if (!w || (!w.path && w.targetKey === 'seat')) continue;
    const c = cast.get(desk.id); const activity = activityOf(desk.id);
    placeWalker(`step:${desk.id}`, (mv) => renderer.render({ look: c.look, pose: poseOf(activity, mv), frame, drill }),
      { 'data-testid': 'office-walker', 'data-step': desk.id, 'data-activity': activity, className: `office-walker${drill ? ' drill' : ''}`, ...btn(`${c.name}: ${activityText(activity)}`, () => onOpenStep(desk.id)) });
  }
  walkerEls.sort((x, y) => x[0] - y[0]);

  // bubbles (over everything)
  const bubbles = [];
  if (run && ACTIVE.has(run.status)) for (const desk of layout.desks) {
    const st = run.steps[desk.id]; if (!st?.bubble) continue;
    const w = walkers.current.get(`step:${desk.id}`); const p = w ? center(w.pos.gx, w.pos.gy) : center(desk.seat.gx, desk.seat.gy);
    const text = String(st.bubble).slice(0, 28);
    bubbles.push(<g key={desk.id} className="office-bubble" transform={`translate(${p.x},${p.y - 66})`}><rect x={-(text.length * 3.4) - 6} y="-12" width={text.length * 6.8 + 12} height="18" rx="9" /><text textAnchor="middle" y="1">{text}</text></g>);
  }
  // the queue: other runs going at the same time, waiting with their ticket
  const queue = others.map((id, i) => { const t = layout.queue[i]; const p = center(t.gx, t.gy); return <g key={id} transform={`translate(${p.x},${p.y})`} data-testid="office-queue-person" data-ticket={shown.runs[id].ticket} className="office-item" {...btn(`Turno ${shown.runs[id].ticket} esperando`, () => onOpenRun(id))}>{renderer.render({ look: autoLook(id), pose: 'wait', frame })}<text y="-54" textAnchor="middle" className="office-ticket">{shown.runs[id].ticket}</text></g>; });

  return (
    <div className={`office${reduced ? ' reduced' : ''}${hidden ? ' paused' : ''}`} data-testid="office" data-mode={replay ? 'replay' : 'live'} data-reduced-motion={reduced ? '1' : '0'} data-animating={animating && !hidden ? '1' : '0'} data-run={run?.ticket || ''} data-drill={drill ? '1' : '0'}>
      <div className="office-toolbar">
        <button className="ghost small" data-testid="office-replay-btn" onClick={openReplay} title="Repetir una ejecución pasada en cámara rápida">▶ Ver la jornada</button>
        <label className="toggle small" title="Sin desplazamientos ni animaciones"><input type="checkbox" data-testid="office-reduced" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Movimiento reducido</label>
        <label className="toggle small" title="La campana de la ventanilla en un break o un error"><input type="checkbox" data-testid="office-sound" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sonido</label>
        <button className="ghost small" data-testid="office-log-btn" onClick={() => setShowLog((v) => !v)}>📜 Bitácora</button>
      </div>
      {runsList && (
        <div className="office-replay-pick">
          <select data-testid="office-replay-run" defaultValue="" onChange={(e) => e.target.value && startReplay(e.target.value, Number(document.querySelector('[data-testid="office-replay-speed"]')?.value) || 8)}>
            <option value="">{runsList.length ? 'Elegí una ejecución…' : 'No hay ejecuciones terminadas'}</option>
            {runsList.map((r) => <option key={r.id} value={r.id}>{`A${String(r.id).replace(/[^a-z0-9]/gi, '').slice(-3).toUpperCase()} · ${new Date(r.startedAt).toLocaleString()} · ${r.status}`}</option>)}
          </select>
          <select data-testid="office-replay-speed" defaultValue="8">{[1, 4, 8, 16].map((x) => <option key={x} value={x}>{x}×</option>)}</select>
          <button className="ghost small" onClick={() => setRunsList(null)}>✕</button>
        </div>
      )}
      {replay && (
        <div className="office-replay-bar" data-testid="office-replay-bar">
          Repetición de {replay.ticket} · {replay.speed}× {replay.playing ? '' : '· terminada'}
          <button className="ghost small" onClick={() => setReplay((r) => r && { ...r, playing: !r.playing && r.i < r.timeline.length })}>{replay.playing ? '⏸' : '▶'}</button>
          <button className="ghost small" data-testid="office-replay-stop" onClick={() => setReplay(null)}>✕ Volver al vivo</button>
        </div>
      )}
      <div className="office-scroll" onClick={onBackground}>
        <svg className="office-svg" viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} width="100%" height="100%" style={{ minWidth: Math.min(maxX - minX, 2400) * 0.55, minHeight: Math.min(maxY - minY, 2000) * 0.55 }} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Oficina del flujo «${flow.name}»`}>
          <g>{floorRooms}</g>
          <g className="office-edges">{edgeLines}</g>
          <g>{items.map((x) => x[1])}</g>
          <g>{queue}</g>
          <g>{walkerEls.map((x) => x[1])}</g>
          <g className="office-bubbles">{bubbles}</g>
          {!run && <g className="office-idle"><text x={iso(1.5, 3.5).x} y={iso(1.5, 3.5).y} textAnchor="middle" className="office-steam">☕</text></g>}
          {layout.overflow > 0 && <text x={iso(layout.cols - 4, 1).x} y={iso(layout.cols - 4, 1).y - 60} className="office-sign">+{layout.overflow} más · ver en 🔲 Cajas</text>}
        </svg>
      </div>
      <div className="sr-only" aria-live="polite" data-testid="office-summary">{liveText}</div>
      {showLog && (
        <div className="office-log small" data-testid="office-log">
          {shown.log.length ? shown.log.slice().reverse().map((l, i) => <div key={`${l.t}-${i}`}>{l.text}</div>) : <div className="muted">Todavía no pasó nada en esta oficina.</div>}
        </div>
      )}
      <div className="office-log-hidden" data-testid="office-log-text" hidden>{shown.log.map((l) => l.text).join('\n')}</div>
    </div>
  );
}
