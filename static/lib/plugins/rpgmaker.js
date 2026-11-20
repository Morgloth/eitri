/* RPG Maker MV (.rpgsave: LZString.compressToBase64 of JsonEx JSON) and MZ (.rmmzsave: zlib of JSON).
 * JsonEx wraps arrays as {"@c": id, "@a": [...]} and tags objects with "@c"; the tree shows them as-is
 * (the path to variable 5 is variables._data["@a"][5]). Needs vendor/lz-string.js (the game's own copy). */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const LZ = () => G.LZString;
  /* lz-string 1.3.x compressToBase64, as RPG Maker MV ships it: standard base64 of compress()'s 16-bit chars, high
   * byte first. lz-string 1.4+ ends the base64 differently, so only compress() comes from the library. */
  function toBase64(text) {
    const c = LZ().compress(text), b = new Uint8Array(c.length * 2);
    for (let i = 0; i < c.length; i++) { const v = c.charCodeAt(i); b[2 * i] = v >> 8; b[2 * i + 1] = v & 255; }
    return M.base64.encode(b);
  }

  /* JsonEx value -> plain value (drop "@c", unwrap "@a"); what the game's objects look like in memory. */
  M.jsonExPlain = function plain(v) {
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") {
      if (Array.isArray(v["@a"])) return v["@a"].map(plain);
      const o = {};
      for (const k of Object.keys(v)) if (k !== "@c") o[k] = plain(v[k]);
      return o;
    }
    return v;
  };

  function mvText(f) {
    if (M.ext(f.name) !== "rpgsave") return null;
    const s = M.latin1.decode(f.bytes);
    if (!/^[A-Za-z0-9+/]+=*$/.test(s)) return null;
    const t = LZ().decompressFromBase64(s);
    return t && (t[0] === "{" || t[0] === "[") ? t : null;
  }

  function quick(doc) {
    const out = [];
    const has = (p) => { try { doc.node(p); return true; } catch (e) { return false; } };
    if (has(["party", "_gold"])) out.push({ label: "Gold", path: ["party", "_gold"] });
    if (has(["party", "_steps"])) out.push({ label: "Steps", path: ["party", "_steps"] });
    try {
      const actors = doc.node(["actors", "_data", "@a"]);
      for (const c of actors.children) {
        if (c.node.kind !== "object") continue;
        const name = (c.node.children.find((x) => x.key === "_name") || {}).node;
        for (const [k, l] of [["_hp", "HP"], ["_mp", "MP"], ["_level", "Level"]]) {
          if (c.node.children.some((x) => x.key === k)) out.push({ label: `${name ? name.value : "Actor " + c.key} ${l}`, path: ["actors", "_data", "@a", c.key, k] });
        }
      }
    } catch (e) { /* not a game save (global/config) */ }
    return out;
  }

  M.register({
    id: "rpgmaker-mv",
    name: "RPG Maker MV",
    engine: "RPG Maker MV",
    status: "tested",
    detect(f) { try { return mvText(f) ? 30 : 0; } catch (e) { return 0; } },
    async decode(files) {
      if (files.length !== 1) throw new Error("RPG Maker: open one .rpgsave at a time");
      const f = files[0];
      const t = mvText(f);
      if (!t) throw new Error(f.name + ": not an LZString RPG Maker MV save");
      const d = M.LJSON.doc(t);
      d.name = f.name;
      return d;
    },
    async encode(doc) { return [{ name: doc.name, bytes: M.latin1.encode(toBase64(doc.toText())) }]; },
    quickFields: quick,
  });

  /* MZ: pako.deflate(json, {level: 1}). CompressionStream can't pick level 1, so an edited file
   * is valid zlib but not byte-identical; no sample yet. */
  M.register({
    id: "rpgmaker-mz",
    name: "RPG Maker MZ",
    engine: "RPG Maker MZ",
    status: "untested",
    detect(f) { return M.ext(f.name) === "rmmzsave" && f.bytes[0] === 0x78 ? 30 : 0; },
    async decode(files) {
      const f = files[0];
      const d = M.LJSON.doc(M.utf8.decode(await M.inflate(f.bytes)));
      d.name = f.name;
      d.untested = "no RPG Maker MZ sample yet: re-encoding is valid but not byte-identical";
      return d;
    },
    async encode(doc) { return [{ name: doc.name, bytes: await M.deflate(M.utf8.encode(doc.toText())) }]; },
    quickFields: quick,
  });
})(typeof self !== "undefined" ? self : globalThis);
