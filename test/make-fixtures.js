#!/usr/bin/env node
/* Builds small, made-up saves in every supported format, so the tests (and CI) never need real game files.
 *   node test/make-fixtures.js OUTDIR
 * Writes OUTDIR/<game>/<file> and OUTDIR/keys/<game>/<key file>, the layout test/fixtures.json expects.
 * The files are built here independently of the plugins (Node's crypto/zlib, Python's own pickle), so a round
 * trip through the plugins is a real check. Ren'Py and Godot keys are generated fresh each run. */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const LZString = require(path.join(__dirname, "..", "static", "lib", "vendor", "lz-string.js"));

const OUT = process.argv[2];
if (!OUT) { console.error("usage: make-fixtures.js OUTDIR"); process.exit(2); }
const put = (rel, data) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

/* ---------- plain JSON: BOM, CRLF, 2-space indent, a float written as 39779.0 ---------- */
put("fixture-roguelite/profile.json", "﻿" + [
  "{",
  '  "version": 3,',
  '  "gold": 1250,',
  '  "playtime": 39779.0,',
  '  "player": { "name": "Ada", "level": 7, "hardcore": false },',
  '  "unlocked": ["sword", "bow", "staff"],',
  '  "seed": 18446744073709551615',
  "}",
].join("\r\n") + "\r\n");

/* ---------- JSON sequence: one object per line ---------- */
put("fixture-roguelite/history.jsonl", ['{"run":1,"floor":4,"won":false}', '{"run":2,"floor":9,"won":true}', ""].join("\n"));

/* ---------- base64(JSON XOR "key") ---------- */
{
  const json = Buffer.from(JSON.stringify({ current_health: 54, max_health: 80, gold: 99, floor_num: 12, name: "Ironclad" }));
  const key = Buffer.from("key");
  const x = Buffer.from(json.map((b, i) => b ^ key[i % key.length]));
  put("fixture-xor/run.autosave", x.toString("base64"));
}

/* ---------- JSON with a SHA-256 checksum of itself (the Vampire Survivors rule) ---------- */
{
  const body = (ck) => JSON.stringify({ saveName: "fixture", Coins: 1234, LifetimeCoins: 56789, checksum: ck, Characters: ["A", "B"] });
  const ck = crypto.createHash("sha256").update(body("")).digest("hex");
  put("fixture-checksum/SaveData", body(ck));
}

/* ---------- RPG Maker MV: LZString base64 of JsonEx (lz-string 1.3.x base64: compress() as UTF-16BE bytes) ---------- */
{
  const b64 = (text) => { const c = LZString.compress(text); const b = Buffer.alloc(c.length * 2); for (let i = 0; i < c.length; i++) b.writeUInt16BE(c.charCodeAt(i), 2 * i); return b.toString("base64"); };
  const save = {
    system: { _saveCount: 3, _versionId: 12345678, "@c": 1 },
    party: { _gold: 98, _steps: 4021, _actors: { "@a": [1, 2], "@c": 4 }, "@c": 3 },
    variables: { _data: { "@a": [null, 0, 15, 0, 0, 2], "@c": 6 }, "@c": 5 },
    switches: { _data: { "@a": [null, true, false, true], "@c": 8 }, "@c": 7 },
    actors: { _data: { "@a": [null, { _name: "Hero", _level: 5, _exp: { 1: 1200, "@c": 10 }, "@c": 9 }], "@c": 11 }, "@c": 12 },
  };
  put("fixture-quest/file1.rpgsave", b64(JSON.stringify(save)));
  const global = [null, { globalId: "RPGMV", title: "Fixture Quest", characters: [["Actor1", 0]], playtime: "01:02:03", timestamp: 1700000000000 }];
  put("fixture-quest/global.rpgsave", b64(JSON.stringify(global)));
}

/* ---------- Ren'Py: zip save (log pickle + json + signatures) and a persistent file ---------- */
{
  const py = String.raw`
import pickle, sys, zlib
roots = {"store.money": 120, "store.week": 3, "store.name": "Fixture", "store.flags": ["met_guard", "found_key"], "store.ratio": 0.5}
sys.stdout.buffer.write(pickle.dumps((roots, None), protocol=2))
`;
  const log = execFileSync("python3", ["-I", "-c", py]);
  const persistent = execFileSync("python3", ["-I", "-c", 'import pickle,sys;sys.stdout.buffer.write(pickle.dumps({"_seen_ever": {"start": True}, "endings": 2}, protocol=2))']);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sec1 = privateKey.export({ type: "sec1", format: "der" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sigLine = (data) => `signature ${spki.toString("base64")} ${crypto.sign("sha1", data, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64")}\n`;
  put("keys/fixture-renpy/security_keys.txt", `signing-key ${sec1.toString("base64")}\nverifying-key ${spki.toString("base64")}\n`);
  put("fixture-renpy/1-1-LT1.save", zip([
    ["extra_info", Buffer.from("Week 3")],
    ["json", Buffer.from(JSON.stringify({ _save_name: "Week 3", _renpy_version: [8, 3, 0], _version: "1.0" }))],
    ["renpy_version", Buffer.from("8.3.0.24082114")],
    ["log", log],
    ["signatures", Buffer.from(sigLine(log))],
  ]));
  put("fixture-renpy/persistent", Buffer.concat([zlib.deflateSync(persistent), Buffer.from(sigLine(persistent))]));
}

/* ---------- Unreal GVAS, UE 4.27 tags ---------- */
{
  const w = new Writer();
  w.raw("GVAS"); w.i32(2); w.i32(522); w.u16(4); w.u16(27); w.u16(2); w.u32(0);
  w.fstr("++UE4+Release-4.27"); w.i32(3); w.i32(0); // custom version format, no custom versions
  w.fstr("/Script/FixtureGame.FixtureSave_C");
  const tag = (name, type, value, extra = () => {}) => {
    w.fstr(name); w.fstr(type);
    const v = new Writer(); value(v);
    w.i32(v.len()); w.i32(0); extra(); w.u8(0); w.raw(v.out());
  };
  tag("Gold", "IntProperty", (v) => v.i32(1500));
  tag("Level", "IntProperty", (v) => v.i32(12));
  tag("PlayTime", "FloatProperty", (v) => v.f32(3600.5));
  tag("TotalXP", "Int64Property", (v) => v.i64(9007199254740993n));
  tag("PlayerName", "StrProperty", (v) => v.fstr("Fixture"));
  w.fstr("HardMode"); w.fstr("BoolProperty"); w.i32(0); w.i32(0); w.u8(1); w.u8(0); // bool: value in the tag, size 0
  tag("LastPosition", "StructProperty", (v) => { v.f32(1); v.f32(-2.5); v.f32(300); }, () => { w.fstr("Vector"); w.raw(Buffer.alloc(16)); });
  tag("Unlocks", "ArrayProperty", (v) => { v.i32(3); v.i32(4); v.i32(8); v.i32(15); }, () => w.fstr("IntProperty"));
  w.fstr("None"); w.i32(0);
  put("fixture-unreal/SaveSlot_0.sav", w.out());
}

/* ---------- Godot encrypted (GDEC), Godot 4 CFB and Godot 3 ECB ---------- */
{
  const password = "fixture-password-123";
  put("keys/fixture-godot/godot-password.txt", password + "\n");
  const key = Buffer.from(crypto.createHash("md5").update(password).digest("hex"), "latin1");
  const plain = Buffer.from(JSON.stringify({ runCount: 4, Data: { "inventory.iron": 37, "inventory.water": 5 }, upgrades: ["drill1", "jetpack"] }));
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
  const md5 = crypto.createHash("md5").update(plain).digest();
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(plain.length));
  const iv = crypto.randomBytes(16);
  const cfb = crypto.createCipheriv("aes-256-cfb", key, iv);
  put("fixture-godot/savegame_0.json", Buffer.concat([Buffer.from("GDEC"), md5, len, iv, cfb.update(padded), cfb.final()]));
  const ecb = crypto.createCipheriv("aes-256-ecb", key, null).setAutoPadding(false);
  const mode = Buffer.alloc(4); mode.writeUInt32LE(1);
  put("fixture-godot/savegame3.json", Buffer.concat([Buffer.from("GDEC"), mode, md5, len, ecb.update(padded), ecb.final()]));
}

console.log("fixtures written to " + OUT);

/* ---------- helpers ---------- */
function Writer() {
  const parts = [];
  const num = (n, fn) => { const b = Buffer.alloc(n); fn(b); parts.push(b); };
  return {
    raw: (b) => parts.push(Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1")),
    u8: (v) => num(1, (b) => b.writeUInt8(v)),
    u16: (v) => num(2, (b) => b.writeUInt16LE(v)),
    u32: (v) => num(4, (b) => b.writeUInt32LE(v)),
    i32: (v) => num(4, (b) => b.writeInt32LE(v)),
    i64: (v) => num(8, (b) => b.writeBigInt64LE(v)),
    f32: (v) => num(4, (b) => b.writeFloatLE(v)),
    fstr(s) { const b = Buffer.from(s + "\0", "latin1"); this.i32(b.length); parts.push(b); },
    len: () => parts.reduce((n, b) => n + b.length, 0),
    out: () => Buffer.concat(parts),
  };
}

/* Minimal zip writer (deflate, no data descriptors), enough for a Ren'Py save. */
function zip(entries) {
  const local = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}
