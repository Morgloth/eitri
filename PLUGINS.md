# Eitri plugins

Browser-side save decoders and encoders. Plain ES2020 scripts with no build step and no dependencies apart from
lz-string 1.5.0. They live in `static/lib/`: `vendor/`, `core/`, `plugins/`
(one per format) and `games/` (per-game rules). The same files run in Node for the tests.

## Load order

`test/load-order.json` is the order the page must use (`<script>` tags): vendor, core, plugins,
then game rules.

## Interface

```js
Eitri.register({
  id, name, engine, status: "tested" | "untested",
  detect(file) -> priority,            // file = {name, bytes: Uint8Array}; 0 = not mine
  async decode(files, ctx) -> doc,     // ctx = {keys: {"security_keys.txt": Uint8Array, ...}}
  async encode(doc, ctx) -> [{name, bytes}],
  quickFields(doc) -> [{label, path}],
});
Eitri.registerRule({                 // per-game rules (linked fields, quick fields)
  id, game, plugin, match(doc), quickFields?(doc), linked(doc, change) -> [{path, before, after}],
});
```

- `Eitri.detect(files)` picks the plugin, `Eitri.open(files, ctx)` decodes and attaches the
  matching rules, `Eitri.edit(doc, path, value)` sets a value and runs the rules (the returned
  change list is the version label / change summary), `Eitri.quickFields(doc)`.
- `doc.root` is a generic tree: `{kind: object|array|string|number|bool|null|bytes|other, value,
  children: [{key, node}], editable, note}`. Paths are arrays of keys/indexes; `Eitri.pathStr`
  prints them, `Eitri.search(root, q)` and `Eitri.diff(a, b)` work on any tree.
- Numbers come back as strings so 64-bit values survive.

## Formats

| Plugin | Format | Tested on real saves from (all byte-identical) | Notes |
|---|---|---|---|
| `json` | Plain JSON, JSON sequences, OdinSerializer JSON | Brotato, Slay the Spire 2, Inscryption, Monster Train, StS1 prefs, Dome Keeper options, VS 2022 | Edits are spliced into the text; layout, CRLF, BOM, number spelling stay. `39779.0` stays a float. |
| `json-xor` | base64(JSON XOR key) | Slay the Spire 1 `.autosave` | Known key `"key"`; more via `ctx.xorKeys`. |
| `rpgmaker-mv` | LZString base64 JsonEx | a commercial RPG Maker MV game (slot + global saves) | lz-string 1.5.0 `compress()` plus the 1.3.x base64 step RPG Maker MV uses, so output matches. |
| `rpgmaker-mz` | zlib JSON | none | **untested**: no sample, and pako level 1 can't be reproduced, so a re-encode is valid but not identical. |
| `renpy` | zip + pickle + ECDSA signature; `persistent` | Long Live The Queen (2 saves + persistent) | Data-only pickle (nothing is imported or run). Re-signs edits with `security_keys.txt` (P-256, SHA-1, WebCrypto: needs https). Untouched zip entries and an untouched persistent keep their compressed bytes (Ren'Py's zlib output can't be reproduced). |
| `gvas` | Unreal GVAS UE4 + UE 5.4 tags | Clair Obscur (2), Lies of P (2) | Full re-serialise with sizes recomputed. Anything not understood is kept raw per property. |
| `godot-encrypted` | GDEC (Godot 3 ECB, Godot 4 CFB) | Dome Keeper (3) | Needs the game password as a key file (`*password*.txt`). Dome Keeper's is `SAVE_FILE_PASSWORD` in `res://game/SaveGame.gdc`. |

Game rules (`games/`):

- Long Live The Queen: every skill is stored twice, `store.<skill>_` (real) and `store.<skill>`
  (shown); the game recomputes the shown one at week end, so editing either name sets both.
- Vampire Survivors: `checksum` = SHA-256 (hex) of the file with `"checksum":""`; rebuilt after edits.
- Quick fields only: Clair Obscur (Gold, character levels), Lies of P (level, humanity, dropped
  ergo), Dome Keeper (iron, water, cobalt, run count).

Not handled: Dome Keeper `savegame_N_map.scn` (binary Godot RSRC), Unity ES3 / PlayerPrefs (no
sample), Oodle-compressed GVAS, TextProperty contents (kept raw).

## In-game load tests (2026-11-09)

Every tested game loaded an edited save on Windows (Steam Cloud off, game closed, file copied in,
hash checked): an RPG Maker MV game (gold + a game variable), Slay the Spire 1 (XOR) and 2,
Inscryption, Long Live The Queen (re-signed, no trust prompt), Brotato, Dome Keeper (GDEC),
Vampire Survivors (checksum), Monster Train, Clair Obscur (UE 5.4), Lies of P (UE 4.27).
Findings: Long Live The Queen skills need both names (rule above); Brotato `save_v3_N.json` is
in-game profile N+1; Inscryption keeps the finished run in `pastRuns` and starts a new `currentRun`.

`test/make-edit.js` builds such a test file from a live save the way the page will (decode, edit,
encode, re-open, list every changed field):

```sh
node test/make-edit.js --out DIR [--keys DIR] FILE -- '["party","_gold"]=55555'
```

## Tests

See the README. `test/run.js` checks every manifest entry: detection picks the expected plugin, decode then encode
gives the original bytes, the expected rule and quick fields are there, and each edit reads back, changes only the
edited and linked fields, and passes its named check (`test/checks.js`: hash accepted, Ren'Py signature valid).
`test/fixtures.json` lists the made-up saves; `test/samples.json` lists the real saves the plugins were developed
against (bring your own copies; they are never shipped).
