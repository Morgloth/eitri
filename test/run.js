#!/usr/bin/env node
/* Eitri round-trip tests.
 *   node test/run.js [filter]                      made-up saves from test/make-fixtures.js (what CI runs)
 *   node test/run.js --samples DIR [filter]        your own saves, listed in test/samples.json (or --manifest FILE)
 * For every entry in the manifest: detect -> decode -> encode must give back the
 * original bytes exactly. Then each edit in the manifest is applied, encoded, decoded again,
 * and the tree diff must hold only the edited path and the linked fields the rules changed.
 * Samples are read-only; output goes only to a temp dir (kept when something fails).
 * Keys come from <samples>/keys/<game>/ and are never printed. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "../static/lib");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const OUT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "eitri-test-"));
let SAMPLES = opt("--samples") || process.env.EITRI_SAMPLES || null;
let MANIFEST = opt("--manifest");
if (!SAMPLES) {
  SAMPLES = path.join(OUT, "fixtures");
  require("child_process").execFileSync(process.execPath, [path.join(__dirname, "make-fixtures.js"), SAMPLES], { stdio: "ignore" });
  MANIFEST = MANIFEST || path.join(__dirname, "fixtures.json");
}
MANIFEST = MANIFEST || path.join(__dirname, "samples.json");

for (const f of require("./load-order.json")) require(path.join(ROOT, f));
const M = globalThis.Eitri;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const filter = args[0] || "";

function keysFor(game) {
  const dir = path.join(SAMPLES, "keys", game);
  const keys = {};
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) keys[n] = new Uint8Array(fs.readFileSync(path.join(dir, n)));
  return keys;
}
const load = (rel) => ({ name: path.basename(rel), bytes: new Uint8Array(fs.readFileSync(path.join(SAMPLES, rel))) });
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 40 ? s.slice(0, 37) + "..." : s; };

let pass = 0, fail = 0, untested = 0;
const results = [];
function report(ok, label, msg) {
  if (ok === null) { untested++; console.log(`  UNTESTED ${label}${msg ? ": " + msg : ""}`); }
  else if (ok) { pass++; console.log(`  ok   ${label}${msg ? "  " + msg : ""}`); }
  else { fail++; console.log(`  FAIL ${label}: ${msg}`); }
  results.push({ ok, label, msg });
}

(async () => {
  for (const s of manifest) {
    const label = s.files.join(" + ");
    if (filter && !label.includes(filter) && s.plugin !== filter) continue;
    const game = s.files[0].split("/")[0];
    const ctx = { keys: keysFor(game) };
    let files;
    try { files = s.files.map(load); } catch (e) { report(false, label, "cannot read sample: " + e.message); continue; }
    console.log(`${label}  [${s.plugin}]`);

    const det = M.detect(files);
    if (!det || det.plugin.id !== s.plugin) {
      report(s.status === "untested" ? null : false, "detect", `got ${det ? det.plugin.id : "nothing"}, want ${s.plugin}`);
      if (s.status === "untested") continue;
    } else report(true, "detect", `priority ${det.priority}`);

    let doc;
    try {
      doc = await M.open(files, ctx, s.plugin);
    } catch (e) {
      report(s.status === "untested" ? null : false, "decode", e.message);
      continue;
    }
    if (doc.untested) { report(null, "decode", doc.untested); continue; }
    if (s.rule) report(doc.rules.some((r) => r.id === s.rule), "rule", s.rule);

    let out;
    try { out = await M.plugins.find((p) => p.id === s.plugin).encode(doc, ctx); } catch (e) { report(false, "encode", e.stack); continue; }
    let same = out.length === files.length;
    for (let i = 0; i < files.length && same; i++) {
      const o = out.find((x) => x.name === files[i].name);
      if (!o || !M.equal(o.bytes, files[i].bytes)) {
        same = false;
        const dst = path.join(OUT, game, files[i].name);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (o) fs.writeFileSync(dst, o.bytes);
        report(false, "round trip", o ? `${files[i].name}: first difference at byte ${M.firstDiff(o.bytes, files[i].bytes)} (${o.bytes.length} vs ${files[i].bytes.length} bytes), output in ${dst}` : `${files[i].name} missing from output`);
      }
    }
    if (same) report(true, "round trip", `${files.reduce((n, f) => n + f.bytes.length, 0)} bytes identical, ${M.leaves(doc.root).length} fields`);

    const qf = M.quickFields(doc);
    if (s.quick) for (const q of s.quick) report(qf.some((x) => x.label === q), "quick field", q);

    for (const e of s.edits || []) {
      const elabel = `edit ${M.pathStr(e.path)} -> ${short(e.value)}`;
      try {
        const d = await M.open(files, ctx, s.plugin);
        const before = M.toValue(d.root);
        const ch = M.edit(d, e.path, e.value);
        const enc = await M.plugins.find((p) => p.id === s.plugin).encode(d, ctx);
        const d2 = await M.open(enc, ctx, s.plugin);
        const after = d2.get(e.path);
        const want = String(e.expect !== undefined ? e.expect : e.value);
        if (String(after) !== want) { report(false, elabel, `read back ${short(after)}`); continue; }
        const allowed = new Set(ch.map((c) => M.pathStr(c.path)));
        const orig = await M.open(files, ctx, s.plugin);
        const diff = M.diff(orig.root, d2.root).filter((x) => !(e.ignore || []).some((p) => x.path.startsWith(p)));
        const extra = diff.filter((x) => !allowed.has(x.path));
        if (extra.length) { report(false, elabel, "unexpected changes: " + extra.slice(0, 5).map((x) => `${x.path} ${short(x.before)} -> ${short(x.after)}`).join("; ")); continue; }
        for (const want of e.linked || []) if (!ch.some((c) => c.linked && M.pathStr(c.path) === want)) { report(false, elabel, "linked field not updated: " + want); continue; }
        if (e.check) {
          const msg = await require(path.join(__dirname, "checks.js"))[e.check](d2, M, ctx);
          if (msg) { report(false, elabel, msg); continue; }
        }
        const linked = ch.filter((c) => c.linked).map((c) => M.pathStr(c.path));
        report(true, elabel, (linked.length ? `linked: ${linked.join(", ")}; ` : "") + `${diff.length} field(s) changed` + (e.check ? `, ${e.check} ok` : ""));
        void before;
      } catch (err) {
        report(false, elabel, err.stack.split("\n").slice(0, 3).join(" | "));
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${untested} untested. Temp dir: ${OUT}`);
  if (!fail) fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
