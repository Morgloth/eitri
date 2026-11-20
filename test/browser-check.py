#!/usr/bin/env python3
"""Run the Eitri round trips inside headless Chromium (proves the plugins are browser-safe).

    python test/browser-check.py                         made-up saves from test/make-fixtures.js
    python test/browser-check.py --samples DIR           your own saves, listed in test/samples.json

Serves the plugin files and the samples to the page through Playwright request routing on
http://localhost (a secure context, so WebCrypto works). Samples and keys never leave this process."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

TEST = Path(__file__).resolve().parent
ROOT = TEST.parent / "static" / "lib"  # plugin code
ORDER = json.loads((TEST / "load-order.json").read_text())
SAMPLES = None  # set in main()

JS = """
async ([manifest]) => {
  const M = window.Eitri, out = [];
  const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  for (const s of manifest) {
    const game = s.files[0].split("/")[0];
    const keys = {};
    for (const k of (await (await fetch("/keys/" + game + "/")).json())) keys[k] = await get("/keys/" + game + "/" + k);
    const files = [];
    for (const f of s.files) files.push({ name: f.split("/").pop(), bytes: await get("/samples/" + f) });
    try {
      const doc = await M.open(files, { keys }, s.plugin);
      const enc = await M.plugins.find((p) => p.id === s.plugin).encode(doc, { keys });
      const same = files.every((f) => { const o = enc.find((x) => x.name === f.name); return o && M.equal(o.bytes, f.bytes); });
      let edit = "";
      if (s.edits && s.edits.length) {
        const e = s.edits[0], d = await M.open(files, { keys }, s.plugin);
        M.edit(d, e.path, e.value);
        const d2 = await M.open(await M.plugins.find((p) => p.id === s.plugin).encode(d, { keys }), { keys }, s.plugin);
        edit = String(d2.get(e.path)) === String(e.expect !== undefined ? e.expect : e.value) ? "edit ok" : "EDIT FAIL";
      }
      out.push([s.files.join("+"), same ? "ok" : "ROUND TRIP FAIL", edit]);
    } catch (err) { out.push([s.files.join("+"), "ERROR " + err.message, ""]); }
  }
  return out;
}
"""


def route(r):
    url = r.request.url.split("localhost", 1)[1].split("?")[0]
    if url == "/":
        tags = "".join(f'<script src="/{f}"></script>' for f in ORDER)
        return r.fulfill(body=f"<!doctype html><meta charset=utf-8>{tags}", content_type="text/html")
    if url.startswith("/keys/"):
        rest = url[len("/keys/"):]
        game, _, name = rest.partition("/")
        d = SAMPLES / "keys" / game
        if not name:
            return r.fulfill(body=json.dumps(sorted(os.listdir(d)) if d.is_dir() else []), content_type="application/json")
        return r.fulfill(body=(d / name).read_bytes())
    if url.startswith("/samples/"):
        return r.fulfill(body=(SAMPLES / url[len("/samples/"):]).read_bytes())
    p = (ROOT / url.lstrip("/")).resolve()
    if ROOT in p.parents and p.is_file():
        return r.fulfill(body=p.read_bytes(), content_type="text/javascript")
    return r.fulfill(status=404, body="")


def main():
    global SAMPLES
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default=os.environ.get("EITRI_SAMPLES"))
    a = ap.parse_args()
    tmp = None
    if a.samples:
        SAMPLES, manifest_file = Path(a.samples), TEST / "samples.json"
    else:
        tmp = Path(tempfile.mkdtemp(prefix="eitri-browser-"))
        SAMPLES, manifest_file = tmp / "fixtures", TEST / "fixtures.json"
        subprocess.run(["node", str(TEST / "make-fixtures.js"), str(SAMPLES)], check=True, stdout=subprocess.DEVNULL)
    manifest = [s for s in json.loads(manifest_file.read_text()) if s.get("status") != "untested"]
    exe = os.environ.get("EITRI_CHROMIUM") or ("/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else None)
    with sync_playwright() as pw:
        b = pw.chromium.launch(**({"executable_path": exe, "args": ["--no-sandbox"]} if exe else {}))
        page = b.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("http://localhost/**", route)
        page.goto("http://localhost/")
        rows = page.evaluate(JS, [manifest])
        b.close()
    bad = 0
    for name, rt, edit in rows:
        flag = rt != "ok" or edit.startswith("EDIT")
        bad += flag
        print(f"{'FAIL' if flag else 'ok  '} {name}: {rt} {edit}")
    for e in errors:
        print("page error:", e)
    print(f"\n{len(rows) - bad}/{len(rows)} samples ok in Chromium")
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1 if bad or errors else 0)


if __name__ == "__main__":
    main()
