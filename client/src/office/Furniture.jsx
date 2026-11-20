// Spec 29 — the office's room and furniture, drawn in isometric SVG after the user's reference illustration: a warm,
// bright room (rosy beige walls with a skirting board, cream floor with a soft sheen, light pooling from the window),
// wooden desks with half-frosted partitions and monitors, metal shelving with real binders and archive boxes, the
// coordinator's glass counter, the red turn display hanging on the wall, blue waiting chairs, plants and a coffee
// corner. Objects stand on the floor with a contact shadow; signs are mounted on things, not floating.
// Coordinates: tiles (gx, gy) and a height z in px. Left-wall items use the x=const plane, back-wall items y=const.
import React from 'react';
import { iso, isoRaw, rot, rotDir, facesViewer, viewRotation } from './layout.js';

/** A point on the floor (gx, gy) raised z px. */
export const P = (gx, gy, z = 0) => { const p = iso(gx, gy); return { x: p.x, y: p.y - z }; };
const pts = (list) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** Lighten (k > 0) or darken (k < 0) a #rrggbb colour. */
export const shade = (c, k) => { const [r, g, b] = hex(c); return k >= 0 ? toHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k) : toHex(r * (1 + k), g * (1 + k), b * (1 + k)); };
const EDGE = 'rgba(74,50,36,.45)';
/** Centre of a tile on the floor (where feet stand). */
export const center = (gx, gy) => P(gx + 0.5, gy + 0.5);
/** Text laid on a back-wall / front face (y = const) or a left-wall face (x = const), anchored at p. */
/** Text laid on a face whose plan normal is (nx, ny), anchored at p; hidden when that face looks away. */
const onPlane = (nx, ny, p) => {
  if (!facesViewer(nx, ny)) return 'scale(0)';
  const [x] = rotDir(nx, ny);
  return x > 0 ? `matrix(1,-0.5,0,1,${p.x.toFixed(1)},${p.y.toFixed(1)})` : `matrix(1,0.5,0,1,${p.x.toFixed(1)},${p.y.toFixed(1)})`;
};
export const onFront = (p) => onPlane(0, 1, p);
export const onSide = (p) => onPlane(1, 0, p);
/** A decal on the plane y = gy (front face). Hidden from behind unless it is a panel seen from both sides. */
const frontQuad = (gx0, gx1, gy, z0, z1, both = false) => (both || facesViewer(0, 1) ? [P(gx0, gy, z0), P(gx1, gy, z0), P(gx1, gy, z1), P(gx0, gy, z1)] : []);
const sideQuad = (gx, gy0, gy1, z0, z1, both = false) => (both || facesViewer(1, 0) ? [P(gx, gy0, z0), P(gx, gy1, z0), P(gx, gy1, z1), P(gx, gy0, z1)] : []);
/** Rotated-space point (the walls and the floor's cut edge live there). */
const R = (x, y, z = 0) => { const p = isoRaw(x, y); return { x: p.x, y: p.y - z }; };
const floorQuad = (gx, gy, w, d, z = 0) => [P(gx, gy, z), P(gx + w, gy, z), P(gx + w, gy + d, z), P(gx, gy + d, z)];

/** Contact shadow of a footprint (objects never float). */
export const FloorShadow = ({ gx, gy, w = 1, d = 1, k = 0.14 }) => <polygon points={pts(floorQuad(gx + 0.1, gy + 0.1, w, d))} fill={`rgba(92,62,32,${k})`} pointerEvents="none" />;
/** An isometric box lit from the top-left. */
export function Box({ gx, gy, w = 1, d = 1, h = 10, z = 0, color = '#c9a27a', top, left, right, stroke = EDGE, opacity, shadow }) {
  const [ax, ay] = rot(gx, gy); const [bx, by] = rot(gx + w, gy + d);
  const x0 = Math.min(ax, bx); const x1 = Math.max(ax, bx); const y0 = Math.min(ay, by); const y1 = Math.max(ay, by);
  const T = [R(x0, y0, z + h), R(x1, y0, z + h), R(x1, y1, z + h), R(x0, y1, z + h)];
  const L = [R(x0, y1, z), R(x1, y1, z), R(x1, y1, z + h), R(x0, y1, z + h)];
  const Rf = [R(x1, y1, z), R(x1, y0, z), R(x1, y0, z + h), R(x1, y1, z + h)];
  return (
    <g opacity={opacity}>
      {(shadow ?? z === 0) && <FloorShadow gx={gx} gy={gy} w={w} d={d} />}
      <polygon points={pts(L)} fill={left || color} stroke={stroke} strokeWidth="0.7" strokeLinejoin="round" />
      <polygon points={pts(Rf)} fill={right || shade(color, -0.17)} stroke={stroke} strokeWidth="0.7" strokeLinejoin="round" />
      <polygon points={pts(T)} fill={top || shade(color, 0.2)} stroke={stroke} strokeWidth="0.7" strokeLinejoin="round" />
    </g>
  );
}

export function OfficeDefs() {
  return (
    <defs>
      <linearGradient id="of-wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f4e4d2" /><stop offset="1" stopColor="#ecd6c0" /></linearGradient>
      <linearGradient id="of-wall-side" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ead7c3" /><stop offset="1" stopColor="#e0c7ae" /></linearGradient>
      <linearGradient id="of-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a9d8f0" /><stop offset="1" stopColor="#e3f4fb" /></linearGradient>
      <linearGradient id="of-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#eef8fc" stopOpacity=".7" /><stop offset="1" stopColor="#c6e0ea" stopOpacity=".38" /></linearGradient>
      <linearGradient id="of-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" stopOpacity=".22" /><stop offset="1" stopColor="#ffffff" stopOpacity="0" /></linearGradient>
      <linearGradient id="of-screen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22356e" /><stop offset="1" stopColor="#16224a" /></linearGradient>
      <linearGradient id="of-screen-ok" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#166534" /><stop offset="1" stopColor="#0b3a20" /></linearGradient>
      <linearGradient id="of-screen-err" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8b1d1d" /><stop offset="1" stopColor="#4c0f0f" /></linearGradient>
      <linearGradient id="of-screen-run" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#13457a" /><stop offset="1" stopColor="#0a2744" /></linearGradient>
      <filter id="of-soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.4" floodColor="#3b2a1a" floodOpacity=".28" /></filter>
      <filter id="of-blur"><feGaussianBlur stdDeviation="18" /></filter>
      <filter id="of-glow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#5b8cff" floodOpacity=".95" /></filter>
      <filter id="of-glow-err" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#ef4444" floodOpacity=".9" /></filter>
    </defs>
  );
}

const WALL_H = 120;
/** The floor of one room (plan space) and, for rooms after the first, the low wall that separates it. */
export function Room({ room, cols, gy0, rows }) {
  const many = cols * rows > 2600;
  const tiles = [];
  if (!many) for (let x = 0; x < cols; x++) for (let y = gy0; y < gy0 + rows; y++) tiles.push(<polygon key={`${x},${y}`} points={pts(floorQuad(x, y, 1, 1))} fill="#eee2d1" stroke="#dccab2" strokeWidth="0.5" />);
  return (
    <g className="office-room" data-room={room} pointerEvents="none">
      {many ? <polygon points={pts(floorQuad(0, gy0, cols, rows))} fill="#eee2d1" /> : tiles}
      {room > 0 && <g><Box gx={5} gy={gy0 - 0.07} w={cols - 5} d={0.14} h={34} color="#e7d3b8" top="#f5e8d6" shadow={false} /><Box gx={0} gy={gy0 - 0.07} w={0.2} d={0.14} h={34} color="#e7d3b8" top="#f5e8d6" shadow={false} /></g>}
    </g>
  );
}
/** Under the floor: the contact shadow; around it: the cut edge. Drawn first. */
export function Shell({ cols, rows }) {
  const r = viewRotation(); const W = r % 2 ? rows : cols; const H = r % 2 ? cols : rows; const slab = 16;
  const c = R(W / 2, H / 2);
  return (
    <g pointerEvents="none">
      <ellipse cx={c.x} cy={c.y + 40} rx={(W + H) * 22} ry={(W + H) * 11} fill="rgba(0,0,0,.45)" filter="url(#of-blur)" />
      <polygon points={pts([R(0, H), R(W, H), R(W, H, -slab), R(0, H, -slab)])} fill="#a88f72" />
      <polygon points={pts([R(W, 0), R(W, H), R(W, H, -slab), R(W, 0, -slab)])} fill="#8f775c" />
    </g>
  );
}
/** The sheen, the window light, the two back walls (always the ones far from the camera) and their decor. */
export function Walls({ cols, rows }) {
  const r = viewRotation(); const W = r % 2 ? rows : cols; const H = r % 2 ? cols : rows;
  const WH = WALL_H; const T = 0.22;
  const bq = (x0, x1, z0, z1, y = 0) => [R(x0, y, z0), R(x1, y, z0), R(x1, y, z1), R(x0, y, z1)];
  const lq = (y0, y1, z0, z1, x = 0) => [R(x, y0, z0), R(x, y1, z0), R(x, y1, z1), R(x, y0, z1)];
  const w0 = Math.max(1.5, H * 0.35); const w1 = Math.min(H - 0.8, w0 + 3);
  const at = (x, y, z) => R(x, y, z);
  return (
    <g pointerEvents="none">
      <polygon points={pts([R(0, 0), R(W, 0), R(W, H), R(0, H)])} fill="url(#of-sheen)" />
      <polyline points={pts([R(0, H), R(W, H), R(W, 0)])} fill="none" stroke="#fff3e0" strokeWidth="1" />
      <polygon points={pts([R(0, w0), R(3.5, w0 + 0.8), R(3.5, w1 + 0.8), R(0, w1)])} fill="#fff3d6" opacity=".28" />
      <polygon points={pts([R(3.5, w0 + 0.8), R(4.6, w0 + 1.1), R(4.6, w1 + 1.1), R(3.5, w1 + 0.8)])} fill="#fff3d6" opacity=".14" />
      {/* back wall (y' = 0) and left wall (x' = 0), with a top cap and their cut ends */}
      <polygon points={pts(bq(0, W, 0, WH))} fill="url(#of-wall)" stroke={EDGE} strokeWidth=".6" />
      <polygon points={pts([R(-T, -T, WH), R(W, -T, WH), R(W, 0, WH), R(0, 0, WH)])} fill="#f6ead9" stroke={EDGE} strokeWidth=".6" />
      <polygon points={pts([R(W, 0, 0), R(W, -T, 0), R(W, -T, WH), R(W, 0, WH)])} fill="#d9c3a5" />
      <polygon points={pts(lq(0, H, 0, WH))} fill="url(#of-wall-side)" stroke={EDGE} strokeWidth=".6" />
      <polygon points={pts([R(-T, -T, WH), R(0, 0, WH), R(0, H, WH), R(-T, H, WH)])} fill="#f6ead9" stroke={EDGE} strokeWidth=".6" />
      <polygon points={pts([R(0, H, 0), R(-T, H, 0), R(-T, H, WH), R(0, H, WH)])} fill="#d9c3a5" />
      <polygon points={pts(bq(0, W, 0, 8))} fill="#d7bf9f" /><polygon points={pts(bq(0, W, 8, 9))} fill="#b99b78" />
      <polygon points={pts(lq(0, H, 0, 8))} fill="#cfb492" /><polygon points={pts(lq(0, H, 8, 9))} fill="#b0916e" />
      {/* the window on the left wall */}
      <polygon points={pts(lq(w0, w1, 40, 104, 0.01))} fill="#f7f3ec" />
      <polygon points={pts(lq(w0 + 0.12, w1 - 0.12, 44, 100, 0.02))} fill="url(#of-sky)" />
      {[[w0 + 0.7, 58, 13, '#7fb77e'], [w0 + 1.6, 54, 15, '#5f9d63'], [w1 - 0.6, 60, 12, '#6aa96c']].map(([y, z, rr, c], i) => { const p = at(0.02, y, z); return <ellipse key={i} cx={p.x} cy={p.y} rx={rr * 0.7} ry={rr} fill={c} opacity=".85" transform={`rotate(-26 ${p.x} ${p.y})`} />; })}
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <polygon key={i} points={pts(lq(w0 + 0.12, w1 - 0.12, 96 - i * 6, 98.5 - i * 6, 0.03))} fill="#f4ede2" opacity=".8" />)}
      <polygon points={pts(lq(w0 + 0.12, w1 - 0.12, 44, 100, 0.02))} fill="none" stroke="#e8dfd2" strokeWidth="3" />
      {/* the back wall: a framed landscape, the clock, a cork board with notes, a calendar */}
      <polygon points={pts(bq(1.2, 2.8, 62, 102))} fill="#b8863f" stroke="#8a6238" strokeWidth="1.5" />
      <polygon points={pts(bq(1.3, 2.7, 66, 98))} fill="url(#of-sky)" />
      <polygon points={pts([at(1.3, 0, 66), at(1.8, 0, 84), at(2.2, 0, 74), at(2.7, 0, 82), at(2.7, 0, 66)])} fill="#86b47d" />
      {(() => { const c = at(4.2, 0, 96); return (
        <g transform={`matrix(1,0.5,0,1,${c.x},${c.y})`}>
          <circle r="12" fill="#fdfbf6" stroke="#3f3a36" strokeWidth="2.4" />
          {Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6; return <line key={i} x1={Math.sin(a) * 9} y1={-Math.cos(a) * 9} x2={Math.sin(a) * 10.5} y2={-Math.cos(a) * 10.5} stroke="#3f3a36" strokeWidth={i % 3 ? 0.8 : 1.6} />; })}
          <line x1="0" y1="0" x2="0" y2="-6" stroke="#3f3a36" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="0" y1="0" x2="0" y2="-8.5" stroke="#3f3a36" strokeWidth="1.1" strokeLinecap="round" className="office-clock-min" />
        </g>); })()}
      {W > 9 && <g>
        <polygon points={pts(bq(W - 5.4, W - 2.8, 58, 108))} fill="#c89a63" stroke="#8a6238" strokeWidth="2" />
        {['#fde68a', '#fbcfe8', '#bae6fd', '#bbf7d0', '#fde68a', '#fecaca', '#bae6fd', '#fbcfe8'].map((c, i) => { const x = W - 5.2 + (i % 4) * 0.55; const z = 100 - Math.floor(i / 4) * 22; return <g key={i}><polygon points={pts(bq(x, x + 0.42, z - 15, z))} fill={c} /><circle cx={at(x + 0.21, 0, z - 2).x} cy={at(x + 0.21, 0, z - 2).y} r="1.2" fill="#dc2626" /></g>; })}
        <polygon points={pts(bq(W - 2.3, W - 1.3, 54, 92))} fill="#fffdf8" stroke="#d8cbb8" />
        <polygon points={pts(bq(W - 2.3, W - 1.3, 84, 92))} fill="#e25b4a" />
      </g>}
    </g>
  );
}
/** A solid nameplate (face + bevel), upright, facing the viewer. Two lines: the sign and, smaller, a name. */
export function Plaque({ x, y, text, sub, pip, chips = [], small = false }) {
  const fs = small ? 8 : 9.5;
  const w = Math.max(40, Math.max(String(text).length * fs * 0.6, sub ? String(sub).length * 8 * 0.55 : 0) + (pip ? 26 : 16));
  const h = sub ? 24 : small ? 14 : 17;
  return (
    <g className="office-plaque">
      <rect x={x - w / 2} y={y - h / 2 + 2.5} width={w} height={h} rx="2.5" fill="#c9b28e" />
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx="2.5" fill="#fbf3e4" stroke="#7a6248" strokeWidth="1" />
      {pip && <circle cx={x - w / 2 + 8} cy={y - (sub ? 4 : 0)} r="3.5" className={`office-pip ${pip}`} />}
      <text x={x + (pip ? 4 : 0)} y={y + (sub ? -1.5 : fs * 0.36)} textAnchor="middle" className="office-plaque-text" fontSize={fs}>{text}</text>
      {sub && <text x={x + (pip ? 4 : 0)} y={y + 8.5} textAnchor="middle" className="office-plaque-sub">{sub}</text>}
      {chips.map((c, i) => <g key={i} transform={`translate(${x + w / 2 + 2 + i * 22},${y - 8})`}><rect width="20" height="13" rx="6.5" className="office-chip" /><text x="10" y="9.5" textAnchor="middle" className="office-chip-text">{c}</text></g>)}
    </g>
  );
}
/** A board on a shelf, the counter or the cabinets: an upright sign (readable from every angle). */
function FrontBoard({ gx0, gx1, gy, z1, text, fontSize = 11 }) {
  const mid = P((gx0 + gx1) / 2, gy, z1 - 6);
  return <Plaque x={mid.x} y={mid.y} text={text} small={fontSize < 10} />;
}

/** A screen facing the viewer: frame, title bar, a few UI lines or a terminal line, two pill buttons, a stand. */
function Screen({ gx0, gx1, gy, z0, z1, state = 'idle', label, id }) {
  const fill = state === 'ok' ? 'url(#of-screen-ok)' : state === 'err' ? 'url(#of-screen-err)' : state === 'running' ? 'url(#of-screen-run)' : 'url(#of-screen)';
  const mx = (gx0 + gx1) / 2;
  const clip = `of-clip-${id}`;
  return (
    <g>
      <Box gx={gx0 - 0.05} gy={gy - 0.07} w={gx1 - gx0 + 0.1} d={0.07} h={z1 - z0 + 6} z={z0 - 3} color="#2a2d33" top="#3a3d44" shadow={false} />
      <polygon points={pts([P(mx - 0.06, gy + 0.02, z0 - 2), P(mx + 0.06, gy + 0.02, z0 - 2), P(mx + 0.06, gy + 0.02, z0 - 13), P(mx - 0.06, gy + 0.02, z0 - 13)])} fill="#3a3d44" />
      <polygon points={pts(floorQuad(mx - 0.16, gy - 0.08, 0.32, 0.18, z0 - 13))} fill="#2a2d33" />
      <polygon points={pts(frontQuad(gx0 - 0.05, gx1 + 0.05, gy, z0 - 3, z1 + 3))} fill="#26292e" stroke="#101214" strokeWidth=".8" />
      <polygon points={pts(frontQuad(gx0, gx1, gy, z0, z1))} fill={fill} />
      <polygon points={pts(frontQuad(gx0, gx1, gy, z1 - 3, z1))} fill={state === 'err' ? '#dc2626' : state === 'ok' ? '#16a34a' : '#3b5bdb'} />
      {!label && [0, 1, 2].map((i) => <polygon key={i} points={pts(frontQuad(gx0 + 0.06, gx0 + 0.06 + (gx1 - gx0 - 0.12) * [0.75, 0.55, 0.65][i], gy, z1 - 8 - i * 5, z1 - 6 - i * 5))} fill={['#93c5fd', '#c4b5fd', '#86efac'][i]} opacity=".8" />)}
      {!label && <g><polygon points={pts(frontQuad(gx0 + 0.08, gx0 + 0.24, gy, z0 + 2, z0 + 5))} fill="#22c55e" /><polygon points={pts(frontQuad(gx0 + 0.3, gx0 + 0.46, gy, z0 + 2, z0 + 5))} fill="#f43f5e" /></g>}
      {label && (
        <g>
          <clipPath id={clip}><polygon points={pts(frontQuad(gx0, gx1, gy, z0, z1 - 3))} /></clipPath>
          <g clipPath={`url(#${clip})`}><g transform={onFront(P(gx0 + 0.06, gy, (z0 + z1) / 2))}><text y="2" className="office-screen-text">{label}</text></g></g>
          {state === 'running' && <polygon className="office-progress" points={pts(frontQuad(gx0 + 0.06, gx1 - 0.06, gy, z0 + 2, z0 + 4))} />}
        </g>
      )}
    </g>
  );
}
const Mug = ({ x, y, color = '#f5c542' }) => (<g><rect x={x - 4.5} y={y - 10} width="9" height="10" rx="2" fill={color} stroke={EDGE} strokeWidth=".7" /><ellipse cx={x} cy={y - 10} rx="4.5" ry="1.4" fill={shade(color, -0.25)} /><path d={`M${x + 4.5} ${y - 7.5} q3.5 1 0 4.5`} fill="none" stroke={color} strokeWidth="1.6" /></g>);
const PencilCup = ({ x, y }) => (<g><path d={`M${x - 1.5} ${y - 9} l-2 -7`} stroke="#ef4444" strokeWidth="1.3" /><path d={`M${x} ${y - 9} l0 -8`} stroke="#3b82f6" strokeWidth="1.3" /><path d={`M${x + 1.5} ${y - 9} l2 -6`} stroke="#eab308" strokeWidth="1.3" /><rect x={x - 3.5} y={y - 9} width="7" height="9" rx="1.2" fill="#6b7280" stroke={EDGE} strokeWidth=".6" /></g>);
const Thermos = ({ x, y }) => (<g><rect x={x - 3} y={y - 16} width="6" height="16" rx="2" fill="#16a34a" stroke={EDGE} strokeWidth=".6" /><rect x={x - 2} y={y - 18} width="4" height="3" rx="1" fill="#e5e7eb" /><rect x={x - 1.6} y={y - 13} width="1.2" height="9" fill="#bbf7d0" opacity=".7" /></g>);
const Lamp = ({ x, y }) => (<g><ellipse cx={x} cy={y - 1} rx="4" ry="1.5" fill="#374151" /><path d={`M${x} ${y - 1} L${x + 2} ${y - 13} L${x - 4} ${y - 20}`} stroke="#374151" strokeWidth="1.5" fill="none" /><path d={`M${x - 10} ${y - 17} L${x - 1} ${y - 24} L${x + 1} ${y - 19} Z`} fill="#f59e0b" stroke={EDGE} strokeWidth=".6" /></g>);
const Books = ({ x, y }) => (<g>{['#2563eb', '#16a34a', '#dc2626'].map((c, i) => <rect key={i} x={x - 8 + i} y={y - 3.5 - i * 3.5} width="15" height="3.5" rx=".8" fill={c} stroke="rgba(0,0,0,.15)" strokeWidth=".5" />)}</g>);

/** Half-frosted cubicle partition behind the person (opaque below, frosted above, a rail, a side wing). */
export function Partition({ gx, gy, w = 2 }) {
  const x0 = gx - 0.1; const x1 = gx + w + 0.1;
  return (
    <g>
      <polygon points={pts(frontQuad(x0, x1, gy, 0, 30, true))} fill="#d8d1c6" stroke="#b5ab9c" strokeWidth=".8" />
      <polygon points={pts(frontQuad(x0, x1, gy, 30, 44, true))} fill="url(#of-glass)" opacity=".75" stroke="#b5ab9c" strokeWidth=".6" />
      <polygon points={pts(frontQuad(x0, x1, gy, 44, 46, true))} fill="#9aa3ad" />
      <polygon points={pts(sideQuad(x1, gy, gy + 1.25, 0, 30, true))} fill="#cbc3b6" stroke="#b5ab9c" strokeWidth=".8" />
      <polygon points={pts(sideQuad(x1, gy, gy + 1.25, 30, 44, true))} fill="url(#of-glass)" opacity=".7" />
      <polygon points={pts(sideQuad(x1, gy, gy + 1.25, 44, 46, true))} fill="#8f98a3" />
      <polygon points={pts(frontQuad(x0 + 0.2, x0 + 0.48, gy, 16, 26, true))} fill="#fde68a" />
    </g>
  );
}
/** An office chair seen from the front: back with a highlight, armrests, a five-star base. */
export function OfficeChair({ x, y, color = '#2d3340' }) {
  return (
    <g>
      <path d={`M${x - 9} ${y - 1} l-4 2 M${x + 9} ${y - 1} l4 2 M${x} ${y} l0 3`} stroke="#1f2937" strokeWidth="1.6" strokeLinecap="round" />
      <ellipse cx={x} cy={y - 2} rx="11" ry="3.2" fill="#1f2937" />
      <rect x={x - 1.5} y={y - 20} width="3" height="18" fill="#4b5563" />
      <rect x={x - 14} y={y - 60} width="28" height="34" rx="8" fill={color} stroke="#111827" strokeWidth=".9" />
      <rect x={x - 12} y={y - 57} width="5" height="28" rx="2.5" fill="#475063" />
      <rect x={x - 16} y={y - 28} width="6" height="3" rx="1.5" fill="#1f2937" /><rect x={x + 10} y={y - 28} width="6" height="3" rx="1.5" fill="#1f2937" />
    </g>
  );
}
/** The desk: wooden top with a bevel, an inset modesty panel, metal legs. */
export function DeskBase({ gx, gy }) {
  const top = 26;
  return (
    <g>
      <FloorShadow gx={gx + 0.06} gy={gy + 0.08} w={1.88} d={0.84} k={0.16} />
      <polygon points={pts(sideQuad(gx + 1.88, gy + 0.14, gy + 0.9, 0, top - 6, true))} fill="#8e97a3" stroke={EDGE} strokeWidth=".5" />
      <polygon points={pts(sideQuad(gx + 0.14, gy + 0.14, gy + 0.9, 0, top - 6, true))} fill="#a9b1bb" opacity=".9" />
      <polygon points={pts(frontQuad(gx + 0.16, gx + 1.84, gy + 0.9, 3, top - 6))} fill="#c88a4e" stroke={EDGE} strokeWidth=".6" />
      <polygon points={pts(frontQuad(gx + 0.28, gx + 1.72, gy + 0.905, 7, top - 10))} fill="#d39a5e" />
      <Box gx={gx + 0.06} gy={gy + 0.08} w={1.88} d={0.84} h={6} z={top - 6} color="#c88a4e" top="#e2ad72" left="#c88a4e" right="#ad7039" shadow={false} />
      <polyline points={pts([P(gx + 0.06, gy + 0.92, top), P(gx + 1.94, gy + 0.92, top)])} stroke="#f3cf9e" strokeWidth="1" />
    </g>
  );
}
/** What is on the desk: monitor (or the terminal of a command), keyboard, mug, pencils, books, a thermos or a lamp. */
export function DeskTop({ gx, gy, computer, accent, variant = 0, flowPhone, id }) {
  const top = 26;
  const at = (x, y) => P(gx + x, gy + y, top);
  return (
    <g>
      {computer
        ? <Screen id={id} gx0={gx + 1.2} gx1={gx + 1.95} gy={gy + 0.24} z0={top + 15} z1={top + 42} state={computer.state} label={computer.label} />
        : <Screen id={id} gx0={gx + 1.32} gx1={gx + 1.95} gy={gy + 0.22} z0={top + 13} z1={top + 34} />}
      <polygon points={pts(floorQuad(gx + 0.18, gy + 0.5, 0.6, 0.24, top))} fill="#2f3237" stroke="#111" strokeWidth=".5" />
      <polygon points={pts(floorQuad(gx + 0.22, gy + 0.53, 0.52, 0.18, top + 0.6))} fill="#4b5058" />
      {(() => { const m = at(1.0, 0.72); return <Mug x={m.x} y={m.y} color={accent} />; })()}
      {(() => { const m = at(0.95, 0.3); return <PencilCup x={m.x} y={m.y} />; })()}
      {(() => { const m = at(0.15, 0.3); return <Books x={m.x} y={m.y} />; })()}
      {variant % 3 === 0 && (() => { const m = at(1.85, 0.75); return <Thermos x={m.x} y={m.y} />; })()}
      {variant % 3 === 1 && (() => { const m = at(0.12, 0.72); return <Lamp x={m.x} y={m.y} />; })()}
      {flowPhone && (() => { const m = at(0.55, 0.3); return <g><rect x={m.x - 7} y={m.y - 6} width="14" height="6" rx="2" fill="#1f2937" /><path d={`M${m.x - 7} ${m.y - 7} q7 -6 14 0`} stroke="#1f2937" strokeWidth="3" fill="none" /></g>; })()}
    </g>
  );
}
/** A metal shelving unit: uprights, boards, a back panel, binders with spine labels, archive boxes, and its sign board on top. */
export function ShelfPiece({ gx, gy, w = 2, label, variant = 0 }) {
  const H = 96; const d = 0.55; const fy = gy + 0.02;
  const binderSets = [['#2563eb', '#1d4ed8', '#3b82f6', '#16a34a', '#15803d', '#22c55e'], ['#dc2626', '#b91c1c', '#f59e0b', '#eab308', '#2563eb', '#16a34a'], ['#f59e0b', '#eab308', '#d97706', '#64748b', '#94a3b8', '#e5e7eb']][variant % 3];
  const boards = [0, 32, 64, 94];
  return (
    <g>
      <FloorShadow gx={gx} gy={fy} w={w} d={d} />
      <polygon points={pts(frontQuad(gx + 0.05, gx + w - 0.05, fy + 0.04, 0, H, true))} fill="#cfd5db" />
      {boards.slice(0, 3).map((z, si) => (
        <g key={z}>
          {Array.from({ length: 7 }, (_, i) => {
            const bw = (w - 0.2) / 7; const x0 = gx + 0.1 + i * bw;
            if (si === 1 && i >= 4) { if (i > 4) return null; return <Box key={i} gx={x0} gy={fy + 0.08} w={bw * 2.8} d={0.42} h={18} z={z + 3} color="#d9bd8f" top="#e7cfa6" shadow={false} />; }
            return (
              <g key={i}>
                <Box gx={x0} gy={fy + 0.1} w={bw * 0.86} d={0.42} h={23 - (i % 3)} z={z + 3} color={binderSets[(i + si * 2) % binderSets.length]} shadow={false} />
                <polygon points={pts(frontQuad(x0 + 0.03, x0 + bw * 0.7, fy + 0.52, z + 15, z + 20))} fill="#f8fafc" />
                <circle cx={P(x0 + bw * 0.43, fy + 0.52, z + 9).x} cy={P(x0 + bw * 0.43, fy + 0.52, z + 9).y} r="1.1" fill="#1f2937" />
              </g>
            );
          })}
        </g>
      ))}
      {boards.map((z) => <Box key={z} gx={gx + 0.04} gy={fy} w={w - 0.08} d={d} h={3} z={z} color="#a9b1bb" top="#c3cad2" shadow={false} />)}
      <Box gx={gx} gy={fy} w={0.07} d={d} h={H + 3} color="#8e97a3" shadow={false} />
      <Box gx={gx + w - 0.07} gy={fy} w={0.07} d={d} h={H + 3} color="#8e97a3" shadow={false} />
      <Box gx={gx + 0.15} gy={fy + 0.08} w={0.7} d={0.4} h={14} z={H + 3} color="#d8b88b" shadow={false} />
      <FrontBoard gx0={gx + 0.12} gx1={gx + w - 0.12} gy={fy + 0.32} z0={H + 18} z1={H + 36} text={label} />
    </g>
  );
}
/** Grey filing cabinets (Archivo) with drawers and its board. */
export function FilingPiece({ gx, gy, w = 2 }) {
  return (
    <g>
      {[0, 1].map((i) => <g key={i}><Box gx={gx + i * (w / 2) + 0.04} gy={gy + 0.05} w={w / 2 - 0.08} d={0.6} h={70} color="#a3acb6" top="#bfc6ce" right="#88929d" />
        {[0, 1, 2, 3].map((k) => <g key={k}><polygon points={pts(frontQuad(gx + i * (w / 2) + 0.12, gx + (i + 1) * (w / 2) - 0.12, gy + 0.655, 5 + k * 16, 18 + k * 16))} fill="#b3bbc4" stroke="#7b8590" strokeWidth=".6" /><polygon points={pts(frontQuad(gx + i * (w / 2) + 0.36, gx + (i + 1) * (w / 2) - 0.36, gy + 0.66, 12 + k * 16, 14.5 + k * 16))} fill="#4b5563" /></g>)}</g>)}
      <Box gx={gx + 0.3} gy={gy + 0.15} w={0.5} d={0.35} h={12} z={70} color="#d9bd8f" shadow={false} />
      <FrontBoard gx0={gx + 0.25} gx1={gx + w - 0.25} gy={gy + 0.35} z0={86} z1={102} text="ARCHIVO" />
    </g>
  );
}
/** The coordinator's counter base: wood with an inset front and an emblem (the chair and the person go behind). */
export function CounterBase({ gx, gy, w = 2 }) {
  const top = 34;
  const crest = P(gx + w * 0.72, gy + 0.9, 17);
  return (
    <g>
      <Box gx={gx} gy={gy + 0.1} w={w} d={0.8} h={top} color="#cf9b63" top="#e3b37c" left="#c88a4e" right="#a8753f" />
      <polygon points={pts(frontQuad(gx + 0.1, gx + w - 0.1, gy + 0.905, 5, top - 5))} fill="#dcae78" stroke="#a8753f" strokeWidth=".8" />
      <g transform={onFront(crest)}><circle r="8" fill="#f6ead9" stroke="#b37d47" strokeWidth="1.2" /><text y="3.2" textAnchor="middle" className="office-crest">⛓</text></g>
    </g>
  );
}
/** The counter's top: a monitor, coloured folders, low framed glass with highlights, the COORDINADOR board on the rail. */
export function CounterTop({ gx, gy, w = 2, bell, id }) {
  const top = 34;
  return (
    <g>
      <Screen id={`c${id}`} gx0={gx + 0.25} gx1={gx + 0.95} gy={gy + 0.42} z0={top + 12} z1={top + 30} />
      {['#fde68a', '#93c5fd', '#fca5a5'].map((c, i) => <polygon key={c} points={pts(frontQuad(gx + w - 0.55 + i * 0.12, gx + w - 0.45 + i * 0.12, gy + 0.55, top, top + 16 - i * 2))} fill={c} stroke={EDGE} strokeWidth=".5" />)}
      <polygon points={pts(frontQuad(gx + 0.05, gx + w - 0.05, gy + 0.25, top, top + 38, true))} fill="url(#of-glass)" opacity=".55" />
      <polygon points={pts([P(gx + 0.3, gy + 0.25, top + 4), P(gx + 0.45, gy + 0.25, top + 4), P(gx + 0.75, gy + 0.25, top + 34), P(gx + 0.6, gy + 0.25, top + 34)])} fill="#fff" opacity=".45" />
      <polygon points={pts([P(gx + 0.6, gy + 0.25, top + 4), P(gx + 0.66, gy + 0.25, top + 4), P(gx + 0.96, gy + 0.25, top + 34), P(gx + 0.9, gy + 0.25, top + 34)])} fill="#fff" opacity=".35" />
      <polygon points={pts(frontQuad(gx + 0.05, gx + w - 0.05, gy + 0.25, top, top + 38, true))} fill="none" stroke="#c4ccd3" strokeWidth="2" />
      <g className={bell ? 'office-ring' : undefined}><FrontBoard gx0={gx + 0.08} gx1={gx + w - 0.08} gy={gy + 0.25} z0={top + 40} z1={top + 56} text={bell ? '🔔 COORDINADOR' : 'COORDINADOR'} fontSize={9.5} /></g>
    </g>
  );
}
/** The turn display on a stand next to the counter: TURNO / VENT., red tickets, dim history. */
export function TurnDisplay({ gx, gy, tickets }) {
  const base = P(gx + 0.5, gy + 0.5); const w = 70; const h = 54; const top = base.y - 112;
  const rows = tickets.length ? tickets.slice(0, 3) : null;
  return (
    <g>
      <ellipse cx={base.x + 2} cy={base.y + 1} rx="10" ry="4" fill="rgba(92,62,32,.18)" />
      <ellipse cx={base.x} cy={base.y - 1} rx="8" ry="3" fill="#2a2e35" />
      <rect x={base.x - 2} y={top + h} width="4" height={112 - h} fill="#4b5563" />
      <rect x={base.x - w / 2} y={top} width={w} height={h} rx="4" fill="#111418" stroke="#3b4048" strokeWidth="2.5" filter="url(#of-soft)" />
      <text x={base.x - w / 2 + 6} y={top + 11} className="office-turn-head">TURNO</text>
      <text x={base.x + w / 2 - 6} y={top + 11} textAnchor="end" className="office-turn-head">VENT.</text>
      {rows ? rows.map((tk, i) => <g key={i} opacity={i ? 0.55 : 1}><text x={base.x - w / 2 + 6} y={top + 26 + i * 12} className="office-turn-num">{tk}</text><text x={base.x + w / 2 - 8} y={top + 26 + i * 12} textAnchor="end" className="office-turn-win">1</text></g>)
        : <text x={base.x - w / 2 + 6} y={top + 28} className="office-turn-idle">- - - -</text>}
    </g>
  );
}
/** The ticket kiosk (TURNOS): tall, a slanted screen with a hand, a ticket slot with a paper strip. */
export function KioskPiece({ gx, gy }) {
  return (
    <g pointerEvents="none">
      <Box gx={gx + 0.2} gy={gy + 0.2} w={0.6} d={0.5} h={72} color="#f1f4f7" top="#ffffff" left="#f1f4f7" right="#dfe4ea" />
      <polygon points={pts([P(gx + 0.28, gy + 0.71, 50), P(gx + 0.72, gy + 0.71, 50), P(gx + 0.72, gy + 0.6, 66), P(gx + 0.28, gy + 0.6, 66)])} fill="#2563eb" stroke="#1e40af" strokeWidth=".8" />
      <g transform={onFront(P(gx + 0.5, gy + 0.66, 58))}><text y="3" textAnchor="middle" className="office-kiosk">☝</text></g>
      <polygon points={pts(frontQuad(gx + 0.36, gx + 0.64, gy + 0.71, 29, 32))} fill="#1f2937" />
      <path d={`M${P(gx + 0.45, gy + 0.72, 29).x} ${P(gx + 0.45, gy + 0.72, 29).y} q2 7 7 9`} stroke="#fff" strokeWidth="3" fill="none" />
      {(() => { const l = P(gx + 0.5, gy + 0.5, 84); return <Plaque x={l.x} y={l.y} text="TURNOS" small />; })()}
    </g>
  );
}
/** A row of blue waiting chairs with chrome legs (seats; the backrests are drawn after the people). */
export function WaitingChairs({ gx, gy, w }) {
  return (
    <g pointerEvents="none">
      {Array.from({ length: w }, (_, i) => {
        const x0 = gx + i + 0.12; const x1 = gx + i + 0.88;
        return (
          <g key={i}>
            <FloorShadow gx={x0} gy={gy + 0.15} w={0.76} d={0.7} k={0.12} />
            <path d={`M${P(x0 + 0.05, gy + 0.2, 0).x} ${P(x0 + 0.05, gy + 0.2, 0).y} L${P(x0 + 0.05, gy + 0.2, 16).x} ${P(x0 + 0.05, gy + 0.2, 16).y} M${P(x1 - 0.05, gy + 0.8, 0).x} ${P(x1 - 0.05, gy + 0.8, 0).y} L${P(x1 - 0.05, gy + 0.8, 16).x} ${P(x1 - 0.05, gy + 0.8, 16).y}`} stroke="#9aa3ad" strokeWidth="1.6" />
            <Box gx={x0} gy={gy + 0.15} w={0.76} d={0.62} h={5} z={16} color="#2f56a6" top="#4a74c9" shadow={false} />
          </g>
        );
      })}
    </g>
  );
}
/** The backrests and armrests of the waiting chairs (on the near side: the people face the counter). */
export function WaitingBacks({ gx, gy, w }) {
  return (
    <g pointerEvents="none">
      {Array.from({ length: w }, (_, i) => <polygon key={i} points={pts(frontQuad(gx + i + 0.14, gx + i + 0.86, gy + 0.8, 20, 44, true))} fill="#2a4f96" stroke="#1d3a72" strokeWidth=".9" />)}
      {Array.from({ length: w + 1 }, (_, i) => <Box key={`a${i}`} gx={gx + i - 0.04} gy={gy + 0.3} w={0.08} d={0.45} h={2.5} z={27} color="#1f2937" shadow={false} />)}
    </g>
  );
}
/** One half of the Entrada/Salida cabinet with its wire tray, papers, label and (Salida) the rubber stamp. */
export function TrayPiece({ gx, gy, label, stamp }) {
  const top = 30;
  return (
    <g>
      <Box gx={gx + 0.04} gy={gy + 0.1} w={0.96} d={0.8} h={top} color="#e6dcc9" top="#f3eadb" right="#cbbda4" />
      {[0, 1].map((k) => <g key={k}><polygon points={pts(frontQuad(gx + 0.12, gx + 0.92, gy + 0.905, 4 + k * 13, 14 + k * 13))} fill="#ddd1bb" stroke="#bfae92" strokeWidth=".6" /><rect x={P(gx + 0.52, gy + 0.91, 9 + k * 13).x - 4} y={P(gx + 0.52, gy + 0.91, 9 + k * 13).y - 1} width="8" height="2" rx="1" fill="#8b7d68" /></g>)}
      <Box gx={gx + 0.12} gy={gy + 0.2} w={0.8} d={0.55} h={9} z={top} color="#9aa3ad" top="rgba(255,255,255,.4)" left="#aeb6bf" right="#8e97a3" shadow={false} />
      {[0, 1, 2].map((i) => <Box key={i} gx={gx + 0.18} gy={gy + 0.26} w={0.68} d={0.44} h={1.4} z={top + 1.5 + i * 1.6} color="#ffffff" stroke="rgba(0,0,0,.12)" shadow={false} />)}
      {(() => { const l = P(gx + 0.5, gy + 0.9, top - 8); return <Plaque x={l.x} y={l.y} text={label} small />; })()}
      {label === 'SALIDA' && (() => { const s = P(gx + 0.02, gy + 0.5, top); return <g><rect x={s.x - 3} y={s.y - 14} width="6" height="10" rx="3" fill="#b91c1c" /><rect x={s.x - 5.5} y={s.y - 5} width="11" height="5" rx="1" fill="#44403c" /></g>; })()}
      {stamp && (() => { const s = P(gx + 0.5, gy + 0.5, top + 30); return <g className={`office-stamp-badge ${stamp === 'APROBADO' ? 'ok' : 'bad'}`} transform={`rotate(-10 ${s.x} ${s.y})`}><rect x={s.x - 40} y={s.y - 12} width="80" height="24" rx="4" /><text x={s.x} y={s.y + 5} textAnchor="middle">{stamp}</text></g>; })()}
    </g>
  );
}
/** The low half-wall that closes the reception, with a glass strip and a top rail. */
export function HalfWall({ gx, gy, d }) {
  return (
    <g pointerEvents="none">
      <Box gx={gx} gy={gy} w={0.14} d={d} h={34} color="#e7d3b8" top="#f5e8d6" left="#e7d3b8" right="#d6bf9f" />
      <polygon points={pts(sideQuad(gx + 0.07, gy, gy + d, 34, 62, true))} fill="url(#of-glass)" opacity=".8" />
      <Box gx={gx + 0.03} gy={gy} w={0.08} d={d} h={2.5} z={62} color="#c4ccd3" shadow={false} />
      {[0.25, 0.5, 0.75].map((k) => <polygon key={k} points={pts(sideQuad(gx + 0.07, gy + d * k - 0.03, gy + d * k + 0.03, 34, 62, true))} fill="#c4ccd3" />)}
    </g>
  );
}
const leaf = (x, y, rot, s, fill) => <g key={`${x.toFixed(1)},${y.toFixed(1)},${rot}`} transform={`translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot}) scale(${s})`}><path d="M0 0 q6 -8 0 -18 q-6 10 0 18 Z" fill={fill} stroke="rgba(30,60,30,.35)" strokeWidth=".6" /><path d="M0 -1 L0 -15" stroke="#2f6b38" strokeWidth=".6" opacity=".6" /></g>;
/** Decor: plants (potted, a tall ficus, pothos on the shelf line), water cooler, coffee corner. */
export function DecorPiece({ kind, gx, gy }) {
  const c = P(gx + 0.5, gy + 0.5);
  if (kind === 'plant' || kind === 'ficus') {
    const tall = kind === 'ficus'; const potH = tall ? 18 : 14; const stem = tall ? 46 : 14;
    const fills = ['#3f8f4a', '#4ea35a', '#63bd6f'];
    const leaves = tall
      ? [[-8, -40, -60], [8, -44, 55], [-10, -54, -35], [10, -58, 30], [-4, -66, -15], [5, -70, 10], [-12, -72, -50], [12, -76, 45], [0, -82, 0], [-7, -84, -25], [7, -88, 20]]
      : [[-6, -20, -60], [6, -22, 55], [-8, -28, -35], [8, -30, 30], [-2, -34, -15], [3, -36, 10], [0, -40, 0], [-9, -36, -50], [9, -38, 45]];
    return (
      <g pointerEvents="none">
        <ellipse cx={c.x + 3} cy={c.y + 2} rx="12" ry="5" fill="rgba(92,62,32,.16)" />
        <path d={`M${c.x} ${c.y - potH} L${c.x} ${c.y - potH - stem}`} stroke="#4a6b2f" strokeWidth="1.6" />
        {leaves.map(([dx, dy, r], i) => leaf(c.x + dx * 0.6, c.y - potH + dy * (tall ? 0.95 : 1) + (tall ? 0 : 6), r, tall ? 1.05 : 0.85, fills[i % 3]))}
        <rect x={c.x - 8} y={c.y - potH} width="16" height={potH} rx="2.5" fill="#f4efe8" stroke="#c8bfb1" strokeWidth=".8" />
        <ellipse cx={c.x} cy={c.y - potH} rx="8" ry="2.6" fill="#e4ddd2" /><ellipse cx={c.x} cy={c.y - potH + 0.4} rx="6.5" ry="1.8" fill="#5b4632" />
      </g>
    );
  }
  if (kind === 'pothos') {
    const top = P(gx + 0.5, gy + 0.3, 100);
    return (
      <g pointerEvents="none">
        <Box gx={gx + 0.25} gy={gy + 0.1} w={0.5} d={0.4} h={12} z={88} color="#f4efe8" shadow={false} />
        <path d={`M${P(gx + 0.5, gy + 0.3, 0).x} ${P(gx + 0.5, gy + 0.3, 0).y} L${P(gx + 0.5, gy + 0.3, 88).x} ${P(gx + 0.5, gy + 0.3, 88).y}`} stroke="#9aa3ad" strokeWidth="2" />
        {[[-6, 46], [2, 62], [9, 38]].map(([dx, len], k) => (
          <g key={k}>
            <path d={`M${top.x + dx * 0.3} ${top.y} q${dx} ${len / 2} ${dx * 0.6} ${len}`} stroke="#4a6b2f" strokeWidth="1.1" fill="none" />
            {Array.from({ length: 7 }, (_, i) => leaf(top.x + dx * (0.3 + 0.1 * i), top.y + (len / 7) * (i + 0.6), (i % 2 ? 140 : 220), 0.45, ['#3f8f4a', '#5bb466'][i % 2]))}
          </g>
        ))}
        {[[-8, -6, -40], [6, -8, 35], [0, -12, 0]].map(([dx, dy, r]) => leaf(top.x + dx, top.y + dy + 4, r, 0.6, '#4ea35a'))}
      </g>
    );
  }
  if (kind === 'cooler') return (
    <g pointerEvents="none">
      <Box gx={gx + 0.25} gy={gy + 0.25} w={0.5} d={0.5} h={48} color="#f1f4f7" top="#ffffff" right="#cbd3db" />
      <path d={`M${c.x - 9} ${c.y - 62} q0 -18 9 -20 q9 2 9 20 l0 6 l-18 0 Z`} fill="#7cc4f2" opacity=".85" stroke="#4b9fd6" />
      <rect x={c.x - 3} y={c.y - 84} width="6" height="5" rx="1" fill="#4b9fd6" />
      <rect x={c.x - 6} y={c.y - 76} width="2.5" height="14" fill="#fff" opacity=".6" />
      <rect x={c.x - 5} y={c.y - 36} width="3.5" height="4" fill="#ef4444" /><rect x={c.x + 1.5} y={c.y - 36} width="3.5" height="4" fill="#3b82f6" />
    </g>
  );
  if (kind === 'coffee') return (
    <g pointerEvents="none">
      <FloorShadow gx={gx + 0.1} gy={gy + 0.15} w={0.8} d={0.7} k={0.12} />
      <path d={`M${P(gx + 0.15, gy + 0.85, 0).x} ${P(gx + 0.15, gy + 0.85, 0).y} l0 -24 M${P(gx + 0.85, gy + 0.85, 0).x} ${P(gx + 0.85, gy + 0.85, 0).y} l0 -24`} stroke="#9aa3ad" strokeWidth="1.6" />
      <Box gx={gx + 0.1} gy={gy + 0.15} w={0.8} d={0.7} h={4} z={24} color="#c99a63" top="#ddb07b" shadow={false} />
      <Box gx={gx + 0.28} gy={gy + 0.28} w={0.4} d={0.36} h={22} z={28} color="#2b2d31" top="#3a3d42" shadow={false} />
      {(() => { const m = P(gx + 0.8, gy + 0.7, 28); return <g>{[0, 1, 2].map((i) => <ellipse key={i} cx={m.x} cy={m.y - i * 3} rx="3.5" ry="1.3" fill="#fff" stroke="#cbd5e1" strokeWidth=".5" />)}</g>; })()}
      <Box gx={gx + 0.66} gy={gy - 0.38} w={0.3} d={0.3} h={14} color="#6b7280" />
      <text x={c.x + 4} y={c.y - 56} className="office-steam">☕</text>
    </g>
  );
  return null;
}
