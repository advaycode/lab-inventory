/* ============================================================================
   LabInventory - app.js   (user side)

   Boot order:
     1. theme
     2. catalog: API if configured, seed JSON otherwise (CONTRACT 7.2)
     3. index + tree (store.js)
     4. route from the URL hash, render
   Nothing here calls fetch. Everything network-shaped goes through api.js.
   ========================================================================== */

import * as api from "./api.js";
import { store, loadCatalog, loadCategories, search, categoryBySlug, imageFor,
         getPartLocal } from "./store.js";
import { SITE_TITLE, PAGE_SIZE, SEARCH_DEBOUNCE, COMBO_LIMIT, TEAMS, teamLabel } from "./config.js";

/* -------------------------------------------------------------------------- */
/* tiny helpers                                                                */
/* -------------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function icon(id, cls = "icon") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const todayISO = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* -------------------------------------------------------------------------- */
/* toasts                                                                      */
/* -------------------------------------------------------------------------- */

const toasts = $("#toasts");
function toast(message, kind = "ok", ms = 5000) {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .2s, transform .2s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* -------------------------------------------------------------------------- */
/* theme                                                                       */
/* -------------------------------------------------------------------------- */

const THEME_KEY = "labinv.theme";
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", mode === "light" ? "#fbf8f8" : "#0e0b0a");
  const next = mode === "light" ? "dark" : "light";
  const label = `Switch to ${next} theme`;
  const btn = $("#themeBtn");
  if (btn) { btn.title = label; const l = $("#themeLabel"); if (l) l.textContent = label; }
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode */ }
}
function initTheme() {
  let mode = "dark";                       // CONTRACT 6: dark is the default
  try { mode = localStorage.getItem(THEME_KEY) || "dark"; } catch { /* ignore */ }
  applyTheme(mode === "light" ? "light" : "dark");
  $("#themeBtn")?.addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
  });
}

/* -------------------------------------------------------------------------- */
/* app state                                                                   */
/* -------------------------------------------------------------------------- */

const state = {
  query: "",
  category: "",
  availableOnly: false,
  results: [],
  online: false,      // backend reachable and configured
  readOnly: true,     // no submitting until we know the backend is there
};

/* -------------------------------------------------------------------------- */
/* banner (CONTRACT 7.2)                                                       */
/* -------------------------------------------------------------------------- */

function showBanner(kind, title, body, action = null) {
  const slot = $("#bannerSlot");
  slot.innerHTML = `
    <div class="banner ${kind === "quiet" ? "banner--quiet" : ""}" role="status">
      <div class="banner__body"><strong>${esc(title)}</strong> ${esc(body)}</div>
      ${action ? `<button class="btn btn--sm" type="button" id="bannerAct">${esc(action.label)}</button>` : ""}
    </div>`;
  if (action) $("#bannerAct").addEventListener("click", action.onClick);
}

/* -------------------------------------------------------------------------- */
/* routing: #/  #/c/<slug>  with ?q= and ?p=                                    */
/* -------------------------------------------------------------------------- */

function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const m = /^\/c\/([^/]+)/.exec(path || "");
  return {
    category: m ? decodeURIComponent(m[1]) : "",
    query: params.get("q") || "",
    part: params.get("p") || "",
  };
}

let suppressHash = false;
function writeHash({ category = state.category, query = state.query, part = "" } = {}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (part) params.set("p", part);
  const qs = params.toString();
  const next = `#${category ? `/c/${encodeURIComponent(category)}` : "/"}${qs ? `?${qs}` : ""}`;
  if (next === location.hash) return;
  suppressHash = true;
  history.replaceState(null, "", next);
  suppressHash = false;
}

function applyRoute() {
  const r = parseHash();
  state.category = r.category;
  state.query = r.query;
  const input = $("#q");
  if (input.value !== r.query) input.value = r.query;
  $("#searchWrap").classList.toggle("is-filled", !!r.query);
  runSearch();
  if (r.part) {
    const p = getPartLocal(r.part);
    if (p) openDetail(p, { fromHash: true });
  }
}

/* -------------------------------------------------------------------------- */
/* sidebar                                                                     */
/* -------------------------------------------------------------------------- */

const EXPAND_KEY = "labinv.open-cats";
function readExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || "[]")); }
  catch { return new Set(); }
}
function writeExpanded(set) {
  try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

function renderSidebar() {
  const nav = $("#catNav");
  const expanded = readExpanded();
  const total = store.parts.length;

  let html = `
    <div class="cat"><div class="cat__row">
      <a class="cat__link" href="#/" data-slug="">
        <span class="cat__name">All parts</span>
        <span class="cat__count">${total}</span>
      </a>
    </div></div>`;

  for (const b of store.tree) {
    const slug = b.node.slug;
    const open = expanded.has(slug);
    const kidsId = `kids-${slug}`;
    html += `<div class="cat">
      <div class="cat__row">
        <a class="cat__link" href="#/c/${encodeURIComponent(slug)}" data-slug="${esc(slug)}">
          <span class="cat__name">${esc(b.node.name)}</span>
          <span class="cat__count">${b.count}</span>
        </a>
        ${b.children.length ? `
        <button class="cat__toggle" type="button" aria-expanded="${open}" aria-controls="${kidsId}">
          <span class="u-sr">${open ? "Collapse" : "Expand"} ${esc(b.node.name)}</span>
          ${icon("i-chev")}
        </button>` : ""}
      </div>
      ${b.children.length ? `
      <div class="cat__kids" id="${kidsId}" ${open ? "" : "hidden"}>
        ${b.children.map((c) => `
          <div class="cat__row">
            <a class="cat__link" href="#/c/${encodeURIComponent(c.node.slug)}" data-slug="${esc(c.node.slug)}">
              <span class="cat__name">${esc(c.node.name)}</span>
              <span class="cat__count">${c.count}</span>
            </a>
          </div>`).join("")}
      </div>` : ""}
    </div>`;
  }
  nav.innerHTML = html;
  markActiveCategory();
}

function markActiveCategory() {
  for (const a of $("#catNav").querySelectorAll(".cat__link")) {
    const on = (a.dataset.slug || "") === state.category;
    if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
  }
}

function wireSidebar() {
  $("#catNav").addEventListener("click", (e) => {
    const toggle = e.target.closest(".cat__toggle");
    if (toggle) {
      const kids = document.getElementById(toggle.getAttribute("aria-controls"));
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      kids.hidden = open;
      const set = readExpanded();
      const slug = toggle.closest(".cat").querySelector(".cat__link").dataset.slug;
      if (open) set.delete(slug); else set.add(slug);
      writeExpanded(set);
      return;
    }
    const link = e.target.closest(".cat__link");
    if (!link) return;
    e.preventDefault();
    state.category = link.dataset.slug || "";
    writeHash({ category: state.category, query: state.query });
    markActiveCategory();
    runSearch();
    if (isMobile()) closeSheet();
    $("#main").scrollTop = 0;
    window.scrollTo({ top: 0 });
  });

  const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
  const sheet = $("#sidebar");
  const btn = $("#catsBtn");

  function openSheet() {
    sheet.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", sheetKeys);
    document.addEventListener("pointerdown", sheetOutside, true);
  }
  function closeSheet() {
    if (!isMobile()) return;
    sheet.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", sheetKeys);
    document.removeEventListener("pointerdown", sheetOutside, true);
  }
  const sheetKeys = (e) => { if (e.key === "Escape") { closeSheet(); btn.focus(); } };
  const sheetOutside = (e) => {
    if (!sheet.contains(e.target) && !btn.contains(e.target)) closeSheet();
  };

  btn.addEventListener("click", () => {
    if (sheet.hidden) openSheet(); else { closeSheet(); }
  });

  // the sheet is a fixed overlay only under 900px; above that it is a rail
  const mq = window.matchMedia("(max-width: 900px)");
  const sync = () => { sheet.hidden = mq.matches; btn.setAttribute("aria-expanded", "false"); };
  mq.addEventListener("change", sync);
  sync();

  window.__closeSheet = closeSheet;
}

/* -------------------------------------------------------------------------- */
/* virtual grid                                                                */
/*                                                                             */
/* Only the rows intersecting the viewport (plus two rows of buffer) exist in   */
/* the DOM. With 2,400 results that is ~30 nodes rather than 2,400. Cards are   */
/* pooled and reused, so scrolling allocates nothing.                          */
/* -------------------------------------------------------------------------- */

function createGrid(vp, onOpen) {
  const live = new Map();   // item position -> element
  const free = [];
  let items = [];
  let cols = 1, colW = 0, cardH = 268, gap = 12, cardMin = 212;
  let frame = 0;

  function readMetrics() {
    const cs = getComputedStyle(document.documentElement);
    cardH = parseFloat(cs.getPropertyValue("--card-h")) || 268;
    gap = parseFloat(cs.getPropertyValue("--grid-gap")) || 12;
    cardMin = parseFloat(cs.getPropertyValue("--card-min")) || 212;
  }

  function makeCard() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "card";
    el.setAttribute("role", "listitem");
    el.innerHTML = `
      <span class="card__img">
        <span class="card__ph">${icon("i-box")}</span>
        <img alt="" loading="lazy" decoding="async" hidden>
      </span>
      <span class="card__name"></span>
      <span class="card__sku mono"></span>
      <span class="avail"><span class="avail__n"></span><span class="avail__lbl"></span></span>
      <span class="bar"><i></i></span>`;
    el.__refs = {
      img: el.querySelector("img"),
      ph: el.querySelector(".card__ph"),
      name: el.querySelector(".card__name"),
      sku: el.querySelector(".card__sku"),
      n: el.querySelector(".avail__n"),
      lbl: el.querySelector(".avail__lbl"),
      bar: el.querySelector(".bar > i"),
    };
    el.addEventListener("click", () => {
      const p = store.parts[el.__idx];
      if (p) onOpen(p);
    });
    return el;
  }

  function fill(el, partIdx) {
    const p = store.parts[partIdx];
    const r = el.__refs;
    el.__idx = partIdx;
    r.name.textContent = p.name;
    r.sku.textContent = p.sku;
    const out = p.qtyAvailable <= 0;
    el.classList.toggle("is-out", out);
    r.n.textContent = String(p.qtyAvailable);
    r.lbl.innerHTML = p.qtyTotal
      ? `available <span class="muted">of ${p.qtyTotal} ${esc(p.unit)}</span>`
      : `<span class="muted">count not set yet</span>`;
    r.bar.style.setProperty("--p", p.qtyTotal ? `${Math.round(p.qtyAvailable / p.qtyTotal * 100)}%` : "0%");

    const src = imageFor(p);
    if (src) {
      r.img.hidden = false; r.ph.hidden = true;
      if (r.img.getAttribute("src") !== src) r.img.setAttribute("src", src);
      r.img.alt = "";
      r.img.onerror = () => { r.img.hidden = true; r.ph.hidden = false; };
    } else {
      r.img.hidden = true; r.ph.hidden = false;
      r.img.removeAttribute("src");
    }
    el.setAttribute("aria-label",
      `${p.name}. Part number ${p.sku}. ${p.qtyTotal
        ? `${p.qtyAvailable} of ${p.qtyTotal} available.`
        : "Stock count not set."}`);
  }

  function place(el, pos) {
    const row = Math.floor(pos / cols);
    const col = pos % cols;
    el.style.transform = `translate(${Math.round(col * (colW + gap))}px, ${row * (cardH + gap)}px)`;
    el.style.width = `${colW}px`;
  }

  function layout() {
    const width = vp.clientWidth;
    if (!width) return;
    const nextCols = Math.max(1, Math.floor((width + gap) / (cardMin + gap)));
    cols = nextCols;
    colW = Math.floor((width - (cols - 1) * gap) / cols);
    const rows = Math.ceil(items.length / cols);
    vp.style.height = `${Math.max(0, rows * (cardH + gap) - gap)}px`;
  }

  function render() {
    frame = 0;
    if (!items.length) { recycleAll(); return; }
    const rect = vp.getBoundingClientRect();
    const rowH = cardH + gap;
    const top = Math.max(0, -rect.top);
    const first = Math.max(0, Math.floor(top / rowH) - 2);
    const last = Math.min(
      Math.ceil(items.length / cols) - 1,
      Math.floor((top + window.innerHeight) / rowH) + 2
    );
    const from = first * cols;
    const to = Math.min(items.length - 1, last * cols + cols - 1);

    for (const [pos, el] of live) {
      if (pos < from || pos > to) { live.delete(pos); el.remove(); free.push(el); }
    }
    for (let pos = from; pos <= to; pos++) {
      let el = live.get(pos);
      if (!el) {
        el = free.pop() || makeCard();
        live.set(pos, el);
        vp.appendChild(el);
      }
      fill(el, items[pos]);
      place(el, pos);
    }
  }

  function recycleAll() {
    for (const [, el] of live) { el.remove(); free.push(el); }
    live.clear();
  }

  function schedule() { if (!frame) frame = requestAnimationFrame(render); }

  function setItems(next) {
    items = next;
    recycleAll();
    layout();
    vp.scrollTop = 0;
    render();
  }

  readMetrics();
  // Scroll listeners are in capture phase on window so this works whether the
  // scroller is .main (desktop app shell) or the document (mobile).
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", () => { readMetrics(); layout(); schedule(); }, { passive: true });
  new ResizeObserver(() => { readMetrics(); layout(); schedule(); }).observe(vp);

  return { setItems, refresh: () => { layout(); render(); }, get count() { return items.length; },
           get domNodes() { return live.size; } };
}

let grid;

/* -------------------------------------------------------------------------- */
/* search + results                                                            */
/* -------------------------------------------------------------------------- */

function runSearch() {
  const t0 = performance.now();
  state.results = search({
    query: state.query,
    category: state.category,
    availableOnly: state.availableOnly,
  });
  const ms = performance.now() - t0;
  window.__lastSearchMs = ms;      // read by the verification harness

  const cat = state.category ? categoryBySlug(state.category) : null;
  $("#viewTitle").textContent = state.query
    ? `Results for "${state.query}"`
    : (cat ? cat.name : "All parts");

  const crumb = $("#crumb");
  if (cat) {
    crumb.hidden = false;
    crumb.innerHTML = `<button type="button" data-all>All parts</button>${icon("i-chev", "icon")}<span>${esc(cat.name)}</span>`;
    crumb.querySelector("[data-all]").onclick = () => {
      state.category = "";
      writeHash({ category: "", query: state.query });
      markActiveCategory(); runSearch();
    };
  } else {
    crumb.hidden = true;
  }

  const n = state.results.length;
  $("#resultCount").textContent = n ? plural(n, "part", "parts") : "";
  $("#searchMeta").textContent = state.query ? String(n) : "";

  grid.setItems(state.results);
  $("#grid").setAttribute("aria-busy", "false");
  renderGridState();
}

function renderGridState() {
  const slot = $("#gridState");
  if (state.results.length) { slot.innerHTML = ""; return; }
  if (state.query) {
    slot.innerHTML = `
      <div class="empty">
        <div class="empty__title">No part matches "${esc(state.query)}"</div>
        <p>Try a shorter search, or part of the goBILDA part number such as 5203 or 1120.</p>
        <button class="btn btn--sm" type="button" data-clear>Clear the search</button>
      </div>`;
    slot.querySelector("[data-clear]").onclick = () => {
      $("#q").value = ""; state.query = "";
      $("#searchWrap").classList.remove("is-filled");
      writeHash({ query: "" }); runSearch(); $("#q").focus();
    };
  } else if (state.availableOnly) {
    slot.innerHTML = `
      <div class="empty">
        <div class="empty__title">Nothing in this category is on the shelf</div>
        <p>Everything here is checked out, or its count has not been entered yet.</p>
        <button class="btn btn--sm" type="button" data-all>Show everything</button>
      </div>`;
    slot.querySelector("[data-all]").onclick = () => {
      $("#availOnly").checked = false; state.availableOnly = false; runSearch();
    };
  } else {
    slot.innerHTML = `
      <div class="empty">
        <div class="empty__title">Nothing here yet</div>
        <p>This category has no parts in the catalogue.</p>
      </div>`;
  }
}

function showSkeleton() {
  $("#gridState").innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-min),1fr));gap:var(--grid-gap)">
      ${Array.from({ length: 12 }, () => `
        <div class="sk" style="height:var(--card-h);border-radius:var(--r-lg)"></div>`).join("")}
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* panel plumbing: scrim, focus trap, escape, focus restore                     */
/* -------------------------------------------------------------------------- */

let openPanel = null;

function mountPanel(html, { wide = false, onClose } = {}) {
  closePanel();
  const opener = document.activeElement;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const panel = document.createElement("div");
  panel.className = `panel${wide ? " panel--wide" : ""}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.innerHTML = html;
  document.body.append(scrim, panel);
  document.body.style.overflow = "hidden";

  const keys = (e) => {
    if (e.key === "Escape") {
      // an open combobox owns Escape first: it closes its list, not the dialog
      const cb = e.target?.closest?.('[role="combobox"]');
      if (cb && cb.getAttribute("aria-expanded") === "true") return;
      e.stopPropagation(); closePanel(); return;
    }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll(
      'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]
      .filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", keys, true);
  scrim.addEventListener("click", () => closePanel());
  // querySelectorAll, not querySelector: several panels carry both a header
  // "x" and a footer button (Done / Close / Cancel). Wiring only the first
  // left the footer button inert.
  panel.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closePanel()));

  openPanel = { scrim, panel, keys, opener, onClose };
  (panel.querySelector("[data-autofocus]") || panel.querySelector("[data-close]"))?.focus();
  return panel;
}

function closePanel() {
  if (!openPanel) return;
  const { scrim, panel, keys, opener, onClose } = openPanel;
  openPanel = null;
  document.removeEventListener("keydown", keys, true);
  scrim.remove(); panel.remove();
  document.body.style.overflow = "";
  onClose?.();
  if (opener && document.contains(opener)) opener.focus();
}

/* -------------------------------------------------------------------------- */
/* part detail                                                                 */
/* -------------------------------------------------------------------------- */

function stockBlock(p) {
  return `
    <div class="stock">
      <div class="stock__n">${p.qtyAvailable}</div>
      <div class="stock__lbl">
        ${p.qtyTotal
          ? `available now<br><b>${p.qtyTotal}</b> owned, <b>${p.qtyOut}</b> checked out`
          : `<b>Stock count not entered yet.</b><br>Ask an admin before you plan around this.`}
      </div>
    </div>`;
}

function openDetail(p, { fromHash = false } = {}) {
  if (!fromHash) writeHash({ part: p.partId });
  const src = imageFor(p);
  const panel = mountPanel(`
    <div class="panel__head">
      <h2>Part detail</h2>
      <button class="btn btn--sm btn--ghost btn--icon" type="button" data-close>
        <span class="u-sr">Close</span>${icon("i-x")}
      </button>
    </div>
    <div class="panel__body">
      <div class="detail__img">
        ${src
          ? `<img src="${esc(src)}" alt="${esc(p.name)}" onerror="this.remove()">`
          : `<span class="card__ph">${icon("i-box")}</span>`}
      </div>
      <div class="detail__name">${esc(p.name)}</div>
      <div class="detail__sku">${esc(p.sku)}</div>
      ${stockBlock(p)}
      ${p.description ? `<p class="dim" style="font-size:var(--t-sm)">${esc(p.description)}</p>` : ""}
      <dl class="facts">
        <div class="fact"><dt>Location</dt><dd>${p.location
          ? esc(p.location)
          : `<span class="muted">not recorded yet</span>`}</dd></div>
        <div class="fact"><dt>Category</dt><dd>${esc(p.category)}${p.subcategory ? ` <span class="muted">/ ${esc(p.subcategory)}</span>` : ""}</dd></div>
        <div class="fact"><dt>Unit</dt><dd class="mono">${esc(p.unit)}</dd></div>
        ${p.productUrl ? `<div class="fact"><dt>goBILDA</dt><dd><a href="${esc(p.productUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-hot)">Product page</a></dd></div>` : ""}
      </dl>
    </div>
    <div class="panel__foot">
      <button class="btn" type="button" data-close>Close</button>
      <button class="btn btn--primary" type="button" data-request ${state.readOnly ? "disabled" : ""}>
        ${state.readOnly ? "Requests are offline" : "Request this part"}
      </button>
    </div>`, { onClose: () => writeHash({ part: "" }) });

  panel.querySelector("[data-request]")?.addEventListener("click", () => {
    closePanel();
    openRequest({ part: p });
  });
}

/* -------------------------------------------------------------------------- */
/* combobox: the part picker                                                   */
/*                                                                             */
/* A native <select> with 2,400 options is unusable, so this is a real          */
/* combobox: role=combobox + aria-expanded + aria-activedescendant, arrow key   */
/* navigation, Enter to pick, Escape to close, results capped at COMBO_LIMIT    */
/* with a "keep typing" hint below.                                            */
/* -------------------------------------------------------------------------- */

function mountCombobox({ input, pop, onPick }) {
  let options = [];      // part indices currently listed
  let active = -1;
  let total = 0;

  const isOpen = () => !pop.hidden;

  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(text);
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }

  function render(q) {
    const found = search({ query: q, limit: COMBO_LIMIT + 1 });
    total = q ? found.length : store.parts.length;
    options = found.slice(0, COMBO_LIMIT);
    active = options.length ? 0 : -1;

    if (!options.length) {
      pop.innerHTML = `<div class="combo__empty">No part matches "${esc(q)}"</div>`;
      input.removeAttribute("aria-activedescendant");
      return;
    }

    pop.innerHTML = options.map((idx, i) => {
      const p = store.parts[idx];
      const src = imageFor(p);
      const zero = p.qtyAvailable <= 0;
      return `<div class="opt" role="option" id="cbo-${i}" aria-selected="${i === 0}" data-i="${i}">
        <span class="opt__thumb">${src
          ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`
          : icon("i-box")}</span>
        <span style="min-width:0">
          <span class="opt__name">${highlight(p.name, q)}</span>
          <span class="opt__sku">${highlight(p.sku, q)}</span>
        </span>
        <span class="opt__avail ${zero ? "is-zero" : ""}">${p.qtyTotal ? `${p.qtyAvailable}/${p.qtyTotal}` : "not set"}</span>
      </div>`;
    }).join("") + (total > COMBO_LIMIT
      ? `<div class="combo__note">Showing the closest ${COMBO_LIMIT} of ${total}. Keep typing to narrow it down.</div>`
      : "");

    input.setAttribute("aria-activedescendant", "cbo-0");
  }

  function open(q) {
    render(q);
    pop.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close() {
    pop.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function move(delta) {
    if (!isOpen()) { open(input.value.trim()); return; }
    if (!options.length) return;
    const prev = pop.querySelector(`#cbo-${active}`);
    prev?.setAttribute("aria-selected", "false");
    active = (active + delta + options.length) % options.length;
    const next = pop.querySelector(`#cbo-${active}`);
    next?.setAttribute("aria-selected", "true");
    next?.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", `cbo-${active}`);
  }

  function commit(i = active) {
    if (i < 0 || i >= options.length) return;
    const p = store.parts[options[i]];
    close();
    onPick(p);
  }

  const onInput = debounce(() => { open(input.value.trim()); }, SEARCH_DEBOUNCE);

  input.addEventListener("input", onInput);
  input.addEventListener("focus", () => { if (!isOpen()) open(input.value.trim()); });
  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "Home": if (isOpen()) { e.preventDefault(); move(-active); } break;
      case "End": if (isOpen()) { e.preventDefault(); move(options.length - 1 - active); } break;
      case "Enter": if (isOpen() && active >= 0) { e.preventDefault(); commit(); } break;
      case "Escape": if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); } break;
      case "Tab": close(); break;
      default: break;
    }
  });
  pop.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    e.preventDefault();                 // keep focus in the input
    commit(Number(opt.dataset.i));
  });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.contains(e.target) && e.target !== input) close();
  }, true);

  return { close, open: () => open(input.value.trim()) };
}

/* -------------------------------------------------------------------------- */
/* request form                                                                */
/* -------------------------------------------------------------------------- */

const IDENTITY_KEY = "labinv.me";
function readIdentity() {
  try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || "{}"); } catch { return {}; }
}
function writeIdentity(name, teamNumber) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name, teamNumber })); } catch { /* ignore */ }
}

/** Client-side mirror of CONTRACT 7.4. The server stays authoritative; this
 *  exists so a tired user finds out before a round trip, not after. */
function validate(v, picked, type) {
  const e = {};
  if (!v.name || v.name.length < 1) e.name = "Put your name in.";
  else if (v.name.length > 80) e.name = "That is longer than 80 characters.";

  if (!v.teamNumber) e.teamNumber = "Which team are you on?";
  else if (!TEAMS.some((t) => t.number === v.teamNumber)) e.teamNumber = "Pick one of the four teams.";

  if (!picked) e.part = "Pick a part from the list.";

  const q = Number(v.quantity);
  if (!v.quantity) e.quantity = "How many?";
  else if (!Number.isInteger(q) || q < 1) e.quantity = "Whole numbers, 1 or more.";
  else if (q > 999) e.quantity = "999 is the most in one request.";
  else if (picked && type === "checkout" && picked.qtyTotal > 0 && q > picked.qtyAvailable) {
    e.quantity = `Only ${picked.qtyAvailable} available right now.`;
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(v.checkoutDate)) e.checkoutDate = "Pick a date.";
  if (!dateRe.test(v.returnDate)) e.returnDate = "Pick a date.";
  if (!e.checkoutDate && !e.returnDate && v.returnDate < v.checkoutDate) {
    e.returnDate = "This has to be on or after the checkout date.";
  }
  if (v.userNote && v.userNote.length > 300) e.userNote = "Keep it under 300 characters.";
  return e;
}

function openRequest({ part = null, returnFor = null } = {}) {
  const me = readIdentity();
  let type = returnFor ? "return" : "checkout";
  let picked = part || (returnFor ? store.byId?.get(returnFor.partId) || null : null);
  let mineList = [];
  let linkedRequestId = returnFor ? returnFor.requestId : "";

  /* Declared up here, not beside setErr: syncPicked() runs while the panel is
     being built -- whenever a part is pre-selected -- and reaches these. As
     consts further down they were still in the temporal dead zone, so opening
     the form with a part already chosen threw before it finished. */
  const ERR = { name: "#e-name", teamNumber: "#e-team", part: "#e-part",
                quantity: "#e-qty", checkoutDate: "#e-out", returnDate: "#e-back", userNote: "#e-note" };
  const FIELD = { name: "#f-name", teamNumber: "#f-team", part: "#f-part",
                  quantity: "#f-qty", checkoutDate: "#f-out", returnDate: "#f-back", userNote: "#f-note" };

  const panel = mountPanel(`
    <div class="panel__head">
      <h2>Request a part</h2>
      <button class="btn btn--sm btn--ghost btn--icon" type="button" data-close>
        <span class="u-sr">Close</span>${icon("i-x")}
      </button>
    </div>
    <div class="panel__body">
      <form class="form" id="reqForm" novalidate>
        <div class="seg" role="group" aria-label="Request type">
          <button type="button" data-type="checkout" aria-pressed="true">Checking out</button>
          <button type="button" data-type="return" aria-pressed="false">Returning</button>
        </div>

        <div class="form__row">
          <div class="field">
            <label for="f-name">Your name</label>
            <input class="input" id="f-name" name="name" maxlength="80" autocomplete="name"
                   value="${esc(me.name || "")}" data-autofocus>
            <p class="err" id="e-name"></p>
          </div>
          <div class="field">
            <label for="f-team">Team number</label>
            <select class="input" id="f-team" name="teamNumber">
              <option value="">Choose your team</option>
              ${TEAMS.map((t) => `<option value="${esc(t.number)}"${
                String(me.teamNumber || "") === t.number ? " selected" : ""
              }>${esc(t.name)} ${esc(t.number)}</option>`).join("")}
            </select>
            <p class="err" id="e-team"></p>
          </div>
        </div>

        <div class="field" id="mineSlot" hidden>
          <span class="label">Your parts that are out</span>
          <div class="mine" id="mine"></div>
        </div>

        <div class="field">
          <label for="f-part">Part</label>
          <div class="combo">
            <input class="input combo__input" id="f-part" role="combobox" aria-expanded="false"
                   aria-controls="partPop" aria-autocomplete="list" autocomplete="off"
                   spellcheck="false" placeholder="Type a name or part number">
            <span class="combo__caret">${icon("i-chev", "icon")}</span>
            <div class="combo__pop" id="partPop" role="listbox" aria-label="Matching parts" hidden></div>
          </div>
          <div id="pickedSlot"></div>
          <p class="err" id="e-part"></p>
        </div>

        <div class="form__row">
          <div class="field">
            <label for="f-qty">Quantity</label>
            <input class="input mono" id="f-qty" name="quantity" type="number" inputmode="numeric"
                   min="1" max="999" step="1" value="1">
            <p class="hint" id="qtyHint"></p>
            <p class="err" id="e-qty"></p>
          </div>
          <div class="field">
            <label for="f-out" id="l-out">Checkout date</label>
            <input class="input" id="f-out" name="checkoutDate" type="date" value="${todayISO()}">
            <p class="err" id="e-out"></p>
          </div>
        </div>

        <div class="field">
          <label for="f-back" id="l-back">Return date</label>
          <input class="input" id="f-back" name="returnDate" type="date" value="${todayISO(7)}">
          <p class="err" id="e-back"></p>
        </div>

        <div class="field">
          <label for="f-note">Mini description <span class="muted">(what is it for?)</span></label>
          <textarea class="textarea" id="f-note" name="userNote" maxlength="300"
                    placeholder="Drivetrain rebuild for the league meet on Saturday"></textarea>
          <p class="err" id="e-note"></p>
        </div>
      </form>
    </div>
    <div class="panel__foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="submit" form="reqForm" id="submitBtn">Send request</button>
    </div>`, { wide: true });

  const form = panel.querySelector("#reqForm");
  const partInput = panel.querySelector("#f-part");
  const qty = panel.querySelector("#f-qty");
  const pickedSlot = panel.querySelector("#pickedSlot");

  const combo = mountCombobox({
    input: partInput,
    pop: panel.querySelector("#partPop"),
    onPick: (p) => { picked = p; linkedRequestId = ""; syncPicked(); qty.focus(); },
  });

  function syncPicked() {
    if (!picked) { pickedSlot.innerHTML = ""; panel.querySelector("#qtyHint").textContent = ""; return; }
    partInput.value = picked.name;
    const cap = type === "checkout" ? picked.qtyAvailable : 999;
    if (type === "checkout" && picked.qtyTotal > 0) {
      qty.max = String(Math.max(1, cap));
      if (Number(qty.value) > cap) qty.value = String(Math.max(1, cap));
      panel.querySelector("#qtyHint").textContent =
        cap > 0 ? `${cap} available to take today.` : "Nothing on the shelf right now.";
    } else {
      qty.max = "999";
      panel.querySelector("#qtyHint").textContent = "";
    }
    pickedSlot.innerHTML = `
      <div class="picked">
        <span class="picked__meta">
          <span class="mono" style="font-size:var(--t-xs);color:var(--text-3)">${esc(picked.sku)}</span><br>
          <span class="picked__where">${picked.location ? esc(picked.location) : "Location not recorded yet"}</span>
        </span>
        <span class="picked__n">${picked.qtyAvailable}<span class="muted" style="font-weight:400">/${picked.qtyTotal}</span></span>
      </div>`;
    setErr("part", "");
  }

  if (picked) syncPicked();

  /* ---- type switch ---- */
  panel.querySelectorAll("[data-type]").forEach((b) => {
    b.addEventListener("click", () => {
      type = b.dataset.type;
      panel.querySelectorAll("[data-type]").forEach((x) =>
        x.setAttribute("aria-pressed", String(x.dataset.type === type)));
      panel.querySelector("#l-out").textContent = type === "return" ? "Taken out on" : "Checkout date";
      panel.querySelector("#l-back").textContent = type === "return" ? "Returning on" : "Return date";
      panel.querySelector("#submitBtn").textContent =
        type === "return" ? "Send return request" : "Send request";
      if (type === "return") { panel.querySelector("#f-back").value = todayISO(); loadMine(); }
      else { panel.querySelector("#mineSlot").hidden = true; }
      syncPicked();
    });
  });

  /* ---- returning: offer the user's open checkouts so linkedRequestId is set ---- */
  async function loadMine() {
    const name = panel.querySelector("#f-name").value.trim();
    const team = panel.querySelector("#f-team").value.trim();
    const slot = panel.querySelector("#mineSlot");
    if (!state.online || !name || !team) { slot.hidden = true; return; }
    slot.hidden = false;
    panel.querySelector("#mine").innerHTML = `<div class="sk" style="height:38px"></div>`;
    try {
      const data = await api.myRequests(name, team);
      mineList = (data.requests || []).filter((r) => r.type === "checkout" && r.status === "approved");
      if (!mineList.length) {
        panel.querySelector("#mine").innerHTML =
          `<p class="hint">Nothing shows as checked out under that name. Pick the part below instead.</p>`;
        return;
      }
      panel.querySelector("#mine").innerHTML = mineList.map((r, i) => `
        <button class="mine__row" type="button" data-mine="${i}" aria-pressed="false">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.partName)}</span>
          <span class="mono muted" style="font-size:var(--t-xs)">${r.quantity} out</span>
        </button>`).join("");
      panel.querySelectorAll("[data-mine]").forEach((b) => b.addEventListener("click", () => {
        const r = mineList[Number(b.dataset.mine)];
        panel.querySelectorAll("[data-mine]").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        linkedRequestId = r.requestId;
        const p = getPartLocal(r.partId);
        if (p) { picked = p; syncPicked(); }
        qty.value = String(r.quantity);
      }));
    } catch {
      panel.querySelector("#mine").innerHTML =
        `<p class="hint">Could not look that up. Pick the part below instead.</p>`;
    }
  }
  panel.querySelector("#f-team").addEventListener("blur", () => { if (type === "return") loadMine(); });

  function setErr(key, msg) {
    const e = panel.querySelector(ERR[key]);
    const f = panel.querySelector(FIELD[key]);
    if (e) e.textContent = msg || "";
    if (f) {
      if (msg) { f.setAttribute("aria-invalid", "true"); f.setAttribute("aria-describedby", e.id); }
      else { f.removeAttribute("aria-invalid"); f.removeAttribute("aria-describedby"); }
    }
  }
  const clearAll = () => Object.keys(ERR).forEach((k) => setErr(k, ""));

  function collect() {
    const fd = new FormData(form);
    return {
      name: String(fd.get("name") || "").trim(),
      teamNumber: String(fd.get("teamNumber") || "").trim(),
      quantity: String(fd.get("quantity") || "").trim(),
      checkoutDate: String(fd.get("checkoutDate") || ""),
      returnDate: String(fd.get("returnDate") || ""),
      userNote: String(fd.get("userNote") || "").trim(),
    };
  }

  // revalidate a field once it has been corrected, never before first submit
  let submitted = false;
  form.addEventListener("input", () => {
    if (!submitted) return;
    const errs = validate(collect(), picked, type);
    Object.keys(ERR).forEach((k) => setErr(k, errs[k] || ""));
  });

  /* ---- submit ---- */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    combo.close();
    submitted = true;
    clearAll();
    const v = collect();
    const errs = validate(v, picked, type);
    if (Object.keys(errs).length) {
      Object.entries(errs).forEach(([k, m]) => setErr(k, m));
      const firstKey = Object.keys(errs)[0];
      panel.querySelector(FIELD[firstKey])?.focus();
      return;
    }
    if (!state.online) {
      toast("The backend is not connected, so requests cannot be sent yet.", "err");
      return;
    }

    const btn = panel.querySelector("#submitBtn");
    btn.disabled = true;
    btn.textContent = "Sending...";
    writeIdentity(v.name, v.teamNumber);

    try {
      const data = await api.submitRequest({
        type,
        name: v.name,
        teamNumber: v.teamNumber,
        partId: picked.partId,
        quantity: Number(v.quantity),
        userNote: v.userNote,
        checkoutDate: v.checkoutDate,
        returnDate: v.returnDate,
        linkedRequestId,
      });
      showConfirmation(data.requestId, picked, Number(v.quantity), type);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = type === "return" ? "Send return request" : "Send request";
      if (err.code === "INSUFFICIENT_STOCK") {
        setErr("quantity", err.message || "There is not enough of that on the shelf.");
        qty.focus();
      } else if (err.code === "BAD_INPUT") {
        toast(err.message || "The server rejected that. Check the fields.", "err");
      } else {
        toast(err.message || "Could not send the request. Try again.", "err");
      }
    }
  });

  /* ---- opened from the activity board: a return of one known loan, so the
     form arrives already answered and the link is carried through rather than
     asking the student to find their own checkout in a dropdown.
     This runs last: syncPicked() reaches ERR/FIELD, which are const and would
     still be in the temporal dead zone earlier in this function. ---- */
  if (returnFor) {
    panel.querySelector("#f-name").value = returnFor.name || "";
    const teamSel = panel.querySelector("#f-team");
    if (teamSel) teamSel.value = returnFor.teamNumber || "";
    panel.querySelector("#f-qty").value = String(returnFor.quantity || 1);
    panel.querySelector('[data-type="return"]')?.click();
    linkedRequestId = returnFor.requestId;             // after the click: the
    panel.querySelector("#mineSlot").hidden = true;    // picker would clear it
    syncPicked();
  }
}

function showConfirmation(requestId, part, quantity, type) {
  mountPanel(`
    <div class="panel__head">
      <h2>Request sent</h2>
      <button class="btn btn--sm btn--ghost btn--icon" type="button" data-close>
        <span class="u-sr">Close</span>${icon("i-x")}
      </button>
    </div>
    <div class="panel__body">
      <div class="done">
        <div style="color:var(--accent);margin-bottom:var(--s3)">${icon("i-check", "icon")}</div>
        <h3>${quantity} &times; ${esc(part.name)}</h3>
        <p class="muted" style="font-size:var(--t-sm);margin-top:6px">
          ${type === "return" ? "Return" : "Checkout"} request filed. Quote this number if you need to ask about it.
        </p>
        <div class="done__id">${esc(requestId)}</div>
        <div>
          <span class="done__pending">Pending admin approval</span>
        </div>
        <p class="muted" style="font-size:var(--t-sm);margin-top:var(--s4)">
          Nothing has moved yet. The count changes only once an admin approves it,
          so do not take the part off the shelf until then.
        </p>
      </div>
    </div>
    <div class="panel__foot">
      <button class="btn btn--primary" type="button" data-close data-autofocus>Done</button>
    </div>`);
}


/* ==========================================================================
   Activity board -- public, read-only: who has what and where it stands.

   Status is derived from (type, status) rather than stored, because a loan is
   two rows: the checkout and, later, its return. What a reader cares about is
   the state of the loan, not which row they happen to be looking at.
   ========================================================================== */

const BOARD_STATES = {
  pending:   { cls: "st--pending",   label: "Waiting for approval" },
  out:       { cls: "st--out",       label: "Out on loan" },
  returning: { cls: "st--returning", label: "Return awaiting approval" },
  denied:    { cls: "st--denied",    label: "Denied" },
  done:      { cls: "st--done",      label: "Returned" },
  cancelled: { cls: "st--pending",   label: "Cancelled" },
};

function boardStateOf(r) {
  if (r.status === "denied") return "denied";
  if (r.status === "cancelled") return "cancelled";
  if (r.type === "return") return r.status === "pending" ? "returning" : "done";
  if (r.status === "approved") return "out";
  if (r.status === "returned") return "done";
  return "pending";
}

const boardState = { rows: [], team: "", loaded: false };

function boardCategoryOf(r) {
  const p = store.byId?.get(r.partId);
  return (p && p.category) || "Other";
}

function renderBoard() {
  const body = $("#boardBody");
  const rows = boardState.team
    ? boardState.rows.filter((r) => String(r.teamNumber) === boardState.team)
    : boardState.rows;

  const tally = { pending: 0, out: 0, returning: 0, denied: 0, done: 0, cancelled: 0 };
  for (const r of rows) tally[boardStateOf(r)] += 1;
  $("#boardMetrics").innerHTML = `
    <div class="metric"><dt>Waiting</dt><dd>${tally.pending + tally.returning}</dd></div>
    <div class="metric"><dt>Out on loan</dt><dd>${tally.out}</dd></div>
    <div class="metric"><dt>Closed</dt><dd>${tally.done}</dd></div>
    <div class="metric"><dt>Denied</dt><dd>${tally.denied}</dd></div>`;

  if (!rows.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty__title">${boardState.team ? "Nothing from that team yet" : "No requests yet"}</div>
        <p>${boardState.team
          ? "Try another team, or clear the filter."
          : "The first checkout request will show up here."}</p>
      </div>`;
    return;
  }

  const groups = new Map();
  for (const r of rows) {
    const c = boardCategoryOf(r);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  const today = new Date().toISOString().slice(0, 10);

  body.innerHTML = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, list]) => `
      <section class="bgroup">
        <div class="bgroup__head">
          <h2>${esc(cat)}</h2>
          <span class="bgroup__count">${list.length} request${list.length === 1 ? "" : "s"}</span>
        </div>
        ${list.map((r) => {
          const st = boardStateOf(r);
          const meta = BOARD_STATES[st];
          const overdue = st === "out" && r.returnDate && r.returnDate < today;
          return `
          <div class="brow${overdue ? " is-overdue" : ""}">
            <span class="brow__bar ${meta.cls}"></span>
            <span class="brow__part">
              <span class="brow__name">${esc(r.partName || r.partId)}</span>
              <span class="brow__sku">${esc(r.sku || "")}</span>
            </span>
            <span class="brow__who">
              <b>${esc(r.name)}</b>
              <span class="brow__team">${esc(teamLabel(r.teamNumber))}</span>
            </span>
            <span class="brow__qty">x${r.quantity}${st === "out"
              ? `<button class="btn btn--sm brow__act" type="button" data-return="${esc(r.requestId)}">Return</button>`
              : ""}</span>
            <span class="brow__status">
              <span class="dot ${meta.cls}"></span>
              <span>${esc(meta.label)}
                <span class="brow__when">${overdue
                  ? `due ${esc(r.returnDate)} &middot; overdue`
                  : r.returnDate ? `due ${esc(r.returnDate)}` : esc(r.checkoutDate || "")}</span>
              </span>
            </span>
          </div>`;
        }).join("")}
      </section>`).join("");
}

async function loadBoard(force = false) {
  if (boardState.loaded && !force) return;
  const body = $("#boardBody");
  body.innerHTML = Array.from({ length: 4 }, () =>
    `<div class="sk" style="height:52px;border-radius:var(--r-md);margin-bottom:8px"></div>`).join("");
  try {
    const data = await api.board(200);
    boardState.rows = data.requests || [];
    boardState.loaded = true;
    renderBoard();
  } catch (e) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty__title">Could not load the board</div>
        <p>${esc(e.message)}</p>
        <button class="btn btn--sm" type="button" id="boardRetry">Try again</button>
      </div>`;
    $("#boardRetry").onclick = () => loadBoard(true);
  }
}

function showView(which) {
  const onBoard = which === "board";
  $("#board").hidden = !onBoard;
  document.querySelector(".shell").hidden = onBoard;
  $("#tabBoard").classList.toggle("is-on", onBoard);
  $("#tabCatalogue").classList.toggle("is-on", !onBoard);
  $("#tabBoard").setAttribute("aria-current", onBoard ? "page" : "false");
  $("#tabCatalogue").setAttribute("aria-current", onBoard ? "false" : "page");
  $("#searchWrap").hidden = onBoard;
  if (onBoard) loadBoard();
}

function wireBoard() {
  const sel = $("#boardTeam");
  sel.innerHTML = `<option value="">All teams</option>` +
    TEAMS.map((t) => `<option value="${esc(t.number)}">${esc(t.name)} ${esc(t.number)}</option>`).join("");
  sel.addEventListener("change", () => { boardState.team = sel.value; renderBoard(); });
  $("#boardRefresh").addEventListener("click", () => loadBoard(true));
  $("#boardBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-return]");
    if (!b) return;
    const r = boardState.rows.find((x) => x.requestId === b.dataset.return);
    if (!r) return;
    if (!state.online) { toast("Returns need the backend to be connected.", "err", 6000); return; }
    openRequest({ returnFor: r });
  });
  $("#tabBoard").addEventListener("click", () => { location.hash = "#/activity"; showView("board"); });
  $("#tabCatalogue").addEventListener("click", () => { location.hash = "#/"; showView("catalogue"); });
  if (location.hash.startsWith("#/activity")) showView("board");
}

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

async function boot() {
  initTheme();
  document.title = SITE_TITLE;
  showSkeleton();

  grid = createGrid($("#grid"), (p) => openDetail(p));
  window.__grid = grid;                 // read by the verification harness

  /* ---- 1. categories, best effort ---- */
  let cats = null;
  try { cats = await api.loadSeedCategories(); } catch { /* derived from parts instead */ }

  /* ---- 2. catalog: live API first, seed JSON as the fallback ---- */
  let loaded = false;
  if (api.hasApi()) {
    try {
      const data = await api.getCatalogCached();
      loadCatalog({ parts: data.parts, version: data.version }, "api");
      if (Array.isArray(data.categories) && data.categories.length) {
        cats = { categories: data.categories };
      }
      loaded = true;

      if (data.stale) {
        // We have a real catalogue from a previous visit, just not a fresh one.
        // Browsing and searching are fine; only sending is not, so say that
        // plainly rather than crying that the whole backend is gone.
        state.online = false;
        state.readOnly = true;
        showBanner("quiet", "Showing your saved copy.",
          "The backend did not answer just now, so this is the catalogue from your last visit. " +
          "Availability may have moved on and requests cannot be sent until it reconnects.",
          { label: "Try again", onClick: () => location.reload() });
      } else {
        state.online = true;
        state.readOnly = false;
      }
    } catch (err) {
      showBanner("accent", "Backend unreachable.",
        `Showing the catalogue that ships with the site. Availability may be out of date and requests cannot be sent. (${err.message})`,
        { label: "Try again", onClick: () => location.reload() });
    }
  } else {
    showBanner("quiet", "Read-only preview.",
      "No backend is connected yet, so this is the catalogue committed to the repo. Availability is a snapshot and the request form is disabled until API_URL is filled in.");
  }

  if (!loaded) {
    try {
      const seed = await api.loadSeedCatalog();
      loadCatalog(seed, "seed");
    } catch (err) {
      $("#gridState").innerHTML = `
        <div class="empty">
          <div class="empty__title">The catalogue has not been built yet</div>
          <p>${esc(err.message)} Run <span class="mono">tools/crawl_gobilda.py</span> to generate it,
             or set <span class="mono">API_URL</span> in <span class="mono">assets/js/config.js</span>.</p>
        </div>`;
      $("#grid").setAttribute("aria-busy", "false");
      $("#resultCount").textContent = "";
      return;
    }
  }

  loadCategories(cats || { categories: [] });

  /* ---- 3. render ---- */
  $("#gridState").innerHTML = "";
  renderSidebar();
  wireSidebar();
  applyRoute();

  /* ---- 4. wiring ---- */
  wireBoard();

  const input = $("#q");
  const onType = debounce(() => {
    state.query = input.value.trim();
    $("#searchWrap").classList.toggle("is-filled", !!input.value);
    writeHash({ query: state.query });
    runSearch();
  }, SEARCH_DEBOUNCE);
  input.addEventListener("input", onType);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = ""; state.query = "";
      $("#searchWrap").classList.remove("is-filled");
      writeHash({ query: "" }); runSearch();
    }
  });
  $("#qClear").addEventListener("click", () => {
    input.value = ""; state.query = "";
    $("#searchWrap").classList.remove("is-filled");
    writeHash({ query: "" }); runSearch(); input.focus();
  });

  $("#availOnly").addEventListener("change", (e) => {
    state.availableOnly = e.target.checked;
    runSearch();
  });

  $("#requestBtn").addEventListener("click", () => {
    if (state.readOnly) {
      toast("Requests need the backend. An admin has to set API_URL in config.js first.", "err", 6500);
      return;
    }
    openRequest({});
  });
  if (state.readOnly) {
    $("#requestBtn").title = "Requests are disabled until the backend is connected";
  }

  window.addEventListener("hashchange", () => { if (!suppressHash) applyRoute(); });

  // "/" focuses search, the way every tool a teenager already uses behaves
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !openPanel && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) {
      e.preventDefault(); input.focus(); input.select();
    }
  });

  window.__ready = true;               // read by the verification harness
}

boot().catch((err) => {
  console.error(err);
  showBanner("accent", "Something broke while loading.", err.message || String(err));
});
