// Minimal block-YAML subset parser (no dependencies) used by the template verifier and the e2e suite.
// Covers what the generated CI templates use and rejects what would break a real YAML parser.
export function parseYaml(src) {
  const lines = [];
  src.split(/\r?\n/).forEach((raw, n) => {
    if (/^\s*\t/.test(raw)) throw new Error(`line ${n + 1}: tab indentation`);
    if (!raw.trim() || /^\s*#/.test(raw)) { lines.push({ n: n + 1, indent: -1, text: '', raw }); return; }
    lines.push({ n: n + 1, indent: raw.match(/^ */)[0].length, text: raw.trim(), raw });
  });
  let i = 0;
  const skip = () => { while (i < lines.length && lines[i].indent < 0) i++; };
  const err = (l, m) => { throw new Error(`line ${l.n}: ${m} → ${l.raw}`); };
  function scalar(s, l) {
    s = s.trim();
    if (s === '') return null;
    if (s.startsWith('"')) { const m = s.match(/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/); if (!m) err(l, 'unterminated or trailing text after double-quoted scalar'); return JSON.parse(`"${m[1]}"`); }
    if (s.startsWith("'")) { const m = s.match(/^'((?:[^']|'')*)'\s*(#.*)?$/); if (!m) err(l, 'bad single-quoted scalar'); return m[1].replace(/''/g, "'"); }
    if (s.startsWith('[')) { if (!s.endsWith(']')) err(l, 'unterminated flow sequence'); const body = s.slice(1, -1).trim(); return body ? body.split(',').map((x) => scalar(x, l)) : []; }
    if (/^[{&*!%@`|>]/.test(s)) err(l, `unsupported/indicator start "${s[0]}"`);
    const c = s.search(/\s#/); if (c >= 0) s = s.slice(0, c).trim();
    if (/:\s/.test(s) || s.endsWith(':')) err(l, 'plain scalar contains ": " (mapping values not allowed here)');
    return s;
  }
  function blockScalar(style, parentIndent) {
    const out = []; let bi = null;
    while (i < lines.length && (lines[i].indent < 0 || lines[i].indent > parentIndent)) {
      const l = lines[i];
      if (l.indent >= 0 && bi === null) bi = l.indent;
      out.push(l.indent < 0 ? '' : l.raw.slice(bi));
      i++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style.startsWith('|') ? out.join('\n') + (style === '|-' ? '' : '\n') : out.join(' ').replace(/ +\n/g, '\n');
  }
  function value(rest, l, indent) {
    if (/^[|>][-+]?$/.test(rest)) { i++; return blockScalar(rest, indent); }
    if (rest === '') {
      i++; skip();
      if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && /^- |^-$/.test(lines[i].text)))) return block(lines[i].indent);
      return null;
    }
    i++; return scalar(rest, l);
  }
  function block(indent) {
    skip();
    const first = lines[i];
    if (/^- |^-$/.test(first.text)) {
      const seq = [];
      while (i < lines.length) {
        skip(); const l = lines[i]; if (!l || l.indent < indent) break;
        if (l.indent > indent) err(l, 'bad indentation in sequence');
        if (!/^- |^-$/.test(l.text)) break;
        const rest = l.text.slice(1).trimStart();
        if (rest === '' ) { i++; skip(); seq.push(lines[i] && lines[i].indent > indent ? block(lines[i].indent) : null); continue; }
        if (/^[^"'[\s][^:]*:(\s|$)/.test(rest) && !/^[|>]/.test(rest)) { // "- key: v" → mapping item
          const off = l.raw.indexOf(rest);
          lines[i] = { ...l, indent: off, text: rest, raw: ' '.repeat(off) + rest };
          seq.push(block(off));
        } else if (/^[|>][-+]?$/.test(rest)) { i++; seq.push(blockScalar(rest, indent)); }
        else { i++; seq.push(scalar(rest, l)); }
      }
      return seq;
    }
    const map = {};
    while (i < lines.length) {
      skip(); const l = lines[i]; if (!l || l.indent < indent) break;
      if (l.indent > indent) err(l, 'bad indentation (deeper than its siblings)');
      if (/^- /.test(l.text)) break;
      const m = l.text.match(/^([^\s"'][^:]*?|"[^"]*"):(?:\s+(.*))?$/);
      if (!m) err(l, 'expected "key: value"');
      const key = m[1].replace(/^"|"$/g, '');
      if (key in map) err(l, `duplicate key "${key}"`);
      map[key] = value((m[2] || '').trim(), l, indent);
    }
    return map;
  }
  skip();
  const doc = block(lines[i]?.indent || 0);
  skip();
  if (i < lines.length) err(lines[i], 'unparsed content (indentation)');
  return doc;
}
