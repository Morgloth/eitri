/* Minimal zip reader/writer that keeps every byte it doesn't change: local headers, compressed
 * data, central directory records and the end record are stored raw. Replacing an entry
 * re-deflates only that entry and patches its sizes, CRC and the offsets after it. No zip64. */
(function (G) {
  "use strict";
  const M = G.Eitri;

  function parse(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eo = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
    if (eo < 0) throw new Error("zip: no end record");
    const count = dv.getUint16(eo + 10, true), cdSize = dv.getUint32(eo + 12, true), cdOff = dv.getUint32(eo + 16, true);
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error("zip64 not supported");
    const entries = [];
    let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central record");
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const cen = b.slice(p, p + 46 + nl + xl + cl);
      const name = M.utf8.decode(b.subarray(p + 46, p + 46 + nl));
      const lo = dv.getUint32(p + 42, true), csize = dv.getUint32(p + 20, true);
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error("zip: bad local header for " + name);
      const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
      const dataAt = lo + 30 + lnl + lxl;
      let end = dataAt + csize;
      if (flags & 8) end += dv.getUint32(end, true) === 0x08074b50 ? 16 : 12; // data descriptor
      entries.push({ name, method, flags, lo, local: b.slice(lo, dataAt), data: b.slice(dataAt, dataAt + csize), desc: b.slice(dataAt + csize, end), cen, end });
      p += cen.length;
    }
    if (p !== cdOff + cdSize) throw new Error("zip: central directory size mismatch");
    /* Bytes between entries (rare) are kept so the layout survives. */
    const byOff = entries.slice().sort((x, y) => x.lo - y.lo);
    let pos = 0;
    for (const e of byOff) { e.gap = b.slice(pos, e.lo); pos = e.end; }
    return { entries: byOff, preCd: b.slice(pos, cdOff), eocd: b.slice(eo), order: entries.map((e) => e.name) };
  }

  M.Zip = {
    open(bytes) {
      const z = parse(bytes);
      const get = (name) => z.entries.find((e) => e.name === name);
      return {
        names: () => z.order.slice(),
        has: (name) => !!get(name),
        async read(name) {
          const e = get(name);
          if (!e) throw new Error("zip: no entry " + name);
          if (e.method === 0) return e.data.slice();
          if (e.method === 8) return M.inflateRaw(e.data);
          throw new Error("zip: method " + e.method + " not supported");
        },
        /* New uncompressed content for an existing entry. */
        async write(name, content) {
          const e = get(name);
          if (!e) throw new Error("zip: no entry " + name);
          if (e.flags & 8) throw new Error("zip: entries with data descriptors can't be rewritten");
          const data = e.method === 8 ? await M.deflateRaw(content) : content;
          const crc = M.crc32(content);
          for (const [h, o] of [[e.local, 14], [e.cen, 16]]) {
            const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
            dv.setUint32(o, crc, true); dv.setUint32(o + 4, data.length, true); dv.setUint32(o + 8, content.length, true);
          }
          e.data = data;
        },
        toBytes() {
          const parts = [];
          let off = 0;
          const push = (x) => { parts.push(x); off += x.length; };
          const newOff = new Map();
          for (const e of z.entries) { push(e.gap); newOff.set(e.name, off); push(e.local); push(e.data); push(e.desc); }
          push(z.preCd);
          const cdOff = off;
          for (const name of z.order) {
            const e = get(name);
            new DataView(e.cen.buffer, e.cen.byteOffset, e.cen.byteLength).setUint32(42, newOff.get(name), true);
            push(e.cen);
          }
          const eocd = z.eocd.slice();
          const dv = new DataView(eocd.buffer);
          dv.setUint32(12, off - cdOff, true); dv.setUint32(16, cdOff, true);
          parts.push(eocd);
          return M.concat(parts);
        },
      };
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
