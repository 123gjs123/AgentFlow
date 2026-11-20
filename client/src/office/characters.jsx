// Spec 29: how a character is drawn. A renderer turns {look, pose, frame, drill, mood, part, facing} into SVG anchored
// at the feet (0,0), in the style of the reference illustration: warm-brown outlines, light from the top-left (a
// shaded right side), big expressive eyes with catchlights, a nose, hair with a fringe and a highlight, clothes in
// layers (blazer, cardigan, hoodie). `part` splits a seated person into the body (drawn before the desk) and the front
// (forearms, hands, what they hold: drawn after the desk top, so they type ON the keyboard). `facing: 'away'` draws
// someone from behind (the people waiting at the counter). A sprite renderer can replace this one later.
import React from 'react';
import { lookValues } from './model.js';

const OUT = '#4a3224';
const rgb = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lighten = (c, k) => { const [r, g, b] = rgb(c); const f = (v) => Math.round(v + (255 - v) * k); return `rgb(${f(r)},${f(g)},${f(b)})`; };
const darken = (c, k) => { const [r, g, b] = rgb(c); const f = (v) => Math.round(v * (1 - k)); return `rgb(${f(r)},${f(g)},${f(b)})`; };

function Hair({ style, color, hy, back }) {
  const hi = lighten(color, 0.38); const sw = 1.1;
  if (back) { // the mass behind the head
    if (style === 'long') return <path d={`M-13.5 ${hy - 2} Q-16 ${hy + 18} -10 ${hy + 24} L10 ${hy + 24} Q16 ${hy + 18} 13.5 ${hy - 2} Z`} fill={color} stroke={OUT} strokeWidth={sw} />;
    if (style === 'wavy') return <path d={`M-13 ${hy - 4} Q-17 ${hy + 4} -14 ${hy + 9} Q-17 ${hy + 13} -12 ${hy + 16} Q-6 ${hy + 19} 0 ${hy + 16} Q6 ${hy + 19} 12 ${hy + 16} Q17 ${hy + 13} 14 ${hy + 9} Q17 ${hy + 4} 13 ${hy - 4} Z`} fill={color} stroke={OUT} strokeWidth={sw} />;
    if (style === 'bun') return <g><circle cx="0" cy={hy - 13} r="6.5" fill={color} stroke={OUT} strokeWidth={sw} /><path d={`M-2 ${hy - 16} q2 -2 4 0`} stroke={hi} strokeWidth="1.2" fill="none" /></g>;
    return null;
  }
  switch (style) {
    case 'bald': return <path d={`M-11.5 ${hy + 3} q-1 -4 1 -7 M11.5 ${hy + 3} q1 -4 -1 -7`} stroke={color} strokeWidth="3.4" strokeLinecap="round" fill="none" />;
    case 'curly': return <g fill={color} stroke={OUT} strokeWidth=".9">{[[-10, -2], [-7, -8], [-2, -11], [3, -11], [8, -8], [11, -2], [-12, 3], [12, 3], [-5, -4], [4, -5]].map(([x, y], i) => <circle key={i} cx={x} cy={hy + y} r="4.8" />)}<circle cx="-3" cy={hy - 11} r="1.8" fill={hi} stroke="none" /></g>;
    case 'long': case 'wavy': return <g><path d={`M-13 ${hy + 4} Q-14 ${hy - 13} 0 ${hy - 13} Q14 ${hy - 13} 13 ${hy + 4} Q10 ${hy - 3} 5 ${hy - 5} Q0 ${hy - 2} -4 ${hy - 6} Q-9 ${hy - 2} -13 ${hy + 4} Z`} fill={color} stroke={OUT} strokeWidth={sw} /><path d={`M-6 ${hy - 10} q5 -2.5 10 -1`} stroke={hi} strokeWidth="1.8" fill="none" strokeLinecap="round" /></g>;
    case 'bun': return <g><path d={`M-12.5 ${hy + 2} Q-13 ${hy - 13} 0 ${hy - 13} Q13 ${hy - 13} 12.5 ${hy + 2} Q7 ${hy - 6} 0 ${hy - 6} Q-7 ${hy - 6} -12.5 ${hy + 2} Z`} fill={color} stroke={OUT} strokeWidth={sw} /><path d={`M-5 ${hy - 10} q5 -2.5 9 0`} stroke={hi} strokeWidth="1.6" fill="none" strokeLinecap="round" /></g>;
    default: return <g><path d={`M-12.5 ${hy + 2} Q-14 ${hy - 13} 0 ${hy - 13} Q14 ${hy - 13} 12.5 ${hy + 2} Q11 ${hy - 4} 5 ${hy - 6} Q-1 ${hy - 3} -6 ${hy - 7} Q-10 ${hy - 3} -12.5 ${hy + 2} Z`} fill={color} stroke={OUT} strokeWidth={sw} /><path d={`M-5 ${hy - 10} q5 -2.5 10 0`} stroke={hi} strokeWidth="1.7" fill="none" strokeLinecap="round" /></g>;
  }
}
function Face({ hy, mood, skin, hairColor }) {
  const cheek = 'rgba(244,114,128,.38)'; const brow = darken(hairColor, 0.2);
  const mouth = mood === 'sad' ? <path d={`M-3 ${hy + 8} q3 -2.4 6 0`} stroke="#7a3b2e" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    : mood === 'open' ? <ellipse cx="0" cy={hy + 7.5} rx="2.4" ry="2.1" fill="#7a3b2e" />
      : mood === 'happy' ? <path d={`M-3.6 ${hy + 5.8} q3.6 4.4 7.2 0 Z`} fill="#fff" stroke="#7a3b2e" strokeWidth="1.1" strokeLinejoin="round" />
        : <path d={`M-3.2 ${hy + 6.2} q3.2 3 6.4 0`} stroke="#7a3b2e" strokeWidth="1.3" fill="none" strokeLinecap="round" />;
  return (
    <g>
      {[-4.2, 4.2].map((x) => <g key={x}><ellipse cx={x} cy={hy + 1.2} rx="2.2" ry="2.9" fill="#2b1d14" /><circle cx={x + 0.7} cy={hy + 0.2} r=".8" fill="#fff" /><circle cx={x - 0.6} cy={hy + 2.3} r=".4" fill="#fff" /></g>)}
      <path d={`M-6.6 ${hy - 3} q2.4 -1.6 4.6 -0.2 M2 ${hy - 3.2} q2.4 -1.4 4.6 0.2`} stroke={brow} strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d={`M0 ${hy + 2.6} q1.3 1.2 0 2.2`} stroke={darken(skin, 0.25)} strokeWidth="1" fill="none" strokeLinecap="round" />
      <ellipse cx="-7.5" cy={hy + 5} rx="2.2" ry="1.3" fill={cheek} /><ellipse cx="7.5" cy={hy + 5} rx="2.2" ry="1.3" fill={cheek} />
      {mouth}
    </g>
  );
}
function Accessory({ kind, hy, bodyY }) {
  switch (kind) {
    case 'glasses': return <g stroke="#2b1d14" strokeWidth="1.3" fill="rgba(255,255,255,.22)"><circle cx="-4.2" cy={hy + 1.2} r="3.8" /><circle cx="4.2" cy={hy + 1.2} r="3.8" /><path d={`M-0.4 ${hy + 1} L0.4 ${hy + 1} M-8 ${hy + 0.6} L-11 ${hy} M8 ${hy + 0.6} L11 ${hy}`} /></g>;
    case 'headset': return <g fill="none" stroke="#1f2937" strokeWidth="2"><path d={`M-12 ${hy + 2} Q0 ${hy - 19} 12 ${hy + 2}`} /><rect x="-14.5" y={hy - 1} width="4.5" height="8" rx="1.8" fill="#1f2937" /><path d={`M-12 ${hy + 6} q2 6 9 6.5`} strokeWidth="1.3" /><circle cx="-2.5" cy={hy + 12.5} r="1.4" fill="#1f2937" /></g>;
    case 'cap': return <g><path d={`M-12.5 ${hy - 1} Q0 ${hy - 17} 12.5 ${hy - 1} Z`} fill="#dc2626" stroke={OUT} strokeWidth="1" /><path d={`M4 ${hy - 2} q10 0 13 3 l-13 0 Z`} fill="#b91c1c" stroke={OUT} strokeWidth=".8" /></g>;
    case 'scarf': return <path d={`M-9 ${bodyY + 1} q9 5.5 18 0 l0 4.5 q-9 5.5 -18 0 Z`} fill="#facc15" stroke={OUT} strokeWidth=".9" />;
    case 'earrings': return <g fill="#fbbf24" stroke="#b45309" strokeWidth=".5"><circle cx="-12.4" cy={hy + 7} r="1.7" /><circle cx="12.4" cy={hy + 7} r="1.7" /></g>;
    default: return null;
  }
}
/** The clothes over the torso: a blazer (lapels, white shirt), a cardigan (open front, buttons) or a hoodie. */
function Layer({ kind, top, bodyY, hip, coordinator }) {
  const shirt = '#f8fafc';
  if (coordinator || kind === 'blazer') return <g><path d={`M-4.5 ${bodyY - 1} L0 ${bodyY + 9} L4.5 ${bodyY - 1} Z`} fill={shirt} /><path d={`M-6 ${bodyY - 1} L-1 ${bodyY + 10} L-4 ${bodyY + 3} Z M6 ${bodyY - 1} L1 ${bodyY + 10} L4 ${bodyY + 3} Z`} fill={darken(top, 0.22)} stroke={OUT} strokeWidth=".7" /></g>;
  if (kind === 'cardigan') return <g><rect x="-3" y={bodyY - 1} width="6" height={hip - bodyY + 2} fill={shirt} /><path d={`M-3 ${bodyY - 1} L-3 ${hip + 1} M3 ${bodyY - 1} L3 ${hip + 1}`} stroke={OUT} strokeWidth=".7" /><circle cx="-4.6" cy={bodyY + 8} r=".9" fill={darken(top, 0.35)} /><circle cx="-4.6" cy={bodyY + 14} r=".9" fill={darken(top, 0.35)} /></g>;
  if (kind === 'hoodie') return <g><path d={`M-7 ${bodyY - 1} Q0 ${bodyY + 5} 7 ${bodyY - 1}`} fill="none" stroke={darken(top, 0.25)} strokeWidth="2.2" /><path d={`M-2 ${bodyY + 2} l-0.6 8 M2 ${bodyY + 2} l0.6 8`} stroke={lighten(top, 0.7)} strokeWidth="1" strokeLinecap="round" /><rect x="-6" y={hip - 9} width="12" height="6" rx="2" fill={darken(top, 0.12)} stroke={OUT} strokeWidth=".6" /></g>;
  return <path d={`M-4 ${bodyY - 1} L0 ${bodyY + 5} L4 ${bodyY - 1}`} fill={lighten(top, 0.72)} stroke={OUT} strokeWidth=".7" />;
}
const vectorRenderer = {
  id: 'vector',
  size: { w: 34, h: 76 },
  render({ look, pose = 'sit', frame = 0, drill = false, coordinator = false, mood, legs = false, part = 'all', facing = 'front' }) {
    const L = lookValues(look);
    const seated = ['sit', 'type', 'read', 'phone', 'raise', 'storm'].includes(pose);
    const top = drill ? '#a3acb8' : coordinator ? '#2b3f8f' : L.top; const bottom = drill ? '#7b8594' : L.bottom; const skin = drill ? '#d5dbe3' : L.skin;
    const hair = drill ? '#8792a2' : L.hairColor;
    const hip = seated ? -24 : -22; const bodyY = hip - 20; const hy = bodyY - 13;
    const swing = pose === 'walk' ? (frame % 2 ? 4 : -4) : 0;
    const faceMood = mood || (pose === 'storm' ? 'sad' : pose === 'raise' ? 'open' : 'smile');
    const sleeve = darken(top, 0.06); const cuff = lighten(top, 0.6);
    const arm = (d, key) => <g key={key}><path d={d} stroke={OUT} strokeWidth="6.8" strokeLinecap="round" fill="none" /><path d={d} stroke={sleeve} strokeWidth="5" strokeLinecap="round" fill="none" /></g>;
    const hand = (x, y, key) => <g key={key}><circle cx={x} cy={y - 2.4} r="1.8" fill={cuff} /><circle cx={x} cy={y} r="2.8" fill={skin} stroke={OUT} strokeWidth=".9" /></g>;
    // the front part: forearms, hands and what they hold
    let front = null;
    if (pose === 'raise') front = [arm(`M-10 ${bodyY + 4} Q-13 ${bodyY + 12} -9 ${bodyY + 18}`, 'a'), arm(`M10 ${bodyY + 4} Q15 ${bodyY - 6} 13 ${bodyY - 17}`, 'b'), hand(-9, bodyY + 19, 'c'), hand(13, bodyY - 19, 'd')];
    else if (pose === 'phone') front = [arm(`M-10 ${bodyY + 4} Q-13 ${bodyY + 14} -7 ${bodyY + 22}`, 'a'), arm(`M10 ${bodyY + 4} Q15 ${bodyY + 2} 11 ${hy + 7}`, 'b'), <rect key="p" x="9" y={hy - 1} width="5" height="11" rx="1.6" fill="#111827" />, hand(-7, bodyY + 23, 'c'), hand(11, hy + 8, 'd')];
    else if (pose === 'type') { const t = frame % 2; front = [arm(`M-10 ${bodyY + 4} Q-14 ${bodyY + 16} -5 ${bodyY + 25 + t}`, 'a'), arm(`M10 ${bodyY + 4} Q14 ${bodyY + 16} 5 ${bodyY + 26 - t}`, 'b'), hand(-5, bodyY + 26 + t, 'c'), hand(5, bodyY + 27 - t, 'd')]; }
    else if (pose === 'read') front = [arm(`M-10 ${bodyY + 4} Q-13 ${bodyY + 11} -7 ${bodyY + 15}`, 'a'), arm(`M10 ${bodyY + 4} Q13 ${bodyY + 11} 7 ${bodyY + 15}`, 'b'), <g key="f"><rect x="-9" y={bodyY + 6} width="18" height="13" rx="1.5" fill="#2bb5c8" stroke="#0e7490" strokeWidth=".9" /><rect x="-7" y={bodyY + 9} width="10" height="1.5" fill="#ecfeff" /><rect x="-7" y={bodyY + 12.5} width="12" height="1.5" fill="#ecfeff" /></g>, hand(-7, bodyY + 16, 'c'), hand(7, bodyY + 16, 'd')];
    else if (pose === 'storm') front = [arm(`M-10 ${bodyY + 4} Q-16 ${bodyY - 4} -9 ${hy - 3}`, 'a'), arm(`M10 ${bodyY + 4} Q16 ${bodyY - 4} 9 ${hy - 3}`, 'b'), hand(-9, hy - 4, 'c'), hand(9, hy - 4, 'd')];
    else front = [arm(`M-10 ${bodyY + 4} Q-13 ${bodyY + 12 + swing / 2} -11 ${bodyY + 20 + swing / 2}`, 'a'), arm(`M10 ${bodyY + 4} Q13 ${bodyY + 12 - swing / 2} 11 ${bodyY + 20 - swing / 2}`, 'b'), hand(-11, bodyY + 21 + swing / 2, 'c'), hand(11, bodyY + 21 - swing / 2, 'd')];
    if (part === 'front') return <g className={`char char-front pose-${pose}`}>{front}</g>;
    const torso = `M-12 ${bodyY + 5} Q-12 ${bodyY - 1} -6 ${bodyY - 1} L6 ${bodyY - 1} Q12 ${bodyY - 1} 12 ${bodyY + 5} L9.5 ${hip + 1} L-9.5 ${hip + 1} Z`;
    const away = facing === 'away';
    const body = (
      <g className={`char pose-${pose}`}>
        <ellipse cx="0" cy="0" rx="13" ry="4.6" fill="rgba(60,40,20,.22)" />
        {(!seated || legs) && (
          <g>
            <path d={`M-4.5 ${hip + (seated ? 4 : 0)} L${-4.5 + swing} -3`} stroke={OUT} strokeWidth="7.6" strokeLinecap="round" /><path d={`M4.5 ${hip + (seated ? 4 : 0)} L${4.5 - swing} -3`} stroke={OUT} strokeWidth="7.6" strokeLinecap="round" />
            <path d={`M-4.5 ${hip + (seated ? 4 : 0)} L${-4.5 + swing} -3`} stroke={bottom} strokeWidth="6" strokeLinecap="round" /><path d={`M4.5 ${hip + (seated ? 4 : 0)} L${4.5 - swing} -3`} stroke={bottom} strokeWidth="6" strokeLinecap="round" />
            <ellipse cx={-4.5 + swing} cy="-1.5" rx="4.4" ry="2.4" fill="#2b2118" /><ellipse cx={4.5 - swing} cy="-1.5" rx="4.4" ry="2.4" fill="#2b2118" />
          </g>
        )}
        {seated && <rect x="-10.5" y={hip - 2} width="21" height="9" rx="3.5" fill={bottom} stroke={OUT} strokeWidth=".9" />}
        <Hair style={L.hair} color={hair} hy={hy} back />
        <path d={torso} fill={top} stroke={OUT} strokeWidth="1.1" strokeLinejoin="round" />
        <clipPath id={`tc-${pose}-${part}`}><path d={torso} /></clipPath>
        <rect x="3.5" y={bodyY - 2} width="10" height={hip - bodyY + 4} fill={darken(top, 0.18)} opacity=".55" clipPath={`url(#tc-${pose}-${part})`} />
        {!away && <Layer kind={coordinator ? 'blazer' : L.layer} top={top} bodyY={bodyY} hip={hip} coordinator={coordinator} />}
        {coordinator && !away && <g><path d={`M-0.8 ${bodyY + 5} L0 ${bodyY + 13} L0.8 ${bodyY + 5}`} fill="#1e3a8a" /><path d={`M-3 ${bodyY} L4 ${bodyY + 9}`} stroke="#2563eb" strokeWidth="1" /><rect x="2" y={bodyY + 8} width="6" height="8" rx="1" fill="#f8fafc" stroke="#94a3b8" strokeWidth=".6" /><rect x="3" y={bodyY + 9.5} width="4" height="2" fill="#93c5fd" /></g>}
        {part === 'all' && front}
        <rect x="-2.8" y={bodyY - 4} width="5.6" height="5" fill={darken(skin, 0.1)} />
        <circle cx="-12" cy={hy + 2} r="2.6" fill={skin} stroke={OUT} strokeWidth=".9" /><circle cx="12" cy={hy + 2} r="2.6" fill={skin} stroke={OUT} strokeWidth=".9" />
        <ellipse cx="0" cy={hy} rx="12" ry="12.5" fill={skin} stroke={OUT} strokeWidth="1.1" />
        {!away && <path d={`M4 ${hy - 10} A12 12.5 0 0 1 4 ${hy + 10} A10 11.5 0 0 0 4 ${hy - 10}`} fill={darken(skin, 0.12)} opacity=".7" />}
        {away
          ? <g><path d={`M-12.5 ${hy + 4} Q-14 ${hy - 13} 0 ${hy - 13} Q14 ${hy - 13} 12.5 ${hy + 4} Q12 ${hy + 9} 0 ${hy + 9} Q-12 ${hy + 9} -12.5 ${hy + 4} Z`} fill={hair} stroke={OUT} strokeWidth="1.1" />{L.hair === 'bun' && <circle cx="0" cy={hy - 13} r="6.5" fill={hair} stroke={OUT} strokeWidth="1.1" />}</g>
          : <g><Face hy={hy} mood={faceMood} skin={skin} hairColor={hair} /><Hair style={L.hair} color={hair} hy={hy} /><Accessory kind={coordinator ? 'headset' : L.accessory} hy={hy} bodyY={bodyY} /></g>}
        {pose === 'storm' && <path d={`M11 ${hy - 7} q2.2 3.4 0 5.6 q-2.2 -2.2 0 -5.6`} fill="#7dd3fc" stroke="#0284c7" strokeWidth=".6" />}
      </g>
    );
    return body;
  },
};
export const RENDERERS = { vector: vectorRenderer };
export const renderer = RENDERERS.vector;

/** A small standalone preview (the persona editor). */
export function CharacterPreview({ look, size = 76 }) {
  return (
    <svg width={size} height={size} viewBox="-24 -84 48 88" aria-hidden="true" data-testid="persona-preview">
      {renderer.render({ look, pose: 'stand' })}
    </svg>
  );
}
