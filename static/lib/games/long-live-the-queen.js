/* Long Live The Queen (Ren'Py 8.5). Every skill is stored twice in the store:
 * "store.dance_" is the real value, "store.dance" is what the skills screen shows. At the end of
 * a week the game recomputes the shown value from the real one, so an edit of only the shown
 * name reverts after training (in-game test 2026-11-09). Editing either name sets the other. */
(function (G) {
  "use strict";
  const M = G.Eitri;
  const get = (doc, p) => { try { return doc.get(p); } catch (e) { return undefined; } };
  const isNum = (v) => v !== undefined && v !== null && v !== "" && !isNaN(Number(v));

  M.registerRule({
    id: "long-live-the-queen-skills",
    game: "Long Live The Queen",
    plugin: "renpy",
    match(doc) {
      return isNum(get(doc, ["log", 0, "store.lassi"])) && isNum(get(doc, ["log", 0, "store.court_manners_"]));
    },
    notes: "Skills are stored twice (store.<skill> shown, store.<skill>_ real); editing one sets both.",
    linked(doc, change) {
      const p = change.path;
      if (p.length !== 3 || p[0] !== "log" || typeof p[2] !== "string" || !p[2].startsWith("store.")) return [];
      const name = p[2];
      const other = name.endsWith("_") ? name.slice(0, -1) : name + "_";
      const op = [p[0], p[1], other];
      const before = get(doc, op);
      if (!isNum(before) || !isNum(doc.get(p))) return [];
      if (Number(before) === Number(change.after)) return [];
      doc.set(op, change.after);
      return [{ path: op, before, after: doc.get(op) }];
    },
  });
})(typeof self !== "undefined" ? self : globalThis);
