/* Small synchronous AES (128/192/256) block cipher plus the modes Godot uses:
 * ECB (Godot 3 FileAccessEncrypted) and CFB-128 (Godot 4). WebCrypto has no CFB, so this is
 * plain JS. Not constant-time; it only ever sees the user's own save files. */
(function (G) {
  "use strict";
  const M = G.Eitri;

  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  (() => {
    let p = 1, q = 1;
    do {
      p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
      const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
      SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
  })();
  const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
  const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };

  function expand(key) {
    const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = nk; i < 4 * (nr + 1); i++) {
      let t = w.slice((i - 1) * 4, i * 4);
      if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
      else if (nk > 6 && i % nk === 4) t = t.map((x) => SBOX[x]);
      for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
    }
    return { w, nr };
  }

  function encBlock(k, inp, out) {
    const s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = inp[i] ^ k.w[i];
    for (let r = 1; r <= k.nr; r++) {
      const t = new Uint8Array(16);
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) % 4) * 4 + row]];
      if (r < k.nr) {
        for (let c = 0; c < 4; c++) {
          const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
          t[c * 4] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3;
          t[c * 4 + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3;
          t[c * 4 + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3;
          t[c * 4 + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3);
        }
      }
      for (let i = 0; i < 16; i++) s[i] = t[i] ^ k.w[r * 16 + i];
    }
    out.set(s);
  }
  function decBlock(k, inp, out) {
    let s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = inp[i] ^ k.w[k.nr * 16 + i];
    for (let r = k.nr - 1; r >= 0; r--) {
      const t = new Uint8Array(16);
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[((c + row) % 4) * 4 + row] = INV[s[c * 4 + row]];
      for (let i = 0; i < 16; i++) t[i] ^= k.w[r * 16 + i];
      if (r > 0) {
        for (let c = 0; c < 4; c++) {
          const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
          t[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
          t[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
          t[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
          t[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
        }
      }
      s = t;
    }
    out.set(s);
  }

  M.AES = {
    key: expand,
    encryptBlock: encBlock,
    decryptBlock: decBlock,
    ecb(key, data, decrypt) {
      const k = expand(key), out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 16) (decrypt ? decBlock : encBlock)(k, data.subarray(i, i + 16), out.subarray(i, i + 16));
      return out;
    },
    /* CFB-128 (mbedtls aes_crypt_cfb128, as Godot 4 uses it). */
    cfb(key, iv, data, decrypt) {
      const k = expand(key), out = new Uint8Array(data.length), reg = iv.slice(), ks = new Uint8Array(16);
      for (let i = 0; i < data.length; i += 16) {
        encBlock(k, reg, ks);
        const n = Math.min(16, data.length - i);
        for (let j = 0; j < n; j++) out[i + j] = data[i + j] ^ ks[j];
        reg.set((decrypt ? data : out).subarray(i, i + 16));
      }
      return out;
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
