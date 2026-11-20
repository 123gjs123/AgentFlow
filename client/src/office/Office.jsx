// Spec 29 — 🏢 Oficina: a second way of SEEING the flow. Desks from the steps, a character per step, the coordinator
// walking to whoever works, computers for commands, shelves, trays and a turn display. Live from /ws (with a catch-up
// of runs already going), or replaying a stored run ("Ver la jornada"). It never edits the flow: a click opens a panel.
// Animation: one requestAnimationFrame loop moves walkers through refs, only while mounted, visible and something moves.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, onWs } from '../api.js';
import { castOf, deskSign, KIND_LABEL, COORDINATOR, autoLook } from './model.js';
import { officeLayout, depth, shelfAccess } from './layout.js';
import { pathCache, pointAlong } from './path.js';
import { ticketOf, initialScene, officeReduce, coordinatorTarget, timelineOfRun, replayClock, describeScene, poseOf, activityText, ACTIVE } from './scene.js';
import { renderer } from './characters.jsx';
import { P, center, OfficeDefs, Room, DeskBase, DeskTop, ShelfPiece, FilingPiece, CounterBase, CounterTop, TurnDisplay, KioskPiece, WaitingChairs, WaitingBacks, TrayPiece, DecorPiece, Partition, OfficeChair, HalfWall, Plaque } from './Furniture.jsx';
const WALLTOP = 130;

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} } };
const RELEVANT = new Set(['run.started', 'step.status', 'run.event', 'run.paused', 'run.resumed', 'run.finally', 'run.finished', 'review.started', 'review.done']);
const SPEED_TILES = 3; // tiles per second
const COORD_LOOK = { skin: 1, hair: 0, hairColor: 1, top: 8, bottom: 0, accessory: 2 }; // navy blazer, headset

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
  const scrollRef = useRef(null);
  const [zoom, setZoomState] = useState(() => Number(ls.get('afs.office.zoom')) || 1);
  useEffect(() => { const el = scrollRef.current; if (!el) return; el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; }, [zoom, layout.hash]); // eslint-disable-line react-hooks/exhaustive-deps
  const setZoom = (z) => { const v = Math.min(2.5, Math.max(1, Math.round(z * 100) / 100)); ls.set('afs.office.zoom', String(v)); setZoomState(v); };

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
    setReplay({ runId, ticket: ticketOf(runId), timeline, clock: replayClock(timeline), speed, v: 0, i: 0, scene: initialScene(), playing: true });
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
  const corners = [P(0, 0, WALLTOP), P(layout.cols, 0, WALLTOP), P(layout.cols, layout.rows), P(0, layout.rows), P(0, 0, WALLTOP)];
  const minX = Math.min(...corners.map((p) => p.x)) - 30; const maxX = Math.max(...corners.map((p) => p.x)) + 30;
  const minY = Math.min(...corners.map((p) => p.y)) - 40; const maxY = Math.max(...corners.map((p) => p.y)) + 40;
  const stepById = new Map(flow.steps.map((s) => [s.id, s]));
  const key = (e, fn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); } };
  const btn = (label, fn) => ({ role: 'button', tabIndex: 0, 'aria-label': label, onClick: (e) => { e.stopPropagation(); fn(); }, onKeyDown: (e) => key(e, fn) });
  const others = shown.order.filter((id) => id !== shown.focusRunId && ACTIVE.has(shown.runs[id]?.status)).slice(-3);
  const drill = !!run?.rehearsal;
  const summary = describeScene(shown, cast, flow);
  const [liveText, setLiveText] = useState(summary);
  useEffect(() => { const t = setTimeout(() => setLiveText(summary), 600); return () => clearTimeout(t); }, [summary]);

  const statusOf = (id) => run?.steps[id]?.status || (run ? 'idle' : stepById.get(id)?.lastRun?.status || 'idle');
  const activityOf = (id) => (run && ACTIVE.has(run.status) ? run.steps[id]?.activity || 'idle' : run?.steps[id]?.activity === 'storm' ? 'storm' : 'idle');
  const moodOf = (id) => (statusOf(id) === 'success' && run ? 'happy' : undefined);
  const pipOf = (status) => ({ running: 'running', queued: 'running', paused: 'running', success: 'ok', error: 'err', timeout: 'err', skipped: 'skip' }[status] || 'idle');

  const rooms = Array.from({ length: layout.rooms }, (_, r) => <Room key={r} room={r} cols={layout.cols} gy0={r * layout.roomH} rows={layout.roomH} tall={r === 0} lastRoom={r === layout.rooms - 1} />);
  // arrows on the floor: along the aisles with one elbow (never across the desks)
  const edgeLines = flow.edges.map((e) => {
    const a = deskOf(e.source); const b = deskOf(e.target); if (!a || !b) return null;
    const p = center(a.visit.gx, a.visit.gy); const m = center(b.visit.gx, a.visit.gy); const q = center(b.visit.gx, b.visit.gy);
    const hot = run && (run.steps[e.source]?.status === 'success') && ACTIVE.has(run.status);
    const d = `M${p.x} ${p.y} L${m.x} ${m.y} L${q.x} ${q.y}`;
    return (
      <g key={e.id} data-testid="office-edge" data-edge={e.id} className={`office-edge${hot ? ' hot' : ''}`} {...btn(`Flecha de ${stepById.get(e.source)?.name} a ${stepById.get(e.target)?.name}`, () => onOpenEdge(e.id))}>
        <path d={d} className="office-edge-hit" />
        <path d={d} className="office-edge-line" />
        <circle cx={q.x} cy={q.y} r="3.5" className="office-edge-dot" />
      </g>
    );
  });

  // everything that stands on the floor, sorted back to front; labels go in their own layer above (never covered)
  const items = []; const labels = [];
  const tickets = [run && ACTIVE.has(run.status) ? run.ticket : null, ...others.map((id) => shown.runs[id].ticket)].filter(Boolean);
  const coordWalker = walkers.current.get('coordinator');
  const coordSeated = coordWalker && !coordWalker.path && coordWalker.targetKey === 'chair';
  for (const f of layout.furniture) {
    const d = depth(f.gx + Math.max(1, f.w) - 1, f.gy + Math.max(1, f.h) - 1);
    if (f.shelf) {
      const label = { contexto: 'CONTEXTO', memoria: 'MEMORIA', expedientes: 'EXPEDIENTES' }[f.shelf];
      const open = () => (f.shelf === 'memoria' ? onOpenFlowTab('memory') : f.shelf === 'expedientes' ? onOpenRun(null) : onOpenFlowTab('settings'));
      items.push([d, <g key={f.id} data-testid={`office-shelf-${f.shelf}`} className="office-item" {...btn(`Estantería ${label}`, open)}><ShelfPiece gx={f.gx} gy={f.gy} w={f.w} label={label} variant={{ contexto: 0, memoria: 1, expedientes: 2 }[f.shelf]} /></g>]);
    } else if (f.id === 'window') {
      const bellOn = !!run?.bell;
      const chairAt = P(f.gx + 0.75, f.gy - 0.05);
      items.push([d, <g key={f.id} data-testid="office-window" data-bell={bellOn ? '1' : '0'} className={`office-item${bellOn ? ' ringing' : ''}`} {...btn(bellOn ? 'Ventanilla: hay un break esperando tu revisión' : 'Ventanilla del coordinador', () => (bellOn && paused ? onOpenReview() : onOpenRun(shown.focusRunId)))}>
        <OfficeChair x={chairAt.x} y={chairAt.y} color="#2d3340" />
        {coordSeated && <g transform={`translate(${chairAt.x},${chairAt.y})`} pointerEvents="none">{renderer.render({ look: COORD_LOOK, pose: 'type', frame, drill, coordinator: true, part: 'body' })}</g>}
        <CounterBase gx={f.gx} gy={f.gy} w={f.w} />
        {coordSeated && <g transform={`translate(${chairAt.x},${chairAt.y})`} pointerEvents="none">{renderer.render({ look: COORD_LOOK, pose: 'type', frame, drill, coordinator: true, part: 'front' })}</g>}
        <CounterTop gx={f.gx} gy={f.gy} w={f.w} bell={bellOn} id={flow.id} />
      </g>]);
    } else if (f.id === 'display') {
      items.push([-100, <g key={f.id} data-testid="office-display" data-ticket={run && ACTIVE.has(run.status) ? run.ticket : ''} className="office-item" {...btn(`Turno ${run?.ticket || '—'}`, () => onOpenRun(shown.focusRunId))}><TurnDisplay gy={f.gy} tickets={tickets} /></g>]);
    } else if (f.id === 'entrada' || f.id === 'salida') {
      const stamp = f.id === 'salida' ? run?.stamp || '' : '';
      items.push([d, <g key={f.id} data-testid={`office-${f.id}`} data-stamp={stamp} className="office-item" {...btn(f.id === 'entrada' ? 'Bandeja de Entrada (lo que recibe el flujo)' : `Bandeja de Salida${stamp ? `: ${stamp}` : ''}`, () => onOpenRun(shown.focusRunId))}><TrayPiece gx={f.gx} gy={f.gy} label={f.id === 'entrada' ? 'ENTRADA' : 'SALIDA'} stamp={stamp} /></g>]);
    } else if (f.id === 'archivo') {
      items.push([d, <g key={f.id} data-testid="office-archivo" data-finally={run?.finally || ''} className="office-item" {...btn('Archivo ("Al terminar" y entregables)', () => onOpenFlowTab('settings'))}><FilingPiece gx={f.gx} gy={f.gy} w={f.w} /></g>]);
    }
  }
  for (const dco of layout.decor) {
    const d = depth(dco.gx + Math.ceil(dco.w) - 1, dco.gy + Math.ceil(dco.h) - 1);
    if (dco.id === 'kiosk') items.push([d, <KioskPiece key={dco.id} gx={dco.gx} gy={dco.gy} />]);
    else if (dco.id === 'waiting') {
      items.push([d - 0.5, <WaitingChairs key={dco.id} gx={dco.gx} gy={dco.gy} w={dco.w} />]);
      items.push([d + 0.5, <WaitingBacks key={`${dco.id}:b`} gx={dco.gx} gy={dco.gy} w={dco.w} />]);
    } else if (dco.kind === 'halfwall') items.push([depth(dco.gx, dco.gy + dco.h - 1) + 0.3, <HalfWall key={dco.id} gx={dco.gx} gy={dco.gy} d={dco.h} />]);
    else items.push([d, <DecorPiece key={dco.id} kind={dco.kind} gx={dco.gx} gy={dco.gy} />]);
  }
  for (const desk of layout.desks) {
    const s = stepById.get(desk.id); if (!s) continue;
    const c = cast.get(desk.id); const st = run?.steps[desk.id];
    const status = statusOf(desk.id); const activity = activityOf(desk.id);
    const walker = walkers.current.get(`step:${desk.id}`);
    const away = walker && (walker.path || walker.targetKey !== 'seat');
    const isCmd = s.kind === 'command';
    const comp = run?.computers[desk.id] || (isCmd ? (status === 'error' ? 'err' : status === 'success' ? 'ok' : 'idle') : null);
    const seat = P(desk.gx + 0.42, desk.gy - 0.02);
    const label = `${c?.name} · ${s.name} (${KIND_LABEL[s.kind] || s.kind}): ${activityText(activity)}`;
    const pose = poseOf(activity, false);
    const personCls = `office-person${drill ? ' drill' : ''}${status === 'error' || status === 'timeout' ? ' storm' : ''}`;
    const variant = desk.gx + desk.gy;
    items.push([depth(desk.gx + 1, desk.gy), <g key={desk.id} data-testid="office-desk" data-step={desk.id} data-activity={activity} data-status={status} data-name={c?.name}
      className={`office-desk${selectedId === desk.id ? ' selected' : ''} st-${status}`} {...btn(label, () => onOpenStep(desk.id))}>
      <polygon className="office-hit" points={[P(desk.gx - 0.1, desk.gy - 1, 72), P(desk.gx + 2.1, desk.gy - 1, 72), P(desk.gx + 2.1, desk.gy - 1, 0), P(desk.gx + 2.1, desk.gy + 1, 0), P(desk.gx - 0.1, desk.gy + 1, 0), P(desk.gx - 0.1, desk.gy + 1, 72)].map((p) => `${p.x},${p.y}`).join(' ')} />
      <Partition gx={desk.gx} gy={desk.gy - 0.95} />
      <OfficeChair x={seat.x} y={seat.y} color={['#2d3340', '#3a3f4b', '#33302d'][variant % 3]} />
      {!away && <g transform={`translate(${seat.x},${seat.y})`} className={personCls} data-testid="office-person" data-activity={activity}>{renderer.render({ look: c.look, pose, frame, drill, mood: moodOf(desk.id), part: 'body' })}</g>}
      <DeskBase gx={desk.gx} gy={desk.gy} />
      {!away && <g transform={`translate(${seat.x},${seat.y})`} className={personCls}>{renderer.render({ look: c.look, pose, frame, drill, part: 'front' })}</g>}
      <g data-testid={isCmd ? 'office-computer' : undefined} data-state={isCmd ? comp : undefined} className={isCmd ? `office-computer ${comp}` : undefined}>
        <DeskTop id={desk.id} gx={desk.gx} gy={desk.gy} variant={variant} accent={['#f5c542', '#ef4444', '#3b82f6', '#22c55e', '#a855f7'][variant % 5]} flowPhone={s.kind === 'flow'}
          computer={isCmd ? { state: comp, label: comp === 'err' ? '✗ ERROR' : comp === 'ok' ? '✓ OK' : comp === 'running' ? '>_' : `> ${String(s.command || '').slice(0, 7)}` } : null} />
      </g>
    </g>]);
    const at = P(desk.gx + 1, desk.gy + 0.86, 31);
    const chips = [st?.locked ? '🔒' : null, st?.item ? `${st.item.i}/${st.item.total}` : null].filter(Boolean);
    labels.push(<g key={`l:${desk.id}`} className={`office-desk-label${selectedId === desk.id ? ' selected' : ''}`}><Plaque x={at.x} y={at.y} text={deskSign(s).toUpperCase()} sub={`${c?.name}${s.coordinator ? ' · 🧭' : ''}`} pip={pipOf(status)} chips={chips} /></g>);
  }

  // walkers: the coordinator when he is out of his chair, people away from their seat (same depth order)
  const placeWalker = (k, content, extra, hide) => {
    const w = walkers.current.get(k); if (!w) return;
    const c = center(w.pos.gx, w.pos.gy);
    items.push([w.pos.gx + w.pos.gy + 0.4, <g key={k} ref={(el) => { w.el = el; }} transform={`translate(${c.x},${c.y})`} data-tile={`${Math.round(w.pos.gx)},${Math.round(w.pos.gy)}`} data-moving={w.path ? '1' : '0'} visibility={hide ? 'hidden' : undefined} {...extra}>{content(!!w.path)}</g>]);
  };
  placeWalker('coordinator', (mv) => renderer.render({ look: COORD_LOOK, pose: mv ? 'walk' : 'stand', frame, drill, coordinator: true }),
    { 'data-testid': 'office-coordinator', 'data-target': coord.key, className: 'office-walker', ...btn(`${COORDINATOR}, coordinador`, () => onOpenRun(shown.focusRunId)) }, coordSeated);
  for (const desk of layout.desks) {
    const w = walkers.current.get(`step:${desk.id}`);
    if (!w || (!w.path && w.targetKey === 'seat')) continue;
    const c = cast.get(desk.id); const activity = activityOf(desk.id);
    placeWalker(`step:${desk.id}`, (mv) => renderer.render({ look: c.look, pose: mv ? 'walk' : activity === 'reading' ? 'read' : 'stand', frame, drill }),
      { 'data-testid': 'office-walker', 'data-step': desk.id, 'data-activity': activity, className: `office-walker${drill ? ' drill' : ''}`, ...btn(`${c.name}: ${activityText(activity)}`, () => onOpenStep(desk.id)) });
  }
  // the queue: other runs going at the same time, seen from behind on the waiting chairs, with their ticket
  others.forEach((id, i) => {
    const t = layout.queue[i]; if (!t) return; const p = P(t.gx + 0.5, t.gy + 0.45);
    items.push([depth(t.gx, t.gy) + 0.2, <g key={`q:${id}`} transform={`translate(${p.x},${p.y})`} data-testid="office-queue-person" data-ticket={shown.runs[id].ticket} className="office-item" {...btn(`Turno ${shown.runs[id].ticket} esperando`, () => onOpenRun(id))}>{renderer.render({ look: autoLook(id), pose: 'sit', legs: true, frame, facing: 'away' })}<g transform="translate(14,-58)"><rect x="-1" y="-8" width="30" height="13" rx="3" className="office-ticket-bg" /><text x="14" y="2" textAnchor="middle" className="office-ticket">{shown.runs[id].ticket}</text></g></g>]);
  });
  items.sort((x, y) => x[0] - y[0]);

  // bubbles (over everything), nudged up so they never overlap each other
  const bubbles = []; const placed = [];
  if (run && ACTIVE.has(run.status)) {
    const list = [];
    for (const desk of layout.desks) {
      const st = run.steps[desk.id]; if (!st?.bubble) continue;
      const w = walkers.current.get(`step:${desk.id}`); const away = w && (w.path || w.targetKey !== 'seat');
      const p = away ? center(w.pos.gx, w.pos.gy) : P(desk.gx + 0.42, desk.gy - 0.02);
      const raw = String(st.bubble); const text = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
      list.push({ id: desk.id, x: p.x - 10, y: p.y - 86, text, w: Math.max(28, text.length * 5.8 + 16) });
    }
    list.sort((a, b) => a.y - b.y);
    for (const b of list) {
      let y = b.y;
      for (let k = 0; k < 6; k++) { const hit = placed.find((o) => Math.abs(o.x - b.x) < (o.w + b.w) / 2 && Math.abs(o.y - y) < 24); if (!hit) break; y = hit.y - 24; }
      placed.push({ ...b, y });
      const bw = b.w;
      bubbles.push(<g key={b.id} className="office-bubble" transform={`translate(${b.x},${y})`}><path d={`M${-bw / 2} -11 h${bw} a5 5 0 0 1 5 5 v10 a5 5 0 0 1 -5 5 h${-bw / 2 + 4} l3 8 l-10 -8 h${-bw / 2 + 3} a5 5 0 0 1 -5 -5 v-10 a5 5 0 0 1 5 -5 z`} /><text textAnchor="middle" y="3.5">{b.text}</text></g>);
    }
  }

  return (
    <div className={`office${reduced ? ' reduced' : ''}${hidden ? ' paused' : ''}`} data-testid="office" data-mode={replay ? 'replay' : 'live'} data-reduced-motion={reduced ? '1' : '0'} data-animating={animating && !hidden ? '1' : '0'} data-run={run?.ticket || ''} data-drill={drill ? '1' : '0'}>
      <div className="office-toolbar">
        <button className="ghost small" data-testid="office-replay-btn" onClick={openReplay} title="Repetir una ejecución pasada en cámara rápida">▶ Ver la jornada</button>
        <label className="toggle small" title="Sin desplazamientos ni animaciones"><input type="checkbox" data-testid="office-reduced" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Movimiento reducido</label>
        <label className="toggle small" title="La campana de la ventanilla en un break o un error"><input type="checkbox" data-testid="office-sound" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sonido</label>
        <button className="ghost small" data-testid="office-log-btn" onClick={() => setShowLog((v) => !v)}>📜 Bitácora</button>
        <span className="office-zoom"><button className="ghost small" data-testid="office-zoom-out" disabled={zoom <= 1} onClick={() => setZoom(zoom - 0.25)} title="Alejar">−</button><span className="small muted">{Math.round(zoom * 100)}%</span><button className="ghost small" data-testid="office-zoom-in" disabled={zoom >= 2.5} onClick={() => setZoom(zoom + 0.25)} title="Acercar">+</button></span>
      </div>
      {runsList && (
        <div className="office-replay-pick">
          <select data-testid="office-replay-run" defaultValue="" onChange={(e) => e.target.value && startReplay(e.target.value, Number(document.querySelector('[data-testid="office-replay-speed"]')?.value) || 8)}>
            <option value="">{runsList.length ? 'Elegí una ejecución…' : 'No hay ejecuciones terminadas'}</option>
            {runsList.map((r) => <option key={r.id} value={r.id}>{`${ticketOf(r.id)} · ${new Date(r.startedAt).toLocaleString()} · ${r.status}`}</option>)}
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
      <div className="office-scroll" ref={scrollRef} onClick={onBackground}>
        <svg className="office-svg" viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} width={zoom > 1 ? (maxX - minX) * zoom : '100%'} height={zoom > 1 ? (maxY - minY) * zoom : '100%'} style={zoom > 1 ? undefined : { minWidth: Math.min(maxX - minX, 2400) * 0.55, minHeight: Math.min(maxY - minY, 2000) * 0.55 }} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Oficina del flujo «${flow.name}»`}>
          <OfficeDefs />
          <g>{rooms}</g>
          <g className="office-edges">{edgeLines}</g>
          <g>{items.map((x) => x[1])}</g>
          <g className="office-labels">{labels}</g>
          <g className="office-bubbles">{bubbles}</g>
          {layout.overflow > 0 && <text x={P(layout.cols - 4, 1, 150).x} y={P(layout.cols - 4, 1, 150).y} className="office-overflow">+{layout.overflow} más · ver en 🔲 Cajas</text>}
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
