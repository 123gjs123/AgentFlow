// Spec 29: how a character is drawn. A renderer turns {look, pose, facing, frame, drill} into SVG anchored at the
// feet (0,0). Today: simple vector people. A sprite renderer can replace it later with the same interface
// (render() returning an <image> clipped from a sheet).
import React from 'react';
import { lookValues } from './model.js';

const vectorRenderer = {
  id: 'vector',
  size: { w: 28, h: 46 },
  render({ look, pose = 'sit', frame = 0, drill = false, coordinator = false }) {
    const L = lookValues(look);
    const sit = ['sit', 'type', 'read', 'phone', 'raise', 'storm'].includes(pose);
    const lift = sit ? 8 : 0; // seated: the body sits lower
    const step = pose === 'walk' ? (frame % 2 ? 3 : -3) : 0;
    const top = drill ? '#94a3b8' : L.top; const bottom = drill ? '#64748b' : L.bottom;
    const bodyY = -34 + lift; const headY = -40 + lift;
    const hair = (() => {
      switch (L.hair) {
        case 'long': return <path d={`M-7 ${headY - 1} Q0 ${headY - 11} 7 ${headY - 1} L7 ${headY + 9} L-7 ${headY + 9} Z`} fill={L.hairColor} />;
        case 'bun': return <g fill={L.hairColor}><path d={`M-7 ${headY} Q0 ${headY - 10} 7 ${headY} Z`} /><circle cx="0" cy={headY - 8} r="3.5" /></g>;
        case 'curly': return <g fill={L.hairColor}>{[-6, -3, 0, 3, 6].map((x) => <circle key={x} cx={x} cy={headY - 5} r="3" />)}</g>;
        case 'bald': return null;
        default: return <path d={`M-7 ${headY} Q0 ${headY - 10} 7 ${headY} Z`} fill={L.hairColor} />;
      }
    })();
    const acc = (() => {
      switch (L.accessory) {
        case 'glasses': return <g stroke="#111" strokeWidth="1" fill="none"><circle cx="-3" cy={headY + 1} r="2" /><circle cx="3" cy={headY + 1} r="2" /><path d={`M-1 ${headY + 1} L1 ${headY + 1}`} /></g>;
        case 'headset': return <g stroke="#111" strokeWidth="1.4" fill="none"><path d={`M-7 ${headY + 1} Q0 ${headY - 10} 7 ${headY + 1}`} /><circle cx="-7" cy={headY + 2} r="1.8" fill="#111" /></g>;
        case 'cap': return <path d={`M-7 ${headY - 1} Q0 ${headY - 9} 7 ${headY - 1} L11 ${headY - 1} Z`} fill="#dc2626" />;
        case 'scarf': return <rect x="-6" y={bodyY - 1} width="12" height="3" rx="1.5" fill="#facc15" />;
        case 'earrings': return <g fill="#facc15"><circle cx="-6.5" cy={headY + 4} r="1.2" /><circle cx="6.5" cy={headY + 4} r="1.2" /></g>;
        default: return null;
      }
    })();
    const arms = (() => {
      if (pose === 'raise') return <g stroke={top} strokeWidth="3" strokeLinecap="round"><path d={`M-6 ${bodyY + 3} L-8 ${bodyY + 12}`} /><path d={`M6 ${bodyY + 3} L9 ${bodyY - 12}`} /></g>;
      if (pose === 'phone') return <g><path d={`M6 ${bodyY + 3} L5 ${headY + 3}`} stroke={top} strokeWidth="3" strokeLinecap="round" /><rect x="4" y={headY - 1} width="3" height="7" rx="1" fill="#111" /></g>;
      if (pose === 'type') return <g stroke={top} strokeWidth="3" strokeLinecap="round"><path d={`M-6 ${bodyY + 4} L-4 ${bodyY + 12 + (frame % 2)}`} /><path d={`M6 ${bodyY + 4} L4 ${bodyY + 12 + ((frame + 1) % 2)}`} /></g>;
      if (pose === 'read') return <g><rect x="-6" y={bodyY + 6} width="12" height="8" fill="#f8fafc" stroke="#cbd5e1" /><path d={`M-6 ${bodyY + 4} L-5 ${bodyY + 9} M6 ${bodyY + 4} L5 ${bodyY + 9}`} stroke={top} strokeWidth="3" strokeLinecap="round" /></g>;
      return <g stroke={top} strokeWidth="3" strokeLinecap="round"><path d={`M-6 ${bodyY + 3} L-7 ${bodyY + 13 + step / 2}`} /><path d={`M6 ${bodyY + 3} L7 ${bodyY + 13 - step / 2}`} /></g>;
    })();
    return (
      <g className={`char pose-${pose}`}>
        <ellipse cx="0" cy="0" rx="9" ry="4" fill="rgba(0,0,0,.25)" />
        {!sit && <g stroke={bottom} strokeWidth="4" strokeLinecap="round"><path d={`M-3 -14 L${-3 + step} -1`} /><path d={`M3 -14 L${3 - step} -1`} /></g>}
        {sit && <rect x="-7" y={-14 + lift - 6} width="14" height="6" rx="2" fill={bottom} />}
        <rect x="-7" y={bodyY} width="14" height={20 - (sit ? 6 : 0)} rx="5" fill={top} />
        {coordinator && <rect x="-1.5" y={bodyY + 2} width="3" height="10" fill="#fde047" />}
        {arms}
        <circle cx="0" cy={headY + 1} r="7" fill={drill ? '#cbd5e1' : L.skin} />
        {hair}{acc}
      </g>
    );
  },
};
export const RENDERERS = { vector: vectorRenderer };
export const renderer = RENDERERS.vector;

/** A small standalone preview (the persona editor). */
export function CharacterPreview({ look, size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="-20 -52 40 56" aria-hidden="true" data-testid="persona-preview">
      {renderer.render({ look, pose: 'stand' })}
    </svg>
  );
}
