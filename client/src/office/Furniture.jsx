// Spec 29: isometric furniture primitives (flat polygons in the app's CSS colours).
import React from 'react';
import { iso, TILE_H } from './layout.js';

const pts = (list) => list.map((p) => `${p.x},${p.y}`).join(' ');
/** An isometric box over w×h tiles from (gx, gy), `height` px tall. */
export function Box({ gx, gy, w = 1, h = 1, height = 18, top = 'var(--office-top)', left = 'var(--office-left)', right = 'var(--office-right)', children, className }) {
  const a = iso(gx, gy); const b = iso(gx + w, gy); const c = iso(gx + w, gy + h); const d = iso(gx, gy + h);
  const up = (p) => ({ x: p.x, y: p.y - height });
  return (
    <g className={className}>
      <polygon points={pts([d, c, up(c), up(d)])} fill={left} />
      <polygon points={pts([c, b, up(b), up(c)])} fill={right} />
      <polygon points={pts([up(a), up(b), up(c), up(d)])} fill={top} />
      {children}
    </g>
  );
}
/** The floor of a rectangle of tiles. */
export function Floor({ gx, gy, w, h, className = 'office-floor' }) {
  return <polygon className={className} points={pts([iso(gx, gy), iso(gx + w, gy), iso(gx + w, gy + h), iso(gx, gy + h)])} />;
}
/** Centre of a tile (where feet stand). */
export const center = (gx, gy) => { const p = iso(gx, gy); return { x: p.x, y: p.y + TILE_H / 2 }; };
/** Text label floating over a tile area. */
export function Sign({ gx, gy, w = 1, h = 1, dy = -30, children, className = 'office-sign' }) {
  const a = iso(gx + w / 2, gy + h / 2);
  return <text className={className} x={a.x} y={a.y + dy} textAnchor="middle">{children}</text>;
}
