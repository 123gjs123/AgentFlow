// Minimal JSON Schema validator (type, enum, required, properties, items, minItems): enough for step handoffs.
const typeOf = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : Number.isInteger(x) ? 'integer' : typeof x);

export function validate(schema, v, path = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  if (schema.type) {
    const t = typeOf(v); const types = [].concat(schema.type);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${path}: se esperaba ${types.join('|')}, llegó ${t}`];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: valor fuera de enum ${JSON.stringify(schema.enum)}`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${path}.${k}: requerido`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in v) errs.push(...validate(sub, v[k], `${path}.${k}`));
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${path}: mínimo ${schema.minItems} elementos`);
    if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  }
  return errs.slice(0, 20);
}

export function parseSchema(text) {
  if (!text?.trim()) return { schema: null };
  try { return { schema: JSON.parse(text) }; } catch (e) { return { error: 'Schema inválido: ' + e.message }; }
}
