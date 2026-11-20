/* Plain JSON saves (Godot store_string/store_line, Unity JsonUtility/Newtonsoft, libGDX prefs),
 * plus the "base64 of JSON XORed with a short key" wrapper (Slay the Spire 1).
 * Edits are spliced into the original text, so layout, CRLF, BOM and number spelling survive. */
(function (G) {
  "use strict";
  const M = G.Eitri;

  const QUICK = /^(_?gold|money|coins?|currency|cash|souls|ergo|gems?|crystals?|keys?|hp|max_?hp|current_?health|max_?health|health|xp|exp|level|floor|day|ascension_?level|current_?ascension_?level|max_?ascension_?level)$/i;

  /* Up to 12 leaves whose key looks like a resource (gold, hp, ...), shallowest first. */
  function guessQuick(root) {
    const out = [];
    const walk = (n, path, depth) => {
      if (depth > 4 || out.length >= 12 || !n.children) return;
      for (const c of n.children) {
        if (!c.node.children && typeof c.key === "string" && QUICK.test(c.key) && (c.node.kind === "number" || c.node.kind === "string")) {
          out.push({ label: c.key, path: path.concat([c.key]) });
        }
      }
      if (n.kind === "object") for (const c of n.children) if (c.node.children) walk(c.node, path.concat([c.key]), depth + 1);
    };
    walk(root, [], 0);
    return out;
  }

  /* Text from bytes: UTF-8 (with or without BOM). Returns {text, bom} or null. */
  function asText(bytes) {
    try {
      const t = M.utf8.decode(bytes);
      return t.charCodeAt(0) === 0xfeff ? { text: t.slice(1), bom: true } : { text: t, bom: false };
    } catch (e) {
      return null;
    }
  }
  const firstChar = (b) => { let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0; while (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13) i++; return b[i]; };

  /* One file -> {name, wrap, doc}. wrap = how to rebuild bytes from the JSON text. */
  function jsonFile(f) {
    const t = asText(f.bytes);
    if (!t) throw new Error(f.name + ": not UTF-8 text");
    const doc = M.LJSON.doc(t.text);
    return { name: f.name, doc, bom: t.bom };
  }

  function multiDoc(parts, toBytes) {
    const single = parts.length === 1;
    const root = single ? parts[0].doc.root : { kind: "object", children: parts.map((p) => ({ key: p.name, node: p.doc.root })) };
    const split = (path) => (single ? [parts[0], path] : [parts.find((p) => p.name === path[0]), path.slice(1)]);
    return {
      root,
      parts,
      get(path) { const [p, rest] = split(path); return p.doc.get(rest); },
      set(path, v) { const [p, rest] = split(path); p.doc.set(rest, v); },
      files: () => parts.map((p) => ({ name: p.name, bytes: toBytes(p) })),
    };
  }

  M.register({
    id: "json",
    name: "Plain JSON",
    engine: "Godot / Unity / libGDX / any",
    status: "tested",
    detect(f) {
      const c = firstChar(f.bytes);
      if (c !== 0x7b && c !== 0x5b) return 0;
      try { jsonFile(f); return 10; } catch (e) { return 0; }
    },
    async decode(files) {
      return multiDoc(files.map(jsonFile), (p) => {
        const b = M.utf8.encode(p.doc.toText());
        return p.bom ? M.concat([new Uint8Array([0xef, 0xbb, 0xbf]), b]) : b;
      });
    },
    async encode(doc) { return doc.files(); },
    quickFields: (doc) => guessQuick(doc.root),
  });

  /* ---- base64( JSON XOR key ) ---- */
  const KNOWN_KEYS = ["key"]; // Slay the Spire 1 (SaveFileObfuscator)
  const xor = (b, k) => { const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i] ^ k.charCodeAt(i % k.length); return o; };

  function unwrap(f, keys) {
    const s = M.latin1.decode(f.bytes);
    const tail = /\s*$/.exec(s)[0];
    const body = s.slice(0, s.length - tail.length);
    if (!M.base64.looksLike(body)) return null;
    const raw = M.base64.decode(body);
    if (!raw) return null;
    for (const k of keys) {
      const plain = xor(raw, k);
      const c = firstChar(plain);
      if (c !== 0x7b && c !== 0x5b) continue;
      const t = asText(plain);
      if (!t || t.bom) continue;
      try { return { name: f.name, key: k, tail, doc: M.LJSON.doc(t.text) }; } catch (e) { /* next key */ }
    }
    return null;
  }

  M.register({
    id: "json-xor",
    name: "Base64 + XOR JSON",
    engine: "libGDX (Slay the Spire)",
    status: "tested",
    detect(f) { return f.bytes.length < 64 << 20 && unwrap(f, KNOWN_KEYS) ? 20 : 0; },
    async decode(files, ctx = {}) {
      const keys = (ctx.xorKeys || []).concat(KNOWN_KEYS);
      const parts = files.map((f) => {
        const u = unwrap(f, keys);
        if (!u) throw new Error(f.name + ": not base64+XOR JSON with a known key");
        return u;
      });
      const d = multiDoc(parts, (p) => M.latin1.encode(M.base64.encode(xor(M.utf8.encode(p.doc.toText()), p.key)) + p.tail));
      d.note = "XOR key: " + parts.map((p) => JSON.stringify(p.key)).join(", ");
      return d;
    },
    async encode(doc) { return doc.files(); },
    quickFields: (doc) => guessQuick(doc.root),
  });
})(typeof self !== "undefined" ? self : globalThis);
