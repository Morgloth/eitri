#!/usr/bin/env node
/* Make an edited save for the in-game load tests, the same way the page will.
 *   node test/make-edit.js --out DIR [--keys DIR] [--plugin ID] FILE... [-- 'JSONPATH=VALUE'...]
 * JSONPATH is a JSON array (["party","_gold"]); VALUE is JSON (99999, "text", true).
 * With no edits it prints the plugin, rules and quick fields with their values.
 * After editing it decodes the output again and prints every changed field, so the
 * file that goes into the game is checked like in test/run.js. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "../static/lib");
for (const f of require("./load-order.json")) require(path.join(ROOT, f));
const M = globalThis.Eitri;

const argv = process.argv.slice(2);
let out = null, keysDir = null, pluginId = null;
const files = [], edits = [];
let inEdits = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (inEdits) edits.push(a);
  else if (a === "--") inEdits = true;
  else if (a === "--out") out = argv[++i];
  else if (a === "--keys") keysDir = argv[++i];
  else if (a === "--plugin") pluginId = argv[++i];
  else files.push(a);
}
if (!files.length) { console.error("usage: make-edit.js --out DIR [--keys DIR] FILE... [-- 'PATH=VALUE'...]"); process.exit(2); }

const keys = {};
if (keysDir) for (const n of fs.readdirSync(keysDir)) keys[n] = new Uint8Array(fs.readFileSync(path.join(keysDir, n)));
const ctx = { keys };
const load = (p) => ({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

(async () => {
  const input = files.map(load);
  const det = M.detect(input);
  const pid = pluginId || (det && det.plugin.id);
  if (!pid) throw new Error("no plugin detected");
  const plugin = M.plugins.find((p) => p.id === pid);
  const doc = await M.open(input, ctx, pid);
  console.log(`plugin ${pid}; rules: ${doc.rules.map((r) => r.id).join(", ") || "none"}`);

  const rt = await plugin.encode(doc, ctx);
  for (const f of input) {
    const o = rt.find((x) => x.name === f.name);
    console.log(`round trip ${f.name}: ${o && M.equal(o.bytes, f.bytes) ? "identical" : "DIFFERENT"}`);
  }
  for (const q of M.quickFields(doc)) console.log(`quick  ${q.label} = ${doc.get(q.path)}   ${JSON.stringify(q.path)}`);
  if (!edits.length) return;
  if (!out) throw new Error("--out needed with edits");

  const changes = [];
  for (const e of edits) {
    const eq = e.indexOf("=");
    const p = JSON.parse(e.slice(0, eq));
    const v = JSON.parse(e.slice(eq + 1));
    changes.push(...M.edit(doc, p, v));
  }
  const enc = await plugin.encode(doc, ctx);
  const d2 = await M.open(enc, ctx, pid);
  const orig = await M.open(input, ctx, pid);
  const diff = M.diff(orig.root, d2.root);
  const allowed = new Set(changes.map((c) => M.pathStr(c.path)));
  for (const d of diff) console.log(`${allowed.has(d.path) ? "changed" : "UNEXPECTED"}  ${d.path}: ${String(d.before).slice(0, 60)} -> ${String(d.after).slice(0, 60)}`);
  for (const r of d2.rules) if (r.match && !r.match(d2)) console.log(`RULE NO LONGER MATCHES: ${r.id}`);
  console.log(`rules after re-open: ${d2.rules.map((r) => r.id).join(", ") || "none"}`);
  fs.mkdirSync(out, { recursive: true });
  for (const f of enc) {
    fs.writeFileSync(path.join(out, f.name), f.bytes);
    console.log(`wrote ${path.join(out, f.name)}  ${f.bytes.length} bytes  sha256 ${sha(f.bytes)}`);
  }
  if (diff.some((d) => !allowed.has(d.path))) process.exit(1);
})().catch((e) => { console.error(e.stack); process.exit(1); });
