/* Godot encrypted files (FileAccess.open_encrypted_with_pass), "GDEC" magic.
 * Godot 4: GDEC | md5(plain) 16 | length u64 | iv 16 | AES-256-CFB(plain + zero pad to 16)
 * Godot 3: GDEC | mode u32 | md5(plain) 16 | length u64 | AES-256-ECB(plain + zero pad)
 * key = the 32 ASCII hex chars of md5(password). The password lives in the game's scripts
 * (Dome Keeper: SaveGame.gd SAVE_FILE_PASSWORD) and is a key file (*password*.txt), never in git.
 * The plaintext is handled by the JSON editor when it parses as JSON. */
(function (G) {
  "use strict";
  const M = G.Eitri;

  function passwords(ctx) {
    const out = [];
    for (const [n, b] of Object.entries((ctx && ctx.keys) || {})) if (/password/i.test(n)) out.push(M.latin1.decode(b).replace(/\r?\n$/, ""));
    return out.concat((ctx && ctx.godotPasswords) || []);
  }
  const keyOf = (pw) => M.latin1.encode(M.hex(M.md5(M.utf8.encode(pw))));

  function open(bytes, pw) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const key = keyOf(pw);
    /* Godot 4 layout */
    if (bytes.length >= 44 && (bytes.length - 44) % 16 === 0) {
      const md5 = bytes.slice(4, 20), len = Number(dv.getBigUint64(20, true)), iv = bytes.slice(28, 44);
      if (len <= bytes.length - 44) {
        const p = M.AES.cfb(key, iv, bytes.subarray(44), true);
        if (M.equal(M.md5(p.subarray(0, len)), md5)) return { v: 4, key, iv, plain: p.slice(0, len), pad: p.slice(len) };
      }
    }
    /* Godot 3 layout */
    if (bytes.length >= 32 && (bytes.length - 32) % 16 === 0) {
      const mode = dv.getUint32(4, true), md5 = bytes.slice(8, 24), len = Number(dv.getBigUint64(24, true));
      if (len <= bytes.length - 32) {
        const p = M.AES.ecb(key, bytes.subarray(32), true);
        if (M.equal(M.md5(p.subarray(0, len)), md5)) return { v: 3, key, mode, plain: p.slice(0, len), pad: p.slice(len) };
      }
    }
    return null;
  }

  function seal(e, plain) {
    const pad = M.equal(plain, e.plain) ? e.pad : new Uint8Array((16 - (plain.length % 16)) % 16);
    const body = M.concat([plain, pad]);
    const md5 = M.md5(plain);
    const len = new Uint8Array(8);
    new DataView(len.buffer).setBigUint64(0, BigInt(plain.length), true);
    const magic = M.latin1.encode("GDEC");
    if (e.v === 4) return M.concat([magic, md5, len, e.iv, M.AES.cfb(e.key, e.iv, body, false)]);
    const mode = new Uint8Array(4);
    new DataView(mode.buffer).setUint32(0, e.mode, true);
    return M.concat([magic, mode, md5, len, M.AES.ecb(e.key, body, false)]);
  }

  M.register({
    id: "godot-encrypted",
    name: "Godot encrypted (GDEC)",
    engine: "Godot 3 / 4",
    status: "tested",
    needsKey: "the game's encryption password as a key file (*password*.txt)",
    detect(f) { return M.startsWith(f.bytes, "GDEC") ? 45 : 0; },
    async decode(files, ctx) {
      const pws = passwords(ctx);
      if (!pws.length) throw new Error("encrypted Godot file: add the game's password as a key file (e.g. godot-password.txt)");
      const parts = files.map((f) => {
        let e = null;
        for (const pw of pws) if ((e = open(f.bytes, pw))) break;
        if (!e) throw new Error(f.name + ": none of the passwords decrypts this file (MD5 check failed)");
        let text = null;
        try { text = M.utf8.decode(e.plain); } catch (err) { /* binary */ }
        let doc = null;
        if (text !== null) { try { doc = M.LJSON.doc(text); } catch (err) { /* not JSON */ } }
        return { name: f.name, e, doc, root: doc ? doc.root : { kind: "bytes", value: e.plain, editable: false, note: "decrypted, not JSON" } };
      });
      const single = parts.length === 1;
      const root = single ? parts[0].root : { kind: "object", children: parts.map((p) => ({ key: p.name, node: p.root })) };
      const split = (path) => (single ? [parts[0], path] : [parts.find((p) => p.name === path[0]), path.slice(1)]);
      return {
        root, parts,
        note: parts.map((p) => `${p.name}: Godot ${p.e.v} ${p.e.v === 4 ? "AES-CFB" : "AES-ECB"}`).join(", "),
        get(path) { const [p, r] = split(path); return p.doc ? p.doc.get(r) : undefined; },
        node(path) { return M.findNode(root, path); },
        set(path, v) { const [p, r] = split(path); if (!p.doc) throw new Error("not editable (not JSON)"); p.doc.set(r, v); },
      };
    },
    async encode(doc) {
      return doc.parts.map((p) => ({ name: p.name, bytes: seal(p.e, p.doc ? M.utf8.encode(p.doc.toText()) : p.e.plain) }));
    },
    quickFields: () => [],
  });
})(typeof self !== "undefined" ? self : globalThis);
