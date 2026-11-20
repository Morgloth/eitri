/* Ren'Py saves (.save = zip: screenshot.png, extra_info, json, renpy_version, log, signatures)
 * and the "persistent" file (zlib of a pickle). The pickle is read as data only (core/pickle.js).
 * Ren'Py 8.1+ signs the log: signatures = "signature <b64 SPKI> <b64 r||s>\n" per key,
 * ECDSA P-256 over SHA-1 of the log bytes (checked on Long Live The Queen, Ren'Py 8.5).
 * Re-signing an edited log needs the game's security_keys.txt (key file, never in git); without
 * it the game asks whether to trust the save. Untouched entries keep their compressed bytes. */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const SPKI_P256 = M.unhex("3059301306072a8648ce3d020106082a8648ce3d030107034200");

  function derLen(n) { return n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]; }
  function der(tag, body) { return M.concat([new Uint8Array([tag, ...derLen(body.length)]), body]); }
  /* SEC1 "EC PRIVATE KEY" (what python-ecdsa writes) -> PKCS#8 for WebCrypto. */
  function sec1ToPkcs8(sec1) {
    const alg = M.unhex("301306072a8648ce3d020106082a8648ce3d030107");
    return der(0x30, M.concat([M.unhex("020100"), alg, der(0x04, sec1)]));
  }
  const b64url = (s) => M.base64.decode(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

  /* security_keys.txt -> [{key: CryptoKey, spki: Uint8Array}] */
  async function signingKeys(ctx) {
    const f = ctx && ctx.keys && (ctx.keys["security_keys.txt"] || null);
    if (!f) return [];
    const subtle = G.crypto && G.crypto.subtle;
    if (!subtle) throw new Error("WebCrypto not available (needs https)");
    const out = [];
    for (const line of M.latin1.decode(f).split(/\r?\n/)) {
      const [kind, b64] = line.trim().split(/\s+/);
      if (kind !== "signing-key" || !b64) continue;
      const pk8 = sec1ToPkcs8(M.base64.decode(b64));
      const key = await subtle.importKey("pkcs8", pk8, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
      const jwk = await subtle.exportKey("jwk", key);
      out.push({ key, spki: M.concat([SPKI_P256, new Uint8Array([4]), b64url(jwk.x), b64url(jwk.y)]) });
    }
    return out;
  }

  async function sign(log, ctx) {
    const keys = await signingKeys(ctx);
    if (!keys.length) return null;
    let s = "";
    for (const k of keys) {
      const sig = new Uint8Array(await G.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, k.key, log));
      s += "signature " + M.base64.encode(k.spki) + " " + M.base64.encode(sig) + "\n";
    }
    return M.latin1.encode(s);
  }

  async function verify(log, sigText) {
    const subtle = G.crypto && G.crypto.subtle;
    if (!subtle) return null;
    for (const line of sigText.split("\n")) {
      const [kind, pk, sig] = line.trim().split(" ");
      if (kind !== "signature") continue;
      try {
        const k = await subtle.importKey("spki", M.base64.decode(pk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        if (await subtle.verify({ name: "ECDSA", hash: "SHA-1" }, k, M.base64.decode(sig), log)) return true;
      } catch (e) { /* try next */ }
    }
    return false;
  }

  const isZipSave = (f) => M.startsWith(f.bytes, "PK\x03\x04") && (() => { try { const z = M.Zip.open(f.bytes); return z.has("log") && z.has("renpy_version"); } catch (e) { return false; } })();
  const isPersistent = (f) => f.bytes[0] === 0x78 && /(^|[\\/])persistent$/.test(f.name);

  async function decodeSave(f) {
    const z = M.Zip.open(f.bytes);
    const logBytes = await z.read("log");
    const log = M.Pickle.doc(logBytes);
    const children = [{ key: "log", node: log.root }];
    let meta = null;
    if (z.has("json")) {
      meta = M.LJSON.doc(M.utf8.decode(await z.read("json")));
      children.push({ key: "json", node: meta.root });
    }
    const info = {};
    for (const n of ["renpy_version", "extra_info"]) if (z.has(n)) info[n] = M.latin1.decode(await z.read(n));
    for (const [k, v] of Object.entries(info)) children.push({ key: k, node: { kind: "string", value: v, editable: false } });
    const sigText = z.has("signatures") ? M.latin1.decode(await z.read("signatures")) : "";
    const signed = sigText ? await verify(logBytes, sigText) : null;
    return {
      kind: "save", name: f.name, z, log, logBytes, meta, signed,
      root: { kind: "object", children, note: signed === true ? "signature valid" : signed === false ? "signature does not verify" : "unsigned" },
    };
  }

  /* persistent = zlib(pickle) + (Ren'Py 8.1+) "signature ..." lines signing the pickle. */
  function splitTrailer(b) {
    const s = M.latin1.decode(b.subarray(Math.max(0, b.length - 8192)));
    const m = /(?:signature [A-Za-z0-9+/=]+ [A-Za-z0-9+/=]+\n)+$/.exec(s);
    const n = m ? m[0].length : 0;
    return { body: b.subarray(0, b.length - n), sigText: m ? m[0] : "" };
  }
  async function decodePersistent(f) {
    const { body, sigText } = splitTrailer(f.bytes);
    const raw = await M.inflate(body);
    const p = M.Pickle.doc(raw);
    const signed = sigText ? await verify(raw, sigText) : null;
    return { kind: "persistent", name: f.name, p, raw, body, sigText, signed, root: Object.assign(p.root, { note: signed === true ? "signature valid" : signed === false ? "signature does not verify" : "unsigned" }) };
  }

  M.register({
    id: "renpy",
    name: "Ren'Py",
    engine: "Ren'Py 7/8",
    status: "tested",
    detect(f) { return isZipSave(f) || isPersistent(f) ? 40 : 0; },
    async decode(files) {
      if (files.length !== 1) throw new Error("Ren'Py: open one file at a time");
      const f = files[0];
      const d = isZipSave(f) ? await decodeSave(f) : await decodePersistent(f);
      const split = (path) => {
        if (d.kind === "persistent") return [d.p, path];
        if (path[0] === "log") return [d.log, path.slice(1)];
        if (path[0] === "json" && d.meta) return [d.meta, path.slice(1)];
        return [null, path];
      };
      d.get = (path) => { const [t, rest] = split(path); return t ? t.get(rest) : M.findNode(d.root, path).value; };
      d.set = (path, v) => { const [t, rest] = split(path); if (!t) throw new Error("read-only: " + M.pathStr(path)); t.set(rest, v); };
      d.node = (path) => M.findNode(d.root, path);
      if (d.signed === false) d.warning = "The stored signature does not match this save.";
      return d;
    },
    async encode(d, ctx) {
      if (d.kind === "persistent") {
        const raw = d.p.toBytes();
        /* Ren'Py's zlib level can't be reproduced; unchanged pickle -> keep the original stream. */
        if (M.equal(raw, d.raw)) return [{ name: d.name, bytes: M.concat([d.body, M.latin1.encode(d.sigText)]) }];
        let sig = new Uint8Array(0);
        if (d.sigText) {
          sig = await sign(raw, ctx);
          if (!sig) { if (!(ctx && ctx.allowUnsigned)) throw new Error("re-signing needs the game's security_keys.txt"); sig = new Uint8Array(0); }
        }
        return [{ name: d.name, bytes: M.concat([await M.deflate(raw), sig]) }];
      }
      const log = d.log.toBytes();
      if (!M.equal(log, d.logBytes)) {
        await d.z.write("log", log);
        if (d.z.has("signatures")) {
          const sig = await sign(log, ctx);
          if (sig) await d.z.write("signatures", sig);
          else if (!(ctx && ctx.allowUnsigned)) throw new Error("re-signing needs the game's security_keys.txt (%APPDATA%\\RenPy\\tokens); without it the game will ask whether to trust this save");
        }
      }
      if (d.meta && d.meta.dirty()) await d.z.write("json", M.utf8.encode(d.meta.toText()));
      return [{ name: d.name, bytes: d.z.toBytes() }];
    },
    quickFields(d) {
      if (d.kind !== "save") return [];
      const store = d.log.root.children && d.log.root.children[0] && d.log.root.children[0].node;
      if (!store || !store.children) return [];
      const want = /^store\.(money|gold|cash|day|week|affection|love|points|score)$/i;
      return store.children.filter((c) => want.test(c.key) && !c.node.children).map((c) => ({ label: c.key.slice(6), path: ["log", 0, c.key] }));
    },
    sign, verify,
  });
})(typeof self !== "undefined" ? self : globalThis);
