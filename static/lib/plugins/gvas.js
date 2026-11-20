/* Unreal Engine GVAS saves (UE4 tags and the UE 5.4+ "complete type name" tags).
 * Parsed into properties; anything not understood keeps its raw bytes (the tag gives its size),
 * so the file always writes back exactly. Encoding re-serialises the whole tree and recomputes
 * every size field; the round-trip test proves it matches the original byte for byte.
 * Not handled as fields (kept raw): TextProperty, unknown native structs. No compression
 * (Oodle-wrapped saves such as Palworld are out of scope). */
(function (G) {
  "use strict";
  const M = G.Eitri;

  /* ---------- reader / writer ---------- */
  class R {
    constructor(b, o = 0) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.o = o; }
    need(n) { if (this.o + n > this.b.length || n < 0) throw new Error("GVAS: read past end at " + this.o); }
    u8() { this.need(1); return this.b[this.o++]; }
    i32() { this.need(4); const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
    u32() { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
    u16() { this.need(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
    i64() { this.need(8); const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
    u64() { this.need(8); const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
    f32() { this.need(4); const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
    f64() { this.need(8); const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
    bytes(n) { this.need(n); const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
    /* FString -> {s, w (UTF-16), z (zero-length form), nonul} */
    str() {
      const n = this.i32();
      if (n === 0) return { s: "", z: true };
      if (n > 0) {
        if (n > 1 << 24) throw new Error("GVAS: bad string length " + n + " at " + (this.o - 4));
        const raw = this.bytes(n);
        const nonul = raw[n - 1] !== 0;
        return { s: M.latin1.decode(nonul ? raw : raw.subarray(0, n - 1)), nonul };
      }
      const c = -n;
      if (c > 1 << 23) throw new Error("GVAS: bad string length " + n);
      const raw = this.bytes(c * 2);
      let s = "";
      for (let i = 0; i < c - 1; i++) s += String.fromCharCode(raw[i * 2] | (raw[i * 2 + 1] << 8));
      return { s, w: true };
    }
  }
  class W {
    constructor() { this.buf = new Uint8Array(1 << 16); this.o = 0; }
    grow(n) { if (this.o + n > this.buf.length) { let m = this.buf.length * 2; while (m < this.o + n) m *= 2; const nb = new Uint8Array(m); nb.set(this.buf.subarray(0, this.o)); this.buf = nb; } }
    dv() { return new DataView(this.buf.buffer); }
    u8(v) { this.grow(1); this.buf[this.o++] = v; }
    i32(v) { this.grow(4); this.dv().setInt32(this.o, v, true); this.o += 4; }
    u32(v) { this.grow(4); this.dv().setUint32(this.o, v, true); this.o += 4; }
    u16(v) { this.grow(2); this.dv().setUint16(this.o, v, true); this.o += 2; }
    i64(v) { this.grow(8); this.dv().setBigInt64(this.o, BigInt(v), true); this.o += 8; }
    u64(v) { this.grow(8); this.dv().setBigUint64(this.o, BigInt(v), true); this.o += 8; }
    f32(v) { this.grow(4); this.dv().setFloat32(this.o, v, true); this.o += 4; }
    f64(v) { this.grow(8); this.dv().setFloat64(this.o, v, true); this.o += 8; }
    bytes(b) { this.grow(b.length); this.buf.set(b, this.o); this.o += b.length; }
    str(x) {
      if (x.z && x.s === "") return this.i32(0);
      const wide = x.w || /[^\x00-\xff]/.test(x.s);
      if (!wide) { this.i32(x.s.length + (x.nonul ? 0 : 1)); this.bytes(M.latin1.encode(x.s)); if (!x.nonul) this.u8(0); return; }
      this.i32(-(x.s.length + 1));
      for (let i = 0; i < x.s.length; i++) this.u16(x.s.charCodeAt(i));
      this.u16(0);
    }
    patchI32(at, v) { this.dv().setInt32(at, v, true); }
    patchI64(at, v) { this.dv().setBigInt64(at, BigInt(v), true); }
    out() { return this.buf.slice(0, this.o); }
  }
  const S = (s) => ({ s });

  /* Native (binary) structs: name -> [field, type] list. LWC = UE5 doubles. */
  const NATIVE = {
    Vector: (lwc) => [["X", lwc], ["Y", lwc], ["Z", lwc]],
    Vector2D: (lwc) => [["X", lwc], ["Y", lwc]],
    Rotator: (lwc) => [["Pitch", lwc], ["Yaw", lwc], ["Roll", lwc]],
    Quat: (lwc) => [["X", lwc], ["Y", lwc], ["Z", lwc], ["W", lwc]],
    Vector4: (lwc) => [["X", lwc], ["Y", lwc], ["Z", lwc], ["W", lwc]],
    Plane: (lwc) => [["X", lwc], ["Y", lwc], ["Z", lwc], ["W", lwc]],
    LinearColor: () => [["R", "f32"], ["G", "f32"], ["B", "f32"], ["A", "f32"]],
    Color: () => [["B", "u8"], ["G", "u8"], ["R", "u8"], ["A", "u8"]],
    IntPoint: () => [["X", "i32"], ["Y", "i32"]],
    IntVector: () => [["X", "i32"], ["Y", "i32"], ["Z", "i32"]],
    DateTime: () => [["Ticks", "i64"]],
    Timespan: () => [["Ticks", "i64"]],
    FrameNumber: () => [["Value", "i32"]],
    Guid: () => [["Guid", "guid"]],
    GameplayTagContainer: () => [["Tags", "tags"]],
  };

  /* ---------- parser ---------- */
  function makeParser(hdr) {
    const ue5 = hdr.ue5 || 0;
    const complete = ue5 >= 1012; // PROPERTY_TAG_COMPLETE_TYPE_NAME (UE 5.4)
    const lwc = ue5 >= 1004 ? "f64" : "f32"; // LARGE_WORLD_COORDINATES

    function typeName(r) { const name = r.str(); const n = r.i32(); const kids = []; for (let i = 0; i < n; i++) kids.push(typeName(r)); return { name, kids }; }
    /* Type descriptor from either tag style. */
    function tdFromTN(tn) {
      const t = tn.name.s, td = { type: t, tn };
      if (t === "StructProperty") td.struct = tn.kids[0] ? tn.kids[0].name.s : "?";
      else if (t === "ArrayProperty" || t === "SetProperty") td.inner = tdFromTN(tn.kids[0]);
      else if (t === "MapProperty") { td.key = tdFromTN(tn.kids[0]); td.value = tdFromTN(tn.kids[1]); }
      else if (t === "ByteProperty" || t === "EnumProperty") td.enum = tn.kids[0] ? tn.kids[0].name.s : null;
      return td;
    }

    function readTag(r) {
      const start = r.o;
      const name = r.str();
      if (name.s === "None") return { none: true, name };
      const tag = { name };
      if (complete) {
        tag.tn = typeName(r);
        tag.td = tdFromTN(tag.tn);
        tag.size = r.i32();
        tag.flags = r.u8();
        if (tag.flags & 1) tag.arrayIndex = r.i32();
        if (tag.flags & 2) tag.guid = r.bytes(16);
        if (tag.flags & 4) { const ext = r.u8(); tag.ext = [ext]; if (ext & 2) tag.ext.push(r.u8(), r.u8()); }
        if (tag.td.type === "BoolProperty") tag.bool = !!(tag.flags & 0x10);
      } else {
        const type = r.str();
        tag.type = type;
        tag.size = r.i32();
        tag.arrayIndex = r.i32();
        const td = { type: type.s };
        switch (type.s) {
          case "StructProperty": tag.structName = r.str(); tag.structGuid = r.bytes(16); td.struct = tag.structName.s; break;
          case "BoolProperty": tag.boolByte = r.u8(); tag.bool = !!tag.boolByte; break;
          case "ByteProperty": case "EnumProperty": tag.enumName = r.str(); td.enum = tag.enumName.s; break;
          case "ArrayProperty": case "SetProperty": tag.innerType = r.str(); td.inner = { type: tag.innerType.s }; break;
          case "MapProperty": tag.keyType = r.str(); tag.valueType = r.str(); td.key = { type: tag.keyType.s }; td.value = { type: tag.valueType.s }; break;
        }
        tag.hasGuid = r.u8();
        if (tag.hasGuid) tag.guid = r.bytes(16);
        tag.td = td;
      }
      tag.at = start;
      return tag;
    }

    /* Tagged property list until "None". */
    function props(r, end) {
      const list = [];
      for (;;) {
        if (end !== undefined && r.o >= end) throw new Error("GVAS: property list ran past its struct");
        const tag = readTag(r);
        if (tag.none) { list.noneName = tag.name; break; }
        const vs = r.o;
        let value;
        try {
          value = tagValue(r, tag);
          if (r.o !== vs + tag.size) throw new Error(`size mismatch ${r.o - vs} vs ${tag.size}`);
        } catch (e) {
          r.o = vs;
          value = { raw: r.bytes(tag.size), why: e.message };
        }
        list.push({ tag, value });
      }
      return list;
    }

    function tagValue(r, tag) {
      const td = tag.td;
      const end = r.o + tag.size;
      switch (td.type) {
        case "BoolProperty": return { bool: tag.bool };
        case "StructProperty": {
          const native = complete ? !!(tag.flags & 8) : !!NATIVE[td.struct];
          return structValue(r, td.struct, native, end);
        }
        case "ByteProperty": if (tag.size === 1) return { prim: r.u8(), t: "u8" }; return { prim: r.str(), t: "fstr" };
        case "ArrayProperty": return arrayValue(r, td, tag, end);
        case "SetProperty": return setValue(r, td, end);
        case "MapProperty": return mapValue(r, td, end);
        default: return elem(r, td, end, tag.size);
      }
    }

    function structValue(r, name, native, end) {
      if (native && NATIVE[name]) {
        const fields = NATIVE[name](lwc).map(([f, t]) => [f, t, readPrim(r, t)]);
        return { struct: name, native: fields };
      }
      if (native) { if (end === undefined) throw new Error("unknown native struct " + name); return { struct: name, raw: r.bytes(end - r.o) }; }
      return { struct: name, props: props(r, end) };
    }

    function readPrim(r, t) {
      switch (t) {
        case "u8": return r.u8(); case "i32": return r.i32(); case "u32": return r.u32(); case "i64": return r.i64(); case "u64": return r.u64();
        case "f32": return r.f32(); case "f64": return r.f64(); case "fstr": return r.str(); case "guid": return r.bytes(16);
        case "i8": { const v = r.u8(); return v > 127 ? v - 256 : v; }
        case "i16": { const v = r.u16(); return v > 32767 ? v - 65536 : v; }
        case "u16": return r.u16();
        case "tags": { const n = r.i32(); const a = []; for (let i = 0; i < n; i++) a.push(r.str()); return a; }
        case "softobj": return ue5 >= 1007 ? [r.str(), r.str(), r.str()] : [r.str(), r.str()];
        default: throw new Error("prim " + t);
      }
    }
    const PRIM = {
      IntProperty: "i32", Int8Property: "i8", Int16Property: "i16", Int64Property: "i64", UInt16Property: "u16", UInt32Property: "u32", UInt64Property: "u64",
      FloatProperty: "f32", DoubleProperty: "f64", StrProperty: "fstr", NameProperty: "fstr", EnumProperty: "fstr", ObjectProperty: "fstr",
      SoftObjectProperty: "softobj", SoftClassProperty: "softobj", ClassProperty: "fstr", WeakObjectProperty: "fstr", LazyObjectProperty: "guid",
    };
    /* One element without a tag (array/set/map member, or a simple tag value). */
    function elem(r, td, end, size) {
      if (td.type === "BoolProperty") return { prim: r.u8(), t: "u8", isBool: true };
      if (td.type === "ByteProperty") {
        if (size !== undefined) return size === 1 ? { prim: r.u8(), t: "u8" } : { prim: r.str(), t: "fstr" };
        return td.enum && td.enum !== "None" ? { prim: r.str(), t: "fstr" } : { prim: r.u8(), t: "u8" };
      }
      if (td.type === "StructProperty") return structElem(r, td, end);
      const t = PRIM[td.type];
      if (!t) throw new Error("unsupported " + td.type);
      return { prim: readPrim(r, t), t };
    }
    /* Struct inside a map/set without type info (UE4): Guid if it isn't a property list. */
    function structElem(r, td, end) {
      if (td.struct && NATIVE[td.struct]) return structValue(r, td.struct, true);
      if (td.struct) return structValue(r, td.struct, false, end);
      const at = r.o;
      try { return structValue(r, "?", false, end); } catch (e) { r.o = at; }
      return { struct: "Guid?", native: [["Guid", "guid", r.bytes(16)]] };
    }

    function arrayValue(r, td, tag, end) {
      const n = r.i32();
      const inner = td.inner;
      if (inner.type === "StructProperty" && !complete) {
        const it = readTag(r); // inner tag: name, "StructProperty", size, struct name, guid
        const native = !!NATIVE[it.td.struct];
        const items = [];
        const es = r.o;
        for (let i = 0; i < n; i++) items.push(structValue(r, it.td.struct, native, es + it.size));
        if (r.o !== es + it.size) throw new Error("array struct size mismatch");
        return { array: items, innerTag: it };
      }
      if (inner.type === "StructProperty") {
        const native = !!(tag.flags & 8) || !!NATIVE[inner.struct];
        const items = [];
        for (let i = 0; i < n; i++) items.push(structValue(r, inner.struct, native, end));
        return { array: items };
      }
      if ((inner.type === "ByteProperty") && !(inner.enum && inner.enum !== "None") && tag.size === n + 4) {
        return { bytesArray: r.bytes(n) };
      }
      const items = [];
      for (let i = 0; i < n; i++) items.push(elem(r, inner, end));
      return { array: items };
    }
    function setValue(r, td, end) {
      const removed = r.i32(); const n = r.i32();
      const items = []; for (let i = 0; i < n; i++) items.push(elem(r, td.inner, end));
      return { set: items, removed };
    }
    function mapValue(r, td, end) {
      const removed = r.i32(); const n = r.i32();
      const pairs = [];
      for (let i = 0; i < n; i++) { const k = elem(r, td.key, end); const v = elem(r, td.value, end); pairs.push([k, v]); }
      return { map: pairs, removed };
    }

    /* ---------- writer (mirror) ---------- */
    function wTypeName(w, tn) { w.str(tn.name); w.i32(tn.kids.length); for (const k of tn.kids) wTypeName(w, k); }
    function wTag(w, tag) {
      w.str(tag.name);
      let sizeAt;
      if (complete) {
        wTypeName(w, tag.tn);
        sizeAt = w.o; w.i32(0);
        let flags = tag.flags;
        if (tag.td.type === "BoolProperty") flags = (flags & ~0x10) | (tag.bool ? 0x10 : 0);
        w.u8(flags);
        if (flags & 1) w.i32(tag.arrayIndex);
        if (flags & 2) w.bytes(tag.guid);
        if (flags & 4) for (const x of tag.ext) w.u8(x);
      } else {
        w.str(tag.type);
        sizeAt = w.o; w.i32(0);
        w.i32(tag.arrayIndex);
        switch (tag.type.s) {
          case "StructProperty": w.str(tag.structName); w.bytes(tag.structGuid); break;
          case "BoolProperty": w.u8(tag.bool ? (tag.boolByte || 1) : 0); break;
          case "ByteProperty": case "EnumProperty": w.str(tag.enumName); break;
          case "ArrayProperty": case "SetProperty": w.str(tag.innerType); break;
          case "MapProperty": w.str(tag.keyType); w.str(tag.valueType); break;
        }
        w.u8(tag.hasGuid);
        if (tag.hasGuid) w.bytes(tag.guid);
      }
      return sizeAt;
    }
    function wProps(w, list) {
      for (const p of list) {
        const sizeAt = wTag(w, p.tag);
        const vs = w.o;
        wValue(w, p.tag, p.value);
        w.patchI32(sizeAt, w.o - vs);
      }
      w.str(list.noneName || S("None"));
    }
    function wValue(w, tag, v) {
      if (v.raw && !v.struct) return w.bytes(v.raw);
      if (tag.td.type === "BoolProperty") return;
      if (v.array || v.bytesArray) return wArray(w, v);
      if (v.set) { w.i32(v.removed); w.i32(v.set.length); for (const e of v.set) wElem(w, e); return; }
      if (v.map) { w.i32(v.removed); w.i32(v.map.length); for (const [k, x] of v.map) { wElem(w, k); wElem(w, x); } return; }
      wElem(w, v);
    }
    function wArray(w, v) {
      if (v.bytesArray) { w.i32(v.bytesArray.length); w.bytes(v.bytesArray); return; }
      w.i32(v.array.length);
      if (v.innerTag) {
        const sizeAt = wTag(w, v.innerTag);
        const vs = w.o;
        for (const e of v.array) wElem(w, e);
        w.patchI32(sizeAt, w.o - vs);
        return;
      }
      for (const e of v.array) wElem(w, e);
    }
    function wPrim(w, t, x) {
      switch (t) {
        case "u8": return w.u8(x); case "i32": return w.i32(x); case "u32": return w.u32(x); case "i64": return w.i64(x); case "u64": return w.u64(x);
        case "f32": return w.f32(x); case "f64": return w.f64(x); case "fstr": return w.str(x); case "guid": return w.bytes(x);
        case "i8": return w.u8(x & 255); case "i16": return w.u16(x & 65535); case "u16": return w.u16(x);
        case "tags": w.i32(x.length); for (const s of x) w.str(s); return;
        case "softobj": for (const s of x) w.str(s); return;
      }
      throw new Error("prim " + t);
    }
    function wElem(w, e) {
      if (e.struct) {
        if (e.native) { for (const [, t, x] of e.native) wPrim(w, t, x); return; }
        if (e.raw) return w.bytes(e.raw);
        return wProps(w, e.props);
      }
      wPrim(w, e.t, e.prim);
    }

    return { props, wProps, readTag };
  }

  /* ---------- file ---------- */
  function parseFile(b) {
    const r = new R(b);
    if (!M.startsWith(b, "GVAS")) throw new Error("not a GVAS file");
    r.o = 4;
    const hdr = { ver: r.i32(), ue4: r.i32() };
    if (hdr.ver >= 3) hdr.ue5 = r.i32();
    hdr.major = r.u16(); hdr.minor = r.u16(); hdr.patch = r.u16(); hdr.cl = r.u32();
    hdr.branch = r.str();
    hdr.cvFormat = r.i32();
    const n = r.i32();
    hdr.cv = r.bytes(n * 20);
    hdr.cvCount = n;
    hdr.cls = r.str();
    if ((hdr.ue5 || 0) >= 1011) hdr.control = r.u8(); // object serialization control byte
    const p = makeParser(hdr);
    const props = p.props(r);
    const tail = b.slice(r.o);
    return { hdr, props, tail, p };
  }
  function writeFile(f) {
    const w = new W();
    const h = f.hdr;
    w.bytes(M.latin1.encode("GVAS"));
    w.i32(h.ver); w.i32(h.ue4);
    if (h.ver >= 3) w.i32(h.ue5);
    w.u16(h.major); w.u16(h.minor); w.u16(h.patch); w.u32(h.cl);
    w.str(h.branch);
    w.i32(h.cvFormat); w.i32(h.cvCount); w.bytes(h.cv);
    w.str(h.cls);
    if (h.control !== undefined) w.u8(h.control);
    f.p.wProps(w, f.props);
    w.bytes(f.tail);
    return w.out();
  }

  /* ---------- generic tree ---------- */
  const numStr = (t, x) => (typeof x === "bigint" ? x.toString() : t === "f32" || t === "f64" ? (Number.isInteger(x) ? x.toFixed(1) : String(t === "f32" ? Math.fround(x) : x)) : String(x));
  function primNode(holder, key, t, extra) {
    const x = holder[key];
    if (t === "fstr") return { kind: "string", value: x.s, editable: true, _set: (v) => { holder[key] = Object.assign({}, x, { s: String(v), z: false }); } };
    if (t === "guid") return { kind: "bytes", value: x, editable: false };
    if (t === "tags") return { kind: "array", children: x.map((s, i) => ({ key: i, node: primNode(x, i, "fstr") })) };
    if (t === "softobj") return { kind: "array", children: x.map((s, i) => ({ key: i, node: primNode(x, i, "fstr") })), note: "soft object path" };
    if (extra && extra.isBool) return { kind: "bool", value: !!x, editable: true, _set: (v) => { holder[key] = v === true || v === "true" || v === 1 ? 1 : 0; } };
    return {
      kind: "number", value: numStr(t, x), editable: true, note: t,
      _set: (v) => {
        const s = String(v).trim();
        if (t === "i64" || t === "u64") { holder[key] = BigInt(s); return; }
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error("not a number: " + s);
        if (t !== "f32" && t !== "f64" && !Number.isInteger(n)) throw new Error("not an integer: " + s);
        const lim = { u8: [0, 255], i8: [-128, 127], i16: [-32768, 32767], u16: [0, 65535], i32: [-2147483648, 2147483647], u32: [0, 4294967295] }[t];
        if (lim && (n < lim[0] || n > lim[1])) throw new Error(`${s} out of range for ${t}`);
        holder[key] = n;
      },
    };
  }
  function valueNode(v, tag) {
    if (v.raw && !v.struct) return { kind: "bytes", value: v.raw, editable: false, note: "not decoded: " + (v.why || "") };
    if (tag && tag.td.type === "BoolProperty") return { kind: "bool", value: v.bool, editable: true, _set: (x) => { v.bool = tag.bool = x === true || x === "true" || x === 1 || x === "1"; } };
    if (v.bytesArray) return { kind: "bytes", value: v.bytesArray, editable: false };
    if (v.array) return { kind: "array", children: v.array.map((e, i) => ({ key: i, node: valueNode(e) })) };
    if (v.set) return { kind: "array", children: v.set.map((e, i) => ({ key: i, node: valueNode(e) })), note: "set" };
    if (v.map) return { kind: "array", note: "map", children: v.map.map((kv, i) => ({ key: i, node: { kind: "object", children: [{ key: "key", node: valueNode(kv[0]) }, { key: "value", node: valueNode(kv[1]) }] } })) };
    if (v.struct) {
      if (v.native) return { kind: "object", note: v.struct, children: v.native.map((f) => ({ key: f[0], node: primNode(f, 2, f[1]) })) };
      if (v.raw) return { kind: "bytes", value: v.raw, editable: false, note: v.struct };
      return Object.assign(propsNode(v.props), { note: v.struct });
    }
    return primNode(v, "prim", v.t, v);
  }
  function propsNode(list) {
    const used = new Set();
    return {
      kind: "object",
      children: list.map((p, i) => {
        let key = p.tag.name.s + (p.tag.arrayIndex ? `[${p.tag.arrayIndex}]` : "");
        if (used.has(key)) key = key + "#" + i;
        used.add(key);
        const node = valueNode(p.value, p.tag);
        node.note = node.note || p.tag.td.type.replace("Property", "");
        return { key, node };
      }),
    };
  }

  M.register({
    id: "gvas",
    name: "Unreal GVAS",
    engine: "Unreal Engine 4 / 5",
    status: "tested",
    detect(f) { return M.startsWith(f.bytes, "GVAS") ? 50 : 0; },
    async decode(files) {
      const parts = files.map((f) => {
        const g = parseFile(f.bytes);
        return { name: f.name, g, root: propsNode(g.props) };
      });
      const single = parts.length === 1;
      const root = single ? parts[0].root : { kind: "object", children: parts.map((p) => ({ key: p.name, node: p.root })) };
      const h = parts[0].g.hdr;
      return {
        root, parts,
        note: `UE ${h.major}.${h.minor}.${h.patch}, GVAS v${h.ver}, ${h.cls.s}`,
        get(path) { const n = M.findNode(root, path); return n.children ? undefined : n.kind === "bytes" ? M.hex(n.value) : n.value; },
        node(path) { return M.findNode(root, path); },
        set(path, v) {
          const n = M.findNode(root, path);
          if (!n._set || n.editable === false) throw new Error("not editable: " + M.pathStr(path));
          n._set(v);
          const fresh = n.kind === "string" ? String(v) : n.kind === "bool" ? (v === true || v === "true" || v === 1 || v === "1") : null;
          if (fresh !== null) n.value = fresh;
          else n.value = numStr(n.note, typeof v === "bigint" ? v : n.note === "i64" || n.note === "u64" ? BigInt(String(v)) : Number(v));
        },
      };
    },
    async encode(doc) { return doc.parts.map((p) => ({ name: p.name, bytes: writeFile(p.g) })); },
    quickFields(doc) {
      const want = /^(gold|money|ergo|souls|currency|level|lumina|chroma|colou?rs?|exp|xp|playtime|totalplaytime)$/i;
      const out = [];
      const walk = (n, path, depth) => {
        if (!n.children || depth > 3 || out.length >= 12) return;
        for (const c of n.children) {
          const base = String(c.key).replace(/_\d+_[0-9A-F]{32}$/, "");
          if (!c.node.children && c.node.editable && c.node.kind === "number" && want.test(base)) out.push({ label: base, path: path.concat([c.key]) });
          else if (c.node.kind === "object") walk(c.node, path.concat([c.key]), depth + 1);
        }
      };
      walk(doc.root, [], 0);
      return out;
    },
  });
})(typeof self !== "undefined" ? self : globalThis);
