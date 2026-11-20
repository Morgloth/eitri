/* Quick fields for the Unreal sample games (no linked fields known). Matched by save class. */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const cls = (doc) => (doc.note || "");
  const has = (doc, p) => { try { doc.node(p); return true; } catch (e) { return false; } };

  M.registerRule({
    id: "clair-obscur-quick",
    game: "Clair Obscur: Expedition 33",
    plugin: "gvas",
    match: (doc) => cls(doc).includes("BP_SaveGameObject_V3"),
    quickFields(doc) {
      const out = [{ label: "Gold", path: ["Gold"] }];
      try {
        doc.node(["CharactersCollection"]).children.forEach((c) => {
          const v = c.node.children.find((x) => x.key === "value").node;
          const lvl = v.children.find((x) => /^CurrentLevel_/.test(x.key));
          const name = c.node.children.find((x) => x.key === "key").node.value;
          if (lvl) out.push({ label: `${name} level`, path: ["CharactersCollection", c.key, "value", lvl.key] });
        });
      } catch (e) { /* layout changed */ }
      return out;
    },
    linked: () => [],
  });

  M.registerRule({
    id: "lies-of-p-quick",
    game: "Lies of P",
    plugin: "gvas",
    match: (doc) => cls(doc).includes("LCharacterSaveGame"),
    quickFields: (doc) => [["Level", ["CharacterSaveData", "PlayerLevel"]], ["Humanity", ["CharacterSaveData", "HumanityLevel"]], ["Dropped ergo", ["CharacterSaveData", "ErgoDropData", "RemainErgo"]]]
      .filter(([, p]) => has(doc, p)).map(([label, path]) => ({ label, path })),
    linked: () => [],
  });
})(typeof self !== "undefined" ? self : globalThis);
