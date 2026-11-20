/* Dome Keeper (Godot 4.3, GDEC saves; password = SaveGame.gd SAVE_FILE_PASSWORD, kept as a key file).
 * savegame_N.json = the current run; savegame4_<slot>.json = profile/meta state. No checksums
 * beyond the GDEC MD5, which the plugin rebuilds. savegame_N_map.scn (binary RSRC tiles) is not handled. */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const has = (doc, p) => { try { doc.node(p); return true; } catch (e) { return false; } };
  M.registerRule({
    id: "dome-keeper-quick",
    game: "Dome Keeper",
    plugin: "godot-encrypted",
    match: (doc) => doc.parts.length === 1 && (has(doc, ["Data", "inventory.iron"]) || has(doc, ["runCount"])),
    quickFields(doc) {
      if (has(doc, ["runCount"])) return [{ label: "Run count", path: ["runCount"] }];
      return [["Iron", "inventory.iron"], ["Water", "inventory.water"], ["Cobalt", "inventory.sand"]]
        .filter(([, k]) => has(doc, ["Data", k])).map(([label, k]) => ({ label, path: ["Data", k] }));
    },
    linked: () => [],
  });
})(typeof self !== "undefined" ? self : globalThis);
