// Eitri: save library + editor (API in API.md). The server only stores bytes and
// metadata; detect / decode / encode / diff / checksums all run here through window.Eitri (eitri/core + plugins).
// Views by hash: "" library, #g=<slug> game page, #g=<slug>&e=<vid> editor. No timers run while idle.
(() => {
  "use strict";
  const M = window.Eitri;
  const $ = (id) => document.getElementById(id);
  const DATA = JSON.parse($("initial-data").textContent || "{}");
  const API = "/api";
  const LIM = DATA.limits || {};

  // ---------------------------------------------------------------- helpers
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const enc = encodeURIComponent;
  const size = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const TIME = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const when = (epoch, text) => text || (epoch ? TIME.format(new Date(epoch * 1000)) : "");
  const short = (v, n = 60) => { const s = show(v); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function show(v) {
    if (v === undefined) return "(none)";
    if (v === null) return "null";
    if (v instanceof Uint8Array) return v.length > 48 ? M.hex(v.subarray(0, 48)) + `… (${v.length} bytes)` : M.hex(v);
    return String(v);
  }
  const RUNE = '<svg class="ph-rune" viewBox="4 3 24 26" aria-hidden="true"><path d="M11.5 5.5v21M11.5 10.5l8 5.5-8 5.5"/></svg>';
  const pluginById = (id) => M.plugins.find((p) => p.id === id) || null;

  async function api(method, path, body, raw) {
    const opt = { method, headers: {} };
    if (method !== "GET") opt.headers["X-Eitri"] = "1";
    if (raw) { opt.body = raw.body; opt.headers["Content-Type"] = raw.type || "application/octet-stream"; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
    let res;
    try { res = await fetch(API + path, opt); } catch (e) { throw new Error("can't reach the server: " + e.message); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) { const err = new Error((data && data.error) || `${res.status} ${res.statusText}`); err.status = res.status; throw err; }
    return data;
  }
  async function bytesOf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const readFile = (f) => f.arrayBuffer().then((b) => ({ name: f.name, bytes: new Uint8Array(b) }));
  async function sha256hex(b) {
    if (window.crypto && crypto.subtle) return M.hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
    return M.hex(M.sha256(b));
  }

  let toastTimer = 0;
  function toast(msg, err) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!err);
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), err ? 7000 : 3500);
  }
  function status(el, msg, cls) { el.textContent = msg || ""; el.className = "status" + (cls ? " " + cls : ""); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    toast("Copied");
  }
  function confirmBox(title, text, yes = "Delete") {
    const d = $("dlg-confirm");
    $("cf-title").textContent = title;
    $("cf-text").textContent = text;
    $("cf-yes").textContent = yes;
    d.returnValue = "";
    d.showModal();
    return new Promise((ok) => d.addEventListener("close", () => ok(d.returnValue === "yes"), { once: true }));
  }
  // A one-line text dialog; resolves to the trimmed text, or null on Cancel / Esc / empty
  function promptBox(title, text, value, yes = "OK") {
    const d = $("dlg-prompt");
    $("pr-title").textContent = title;
    $("pr-text").textContent = text;
    $("pr-yes").textContent = yes;
    $("pr-input").value = value || "";
    d.returnValue = "";
    d.showModal();
    $("pr-input").select();
    return new Promise((ok) => d.addEventListener("close", () => ok(d.returnValue === "yes" && $("pr-input").value.trim() ? $("pr-input").value.trim() : null), { once: true }));
  }
  // Enter in the box means OK (the form's first button is Cancel)
  $("pr-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("dlg-prompt").close("yes"); } });
  function download(url, name) {
    const a = Object.assign(document.createElement("a"), { href: url });
    a.download = name || "";
    document.body.append(a); a.click(); a.remove();
  }
  // Pager names must change when the list is a new one (a new search / diff) so it starts on page 1
  let pagerSeq = 0;
  function freshPager(prefix) {
    document.querySelectorAll(`.pager[data-for^="${prefix}"]`).forEach((e) => e.remove());
    return `${prefix}-${++pagerSeq}`;
  }

  // ---------------------------------------------------------------- plugin glue (all parsing happens here)
  // Units: what one plugin opens together. All files at once when the plugin can (multi-file JSON, GDEC); otherwise
  // one unit per file (RPG Maker and Ren'Py open one file at a time). Files no plugin reads stay as they are.
  function pickPlugin(files, preferId) {
    const pref = pluginById(preferId);
    if (pref && files.some((f) => { try { return pref.detect(f) > 0; } catch (e) { return false; } })) return pref;
    const d = M.detect(files);
    return d ? d.plugin : pref;
  }
  async function openUnits(files, ctx, preferId) {
    const plugin = pickPlugin(files, preferId);
    if (plugin) {
      try { return [{ name: files.length === 1 ? files[0].name : "all files", files, plugin, doc: await M.open(files, ctx, plugin.id) }]; }
      catch (e) { if (files.length === 1) return [{ name: files[0].name, files, plugin, doc: null, error: e.message }]; }
    }
    const out = [];
    for (const f of files) {
      const p = pickPlugin([f], plugin && plugin.id);
      if (!p) { out.push({ name: f.name, files: [f], plugin: null, doc: null, error: "no plugin reads this file" }); continue; }
      try { out.push({ name: f.name, files: [f], plugin: p, doc: await M.open([f], ctx, p.id) }); }
      catch (e) { out.push({ name: f.name, files: [f], plugin: p, doc: null, error: e.message }); }
    }
    return out;
  }
  // Self-check 1: decode -> encode of the untouched save gives back the same bytes
  async function roundTrip(unit, ctx) {
    if (!unit.doc) return { ok: false, text: unit.error };
    try {
      const out = await unit.plugin.encode(unit.doc, ctx);
      for (const f of unit.files) {
        const o = out.find((x) => x.name === f.name);
        if (!o) return { ok: false, text: `${f.name}: missing after encode` };
        if (!M.equal(o.bytes, f.bytes)) return { ok: false, text: `${f.name}: re-encoded bytes differ at byte ${M.firstDiff(o.bytes, f.bytes)}` };
      }
      return { ok: true, text: "decode → encode gives back identical bytes" };
    } catch (e) { return { ok: false, text: "encode failed: " + e.message }; }
  }
  function integrityOf(unit) {
    const d = unit.doc;
    if (!d) return ["unknown", "not decoded"];
    if (d.signed === true) return ["ok", "signed OK"];
    if (d.signed === false) return ["bad", "signature does not verify"];
    if (unit.plugin.id === "renpy") return ["none", "unsigned"];
    if (unit.plugin.id === "godot-encrypted") return ["ok", "decrypted, MD5 OK"];
    const r = (d.rules || []).find((x) => /hash|checksum/i.test(x.notes || ""));
    if (r) return ["ok", "checksum OK"];
    return ["none", "no checksum"];
  }
  // The Detect object sent with every upload (API.md "Detect")
  function detectOf(units, rts) {
    const u = units.find((x) => x.doc) || units.find((x) => x.plugin);
    if (!u) return null;
    const ints = units.filter((x) => x.doc).map(integrityOf);
    const pick = ints.find((i) => i[0] === "bad") || ints.find((i) => i[0] === "ok") || ints[0] || ["unknown", u.error || "not decoded"];
    const det = { plugin: u.plugin.id, engine: u.plugin.engine, format: u.plugin.name, status: u.plugin.status, integrity: pick[0], integrity_text: pick[1].slice(0, 200) };
    const rules = [...new Set(units.flatMap((x) => (x.doc && x.doc.rules ? x.doc.rules.map((r) => r.id) : [])))];
    if (rules.length) det.game_rule = rules.join(", ").slice(0, 200);
    if (rts && units.every((x) => x.doc)) det.roundtrip = units.every((x, i) => rts[i] && rts[i].ok);
    return det;
  }
  const keyCache = new Map();
  async function ctxFor(g) {
    const sig = g.slug + "|" + (g.keys || []).map((k) => k.name + k.modified + k.size).join(",");
    if (keyCache.has(sig)) return keyCache.get(sig);
    const keys = {};
    for (const k of g.keys || []) keys[k.name] = await bytesOf(`${API}/games/${enc(g.slug)}/keys/${enc(k.name)}`);
    const ctx = { keys };
    keyCache.clear();
    keyCache.set(sig, ctx);
    return ctx;
  }
  const fileCache = new Map();
  async function versionFiles(slug, v) {
    const out = [];
    for (const f of v.files) {
      const k = `${slug}/${v.id}/${f.name}`;
      if (!fileCache.has(k)) fileCache.set(k, await bytesOf(`${API}/games/${enc(slug)}/versions/${v.id}/files/${enc(f.name)}`));
      out.push({ name: f.name, bytes: fileCache.get(k) });
    }
    return out;
  }
  async function uploadVersion(slug, files, meta) {
    const total = files.reduce((n, f) => n + f.bytes.length, 0);
    if (files.length > (LIM.files_per_version || 64)) throw new Error(`at most ${LIM.files_per_version || 64} files per version`);
    if (total > (LIM.version_bytes || 64 << 20)) throw new Error(`a version can be at most ${size(LIM.version_bytes || 64 << 20)}`);
    meta = Object.assign({}, meta, { files: [] });
    for (const f of files) meta.files.push({ name: f.name, size: f.bytes.length, sha256: await sha256hex(f.bytes) });
    const mb = new TextEncoder().encode(JSON.stringify(meta));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, mb.length);
    return api("POST", `/games/${enc(slug)}/versions`, undefined,
      { body: new Blob([head, mb, ...files.map((f) => f.bytes)]), type: "application/x-eitri-version" });
  }

  // ---------------------------------------------------------------- state + routing
  let lib = DATA.games || [];
  let game = null;   // GameDetail of the open game
  let ed = null;     // editor state
  if (!DATA.ok && DATA.error) { $("err").textContent = DATA.error; $("err").hidden = false; }

  function views(name) {
    for (const v of ["lib", "game", "edit"]) $("view-" + v).hidden = v !== name;
  }
  let curHash = location.hash;
  async function route() {
    curHash = location.hash;
    const h = new URLSearchParams(location.hash.slice(1));
    const slug = h.get("g"), vid = h.get("e");
    if (ed && (ed.slug !== slug || ed.vid !== vid)) ed = null;  // left the editor: its edits are dropped
    try {
      if (slug && vid) { await openEditor(slug, vid); views("edit"); }
      else if (slug) { await loadGame(slug); views("game"); }
      else { ed = null; renderLib(); views("lib"); document.title = "Eitri Saves"; }
    } catch (e) {
      toast(e.message, true);
      if (e.status === 404) location.hash = "";
    }
    window.scrollTo(0, 0);
  }
  // In-page navigation away from an editor with unsaved changes asks first (reload / tab close: beforeunload below)
  window.addEventListener("hashchange", async () => {
    const target = location.hash;
    if (ed && dirtyUnits().length && target !== curHash) {
      history.replaceState(history.state, "", curHash || location.pathname + location.search);
      const n = allChanges().length;
      if (!(await confirmBox("Leave the editor?", `${n} unsaved change${n === 1 ? "" : "s"} will be lost. Use “Save as new version” to keep them.`, "Leave"))) return;
      ed = null;
      location.hash = target;
      return;
    }
    route();
  });
  window.addEventListener("beforeunload", (e) => { if (ed && dirtyUnits().length) { e.preventDefault(); e.returnValue = ""; } });
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  // ---------------------------------------------------------------- library
  async function refreshLib() {
    try { lib = (await api("GET", "/games")).games; } catch (e) { toast(e.message, true); }
  }
  function renderLib() {
    const q = $("lib-q").value.trim().toLowerCase();
    const list = lib.filter((g) => !q || `${g.name} ${g.slug} ${g.engine || ""} ${g.plugin || ""}`.toLowerCase().includes(q));
    const tiles = list.map((g) => {
      const d = g.last_detect;
      const bits = [`${g.version_count} version${g.version_count === 1 ? "" : "s"}`, size(g.size)];
      return `<a class="tile" href="#g=${enc(g.slug)}" data-slug="${esc(g.slug)}">` +
        `<div class="cov">${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy" decoding="async">` : RUNE}</div>` +
        `<div class="nm">${esc(g.name)}</div>` +
        `<div class="mt">${esc(bits.join(" · "))}<br>${d ? esc([d.format || d.engine, d.integrity_text].filter(Boolean).join(", ")) + "<br>" : ""}edited ${esc(when(g.updated, g.updated_text))}</div></a>`;
    });
    if (!list.length && q) tiles.push(`<p class="lib-empty">No game matches “${esc(q)}”.</p>`);
    tiles.push(`<button class="tile add" type="button" id="add-game"><span class="plus">+</span>Game</button>`);
    $("tiles").innerHTML = tiles.join("");
    $("lib-count").textContent = lib.length ? `${list.length === lib.length ? lib.length : `${list.length} of ${lib.length}`} game${lib.length === 1 ? "" : "s"}, last edited first` : "";
  }
  $("lib-q").addEventListener("input", renderLib);
  $("tiles").addEventListener("click", (e) => { if (e.target.closest("#add-game")) openNew(); });

  // ---------------------------------------------------------------- Steam picks (new game + game page)
  function renderPicks(box, res, radio, withNone) {
    const rows = (res.results || []).map((r, i) =>
      `<label class="pick"><input type="radio" name="${radio}" value="${r.appid}" data-name="${esc(r.name)}"${i === 0 ? " checked" : ""}>` +
      (r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="noimg"></span>`) +
      `<span>${esc(r.name)} <span class="muted small">app ${r.appid}${r.type && r.type !== "app" ? ", " + esc(r.type) : ""}</span></span></label>`);
    if (withNone) rows.push(`<label class="pick"><input type="radio" name="${radio}" value=""${rows.length ? "" : " checked"}><span class="noimg"></span><span>None of these (own image or the rune)</span></label>`);
    box.innerHTML = rows.join("");
  }
  async function steamSearch(q) {
    const r = await api("GET", "/steam/search?q=" + enc(q));
    return r;
  }
  function pluginOptions(sel, current) {
    const opts = [`<option value="">Auto-detect</option>`].concat(M.plugins.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.name)}${p.status === "untested" ? " (untested)" : ""}</option>`));
    if (current && !pluginById(current)) opts.push(`<option value="${esc(current)}">${esc(current)} (unknown)</option>`);
    sel.innerHTML = opts.join("");
    sel.value = current || "";
  }

  // ---------------------------------------------------------------- new game
  let newFiles = [];
  function openNew() {
    $("new-form").reset();
    $("new-picks").innerHTML = "";
    $("new-detect").textContent = "";
    $("new-cover-wrap").hidden = true;
    status($("new-status"), "");
    pluginOptions($("new-plugin"), "");
    newFiles = [];
    $("new-ok").disabled = false;
    $("dlg-new").showModal();
    $("new-name").focus();
  }
  async function newSearch() {
    const q = $("new-name").value.trim();
    if (!q) return status($("new-status"), "Type the name first.", "err");
    newTyped = q;
    status($("new-status"), "Searching Steam…");
    try {
      const r = await steamSearch(q);
      renderPicks($("new-picks"), r, "new-pick", true);
      status($("new-status"), r.error ? `Steam: ${r.error}${r.stale ? " (older results)" : ""}` : r.results.length ? "" : "No Steam match.", r.error ? "err" : "");
    } catch (e) { status($("new-status"), e.message, "err"); }
    syncNewCover();
  }
  // The picked Steam match names the game (trademark signs dropped); "None of these" puts back what was typed
  let newTyped = "";
  function syncNewCover() {
    const sel = document.querySelector('input[name="new-pick"]:checked');
    $("new-cover-wrap").hidden = !!(sel && sel.value);
    if (!sel) return;
    $("new-name").value = sel.value ? sel.dataset.name.replace(/[\u2122\u00ae\u00a9]/g, "").replace(/\s+/g, " ").trim() : newTyped;
  }
  $("new-search").addEventListener("click", newSearch);
  $("new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); newSearch(); } });
  // Enter in another field would submit the form through its first button (Cancel) and close the dialog
  $("new-form").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "file") e.preventDefault(); });
  $("new-picks").addEventListener("change", syncNewCover);
  $("new-files").addEventListener("change", async () => {
    newFiles = await Promise.all([...$("new-files").files].map(readFile));
    if (!newFiles.length) { $("new-detect").textContent = ""; return; }
    const d = M.detect(newFiles);
    if (!d) { $("new-detect").textContent = "No plugin recognises these files. They're still kept as a version."; return; }
    $("new-detect").textContent = `Detected: ${d.plugin.name} (${d.plugin.engine})${d.plugin.status === "untested" ? ", untested" : ""}${d.plugin.needsKey ? `. Needs ${d.plugin.needsKey}: add it on the game page.` : ""}`;
    $("new-plugin").value = d.plugin.id;
    if (!$("new-engine").value) $("new-engine").value = d.plugin.engine;
  });
  $("new-ok").addEventListener("click", async () => {
    const name = $("new-name").value.trim();
    if (!name) return status($("new-status"), "A name is needed.", "err");
    const body = { name };
    const pick = document.querySelector('input[name="new-pick"]:checked');
    if (pick && pick.value) { body.steam_appid = Number(pick.value); body.steam_name = pick.dataset.name; }
    if ($("new-plugin").value) body.plugin = $("new-plugin").value;
    if ($("new-engine").value.trim()) body.engine = $("new-engine").value.trim();
    $("new-ok").disabled = true;
    status($("new-status"), body.steam_appid ? "Creating… fetching the Steam cover and the PCGamingWiki page (can take ~20 s)" : "Creating…");
    try {
      const g = await api("POST", "/games", body);
      const cover = $("new-cover").files[0];
      if (!body.steam_appid && cover) await api("PUT", `/games/${enc(g.slug)}/cover`, undefined, { body: cover, type: cover.type });
      if (newFiles.length) {
        const ctx = { keys: {} };
        const units = await openUnits(newFiles, ctx, body.plugin);
        const rts = [];
        for (const u of units) rts.push(await roundTrip(u, ctx));
        await uploadVersion(g.slug, newFiles, { parent: null, label: "original", detect: detectOf(units, rts) || undefined });
      }
      $("dlg-new").close();
      const lk = g.lookup || {};
      const issues = [lk.cover && lk.cover !== "ok" ? "cover: " + lk.cover : "", lk.pcgw && lk.pcgw !== "ok" ? "PCGamingWiki: " + lk.pcgw : ""].filter(Boolean);
      toast(`Created ${g.name}${issues.length ? " (" + issues.join("; ") + ")" : ""}`);
      await refreshLib();
      game = null;
      go("#g=" + enc(g.slug));
    } catch (e) {
      status($("new-status"), e.message, "err");
      $("new-ok").disabled = false;
    }
  });

  // ---------------------------------------------------------------- game page
  async function loadGame(slug) {
    const g = await api("GET", `/games/${enc(slug)}`);
    if (!game || game.slug !== g.slug) { fileCache.clear(); upFiles = []; $("g-up-info").hidden = true; $("d-out").innerHTML = ""; $("s-picks").innerHTML = ""; $("s-q").value = ""; }
    game = g;
    renderGame();
  }
  function setGame(g) { game = Object.assign(game || {}, g); renderGame(); }
  function renderGame() {
    const g = game;
    document.title = `${g.name} · Eitri`;
    const p = pluginById(g.plugin);
    const sep = /\\/.test(DATA.saves_dir || "") ? "\\" : "/";
    const folder = `${DATA.saves_dir || "saves"}${sep}${g.folder}`;
    const facts = [
      `<span>Plugin <b>${esc(p ? p.name : g.plugin || "not set")}</b></span>`,
      g.engine ? `<span>Engine <b>${esc(g.engine)}</b></span>` : "",
      `<span><b>${g.versions.length}</b> version${g.versions.length === 1 ? "" : "s"}</span>`,
      `<span>Total <b>${size(g.size)}</b></span>`,
      `<span>Added ${esc(when(g.created, g.created_text))}</span>`,
      `<span>Edited ${esc(when(g.updated, g.updated_text))}</span>`,
    ];
    const links = [];
    if (g.steam_appid) links.push(`<a href="https://store.steampowered.com/app/${g.steam_appid}/" target="_blank" rel="noopener noreferrer">Steam</a>`);
    if (g.pcgw && g.pcgw.url) links.push(`<a href="${esc(g.pcgw.url)}" target="_blank" rel="noopener noreferrer">PCGamingWiki</a>`);
    $("g-head").innerHTML =
      `<div class="gcov">${g.cover ? `<img src="${esc(g.cover)}" alt="">` : RUNE}</div>` +
      `<div class="ginfo"><h2>${esc(g.name)}</h2><div class="facts">${facts.join("")}</div>` +
      `<div class="facts"><span>Folder <code>${esc(folder)}</code></span><button class="btn small" type="button" data-copy="${esc(folder)}">Copy</button>${links.join(" · ")}</div>` +
      `<div class="acts"><a class="btn small" href="#">‹ Library</a><button class="btn small danger" type="button" id="g-del">Delete game</button></div></div>`;
    $("g-cloud").hidden = !g.steam_cloud_warning;
    $("g-cloud-ack").checked = false;
    $("n-cloud").checked = !!g.steam_cloud_ack;
    // notes card
    $("n-name").value = g.name;
    pluginOptions($("n-plugin"), g.plugin);
    $("n-engine").value = g.engine || "";
    $("n-notes").value = g.notes || "";
    $("n-rules").value = g.rules || "";
    $("n-rules").placeholder = M.rules.filter((r) => r.plugin === g.plugin && r.notes).map((r) => `${r.game}: ${r.notes}`).join("\n") || "e.g. gold is stored 3 times; the hash is rebuilt automatically";
    status($("n-status"), "");
    // save location
    $("l-install").value = g.install_dir || "";
    $("l-user").value = g.save_location.user || "";
    renderLoc();
    $("l-lookup").disabled = !g.steam_appid;
    $("l-lookup").title = g.steam_appid ? "Ask PCGamingWiki again" : "Needs a Steam match";
    // keys
    $("k-list").innerHTML = (g.keys || []).map((k) =>
      `<li><span class="nm mono">${esc(k.name)}</span><span class="muted small">${size(k.size)} · ${esc(when(k.modified, k.modified_text))}</span>` +
      `<a class="btn small" href="${API}/games/${enc(g.slug)}/keys/${enc(k.name)}" download="${esc(k.name)}">Get</a>` +
      `<button class="btn small danger" type="button" data-delkey="${esc(k.name)}">Delete</button></li>`).join("") || `<li class="muted">No key files.</li>`;
    $("k-hint").dataset.need = p && p.needsKey ? p.needsKey : "";
    if (p && p.needsKey && !(g.keys || []).length) $("k-list").innerHTML = `<li class="orphan">${esc(p.name)} needs ${esc(p.needsKey)}.</li>`;
    // steam
    $("s-now").innerHTML = g.steam_appid ? `Matched: <b>${esc(g.steam_name || g.name)}</b> (app ${g.steam_appid}). Cover: ${esc(g.cover_source || "none")}.`
      : `No Steam match. Cover: ${esc(g.cover_source || "rune")}.`;
    if (!$("s-q").value) $("s-q").value = g.name;
    $("c-steam").disabled = !g.steam_appid;
    $("c-del").disabled = !g.cover;
    renderVersions();
  }
  function resolved() {
    const inst = $("l-install").value.trim().replace(/[\\/]+$/, "");
    const paths = game.save_location.paths || [];
    const user = $("l-user").value;
    const list = user.trim() ? user.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : paths;
    return list.map((x) => (inst ? x.split("<install>").join(inst) : x));
  }
  function renderLoc() {
    const g = game, loc = g.save_location;
    const res = resolved();
    $("l-paths").innerHTML = res.length ? res.map((x) => `<div class="locp"><code>${esc(x)}</code><button class="btn small" type="button" data-copy="${esc(x)}">Copy</button></div>`).join("")
      : `<p class="hint">No save location known. Add your own under “Edit save location”.</p>`;
    const src = $("l-user").value.trim() ? "your own path" : { user: "your own path", pcgamingwiki: "from PCGamingWiki", engine: "engine default (a guess)", none: "" }[loc.source] || "";
    const pc = g.pcgw;
    const pcText = !g.steam_appid ? "No Steam match, so no PCGamingWiki lookup." : !pc ? "PCGamingWiki not looked up yet."
      : pc.error ? `PCGamingWiki lookup failed (${pc.error}).` : pc.page === null ? "PCGamingWiki has no article for this game." : `PCGamingWiki checked ${when(pc.fetched, pc.fetched_text)}.`;
    $("l-source").textContent = [src ? `Shown: ${src}.` : "", "%VAR% paths paste straight into Explorer.", pcText].filter(Boolean).join(" ");
    $("l-looked").innerHTML = (loc.looked_up || []).length || loc.engine_default
      ? `<p class="hint">Looked up:</p><ul class="looked">${(loc.looked_up || []).map((x) => `<li>${esc(x.platform)}: <code>${esc(x.path)}</code></li>`).join("")}` +
        (loc.engine_default ? `<li>Engine default: <code>${esc(loc.engine_default)}</code></li>` : "") + "</ul>" : "";
  }
  $("l-install").addEventListener("input", renderLoc);
  $("l-user").addEventListener("input", renderLoc);

  // Version tree: roots newest first, each followed by its children (depth-first). A version whose parent was
  // deleted is a root with a "parent deleted" mark.
  function flatVersions() {
    const by = new Map(game.versions.map((v) => [v.id, v]));
    const out = [];
    const walk = (v, depth) => {
      out.push({ v, depth });
      const kids = (v.children || []).map((c) => by.get(c)).filter(Boolean).sort((a, b) => b.n - a.n);
      for (const k of kids) walk(k, depth + 1);
    };
    game.versions.filter((v) => !v.parent || !by.has(v.parent)).sort((a, b) => b.n - a.n).forEach((v) => walk(v, 0));
    return out;
  }
  function changeList(changed, max = 60, w = 80) {
    if (!changed || !changed.length) return "";
    const shown = changed.slice(0, max).map((c) => {
      const p = Array.isArray(c.path) ? M.pathStr(c.path) : String(c.path ?? "");
      return `<li><span class="p">${esc(p)}</span> ${esc(short(c.before, w))} <span class="arr">→</span> ${esc(short(c.after, w))}${c.linked ? `<span class="lk">linked${c.rule ? " (" + esc(c.rule) + ")" : ""}</span>` : ""}</li>`;
    });
    if (changed.length > max) shown.push(`<li class="muted">…and ${changed.length - max} more</li>`);
    return `<ul class="chg">${shown.join("")}</ul>`;
  }
  function versionRow({ v, depth }) {
    const d = v.detect;
    const multi = v.files.length > 1;
    const dl = multi ? `${API}/games/${enc(game.slug)}/versions/${v.id}/zip` : `${API}/games/${enc(game.slug)}/versions/${v.id}/files/${enc(v.files[0].name)}`;
    const files = v.files.map((f) => `${esc(f.name)} (${size(f.size)})`).join(", ");
    const nlinked = (v.changed || []).filter((c) => c.linked).length;
    const ich = d && d.integrity ? `<span class="badge ${d.integrity === "ok" ? "ok" : d.integrity === "bad" ? "bad" : ""}">${esc(d.integrity_text || d.integrity)}</span>` : "";
    const rt = d && d.roundtrip === false ? `<span class="badge warn">round trip differs</span>` : "";
    const orphan = v.parent && !v.parent_exists ? `<span class="orphan" title="was a child of ${esc(v.parent)}">parent ${esc(v.parent)} deleted</span>` : "";
    const pad = depth ? `<span class="tree-pad" style="padding-left:${(depth - 1) * 14}px">└</span>` : "";
    return `<div class="vrow" data-vid="${v.id}"><div class="sel">${pad}</div><div>` +
      `<div class="vt"><span class="vid">${v.id}</span><span class="vlab">${esc(v.label)}</span><span class="badge rc">${esc(v.kind)}</span>${ich}${rt}${orphan}</div>` +
      `<div class="vmeta"><span>${esc(when(v.created, v.created_text))}</span><span>${files}</span>${v.parent && v.parent_exists ? `<span>from ${esc(v.parent)}</span>` : ""}${d && d.format ? `<span>${esc(d.format)}</span>` : ""}</div>` +
      (v.note ? `<div class="vmeta">${esc(v.note)}</div>` : "") + `</div>` +
      `<div class="vacts"><a class="btn small" href="#g=${enc(game.slug)}&e=${v.id}">Edit</a>` +
      `<a class="btn small" href="${dl}" download="${multi ? "" : esc(v.files[0].name)}" title="${multi ? "zip of all files, original names" : "exact original file name"}">Download${multi ? " zip" : ""}</a>` +
      (v.parent && v.parent_exists ? `<button class="btn small" type="button" data-diff="${esc(v.parent)},${v.id}">Diff</button>` : "") +
      `<button class="btn small danger" type="button" data-delv="${v.id}">Delete</button></div>` +
      (v.changed && v.changed.length ? `<details><summary>${v.changed.length} changed field${v.changed.length === 1 ? "" : "s"}${nlinked ? ` (${nlinked} linked)` : ""}</summary>${changeList(v.changed)}</details>` : "") +
      `</div>`;
  }
  function renderVersions() {
    const items = flatVersions();
    $("g-vcount").textContent = items.length ? `${items.length}, newest first, children under their parent` : "";
    // drop every version pager, not just this game's: one left from the previous game page would stay on screen
    document.querySelectorAll('.pager[data-for^="versions-"]').forEach((e) => e.remove());
    if (!items.length) {
      $("g-versions").innerHTML = `<p class="hint">No versions yet: upload a save above.</p>`;
    } else {
      Pager.rows({ name: `versions-${game.slug}`, items, into: $("g-versions"), render: versionRow,
        csv: () => [["id", "label", "kind", "parent", "created", "files", "bytes", "changed"]].concat(items.map(({ v }) =>
          [v.id, v.label, v.kind, v.parent || "", when(v.created, v.created_text), v.files.map((f) => f.name).join(" + "), v.size, (v.changed || []).length])) });
    }
    const opts = [...game.versions].sort((a, b) => b.n - a.n).map((v) => `<option value="${v.id}">${v.id} · ${esc(short(v.label, 40))}</option>`).join("");
    const a = $("d-a").value, b = $("d-b").value;
    $("d-a").innerHTML = opts; $("d-b").innerHTML = opts;
    const ids = game.versions.map((v) => v.id);
    const newest = game.versions[game.versions.length - 1];
    $("d-b").value = ids.includes(b) ? b : newest ? newest.id : "";
    $("d-a").value = ids.includes(a) ? a : newest && newest.parent_exists ? newest.parent : ids[Math.max(0, ids.length - 2)] || "";
    $("g-diffcard").hidden = game.versions.length < 2;
  }

  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) copy(c.dataset.copy);
  });
  $("view-game").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("#g-del")) {
      if (!(await confirmBox(`Delete ${game.name}?`, `All ${game.versions.length} versions, the key files and the cover are deleted from disk. There is no trash.`, "Delete game"))) return;
      try { await api("DELETE", `/games/${enc(game.slug)}?confirm=${enc(game.slug)}`); toast(`Deleted ${game.name}`); game = null; await refreshLib(); go(""); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const dv = t.closest("[data-delv]");
    if (dv) {
      const v = game.versions.find((x) => x.id === dv.dataset.delv);
      const kids = (v.children || []).length;
      if (!(await confirmBox(`Delete ${v.id}?`, `“${v.label}”, ${v.files.length} file${v.files.length === 1 ? "" : "s"}, ${size(v.size)}.${kids ? ` Its ${kids} child version${kids === 1 ? " stays" : "s stay"} (marked “parent deleted”).` : ""} There is no trash.`, "Delete version"))) return;
      try { await api("DELETE", `/games/${enc(game.slug)}/versions/${v.id}?confirm=${v.id}`); toast(`Deleted ${v.id}`); await loadGame(game.slug); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const df = t.closest("[data-diff]");
    if (df) {
      const [a, b] = df.dataset.diff.split(",");
      $("d-a").value = a; $("d-b").value = b;
      await runDiff();
      $("g-diffcard").scrollIntoView({ block: "start" });
      return;
    }
    const dk = t.closest("[data-delkey]");
    if (dk) {
      if (!(await confirmBox(`Delete ${dk.dataset.delkey}?`, "The key file is deleted from the game's folder.", "Delete key"))) return;
      try { const r = await api("DELETE", `/games/${enc(game.slug)}/keys/${enc(dk.dataset.delkey)}`); setGame({ keys: r.keys }); }
      catch (err) { toast(err.message, true); }
    }
  });
  async function putGame(body, el) {
    try {
      const g = await api("PUT", `/games/${enc(game.slug)}`, body);
      const lk = g.lookup || {};
      delete g.lookup;
      game = g;
      renderGame();
      if (el) status(el, "Saved.", "ok");
      const issues = [lk.cover && lk.cover !== "ok" ? "cover: " + lk.cover : "", lk.pcgw && lk.pcgw !== "ok" ? "PCGamingWiki: " + lk.pcgw : ""].filter(Boolean);
      if (issues.length) toast(issues.join("; "), true);
      refreshLib();
      return true;
    } catch (err) {
      if (el) status(el, err.message, "err"); else toast(err.message, true);
      return false;
    }
  }
  $("n-save").addEventListener("click", () => {
    const name = $("n-name").value.trim();
    if (!name) return status($("n-status"), "A name is needed.", "err");
    putGame({ name, plugin: $("n-plugin").value, engine: $("n-engine").value.trim(), notes: $("n-notes").value, rules: $("n-rules").value }, $("n-status"));
  });
  $("g-cloud-ack").addEventListener("change", (e) => { if (e.target.checked) putGame({ steam_cloud_ack: true }); });
  $("n-cloud").addEventListener("change", (e) => putGame({ steam_cloud_ack: e.target.checked }));
  $("l-save").addEventListener("click", () => putGame({ install_dir: $("l-install").value.trim(), save_location: $("l-user").value.trim() }, $("l-status")));
  $("l-lookup").addEventListener("click", async () => {
    status($("l-status"), "Asking PCGamingWiki…");
    try {
      const g = await api("POST", `/games/${enc(game.slug)}/lookup`, { pcgw: true });
      const lk = g.lookup || {};
      delete g.lookup;
      game = g; renderGame();
      status($("l-status"), lk.pcgw === "ok" ? "Looked up." : lk.pcgw || "", lk.pcgw === "ok" ? "ok" : "err");
    } catch (err) { status($("l-status"), err.message, "err"); }
  });
  $("k-file").addEventListener("change", async (e) => {
    for (const f of [...e.target.files]) {
      if (f.size > (LIM.key_bytes || 1 << 20)) { toast(`${f.name}: a key file can be at most ${size(LIM.key_bytes || 1 << 20)}`, true); continue; }
      try { const r = await api("PUT", `/games/${enc(game.slug)}/keys/${enc(f.name)}`, undefined, { body: f }); setGame({ keys: r.keys }); toast(`Added ${f.name}`); }
      catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
    e.target.value = "";
  });
  // Steam match + cover on the game page
  async function gameSearch() {
    const q = $("s-q").value.trim();
    if (!q) return;
    try {
      const r = await steamSearch(q);
      renderPicks($("s-picks"), r, "s-pick", false);
      const extra = r.error ? `<p class="hint">Steam: ${esc(r.error)}${r.stale ? " (older results)" : ""}</p>` : r.results.length ? "" : `<p class="hint">No Steam match.</p>`;
      $("s-picks").insertAdjacentHTML("beforeend", extra + (r.results.length ? `<div class="row"><button class="btn small primary" type="button" id="s-use">Use this match</button>${game.steam_appid ? `<button class="btn small" type="button" id="s-clear">Clear the match</button>` : ""}</div>` : ""));
    } catch (err) { toast(err.message, true); }
  }
  $("s-go").addEventListener("click", gameSearch);
  $("s-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gameSearch(); } });
  $("s-picks").addEventListener("click", async (e) => {
    if (e.target.closest("#s-use")) {
      const pick = document.querySelector('input[name="s-pick"]:checked');
      if (!pick) return;
      toast("Saving the match… (Steam cover + PCGamingWiki, up to ~20 s)");
      if (await putGame({ steam_appid: Number(pick.value), steam_name: pick.dataset.name })) $("s-picks").innerHTML = "";
    } else if (e.target.closest("#s-clear")) {
      if (await putGame({ steam_appid: null, steam_name: "" })) $("s-picks").innerHTML = "";
    }
  });
  $("c-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > (LIM.cover_bytes || 5 << 20)) return toast(`A cover can be at most ${size(LIM.cover_bytes || 5 << 20)}`, true);
    try { setGame(await api("PUT", `/games/${enc(game.slug)}/cover`, undefined, { body: f, type: f.type })); refreshLib(); toast("Cover saved"); }
    catch (err) { toast(err.message, true); }
  });
  $("c-steam").addEventListener("click", async () => {
    try { const g = await api("POST", `/games/${enc(game.slug)}/lookup`, { pcgw: false, cover: true }); const lk = g.lookup || {}; delete g.lookup; setGame(g); refreshLib(); toast(lk.cover === "ok" ? "Cover from Steam" : "Cover: " + (lk.cover || "?"), lk.cover !== "ok"); }
    catch (err) { toast(err.message, true); }
  });
  $("c-del").addEventListener("click", async () => {
    if (!(await confirmBox("Remove the cover?", "The tile shows the rune instead.", "Remove"))) return;
    try { setGame(await api("DELETE", `/games/${enc(game.slug)}/cover`)); refreshLib(); }
    catch (err) { toast(err.message, true); }
  });

  // Upload a new original version
  let upFiles = [];
  async function takeFiles(list) {
    upFiles = await Promise.all([...list].map(readFile));
    const box = $("g-up-info");
    if (!upFiles.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="files">${upFiles.map((f) => `${esc(f.name)} <span class="muted">(${size(f.bytes.length)})</span>`).join(", ")}</div><div class="hint">Checking…</div>`;
    let info = "", det = null;
    try {
      const ctx = await ctxFor(game);
      const units = await openUnits(upFiles, ctx, game.plugin);
      const rts = [];
      for (const u of units) rts.push(await roundTrip(u, ctx));
      det = detectOf(units, rts);
      info = units.map((u, i) => `<div>${units.length > 1 ? `<b>${esc(u.name)}</b>: ` : ""}${u.doc ? `${esc(u.plugin.name)}, ${esc(integrityOf(u)[1])}, ${rts[i].ok ? '<span class="status ok">round trip OK</span>' : `<span class="status err">${esc(rts[i].text)}</span>`}` : `<span class="status err">${esc(u.error)}</span>`}</div>`).join("");
    } catch (e) { info = `<span class="status err">${esc(e.message)}</span>`; }
    upFiles.detect = det;
    const total = upFiles.reduce((n, f) => n + f.bytes.length, 0);
    box.innerHTML = `<div class="files">${upFiles.map((f) => `${esc(f.name)} <span class="muted">(${size(f.bytes.length)})</span>`).join(", ")} · ${size(total)}</div>${info}` +
      `<div class="two"><label class="lbl">Label <input class="field" id="up-label" maxlength="200" value="original"></label><label class="lbl">Note <input class="field" id="up-note" maxlength="2000" placeholder="optional"></label></div>` +
      `<div class="row"><span class="status" id="up-status"></span><button class="btn" type="button" id="up-cancel">Cancel</button><button class="btn primary" type="button" id="up-go">Upload as a new version</button></div>`;
  }
  $("g-files").addEventListener("change", (e) => { takeFiles(e.target.files); e.target.value = ""; });
  const drop = $("g-drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); takeFiles(e.dataTransfer.files); });
  $("g-up-info").addEventListener("click", async (e) => {
    if (e.target.closest("#up-cancel")) { upFiles = []; $("g-up-info").hidden = true; return; }
    if (!e.target.closest("#up-go")) return;
    const btn = e.target.closest("#up-go");
    btn.disabled = true;
    status($("up-status"), "Uploading…");
    try {
      const meta = { parent: null, label: $("up-label").value.trim() || "original", note: $("up-note").value.trim() };
      if (upFiles.detect) meta.detect = upFiles.detect;
      const v = await uploadVersion(game.slug, upFiles, meta);
      upFiles = [];
      $("g-up-info").hidden = true;
      toast(`Uploaded as ${v.id}`);
      await loadGame(game.slug);
      refreshLib();
    } catch (err) { status($("up-status"), err.message, "err"); btn.disabled = false; }
  });

  // Diff of two versions: decoded fields where a plugin reads both, raw bytes otherwise
  async function runDiff() {
    const out = $("d-out");
    const va = game.versions.find((v) => v.id === $("d-a").value), vb = game.versions.find((v) => v.id === $("d-b").value);
    if (!va || !vb) return;
    out.innerHTML = `<p class="hint">Decoding ${va.id} and ${vb.id}…</p>`;
    try {
      const ctx = await ctxFor(game);
      const [fa, fb] = [await versionFiles(game.slug, va), await versionFiles(game.slug, vb)];
      const [ua, ub] = [await openUnits(fa, ctx, game.plugin), await openUnits(fb, ctx, game.plugin)];
      const rows = [], notes = [];
      const multi = ua.length > 1 || ub.length > 1;
      for (const a of ua) {
        const b = ub.find((x) => x.name === a.name);
        if (!b) { notes.push(`${a.name}: only in ${va.id}`); continue; }
        if (a.doc && b.doc) {
          for (const d of M.diff(a.doc.root, b.doc.root)) rows.push({ path: (multi ? a.name + ": " : "") + d.path, before: d.before, after: d.after });
        } else {
          for (const f of a.files) {
            const g = b.files.find((x) => x.name === f.name);
            if (!g) notes.push(`${f.name}: only in ${va.id}`);
            else if (!M.equal(f.bytes, g.bytes)) notes.push(`${f.name}: bytes differ (${a.error || b.error || "not decoded"})`);
          }
        }
      }
      for (const b of ub) if (!ua.find((x) => x.name === b.name)) notes.push(`${b.name}: only in ${vb.id}`);
      const name = freshPager("diff");
      out.innerHTML = `<p class="hint">${rows.length ? `${rows.length.toLocaleString()} field${rows.length === 1 ? "" : "s"} differ` : "No decoded field differs"} between ${va.id} and ${vb.id}.${notes.length ? " " + notes.map(esc).join("; ") + "." : ""}</p>` +
        (rows.length ? `<table class="dtable"><colgroup><col class="c-p"><col><col></colgroup><thead><tr><th>Field</th><th>${va.id}</th><th>${vb.id}</th></tr></thead><tbody id="d-body"></tbody></table>` : "");
      if (rows.length) {
        Pager.rows({ name, items: rows, into: $("d-body"),
          render: (r) => `<tr><td class="p">${esc(r.path)}</td><td class="b">${esc(short(r.before, 200))}</td><td class="a">${esc(short(r.after, 200))}</td></tr>`,
          csv: () => [["field", va.id, vb.id]].concat(rows.map((r) => [r.path, show(r.before), show(r.after)])) });
      }
    } catch (err) { out.innerHTML = `<p class="status err">${esc(err.message)}</p>`; }
  }
  $("d-go").addEventListener("click", runDiff);

  // ---------------------------------------------------------------- editor
  const LIMIT = 200;   // children drawn per tree level before "show more"
  async function openEditor(slug, vid) {
    if (ed && ed.slug === slug && ed.vid === vid) return;
    if (!game || game.slug !== slug) await loadGame(slug);
    const v = game.versions.find((x) => x.id === vid);
    if (!v) { const e = new Error(`${vid} not found`); e.status = 404; throw e; }
    $("e-head").innerHTML = `<p class="hint">Opening ${esc(v.id)}…</p>`;
    $("e-tree").innerHTML = ""; $("e-quick").innerHTML = ""; $("e-results").hidden = true; $("e-q").value = "";
    views("edit");
    const ctx = await ctxFor(game);
    const files = await versionFiles(slug, v);
    ed = { slug, vid, v, ctx, files, units: [], rts: [], cur: 0, labelTouched: false };
    await loadUnits();
    document.title = `Edit ${v.id} · ${game.name} · Eitri`;
  }
  async function loadUnits() {
    ed.units = await openUnits(ed.files, ed.ctx, game.plugin);
    ed.rts = [];
    for (const u of ed.units) ed.rts.push(await roundTrip(u, ed.ctx));
    ed.cur = Math.max(0, ed.units.findIndex((u) => u.doc));
    ed.labelTouched = false;
    $("e-label").value = ""; $("e-note").value = "";
    status($("e-status"), "");
    renderEditor();
  }
  const unit = () => ed.units[ed.cur];
  const netChanges = (u) => {
    if (!u.doc) return [];
    const m = new Map();
    for (const c of u.doc.changes || []) {
      const k = M.pathStr(c.path), e = m.get(k);
      if (e) { e.after = c.after; e.linked = e.linked && c.linked; } else m.set(k, { path: c.path, before: c.before, after: c.after, linked: !!c.linked, rule: c.rule });
    }
    return [...m.values()].filter((c) => show(c.before) !== show(c.after));
  };
  const dirtyUnits = () => (ed ? ed.units.filter((u) => netChanges(u).length) : []);
  function allChanges() {
    const multi = ed.units.length > 1;
    return ed.units.flatMap((u) => netChanges(u).map((c) => Object.assign({}, c, { path: multi ? [u.name].concat(c.path) : c.path })));
  }
  function renderEditor() {
    const u = unit(), v = ed.v;
    const checks = ed.units.map((x, i) => {
      const rt = ed.rts[i];
      const pre = ed.units.length > 1 ? `<b>${esc(x.name)}</b>: ` : "";
      return x.doc ? `<span class="${rt.ok ? "ok" : "bad"}">${pre}Round trip: ${esc(rt.text)}${rt.ok ? "" : " (export is off for this file)"}</span>` : `<span class="bad">${pre}${esc(x.error)}</span>`;
    });
    const d = u.doc;
    const notes = [];
    if (u.plugin && u.plugin.status === "untested") notes.push(`<span class="warn">${esc(u.plugin.name)} is untested: re-encoding is valid but not checked against a real save.</span>`);
    if (d && d.untested) notes.push(`<span class="warn">${esc(d.untested)}</span>`);
    if (d && d.warning) notes.push(`<span class="warn">${esc(d.warning)}</span>`);
    if (d && d.note) notes.push(`<span>${esc(d.note)}</span>`);
    if (d && d.rules && d.rules.length) notes.push(`<span>Game rules: ${d.rules.map((r) => `<b>${esc(r.game)}</b>${r.notes ? " (" + esc(r.notes) + ")" : ""}`).join("; ")}</span>`);
    if (u.plugin && u.plugin.needsKey && !Object.keys(ed.ctx.keys).length) notes.push(`<span class="warn">Needs ${esc(u.plugin.needsKey)}: add it under Key files on the game page.</span>`);
    const units = ed.units.length > 1 ? `<div class="units">${ed.units.map((x, i) => `<button class="btn small" type="button" data-unit="${i}" aria-pressed="${i === ed.cur}"${x.doc ? "" : " disabled"}>${esc(x.name)}${netChanges(x).length ? " •" : ""}</button>`).join("")}</div>` : "";
    $("e-head").innerHTML = `<div class="ehead"><div class="crumbs"><a class="btn small" href="#g=${enc(ed.slug)}">‹ ${esc(game.name)}</a>` +
      `<h2>Edit ${esc(v.id)} · ${esc(v.label)}</h2></div>` +
      `<div class="facts"><span>${esc(when(v.created, v.created_text))}</span><span>${v.files.map((f) => esc(f.name)).join(", ")}</span>${u.plugin ? `<span class="badge rc">${esc(u.plugin.name)}</span>` : ""}${d ? `<span class="badge ${integrityOf(u)[0] === "ok" ? "ok" : integrityOf(u)[0] === "bad" ? "bad" : ""}">${esc(integrityOf(u)[1])}</span>` : ""}</div>` +
      units + `<div class="checks">${checks.join("")}${notes.join("")}</div></div>`;
    renderQuick();
    renderTree();
    renderChanges();
    if ($("e-q").value.trim()) runSearch();
  }
  function inputFor(node, path) {
    const p = esc(JSON.stringify(path));
    const v = node.value;
    if (node.kind === "bool") return `<select class="field" data-p="${p}"><option${v === true ? " selected" : ""}>true</option><option${v === false ? " selected" : ""}>false</option></select>`;
    return `<input class="field" data-p="${p}" value="${esc(show(v))}" spellcheck="false"${node.kind === "number" ? ' inputmode="decimal"' : ""}>`;
  }
  const editable = (node) => node && !node.children && node.editable && ["string", "number", "bool", "null"].includes(node.kind);
  function leafHTML(label, node, path) {
    const val = editable(node) ? inputFor(node, path) : `<span class="v">${esc(short(node.value, 140))}</span>`;
    return `<div class="leaf">${pinBtn(path)}<span class="k" title="${esc(M.pathStr(path))}">${esc(label)}</span>${val}${node.note ? `<span class="nt">${esc(node.note)}</span>` : ""}</div>`;
  }

  // Pins: any field can be pinned to Quick fields under the user's own name (game.pins, saved per game on the
  // server). A pin's file is the unit name in a multi-file version, "" otherwise (then it applies to any file).
  // A list index in the path is anchored by the entry's own name (match: FirstCodeName = Consume_Throw_Gear), so
  // in another version the pin follows the item, not the position; no anchor = "by position", shown as such.
  const pinKey = (path) => JSON.stringify(path);
  const pinFile = (u) => (ed.units.length > 1 ? u.name : "");
  const pinApplies = (u, p) => !p.file || p.file === pinFile(u);
  const ANCHOR = /(^|_)(id|key|name|code|codename|guid|uid|type)$|[a-z](Id|ID|Key|Name|CodeName|Guid|Type)$/;
  function anchorOf(el) {
    // the first child of a list entry that names it: a short non-empty text (or id number) under an id/name-like key
    if (!el || !el.children) return null;
    const leaves = el.children.filter((c) => !c.node.children && ANCHOR.test(String(c.key)));
    // a text name first (FirstCodeName, character_id, _name), else a number id (UniqueId)
    const txt = leaves.find((c) => c.node.kind === "string" && typeof c.node.value === "string" && c.node.value && c.node.value !== "None" && c.node.value.length <= 200);
    const num = leaves.find((c) => c.node.kind === "number" && /id$/i.test(String(c.key)) && String(c.node.value) !== "-1");
    const c = txt || num;
    return c ? { key: String(c.key), value: String(c.node.value) } : null;
  }
  function matchFor(root, path) {
    const out = [];
    for (let i = 0; i < path.length; i++) {
      if (typeof path[i] !== "number") continue;
      let el;
      try { el = M.findNode(root, path.slice(0, i + 1)); } catch (e) { continue; }
      const a = anchorOf(el);
      if (a) out.push({ at: i, key: a.key, value: a.value });
    }
    return out;
  }
  // -> {path, state: "ok" | "moved" | "missing" | "byPosition"}; path is where the pin points in this unit
  function resolvePin(u, p) {
    const path = p.path.slice();
    let state = p.path.some((k, i) => typeof k === "number" && !(p.match || []).some((m) => m.at === i)) ? "byPosition" : "ok";
    for (const m of p.match || []) {
      let list;
      try { list = M.findNode(u.doc.root, path.slice(0, m.at)); } catch (e) { return { path, state: "missing" }; }
      if (!list || !list.children) return { path, state: "missing" };
      const hit = (c) => c.node.children && c.node.children.some((x) => String(x.key) === m.key && !x.node.children && String(x.node.value) === m.value);
      const here = list.children.find((c) => c.key === path[m.at]);
      if (here && hit(here)) continue;
      const found = list.children.find(hit);
      if (!found) return { path, state: "missing" };
      path[m.at] = found.key;
      if (state === "ok") state = "moved";
    }
    try { M.findNode(u.doc.root, path); } catch (e) { return { path, state: "missing" }; }
    return { path, state };
  }
  const pinIndexAt = (u, path) => (game.pins || []).findIndex((p) => pinApplies(u, p) && u.doc && pinKey(resolvePin(u, p).path) === pinKey(path));
  function pinBtn(path) {
    const on = pinIndexAt(unit(), path) >= 0;
    return `<button class="pin${on ? " on" : ""}" type="button" data-pin="${esc(pinKey(path))}" aria-pressed="${on}" title="${on ? "Unpin from" : "Pin to"} Quick fields">${on ? "★" : "☆"}</button>`;
  }
  function refreshPins() {
    for (const b of $("view-edit").querySelectorAll(".leaf [data-pin]")) {
      const on = pinIndexAt(unit(), JSON.parse(b.dataset.pin)) >= 0;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.title = `${on ? "Unpin from" : "Pin to"} Quick fields`;
      b.textContent = on ? "★" : "☆";
    }
  }
  function quickList(u) {
    let qf = [];
    try { qf = u.doc ? M.quickFields(u.doc) : []; } catch (e) { qf = []; }
    const pins = u.doc ? (game.pins || []).map((p, i) => ({ p, i })).filter(({ p }) => pinApplies(u, p)) : [];
    const items = pins.map(({ p, i }) => { const r = resolvePin(u, p); return { label: p.label, path: r.path, state: r.state, pin: p, idx: i }; });
    const pinned = new Set(items.filter((q) => q.state !== "missing").map((q) => pinKey(q.path)));
    return items.concat(qf.filter((q) => !pinned.has(pinKey(q.path))));
  }
  function renderQuick() {
    const u = unit();
    $("e-quickcard").hidden = !u.doc;
    const items = quickList(u);
    $("e-pinhint").hidden = items.some((q) => q.pin);
    $("e-quick").innerHTML = items.map((q) => {
      let node = null;
      if (q.state !== "missing") { try { node = M.findNode(u.doc.root, q.path); } catch (e) { node = null; } }
      if (!q.pin) return node ? `<label>${esc(q.label)}${editable(node) ? inputFor(node, q.path) : `<span class="v">${esc(short(node.value))}</span>`}</label>` : "";
      const anchors = (q.pin.match || []).map((m) => `${m.key} = ${m.value}`).join(", ");
      const where = { ok: anchors ? `follows ${anchors}` : "", moved: `follows ${anchors} (moved to ${M.pathStr(q.path)} in this version)`,
        byPosition: "by position: in another version this entry may be a different item",
        missing: anchors ? `${anchors} is not in this version` : "not in this version" }[q.state];
      const body = node ? (editable(node) ? inputFor(node, q.path) : `<span class="v">${esc(short(node.value))}</span>`) : `<span class="v">—</span>`;
      return `<div class="qpin${q.state === "missing" ? " gone" : ""}"><span class="qhead"><span class="ql">${esc(q.label)}</span>` +
        `<button class="ibtn" type="button" data-rename="${q.idx}" title="Rename" aria-label="Rename ${esc(q.label)}">✎</button>` +
        `<button class="ibtn" type="button" data-unpin="${q.idx}" title="Unpin" aria-label="Unpin ${esc(q.label)}">×</button></span>` +
        `<span class="qp mono" title="${esc(M.pathStr(q.path))}">${esc(M.pathStr(q.pin.path))}</span>` + body +
        (where ? `<span class="qw${q.state === "ok" || q.state === "moved" ? "" : " warn"}">${esc(where)}</span>` : "") + `</div>`;
    }).join("");
  }
  $("view-edit").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pin], [data-unpin], [data-rename]");
    if (!b || !ed) return;
    e.preventDefault();
    const u = unit();
    const pins = (game.pins || []).slice();
    if (b.dataset.pin) {
      const path = JSON.parse(b.dataset.pin);
      const i = pinIndexAt(u, path);
      if (i >= 0) pins.splice(i, 1);
      else {
        const label = await promptBox("Pin to Quick fields", `Name to show for ${M.pathStr(path) || "(value)"}`, nameOf(path, []), "Pin");
        if (!label) return;
        pins.push({ path, label: label.slice(0, 100), file: pinFile(u), match: matchFor(u.doc.root, path) });
      }
    } else {
      const i = +(b.dataset.unpin ?? b.dataset.rename);
      if (!pins[i]) return;
      if (b.dataset.unpin !== undefined) pins.splice(i, 1);
      else {
        const label = await promptBox("Rename pinned field", `Name to show for ${M.pathStr(pins[i].path)}`, pins[i].label, "Rename");
        if (!label) return;
        pins[i] = Object.assign({}, pins[i], { label: label.slice(0, 100) });
      }
    }
    try {
      const g = await api("PUT", `/games/${enc(game.slug)}`, { pins });
      game.pins = g.pins;
    } catch (err) { toast(err.message, true); return; }
    renderQuick();
    refreshPins();
    markChanged();
    renderChanges();
  });
  function itemHTML(key, node, path) {
    if (!node.children) return `<li>${leafHTML(typeof key === "number" ? `[${key}]` : key, node, path)}</li>`;
    const n = node.children.length;
    return `<li><button class="tg" type="button" aria-expanded="false" data-tp="${esc(JSON.stringify(path))}"><span class="k">${esc(typeof key === "number" ? `[${key}]` : key)}</span> ` +
      `<span class="cnt">${node.kind === "array" ? `[${n}]` : `{${n}}`}</span>${node.note ? ` <span class="nt">${esc(node.note)}</span>` : ""}</button></li>`;
  }
  function childrenHTML(node, path, from = 0) {
    const kids = node.children.slice(from, from + LIMIT);
    const more = node.children.length > from + LIMIT
      ? `<li><button class="btn small more-btn" type="button" data-more="${esc(JSON.stringify(path))}" data-from="${from + LIMIT}">Show ${Math.min(LIMIT, node.children.length - from - LIMIT)} more of ${node.children.length - from - LIMIT}</button></li>` : "";
    return kids.map((c) => itemHTML(c.key, c.node, path.concat([c.key]))).join("") + more;
  }
  function renderTree() {
    const u = unit();
    if (!u.doc) { $("e-tree").innerHTML = `<p class="status err">${esc(u.error || "not decoded")}</p>`; $("e-fcount").textContent = ""; return; }
    if (!u.leafCount) u.leafCount = M.leaves(u.doc.root).length;
    $("e-fcount").textContent = `${u.leafCount.toLocaleString()} values`;
    const root = u.doc.root;
    $("e-tree").innerHTML = root.children ? `<ul>${childrenHTML(root, [])}</ul>` : `<ul><li>${leafHTML("(value)", root, [])}</li></ul>`;
    markChanged();
  }
  $("e-tree").addEventListener("click", (e) => {
    const tg = e.target.closest(".tg");
    const mo = e.target.closest("[data-more]");
    const u = unit();
    if (tg) {
      const open = tg.getAttribute("aria-expanded") === "true";
      if (open) { tg.nextElementSibling?.remove(); tg.setAttribute("aria-expanded", "false"); return; }
      const path = JSON.parse(tg.dataset.tp);
      const ul = document.createElement("ul");
      ul.innerHTML = childrenHTML(M.findNode(u.doc.root, path), path);
      tg.after(ul);
      tg.setAttribute("aria-expanded", "true");
      markChanged(ul);
    } else if (mo) {
      const path = JSON.parse(mo.dataset.more);
      const li = mo.closest("li");
      li.insertAdjacentHTML("afterend", childrenHTML(M.findNode(u.doc.root, path), path, +mo.dataset.from));
      const ul = li.parentElement;
      li.remove();
      markChanged(ul);
    }
  });
  let searchTimer = 0;
  function runSearch() {
    const q = $("e-q").value.trim();
    const u = unit();
    const box = $("e-results");
    if (!q || !u.doc) { box.hidden = true; $("e-tree").hidden = false; document.querySelectorAll('.pager[data-for^="matches"]').forEach((x) => x.remove()); return; }
    const hits = M.search(u.doc.root, q);
    $("e-tree").hidden = true;
    box.hidden = false;
    const name = freshPager("matches");
    if (!hits.length) { box.innerHTML = `<p class="hint">Nothing matches “${esc(q)}”.</p>`; return; }
    box.innerHTML = `<p class="hint">${hits.length.toLocaleString()} match${hits.length === 1 ? "" : "es"}</p><div id="e-hits"></div>`;
    Pager.rows({ name, items: hits, into: $("e-hits"),
      render: (h) => { let node; try { node = M.findNode(u.doc.root, h.path); } catch (e) { return ""; } return leafHTML(M.pathStr(h.path) || "(value)", node, h.path); },
      csv: () => [["field", "kind", "value"]].concat(hits.map((h) => [M.pathStr(h.path), h.kind, show(h.value)])) });
    markChanged(box);
    // Pager redraws on Newer/Older; mark the new rows too
    box.querySelector(".pager")?.addEventListener("click", () => markChanged(box));
  }
  $("e-q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
  $("e-head").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unit]");
    if (!b) return;
    ed.cur = +b.dataset.unit;
    renderEditor();
  });

  // Edits: every input with data-p is a field; the value goes through Eitri.edit so game rules update linked fields
  function parseFor(node, raw) {
    if (node.kind === "bool") return raw === "true";
    if (node.kind === "null" && raw.trim() === "null") return null;
    if (node.kind === "number") return raw.trim();
    return raw;
  }
  $("view-edit").addEventListener("change", (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.p) return;
    const u = unit();
    const path = JSON.parse(el.dataset.p);
    const node = M.findNode(u.doc.root, path);
    const value = parseFor(node, el.value);
    if (show(value) === show(u.doc.get(path))) return;
    try { M.edit(u.doc, path, value); }
    catch (err) { toast(err.message, true); el.value = show(u.doc.get(path)); return; }
    renderChanges();
    markChanged();
  });
  function markChanged(scope) {
    const u = unit();
    if (!u.doc) return;
    const changed = new Set(netChanges(u).map((c) => M.pathStr(c.path)));
    for (const el of (scope || $("view-edit")).querySelectorAll("[data-p]")) {
      const path = JSON.parse(el.dataset.p);
      let v;
      try { v = u.doc.get(path); } catch (e) { continue; }
      el.value = el.tagName === "SELECT" ? String(v) : show(v);
      el.classList.toggle("changed", changed.has(M.pathStr(path)));
    }
  }
  function nameOf(path, qf) {
    const q = qf.find((x) => M.pathStr(x.path) === M.pathStr(path));
    if (q) return q.label.toLowerCase();
    const k = [...path].reverse().find((x) => typeof x === "string") ?? path[path.length - 1];
    return String(k).replace(/^store\./, "").replace(/^_+/, "").replace(/_[0-9A-F]{32}$/, "").replace(/_\d+$/, "") || String(k);
  }
  function autoLabel() {
    const parts = [];
    for (const u of ed.units) {
      const qf = quickList(u);
      for (const c of netChanges(u)) if (!c.linked) parts.push(`${nameOf(c.path, qf)} ${short(c.before, 24)} -> ${short(c.after, 24)}`);
    }
    let s = parts.length > 3 ? parts.slice(0, 2).join(", ") + `, +${parts.length - 2} more` : parts.join(", ");
    if (s.length > 200) s = s.slice(0, 199) + "…";
    return s || "edit";
  }
  function renderChanges() {
    const all = allChanges();
    $("e-chlist").innerHTML = all.length ? `<p class="hint">${all.length} field${all.length === 1 ? "" : "s"}${all.some((c) => c.linked) ? `, linked ones updated by the game rule` : ""}:</p>` + changeList(all, 200, 40)
      : `<p class="hint">Nothing changed yet.</p>`;
    if (!ed.labelTouched) $("e-label").value = all.length ? autoLabel() : "";
    const blocked = ed.units.some((u, i) => netChanges(u).length && !ed.rts[i].ok);
    $("e-export").disabled = !all.length || blocked;
    $("e-export").title = blocked ? "A changed file failed the round-trip self-check" : "";
    $("e-head").querySelectorAll("[data-unit]").forEach((b) => { const x = ed.units[+b.dataset.unit]; b.textContent = x.name + (netChanges(x).length ? " •" : ""); });
  }
  $("e-label").addEventListener("input", () => { ed.labelTouched = !!$("e-label").value.trim(); });
  $("e-reset").addEventListener("click", async () => {
    if (!dirtyUnits().length) return;
    if (!(await confirmBox("Undo all changes?", "The save is opened again from the stored version.", "Undo all"))) return;
    await loadUnits();
  });

  // Export: encode, then self-check 2 (re-open: only the intended + linked fields may differ), then upload as a
  // child version and download it from the server (the stored bytes, under the exact original names)
  $("e-export").addEventListener("click", async () => {
    const btn = $("e-export");
    btn.disabled = true;
    const st = $("e-status");
    status(st, "Encoding and checking…");
    try {
      const out = new Map(ed.files.map((f) => [f.name, f.bytes]));
      const after = [];
      for (const u of ed.units) {
        const net = netChanges(u);
        if (!net.length) { after.push(u); continue; }
        const encd = await u.plugin.encode(u.doc, ed.ctx);
        const re = await M.open(encd, ed.ctx, u.plugin.id);
        const orig = await M.open(u.files, ed.ctx, u.plugin.id);
        const allowed = new Set(net.map((c) => M.pathStr(c.path)));
        const extra = M.diff(orig.root, re.root).filter((d) => !allowed.has(d.path));
        const missing = net.filter((c) => { try { return show(re.get(c.path)) !== show(c.after); } catch (e) { return true; } });
        if (extra.length || missing.length) {
          throw new Error(`${u.name}: self-check failed. ` + (extra.length ? `Unexpected changes: ${extra.slice(0, 5).map((d) => d.path).join(", ")}${extra.length > 5 ? "…" : ""}. ` : "") +
            (missing.length ? `Didn't read back: ${missing.slice(0, 5).map((c) => M.pathStr(c.path)).join(", ")}.` : ""));
        }
        for (const f of encd) out.set(f.name, f.bytes);
        after.push({ name: u.name, files: encd, plugin: u.plugin, doc: re });
      }
      const files = ed.v.files.map((f) => ({ name: f.name, bytes: out.get(f.name) }));
      const changed = allChanges().slice(0, LIM.changed || 5000).map((c) => ({ path: c.path, before: short(c.before, 1000), after: short(c.after, 1000), linked: c.linked, ...(c.rule ? { rule: c.rule } : {}) }));
      const det = detectOf(after, after.map(() => ({ ok: true })));
      status(st, "Saving the new version…");
      const nv = await uploadVersion(ed.slug, files, { parent: ed.vid, label: $("e-label").value.trim() || autoLabel(), detect: det || undefined, changed, note: $("e-note").value.trim() });
      const url = nv.files.length > 1 ? `${API}/games/${enc(ed.slug)}/versions/${nv.id}/zip` : `${API}/games/${enc(ed.slug)}/versions/${nv.id}/files/${enc(nv.files[0].name)}`;
      download(url, nv.files.length > 1 ? "" : nv.files[0].name);
      toast(`Saved as ${nv.id} and downloaded. Game closed and Steam Cloud off before you copy it in.`);
      ed = null;
      await loadGame(game.slug);
      refreshLib();
      go("#g=" + enc(game.slug));
      const row = document.querySelector(`.vrow[data-vid="${nv.id}"]`);
      if (row) row.classList.add("fresh");
    } catch (err) {
      status(st, err.message, "err");
      btn.disabled = false;
    }
  });

  route();
})();
