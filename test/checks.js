/* Extra checks after an edit, by name from samples.json. Return an error string or nothing. */
module.exports = {
  /* The re-decoded save must still carry a hash the game accepts (the rule only matches then). */
  ruleStillMatches(doc) {
    if (!doc.rules.length) return "no game rule matches the edited save (hash would be rejected)";
  },
  /* Edited Ren'Py save: the new signature must verify against the new log. */
  renpySigned(doc) {
    if (doc.signed !== true) return "signature does not verify after the edit";
  },
};
