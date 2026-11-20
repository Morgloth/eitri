// Shared page helpers.
(() => {
  // Search boxes: a clear (✕) button while there's text, and Escape to clear.
  for (const input of document.querySelectorAll('input[type="search"]')) {
    const wrap = document.createElement("span");
    wrap.className = "searchwrap " + input.className.replace(/\bfield\b/, "").trim();
    input.classList.remove("search");
    input.before(wrap);
    wrap.append(input);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-clear";
    btn.setAttribute("aria-label", "Clear search");
    btn.title = "Clear search";
    btn.textContent = "✕";
    wrap.append(btn);

    const sync = () => { btn.hidden = input.value === ""; };
    const clear = () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    };
    btn.addEventListener("click", clear);
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) { e.preventDefault(); clear(); }
    });
    sync();
  }

  // Long lists: `size` at a time with Newer/Older (lists are newest first), plus Export CSV of every item.
  // Pager.rows keeps the items as data and puts only the current page in the DOM; Pager.attach pages elements
  // that already exist (only for short lists of heavy items, e.g. ISP close-ups). Pages rebuild their lists
  // on refresh, so call either again after each render; the page you were on is kept by name.
  const at = {};
  const cell = (v) => {
    v = String(v ?? "").replace(/\s+/g, " ").trim();
    return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  function download(name, rows) {
    const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${name}-${new Date().toLocaleDateString("sv-SE")}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // The Newer/Older/Export bar; showPage(p) draws page p
  function bar({ name, count, after, csv, size, showPage }) {
    document.querySelector(`.pager[data-for="${name}"]`)?.remove();
    if (!count) { showPage(0); return; }  // an emptied list must not keep the last page's rows
    const pages = Math.ceil(count / size);
    const el = document.createElement("div");
    el.className = "pager";
    el.dataset.for = name;
    el.innerHTML = (pages > 1 ? `<button type="button" class="btn small" data-go="-1">‹ Newer</button><span class="pos"></span>` +
      `<button type="button" class="btn small" data-go="1">Older ›</button>` : `<span class="pos"></span>`) +
      `<button type="button" class="btn small export">Export CSV</button>`;
    const show = () => {
      const p = (at[name] = Math.max(0, Math.min(pages - 1, at[name] || 0)));
      showPage(p);
      el.querySelector(".pos").textContent = `${p * size + 1}–${Math.min(count, (p + 1) * size)} of ${count.toLocaleString()}`;
      el.querySelectorAll("[data-go]").forEach((b) => { b.disabled = +b.dataset.go < 0 ? p === 0 : p === pages - 1; });
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("export")) return download(name, csv());
      at[name] = (at[name] || 0) + +b.dataset.go;
      show();
    });
    after.after(el);
    show();
  }
  // items: data; into: the element (a <tbody>) that gets render(item) for the current page;
  // csv: () => rows, the first row being the header
  function rows({ name, items, into, render, csv, size = 20 }) {
    bar({ name, count: items.length, after: into.closest("div.table-wrap") || into.closest("table") || into, csv, size,
      showPage: (p) => { into.innerHTML = items.slice(p * size, (p + 1) * size).map(render).join(""); } });
  }
  function attach({ name, items, after, csv, size = 20 }) {
    bar({ name, count: items.length, after, csv, size,
      showPage: (p) => items.forEach((el, i) => { el.hidden = i < p * size || i >= (p + 1) * size; }) });
  }
  window.Pager = { rows, attach };
})();
