# Eitri server API (saves.py)

The library behind the Eitri page. The server stores bytes and metadata only. It never parses a save:
decoding, editing, diffing and checksums all run in the browser through the plugins in `static/lib/`.

- Page: `/` serves `static/index.html` with `__INITIAL_DATA__` filled in. Static files are under `/static/`.
- API: always `/api/...`.
- No login. `eitri.py` listens on 127.0.0.1 unless told otherwise; only expose it on a network you trust.
- Code: `saves.py` (API) and `eitri.py` (HTTP server). Test: `test/server-check.py`.

## Conventions

- **Every request that is not GET must send the header `X-Eitri: 1`.** Without it the answer is `403`. This is
  the CSRF guard: a custom header forces a CORS preflight, and nothing on the server answers one.
- JSON bodies are UTF-8 JSON objects with a `Content-Length` header (fetch adds it). The limit is 256 KB unless
  stated otherwise.
- Errors are always JSON, `{"error": "<human-readable message>"}`, with one of these statuses: `400` bad input,
  `403` missing X-Eitri, `404` unknown game/version/file/path, `405` wrong method, `409` name or folder id
  taken, `411` no Content-Length, `413` too large, `415` wrong Content-Type, `500` file error,
  `503` the saves folder doesn't exist.
- Times: every timestamp is epoch seconds (`created`, `updated`, ...) with a `*_text` twin in the server's local time, 24-hour,
  `"YYYY-MM-DD HH:MM"`. The page can show `*_text` as is, or format the epoch itself with `hourCycle: "h23"`.
- IDs:
  - **game id / slug**: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. It is also the folder name in the saves folder.
  - **version id**: `v` plus at least 3 digits (`v001`, `v012`, `v1000`). Numbers are never reused within a game,
    even after a delete.
  - **file names** are the exact original names (`file1.rpgsave`). URL-encode them in paths with
    `encodeURIComponent`. A name can't contain `/`, `\`, NUL or control characters, can't be `.` or `..`,
    and can be at most 255 bytes.
- Deletes are hard deletes (there is no trash). They need `?confirm=<id>` on the DELETE request.

## Limits (also in `state.limits`)

| What | Limit |
|---|---|
| All files of one version together | 64 MiB (67108864 bytes) |
| Files per version | 64 |
| Upload meta JSON | 1 MiB |
| Key file | 1 MiB |
| Cover image | 5 MiB, JPEG / PNG / WebP (checked by magic bytes) |
| JSON request body | 256 KiB |
| `name` | 100 characters |
| version `label` | 200 characters |
| `notes` | 100000 characters |
| `rules` | 20000 characters |
| `install_dir` | 500 characters |
| `save_location` | 5000 characters |
| version `note` | 2000 characters |
| `changed` entries per version | 5000 |

nginx in front needs `client_max_body_size 66m` for the saves server block. 64 MiB of files plus up to 1 MiB of meta
doesn't fit under the 64M the plan says.

## `__INITIAL_DATA__` (also `GET /api/state`)

```json
{
  "ok": true,
  "error": null,
  "games": [GameSummary, ...],
  "saves_dir": "/home/me/eitri/saves",
  "limits": {"version_bytes": 67108864, "meta_bytes": 1048576, "files_per_version": 64, "key_bytes": 1048576,
             "cover_bytes": 5242880, "json_bytes": 262144, "name": 100, "label": 200, "notes": 100000,
             "rules": 20000, "install_dir": 500, "save_location": 5000, "version_note": 2000, "changed": 5000},
  "engine_defaults": {"rpgmaker": "<install>\\www\\save", "unity": "%USERPROFILE%\\AppData\\LocalLow\\<Company>\\<Game>",
                      "godot": "%APPDATA%\\Godot\\app_userdata\\<Game>", "unreal": "%LOCALAPPDATA%\\<Project>\\Saved\\SaveGames",
                      "renpy": "%APPDATA%\\RenPy\\<game>"},
  "now": 1794447600, "now_text": "2026-11-11 19:40"
}
```

`ok: false` with `error: "<dir> doesn't exist"` and `games: []` means the saves folder is gone (for example an
unmounted drive). Show the error. Every game endpoint then answers `503`.

`games` is sorted by `updated`, newest first (the plan's "last edited first"). Only the library is inlined. The page
fetches a game's details when it is opened. For deep links, use the hash (`#g=<slug>`): the server has no
per-game page route.

## Objects

### GameSummary (library tile)

```json
{
  "slug": "brotato", "name": "Brotato", "plugin": "json", "engine": "Godot 3",
  "steam_appid": 1942280,
  "cover": "/api/games/brotato/cover?v=1794447637",
  "created": 1794447554, "created_text": "2026-11-11 19:39",
  "updated": 1794447637, "updated_text": "2026-11-11 19:40",
  "version_count": 2,
  "size": 145806,
  "last_detect": Detect | null,
  "steam_cloud": true,
  "steam_cloud_ack": false
}
```

- `cover` is `null` when the game has no cover. In that case show the rune placeholder. The `?v=` part changes
  whenever the image changes, so the URL is safe to cache.
- `size` is the total bytes of every file in the game folder: versions, meta.json files, keys and cover.
- `updated` is the newest of: the last game edit, the last version upload or delete, the last key upload.
- `last_detect` is the `detect` of the newest version, so a tile can say "Ren'Py, signed OK".
- `steam_cloud` comes from PCGamingWiki: `true`, `false`, or `null` (unknown).

### GameDetail (`GET /api/games/<slug>`)

GameSummary plus:

```json
{
  "steam_name": "Brotato",
  "cover_source": "steam" | "upload" | null,
  "notes": "free text", "rules": "known rules, free text", "install_dir": "D:\\SteamLibrary\\steamapps\\common\\Brotato",
  "save_location": {
    "user": "",
    "looked_up": [{"platform": "Windows", "path": "%APPDATA%\\Brotato\\<user-id>\\*.json"}],
    "engine_default": "%APPDATA%\\Godot\\app_userdata\\<Game>" | null,
    "paths": ["%APPDATA%\\Brotato\\<user-id>\\*.json"],
    "resolved": ["%APPDATA%\\Brotato\\<user-id>\\*.json"],
    "source": "user" | "pcgamingwiki" | "engine" | "none"
  },
  "pcgw": {"page": "Brotato", "url": "https://www.pcgamingwiki.com/wiki/Brotato", "steam_cloud": true,
           "fetched": 1794447607, "fetched_text": "2026-11-11 19:40", "error": null} | null,
  "steam_cloud_warning": true,
  "keys": [{"name": "security_keys.txt", "size": 120, "modified": 1794447600, "modified_text": "2026-11-11 19:40"}],
  "pins": [{"path": ["playerData", "ExpPoint"], "label": "Blight", "file": ""}],
  "versions": [Version, ...],
  "folder": "brotato"
}
```

- **Save location.** The user's edit wins. `paths` is the user's text split into lines when it isn't blank.
  Otherwise it is PCGamingWiki's Windows-side paths, in their order. Otherwise it is the engine default (picked
  by matching "RPG Maker", "Unity", "Godot", "Unreal"/"GVAS", "Ren'Py" in `engine` + `plugin`). Otherwise it is
  `[]`. `resolved` is `paths` with `<install>` replaced by `install_dir`, without its trailing slash. When
  `install_dir` is empty, `<install>` stays as is. Show `resolved` with a copy button. PCGamingWiki
  placeholders are turned into Windows forms: `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`,
  `%USERPROFILE%\Documents`, `%USERPROFILE%\AppData\LocalLow`, `%PROGRAMDATA%`, `%PUBLIC%`, `%USERNAME%`,
  `<install>` (game folder), `<Steam>`, `<user-id>` (Steam id: steamid64 or the short account id; PCGamingWiki
  doesn't say which). `looked_up` platforms are the ones PCGamingWiki uses, e.g. `Windows`, `Steam`,
  `Microsoft Store`, `GOG.com`, `Epic Games Store`. macOS and Linux entries are left out.
- `pcgw` is `null` until a lookup has run, which needs a Steam app id. `pcgw.page: null` means PCGamingWiki
  has no article for that app id. `pcgw.error` is set when the last lookup failed (offline). The values shown
  are then the older ones, or none.
- `steam_cloud_warning` is `pcgw.steam_cloud === true && !steam_cloud_ack`. Show "turn Steam Cloud off for this
  game or it may put the old save back" until the box is ticked. It is a warning only and never blocks anything.
- `versions` is sorted by number, oldest first.
- `folder` is the game's folder name inside `saves_dir`. It equals `slug`.

### Version

```json
{
  "id": "v002", "n": 2, "dir": "v002-gold-98-99999",
  "label": "gold 98 -> 99999",
  "kind": "upload" | "edit" | "manual",
  "parent": "v001" | null, "parent_exists": true,
  "children": ["v003"],
  "created": 1794447554, "created_text": "2026-11-11 19:39",
  "files": [{"name": "file1.rpgsave", "stored": "file1.rpgsave", "size": 175976, "sha256": "e5b2..."}],
  "size": 175976,
  "detect": Detect | null,
  "changed": [ ...whatever the page sent... ],
  "note": ""
}
```

- `kind`: `upload` = no parent (an original, kept byte for byte). `edit` = has a parent (an export from the
  editor). `manual` = a `vNNN-*` folder someone made by hand from Windows without a `meta.json`. Its files are
  listed with `sha256: null`, its `created` is the folder's mtime, and its label is the folder name after the
  first `-`.
- `parent_exists: false` with a non-null `parent` means the parent was deleted. Children are not re-parented.
- `children` lists the versions whose `parent` is this one, oldest first. Together with `parent` it gives the tree.
- `files[].name` is the exact original name, and downloads use it. `files[].stored` is the name on disk. It
  is the same as `name` unless Windows can't hold that name: `<>:"|?*` and control characters become `_`,
  trailing dots and spaces become `_`, `CON`/`NUL`/`COM1`... get a leading `_`, and a save file called
  `meta.json` is stored as `_meta.json`.
- `changed` is stored exactly as uploaded, but every entry must be an object with a `path` (array or string), else `400`.
  Shape (what `Eitri.edit` returns):
  `[{"path": ["party","_gold"], "before": "98", "after": "99999", "linked": false}]`.

### Detect (sent by the page with an upload, kept as metadata)

All keys are optional. Unknown keys are dropped. Every string is at most 200 characters.

```json
{"plugin": "renpy", "engine": "Ren'Py 7/8", "format": "Ren'Py save (zip + pickle)", "status": "tested",
 "integrity": "ok", "integrity_text": "signed OK", "game_rule": "long-live-the-queen", "roundtrip": true}
```

- `integrity` is one of `"ok"`, `"bad"`, `"none"` (the format has no checksum or signature) or `"unknown"`.
- `roundtrip` (bool) is the result of the decode-then-encode self-check.
- On upload, a game whose `plugin` or `engine` is still empty takes them from `detect`. This pre-fills them
  from the first save.

## Endpoints

### Library and lookups

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/state` | | `__INITIAL_DATA__` shape |
| GET | `/api/games` | | `{"games": [GameSummary]}` (`503` if not mounted) |
| POST | `/api/games` | JSON, see below | `201` GameDetail + `lookup` |
| GET | `/api/steam/search?q=<name>` | | `{"q", "results": [{"appid", "name", "image", "type"}], "error", "stale"}` |
| GET | `/api/pcgw?appid=<n>` | | `{"appid", "page", "url", "save_locations": [{"platform","path"}], "steam_cloud", "fetched", "error", "stale"}` |

**Create a game.** `POST /api/games` with
`{"name": "Brotato", "plugin": "json", "engine": "Godot 3", "steam_appid": 1942280, "steam_name": "Brotato"}`.
Only `name` is required. Unknown fields are a `400`. An optional `slug` sets the folder id: it gets a `409` if
taken, and it must match the slug pattern. Without `slug`, the id comes from the name (ASCII, lowercase, `-`,
apostrophes dropped: "Baldur's Gate 3" becomes `baldurs-gate-3`), and `-2`, `-3`... are added
on a clash. With a `steam_appid`, the server synchronously caches the Steam 600x900 cover (once) and looks
the game up on PCGamingWiki. That can take up to ~20 s when Steam or PCGamingWiki is slow, so show a
spinner. The answer has an extra `"lookup": {"cover": "ok" | "<error>", "pcgw": "ok" | "no PCGamingWiki article" | "<error>"}`.
Keys are missing when the step didn't run. A failed lookup never fails the create.

**Steam search.** Steam's public store search (no key), at most 10 results. `image` is a small 231x87 capsule
for the pick list. Answers are cached for 7 days. When Steam can't be reached the answer is still `200`:
`results` is `[]` (or the old cached results with `stale: true`) and `error` holds a message. A failure is
remembered for 10 minutes, so retrying straight away doesn't go out again. `400` if `q` is empty.

**PCGamingWiki.** Looks a page up by Steam app id. Cached for 30 days, and it degrades the same way as the
search (`200` with `error`). `page: null` with `error: null` means PCGamingWiki has no article. `400` if
`appid` isn't a number. This endpoint is a preview: it doesn't touch any game.

### One game

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/games/<slug>` | | GameDetail |
| PUT | `/api/games/<slug>` | JSON, any subset of the fields below | GameDetail + `lookup` |
| DELETE | `/api/games/<slug>?confirm=<slug>` | | `{"deleted": "<slug>"}` |
| POST | `/api/games/<slug>/lookup` | `{"pcgw": true, "cover": false}` | GameDetail + `lookup` |

**PUT fields** (partial update; unknown fields are a `400`):
- `name`: a display name.
- `slug`: renames the game's folder. The answer has the new `slug`, and the page must switch its URLs to it. `409`
  if taken.
- `plugin`, `engine`: the assigned plugin id and the engine text.
- `notes`, `rules`: notes-card text.
- `install_dir`: text, e.g. `D:\SteamLibrary\steamapps\common\Lies of P`.
- `save_location`: the user's own text, one path per line. `""` clears it, and the looked-up or default path
  comes back.
- `steam_cloud_ack`: must be `true` or `false`. Anything else is a `400`.
- `steam_appid`: a number, or `null` to clear.
- `steam_name`: the Steam match's name.
- `pins`: the whole list of pinned fields (replaces the old one), at most 200: `{"path": [key or index, ...] (1-64 parts),
  "label": "Blight" (1-100 characters), "file": "", "match": []}`. `file` is the unit (file) name in a multi-file version,
  `""` = any. `match` anchors list entries so a pin follows the item, not the position: each `{"at": i, "key": k,
  "value": v}` says path[i] (a list index) is the entry whose child `k` equals `v` (e.g. `FirstCodeName` =
  `Consume_Throw_Gear`). The page re-finds that entry in each version; when it's missing the pin says so instead of
  showing another entry. A list index without a match is "by position" and marked as such.
  The editor shows pins in Quick fields under their label. A path that a version doesn't have is skipped there.

Changing `steam_appid` reruns PCGamingWiki and re-fetches the Steam cover, unless the current cover was
uploaded by hand: an uploaded cover is never replaced automatically. Saving the notes card does no lookups.

**Delete a game.** This deletes the game with all its versions, keys and cover, and needs `?confirm=` set to the
slug (otherwise `400`). The folder disappears from the library at once.

**Lookup again.** `pcgw` (default `true`) re-asks PCGamingWiki, bypassing its cache. `cover: true` re-downloads
the Steam cover, and this one *does* replace an uploaded cover. Without `cover`, a cover is fetched only when the
game has none. Needs a `steam_appid` (otherwise `400`).

### Cover

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/games/<slug>/cover` | | the image (`image/jpeg`/`png`/`webp`, `Cache-Control: private, max-age=86400`); `404` if none |
| PUT | `/api/games/<slug>/cover` | raw image bytes (any Content-Type) | GameDetail (`cover_source: "upload"`) |
| DELETE | `/api/games/<slug>/cover` | | GameDetail (`cover: null`) |

Use the `cover` URL from the summary (it carries `?v=`). The cover is stored as `cover.jpg`/`.png`/`.webp` in the
game folder. Anything that isn't a JPEG, PNG or WebP gets a `400`.

### Key files

Some formats need a key to re-encode: Ren'Py `security_keys.txt`, a Godot password file `*password*.txt`, XOR keys.
Keys are stored in `<game>/keys/<name>` in the saves folder.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/games/<slug>/keys/<name>` | | raw bytes (`application/octet-stream`) |
| PUT | `/api/games/<slug>/keys/<name>` | raw bytes, at most 1 MiB | `{"keys": [ {name,size,modified,modified_text} ]}` (creates or replaces) |
| DELETE | `/api/games/<slug>/keys/<name>` | | `{"keys": [...]}`; `404` if missing |

Key names follow the file-name rules above. They also can't start with `.` or contain `<>:"|?*`. The list is in
GameDetail `keys`. To build the plugin `ctx.keys`, fetch each one:
`{name: new Uint8Array(await (await fetch(url)).arrayBuffer())}`.

### Versions

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/games/<slug>/versions` | | `{"versions": [Version]}` (same list as in GameDetail) |
| POST | `/api/games/<slug>/versions` | binary frame, see below | `201` Version |
| GET | `/api/games/<slug>/versions/<vid>` | | Version |
| DELETE | `/api/games/<slug>/versions/<vid>?confirm=<vid>` | | `{"deleted": "<vid>", "game": "<slug>"}` |
| GET | `/api/games/<slug>/versions/<vid>/files/<name>` | | the file, byte for byte |
| GET | `/api/games/<slug>/versions/<vid>/zip` | | every file of the version in one zip (stored, no compression), with the original names |

**Upload a version.** `POST .../versions` with `Content-Type: application/x-eitri-version` (anything else is a
`415`) and this body:

```
[4 bytes: meta length N, unsigned big-endian][N bytes: meta JSON, UTF-8][file 1 bytes][file 2 bytes]...
```

```json
{
  "files": [{"name": "file1.rpgsave", "size": 175976, "sha256": "<64 hex, optional>"},
            {"name": "global.rpgsave", "size": 480}],
  "parent": null,
  "label": "gold 98 -> 99999",
  "detect": Detect,
  "changed": [ ... ],
  "note": ""
}
```

- `files`: 1 to 64 entries, in the same order as the bytes. Names are exact, can't repeat (case-insensitive) and
  must follow the file-name rules. `sha256` is optional. When it is given and doesn't match what arrived, the
  answer is a `400` and nothing is kept. The server always computes and stores the sha256.
- `parent`: `null` for an original upload (`kind: "upload"`), or an existing version id for an editor export
  (`kind: "edit"`). An unknown parent is a `400`.
- `label`: optional. Empty becomes `"upload"` or `"edit"`. The folder is named `v<NNN>-<label as ascii slug, 40
  chars>`, e.g. `v003-gold-98-99999`. The label shown is the full text.
- `detect`, `changed`, `note`: optional, see above. Unknown meta keys are a `400`.
- `Content-Length` must equal exactly `4 + N + sum(sizes)` (otherwise `400`). A `Content-Length` over
  4 + 1 MiB + 64 MiB is rejected from the header (`413`) before anything is read. A sum of `sizes` over 64 MiB is a
  `413` before any file bytes are read. A body that ends early is a `400`.
- The files are written to a hidden staging folder and then renamed into place, so a version appears complete or
  not at all. Nothing is ever overwritten. Every export is a new version.

Browser example:

```js
const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
const head = new Uint8Array(4); new DataView(head.buffer).setUint32(0, metaBytes.length);
const res = await fetch(`/api/games/${slug}/versions`, {method: "POST",
  headers: {"Content-Type": "application/x-eitri-version", "X-Eitri": "1"},
  body: new Blob([head, metaBytes, ...files.map((f) => f.bytes)])});
```

**Download a file.** `GET .../files/<encodeURIComponent(name)>` sends the exact bytes as
`application/octet-stream` with `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<exact name>`
and `X-Content-SHA256` (missing for `manual` versions). Use the same URL with `fetch()` to get bytes for
decoding and diffing. The `files/<name>` segment is matched against `files[].name`, never against a path on disk.

**Delete a version.** Needs `?confirm=` set to the version id (otherwise `400`). Its children keep their
`parent` id (`parent_exists` becomes `false`).

## On disk (for reference; the page never sees paths)

```
Saves/
  _import/                       ignored (any folder starting with _ or .)
  brotato/
    game.json                    pretty-printed; name, steam_appid, notes, rules, install_dir, save_location_user,
                                 steam_cloud_ack, cover, cover_source, pcgw{...}, created, updated, next_version
    cover.jpg
    keys/security_keys.txt
    v001-original/save_v3_2.json + meta.json
    v002-gold-98-99999/save_v3_2.json + meta.json
```

Folders and files are written group-writable (2775/664), so a shared folder stays editable from other machines. Every JSON
write goes through a temp file and a rename. Steam and PCGamingWiki answers are cached in
`<saves>/.cache/` (`EITRI_CACHE_DIR`). With `EITRI_OFFLINE=1` (tests) the server never goes
out.
