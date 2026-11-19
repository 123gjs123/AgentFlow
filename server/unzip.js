// Minimal, strict zip reader (spec 13 SKSRC-9): central directory only, stored/deflate, no zip64, no encryption, no
// symlinks. Every entry is validated before anything is returned; nothing is written here. buildZip() writes a stored
// zip (export of skills, tests).
import zlib from 'node:zlib';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const bad = (code, msg) => Object.assign(new Error(msg), { status: code === 'ZIP_TOO_BIG' || code === 'ZIP_TOO_MANY' ? 413 : 422, code });

/** A relative path that cannot escape its folder nor trick Windows (zip-slip, drive letters, UNC, ADS, reserved names). */
export function safeRel(name) {
  const n = String(name ?? '');
  if (!n || n.length > 400) return 'nombre vacío o demasiado largo';
  if (/[\x00-\x1f]/.test(n)) return 'caracteres de control';
  if (n.includes('\\')) return 'barra invertida';
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return 'ruta absoluta';
  if (n.includes(':')) return 'dos puntos (":")';
  const segs = n.replace(/\/$/, '').split('/');
  for (const s of segs) {
    if (!s) return 'segmento vacío';
    if (s === '..' || s === '.') return 'sale de la carpeta ("..")';
    if (RESERVED.test(s)) return `nombre reservado de Windows (${s})`;
    if (/[. ]$/.test(s)) return 'termina en punto o espacio';
    if (/~[0-9]/.test(s)) return 'parece un nombre corto de Windows (8.3)';
    if (/[<>"|?*]/.test(s)) return 'caracteres no válidos en Windows';
  }
  return null;
}

/**
 * Reads a zip buffer → [{ name, data }] (files only). Throws { status, code } errors: ZIP_TOO_BIG, ZIP_TOO_MANY,
 * ZIP_UNSAFE, ZIP_SYMLINK, ZIP_BAD.
 */
export function readZip(buf, { maxBytes = 20 * 1024 * 1024, maxFiles = 500, maxUnpacked = 50 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf)) throw bad('ZIP_BAD', 'No es un zip');
  if (buf.length > maxBytes) throw bad('ZIP_TOO_BIG', `El zip supera ${Math.round(maxBytes / 1048576)} MB`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('ZIP_BAD', 'El archivo no es un zip válido');
  const total = buf.readUInt16LE(eocd + 10); const cdSize = buf.readUInt32LE(eocd + 12); const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw bad('ZIP_BAD', 'Zip64 no soportado');
  if (cdOff + cdSize > buf.length) throw bad('ZIP_BAD', 'Zip truncado');
  const out = []; const seen = new Set(); let unpacked = 0; let files = 0;
  let p = cdOff;
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('ZIP_BAD', 'Directorio del zip dañado');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38); const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    const why = safeRel(name);
    if (why) throw bad('ZIP_UNSAFE', `El zip contiene una ruta peligrosa: ${name.slice(0, 200)} (${why})`);
    if (((ext >>> 16) & 0o170000) === 0o120000) throw bad('ZIP_SYMLINK', `El zip contiene un enlace simbólico: ${name.slice(0, 200)}`);
    if (name.endsWith('/')) continue; // folder entry
    if (flags & 1) throw bad('ZIP_BAD', `Entrada cifrada: ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw bad('ZIP_BAD', 'Zip64 no soportado');
    if (++files > maxFiles) throw bad('ZIP_TOO_MANY', `El zip tiene más de ${maxFiles} archivos`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw bad('ZIP_UNSAFE', `Dos entradas con el mismo nombre (sin distinguir mayúsculas): ${name}`);
    seen.add(key);
    unpacked += usize;
    if (unpacked > maxUnpacked) throw bad('ZIP_TOO_BIG', `El contenido descomprimido supera ${Math.round(maxUnpacked / 1048576)} MB`);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad('ZIP_BAD', `Entrada dañada: ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw bad('ZIP_BAD', `Entrada truncada: ${name}`);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }); } catch { throw bad('ZIP_BAD', `No se pudo descomprimir: ${name}`); } }
    else throw bad('ZIP_BAD', `Compresión no soportada (${method}): ${name}`);
    if (data.length !== usize || zlib.crc32(data) !== crc) throw bad('ZIP_BAD', `CRC o tamaño incorrecto: ${name}`);
    out.push({ name, data });
  }
  return out;
}

/** Stored (uncompressed) zip from [{ name, data, mode? }] — mode lets tests craft symlink entries. */
export function buildZip(entries) {
  const locals = []; const cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''));
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x031e, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, data); cds.push(cd, name); off += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(cds);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
