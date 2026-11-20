// Spec 29 — 🏢 Oficina: who sits at each desk. Pure (no React, no DOM): imported by the view and by node tests.
// Every step gets a distinct character with a name, deterministic from its id (same flow → same office), editable
// through step.persona = {name?, look?{skin, hair, hairColor, top, bottom, accessory}} (look values are small integers).

/** FNV-1a 32-bit. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const COORDINATOR = 'Tomás';
export const NAMES = ['Lucía', 'Marta', 'Diego', 'Valeria', 'Bruno', 'Sofía', 'Mateo', 'Camila', 'Julián', 'Elena', 'Andrés', 'Paula', 'Nicolás', 'Carla', 'Joaquín', 'Inés', 'Gabriel', 'Renata', 'Martín', 'Florencia', 'Santiago', 'Ana', 'Facundo', 'Lola', 'Emilia', 'Ramiro', 'Julieta', 'Federico', 'Abril', 'Ignacio', 'Victoria', 'Tadeo', 'Olivia', 'Agustín', 'Pilar', 'Lautaro', 'Micaela', 'Hernán', 'Rocío', 'Gonzalo'];
/** A step's function suggests who sits there (the office of the reference illustration). */
const FUNCTION_NAMES = [[/an[aá]lisis|analiz/i, 'Lucía'], [/planific/i, 'Marta'], [/ejecu|automat/i, 'Diego'], [/revis/i, 'Valeria'], [/archiv/i, 'Bruno']];
export const PALETTE = {
  skin: ['#f7d6bd', '#eebf9c', '#d9a37a', '#bb8259', '#94603f', '#6a432c'],
  hair: ['short', 'long', 'bun', 'curly', 'bald', 'wavy'],
  hairColor: ['#2b1d14', '#5a3825', '#a0672f', '#d9a441', '#c4c4c4', '#7a1f1f', '#1f2f5a'],
  top: ['#2a9d8f', '#e9b23a', '#2f7d4f', '#7b4bc4', '#e07a3a', '#c94b4b', '#3b6fd8', '#d1557f', '#1f3a7a'],
  bottom: ['#2b3445', '#3d4656', '#5a4636', '#24365e'],
  accessory: ['none', 'glasses', 'glasses', 'headset', 'cap', 'scarf', 'earrings'],
  layer: ['none', 'blazer', 'cardigan', 'hoodie'],
};
export const LOOK_KEYS = Object.keys(PALETTE);
const pick = (list, v) => list[((Number(v) % list.length) + list.length) % list.length];
/** A look as palette VALUES (colours, styles) from indexes; any index is clamped modulo the palette. */
export const lookValues = (look) => Object.fromEntries(LOOK_KEYS.map((k) => [k, pick(PALETTE[k], look[k] ?? 0)]));
export function autoLook(id) {
  const h = hash32(String(id));
  return { skin: h % 6, hair: (h >>> 3) % 6, hairColor: (h >>> 6) % 7, top: (h >>> 9) % 9, bottom: (h >>> 12) % 4, accessory: (h >>> 15) % 7, layer: (h >>> 18) % 4 };
}
/** Map(stepId → {name, look (indexes), auto}). Steps in flow order (append-stable), names never repeat while there are names left. */
export function castOf(flow) {
  const cast = new Map(); const used = new Set([COORDINATOR]);
  const steps = flow?.steps || [];
  // names chosen by the person go first: an automatic name never takes one of them
  for (const s of steps) { const n = typeof s.persona?.name === 'string' ? s.persona.name.trim() : ''; if (n) used.add(n); }
  for (const s of steps) {
    const own = typeof s.persona?.name === 'string' ? s.persona.name.trim().slice(0, 40) : '';
    let name = own;
    if (!name) {
      const pref = FUNCTION_NAMES.find(([re]) => re.test(String(s.name || '')))?.[1];
      if (pref && !used.has(pref)) name = pref;
      else {
        const start = hash32(String(s.id)) % NAMES.length;
        for (let i = 0; i < NAMES.length && !name; i++) { const n = NAMES[(start + i) % NAMES.length]; if (!used.has(n)) name = n; }
        if (!name) name = `${NAMES[start]} ${steps.indexOf(s) + 1}`;
      }
      used.add(name);
    }
    const base = autoLook(s.id); const look = { ...base };
    const pl = s.persona?.look;
    if (pl && typeof pl === 'object') for (const k of LOOK_KEYS) if (Number.isInteger(pl[k])) look[k] = ((pl[k] % PALETTE[k].length) + PALETTE[k].length) % PALETTE[k].length;
    cast.set(s.id, { name, look, auto: !own && !pl });
  }
  return cast;
}
/** The sign on a desk: the step's function. */
export function deskSign(step) {
  if (step.kind === 'command') return 'Computadora';
  if (step.kind === 'flow') return 'Otro flujo';
  const n = String(step.name || '');
  for (const [re, label] of [[/an[aá]lisis|analiz/i, 'Análisis'], [/planific/i, 'Planificación'], [/ejecu|automat/i, 'Ejecución'], [/revis/i, 'Revisión'], [/archiv/i, 'Archivo']]) if (re.test(n)) return label;
  return n.slice(0, 22) || 'Escritorio';
}
export const KIND_LABEL = { role: 'Rol', skill: 'Skill', agent: 'Agente', command: 'Comando', flow: 'Flujo' };
