/* Eitri core: plugin registry, byte helpers and the lossless JSON editor.
 * Browser-safe (plain ES2020, no node APIs). Load before any plugin.
 *
 * Plugin shape (see README.md):
 *   { id, name, engine, status: "tested" | "untested",
 *     detect(file) -> priority (0 = not mine),          file = {name, bytes: Uint8Array}
 *     async decode(files, ctx) -> doc,                   files = [{name, bytes}], ctx = {keys:{name: bytes}}
 *     async encode(doc, ctx) -> [{name, bytes}],
 *     quickFields(doc) -> [{label, path}] }
 * doc: { plugin, root (generic node), get(path), set(path, value), changes[] }
 * generic node: { kind: object|array|string|number|bool|null|bytes|other,
 *                 value?, children?: [{key, node}], editable?, note? }
 */
(function (G) {
  "use strict";
  const M = (G.Eitri = G.Eitri || {});
  M.plugins = M.plugins || [];
  M.rules = M.rules || [];

  M.register = (p) => {
    M.plugins = M.plugins.filter((x) => x.id !== p.id);
    M.plugins.push(p);
  };
  /* Game rules: { id, game, plugin, match(doc) -> bool, quickFields?, linked(doc, change) } */
  M.registerRule = (r) => {
    M.rules = M.rules.filter((x) => x.id !== r.id);
    M.rules.push(r);
  };

  /* Pick the plugin for a set of files: highest detect() priority over all files. */
  M.detect = (files) => {
    let best = null;
    for (const p of M.plugins) {
      for (const f of files) {
        let pr = 0;
        try { pr = p.detect(f) || 0; } catch (e) { pr = 0; }
        if (pr > 0 && (!best || pr > best.priority)) best = { plugin: p, priority: pr, file: f.name };
      }
    }
    return best;
  };

  M.open = async (files, ctx = {}, pluginId = null) => {
    const p = pluginId ? M.plugins.find((x) => x.id === pluginId) : (M.detect(files) || {}).plugin;
    if (!p) throw new Error("no plugin recognises these files");
    const doc = await p.decode(files, ctx);
    doc.plugin = p.id;
    doc.changes = doc.changes || [];
    doc.rules = M.rules.filter((r) => r.plugin === p.id && safe(() => r.match(doc)));
    return doc;
  };
  const safe = (f) => { try { return f(); } catch (e) { return false; } };

  /* Edit through here so game rules can update linked fields. Returns the change list. */
  M.edit = (doc, path, value) => {
    const before = doc.get(path);
    doc.set(path, value);
    const ch = [{ path, before, after: doc.get(path), linked: false }];
    for (const r of doc.rules || []) {
      for (const l of r.linked(doc, { path, before, after: value }) || []) {
        ch.push({ path: l.path, before: l.before, after: l.after, linked: true, rule: r.id });
      }
    }
    doc.changes.push(...ch);
    return ch;
  };

  M.quickFields = (doc) => {
    const p = M.plugins.find((x) => x.id === doc.plugin);
    const out = p && p.quickFields ? p.quickFields(doc) : [];
    for (const r of doc.rules || []) if (r.quickFields) out.unshift(...r.quickFields(doc));
    const seen = new Set(); // a rule and its plugin can name the same field: keep the first (the rule's)
    return out.filter((q) => { const k = M.pathStr(q.path); return seen.has(k) ? false : (seen.add(k), true); });
  };

  /* ---------- paths ---------- */
  M.pathStr = (path) =>
    path.map((k, i) => (typeof k === "number" ? `[${k}]` : /^[A-Za-z_$@][\w$@]*$/.test(k) ? (i ? "." : "") + k : `[${JSON.stringify(k)}]`)).join("");

  M.findNode = (root, path) => {
    let n = root;
    for (const k of path) {
      if (!n || !n.children) throw new Error("no such path: " + M.pathStr(path));
      const c = typeof k === "number" && n.kind === "array" ? n.children[k] : n.children.find((x) => x.key === k);
      if (!c) throw new Error("no such path: " + M.pathStr(path));
      n = c.node;
    }
    return n;
  };

  /* Flat list of leaf values: [{path, kind, value}] (for search and diff). */
  M.leaves = (root, out = [], path = []) => {
    if (root.children) for (const c of root.children) M.leaves(c.node, out, path.concat([c.key]));
    else out.push({ path, kind: root.kind, value: root.kind === "bytes" ? M.hex(root.value) : root.value });
    return out;
  };

  /* Paths whose leaf values differ between two trees. */
  M.diff = (a, b) => {
    const la = new Map(M.leaves(a).map((l) => [M.pathStr(l.path), l]));
    const lb = new Map(M.leaves(b).map((l) => [M.pathStr(l.path), l]));
    const out = [];
    for (const [k, l] of la) {
      const r = lb.get(k);
      if (!r) out.push({ path: k, before: l.value, after: undefined });
      else if (String(r.value) !== String(l.value) || r.kind !== l.kind) out.push({ path: k, before: l.value, after: r.value });
    }
    for (const [k, r] of lb) if (!la.has(k)) out.push({ path: k, before: undefined, after: r.value });
    return out;
  };

  /* ---------- bytes ---------- */
  const td = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const te = new TextEncoder();
  M.utf8 = { decode: (b) => td.decode(b), encode: (s) => te.encode(s) };
  M.latin1 = {
    decode: (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; },
    encode: (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; },
  };
  M.equal = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  M.firstDiff = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; };
  M.concat = (parts) => {
    let n = 0; for (const p of parts) n += p.length;
    const o = new Uint8Array(n); let i = 0;
    for (const p of parts) { o.set(p, i); i += p.length; }
    return o;
  };
  M.hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  M.unhex = (s) => { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  M.startsWith = (b, s) => { if (b.length < s.length) return false; for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false; return true; };
  M.ext = (name) => { const m = /\.([^.]+)$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; };

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64I = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;
  M.base64 = {
    encode(b) {
      let s = "";
      for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
        s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
      }
      return s;
    },
    /* Strict: only the alphabet and trailing '='. Returns null when the text isn't base64. */
    decode(s) {
      s = String(s);
      if (s.length % 4 === 1) return null;
      const out = new Uint8Array(Math.floor((s.length * 3) / 4));
      let o = 0, acc = 0, bits = 0, pad = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61) { pad++; continue; }
        if (pad) return null;
        const v = c < 256 ? B64I[c] : -1;
        if (v < 0) return null;
        acc = (acc << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
      }
      return out.subarray(0, o);
    },
    looksLike: (s) => s.length >= 8 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s),
  };

  /* ---------- compression (CompressionStream: Firefox 113+, Chrome 103+, node 18+) ---------- */
  async function stream(bytes, ctor, fmt) {
    const s = new Blob([bytes]).stream().pipeThrough(new ctor(fmt));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  M.inflateRaw = (b) => stream(b, DecompressionStream, "deflate-raw");
  M.deflateRaw = (b) => stream(b, CompressionStream, "deflate-raw");
  M.inflate = (b) => stream(b, DecompressionStream, "deflate");
  M.deflate = (b) => stream(b, CompressionStream, "deflate");

  /* ---------- hashes (sync, small) ---------- */
  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  M.crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  M.sha256 = (msg) => {
    const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(nb); m.set(msg); m[l] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(nb - 4, (l * 8) >>> 0); dv.setUint32(nb - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64);
    const r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32); const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  };

  M.md5 = (msg) => {
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Uint32Array(64); for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(nb); m.set(msg); m[l] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(nb - 8, (l * 8) >>> 0, true); dv.setUint32(nb - 4, Math.floor(l / 0x20000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < nb; o += 64) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + dv.getUint32(o + g * 4, true)) >>> 0;
        A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16); const ov = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
    return out;
  };

  /* ---------- lossless JSON ----------
   * Parses JSON text into generic nodes that remember where each value sits in the text.
   * Editing a scalar records a replacement for its span; serialising splices the replacements
   * into the original text, so untouched bytes (whitespace, CRLF, escapes, number spelling,
   * 64-bit ints) stay exactly as they were. */
  M.LJSON = {
    parse(text) {
      let i = 0;
      const ws = () => { for (;;) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
      const fail = (m) => { throw new Error(`JSON: ${m} at ${i}`); };
      const str = () => {
        const s = i; i++;
        for (;;) {
          const c = text.charCodeAt(i);
          if (c === 34) break;
          if (c === 92) i += 2; else if (Number.isNaN(c)) fail("unterminated string"); else i++;
        }
        i++;
        return text.slice(s, i);
      };
      const val = () => {
        ws();
        const s = i, c = text[i];
        if (c === "{") {
          i++; const children = []; ws();
          if (text[i] === "}") { i++; return { kind: "object", children, start: s, end: i }; }
          for (;;) {
            ws();
            /* OdinSerializer JSON (Inscryption) puts bare values inside objects
             * ("$type": "...", 0.5, 0.3). They get the key "#<index>". */
            if (text[i] !== '"') { children.push({ key: "#" + children.length, node: val(), keyless: true }); }
            else {
              const ks = i, kraw = str(); ws();
              if (text[i] === ":") { i++; children.push({ key: JSON.parse(kraw), node: val() }); }
              else { i = ks; children.push({ key: "#" + children.length, node: val(), keyless: true }); }
            }
            ws();
            if (text[i] === ",") { i++; continue; }
            if (text[i] === "}") { i++; break; }
            fail("expected , or }");
          }
          return { kind: "object", children, start: s, end: i };
        }
        if (c === "[") {
          i++; const children = []; ws();
          if (text[i] === "]") { i++; return { kind: "array", children, start: s, end: i }; }
          for (;;) {
            children.push({ key: children.length, node: val() });
            ws();
            if (text[i] === ",") { i++; continue; }
            if (text[i] === "]") { i++; break; }
            fail("expected , or ]");
          }
          return { kind: "array", children, start: s, end: i };
        }
        if (c === '"') { const raw = str(); return { kind: "string", value: JSON.parse(raw), raw, start: s, end: i, editable: true }; }
        const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
        if (m) { i += m[0].length; return { kind: "number", value: m[0], raw: m[0], start: s, end: i, editable: true }; }
        const odin = /^\$[a-z]+:[^\s,\]}]*/.exec(text.slice(i, i + 64)); // OdinSerializer $iref:75
        if (odin) { i += odin[0].length; return { kind: "other", value: odin[0], raw: odin[0], start: s, end: i, note: "Odin reference" }; }
        for (const [w, kind, v] of [["true", "bool", true], ["false", "bool", false], ["null", "null", null]]) {
          if (text.startsWith(w, i)) { i += w.length; return { kind, value: v, raw: w, start: s, end: i, editable: true }; }
        }
        return fail("unexpected " + JSON.stringify(c));
      };
      /* Several values one after another (Godot store_line style, e.g. Brotato save.json)
       * become a "sequence" array node. */
      const first = val();
      ws();
      if (i === text.length) return { root: first };
      const children = [{ key: 0, node: first }];
      while (i < text.length) { children.push({ key: children.length, node: val() }); ws(); }
      return { root: { kind: "array", sequence: true, children, start: 0, end: text.length, note: "several JSON values in one file" } };
    },

    /* Raw JSON spelling for a new scalar value; numbers stay strings so 64-bit ints survive. */
    raw(node, value) {
      if (value === null) return "null";
      if (typeof value === "boolean") return value ? "true" : "false";
      if (node.kind === "number" || typeof value === "number") {
        const s = String(value).trim();
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) throw new Error("not a number: " + s);
        /* Keep the float spelling (Newtonsoft writes 39779.0): an integer typed over a float gets ".0". */
        if (node.kind === "number" && /^-?\d+\.\d+$/.test(node.raw || "") && /^-?\d+$/.test(s)) return s + ".0";
        return s;
      }
      return JSON.stringify(String(value));
    },

    /* A document over JSON text: get/set by path, toText() splices the edits in. */
    doc(text) {
      const { root } = M.LJSON.parse(text);
      const edits = new Map();
      return {
        root,
        text,
        get(path) { const n = M.findNode(root, path); return n.children ? undefined : n.value; },
        node(path) { return M.findNode(root, path); },
        set(path, value) {
          const n = M.findNode(root, path);
          if (n.children) throw new Error("only scalar values can be edited: " + M.pathStr(path));
          const raw = M.LJSON.raw(n, value);
          const p = M.LJSON.parse(raw).root;
          n.kind = p.kind; n.value = p.value; n.raw = raw;
          edits.set(n.start, { start: n.start, end: n.end, raw });
        },
        dirty: () => edits.size > 0,
        toText() {
          if (!edits.size) return text;
          const list = [...edits.values()].sort((a, b) => a.start - b.start);
          let out = "", pos = 0;
          for (const e of list) { out += text.slice(pos, e.start) + e.raw; pos = e.end; }
          return out + text.slice(pos);
        },
      };
    },
  };

  /* Plain JS value from a generic node (numbers as Number; unsafe ints stay strings). */
  M.toValue = (n) => {
    if (n.kind === "object") { const o = {}; for (const c of n.children) o[c.key] = M.toValue(c.node); return o; }
    if (n.kind === "array") return n.children.map((c) => M.toValue(c.node));
    if (n.kind === "number") { const v = Number(n.value); return Number.isSafeInteger(v) || !/^-?\d+$/.test(n.value) ? v : n.value; }
    return n.value;
  };

  /* Search leaves by name or value (case-insensitive substring). */
  M.search = (root, q) => {
    q = String(q).toLowerCase();
    return M.leaves(root).filter((l) => M.pathStr(l.path).toLowerCase().includes(q) || String(l.value).toLowerCase().includes(q));
  };
})(typeof self !== "undefined" ? self : globalThis);
