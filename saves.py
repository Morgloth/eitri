"""Eitri: the save-game library behind the save editor (API in API.md).

The server only stores bytes and metadata; decoding, editing and diffing run in the browser (static/lib plugins), and
the page sends the plugin's detect result with every upload, which is kept as version metadata.

Storage is plain files, so the library stays browsable in a file manager. The saves folder (EITRI_SAVES_DIR, or
--saves-dir) holds:
    <root>/<game-slug>/game.json            name, Steam app id, notes card, save locations, cover, ...
    <root>/<game-slug>/cover.jpg|png|webp    cached once from Steam (600x900), or uploaded
    <root>/<game-slug>/keys/<name>           key files (Ren'Py security_keys.txt, Godot passwords)
    <root>/<game-slug>/vNNN-<label>/<files>  one version: the save files byte for byte + meta.json
Folders starting with "_" (e.g. _import/) or "." are never games. Version numbers are never reused (game.json keeps
the counter). Deletes are hard deletes, only through DELETE with ?confirm=<id>. Steam / PCGamingWiki answers are
cached in <root>/.cache/ (EITRI_CACHE_DIR) and every lookup degrades to "nothing found" when offline (EITRI_OFFLINE=1).
"""
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http import HTTPStatus
from pathlib import Path

ROOT = Path(os.environ.get("EITRI_SAVES_DIR", "saves")).resolve()
CACHE = Path(os.environ.get("EITRI_CACHE_DIR", str(ROOT / ".cache")))
OFFLINE = os.environ.get("EITRI_OFFLINE") == "1"  # never go out to Steam / PCGamingWiki
API_PREFIX = "/api/"

MAX_VERSION_BYTES = 64 * 1024 * 1024  # all files of one version together
MAX_META_BYTES = 1024 * 1024
MAX_FILES = 64
MAX_KEY_BYTES = 1024 * 1024
MAX_COVER_BYTES = 5 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
MAX_UPLOAD_BODY = 4 + MAX_META_BYTES + MAX_VERSION_BYTES
LIMITS = {"version_bytes": MAX_VERSION_BYTES, "meta_bytes": MAX_META_BYTES, "files_per_version": MAX_FILES,
          "key_bytes": MAX_KEY_BYTES, "cover_bytes": MAX_COVER_BYTES, "json_bytes": MAX_JSON_BYTES,
          "name": 100, "label": 200, "notes": 100_000, "rules": 20_000, "install_dir": 500, "save_location": 5000,
          "version_note": 2000, "changed": 5000, "pins": 200, "pin_label": 100, "pin_path": 64}

UA = "Mozilla/5.0 (compatible; Eitri save library; +https://github.com/Morgloth/eitri)"
HTTP_TIMEOUT = 8
SEARCH_TTL, PCGW_TTL, FAIL_TTL = 7 * 86400, 30 * 86400, 600
CSRF_HEADER = "X-Eitri"

SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?")
VID = re.compile(r"v(\d{3,6})")
VDIR = re.compile(r"v(\d{3,6})(?:-[A-Za-z0-9._-]*)?")
_BAD_CHARS = re.compile(r'[<>:"|?*\x00-\x1f\x7f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
_OUR_FILES = {"meta.json"}  # inside a version folder; a save file with this name is stored as _meta.json
IMAGE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
INTEGRITY = ("ok", "bad", "none", "unknown")

# Where an engine keeps its saves when PCGamingWiki has nothing (from the plan; only a guess).
ENGINE_DEFAULTS = {
    "rpgmaker": r"<install>\www\save",
    "unity": r"%USERPROFILE%\AppData\LocalLow\<Company>\<Game>",
    "godot": r"%APPDATA%\Godot\app_userdata\<Game>",
    "unreal": r"%LOCALAPPDATA%\<Project>\Saved\SaveGames",
    "renpy": r"%APPDATA%\RenPy\<game>",
}

_lock = threading.RLock()
_mem_cache = {}  # key -> (expires, value); failures too, so a dead network isn't hit on every request


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- small helpers
def _now():
    return int(time.time())


def time_text(ts):
    """Server local time, 24-hour: '2026-11-11 08:33' (set TZ to change it)."""
    if not ts:
        return ""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def slugify(text, limit=60):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"['’]", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:limit].strip("-")


def _check_slug(slug):
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise ApiError(HTTPStatus.BAD_REQUEST, "bad game id")
    return slug


def _inside(base, path):
    """True if path resolves to somewhere strictly inside base (no traversal, no symlink escape)."""
    try:
        return base.resolve() in path.resolve().parents
    except OSError:
        return False


def check_filename(name):
    """A save file name as the browser gives it (File.name). Kept exactly; only path tricks are refused."""
    if not isinstance(name, str) or not name or len(name) > 255 or len(name.encode("utf-8")) > 255:
        raise ApiError(HTTPStatus.BAD_REQUEST, "file names must be 1-255 characters")
    if "/" in name or "\\" in name or "\x00" in name or name in (".", "..") or name != name.strip("\r\n"):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"bad file name: {name!r}")
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"bad file name: {name!r}")
    return name


def stored_name(name):
    """The on-disk name: the original unless Windows can't hold it (then the odd characters become _)."""
    out = _BAD_CHARS.sub("_", name)
    out = re.sub(r"[. ]+$", lambda m: "_" * len(m.group(0)), out)
    if out.split(".", 1)[0].upper() in _RESERVED:
        out = "_" + out
    if out.lower() in _OUR_FILES:
        out = "_" + out
    return out


def _chmod(path, mode):
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _mkdir(path):
    path.mkdir(exist_ok=True)
    _chmod(path, 0o2775)  # group-writable + setgid like the rest of the share (the service umask is 022)


def _write_bytes(path, data):
    """Write via a temp file and rename, so nothing ever reads half a file."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        _chmod(tmp, 0o664)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _write_json(path, obj):
    _write_bytes(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def _read_json(path):
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else None
    except (OSError, ValueError):
        return None


def _pins(value):
    """Pinned fields (shown in the editor's Quick fields):
    [{"path": [str|int, ...], "label": str, "file": str, "match": [{"at": int, "key": str, "value": str}, ...]}].
    `file` names the unit in a multi-file version ("" = any). `match` anchors list entries: path[at] is a list index,
    and the page looks for the entry whose `key` child equals `value` (it may have moved). The page decides what
    the path means; the server only checks the shape."""
    if not isinstance(value, list) or len(value) > LIMITS["pins"]:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"pins must be a list of at most {LIMITS['pins']} entries")
    out = []
    for pin in value:
        if not isinstance(pin, dict) or set(pin) - {"path", "label", "file", "match"} or "path" not in pin:
            raise ApiError(HTTPStatus.BAD_REQUEST, "each pin is {path, label, file?, match?}")
        path = pin["path"]
        if (not isinstance(path, list) or not 1 <= len(path) <= LIMITS["pin_path"]
                or not all((isinstance(k, str) and len(k) <= 500) or (type(k) is int and 0 <= k < 10**9) for k in path)):
            raise ApiError(HTTPStatus.BAD_REQUEST, "a pin path is a list of keys (text) and indexes (whole numbers)")
        label = " ".join(_text(pin, "label", LIMITS["pin_label"]).split())
        if not label:
            raise ApiError(HTTPStatus.BAD_REQUEST, "a pin needs a label")
        match = pin.get("match") or []
        if (not isinstance(match, list) or len(match) > LIMITS["pin_path"]
                or not all(isinstance(m, dict) and set(m) == {"at", "key", "value"} and type(m["at"]) is int
                           and 0 <= m["at"] < len(path) and type(path[m["at"]]) is int
                           and isinstance(m["key"], str) and 0 < len(m["key"]) <= 500
                           and isinstance(m["value"], str) and len(m["value"]) <= 500 for m in match)):
            raise ApiError(HTTPStatus.BAD_REQUEST, "pin match entries are {at: index of a list position in path, key, value}")
        out.append({"path": path, "label": label, "file": _text(pin, "file", 255), "match": match})
    return out


def _text(body, key, limit, default=""):
    value = body.get(key, default)
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} must be text")
    if len(value) > limit:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{key} is longer than {limit} characters")
    return value


def _appid(value):
    if value in (None, ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not re.fullmatch(r"[0-9]{1,10}", str(value)) \
            or not 0 < int(value) < 10**10:
        raise ApiError(HTTPStatus.BAD_REQUEST, "steam_appid must be a number")
    return int(value)


def _root_ok():
    return ROOT.is_dir()


def _require_root():
    if not _root_ok():
        raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, f"{ROOT} doesn't exist")


# ---------------------------------------------------------------- outside lookups (cached)
def _cache_get(key, ttl):
    """(value, fresh) from memory or the cache folder; (None, False) when never fetched."""
    hit = _mem_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1], True
    path = CACHE / (hashlib.sha256(key.encode()).hexdigest()[:32] + ".json")
    obj = _read_json(path)
    if obj and "value" in obj:
        fresh = obj.get("at", 0) + ttl > time.time()
        if fresh:
            _mem_cache[key] = (obj["at"] + ttl, obj["value"])
        return obj["value"], fresh
    return None, False


def _cache_put(key, ttl, value):
    _mem_cache[key] = (time.time() + ttl, value)
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        _write_json(CACHE / (hashlib.sha256(key.encode()).hexdigest()[:32] + ".json"),
                    {"key": key, "at": _now(), "value": value})
    except OSError:
        pass


def _fetch(url, max_bytes=2 * 1024 * 1024, accept="application/json"):
    if OFFLINE:
        raise OSError("offline (EITRI_OFFLINE=1)")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        data = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise OSError("answer too large")
        return data, resp.headers.get("Content-Type", "")


def _cached_lookup(key, ttl, fn):
    """Run fn() through the cache. Returns (value, error, stale). Offline = stale cache or (None, error)."""
    value, fresh = _cache_get(key, ttl)
    if fresh:
        return value, None, False
    failed = _mem_cache.get("fail:" + key)
    if failed and failed[0] > time.time():
        return value, failed[1], value is not None
    try:
        value = fn()
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as exc:
        msg = f"lookup failed: {getattr(exc, 'reason', None) or exc}"
        _mem_cache["fail:" + key] = (time.time() + FAIL_TTL, msg)
        return value, msg, value is not None
    _cache_put(key, ttl, value)
    return value, None, False


def steam_search(term):
    """Steam store search by name (no key). [{appid, name, image}]."""
    term = " ".join(str(term or "").split())[:100]
    if not term:
        raise ApiError(HTTPStatus.BAD_REQUEST, "q is required")

    def run():
        q = urllib.parse.urlencode({"term": term, "l": "english", "cc": "US"})
        data, _ = _fetch("https://store.steampowered.com/api/storesearch/?" + q)
        items = json.loads(data).get("items") or []
        return [{"appid": int(i["id"]), "name": str(i.get("name", "")), "image": str(i.get("tiny_image", "")),
                 "type": str(i.get("type", "app"))} for i in items[:10] if str(i.get("id", "")).isdigit()]

    results, error, stale = _cached_lookup("steam-search:" + term.lower(), SEARCH_TTL, run)
    return {"q": term, "results": results or [], "error": error, "stale": stale}


_P_TEMPLATE = {
    "appdata": "%APPDATA%", "localappdata": "%LOCALAPPDATA%", "userprofile": "%USERPROFILE%",
    "userprofile\\documents": "%USERPROFILE%\\Documents", "userprofile\\appdata\\locallow": "%USERPROFILE%\\AppData\\LocalLow",
    "programdata": "%PROGRAMDATA%", "public": "%PUBLIC%", "windir": "%WINDIR%", "username": "%USERNAME%",
    "game": "<install>", "steam": "<Steam>", "uid": "<user-id>", "hkcu": "HKEY_CURRENT_USER",
    "hklm": "HKEY_LOCAL_MACHINE", "wow64": "WOW6432Node", "ubisoftconnect": "<Ubisoft Connect>",
}
_NOT_WINDOWS = {"os x", "linux", "mac app store", "steam play (linux)", "macos"}


def _templates(text, name):
    """Argument lists of every {{name|...}} in wikitext (nested templates kept inside the arguments)."""
    out, low, start = [], text.lower(), 0
    needle = "{{" + name.lower()
    while True:
        i = low.find(needle, start)
        if i < 0:
            return out
        depth, j = 0, i
        while j < len(text) - 1:
            if text.startswith("{{", j):
                depth, j = depth + 1, j + 2
                continue
            if text.startswith("}}", j):
                depth, j = depth - 1, j + 2
                if depth == 0:
                    break
                continue
            j += 1
        inner, args, depth, cur, k = text[i + 2:j - 2], [], 0, "", 0
        while k < len(inner):
            if inner.startswith("{{", k):
                depth, cur, k = depth + 1, cur + "{{", k + 2
            elif inner.startswith("}}", k):
                depth, cur, k = depth - 1, cur + "}}", k + 2
            elif inner[k] == "|" and depth == 0:
                args.append(cur)
                cur, k = "", k + 1
            else:
                cur, k = cur + inner[k], k + 1
        args.append(cur)
        out.append(args[1:])
        start = j


def _clean_path(raw):
    s = re.sub(r"(?is)<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", raw)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)  # HTML first: the placeholders below look like tags
    s = re.sub(r"(?i)\{\{p\|([^}|]+)\}\}", lambda m: _P_TEMPLATE.get(m.group(1).strip().lower(), f"<{m.group(1).strip()}>"), s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)  # notes and other templates
    return [p.strip() for p in s.split("\n") if p.strip()]


def parse_pcgw(wikitext):
    """Save locations (Windows-ish platforms, %VAR% form) and the Steam Cloud flag from a PCGamingWiki page."""
    locations = []
    for args in _templates(wikitext, "Game data/saves"):
        if not args or args[0].strip().lower() in _NOT_WINDOWS:
            continue
        for raw in args[1:]:
            for p in _clean_path(raw):
                entry = {"platform": args[0].strip(), "path": p}
                if entry not in locations:
                    locations.append(entry)
    m = re.search(r"(?im)^\s*\|\s*steam cloud\s*=\s*([a-z]*)", wikitext)
    cloud = {"true": True, "false": False, "limited": True}.get(m.group(1).lower()) if m else None
    return locations, cloud


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def pcgw_lookup(appid):
    """PCGamingWiki by Steam app id: {appid, page, url, save_locations[], steam_cloud, fetched}. page None = no article."""
    appid = _appid(appid)
    if appid is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, "appid is required")

    def run():
        if OFFLINE:
            raise OSError("offline (EITRI_OFFLINE=1)")
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(f"https://www.pcgamingwiki.com/api/appid.php?appid={appid}", headers={"User-Agent": UA})
        location = ""
        try:
            with opener.open(req, timeout=HTTP_TIMEOUT) as resp:
                location = resp.geturl()
        except urllib.error.HTTPError as exc:
            if exc.code not in (301, 302, 303, 307, 308):
                if exc.code == 404:
                    return {"appid": appid, "page": None, "url": None, "save_locations": [], "steam_cloud": None,
                            "fetched": _now()}
                raise
            location = exc.headers.get("Location", "")
        m = re.search(r"/wiki/([^?#]+)", location)
        if not m or m.group(1).startswith("Special:"):
            return {"appid": appid, "page": None, "url": None, "save_locations": [], "steam_cloud": None, "fetched": _now()}
        page = urllib.parse.unquote(m.group(1)).replace("_", " ")
        q = urllib.parse.urlencode({"action": "parse", "page": page, "prop": "wikitext", "format": "json",
                                    "formatversion": "2", "redirects": "1"})
        data, _ = _fetch("https://www.pcgamingwiki.com/w/api.php?" + q, max_bytes=4 * 1024 * 1024)
        parsed = json.loads(data).get("parse") or {}
        locations, cloud = parse_pcgw(parsed.get("wikitext") or "")
        title = parsed.get("title") or page
        return {"appid": appid, "page": title, "url": "https://www.pcgamingwiki.com/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                "save_locations": locations, "steam_cloud": cloud, "fetched": _now()}

    value, error, stale = _cached_lookup(f"pcgw:{appid}", PCGW_TTL, run)
    return {**(value or {"appid": appid, "page": None, "url": None, "save_locations": [], "steam_cloud": None,
                         "fetched": None}), "error": error, "stale": stale}


def _sniff_image(data):
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _fetch_steam_cover(appid):
    """The 600x900 library image, or raises OSError."""
    last = None
    for url in (f"https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg",
                f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"):
        try:
            data, _ = _fetch(url, max_bytes=MAX_COVER_BYTES, accept="image/*")
            if _sniff_image(data):
                return data
            last = OSError("not an image")
        except (OSError, urllib.error.URLError) as exc:
            last = exc
    raise OSError(f"no Steam cover: {getattr(last, 'reason', None) or last}")


# ---------------------------------------------------------------- games
def _game_dir(slug):
    _require_root()
    path = ROOT / _check_slug(slug)
    if not _inside(ROOT, path) or not (path / "game.json").is_file():
        raise ApiError(HTTPStatus.NOT_FOUND, "no such game")
    return path


def _load_game(slug):
    path = _game_dir(slug)
    game = _read_json(path / "game.json")
    if game is None:
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "game.json is unreadable")
    game["slug"] = slug
    return path, game


def _save_game(path, game):
    _write_json(path / "game.json", {k: v for k, v in game.items() if k != "slug"})


def _dir_size(path):
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if not f.startswith("."):
                try:
                    total += os.lstat(os.path.join(dirpath, f)).st_size
                except OSError:
                    pass
    return total


def _engine_key(game):
    text = f"{game.get('engine', '')} {game.get('plugin', '')}".lower().replace("'", "").replace(" ", "")
    for key, needles in (("rpgmaker", ("rpgmaker",)), ("renpy", ("renpy",)), ("unreal", ("unreal", "gvas", "ue4", "ue5")),
                         ("godot", ("godot",)), ("unity", ("unity",))):
        if any(n in text for n in needles):
            return key
    return None


def _save_location(game):
    user = game.get("save_location_user") or ""
    pcgw = game.get("pcgw") or {}
    looked_up = pcgw.get("save_locations") or []
    key = _engine_key(game)
    default = ENGINE_DEFAULTS.get(key) if key else None
    if user.strip():
        paths, source = [p.strip() for p in user.splitlines() if p.strip()], "user"
    elif looked_up:
        paths, source = [loc["path"] for loc in looked_up], "pcgamingwiki"
    elif default:
        paths, source = [default], "engine"
    else:
        paths, source = [], "none"
    install = (game.get("install_dir") or "").strip().rstrip("\\/")
    resolved = [p.replace("<install>", install) if install else p for p in paths]
    return {"user": user, "looked_up": looked_up, "engine_default": default, "paths": paths, "resolved": resolved,
            "source": source}


def _cover_file(path, game):
    name = game.get("cover")
    if name and re.fullmatch(r"cover\.(jpg|png|webp)", name) and (path / name).is_file():
        return path / name
    return None


def _keys(path):
    kdir = path / "keys"
    if not kdir.is_dir():
        return []
    out = []
    for f in sorted(kdir.iterdir(), key=lambda p: p.name.lower()):
        if f.is_file() and not f.name.startswith("."):
            st = f.stat()
            out.append({"name": f.name, "size": st.st_size, "modified": int(st.st_mtime),
                        "modified_text": time_text(int(st.st_mtime))})
    return out


def _summary(path, game, versions=None):
    versions = _versions(path) if versions is None else versions
    cover = _cover_file(path, game)
    latest = versions[-1] if versions else None
    updated = max([game.get("updated") or 0] + [v["created"] for v in versions])
    pcgw = game.get("pcgw") or {}
    return {
        "slug": game["slug"], "name": game.get("name", game["slug"]), "plugin": game.get("plugin", ""),
        "engine": game.get("engine", ""), "steam_appid": game.get("steam_appid"),
        "cover": f"/api/games/{game['slug']}/cover?v={int(cover.stat().st_mtime)}" if cover else None,
        "created": game.get("created", 0), "created_text": time_text(game.get("created", 0)),
        "updated": updated, "updated_text": time_text(updated),
        "version_count": len(versions), "size": _dir_size(path),
        "last_detect": latest["detect"] if latest else None,
        "steam_cloud": pcgw.get("steam_cloud"), "steam_cloud_ack": bool(game.get("steam_cloud_ack")),
    }


def _detail(path, game):
    versions = _versions(path)
    out = _summary(path, game, versions)
    pcgw = game.get("pcgw") or {}
    out.update({
        "steam_name": game.get("steam_name", ""),
        "cover_source": game.get("cover_source") if _cover_file(path, game) else None,
        "notes": game.get("notes", ""), "rules": game.get("rules", ""), "install_dir": game.get("install_dir", ""),
        "save_location": _save_location(game),
        "pins": game.get("pins") or [],
        "pcgw": {"page": pcgw.get("page"), "url": pcgw.get("url"), "steam_cloud": pcgw.get("steam_cloud"),
                 "fetched": pcgw.get("fetched"), "fetched_text": time_text(pcgw.get("fetched") or 0),
                 "error": pcgw.get("error")} if pcgw else None,
        "steam_cloud_warning": pcgw.get("steam_cloud") is True and not game.get("steam_cloud_ack"),
        "keys": _keys(path),
        "versions": versions,
        "folder": game["slug"],
    })
    return out


def list_games():
    if not _root_ok():
        return []
    out = []
    try:
        entries = list(ROOT.iterdir())
    except OSError:
        return []
    for d in entries:
        if d.name.startswith(("_", ".")) or not d.is_dir() or not SLUG.fullmatch(d.name):
            continue
        game = _read_json(d / "game.json")
        if game is None:
            continue
        game["slug"] = d.name
        try:
            out.append(_summary(d, game))
        except OSError:
            continue
    out.sort(key=lambda g: (-g["updated"], g["name"].lower()))
    return out


def state():
    """The page's __INITIAL_DATA__ (and GET /api/state)."""
    ok = _root_ok()
    return {"ok": ok, "error": None if ok else f"{ROOT} doesn't exist", "games": list_games(), "saves_dir": str(ROOT), "limits": LIMITS,
            "engine_defaults": ENGINE_DEFAULTS, "now": _now(), "now_text": time_text(_now())}


def _run_lookups(path, game, cover=None, pcgw=True):
    """Steam cover (once, unless forced) + PCGamingWiki, for a game with a Steam app id. Never raises."""
    report = {}
    appid = game.get("steam_appid")
    if not appid:
        return report
    if pcgw:
        found = pcgw_lookup(appid)
        if found.get("error") and not found.get("fetched"):
            report["pcgw"] = found["error"]
            game["pcgw"] = {**(game.get("pcgw") or {}), "error": found["error"]}
        else:
            game["pcgw"] = {k: found.get(k) for k in ("appid", "page", "url", "save_locations", "steam_cloud", "fetched")}
            game["pcgw"]["error"] = found.get("error")
            report["pcgw"] = "ok" if found.get("page") else "no PCGamingWiki article"
    # cover None = only when there is none yet; True = fetch again (replaces an uploaded one); False = leave it
    if cover or (cover is None and _cover_file(path, game) is None):
        try:
            data = _fetch_steam_cover(appid)
            with _lock:
                _set_cover(path, game, data, "steam")
            report["cover"] = "ok"
        except OSError as exc:
            report["cover"] = str(exc)
    return report


def _set_cover(path, game, data, source):
    kind = _sniff_image(data)
    if not kind:
        raise ApiError(HTTPStatus.BAD_REQUEST, "covers must be JPEG, PNG or WebP")
    name = f"cover.{kind}"
    _write_bytes(path / name, data)
    for other in IMAGE_TYPES:
        if other != kind and (path / f"cover.{other}").exists():
            (path / f"cover.{other}").unlink()
    game["cover"], game["cover_source"] = name, source


def _merge_lookup(slug, path, game):
    """Store what _run_lookups found (pcgw + cover) into the game as it is now on disk, so edits or a rename made while
    the slow lookup ran aren't overwritten. Returns (path, game) as now stored; unchanged if the game went away."""
    with _lock:
        try:
            path2, fresh = _load_game(slug)
        except ApiError:
            return path, game
        for k in ("pcgw", "cover", "cover_source"):
            fresh[k] = game.get(k)
        if _cover_file(path2, fresh) is None:
            fresh["cover"], fresh["cover_source"] = None, None
        _save_game(path2, fresh)
        return path2, fresh


def create_game(body):
    _require_root()
    name = " ".join(_text(body, "name", LIMITS["name"]).split())
    if not name:
        raise ApiError(HTTPStatus.BAD_REQUEST, "name is required")
    unknown = set(body) - {"name", "plugin", "engine", "steam_appid", "steam_name", "slug"}
    if unknown:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"unknown fields: {', '.join(sorted(unknown))}")
    base = body.get("slug") or slugify(name) or "game"
    base = _check_slug(base) if body.get("slug") else base
    now = _now()
    game = {"name": name, "plugin": _text(body, "plugin", 100), "engine": _text(body, "engine", 100),
            "steam_appid": _appid(body.get("steam_appid")), "steam_name": _text(body, "steam_name", 200),
            "notes": "", "rules": "", "install_dir": "", "save_location_user": "", "steam_cloud_ack": False, "pins": [],
            "cover": None, "cover_source": None, "pcgw": None, "created": now, "updated": now, "next_version": 1}
    with _lock:
        slug, n = base, 2
        while (ROOT / slug).exists():
            if body.get("slug"):
                raise ApiError(HTTPStatus.CONFLICT, "a game with that id already exists")
            slug = f"{base[:57].rstrip('-')}-{n}"
            n += 1
        path = ROOT / slug
        _mkdir(path)
        game["slug"] = slug
        _save_game(path, game)
    report = _run_lookups(path, game)
    path, game = _merge_lookup(slug, path, game)
    return {**_detail(path, game), "lookup": report}, HTTPStatus.CREATED


def update_game(slug, body):
    allowed = {"name", "slug", "plugin", "engine", "notes", "rules", "install_dir", "save_location", "steam_cloud_ack",
               "steam_appid", "steam_name", "pins"}
    unknown = set(body) - allowed
    if unknown:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"unknown fields: {', '.join(sorted(unknown))}")
    with _lock:
        path, game = _load_game(slug)
        if "name" in body:
            name = " ".join(_text(body, "name", LIMITS["name"]).split())
            if not name:
                raise ApiError(HTTPStatus.BAD_REQUEST, "name is required")
            game["name"] = name
        for key, limit, field in (("plugin", 100, "plugin"), ("engine", 100, "engine"), ("notes", LIMITS["notes"], "notes"),
                                  ("rules", LIMITS["rules"], "rules"), ("install_dir", LIMITS["install_dir"], "install_dir"),
                                  ("save_location", LIMITS["save_location"], "save_location_user"),
                                  ("steam_name", 200, "steam_name")):
            if key in body:
                game[field] = _text(body, key, limit)
        if "pins" in body:
            game["pins"] = _pins(body["pins"])
        if "steam_cloud_ack" in body:
            if not isinstance(body["steam_cloud_ack"], bool):
                raise ApiError(HTTPStatus.BAD_REQUEST, "steam_cloud_ack must be true or false")
            game["steam_cloud_ack"] = body["steam_cloud_ack"]
        appid_changed = "steam_appid" in body and _appid(body["steam_appid"]) != game.get("steam_appid")
        if appid_changed:
            game["steam_appid"] = _appid(body["steam_appid"])
            game["pcgw"] = None
        new_slug = body.get("slug")
        if new_slug is not None and new_slug != slug:
            _check_slug(new_slug)
            target = ROOT / new_slug
            if target.exists():
                raise ApiError(HTTPStatus.CONFLICT, "a game with that id already exists")
            os.rename(path, target)
            path, slug = target, new_slug
            game["slug"] = slug
        game["updated"] = _now()
        _save_game(path, game)
    report = {}
    if appid_changed and game.get("steam_appid"):
        steam_cover = game.get("cover_source") != "upload"
        report = _run_lookups(path, game, cover=steam_cover)
        path, game = _merge_lookup(slug, path, game)
    return {**_detail(path, game), "lookup": report}


def lookup_game(slug, body):
    path, game = _load_game(slug)
    if not game.get("steam_appid"):
        raise ApiError(HTTPStatus.BAD_REQUEST, "this game has no Steam app id")
    if body.get("pcgw", True):
        _mem_cache.pop(f"pcgw:{game['steam_appid']}", None)
        _mem_cache.pop(f"fail:pcgw:{game['steam_appid']}", None)
        cache_file = CACHE / (hashlib.sha256(f"pcgw:{game['steam_appid']}".encode()).hexdigest()[:32] + ".json")
        old = _read_json(cache_file)
        if old:  # stale it, so the lookup goes out again but an offline retry still has the old answer
            old["at"] = 0
            try:
                _write_json(cache_file, old)
            except OSError:
                pass
    report = _run_lookups(path, game, cover=bool(body.get("cover")) or None, pcgw=bool(body.get("pcgw", True)))
    path, game = _merge_lookup(slug, path, game)
    return {**_detail(path, game), "lookup": report}


def delete_game(slug, confirm):
    with _lock:
        path = _game_dir(slug)
        if confirm != slug:
            raise ApiError(HTTPStatus.BAD_REQUEST, "add ?confirm=<game id> to delete a game and every version")
        doomed = ROOT / f".deleting-{slug}-{secrets.token_hex(4)}"
        os.rename(path, doomed)  # gone from the library at once, even if the rmtree below is slow
    shutil.rmtree(doomed, ignore_errors=True)
    return {"deleted": slug}


# ---------------------------------------------------------------- versions
def _version_dirs(path):
    out = []
    for d in path.iterdir():
        m = VDIR.fullmatch(d.name)
        if m and d.is_dir():
            out.append((int(m.group(1)), d))
    out.sort()
    return out


def _version_obj(n, d, meta):
    if meta is None:  # a folder made by hand from Windows: list what's in it
        files = []
        for f in sorted(d.iterdir(), key=lambda p: p.name.lower()):
            if f.is_file() and not f.name.startswith(".") and f.name not in _OUR_FILES:
                files.append({"name": f.name, "stored": f.name, "size": f.stat().st_size, "sha256": None})
        mtime = int(d.stat().st_mtime)
        meta = {"label": d.name.partition("-")[2] or "manual", "kind": "manual", "parent": None, "created": mtime,
                "files": files, "detect": None, "changed": [], "note": ""}
    files = meta.get("files") or []
    vid = f"v{n:03d}"
    return {"id": vid, "n": n, "dir": d.name, "label": meta.get("label", ""), "kind": meta.get("kind", "upload"),
            "parent": meta.get("parent"), "parent_exists": False, "children": [],
            "created": meta.get("created", 0), "created_text": time_text(meta.get("created", 0)),
            "files": files, "size": sum(f.get("size") or 0 for f in files), "detect": meta.get("detect"),
            "changed": meta.get("changed") or [], "note": meta.get("note", "")}


def _versions(path):
    out = [_version_obj(n, d, _read_json(d / "meta.json")) for n, d in _version_dirs(path)]
    by_id = {v["id"]: v for v in out}
    for v in out:
        parent = by_id.get(v["parent"]) if v["parent"] else None
        if parent:
            v["parent_exists"] = True
            parent["children"].append(v["id"])
    return out


def _find_version(path, vid):
    m = VID.fullmatch(vid or "")
    if not m:
        raise ApiError(HTTPStatus.BAD_REQUEST, "bad version id")
    for n, d in _version_dirs(path):
        if n == int(m.group(1)):
            return n, d
    raise ApiError(HTTPStatus.NOT_FOUND, "no such version")


def get_version(slug, vid):
    path, _ = _load_game(slug)
    n, d = _find_version(path, vid)
    versions = {v["id"]: v for v in _versions(path)}
    return versions[f"v{n:03d}"]


def _clean_detect(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "detect must be an object")
    out = {}
    for key in ("plugin", "engine", "format", "integrity_text", "status", "game_rule"):
        if raw.get(key) is not None:
            if not isinstance(raw[key], str) or len(raw[key]) > 200:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"detect.{key} must be text up to 200 characters")
            out[key] = raw[key]
    if raw.get("integrity") is not None:
        if raw["integrity"] not in INTEGRITY:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"detect.integrity must be one of {', '.join(INTEGRITY)}")
        out["integrity"] = raw["integrity"]
    if raw.get("roundtrip") is not None:
        if not isinstance(raw["roundtrip"], bool):
            raise ApiError(HTTPStatus.BAD_REQUEST, "detect.roundtrip must be true or false")
        out["roundtrip"] = raw["roundtrip"]
    return out


def _read_exact(rfile, n, out=None):
    """Read n bytes (into the open file out, or return them). Short read = the client went away."""
    chunks, left = [], n
    while left:
        chunk = rfile.read(min(left, 1 << 20))
        if not chunk:
            raise ApiError(HTTPStatus.BAD_REQUEST, "upload ended early")
        left -= len(chunk)
        if out is not None:
            out.write(chunk)
        else:
            chunks.append(chunk)
    return b"".join(chunks)


class _HashingWriter:
    def __init__(self, f):
        self.f, self.hash = f, hashlib.sha256()

    def write(self, b):
        self.hash.update(b)
        self.f.write(b)


def _store_file(rfile, dest, size):
    """Stream size bytes from the request into dest; returns the sha256 hex."""
    with open(dest, "wb") as out:
        w = _HashingWriter(out)
        _read_exact(rfile, size, w)
    return w.hash.hexdigest()


def upload_version(slug, length, rfile):
    """Body: 4-byte big-endian meta length, meta JSON (UTF-8), then every file's bytes in meta.files order."""
    path, game = _load_game(slug)
    if length < 4:
        raise ApiError(HTTPStatus.BAD_REQUEST, "empty upload")
    meta_len = int.from_bytes(_read_exact(rfile, 4), "big")
    if meta_len < 2 or meta_len > MAX_META_BYTES or 4 + meta_len > length:
        raise ApiError(HTTPStatus.BAD_REQUEST, "bad meta length")
    try:
        meta = json.loads(_read_exact(rfile, meta_len).decode("utf-8"))
        if not isinstance(meta, dict):
            raise ValueError
    except (ValueError, RecursionError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "meta is not valid JSON") from None
    unknown = set(meta) - {"label", "parent", "detect", "changed", "note", "files"}
    if unknown:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"unknown meta fields: {', '.join(sorted(unknown))}")
    files = meta.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"files must list 1-{MAX_FILES} files")
    seen, stored_seen, plan = set(), set(), []
    for f in files:
        if not isinstance(f, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "each file is {name, size, sha256?}")
        name = check_filename(f.get("name"))
        size = f.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"bad size for {name}")
        sha = f.get("sha256")
        if sha is not None and (not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha)):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"bad sha256 for {name}")
        if name.lower() in seen:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} is in the list twice")
        seen.add(name.lower())
        stored, k = stored_name(name), 2
        while stored.lower() in stored_seen:
            stem, dot, ext = stored_name(name).rpartition(".")
            stored = f"{stem} ({k}).{ext}" if dot and stem else f"{stored_name(name)} ({k})"
            k += 1
        stored_seen.add(stored.lower())
        plan.append({"name": name, "stored": stored, "size": size, "sha256": sha.lower() if sha else None})
    total = sum(p["size"] for p in plan)
    if total > MAX_VERSION_BYTES:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"a version can be at most {MAX_VERSION_BYTES // (1024 * 1024)} MB")
    if 4 + meta_len + total != length:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length doesn't match the file sizes in meta")
    label = " ".join(_text(meta, "label", LIMITS["label"]).split())
    note = _text(meta, "note", LIMITS["version_note"])
    changed = meta.get("changed") or []
    if not isinstance(changed, list) or len(changed) > LIMITS["changed"]:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"changed must be a list of at most {LIMITS['changed']} entries")
    for c in changed:  # stored as sent, but the page renders each entry: objects with a path only
        if not isinstance(c, dict) or not isinstance(c.get("path"), (list, str)):
            raise ApiError(HTTPStatus.BAD_REQUEST, "each changed entry is {path, before, after, linked?, rule?}")
    detect = _clean_detect(meta.get("detect"))
    parent = meta.get("parent")
    if parent is not None:
        if not isinstance(parent, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "parent must be a version id")
        try:
            pn, _ = _find_version(path, parent)
        except ApiError:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"parent {parent} doesn't exist") from None
        parent = f"v{pn:03d}"
    kind = "edit" if parent else "upload"
    label = label or kind

    staging = path / f".upload-{secrets.token_hex(6)}"
    staging.mkdir()
    try:
        for p in plan:
            digest = _store_file(rfile, staging / p["stored"], p["size"])
            _chmod(staging / p["stored"], 0o664)
            if p["sha256"] and p["sha256"] != digest:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"{p['name']}: sha256 doesn't match what arrived")
            p["sha256"] = digest
        now = _now()
        with _lock:
            # re-read: a rename or edit may have happened during the upload (the staging folder moved along with it)
            try:
                path, game = _load_game(slug)
            except ApiError:
                moved = [d for d in ROOT.iterdir() if SLUG.fullmatch(d.name) and (d / staging.name).is_dir()]
                if not moved:
                    raise
                slug = moved[0].name
                path, game = _load_game(slug)
            staging = path / staging.name
            n = max([game.get("next_version") or 1] + [m + 1 for m, _ in _version_dirs(path)])
            vid = f"v{n:03d}"
            record = {"id": vid, "label": label, "kind": kind, "parent": parent, "created": now,
                      "created_text": time_text(now), "files": plan, "detect": detect, "changed": changed, "note": note}
            _write_json(staging / "meta.json", record)
            _chmod(staging, 0o2775)
            dirname = f"{vid}-{slugify(label, 40) or kind}"
            os.rename(staging, path / dirname)
            game["next_version"] = n + 1
            game["updated"] = now
            if detect and not game.get("plugin") and detect.get("plugin"):
                game["plugin"] = detect["plugin"]
            if detect and not game.get("engine") and detect.get("engine"):
                game["engine"] = detect["engine"]
            _save_game(path, game)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return get_version(slug, vid), HTTPStatus.CREATED


def delete_version(slug, vid, confirm):
    with _lock:
        path, game = _load_game(slug)
        n, d = _find_version(path, vid)
        if confirm != f"v{n:03d}":
            raise ApiError(HTTPStatus.BAD_REQUEST, "add ?confirm=<version id> to delete a version")
        doomed = path / f".deleting-{d.name}-{secrets.token_hex(4)}"
        os.rename(d, doomed)
        game["updated"] = _now()
        _save_game(path, game)
    shutil.rmtree(doomed, ignore_errors=True)
    return {"deleted": f"v{n:03d}", "game": slug}


def version_file(slug, vid, name):
    """(Path, original name, sha256) of one file of a version."""
    path, _ = _load_game(slug)
    n, d = _find_version(path, vid)
    version = _version_obj(n, d, _read_json(d / "meta.json"))
    for f in version["files"]:
        if f["name"] == name:
            full = d / f["stored"]
            if not _inside(d, full) or not full.is_file():
                raise ApiError(HTTPStatus.NOT_FOUND, "that file is missing on disk")
            return full, f["name"], f.get("sha256")
    raise ApiError(HTTPStatus.NOT_FOUND, "no such file in that version")


def version_zip(slug, vid):
    path, _ = _load_game(slug)
    n, d = _find_version(path, vid)
    version = _version_obj(n, d, _read_json(d / "meta.json"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for f in version["files"]:
            full = d / f["stored"]
            if _inside(d, full) and full.is_file():
                z.write(full, f["name"])
    return buf.getvalue(), f"{slug}-{version['dir']}.zip"


# ---------------------------------------------------------------- keys + cover
def _key_path(path, name):
    check_filename(name)
    if name.startswith(".") or stored_name(name) != name:
        raise ApiError(HTTPStatus.BAD_REQUEST, "key file names can't start with a dot or use <>:\"|?*")
    return path / "keys" / name  # no / or \\ and not . or ..: always directly inside keys/


def put_key(slug, name, data):
    with _lock:
        path, game = _load_game(slug)
        full = _key_path(path, name)
        _mkdir(path / "keys")
        _write_bytes(full, data)
        game["updated"] = _now()
        _save_game(path, game)
    return {"keys": _keys(path)}


def delete_key(slug, name):
    with _lock:
        path, _ = _load_game(slug)
        full = _key_path(path, name)
        if not full.is_file():
            raise ApiError(HTTPStatus.NOT_FOUND, "no such key file")
        full.unlink()
    return {"keys": _keys(path)}


def put_cover(slug, data):
    with _lock:
        path, game = _load_game(slug)
        _set_cover(path, game, data, "upload")
        _save_game(path, game)
    return _detail(path, game)


def delete_cover(slug):
    with _lock:
        path, game = _load_game(slug)
        cover = _cover_file(path, game)
        if cover:
            cover.unlink()
        game["cover"], game["cover_source"] = None, None
        _save_game(path, game)
    return _detail(path, game)


# ---------------------------------------------------------------- http
def _send(h, status, body, ctype, extra=None):
    h.send_response(status)
    h.send_header("Content-Type", ctype)
    h.send_header("Content-Length", str(len(body)))
    h.send_header("X-Content-Type-Options", "nosniff")
    for k, v in (extra or {}).items():
        h.send_header(k, v)
    if "Cache-Control" not in (extra or {}):
        h.send_header("Cache-Control", "no-store")
    h.end_headers()
    h.wfile.write(body)


def _send_json(h, obj, status=HTTPStatus.OK):
    _send(h, status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")


def _disposition(name):
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


def _length(h, limit):
    raw = h.headers.get("Content-Length")
    if raw is None or not re.fullmatch(r"[0-9]{1,20}", raw.strip()):
        raise ApiError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
    n = int(raw)
    if n > limit:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"too large (limit {limit} bytes)")
    return n


def _json_body(h):
    n = _length(h, MAX_JSON_BYTES)
    try:
        body = json.loads(h.rfile.read(n) or b"{}")
    except (ValueError, RecursionError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "invalid JSON") from None
    if not isinstance(body, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "send a JSON object")
    return body


def dispatch(h, method):
    """Serve /api/* on the request handler h. Always answers (404 for unknown paths)."""
    raw_path, _, query = h.path.partition("?")
    q = urllib.parse.parse_qs(query)
    try:
        parts = [urllib.parse.unquote(p) for p in raw_path[len(API_PREFIX):].split("/")]
        if parts and parts[-1] == "" and len(parts) > 1:
            parts.pop()
        if method != "GET" and h.headers.get(CSRF_HEADER) != "1":
            # A custom header forces a CORS preflight, which nothing here answers: other web pages can't write.
            raise ApiError(HTTPStatus.FORBIDDEN, f"missing {CSRF_HEADER}: 1 header")
        return _route(h, method, parts, q)
    except ApiError as exc:
        return _send_json(h, {"error": str(exc)}, exc.status)
    except OSError as exc:
        return _send_json(h, {"error": f"file error: {exc.strerror or exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
    except Exception:  # never a traceback to the client; it goes to stderr
        traceback.print_exc(file=sys.stderr)
        return _send_json(h, {"error": "internal error (see the server log)"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def _route(h, method, parts, q):
    def arg(name):
        return (q.get(name) or [""])[0]

    n = len(parts)
    if parts == ["state"] and method == "GET":
        return _send_json(h, state())
    if parts == ["steam", "search"] and method == "GET":
        return _send_json(h, steam_search(arg("q")))
    if parts == ["pcgw"] and method == "GET":
        return _send_json(h, pcgw_lookup(arg("appid")))
    if parts == ["games"]:
        if method == "GET":
            _require_root()
            return _send_json(h, {"games": list_games()})
        if method == "POST":
            obj, status = create_game(_json_body(h))
            return _send_json(h, obj, status)
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
    if n < 2 or parts[0] != "games":
        raise ApiError(HTTPStatus.NOT_FOUND, "not found")
    slug = _check_slug(parts[1])
    if n == 2:
        if method == "GET":
            path, game = _load_game(slug)
            return _send_json(h, _detail(path, game))
        if method == "PUT":
            return _send_json(h, update_game(slug, _json_body(h)))
        if method == "DELETE":
            return _send_json(h, delete_game(slug, arg("confirm")))
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
    if parts[2] == "lookup" and n == 3 and method == "POST":
        return _send_json(h, lookup_game(slug, _json_body(h)))
    if parts[2] == "cover" and n == 3:
        if method == "GET":
            path, game = _load_game(slug)
            cover = _cover_file(path, game)
            if not cover:
                raise ApiError(HTTPStatus.NOT_FOUND, "no cover")
            return _send(h, HTTPStatus.OK, cover.read_bytes(), IMAGE_TYPES[cover.suffix[1:]],
                         {"Cache-Control": "private, max-age=86400"})
        if method == "PUT":
            data = h.rfile.read(_length(h, MAX_COVER_BYTES))
            return _send_json(h, put_cover(slug, data))
        if method == "DELETE":
            return _send_json(h, delete_cover(slug))
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
    if parts[2] == "keys" and n == 4:
        if method == "GET":
            path, _ = _load_game(slug)
            full = _key_path(path, parts[3])
            if not full.is_file():
                raise ApiError(HTTPStatus.NOT_FOUND, "no such key file")
            return _send(h, HTTPStatus.OK, full.read_bytes(), "application/octet-stream",
                         {"Content-Disposition": _disposition(parts[3])})
        if method == "PUT":
            data = h.rfile.read(_length(h, MAX_KEY_BYTES))
            return _send_json(h, put_key(slug, parts[3], data))
        if method == "DELETE":
            return _send_json(h, delete_key(slug, parts[3]))
        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
    if parts[2] == "versions":
        if n == 3:
            if method == "GET":
                path, _ = _load_game(slug)
                return _send_json(h, {"versions": _versions(path)})
            if method == "POST":
                ctype = h.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if ctype != "application/x-eitri-version":
                    raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "send Content-Type: application/x-eitri-version")
                length = _length(h, MAX_UPLOAD_BODY)
                obj, status = upload_version(slug, length, h.rfile)
                return _send_json(h, obj, status)
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
        vid = parts[3]
        if n == 4:
            if method == "GET":
                return _send_json(h, get_version(slug, vid))
            if method == "DELETE":
                return _send_json(h, delete_version(slug, vid, arg("confirm")))
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
        if n == 5 and parts[4] == "zip" and method == "GET":
            data, name = version_zip(slug, vid)
            return _send(h, HTTPStatus.OK, data, "application/zip", {"Content-Disposition": _disposition(name)})
        if n == 6 and parts[4] == "files" and method == "GET":
            full, name, sha = version_file(slug, vid, check_filename(parts[5]))
            extra = {"Content-Disposition": _disposition(name)}
            if sha:
                extra["X-Content-SHA256"] = sha
            return _send(h, HTTPStatus.OK, full.read_bytes(), "application/octet-stream", extra)
    raise ApiError(HTTPStatus.NOT_FOUND, "not found")
