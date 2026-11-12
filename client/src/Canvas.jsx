import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, MarkerType, ConnectionMode } from '@xyflow/react';
import dagre from '@dagrejs/dagre';

export const NODE_W = 240;
export const NODE_H = 96;
const KIND = { role: ['Rol', '🎭'], agent: ['Agente', '🤖'], skill: ['Skill', '🧩'], command: ['Comando', '⌨️'] };

/** Auto-order: left→right layered layout from the manual relations. */
export function autoLayout(steps, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  steps.forEach((s) => g.setNode(s.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return steps.map((s) => { const n = g.node(s.id); return { ...s, position: { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 } }; });
}

export function wouldCycle(edges, source, target) {
  if (source === target) return true;
  const adj = new Map();
  edges.forEach((e) => adj.set(e.source, [...(adj.get(e.source) || []), e.target]));
  const stack = [target]; const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    (adj.get(n) || []).forEach((x) => stack.push(x));
  }
  return false;
}

// Arrows can leave and enter any side of a box (spec 18). Inputs are hollow dots, outputs filled; the first ones
// rendered (in-left, out-right) are the defaults for arrows saved before sides existed.
const SIDES = [['left', Position.Left], ['top', Position.Top], ['bottom', Position.Bottom], ['right', Position.Right]];
const along = (side, pct) => (side === 'top' || side === 'bottom' ? { left: pct } : { top: pct });
function Handles() {
  return (
    <>
      {SIDES.map(([side, pos]) => <Handle key={`in-${side}`} id={`in-${side}`} type="target" position={pos} className="h-in" style={along(side, '35%')} title="Entrada" />)}
      {[...SIDES].reverse().map(([side, pos]) => <Handle key={`out-${side}`} id={`out-${side}`} type="source" position={pos} className="h-out" style={along(side, '65%')} title="Salida" />)}
    </>
  );
}
const BREAK_LABEL = { before: '⏸ antes', after: '⏸ después', both: '⏸ antes y después' };

const OP_SYM = { equals: '=', notEquals: '≠', gte: '≥', lte: '≤', exists: 'existe', matches: '~', lengthGte: 'largo ≥', lengthLte: 'largo ≤' };
/** Short text for an arrow: label · field · condition. */
export function edgeText(e) {
  const w = e.when;
  const cond = !w ? '' : w.type === 'route' ? '🧭 lo decide el step' : w.type === 'json' ? `si ${w.path || '(raíz)'} ${OP_SYM[w.op || 'exists'] || w.op}${w.op && w.op !== 'exists' ? ` ${typeof w.value === 'string' ? w.value : JSON.stringify(w.value)}` : ''}`
    : w.type === 'regex' ? `si /${w.pattern || ''}/` : w.type === 'contains' ? `si contiene "${w.value || ''}"` : w.type === 'notContains' ? `si no contiene "${w.value || ''}"` : '';
  return [e.label, e.pick && `{ ${e.pick} }`, cond].filter(Boolean).join(' · ');
}

function StepNode({ data, selected }) {
  const { step, live, order } = data;
  const status = live?.status || step.lastRun?.status || 'idle';
  const notRouted = status === 'skipped' && (live?.skipReason || step.lastRun?.skipReason) === 'not_routed';
  const [label, icon] = KIND[step.kind] || ['?', '•'];
  const ref = step.kind === 'agent' ? step.agentRef : step.kind === 'skill' ? step.skillRef : step.kind === 'command' ? step.command : step.model;
  return (
    <div className={`node st-${status} ${notRouted ? 'not-routed' : ''} ${step.breakpoint ? 'has-break' : ''} ${selected ? 'sel' : ''}`}>
      <Handles />
      <div className="node-top">
        <span className="order">{order}</span>
        <span className="kind">{icon} {label}</span>
        <span className={`status s-${status}`}>{status === 'running' ? <span className="spinner" /> : null}{notRouted ? 'no enrutado' : statusLabel(status)}</span>
      </div>
      <div className="node-name" title={step.name}>{step.name}</div>
      <div className="node-sub" title={ref}>{ref || <span className="muted">—</span>}</div>
      {live?.activity && status === 'running' && <div className="node-live" title={live.activity}>{live.activity}</div>}
      {(step.breakpoint || step.memory?.length > 0 || step.hooks?.trim() || step.pinned || step.output?.format === 'json' || step.lastRun?.actions?.length > 0 || step.assertions?.length > 0) && (
        <div className="node-badges">
          {step.breakpoint && <span className="brk" title="Break: la ejecución se pausa aquí para validar">{BREAK_LABEL[step.breakpoint]}</span>}
          {step.memory?.length > 0 && <span title="Memoria">🧷 {step.memory.length}</span>}
          {step.hooks?.trim() && <span title="Hooks">🪝</span>}
          {step.output?.format === 'json' && <span title="Entrega JSON estructurado">{'{ }'}</span>}
          {step.lastRun?.actions?.length > 0 && <span title="Acciones en sistemas externos (última ejecución)">⚡ {step.lastRun.actions.length}</span>}
          {step.pinned && <span className="pin" title="Salida fijada: no se ejecuta en el flujo">📌</span>}
          {step.assertions?.length > 0 && (() => {
            const res = step.lastRun?.assertions || [];
            const ok = res.filter((a) => a.pass).length; const bad = res.length - ok;
            return <span title={`${step.assertions.length} aserción(es)${res.length ? `: ${ok} ok, ${bad} fallida(s) en la última ejecución` : ''}`}>{res.length ? `✓${ok}${bad ? ` ✗${bad}` : ''}` : `✓? ${step.assertions.length}`}</span>;
          })()}
        </div>
      )}
    </div>
  );
}
const statusLabel = (s) => ({ idle: '', running: 'ejecutando', success: 'ok', error: 'error', skipped: 'omitido', stopped: 'detenido', timeout: '⏱ tiempo agotado', interrupted: 'interrumpido', queued: '⏳ en cola', paused: '⏸ en revisión' }[s] ?? s);
const nodeTypes = { step: StepNode };

export default function Canvas({ flow, live, selectedId, onSelect, onConnect, onReconnect, onDeleteSteps, onDeleteEdges, onMove, selectedEdge, onSelectEdge }) {
  const order = useMemo(() => {
    // execution level per step (1-based) for the badge
    const lvl = new Map(); const steps = flow.steps;
    const indeg = new Map(steps.map((s) => [s.id, 0]));
    flow.edges.forEach((e) => indeg.set(e.target, (indeg.get(e.target) || 0) + 1));
    let frontier = steps.filter((s) => !indeg.get(s.id)).map((s) => s.id); let k = 1;
    while (frontier.length) {
      const next = [];
      frontier.forEach((id) => { lvl.set(id, k); flow.edges.filter((e) => e.source === id).forEach((e) => { indeg.set(e.target, indeg.get(e.target) - 1); if (!indeg.get(e.target)) next.push(e.target); }); });
      frontier = next; k++;
    }
    return lvl;
  }, [flow.steps, flow.edges]);

  const [nodes, setNodes] = useState([]);
  useEffect(() => {
    setNodes((prev) => flow.steps.map((s) => {
      const p = prev.find((n) => n.id === s.id);
      return { ...(p || {}), id: s.id, type: 'step', position: p?.dragging ? p.position : s.position, data: { step: s, live: live[s.id], order: order.get(s.id) }, selected: s.id === selectedId };
    }));
  }, [flow.steps, live, selectedId, order]);

  const edgeSel = selectedEdge || null;
  const setEdgeSel = (id) => onSelectEdge?.(id);
  const edges = useMemo(() => flow.edges.map((e) => {
    const running = live[e.target]?.status === 'running' || live[e.source]?.status === 'running';
    const text = edgeText(e);
    const style = { ...(e.when ? { strokeDasharray: '6 4' } : {}), ...(e.id === edgeSel ? { stroke: 'var(--accent)', strokeWidth: 2 } : {}) };
    return { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || null, targetHandle: e.targetHandle || null, animated: running, selected: e.id === edgeSel, markerEnd: { type: MarkerType.ArrowClosed }, style, label: text || undefined, labelBgPadding: [6, 3], labelBgBorderRadius: 4, labelStyle: { fill: 'var(--text)', fontSize: 11 }, labelBgStyle: { fill: 'var(--bg3)', stroke: 'var(--line)' }, reconnectable: true };
  }), [flow.edges, edgeSel, live]);

  const onNodesChange = useCallback((changes) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) onDeleteSteps(removed);
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove' && c.type !== 'select'), nds));
  }, [onDeleteSteps]);

  const onEdgesChange = useCallback((changes) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) onDeleteEdges(removed);
    const sel = changes.find((c) => c.type === 'select' && c.selected);
    if (sel) setEdgeSel(sel.id);
  }, [onDeleteEdges]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      connectionMode={ConnectionMode.Strict}
      onConnect={(c) => onConnect(c.source, c.target, c.sourceHandle, c.targetHandle)}
      onReconnect={(old, c) => onReconnect?.(old.id, c)}
      onEdgeClick={(_, e) => { setEdgeSel(e.id); onSelect(null); }}
      onNodeClick={(_, n) => { setEdgeSel(null); onSelect(n.id); }}
      onPaneClick={() => { setEdgeSel(null); onSelect(null); }}
      onNodeDragStop={(_, n) => onMove(n.id, n.position)}
      deleteKeyCode={['Delete']}
      fitView fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={20} size={1} />
      <Controls />
      <MiniMap pannable zoomable nodeStrokeWidth={2} />
    </ReactFlow>
  );
}
