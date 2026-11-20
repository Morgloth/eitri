#!/usr/bin/env python3
"""Exercise every /api endpoint of Eitri.

    python3 test/server-check.py                       start eitri.py on a free port with a temp saves folder and
                                                       the made-up saves from test/make-fixtures.js (what CI runs)
    python3 test/server-check.py --base URL --saves-dir DIR [--samples DIR] [--online]
                                                       check a server you started (EITRI_SAVES_DIR=DIR, empty)

Samples: <DIR>/<game>/backup/* is uploaded as the original version, <DIR>/<game>/edited/* as its child; every download
is compared by sha256. Without --online the server should run offline (lookups must degrade, not fail); with
--online a few real Steam / PCGamingWiki lookups run (keep it polite: run that rarely).
"""
import argparse
import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import struct
import sys
import time
import urllib.parse
from pathlib import Path

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    return ok


class Client:
    def __init__(self, base):
        u = urllib.parse.urlsplit(base)
        self.host, self.port = u.hostname, u.port or 80

    def req(self, method, path, body=None, headers=None, csrf=True, host=None):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=60)
        hdrs = dict(headers or {})
        if csrf and method != "GET":
            hdrs["X-Eitri"] = "1"
        if host:
            hdrs["Host"] = host
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=body, headers=hdrs)
            r = conn.getresponse()
            data = r.read()
            return r.status, dict(r.getheaders()), data
        except (ConnectionError, http.client.HTTPException) as exc:
            return 0, {}, str(exc).encode()
        finally:
            conn.close()

    def json(self, method, path, body=None, headers=None, **kw):
        status, headers, data = self.req(method, path, body, headers, **kw)
        try:
            return status, json.loads(data)
        except ValueError:
            return status, {"_raw": data[:200]}


def frame(meta, blobs):
    m = json.dumps(meta).encode()
    return struct.pack(">I", len(m)) + m + b"".join(blobs)


def upload(c, slug, files, **meta):
    """files = [(name, bytes)]"""
    meta["files"] = [{"name": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in files]
    body = frame(meta, [b for _, b in files])
    status, _, data = c.req("POST", f"/api/games/{slug}/versions", body,
                            {"Content-Type": "application/x-eitri-version"})
    try:
        return status, json.loads(data)
    except ValueError:
        return status, {}


def q(s):
    return urllib.parse.quote(s, safe="")


REPO = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


def fixture_samples(work):
    """Lay the made-up saves out as <game>/backup + <game>/edited (edited = the same files with one byte appended;
    the server never parses saves, so any bytes do)."""
    fx = work / "fixtures"
    subprocess.run(["node", str(REPO / "test" / "make-fixtures.js"), str(fx)], check=True, stdout=subprocess.DEVNULL)
    out = work / "samples"
    for game in sorted(d for d in fx.iterdir() if d.is_dir() and d.name != "keys"):
        for kind in ("backup", "edited"):
            (out / game.name / kind).mkdir(parents=True)
            for f in sorted(game.iterdir()):
                (out / game.name / kind / f.name).write_bytes(f.read_bytes() + (b"\n" if kind == "edited" else b""))
    return out


def wait_up(base, proc):
    c = Client(base)
    for _ in range(100):
        if proc.poll() is not None:
            sys.exit("eitri.py exited early")
        if c.req("GET", "/api/state")[0] == 200:
            return
        time.sleep(0.1)
    sys.exit("eitri.py did not start")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="a running server; without it eitri.py is started on a free port")
    ap.add_argument("--samples", help="<game>/backup + <game>/edited folders (default: made-up saves)")
    ap.add_argument("--saves-dir", help="the server's EITRI_SAVES_DIR (checked on disk); needed with --base")
    ap.add_argument("--online", action="store_true")
    a = ap.parse_args()
    work = Path(tempfile.mkdtemp(prefix="eitri-server-check-"))
    proc = None
    try:
        samples = Path(a.samples) if a.samples else fixture_samples(work)
        if a.base:
            if not a.saves_dir:
                sys.exit("--saves-dir is required with --base")
            base, root = a.base, Path(a.saves_dir)
        else:
            root = work / "saves"
            root.mkdir()
            port = free_port()
            base = f"http://127.0.0.1:{port}"
            env = dict(os.environ, EITRI_QUIET="1")
            cmd = [sys.executable, str(REPO / "eitri.py"), "--saves-dir", str(root), "--port", str(port)]
            proc = subprocess.Popen(cmd + ([] if a.online else ["--offline"]), env=env)
            wait_up(base, proc)
        run(a, Client(base), root, samples)
    finally:
        if proc:
            proc.terminate()
            proc.wait(timeout=10)
        shutil.rmtree(work, ignore_errors=True)


def run(a, c, root, samples):
    if any(p for p in root.iterdir() if not p.name.startswith("_")):
        sys.exit(f"{root} must be empty (only _ folders allowed)")
    (root / "_import").mkdir(exist_ok=True)
    (root / "_import" / "game.json").write_text("{}")

    # ---- pages + state
    s, h, body = c.req("GET", "/")
    check("GET / serves the page with initial data", s == 200 and b"__INITIAL_DATA__" not in body and b'"games"' in body)
    check("page has a Content-Security-Policy", "default-src 'self'" in h.get("Content-Security-Policy", ""))
    s, h, body = c.req("GET", "/static/../eitri.py")
    check("no files outside static/", s == 404)
    s, st = c.json("GET", "/api/state")
    check("state: ok, empty, _import ignored", s == 200 and st["ok"] and st["games"] == [] and st["limits"]["version_bytes"] == 64 << 20)

    # ---- CSRF + bad input
    s, _ = c.json("POST", "/api/games", {"name": "x"}, csrf=False)
    check("write without X-Eitri header -> 403", s == 403)
    s, _ = c.json("POST", "/api/games", {"name": ""})
    check("empty name -> 400", s == 400)
    s, _ = c.json("POST", "/api/games", {"name": "x", "evil": 1})
    check("unknown field -> 400", s == 400)

    # ---- games from the samples
    games = sorted(d for d in samples.iterdir() if d.is_dir()) if samples.is_dir() else []
    check("samples found", len(games) >= 5, str(samples))
    made = {}
    for d in games:
        name = d.name.replace("-", " ").title()
        s, g = c.json("POST", "/api/games", {"name": name, "engine": "test", "plugin": "json"})
        if not check(f"create {name}", s == 201 and g.get("slug") == d.name, f"{s} {g}"):
            continue
        made[d.name] = g
        orig = [(f.name, f.read_bytes()) for f in sorted((d / "backup").iterdir()) if f.is_file()]
        s, v1 = upload(c, d.name, orig, label="original", detect={"plugin": "json", "engine": "test", "format": "JSON",
                                                                      "integrity": "ok", "integrity_text": "checksum OK"})
        if not check(f"{d.name}: upload original ({len(orig)} files)", s == 201 and v1.get("id") == "v001", f"{s} {v1}"):
            continue
        edited = [(f.name, f.read_bytes()) for f in sorted((d / "edited").iterdir()) if f.is_file()]
        changed = [{"path": ["gold"], "before": "98", "after": "99999"}]
        s, v2 = upload(c, d.name, edited, label="gold 98 -> 99999", parent="v001", changed=changed)
        check(f"{d.name}: upload edited as child", s == 201 and v2.get("id") == "v002" and v2.get("parent") == "v001"
              and v2.get("kind") == "edit" and v2.get("changed") == changed and v2.get("dir") == "v002-gold-98-99999", f"{s} {v2}")
        s, gd = c.json("GET", f"/api/games/{d.name}")
        vs = {v["id"]: v for v in gd.get("versions", [])}
        check(f"{d.name}: tree v001 -> v002", vs.get("v001", {}).get("children") == ["v002"] and vs.get("v002", {}).get("parent_exists"))
        check(f"{d.name}: 24-hour created_text", len(vs.get("v002", {}).get("created_text", "")) == 16
              and "M" not in vs["v002"]["created_text"])
        expect_size = sum(len(b) for _, b in orig + edited)
        check(f"{d.name}: total size counts the save files", gd.get("size", 0) >= expect_size)
        for vid, files in (("v001", orig), ("v002", edited)):
            for fname, data in files:
                s, hdr, got = c.req("GET", f"/api/games/{d.name}/versions/{vid}/files/{q(fname)}")
                check(f"{d.name}: {vid}/{fname} sha256 matches", s == 200 and hashlib.sha256(got).digest() == hashlib.sha256(data).digest())
                cd = hdr.get("Content-Disposition", "")
                check(f"{d.name}: {vid}/{fname} keeps its exact name", f"filename*=UTF-8''{q(fname)}" in cd, cd)
                on_disk = root / d.name / vs[vid]["dir"] / fname
                check(f"{d.name}: {vid}/{fname} stored under its own name on disk", on_disk.is_file()
                      and on_disk.read_bytes() == data)
        check(f"{d.name}: meta.json + game.json on disk", (root / d.name / "game.json").is_file()
              and (root / d.name / vs["v001"]["dir"] / "meta.json").is_file())

    # ---- library list
    s, lib = c.json("GET", "/api/games")
    check("library lists every game", s == 200 and len(lib["games"]) == len(made))
    check("library sorted by last edited", [g["updated"] for g in lib["games"]] == sorted((g["updated"] for g in lib["games"]), reverse=True))
    check("tile has last_detect", all(g["last_detect"] is None or "plugin" in g["last_detect"] for g in lib["games"]))

    slug = "fixture-quest" if "fixture-quest" in made else next(iter(made))
    base = f"/api/games/{slug}"

    # ---- zip of a multi-file version
    s, hdr, z = c.req("GET", f"{base}/versions/v001/zip")
    import io
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(z)).namelist() if s == 200 else []
    check("zip of v001 has every file with its name", s == 200 and sorted(names) == sorted(f.name for f in (samples / slug / "backup").iterdir()))

    # ---- notes card
    upd = {"notes": "file1 = slot 1", "rules": "gold stored once", "install_dir": r"D:\Games\FixtureQuest",
           "save_location": r"<install>\www\save", "steam_cloud_ack": True, "plugin": "rpgmaker-mv", "engine": "RPG Maker MV"}
    s, g = c.json("PUT", base, upd)
    sl = g.get("save_location", {})
    check("notes card saved", s == 200 and g["notes"] == upd["notes"] and g["rules"] == upd["rules"] and g["steam_cloud_ack"] is True)
    check("user save location wins + <install> filled", sl.get("source") == "user" and sl.get("resolved") == [r"D:\Games\FixtureQuest\www\save"], str(sl))
    s, g = c.json("PUT", base, {"save_location": ""})
    sl = g.get("save_location", {})
    check("cleared user location falls back to engine default", sl.get("source") in ("engine", "pcgamingwiki")
          and sl.get("paths") and sl["engine_default"] == r"<install>\www\save", str(sl))
    s, _ = c.json("PUT", base, {"steam_cloud_ack": "yes"})
    check("steam_cloud_ack must be bool", s == 400)
    s, _ = c.json("PUT", base, {"notes": "x" * 100_001})
    check("notes over the limit -> 400", s == 400)

    # ---- rename (name, then folder)
    s, g = c.json("PUT", base, {"name": "Fixture Quest: Director's Cut"})
    check("rename keeps the folder", s == 200 and g["name"] == "Fixture Quest: Director's Cut" and g["slug"] == slug)
    s, g = c.json("PUT", base, {"slug": "fq"})
    check("move to a new folder id", s == 200 and g["slug"] == "fq" and (root / "fq" / "game.json").is_file() and not (root / slug).exists())
    s, _ = c.json("PUT", "/api/games/fq", {"slug": "../evil"})
    check("bad new folder id -> 400", s == 400)
    other = next(k for k in made if k != slug)
    s, _ = c.json("PUT", "/api/games/fq", {"slug": other})
    check("folder id taken -> 409", s == 409)
    s, g = c.json("PUT", "/api/games/fq", {"slug": slug})
    check("move back", s == 200 and g["slug"] == slug)

    # ---- key files
    key = b"signing-key = abc\n"
    s, k = c.json("PUT", f"{base}/keys/security_keys.txt", key, {"Content-Type": "application/octet-stream"})
    check("key file stored", s == 200 and k["keys"][0]["name"] == "security_keys.txt" and (root / slug / "keys" / "security_keys.txt").read_bytes() == key)
    s, _, got = c.req("GET", f"{base}/keys/security_keys.txt")
    check("key file served back", s == 200 and got == key)
    for bad in ("..", ".hidden", q("a/b"), q("..\\x"), q("con:x")):
        s, _ = c.json("PUT", f"{base}/keys/{bad}", b"x", {"Content-Type": "application/octet-stream"})
        check(f"bad key name {bad!r} -> 400/404", s in (400, 404), str(s))
    s, k = c.json("DELETE", f"{base}/keys/security_keys.txt")
    check("key file deleted", s == 200 and k["keys"] == [])

    # ---- cover upload fallback
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    s, g = c.json("PUT", f"{base}/cover", png, {"Content-Type": "image/png"})
    check("cover upload", s == 200 and g["cover_source"] == "upload" and g["cover"].startswith(f"/api/games/{slug}/cover?v="))
    s, hdr, got = c.req("GET", f"{base}/cover")
    check("cover served as image/png", s == 200 and got == png and hdr.get("Content-Type") == "image/png")
    s, _ = c.json("PUT", f"{base}/cover", b"<svg/>", {"Content-Type": "image/svg+xml"})
    check("non-image cover -> 400", s == 400)
    s, g = c.json("DELETE", f"{base}/cover")
    check("cover deleted", s == 200 and g["cover"] is None and not list((root / slug).glob("cover.*")))

    # ---- odd file names: exact name back, safe name on disk
    odd = [("save: 1?.dat", b"one"), ("meta.json", b"{\"not\": \"ours\"}"), ("CON.sav", b"con"), ("trail. ", b"t"),
           ("Ünïcode ✓.sav", b"uni")]
    s, v = upload(c, slug, odd, label="odd names")
    stored = {f["name"]: f["stored"] for f in v.get("files", [])}
    check("odd names upload", s == 201, str(v))
    check("odd names stored Windows-safe", stored.get("save: 1?.dat") == "save_ 1_.dat" and stored.get("meta.json") == "_meta.json"
          and stored.get("CON.sav") == "_CON.sav" and stored.get("trail. ") == "trail__", str(stored))
    for name, data in odd:
        s, hdr, got = c.req("GET", f"{base}/versions/{v.get('id')}/files/{q(name)}")
        check(f"odd name {name!r} downloads with its exact name", s == 200 and got == data
              and f"filename*=UTF-8''{q(name)}" in hdr.get("Content-Disposition", ""))

    # ---- rejected uploads
    s, _ = upload(c, slug, [("a.sav", b"x"), ("A.SAV", b"y")])
    check("same name twice (any case) -> 400", s == 400)
    for bad in ("../x", "..", "a/b", "a\\b", "", "x\x00y"):
        s, _ = upload(c, slug, [(bad, b"x")])
        check(f"bad upload name {bad!r} -> 400", s == 400)
    s, _ = upload(c, slug, [("a.sav", b"x")], parent="v999")
    check("unknown parent -> 400", s == 400)
    s, _ = upload(c, slug, [("a.sav", b"x")], detect={"integrity": "maybe"})
    check("bad detect.integrity -> 400", s == 400)
    meta = {"files": [{"name": "a.sav", "size": 1, "sha256": "0" * 64}]}
    s, _, _ = c.req("POST", f"{base}/versions", frame(meta, [b"x"]), {"Content-Type": "application/x-eitri-version"})
    check("sha256 mismatch -> 400, nothing kept", s == 400 and not list((root / slug).glob(".upload-*")))
    s, _, _ = c.req("POST", f"{base}/versions", frame({"files": [{"name": "a.sav", "size": 5}]}, [b"xx"]),
                    {"Content-Type": "application/x-eitri-version"})
    check("Content-Length vs sizes mismatch -> 400", s == 400)
    s, _, _ = c.req("POST", f"{base}/versions", frame({"files": [{"name": "a", "size": 1}]}, [b"x"]), {"Content-Type": "application/octet-stream"})
    check("wrong Content-Type -> 415", s == 415)
    big = 64 * 1024 * 1024 + 1
    s, _, _ = c.req("POST", f"{base}/versions", frame({"files": [{"name": "big.sav", "size": big}]}, []),
                    {"Content-Type": "application/x-eitri-version"})
    check("version over 64 MB (declared in meta) -> 413", s == 413)
    # Content-Length over the cap: rejected from the header, before any body is read
    conn = http.client.HTTPConnection(c.host, c.port, timeout=10)
    conn.putrequest("POST", f"{base}/versions")
    conn.putheader("Content-Type", "application/x-eitri-version")
    conn.putheader("X-Eitri", "1")
    conn.putheader("Content-Length", str(70 * 1024 * 1024))
    conn.endheaders()
    conn.send(b"\x00\x00\x00\x02{}")
    r = conn.getresponse()
    check("Content-Length over the cap -> 413 without reading the body", r.status == 413)
    conn.close()
    # ---- review fixes (2026-11-11): malformed input is a clean 4xx, never a dropped connection or a traceback
    for bad in ([1], [{"before": "1"}], ["x"], [{"path": 5}]):
        s, r = upload(c, slug, [("a.sav", b"x")], changed=bad)
        check(f"bad changed entry {bad!r} -> 400 (the page renders every entry)", s == 400 and "error" in r, str(s))
    s, r = c.json("PUT", base, {"steam_appid": "²"})
    check("non-ASCII digit app id -> 400, not 500", s == 400, f"{s} {r}")
    deep = b"[" * 100000 + b"]" * 100000
    s, _, body = c.req("POST", f"{base}/lookup", deep[:200000], {"Content-Type": "application/json"})
    check("deeply nested JSON -> 400 JSON error", s == 400 and body.startswith(b'{"error"') and b"Traceback" not in body, f"{s} {body[:80]}")
    m = json.dumps({"files": [{"name": "a.sav", "size": 1}], "note": [[[]]]}).encode()
    s, _, body = c.req("POST", f"{base}/versions", struct.pack(">I", len(m)) + m + b"x", {"Content-Type": "application/x-eitri-version"})
    check("note that isn't text -> 400", s == 400 and b"Traceback" not in body, str(s))
    conn = http.client.HTTPConnection(c.host, c.port, timeout=10)
    conn.putrequest("PUT", f"{base}/keys/k.txt")
    conn.putheader("X-Eitri", "1")
    conn.putheader("Content-Length", "²".encode("latin-1").decode("latin-1"))
    conn.endheaders()
    r = conn.getresponse()
    check("Content-Length that isn't ASCII digits -> 411", r.status == 411, str(r.status))
    conn.close()
    # a rename while an upload streams in: the upload still lands, in the renamed folder, with no staging leftovers
    payload = b"z" * 300_000
    m = json.dumps({"files": [{"name": "slow.sav", "size": len(payload)}], "label": "during rename"}).encode()
    conn = http.client.HTTPConnection(c.host, c.port, timeout=30)
    conn.putrequest("POST", f"{base}/versions")
    conn.putheader("Content-Type", "application/x-eitri-version")
    conn.putheader("X-Eitri", "1")
    conn.putheader("Content-Length", str(4 + len(m) + len(payload)))
    conn.endheaders()
    conn.send(struct.pack(">I", len(m)) + m + payload[:1000])
    time.sleep(0.5)
    s, g = c.json("PUT", base, {"slug": "mid-rename"})
    conn.send(payload[1000:])
    r = conn.getresponse()
    rbody = r.read()
    conn.close()
    landed = list((root / "mid-rename").glob("v*-during-rename/slow.sav"))
    check("upload during a rename lands in the renamed folder", s == 200 and r.status == 201 and len(landed) == 1
          and landed[0].read_bytes() == payload and not list((root / "mid-rename").glob(".upload-*")), f"{s} {r.status} {rbody[:200]}")
    s, g = c.json("PUT", "/api/games/mid-rename", {"slug": slug})
    check("rename back after the mid-upload test", s == 200 and g["slug"] == slug)
    s, v64 = upload(c, slug, [("exact64.bin", os.urandom(1024) * (64 * 1024))], label="64 MB exactly")
    check("version of exactly 64 MB accepted", s == 201 and v64.get("size") == 64 * 1024 * 1024, str(s))

    # ---- traversal on every path parameter
    for path in ("/api/games/..%2F..%2Fetc", "/api/games/../../etc/passwd", "/api/games/_import",
                 "/api/games/.ssh", f"{base}/versions/..%2F..", f"{base}/versions/v001/files/..%2Fgame.json",
                 f"{base}/versions/v001/files/..", f"{base}/versions/v001/files/%2Fetc%2Fpasswd", f"{base}/keys/..%2Fgame.json",
                 f"{base}/versions/v001/files/meta.json"):
        s, _, body = c.req("GET", path)
        check(f"traversal {path} refused", s in (400, 404) and b"root:" not in body and b'"next_version"' not in body, str(s))

    # ---- deletes: explicit confirm only
    s, _ = c.json("DELETE", f"{base}/versions/v002")
    check("version delete without confirm -> 400", s == 400 and any((root / slug).glob("v002-*")))
    s, d = c.json("DELETE", f"{base}/versions/v002?confirm=v002")
    check("version delete with confirm", s == 200 and not any((root / slug).glob("v002-*")))
    s, v = upload(c, slug, [("after.sav", b"z")], parent="v001")
    check("version numbers are never reused", s == 201 and v.get("id") not in ("v002",) and int(v["id"][1:]) > 4, str(v.get("id")))
    s, gd = c.json("GET", base)
    check("v001 children updated after delete", "v002" not in next(x for x in gd["versions"] if x["id"] == "v001")["children"])
    s, _ = c.json("DELETE", base)
    check("game delete without confirm -> 400", s == 400 and (root / slug).is_dir())
    s, _ = c.json("DELETE", f"{base}?confirm={slug}")
    check("game delete with confirm", s == 200 and not (root / slug).exists() and not list(root.glob(".deleting-*")))
    s, _ = c.json("GET", base)
    check("deleted game -> 404", s == 404)

    # ---- a folder made by hand on Windows
    hand = root / made[other]["slug"] / "v050-from-windows"
    hand.mkdir()
    (hand / "hand.sav").write_bytes(b"hand")
    s, gd = c.json("GET", f"/api/games/{other}")
    hv = next((x for x in gd.get("versions", []) if x["id"] == "v050"), None)
    check("hand-made version folder listed", hv is not None and hv["kind"] == "manual" and hv["files"][0]["name"] == "hand.sav")
    s, _, got = c.req("GET", f"/api/games/{other}/versions/v050/files/hand.sav")
    check("hand-made version downloads", s == 200 and got == b"hand")

    # ---- lookups
    s, r = c.json("GET", "/api/steam/search?q=")
    check("steam search needs q", s == 400)
    s, r = c.json("GET", "/api/pcgw?appid=abc")
    check("pcgw needs a numeric appid", s == 400)
    if a.online:
        s, r = c.json("GET", "/api/steam/search?q=Brotato")
        check("steam search Brotato finds 1942280", s == 200 and any(x["appid"] == 1942280 for x in r["results"]), str(r)[:200])
        first_search = r
        s, r = c.json("GET", "/api/pcgw?appid=1942280")
        check("pcgw Brotato: %APPDATA% save path + Steam Cloud", s == 200 and r["steam_cloud"] is True
              and any(x["path"].startswith("%APPDATA%\\Brotato\\<user-id>") for x in r["save_locations"]), str(r)[:300])
        s, g = c.json("POST", "/api/games", {"name": "Lies of P", "steam_appid": 1627720})
        sl = g.get("save_location", {})
        check("create with app id: cover cached + PCGW looked up", s == 201 and g["lookup"].get("cover") == "ok"
              and g["cover_source"] == "steam" and sl.get("source") == "pcgamingwiki"
              and any("<install>\\LiesofP\\Saved\\SaveGames" in p for p in sl["paths"]) and g["steam_cloud_warning"] is True, str(g)[:400])
        cover = next(iter((root / g["slug"]).glob("cover.*")), None)
        check("cover file in the game folder", cover is not None and cover.stat().st_size > 10_000)
        s, g = c.json("PUT", f"/api/games/{g['slug']}", {"install_dir": "D:\\SteamLibrary\\steamapps\\common\\Lies of P"})
        check("<install> filled from the install folder", any(p.startswith("D:\\SteamLibrary\\steamapps\\common\\Lies of P\\LiesofP")
                                                              for p in g["save_location"]["resolved"]))
        s, r2 = c.json("GET", "/api/steam/search?q=Brotato")
        check("second search comes from the cache", s == 200 and r2 == first_search and r2["error"] is None)
    else:
        s, r = c.json("GET", "/api/steam/search?q=Brotato")
        check("offline steam search degrades (200, error, no results)", s == 200 and r["results"] == [] and r["error"])
        s, r = c.json("GET", "/api/pcgw?appid=1942280")
        check("offline pcgw degrades", s == 200 and r["save_locations"] == [] and r["error"])
        s, g = c.json("POST", "/api/games", {"name": "Offline Game", "steam_appid": 1942280, "engine": "Godot 3"})
        check("offline create still works, engine default used", s == 201 and g["cover"] is None
              and g["save_location"]["source"] == "engine" and "cover" in g["lookup"], str(g)[:300])
        s, g = c.json("POST", f"/api/games/{g['slug']}/lookup", {})
        check("offline re-lookup degrades", s == 200 and g["lookup"].get("pcgw"))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    for f in FAIL:
        print("  FAIL", f)
    if FAIL:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
