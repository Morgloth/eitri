/* Data-only Python pickle reader/writer (protocols 2-5). Never imports or calls anything:
 * GLOBAL/REDUCE/NEWOBJ/BUILD only record "class X built with args/state" as data.
 * The pickle is kept as its list of opcodes; an edit swaps the bytes of one opcode
 * (and FRAME lengths are recomputed), so an untouched pickle re-serialises byte for byte.
 * Shared objects (memo references) show once in the tree; later references are "same as" nodes. */
(function (G) {
  "use strict";
  const M = G.Eitri;

  const NOARG = new Set([0x28, 0x2e, 0x30, 0x31, 0x32, 0x4e, 0x52, 0x5d, 0x61, 0x62, 0x64, 0x65, 0x6c, 0x73, 0x74, 0x75, 0x7d, 0x29, 0x81, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x94, 0x97, 0x98, 0x51]);

  function parse(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ops = [];
    let i = 0;
    const u32 = (o) => dv.getUint32(o, true);
    const u64 = (o) => Number(dv.getBigUint64(o, true));
    const line = (o) => { let e = o; while (b[e] !== 10) { if (e >= b.length) throw new Error("pickle: unterminated line"); e++; } return e; };
    while (i < b.length) {
      const s = i, c = b[i++];
      let a = null;
      if (NOARG.has(c)) { /* no argument */ }
      else switch (c) {
        case 0x80: i += 1; break; // PROTO
        case 0x95: a = u64(i); i += 8; break; // FRAME
        case 0x4b: case 0x71: case 0x68: i += 1; break; // BININT1 BINPUT BINGET
        case 0x4d: i += 2; break; // BININT2
        case 0x4a: case 0x72: case 0x6a: i += 4; break; // BININT LONG_BINPUT LONG_BINGET
        case 0x47: i += 8; break; // BINFLOAT
        case 0x8a: i += 1 + b[i]; break; // LONG1
        case 0x8b: i += 4 + u32(i); break; // LONG4
        case 0x8c: case 0x55: case 0x43: i += 1 + b[i]; break; // SHORT_BINUNICODE SHORT_BINSTRING SHORT_BINBYTES
        case 0x58: case 0x54: case 0x42: i += 4 + u32(i); break; // BINUNICODE BINSTRING BINBYTES
        case 0x8d: case 0x8e: case 0x96: i += 8 + u64(i); break; // BINUNICODE8 BINBYTES8 BYTEARRAY8
        case 0x82: i += 1; break; case 0x83: i += 2; break; case 0x84: i += 4; break; // EXT1/2/4
        case 0x63: i = line(line(i) + 1) + 1; break; // GLOBAL module\nname\n
        case 0x69: i = line(line(i) + 1) + 1; break; // INST
        case 0x49: case 0x4c: case 0x46: case 0x53: case 0x56: case 0x50: case 0x67: case 0x70: i = line(i) + 1; break; // text ops
        default: throw new Error(`pickle: unknown opcode 0x${c.toString(16)} at ${s}`);
      }
      if (i > b.length) throw new Error("pickle: truncated");
      ops.push({ c, s, e: i, a });
      if (c === 0x2e) break; // STOP
    }
    return { ops, tail: b.subarray(i) };
  }

  function longLE(bytes) {
    if (!bytes.length) return 0n;
    let v = 0n;
    for (let k = bytes.length - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[k]);
    if (bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8);
    return v;
  }
  function longBytes(v) {
    v = BigInt(v);
    if (v === 0n) return new Uint8Array(0);
    const out = [];
    let x = v;
    for (;;) {
      out.push(Number(x & 255n));
      x >>= 8n;
      if ((x === 0n && !(out[out.length - 1] & 0x80)) || (x === -1n && out[out.length - 1] & 0x80)) break;
    }
    return new Uint8Array(out);
  }

  /* Run the opcodes as data: build the value graph. */
  function build(b, ops) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const stack = [], marks = [], memo = new Map();
    const memoSrc = new Map(); // memo id -> op index of the value (scalars)
    const gets = new Map(); // memo id -> [op index]
    const MARK = { mark: true };
    const sc = (idx, kind, value, extra) => Object.assign({ t: "scalar", kind, value, op: idx }, extra || {});
    const listOf = (o) => { if (o.t === "obj") return (o.items = o.items || []); if (!o.items) throw new Error("pickle: append to " + o.t + " " + JSON.stringify(o).slice(0, 200)); return o.items; };
    const dictOf = (o) => (o.t === "obj" ? (o.ditems = o.ditems || []) : o.items);
    const popMark = () => { const m = marks.pop(); const items = stack.splice(m + 1); stack.pop(); return items; };
    const str = (o, n) => M.utf8.decode(b.subarray(o, o + n));
    const lat = (o, n) => M.latin1.decode(b.subarray(o, o + n));
    const lineAt = (o) => { let e = o; while (b[e] !== 10) e++; return [lat(o, e - o), e + 1]; };
    const doMemo = (id, idx) => {
      const v = stack[stack.length - 1];
      memo.set(id, v);
      if (v && v.t === "scalar") memoSrc.set(id, v.refOp !== undefined ? v.refOp : v.op);
      void idx;
    };
    let memoNext = 0;
    for (let n = 0; n < ops.length; n++) {
      const { c, s } = ops[n], a1 = s + 1;
      switch (c) {
        case 0x80: case 0x95: break;
        case 0x28: marks.push(stack.length); stack.push(MARK); break;
        case 0x2e: break;
        case 0x30: stack.pop(); break;
        case 0x31: popMark(); break;
        case 0x32: stack.push(stack[stack.length - 1]); break;
        case 0x4e: stack.push(sc(n, "null", null)); break;
        case 0x88: stack.push(sc(n, "bool", true)); break;
        case 0x89: stack.push(sc(n, "bool", false)); break;
        case 0x4b: stack.push(sc(n, "int", String(b[a1]))); break;
        case 0x4d: stack.push(sc(n, "int", String(dv.getUint16(a1, true)))); break;
        case 0x4a: stack.push(sc(n, "int", String(dv.getInt32(a1, true)))); break;
        case 0x8a: stack.push(sc(n, "int", String(longLE(b.subarray(a1 + 1, a1 + 1 + b[a1]))))); break;
        case 0x8b: { const l = dv.getUint32(a1, true); stack.push(sc(n, "int", String(longLE(b.subarray(a1 + 4, a1 + 4 + l))))); break; }
        case 0x47: stack.push(sc(n, "float", dv.getFloat64(a1, false))); break;
        case 0x8c: stack.push(sc(n, "str", str(a1 + 1, b[a1]))); break;
        case 0x58: stack.push(sc(n, "str", str(a1 + 4, dv.getUint32(a1, true)))); break;
        case 0x8d: stack.push(sc(n, "str", str(a1 + 8, Number(dv.getBigUint64(a1, true))))); break;
        case 0x55: stack.push(sc(n, "bstr", lat(a1 + 1, b[a1]))); break;
        case 0x54: stack.push(sc(n, "bstr", lat(a1 + 4, dv.getUint32(a1, true)))); break;
        case 0x43: stack.push(sc(n, "bytes", b.slice(a1 + 1, a1 + 1 + b[a1]))); break;
        case 0x42: stack.push(sc(n, "bytes", b.slice(a1 + 4, a1 + 4 + dv.getUint32(a1, true)))); break;
        case 0x8e: case 0x96: stack.push(sc(n, "bytes", b.slice(a1 + 8, a1 + 8 + Number(dv.getBigUint64(a1, true))))); break;
        case 0x49: case 0x4c: case 0x46: case 0x53: case 0x56: { const [t] = lineAt(a1); stack.push({ t: "scalar", kind: "text", value: t, op: n, ro: true }); break; }
        case 0x7d: stack.push({ t: "dict", items: [] }); break;
        case 0x5d: stack.push({ t: "list", items: [] }); break;
        case 0x29: stack.push({ t: "tuple", items: [] }); break;
        case 0x8f: stack.push({ t: "set", items: [] }); break;
        case 0x85: stack.push({ t: "tuple", items: [stack.pop()] }); break;
        case 0x86: { const y = stack.pop(), x = stack.pop(); stack.push({ t: "tuple", items: [x, y] }); break; }
        case 0x87: { const z = stack.pop(), y = stack.pop(), x = stack.pop(); stack.push({ t: "tuple", items: [x, y, z] }); break; }
        case 0x74: stack.push({ t: "tuple", items: popMark() }); break;
        case 0x6c: stack.push({ t: "list", items: popMark() }); break;
        case 0x64: { const it = popMark(), d = { t: "dict", items: [] }; for (let k = 0; k < it.length; k += 2) d.items.push([it[k], it[k + 1]]); stack.push(d); break; }
        case 0x91: stack.push({ t: "frozenset", items: popMark() }); break;
        /* On a class instance (RevertableList/Dict subclasses) appends and setitems are data too. */
        case 0x61: { const v = stack.pop(); listOf(stack[stack.length - 1]).push(v); break; }
        case 0x65: case 0x90: { const it = popMark(); listOf(stack[stack.length - 1]).push(...it); break; }
        case 0x73: { const v = stack.pop(), k = stack.pop(); dictOf(stack[stack.length - 1]).push([k, v]); break; }
        case 0x75: { const it = popMark(), d = dictOf(stack[stack.length - 1]); for (let k = 0; k < it.length; k += 2) d.push([it[k], it[k + 1]]); break; }
        case 0x94: doMemo(memoNext++, n); break;
        case 0x71: doMemo(b[a1], n); break;
        case 0x72: doMemo(dv.getUint32(a1, true), n); break;
        case 0x68: case 0x6a: {
          const id = c === 0x68 ? b[a1] : dv.getUint32(a1, true);
          if (!memo.has(id)) throw new Error("pickle: memo " + id + " missing");
          const v = memo.get(id);
          (gets.get(id) || gets.set(id, []).get(id)).push(n);
          stack.push(v && v.t === "scalar" ? Object.assign({}, v, { op: n, refOp: memoSrc.get(id), memoId: id }) : v);
          break;
        }
        case 0x63: { const [m, e1] = lineAt(a1); const [nm] = lineAt(e1); stack.push({ t: "global", name: m + "." + nm }); break; }
        case 0x93: { const nm = stack.pop(), m = stack.pop(); stack.push({ t: "global", name: m.value + "." + nm.value }); break; }
        case 0x82: case 0x83: case 0x84: stack.push({ t: "global", name: "ext#" + (c === 0x82 ? b[a1] : c === 0x83 ? dv.getUint16(a1, true) : dv.getInt32(a1, true)) }); break;
        case 0x52: { const args = stack.pop(), f = stack.pop(); stack.push({ t: "obj", cls: f, args, how: "reduce" }); break; }
        case 0x81: { const args = stack.pop(), cls = stack.pop(); stack.push({ t: "obj", cls, args, how: "newobj" }); break; }
        case 0x92: { const kw = stack.pop(), args = stack.pop(), cls = stack.pop(); stack.push({ t: "obj", cls, args, kwargs: kw, how: "newobj_ex" }); break; }
        case 0x62: { const st = stack.pop(), o = stack[stack.length - 1]; if (o.t !== "obj") stack[stack.length - 1] = { t: "obj", cls: { t: "global", name: "?" }, args: null, base: o, how: "build" }; (stack[stack.length - 1].states = stack[stack.length - 1].states || []).push(st); break; }
        case 0x69: { const [m, e1] = lineAt(a1); const [nm] = lineAt(e1); stack.push({ t: "obj", cls: { t: "global", name: m + "." + nm }, args: { t: "tuple", items: popMark() }, how: "inst" }); break; }
        case 0x6f: { const it = popMark(); stack.push({ t: "obj", cls: it[0], args: { t: "tuple", items: it.slice(1) }, how: "obj" }); break; }
        case 0x50: case 0x51: { if (c === 0x51) stack.pop(); stack.push({ t: "scalar", kind: "text", value: "persistent id", op: n, ro: true }); break; }
        case 0x70: case 0x67: { const [t] = lineAt(a1); const id = Number(t); if (c === 0x70) doMemo(id, n); else stack.push(memo.get(id)); break; }
        case 0x97: case 0x98: stack.push({ t: "scalar", kind: "text", value: "pickle buffer", op: n, ro: true }); break;
        default: throw new Error(`pickle: opcode 0x${c.toString(16)} not handled`);
      }
    }
    return { value: stack[stack.length - 1], memoSrc, gets };
  }

  /* Value graph -> generic tree. */
  function toTree(v, seen, path) {
    if (!v) return { kind: "null", value: null };
    if (v.t === "scalar") {
      const kind = { int: "number", float: "number", str: "string", bstr: "string", bytes: "bytes", bool: "bool", null: "null", text: "other" }[v.kind];
      const value = v.kind === "float" ? floatStr(v.value) : v.value;
      return { kind, value, editable: !v.ro && v.kind !== "bytes", _s: v, note: v.kind === "bstr" ? "py2 str" : undefined };
    }
    if (seen.has(v)) return { kind: "other", value: "same as " + (M.pathStr(seen.get(v)) || "(root)"), note: "shared reference" };
    seen.set(v, path);
    const kids = (items) => items.map((x, i) => ({ key: i, node: toTree(x, seen, path.concat([i])) }));
    switch (v.t) {
      case "list": case "tuple": case "set": case "frozenset":
        return { kind: "array", children: kids(v.items), note: v.t === "list" ? undefined : v.t };
      case "dict": return dictTree(v.items, seen, path);
      case "global": return { kind: "other", value: v.name, note: "class/function" };
      case "obj": {
        const children = [];
        const cls = v.cls && v.cls.t === "global" ? v.cls.name : "?";
        const add = (key, x) => children.push({ key, node: toTree(x, seen, path.concat([key])) });
        if (v.args && !(v.args.t === "tuple" && v.args.items.length === 0)) add("__args__", v.args);
        if (v.kwargs) add("__kwargs__", v.kwargs);
        if (v.base) add("__base__", v.base);
        const plainState = !(v.states || []).length && !v.kwargs && !(v.args && !(v.args.t === "tuple" && v.args.items.length === 0));
        if (plainState && v.items && !v.ditems) return { kind: "array", children: kids(v.items), note: cls };
        if (plainState && v.ditems && !v.items) return Object.assign(dictTree(v.ditems, seen, path), { note: cls });
        if (v.items) add("__items__", { t: "list", items: v.items });
        if (v.ditems) add("__dictitems__", { t: "dict", items: v.ditems });
        for (const [si, st] of (v.states || []).entries()) {
          const key = si ? "__state" + si + "__" : "__state__";
          if (st && st.t === "dict" && v.states.length === 1 && !seen.has(st)) {
            seen.set(st, path);
            for (const c of dictTree(st.items, seen, path).children) children.push(c);
          } else add(key, st);
        }
        return { kind: "object", children, note: cls };
      }
      default: return { kind: "other", value: v.t };
    }
  }
  function dictTree(items, seen, path) {
    const children = [];
    const used = new Set();
    items.forEach(([k, val], i) => {
      let key = k && k.t === "scalar" && (k.kind === "str" || k.kind === "bstr" || k.kind === "int") ? String(k.value) : "#" + i;
      if (used.has(key)) key = "#" + i;
      used.add(key);
      children.push({ key, node: toTree(val, seen, path.concat([key])) });
    });
    return { kind: "object", children };
  }
  const floatStr = (x) => (Number.isInteger(x) && Math.abs(x) < 1e16 ? x.toFixed(1) : String(x));

  /* New opcode bytes for a scalar edit (same kind as before). */
  function opFor(s, value) {
    const k = s.kind;
    if (k === "bool") { const t = value === true || value === "true" || value === "True" || value === 1 || value === "1"; return new Uint8Array([t ? 0x88 : 0x89]); }
    if (k === "null") { if (value === null || value === "null" || value === "None") return new Uint8Array([0x4e]); throw new Error("None can only stay None"); }
    if (k === "int") {
      const s2 = String(value).trim();
      if (!/^-?\d+$/.test(s2)) throw new Error("not an integer: " + s2);
      const v = BigInt(s2);
      if (v >= 0n && v < 256n) return new Uint8Array([0x4b, Number(v)]);
      if (v >= 0n && v < 65536n) return new Uint8Array([0x4d, Number(v) & 255, Number(v) >> 8]);
      if (v >= -2147483648n && v <= 2147483647n) { const o = new Uint8Array(5); o[0] = 0x4a; new DataView(o.buffer).setInt32(1, Number(v), true); return o; }
      const lb = longBytes(v); if (lb.length > 255) throw new Error("integer too large");
      return M.concat([new Uint8Array([0x8a, lb.length]), lb]);
    }
    if (k === "float") {
      const x = Number(value); if (!Number.isFinite(x)) throw new Error("not a number: " + value);
      const o = new Uint8Array(9); o[0] = 0x47; new DataView(o.buffer).setFloat64(1, x, false); return o;
    }
    if (k === "str") {
      const u = M.utf8.encode(String(value));
      if (u.length < 256) return M.concat([new Uint8Array([0x8c, u.length]), u]);
      const h = new Uint8Array(5); h[0] = 0x58; new DataView(h.buffer).setUint32(1, u.length, true); return M.concat([h, u]);
    }
    if (k === "bstr") {
      const u = M.latin1.encode(String(value));
      if (u.length < 256) return M.concat([new Uint8Array([0x55, u.length]), u]);
      const h = new Uint8Array(5); h[0] = 0x54; new DataView(h.buffer).setUint32(1, u.length, true); return M.concat([h, u]);
    }
    throw new Error("can't edit a " + k);
  }

  M.Pickle = {
    /* -> doc {root, get, set, toBytes} */
    doc(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const { ops, tail } = parse(b);
      const g = build(b, ops);
      const root = toTree(g.value, new Map(), []);
      const repl = new Map(); // op index -> bytes
      const opBytes = (n) => repl.get(n) || b.subarray(ops[n].s, ops[n].e);
      return {
        root,
        get(path) { const n = M.findNode(root, path); return n.children ? undefined : n.value; },
        node(path) { return M.findNode(root, path); },
        set(path, value) {
          const node = M.findNode(root, path);
          if (!node._s || node.editable === false) throw new Error("not editable: " + M.pathStr(path));
          const s = node._s;
          const fresh = opFor(s, value);
          if (s.refOp === undefined) {
            /* The literal itself: if later BINGETs read it from the memo, give them the old value inline. */
            for (const [id, src] of g.memoSrc) if (src === s.op) for (const gi of g.gets.get(id) || []) if (!repl.has(gi)) repl.set(gi, b.subarray(ops[s.op].s, ops[s.op].e));
          }
          repl.set(s.op, fresh);
          node.value = M.Pickle.doc(M.concat([new Uint8Array([0x80, 4]), fresh, new Uint8Array([0x2e])])).root.value;
        },
        dirty: () => repl.size > 0,
        /* FRAME n covers the ops whose bytes started inside its original length; big ops the
         * pickler wrote outside a frame stay outside. */
        toBytes() {
          const parts = [];
          let frameAt = -1, frameLen = 0, frameEnd = -1;
          const closeFrame = () => { if (frameAt >= 0) { const h = new Uint8Array(9); h[0] = 0x95; new DataView(h.buffer).setBigUint64(1, BigInt(frameLen), true); parts[frameAt] = h; frameAt = -1; } };
          for (let n = 0; n < ops.length; n++) {
            if (ops[n].c === 0x95) { closeFrame(); frameAt = parts.length; frameLen = 0; frameEnd = ops[n].e + ops[n].a; parts.push(null); continue; }
            if (frameAt >= 0 && ops[n].s >= frameEnd) closeFrame();
            const ob = opBytes(n);
            parts.push(ob);
            if (frameAt >= 0) frameLen += ob.length;
          }
          closeFrame();
          parts.push(tail);
          return M.concat(parts);
        },
      };
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
