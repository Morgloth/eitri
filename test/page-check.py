#!/usr/bin/env python3
"""Drive the Eitri page in headless Chromium against a scratch server (eitri.py on a free port, offline, empty
saves folder in a temp dir).

    python test/page-check.py [--work DIR] [--samples DIR --keys DIR] [--shots DIR]

Default samples are the made-up saves from test/make-fixtures.js. For each format: create the game through the
"+ Game" dialog, upload the save (<samples>/<game>/backup/*), add key files, open the editor, change a field, export,
and check the new version's bytes against `node test/make-edit.js` (Ren'Py: the decoded fields, since ECDSA
signatures differ every time, plus a valid signature), diff, download, delete the parent (the child then shows
"parent deleted"). Also: library search, notes and save-location cards, pins, XSS in every text field, no console
errors, screenshots at desktop and phone width, and idle CPU at 6x CDP throttle on the library and a game page.
Steam search is answered by a Playwright route for the first game (the server is offline); the rest pick "None".
Chromium: $EITRI_CHROMIUM, else /usr/bin/chromium if present, else Playwright's own (`playwright install chromium`).
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

TEST = Path(__file__).resolve().parent
REPO = TEST.parent
ROOT = REPO / "static" / "lib"                         # plugin code


def _free_port():
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"
PASS, FAIL = [], []

# game folder, name, files, editor unit, how to find the field, path, value, linked fields expected, plugin, keys
CASES = [
    dict(game="fixture-quest", name="Fixture Quest", files=["file1.rpgsave", "global.rpgsave"], unit="file1.rpgsave",
         quick="Gold", path=["party", "_gold"], value=99999, linked=[], plugin="rpgmaker-mv",
         label="gold 98 -> 99999", steam={"appid": 480, "name": "Fixture Quest"}),
    dict(game="fixture-unreal", name="Fixture Unreal", files=["SaveSlot_0.sav"], quick="Gold", path=["Gold"],
         value=1234567, linked=[], plugin="gvas", label="gold 1500 -> 1234567"),
    dict(game="fixture-renpy", name="Fixture Ren'Py", files=["1-1-LT1.save"], search="store.money",
         path=["log", 0, "store.money"], value=50, linked=[], plugin="renpy", keys=["security_keys.txt"], semantic=True),
    dict(game="fixture-godot", name="Fixture Godot", files=["savegame_0.json"], quick="Run count", path=["runCount"], value=150,
         linked=[], plugin="godot-encrypted", keys=["godot-password.txt"], label="run count 4 -> 150"),
    dict(game="fixture-xor", name="Fixture XOR", files=["run.autosave"], quick="gold", path=["gold"], value=999,
         linked=[], plugin="json-xor", label="gold 99 -> 999"),
    dict(game="fixture-checksum", name="Fixture Checksum", files=["SaveData"], quick="Coins", path=["Coins"], value=999999,
         linked=["checksum"], plugin="json"),
]
SEMANTIC_JS = r"""
const path = require("path"), fs = require("fs");
const [root, a, b, keysDir, pid, order] = process.argv.slice(1);
for (const f of require(order)) require(path.join(root, f));
const M = globalThis.Eitri, keys = {};
for (const n of fs.readdirSync(keysDir)) keys[n] = new Uint8Array(fs.readFileSync(path.join(keysDir, n)));
const load = (p) => [{ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) }];
(async () => {
  const da = await M.open(load(a), { keys }, pid), db = await M.open(load(b), { keys }, pid);
  console.log(JSON.stringify({ diff: M.diff(da.root, db.root).length, signedA: da.signed, signedB: db.signed }));
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); });
"""


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""), flush=True)
    return ok


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.read()


def get_json(path):
    return json.loads(get(path))


def api_json(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Eitri": "1", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def api_upload(slug, meta, data):
    m = json.dumps(meta).encode()
    req = urllib.request.Request(f"{BASE}/api/games/{slug}/versions", method="POST", data=len(m).to_bytes(4, "big") + m + data,
                                 headers={"X-Eitri": "1", "Content-Type": "application/x-eitri-version"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def fixture_samples(work):
    """Made-up saves as <game>/backup/* plus keys/<game>/*."""
    fx, out = work / "fixtures", work / "samples"
    shutil.rmtree(fx, ignore_errors=True)
    shutil.rmtree(out, ignore_errors=True)
    subprocess.run(["node", str(TEST / "make-fixtures.js"), str(fx)], check=True, stdout=subprocess.DEVNULL)
    for game in sorted(d for d in fx.iterdir() if d.is_dir() and d.name != "keys"):
        shutil.copytree(game, out / game.name / "backup")
    return out, fx / "keys"


def start(work, saves):
    if saves.exists():
        shutil.rmtree(saves)
    saves.mkdir(parents=True)
    env = dict(os.environ, EITRI_CACHE_DIR=str(work / "cache"))
    log = open(work / "server.log", "w")
    proc = subprocess.Popen([sys.executable, str(REPO / "eitri.py"), "--saves-dir", str(saves), "--port", str(PORT), "--offline"],
                            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        try:
            get("/api/state")
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    sys.exit("server did not start, see " + str(work / "server.log"))


def chromium():
    exe = os.environ.get("EITRI_CHROMIUM") or ("/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else None)
    return {"executable_path": exe, "args": ["--no-sandbox"]} if exe else {}


def make_edit(case, src_dir, keys_dir, out):
    f = src_dir / (case.get("unit") or case["files"][0])
    cmd = ["node", str(TEST / "make-edit.js"), "--out", str(out)]
    if case.get("keys"):
        cmd += ["--keys", str(keys_dir / case["game"])]
    cmd += [str(f), "--", f"{json.dumps(case['path'])}={json.dumps(case['value'])}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0, (out / f.name), r.stdout + r.stderr


def semantic(a, b, keys_dir, plugin):
    r = subprocess.run(["node", "-e", SEMANTIC_JS, str(ROOT), str(a), str(b), str(keys_dir), plugin, str(TEST / "load-order.json")], capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": r.stdout + r.stderr}


def idle_cpu(page, ctx, seconds=15):
    cdp = ctx.new_cdp_session(page)
    cdp.send("Performance.enable")
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 6})
    page.wait_for_timeout(5000)  # the one-shot load flash is over
    m = lambda: {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}  # noqa: E731
    a = m()
    page.wait_for_timeout(seconds * 1000)
    b = m()
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    cdp.detach()
    return 100 * (b["TaskDuration"] - a["TaskDuration"]) / (b["Timestamp"] - a["Timestamp"])


def run_case(page, case, samples, keys_dir, work, first):
    g, name = case["game"], case["name"]
    src = samples / g / "backup"
    page.goto(BASE + "/")
    page.click("#add-game")
    page.fill("#new-name", name)
    page.click("#new-search")
    page.wait_for_selector('#new-picks input[name="new-pick"]')
    if first:
        check(f"{g}: Steam pick list shows the match", page.locator("#new-picks .pick").count() == 2)
        page.fill("#new-name", name.lower())          # typed differently: the pick's Steam name replaces it,
        with page.expect_response("**/api/steam/search*"):   # "None of these" puts back what was typed
            page.click("#new-search")
        page.wait_for_function("document.getElementById('new-status').textContent === ''")
        check(f"{g}: picked Steam match names the game", page.input_value("#new-name") == case["steam"]["name"], page.input_value("#new-name"))
        page.check('#new-picks input[value=""]')
        check(f"{g}: None of these restores the typed name", page.input_value("#new-name") == name.lower(), page.input_value("#new-name"))
        page.check(f'#new-picks input[value="{case["steam"]["appid"]}"]')
    else:
        page.check('#new-picks input[value=""]')
        check(f"{g}: no Steam match offline -> cover upload offered", page.is_visible("#new-cover-wrap"))
    page.set_input_files("#new-files", [str(src / f) for f in case["files"]])
    page.wait_for_function("document.getElementById('new-detect').textContent.length > 0")
    check(f"{g}: detect pre-fills the plugin", page.input_value("#new-plugin") == case["plugin"], page.input_value("#new-plugin"))
    page.click("#new-ok")
    page.wait_for_selector('.vrow[data-vid="v001"]', timeout=60000)
    gd = get_json(f"/api/games/{g}")
    check(f"{g}: game created with slug {g}", gd["slug"] == g, gd["slug"])
    check(f"{g}: plugin kept", gd["plugin"] == case["plugin"], gd["plugin"])
    v1 = gd["versions"][0]
    check(f"{g}: v001 holds all {len(case['files'])} files byte for byte", [f["name"] for f in v1["files"]] == case["files"] and all(
        f["sha256"] == hashlib.sha256((src / f["name"]).read_bytes()).hexdigest() for f in v1["files"]))
    check(f"{g}: v001 detect sent", (v1.get("detect") or {}).get("plugin") == case["plugin"], str(v1.get("detect")))
    if first:
        check(f"{g}: Steam match stored", gd["steam_appid"] == case["steam"]["appid"])
    for k in case.get("keys", []):
        page.set_input_files("#k-file", str(keys_dir / g / k))
        page.wait_for_selector(f'#k-list .nm:text-is("{k}")')
    if case.get("keys"):
        check(f"{g}: key files uploaded", [k["name"] for k in get_json(f"/api/games/{g}")["keys"]] == sorted(case["keys"]))

    # editor
    page.click('.vrow[data-vid="v001"] a:has-text("Edit")')
    page.wait_for_selector("#e-head .checks", timeout=60000)
    page.wait_for_function("!!document.querySelector('#e-head .checks')")
    if case.get("unit"):
        page.click(f'#e-head [data-unit]:has-text("{case["unit"]}")')
    checks_text = page.inner_text("#e-head .checks")
    check(f"{g}: round-trip self-check passes", "identical bytes" in checks_text and "differ" not in checks_text, checks_text[:300])
    sel = f"[data-p='{json.dumps(case['path'], separators=(',', ':'))}']"
    if case.get("quick"):
        field = page.locator("#e-quick label", has_text=case["quick"]).locator(".field").first
    else:
        page.fill("#e-q", case["search"])
        page.wait_for_selector(f"#e-results {sel}")
        field = page.locator(f"#e-results {sel}").first
    field.fill(str(case["value"]))
    field.press("Tab")
    page.wait_for_function("!document.getElementById('e-export').disabled")
    ch = page.inner_text("#e-chlist")
    check(f"{g}: change listed", "1 field" in ch or "fields" in ch, ch[:200])
    for lk in case["linked"]:
        check(f"{g}: linked field {lk} updated and listed", lk in ch and "linked" in ch, ch[:400])
    label = page.input_value("#e-label")
    if case.get("label"):
        check(f"{g}: auto label '{case['label']}'", label == case["label"], label)
    else:
        check(f"{g}: auto label has before -> after", "->" in label, label)
    with page.expect_download(timeout=60000) as dl:
        page.click("#e-export")
    d = dl.value
    page.wait_for_selector('.vrow[data-vid="v002"]', timeout=60000)
    gd = get_json(f"/api/games/{g}")
    v2 = next(v for v in gd["versions"] if v["id"] == "v002")
    check(f"{g}: v002 is a child of v001", v2["parent"] == "v001" and v2["kind"] == "edit" and v2["label"] == label, str(v2)[:200])
    check(f"{g}: v002 changed list has the edit + linked", len(v2["changed"]) == 1 + len(case["linked"]) and any(c["linked"] for c in v2["changed"]) == bool(case["linked"]), str(v2["changed"])[:300])
    check(f"{g}: v002 detect roundtrip + integrity", (v2.get("detect") or {}).get("roundtrip") is True, str(v2.get("detect")))
    check(f"{g}: 24-hour timestamp shown", page.locator('.vrow[data-vid="v002"] .vmeta').first.inner_text()[:16] == v2["created_text"])

    target = case.get("unit") or case["files"][0]
    got = get(f"/api/games/{g}/versions/v002/files/{urllib.request.quote(target, safe='')}")
    out = work / "make-edit" / g
    ok, want, log = make_edit(case, src, keys_dir, out)
    check(f"{g}: make-edit.js ran", ok, log[-300:])
    if case.get("semantic"):
        mine = work / "page-out" / g / target
        mine.parent.mkdir(parents=True, exist_ok=True)
        mine.write_bytes(got)
        r = semantic(want, mine, keys_dir / g, case["plugin"])
        check(f"{g}: page export decodes to the same fields as make-edit.js", r.get("diff") == 0, str(r))
        check(f"{g}: page export signature valid", r.get("signedB") is True, str(r))
    else:
        check(f"{g}: page export bytes == make-edit.js bytes", ok and got == want.read_bytes(), f"{len(got)} vs {want.stat().st_size if want.exists() else '-'}")
    for f in case["files"]:
        if f != target:
            other = get(f"/api/games/{g}/versions/v002/files/{urllib.request.quote(f, safe='')}")
            check(f"{g}: untouched {f} carried over byte for byte", other == (src / f).read_bytes())
    dbytes = Path(d.path()).read_bytes()
    if len(case["files"]) > 1:
        z = zipfile.ZipFile(io.BytesIO(dbytes))
        check(f"{g}: download is a zip with the original names", sorted(z.namelist()) == sorted(case["files"]), str(z.namelist()))
        check(f"{g}: zip holds the exported bytes", z.read(target) == got)
    else:
        check(f"{g}: download keeps the exact file name", d.suggested_filename == target, d.suggested_filename)
        check(f"{g}: downloaded bytes == stored v002", dbytes == got)

    # diff of the two versions
    page.click('.vrow[data-vid="v002"] [data-diff]')
    page.wait_for_selector("#d-out .hint")
    page.wait_for_function("!document.getElementById('d-out').textContent.includes('Decoding')", timeout=60000)
    dt = page.inner_text("#d-out")
    pstr = case["path"][-1] if isinstance(case["path"][-1], str) else str(case["path"][-1])
    check(f"{g}: diff v001 -> v002 shows the field", pstr in dt and str(case["value"]) in dt, dt[:300])
    # re-download v001 from its row
    with page.expect_download() as dl1:
        page.click('.vrow[data-vid="v001"] a:has-text("Download")')
    b1 = Path(dl1.value.path()).read_bytes()
    if len(case["files"]) > 1:
        z = zipfile.ZipFile(io.BytesIO(b1))
        check(f"{g}: v001 zip == originals", all(z.read(f) == (src / f).read_bytes() for f in case["files"]))
    else:
        check(f"{g}: v001 re-download == original", b1 == (src / case["files"][0]).read_bytes() and dl1.value.suggested_filename == case["files"][0])
    # delete the parent: the child stays, marked
    page.click('.vrow[data-vid="v001"] [data-delv]')
    page.wait_for_selector("#dlg-confirm[open]")
    page.click("#cf-yes")
    page.wait_for_selector('.vrow[data-vid="v001"]', state="detached")
    vs = get_json(f"/api/games/{g}/versions")["versions"]
    check(f"{g}: v001 deleted, v002 kept", [v["id"] for v in vs] == ["v002"])
    check(f"{g}: v002 shows 'parent deleted'", "parent v001 deleted" in page.inner_text('.vrow[data-vid="v002"]'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=None, help="scratch folder (default: a new temp dir)")
    ap.add_argument("--samples", help="<game>/backup/* folders (default: made-up saves)")
    ap.add_argument("--keys", help="keys/<game>/* for --samples")
    ap.add_argument("--shots", default=None, help="screenshot folder (default: <work>/shots)")
    a = ap.parse_args()
    work = Path(a.work or tempfile.mkdtemp(prefix="eitri-page-"))
    work.mkdir(parents=True, exist_ok=True)
    shots = Path(a.shots or work / "shots")
    shots.mkdir(parents=True, exist_ok=True)
    if a.samples:
        samples, keys_dir = Path(a.samples), Path(a.keys or Path(a.samples) / "keys")
    else:
        samples, keys_dir = fixture_samples(work)
    saves = work / "saves"
    proc = start(work, saves)
    errors = []
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(**chromium())
            # The page's CSP is checked on its own first (Playwright's string waits need eval, so the main run bypasses it).
            strict = b.new_context()
            sp, csp_errors = strict.new_page(), []
            sp.on("console", lambda m: m.type == "error" and csp_errors.append(m.text))
            sp.on("pageerror", lambda e: csp_errors.append(str(e)))
            sp.goto(BASE + "/")
            sp.wait_for_selector("#tiles .tile")
            check("page runs under its Content-Security-Policy without errors", not csp_errors, "; ".join(csp_errors)[:300])
            strict.close()
            ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True, bypass_csp=True)
            page = ctx.new_page()
            page.on("console", lambda m: m.type == "error" and errors.append(m.text))
            page.on("pageerror", lambda e: errors.append(str(e)))
            first = CASES[0]["steam"]
            def steam(r):
                if "fixture" not in r.request.url.lower():
                    return r.continue_()
                r.fulfill(content_type="application/json", body=json.dumps({"q": "x", "error": None, "stale": False,
                          "results": [{"appid": first["appid"], "name": first["name"], "image": None, "type": "app"}]}))
            page.route("**/api/steam/search*", steam)
            page.goto(BASE + "/")
            check("empty library shows only the + Game tile", page.locator("#tiles .tile").count() == 1)
            for i, case in enumerate(CASES):
                try:
                    run_case(page, case, samples, keys_dir, work, i == 0)
                except Exception as e:  # keep going with the next format
                    check(f"{case['game']}: flow finished", False, repr(e)[:300])
                    page.screenshot(path=str(shots / f"fail-{case['game']}.png"), full_page=True)

            # library
            page.goto(BASE + "/")
            n = page.locator("#tiles .tile:not(.add)").count()
            check(f"library lists the {len(CASES)} games", n == len(CASES), str(n))
            first_tile = page.locator("#tiles .tile:not(.add) .nm").first.inner_text()
            gl = get_json("/api/games")["games"]   # timestamps are whole seconds: any game tied for newest may lead
            newest = {g["name"] for g in gl if g["updated"] == max(x["updated"] for x in gl)}
            check("library: last edited first", first_tile in newest and CASES[-1]["name"] in newest, f"{first_tile} / {sorted(newest)}")
            page.fill("#lib-q", "checksum")
            check("library search filters", page.locator("#tiles .tile:not(.add)").count() == 1)
            page.fill("#lib-q", "")
            page.screenshot(path=str(shots / "library-desktop.png"), full_page=True)
            cpu_lib = idle_cpu(page, ctx)
            check(f"library idle CPU at 6x throttle < 1% ({cpu_lib:.2f}%)", cpu_lib < 1)
            # game page with the save-location card filled in
            page.goto(BASE + "/#g=fixture-quest")
            page.wait_for_selector(".vrow")
            page.fill("#l-install", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Fixture Quest")
            page.click("#l-save")
            page.wait_for_function("document.getElementById('l-status').textContent === 'Saved.'")
            loc = page.inner_text("#l-paths")
            check("save location: <install> filled from the install folder", "Fixture Quest\\www\\save" in loc and "<install>" not in loc, loc)
            check("game page: Steam Cloud warning hidden (offline, unknown)", page.is_hidden("#g-cloud"))
            page.fill("#n-notes", "file1 = slot 1. Copy in with the game closed.")
            page.click("#n-save")
            page.wait_for_function("document.getElementById('n-status').textContent === 'Saved.'")
            check("notes card saved", get_json("/api/games/fixture-quest")["notes"].startswith("file1 = slot 1"))
            page.screenshot(path=str(shots / "game-desktop.png"), full_page=True)
            page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
            page.wait_for_timeout(200)
            page.screenshot(path=str(shots / "game-desktop-bottom.png"))
            page.evaluate("window.scrollTo(0, 0)")
            cpu_game = idle_cpu(page, ctx)
            check(f"game page idle CPU at 6x throttle < 1% ({cpu_game:.2f}%)", cpu_game < 1)
            # editor, with one unsaved change so the summary shows
            page.click('.vrow[data-vid="v002"] a:has-text("Edit")')
            page.wait_for_selector("#e-head .checks")
            page.click('#e-head [data-unit]:has-text("file1.rpgsave")')
            f = page.locator("#e-quick label", has_text="Gold").locator(".field").first
            f.fill("12")
            f.press("Tab")
            page.wait_for_function("!document.getElementById('e-export').disabled")
            page.click('#e-tree .tg:has-text("party")')
            page.screenshot(path=str(shots / "editor-desktop.png"), full_page=True)
            # phone width
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(shots / "editor-phone.png"), full_page=True)
            # in-page navigation away from unsaved edits asks first; Cancel keeps the edits
            page.click("#e-head .crumbs a")
            page.wait_for_selector("#dlg-confirm[open]")
            check("dirty editor: leaving in-page asks first", "unsaved" in page.inner_text("#cf-text"))
            page.click("#dlg-confirm button[value=no]")
            page.wait_for_timeout(300)
            check("dirty editor: Cancel stays in the editor with the edit", page.is_visible("#view-edit") and "#g=fixture-quest&e=v002" in page.url
                  and not page.is_disabled("#e-export"), page.url)
            page.click("#e-head .crumbs a")
            page.wait_for_selector("#dlg-confirm[open]")
            page.click("#cf-yes")
            page.wait_for_selector("#view-game:not([hidden])")
            check("dirty editor: Leave goes on and drops the edits", page.evaluate("location.hash") != "#g=fixture-quest&e=v002")
            page.click('.vrow[data-vid="v002"] a:has-text("Edit")')
            page.wait_for_selector("#e-head .checks")
            check("editor reopened after leaving starts clean", page.is_disabled("#e-export"))
            # pins: pin party._gold in file1 as "Blight", it shows in Quick fields, names the edit, rename, per file, unpin
            page.click('#e-head [data-unit]:has-text("file1.rpgsave")')
            page.click('#e-tree .tg:has-text("party")')
            page.click('#e-tree .leaf:has(.k:text-is("_gold")) [data-pin]')
            page.wait_for_selector("#dlg-prompt[open]")
            check("pin: asks for a name, field name prefilled", page.input_value("#pr-input") == "gold", page.input_value("#pr-input"))
            page.fill("#pr-input", "Blight")
            page.press("#pr-input", "Enter")
            page.wait_for_selector('#e-quick .qpin:has-text("Blight")')
            pins = get_json("/api/games/fixture-quest")["pins"]
            check("pin: saved on the game", pins == [{"path": ["party", "_gold"], "label": "Blight", "file": "file1.rpgsave", "match": []}], json.dumps(pins))
            check("pin: star is on in All fields", page.get_attribute('#e-tree .leaf:has(.k:text-is("_gold")) [data-pin]', "aria-pressed") == "true")
            check("pin: hint hidden once something is pinned", not page.is_visible("#e-pinhint"))
            qf = page.locator("#e-quick .qpin", has_text="Blight").locator(".field").first
            qf.fill("4242")
            qf.press("Tab")
            page.wait_for_function("!document.getElementById('e-export').disabled")
            check("pin: edit label uses the pin's name", page.input_value("#e-label").startswith("blight"), page.input_value("#e-label"))
            page.click('#e-quick [data-rename]')
            page.wait_for_selector("#dlg-prompt[open]")
            page.fill("#pr-input", "Blight (exp)")
            page.click("#pr-yes")
            page.wait_for_selector('#e-quick .qpin:has-text("Blight (exp)")')
            check("pin: rename saved", get_json("/api/games/fixture-quest")["pins"][0]["label"] == "Blight (exp)")
            check("pin: edit kept through the rename", page.input_value('#e-quick .qpin .field') == "4242")
            page.click('#e-head [data-unit]:has-text("global.rpgsave")')
            check("pin: not shown for the other file of the version", page.locator("#e-quick .qpin").count() == 0)
            page.click('#e-head [data-unit]:has-text("file1.rpgsave")')
            page.click('#e-quick [data-unpin]')
            page.wait_for_function("document.querySelectorAll('#e-quick .qpin').length === 0")
            check("pin: unpin saved, hint back", get_json("/api/games/fixture-quest")["pins"] == [] and page.is_visible("#e-pinhint"))
            st, _ = api_json("PUT", "/api/games/fixture-quest", {"pins": [{"path": [], "label": "x"}]})
            check("pin: bad pin is a 400", st == 400, str(st))
            page.click("#e-reset")
            page.wait_for_selector("#dlg-confirm[open]")
            page.click("#cf-yes")
            page.wait_for_function("document.getElementById('e-export').disabled")
            page.goto(BASE + "/#g=fixture-quest")
            page.wait_for_selector(".vrow")
            page.screenshot(path=str(shots / "game-phone.png"), full_page=True)
            page.goto(BASE + "/")
            page.wait_for_selector(".tile")
            page.screenshot(path=str(shots / "library-phone.png"), full_page=True)
            wide = page.evaluate("document.documentElement.scrollWidth")
            check("phone: no horizontal scroll on the library", wide <= 390, str(wide))
            # user data is rendered as text: a game name / notes / label / changed path with markup stays text
            evil = '<img src=x onerror="window.__xss=1">'
            st, gx = api_json("POST", "/api/games", {"name": "XSS " + evil, "engine": evil})
            meta = {"files": [{"name": evil.replace("/", "_") + ".sav", "size": 1}], "label": evil, "note": evil,
                    "changed": [{"path": [evil], "before": evil, "after": evil, "linked": True, "rule": evil}],
                    "detect": {"plugin": evil[:50], "format": evil, "integrity": "bad", "integrity_text": evil}}
            api_upload(gx["slug"], meta, b"x")
            api_json("PUT", f"/api/games/{gx['slug']}", {"notes": evil, "rules": evil, "save_location": evil, "install_dir": evil})
            page.set_viewport_size({"width": 1280, "height": 900})
            page.goto(BASE + "/")
            page.wait_for_selector(".tile")
            page.goto(BASE + "/#g=" + gx["slug"])
            page.wait_for_selector(".vrow")
            page.click(".vrow details summary")
            page.wait_for_timeout(500)
            check("XSS: markup in names, labels, notes, paths and changes stays text", page.evaluate("window.__xss") is None
                  and page.locator("#view-game img[src=x], #tiles img[src=x]").count() == 0 and evil in page.inner_text("#g-head"))
            page.click("#g-del")
            page.click("#cf-yes")
            page.wait_for_selector("#view-lib:not([hidden])")
            # Enter in the New game dialog's Engine field doesn't submit (= close) the dialog
            page.click("#add-game")
            page.fill("#new-engine", "x")
            page.press("#new-engine", "Enter")
            check("new game dialog: Enter in a field keeps it open", page.is_visible("#dlg-new"))
            page.keyboard.press("Escape")
            # big save: the 940 KB Lies of P GVAS opens and searches quickly (the tree draws one level at a time)
            lop = samples / "lies-of-p" / "backup"
            if lop.is_dir():
                st, gl = api_json("POST", "/api/games", {"name": "Lies of P"})
                files = sorted(lop.iterdir())
                api_upload(gl["slug"], {"files": [{"name": f.name, "size": f.stat().st_size} for f in files]}, b"".join(f.read_bytes() for f in files))
                page.goto(BASE + f"/#g={gl['slug']}")
                page.wait_for_selector(".vrow")
                t0 = time.time()
                page.click('.vrow[data-vid="v001"] a:has-text("Edit")')
                page.wait_for_selector("#e-head .checks", timeout=60000)
                page.wait_for_function("document.getElementById('e-fcount').textContent.includes('values')", timeout=60000)
                t_open = time.time() - t0
                check("Lies of P: decoded, round trip OK", "identical bytes" in page.inner_text("#e-head .checks"), page.inner_text("#e-head")[:300])
                nodes = page.evaluate("document.querySelectorAll('#e-tree *').length")
                t0 = time.time()
                page.fill("#e-q", "level")
                page.wait_for_selector("#e-results:not([hidden])")
                t_search = time.time() - t0
                check(f"Lies of P (940 KB GVAS): editor opens in {t_open:.1f} s (< 10), {nodes} tree nodes (< 3000), search {t_search:.1f} s (< 3)",
                      t_open < 10 and nodes < 3000 and t_search < 3)
                # pins inside lists follow the entry by its name, not its position
                items = ["CharacterSaveData", "CharacterItem", "PlayerItems"]
                page.fill("#e-q", "Consume_Throw_Gear")
                hit = '#e-results .leaf:has(.k:text-is("CharacterSaveData.CharacterItem.PlayerItems[22].FirstCodeName")) [data-pin]'
                page.wait_for_selector(hit)
                page.click(hit)
                page.wait_for_selector("#dlg-prompt[open]")
                page.fill("#pr-input", "Cogs code")
                page.press("#pr-input", "Enter")
                page.wait_for_selector('#e-quick .qpin:has-text("Cogs code")')
                pin = get_json(f"/api/games/{gl['slug']}")["pins"][0]
                check("list pin: anchored by the entry's name", pin["match"] == [{"at": 3, "key": "FirstCodeName", "value": "Consume_Throw_Gear"}], json.dumps(pin))
                check("list pin: full address shown", "PlayerItems[22].FirstCodeName" in page.inner_text('#e-quick .qpin:has-text("Cogs code") .qp'))
                anchor = [{"at": 3, "key": "FirstCodeName", "value": "Consume_Throw_Gear"}]
                st, _ = api_json("PUT", f"/api/games/{gl['slug']}", {"pins": [
                    {"path": items + [5, "Count"], "label": "Cogs moved", "match": anchor},
                    {"path": items + [5, "Count"], "label": "Cogs gone", "match": [{"at": 3, "key": "FirstCodeName", "value": "No_Such_Item"}]},
                    {"path": items + [22, "Count"], "label": "Cogs by position"}]})
                check("list pins: saved", st == 200, str(st))
                page.reload()
                page.wait_for_selector('#e-quick .qpin:has-text("Cogs moved")', timeout=60000)
                moved = page.locator('#e-quick .qpin', has_text="Cogs moved")
                check("list pin: finds the entry at its new position (value 14, says moved)",
                      moved.locator(".field").input_value() == "14" and "moved to CharacterSaveData.CharacterItem.PlayerItems[22].Count" in moved.inner_text(), moved.inner_text())
                gone = page.locator('#e-quick .qpin', has_text="Cogs gone")
                check("list pin: entry missing -> says so, no field to edit", gone.locator(".field").count() == 0 and "not in this version" in gone.inner_text(), gone.inner_text())
                pos = page.locator('#e-quick .qpin', has_text="Cogs by position")
                check("list pin: no anchor -> marked by position", "by position" in pos.inner_text() and pos.locator(".field").input_value() == "14", pos.inner_text())
                st, _ = api_json("PUT", f"/api/games/{gl['slug']}", {"pins": [{"path": items + [5], "label": "x", "match": [{"at": 1, "key": "k", "value": "v"}]}]})
                check("list pin: match must point at a list index (400)", st == 400, str(st))
                api_json("DELETE", f"/api/games/{gl['slug']}?confirm={gl['slug']}")
            b.close()
    finally:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(10)
    check("no console errors", not errors, "; ".join(errors)[:600])
    print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)} checks passed. Work dir: {work}  Screenshots: {shots}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
