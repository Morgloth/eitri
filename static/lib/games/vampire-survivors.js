/* Vampire Survivors (Unity 6, saves via Steam Cloud: userdata\<id>\1794680\remote\SaveData, SaveData2).
 * Single-line JSON with "checksum" = lowercase hex SHA-256 of the exact file bytes with the
 * checksum value set to "" (found 2026-11-03, holds for both samples). Rebuilt after every edit. */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const CK = ["checksum"];

  function compute(doc) {
    const part = doc.parts[0].doc;
    const keep = part.get(CK);
    part.set(CK, "");
    const h = M.hex(M.sha256(M.utf8.encode(part.toText())));
    part.set(CK, keep);
    return h;
  }

  M.registerRule({
    id: "vampire-survivors-checksum",
    game: "Vampire Survivors",
    plugin: "json",
    match(doc) {
      if (!doc.parts || doc.parts.length !== 1 || doc.parts[0].bom) return false;
      const c = doc.get(CK);
      return typeof c === "string" && /^[0-9a-f]{64}$/.test(c) && doc.get(["saveName"]) !== undefined && compute(doc) === c;
    },
    quickFields: () => [{ label: "Coins", path: ["Coins"] }, { label: "Lifetime coins", path: ["LifetimeCoins"] }],
    notes: "checksum = SHA-256 of the file with checksum set to \"\"; rebuilt automatically.",
    linked(doc, change) {
      if (M.pathStr(change.path) === "checksum") return [];
      const before = doc.get(CK);
      const after = compute(doc);
      if (after === before) return [];
      doc.set(CK, after);
      return [{ path: CK, before, after }];
    },
  });
})(typeof self !== "undefined" ? self : globalThis);
