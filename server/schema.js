// JSON Schema validation for step outputs (Ajv: draft-07 by default, draft 2020-12 when $schema says so).
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// strict: unknown keywords (typos like "requried") are schema errors, not silently ignored.
const opts = { allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true };
const ajv7 = addFormats(new Ajv(opts));
const ajv2020 = addFormats(new Ajv2020(opts));
const cache = new Map(); // schema JSON text -> compiled validator (one compile per schema, even with $id)

const fmt = (e) => {
  const at = '$' + (e.instancePath || '').replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.');
  if (e.keyword === 'required') return `${at}.${e.params.missingProperty}: requerido`;
  if (e.keyword === 'additionalProperties') return `${at}: propiedad no permitida "${e.params.additionalProperty}"`;
  if (e.keyword === 'enum') return `${at}: valor fuera de enum ${JSON.stringify(e.params.allowedValues)}`;
  return `${at}: ${e.message}`;
};

function compile(schema) {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (fn) return fn;
  const engine = /2020-12/.test(String(schema?.$schema || '')) ? ajv2020 : ajv7;
  // Strip $id so the same schema can be compiled again after an edit without "schema with key or id already exists".
  const { $id, ...rest } = schema && typeof schema === 'object' ? schema : {};
  fn = engine.compile(typeof schema === 'object' ? rest : schema);
  cache.set(key, fn);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return fn;
}

/** Validates v against a schema object. Returns a list of readable errors (max 20). */
export function validate(schema, v) {
  if (!schema || typeof schema !== 'object') return [];
  let fn;
  try { fn = compile(schema); } catch (e) { return [`Schema inválido: ${e.message}`]; }
  return fn(v) ? [] : (fn.errors || []).slice(0, 20).map(fmt);
}

/** Parses and compiles a schema given as text. Invalid JSON or an invalid schema is an error (not ignored). */
export function parseSchema(text) {
  if (!text?.trim()) return { schema: null };
  let schema;
  try { schema = JSON.parse(text); } catch (e) { return { error: 'Schema inválido (JSON): ' + e.message }; }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { error: 'Schema inválido: debe ser un objeto JSON' };
  try { compile(schema); } catch (e) { return { error: 'Schema inválido: ' + e.message }; }
  return { schema };
}
