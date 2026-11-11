import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, MarkerType } from '@xyflow/react';
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

function StepNode({ data, selected }) {
  const { step, live, order } = data;
  const status = live?.status || step.lastRun?.status || 'idle';
  const [label, icon] = KIND[step.kind] || ['?', '•'];
  const ref = step.kind === 'agent' ? step.agentRef : step.kind === 'skill' ? step.skillRef : step.kind === 'command' ? step.command : step.model;
  return (
    <div className={`node st-${status} ${selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className="order">{order}</span>
        <span className="kind">{icon} {label}</span>
        <span className={`status s-${status}`}>{status === 'running' ? <span className="spinner" /> : null}{statusLabel(status)}</span>
      </div>
      <div className="node-name" title={step.name}>{step.name}</div>
      <div className="node-sub" title={ref}>{ref || <span className="muted">—</span>}</div>
      {live?.activity && status === 'running' && <div className="node-live" title={live.activity}>{live.activity}</div>}
      {(step.memory?.length > 0 || step.hooks?.trim() || step.pinned || step.output?.format === 'json' || step.lastRun?.actions?.length > 0 || step.assertions?.length > 0) && (
        <div className="node-badges">
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
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const statusLabel = (s) => ({ idle: '', running: 'ejecutando', success: 'ok', error: 'error', skipped: 'omitido', stopped: 'detenido', timeout: '⏱ tiempo agotado', interrupted: 'interrumpido', queued: '⏳ en cola' }[s] ?? s);
const nodeTypes = { step: StepNode };

export default function Canvas({ flow, live, selectedId, onSelect, onConnect, onDeleteSteps, onDeleteEdges, onMove }) {
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

  const [edgeSel, setEdgeSel] = useState(null);
  const edges = useMemo(() => flow.edges.map((e) => {
    const running = live[e.target]?.status === 'running' || live[e.source]?.status === 'running';
    return { ...e, animated: running, selected: e.id === edgeSel, markerEnd: { type: MarkerType.ArrowClosed }, style: e.id === edgeSel ? { stroke: 'var(--accent)', strokeWidth: 2 } : undefined };
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
      onConnect={(c) => onConnect(c.source, c.target)}
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
