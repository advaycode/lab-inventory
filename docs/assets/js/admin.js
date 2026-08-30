/* ============================================================================
   LabInventory - admin.js

   The page starts as a login form and nothing else. The admin shell lives in a
   <template> and is not instantiated until the backend returns a token, so an
   unauthenticated visitor has no admin DOM to read.

   Token handling lives in api.js: sessionStorage only, cleared on sign-out and
   automatically on any UNAUTHORIZED response. The password is never stored.
   ========================================================================== */

import * as api from "./api.js";
import { store, loadCatalog, loadCategories, search, imageFor,
         upsertPartLocal, removePartLocal, applyDecisionLocal, getPartLocal } from "./store.js";
import { SITE_TITLE, PAGE_SIZE, SEARCH_DEBOUNCE, IMAGE_MAX_PX, IMAGE_QUALITY } from "./config.js";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, cls = "icon") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* No client-side gate exists. The Apps Script backend is the only thing that
   decides whether a password is correct, and it does so on Google's servers. */
const previewMode = false;

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function dayLabel(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return "not set";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { month: "short", day: "numeric" });
}

const isOverdue = (ymd) => /^\d{4}-\d{2}-\d{2}$/.test(ymd || "") &&
  ymd < new Date().toISOString().slice(0, 10);

const toastsEl = $("#toasts");
function toast(msg, kind = "ok", ms = 5200) {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .2s, transform .2s";
    el.style.opacity = "0"; el.style.transform = "translateY(6px)";
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
  const label = `Switch to ${mode === "light" ? "dark" : "light"} theme`;
  const btn = $("#themeBtn");
  if (btn) { btn.title = label; const l = $("#themeLabel"); if (l) l.textContent = label; }
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
}
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

/* -------------------------------------------------------------------------- */
/* state                                                                       */
/* -------------------------------------------------------------------------- */

const st = {
  tab: "queue",
  queue: [],
  partQuery: "",
  partResults: [],
  shown: 0,
  catalogLoaded: false,
  grouped: true,
  groups: [],
  openGroups: new Set(),
};

/* -------------------------------------------------------------------------- */
/* gate                                                                        */
/* -------------------------------------------------------------------------- */

function showGate(message) {
  $("#gate").hidden = false;
  document.body.classList.remove("has-shell");
  const shell = $("#adminShell");
  if (shell) shell.remove();          // nothing admin-shaped stays in the DOM
  document.title = `Admin | ${SITE_TITLE}`;
  const err = $("#pwErr");
  if (message && err) err.textContent = message;
  $("#pw")?.focus();
}

function wireGate() {
  const form = $("#loginForm");
  const pw = $("#pw");
  const err = $("#pwErr");
  const btn = $("#loginBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    pw.removeAttribute("aria-invalid");
    const password = pw.value;
    if (!password) {
      err.textContent = "Enter the password.";
      pw.setAttribute("aria-invalid", "true");
      pw.focus();
      return;
    }
    if (!api.hasApi()) {
      err.textContent = "API_URL is empty in assets/js/config.js, so there is nothing to sign in to.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Checking...";
    try {
      await api.login(password);
      pw.value = "";                  // the password never lingers, not even in the field
      await mountShell();
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      err.textContent = ex.code === "UNAUTHORIZED"
        ? "That password did not work."
        : (ex.message || "Could not reach the backend.");
      pw.setAttribute("aria-invalid", "true");
      pw.select();
    }
  });
}

window.addEventListener("labinv:unauthorized", () => {
  showGate("Your session ended. Sign in again.");
});

/* -------------------------------------------------------------------------- */
/* shell                                                                       */
/* -------------------------------------------------------------------------- */

async function mountShell() {
  $("#gate").hidden = true;
  if (!$("#adminShell")) {
    const frag = $("#shellTpl").content.cloneNode(true);
    const holder = document.createElement("div");
    holder.id = "adminShell";
    holder.append(frag);
    document.body.insertBefore(holder, toastsEl);
  }
  document.body.classList.add("has-shell");

  applyTheme(currentTheme());
  $("#themeBtn").addEventListener("click", () =>
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));

  $("#logoutBtn").addEventListener("click", () => {
    api.logout();
    showGate("Signed out.");
  });

  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  $("#refreshBtn").addEventListener("click", () => loadQueue(true));
  $("#approveAllBtn").addEventListener("click", approveAll);
  wireQueue();
  $("#newPartBtn").addEventListener("click", () => openEditor(null));

  $("#plist").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches('[data-role="loc"]')) return;
    e.preventDefault();
    e.target.closest(".pgroup__bulk").querySelector('[data-act="applyloc"]').click();
  });

  $("#groupToggle").addEventListener("change", (e) => {
    st.grouped = e.target.checked;
    st.shown = 0;
    renderPartList();
  });

  const pq = $("#pq");
  const onType = debounce(() => {
    st.partQuery = pq.value.trim();
    $("#adminSearchWrap").classList.toggle("is-filled", !!pq.value);
    runPartSearch();
  }, SEARCH_DEBOUNCE);
  pq.addEventListener("input", onType);
  $("#pqClear").addEventListener("click", () => {
    pq.value = ""; st.partQuery = "";
    $("#adminSearchWrap").classList.remove("is-filled");
    runPartSearch(); pq.focus();
  });

  window.__adminReady = true;
  if (previewMode) showPreviewBanner();
  // Both are needed before the queue can show shelf counts, and they race:
  // whichever finishes second triggers the render that has all the facts.
  await Promise.all([previewMode ? Promise.resolve() : loadQueue(), loadCatalogOnce()]);
  renderQueue();
  selectTab(location.hash.replace("#", "") || "queue");
}

function selectTab(tab) {
  if (!["queue", "parts", "stats"].includes(tab)) tab = "queue";
  st.tab = tab;
  $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  for (const name of ["queue", "parts", "stats"]) {
    $(`#view-${name}`).hidden = name !== tab;
  }
  history.replaceState(null, "", `#${tab}`);
  if (tab === "parts") { runPartSearch(); $("#pq").focus(); }
  if (tab === "stats") loadStats();
}

/* -------------------------------------------------------------------------- */
/* catalog (shared with the user side via store.js)                            */
/* -------------------------------------------------------------------------- */

async function loadCatalogOnce() {
  if (st.catalogLoaded) return;
  try {
    const data = await api.getCatalog();
    loadCatalog({ parts: data.parts, version: data.version }, "api");
    loadCategories({ categories: data.categories || [] });
    st.catalogLoaded = true;
  } catch {
    try {
      const seed = await api.loadSeedCatalog();
      loadCatalog(seed, "seed");
      try { loadCategories(await api.loadSeedCategories()); } catch { loadCategories({ categories: [] }); }
      st.catalogLoaded = true;
      toast("Loaded the catalogue from the repo seed. Live counts may differ.", "err", 7000);
    } catch (e) {
      toast(`Could not load any catalogue: ${e.message}`, "err", 9000);
    }
  }
  runPartSearch();
}

/* -------------------------------------------------------------------------- */
/* queue                                                                       */
/* -------------------------------------------------------------------------- */

function showPreviewBanner() {
  if ($("#previewNote")) return;
  const el = document.createElement("div");
  el.id = "previewNote";
  el.className = "banner";
  el.innerHTML =
    "<strong>Preview mode.</strong> No backend is connected, so there are no real " +
    "requests to approve and nothing you change here is saved. Deploy the Apps " +
    "Script backend and set API_URL to switch this on.";
  const shell = $("#adminShell");
  shell.insertBefore(el, shell.firstChild.nextSibling);
}

async function loadQueue(manual = false) {
  const box = $("#queue");
  if (previewMode) {
    st.queue = [];
    box.innerHTML = `
      <div class="empty">
        <div class="empty__title">No queue yet</div>
        <p>Check-out and return requests will appear here once the backend is connected.</p>
      </div>`;
    return;
  }
  if (manual || !st.queue.length) {
    box.innerHTML = Array.from({ length: 3 }, () =>
      `<div class="sk" style="height:118px;border-radius:var(--r-md)"></div>`).join("");
  }
  try {
    const data = await api.pendingRequests();
    st.queue = data.requests || [];
    renderQueue();
  } catch (e) {
    if (e.code === "UNAUTHORIZED") return;      // the gate already took over
    box.innerHTML = `
      <div class="empty">
        <div class="empty__title">Could not load the queue</div>
        <p>${esc(e.message)}</p>
        <button class="btn btn--sm" type="button" data-retry>Try again</button>
      </div>`;
    box.querySelector("[data-retry]").onclick = () => loadQueue(true);
  }
}

function renderQueue() {
  const box = $("#queue");
  const n = st.queue.length;

  const pill = $("#pendingPill");
  pill.textContent = String(n);
  pill.classList.toggle("pill--zero", n === 0);

  const aa = $("#approveAllBtn");
  if (aa && !aa.disabled) {
    aa.hidden = n === 0;
    if (!approveAllArmed) aa.textContent = `Approve all (${n})`;
  }

  const units = st.queue.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const overdueCount = st.queue.filter((r) => isOverdue(r.returnDate)).length;
  $("#queueMetrics").innerHTML = `
    <div class="metric ${n ? "metric--alert" : ""}"><dt>Waiting on you</dt><dd>${n}</dd></div>
    <div class="metric"><dt>Units requested</dt><dd>${units}</dd></div>
    <div class="metric"><dt>Checkouts</dt><dd>${st.queue.filter((r) => r.type === "checkout").length}</dd></div>
    <div class="metric"><dt>Returns</dt><dd>${st.queue.filter((r) => r.type === "return").length}</dd></div>`;

  if (!n) {
    box.innerHTML = `
      <div class="empty">
        <div style="color:var(--text-3)">${icon("i-check", "icon")}</div>
        <div class="empty__title">Queue is clear</div>
        <p>Nothing is waiting for approval. New requests land here newest first.</p>
      </div>`;
    return;
  }

  box.innerHTML = st.queue.map((r, i) => requestRow(r, i)).join("");
  if (overdueCount) {
    // surfaced quietly rather than as another red thing on screen
    box.insertAdjacentHTML("afterbegin",
      `<p class="muted" style="font-size:var(--t-sm);margin:0 0 var(--s2)">
         ${overdueCount} of these were due back already.</p>`);
  }
}

function requestRow(r, i) {
  const part = getPartLocal(r.partId);
  const qty = Number(r.quantity) || 0;
  const short = part && r.type === "checkout" && part.qtyTotal > 0 && qty > part.qtyAvailable;
  return `
  <article class="req" data-i="${i}" data-id="${esc(r.requestId)}">
    <div>
      <div class="req__who">
        <span class="badge ${r.type === "return" ? "" : "badge--accent"}">${r.type === "return" ? "Return" : "Checkout"}</span>
        <span class="req__name">${esc(r.name)}</span>
        <span class="req__team">Team ${esc(r.teamNumber)}</span>
        <span class="req__ago">${esc(ago(r.createdAt))}</span>
      </div>
      <div class="req__part"><b>${qty}</b> &times; ${esc(r.partName || part?.name || r.partId)}</div>
      <div class="req__sku">${esc(r.sku || part?.sku || "")}${part?.location ? ` &middot; ${esc(part.location)}` : ""}</div>
      <div class="req__dates">
        <span>Out</span>
        <span class="mono">${esc(dayLabel(r.checkoutDate))}</span>
        <span>back</span>
        <span class="mono">${esc(dayLabel(r.returnDate))}</span>
        ${isOverdue(r.returnDate) ? `<span class="badge badge--accent">Past due</span>` : ""}
      </div>
      ${r.userNote ? `<div class="req__note">${esc(r.userNote)}</div>` : ""}
      ${part ? `<div class="req__stock">
        On the shelf: <b>${part.qtyAvailable}</b> of <b>${part.qtyTotal}</b>
        ${short ? `<span class="req__short">- not enough for this request</span>` : ""}
      </div>` : `<div class="req__stock">This part is not in the local catalogue.</div>`}
    </div>
    <div class="req__acts">
      <button class="btn btn--sm btn--danger" type="button" data-act="deny-open">Deny</button>
      <button class="btn btn--sm btn--primary" type="button" data-act="approve">Approve</button>
    </div>
    <div class="req__deny" hidden>
      <div class="field" style="flex:1">
        <label class="u-sr" for="dn-${i}">Reason for denying (optional)</label>
        <input class="input" id="dn-${i}" placeholder="Reason (optional)" maxlength="200">
      </div>
      <button class="btn btn--sm btn--danger" type="button" data-act="deny">Confirm deny</button>
      <button class="btn btn--sm btn--ghost" type="button" data-act="deny-cancel">Cancel</button>
    </div>
  </article>`;
}

/** Delegated once at mount, never per render. Rows are looked up by request id
 *  rather than by index so a re-render between click and handler cannot act on
 *  the wrong request. */
function wireQueue() {
  const box = $("#queue");
  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = btn.closest(".req");
    const req = st.queue.find((r) => r.requestId === row.dataset.id);
    if (!req) return;

    if (btn.dataset.act === "deny-open") {
      row.querySelector(".req__deny").hidden = false;
      row.querySelector(".input").focus();
      return;
    }
    if (btn.dataset.act === "deny-cancel") {
      row.querySelector(".req__deny").hidden = true;
      row.querySelector('[data-act="deny-open"]').focus();
      return;
    }
    if (btn.dataset.act === "approve") return decide(req, "approve", "", row);
    if (btn.dataset.act === "deny") return decide(req, "deny", row.querySelector(".input").value.trim(), row);
  });

  // Enter inside the deny note confirms it
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches(".req__deny .input")) return;
    e.preventDefault();
    e.target.closest(".req__deny").querySelector('[data-act="deny"]').click();
  });
}

/**
 * Optimistic decision. The row leaves immediately and the affected part's
 * availability moves with it; if the server refuses, both go back exactly
 * where they were.
 */
/* Approve-all. Two-step rather than a confirm() dialog: the first click arms
   the button, the second commits, and it disarms itself after 5s. Requests are
   sent one at a time on purpose -- the backend takes a script lock per write,
   so firing them in parallel would just pile up on that lock. Anything the
   server rejects (a checkout that no longer fits the shelf, say) is reported
   rather than swallowed, and the queue is reloaded from the server at the end
   so what you see is the truth, not our optimistic guess. */
let approveAllArmed = false;
let approveAllTimer = null;

function disarmApproveAll() {
  approveAllArmed = false;
  clearTimeout(approveAllTimer);
  const b = $("#approveAllBtn");
  if (b) { b.classList.remove("btn--danger"); b.textContent = `Approve all (${st.queue.length})`; }
}

async function approveAll() {
  const btn = $("#approveAllBtn");
  const items = st.queue.slice();
  if (!items.length) return;

  if (!approveAllArmed) {
    approveAllArmed = true;
    btn.classList.add("btn--danger");
    btn.textContent = `Approve all ${items.length}? Click again`;
    clearTimeout(approveAllTimer);
    approveAllTimer = setTimeout(disarmApproveAll, 5000);
    return;
  }

  disarmApproveAll();
  btn.disabled = true;
  let done = 0;
  const failed = [];
  for (const req of items) {
    btn.textContent = `Approving ${done + 1} of ${items.length}...`;
    try {
      const data = await api.decide(req.requestId, "approve", "");
      if (data?.part) upsertPartLocal(data.part);
      st.queue = st.queue.filter((r) => r.requestId !== req.requestId);
      done += 1;
      renderQueue();
      if (st.tab === "parts") renderPartList();
    } catch (e) {
      if (e.code === "UNAUTHORIZED") { btn.disabled = false; return; }
      failed.push(`${req.quantity} x ${req.partName || req.partId}: ${e.message}`);
    }
  }
  btn.disabled = false;
  await loadQueue(true);
  if (failed.length) {
    toast(`Approved ${done}. ${failed.length} could not be approved - ${failed[0]}`, "err", 10000);
  } else {
    toast(`Approved all ${done}.`);
  }
}

async function decide(req, decision, adminNote, row) {
  row.classList.add("is-busy");

  const index = st.queue.indexOf(req);
  const part = getPartLocal(req.partId);
  const before = part ? { qtyOut: part.qtyOut, qtyAvailable: part.qtyAvailable } : null;

  st.queue.splice(index, 1);
  const changed = applyDecisionLocal(req, decision);
  renderQueue();
  if (st.tab === "parts") renderPartList();

  const what = `${req.quantity} x ${req.partName || req.partId}`;
  try {
    const data = await api.decide(req.requestId, decision, adminNote);
    if (data?.part) {
      const p = upsertPartLocal(data.part);
      renderQueue();
      if (st.tab === "parts") renderPartList();
      toast(decision === "approve"
        ? `Approved ${what}. ${p.qtyAvailable} of ${p.qtyTotal} left on the shelf.`
        : `Denied ${what}.`);
      return;
    }
    toast(decision === "approve"
      ? `Approved ${what}.${changed ? ` ${changed.qtyAvailable} of ${changed.qtyTotal} left.` : ""}`
      : `Denied ${what}.`);
  } catch (e) {
    if (e.code === "UNAUTHORIZED") return;
    st.queue.splice(index, 0, req);              // rollback: the row goes back
    if (part && before) { part.qtyOut = before.qtyOut; part.qtyAvailable = before.qtyAvailable; }
    renderQueue();
    if (st.tab === "parts") renderPartList();
    toast(e.code === "INSUFFICIENT_STOCK"
      ? `Not enough stock to approve ${what}. Nothing changed.`
      : `Could not ${decision} that request: ${e.message}`, "err", 8000);
  }
}

/* -------------------------------------------------------------------------- */
/* parts list                                                                  */
/*                                                                             */
/* Paginated in PAGE_SIZE chunks behind an IntersectionObserver, so the 2,400   */
/* part catalogue never lands in the DOM in one go.                            */
/* -------------------------------------------------------------------------- */

let observer = null;

function runPartSearch() {
  if (!$("#plist")) return;
  const t0 = performance.now();
  st.partResults = search({ query: st.partQuery });
  window.__lastAdminSearchMs = performance.now() - t0;
  buildGroups();
  st.shown = 0;
  $("#partCount").textContent = st.partResults.length
    ? `${st.partResults.length} of ${store.parts.length}` : "";
  renderPartList();
}

/* --------------------------------------------------------------------------
   Grouping.

   goBILDA sells families: one U-Beam in eleven lengths, one screw in six.
   They live in the same bin, so asking for a location eleven times is busywork.
   The family name is the product name with its trailing variant parenthetical
   removed -- "1101 Series U-Beam (3 Hole, 24mm Length)" -> "1101 Series U-Beam".
   A family of one is left as a plain row; grouping a single part helps nobody.
   -------------------------------------------------------------------------- */

function familyOf(p) {
  let n = String(p.name || "").trim();
  n = n.replace(/\s*\([^()]*\)\s*$/, "").trim();          // drop "(3 Hole, 24mm Length)"
  n = n.replace(/\s*[-–,]\s*\d[\d.]*\s*mm\b.*$/i, "").trim(); // drop ", 24mm Length" tails
  return n || String(p.sku || "").slice(0, 4) || p.partId;
}

const slugKey = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "g";

function buildGroups() {
  const map = new Map();
  for (const idx of st.partResults) {
    const p = store.parts[idx];
    const key = familyOf(p);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(idx);
  }
  st.groups = [...map.entries()].map(([name, idxs]) => ({ name, key: slugKey(name), idxs }));
}

/* The location shared by the whole family, or "" when they disagree -- so the
   bulk field shows what is already true instead of inviting a blind overwrite. */
function commonLocation(idxs) {
  const locs = new Set(idxs.map((i) => store.parts[i].location || ""));
  return locs.size === 1 ? [...locs][0] : "";
}

function partRowHtml(p) {
  const src = imageFor(p);
  return `
    <button class="prow" type="button" data-id="${esc(p.partId)}">
      <span class="prow__thumb">${src
        ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`
        : icon("i-box")}</span>
      <span style="min-width:0">
        <span class="prow__name">${esc(p.name)}</span>
        <span class="prow__sku">${esc(p.sku)}</span>
      </span>
      <span class="prow__loc">${p.location ? esc(p.location) : "no location"}</span>
      <span class="prow__qty">${p.qtyAvailable}<span>/${p.qtyTotal}</span></span>
      <span class="prow__edit">${icon("i-edit")}</span>
    </button>`;
}

function groupHtml(g) {
  const parts = g.idxs.map((i) => store.parts[i]);
  const open = st.openGroups.has(g.key);
  const located = parts.filter((p) => p.location).length;
  const units = parts.reduce((a, p) => a + (p.qtyTotal || 0), 0);
  const avail = parts.reduce((a, p) => a + (p.qtyAvailable || 0), 0);
  const first = parts.find((p) => imageFor(p));
  const src = first ? imageFor(first) : "";
  const cat = [parts[0].category, parts[0].subcategory].filter(Boolean).join(" / ");
  const loc = commonLocation(g.idxs);

  if (parts.length === 1) return partRowHtml(parts[0]);

  return `
  <div class="pgroup" data-key="${esc(g.key)}">
    <button class="pgroup__head" type="button" data-act="toggle" aria-expanded="${open}">
      <span class="pgroup__chev ${open ? "is-open" : ""}">${icon("i-chev")}</span>
      <span class="pgroup__thumb">${src
        ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`
        : icon("i-box")}</span>
      <span style="min-width:0">
        <span class="prow__name">${esc(g.name)}</span>
        <span class="prow__sku">${parts.length} sizes${cat ? " &middot; " + esc(cat) : ""}</span>
      </span>
      <span class="prow__loc">${located === parts.length && loc
        ? esc(loc)
        : located ? `${located} of ${parts.length} located` : "no location"}</span>
      <span class="prow__qty">${avail}<span>/${units}</span></span>
    </button>
    <div class="pgroup__bulk">
      <label class="u-sr" for="loc-${esc(g.key)}">Location for all ${parts.length}</label>
      <input class="input" id="loc-${esc(g.key)}" data-role="loc" placeholder="Shelf B3, Bin 12"
             value="${esc(loc)}" autocomplete="off">
      <button class="btn btn--sm btn--primary" type="button" data-act="applyloc">
        Set for all ${parts.length}
      </button>
    </div>
    <div class="pgroup__body" ${open ? "" : "hidden"}>
      ${open ? parts.map(partRowHtml).join("") : ""}
    </div>
  </div>`;
}

/* One PATCH per member. Sequential on purpose: the backend takes a script lock
   per write, so parallel calls only contend on it. Failures are reported, not
   swallowed, and the ones that succeeded stay applied. */
async function applyGroupLocation(key, location, btn) {
  const g = st.groups.find((x) => x.key === key);
  if (!g) return;
  const members = g.idxs.map((i) => store.parts[i]);
  const label = `Set for all ${members.length}`;
  btn.disabled = true;

  // Fast path: one server call sets the whole family. Older deployments of the
  // Apps Script do not have this action yet, so a BAD_ACTION falls back to the
  // slow per-part loop rather than failing in the admin's face.
  btn.textContent = `Saving ${members.length}...`;
  try {
    const res = await api.bulkLocation(members.map((p) => p.partId), location);
    for (const p of members) upsertPartLocal({ ...p, location });
    btn.disabled = false;
    btn.textContent = label;
    renderPartList();
    toast(location
      ? `Set location on ${res.updated ?? members.length} parts.`
      : `Cleared location on ${res.updated ?? members.length} parts.`);
    return;
  } catch (e) {
    if (e.code === "UNAUTHORIZED") { btn.disabled = false; return; }
    if (e.code !== "BAD_ACTION") {
      btn.disabled = false;
      btn.textContent = label;
      toast(`Could not set the location: ${e.message}`, "err", 9000);
      return;
    }
  }

  // Fallback: one write per part. Sequential because the backend takes a
  // script lock per write, so parallel calls only queue on it anyway.
  let done = 0;
  const failed = [];
  for (const p of members) {
    btn.textContent = `Saving ${done + 1} of ${members.length}...`;
    try {
      const data = await api.upsertPart({ partId: p.partId, location });
      if (data?.part) upsertPartLocal(data.part);
      done += 1;
    } catch (e) {
      if (e.code === "UNAUTHORIZED") { btn.disabled = false; return; }
      failed.push(`${p.sku}: ${e.message}`);
    }
  }
  btn.disabled = false;
  btn.textContent = label;
  renderPartList();
  if (failed.length) toast(`Set ${done} of ${members.length}. First problem - ${failed[0]}`, "err", 9000);
  else toast(`Set location on ${done} parts.`);
}

function renderPartList(append = false) {
  const list = $("#plist");
  if (!list) return;

  if (!st.partResults.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__title">${st.partQuery ? "No part matches that" : "No parts in the catalogue"}</div>
        <p>${st.partQuery
          ? "Try part of the goBILDA number, or a shorter word."
          : "Run the crawler, or add a part by hand with the New part button."}</p>
      </div>`;
    $("#more").innerHTML = "";
    return;
  }

  const units = st.grouped ? st.groups : st.partResults;
  const next = Math.min(units.length, st.shown + PAGE_SIZE);
  const slice = units.slice(append ? st.shown : 0, next);
  const html = st.grouped
    ? slice.map(groupHtml).join("")
    : slice.map((idx) => partRowHtml(store.parts[idx])).join("");

  if (append) list.insertAdjacentHTML("beforeend", html);
  else { list.innerHTML = html; list.onclick = onPartListClick; }
  st.shown = next;

  const more = $("#more");
  observer?.disconnect();
  if (st.shown < units.length) {
    const left = units.length - st.shown;
    more.innerHTML = `<button class="btn btn--sm" type="button" id="loadMore">
      Load ${Math.min(PAGE_SIZE, left)} more
      <span class="muted">(${left} left)</span></button>`;
    $("#loadMore").onclick = () => renderPartList(true);
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) renderPartList(true);
    }, { rootMargin: "600px 0px" });
    observer.observe(more);
  } else {
    more.innerHTML = "";
  }
}

/* One delegated handler for the whole list: expand/collapse a family, apply a
   bulk location, or open a single part. */
function onPartListClick(e) {
  const act = e.target.closest("[data-act]");
  if (act) {
    const wrap = act.closest(".pgroup");
    const key = wrap?.dataset.key;
    if (act.dataset.act === "toggle") {
      const open = !st.openGroups.has(key);
      if (open) st.openGroups.add(key); else st.openGroups.delete(key);
      const g = st.groups.find((x) => x.key === key);
      const body = wrap.querySelector(".pgroup__body");
      if (open && !body.childElementCount) {
        body.innerHTML = g.idxs.map((i) => partRowHtml(store.parts[i])).join("");
      }
      body.hidden = !open;
      act.setAttribute("aria-expanded", String(open));
      wrap.querySelector(".pgroup__chev")?.classList.toggle("is-open", open);
      return;
    }
    if (act.dataset.act === "applyloc") {
      const input = wrap.querySelector('[data-role="loc"]');
      applyGroupLocation(key, input.value.trim(), act);
      return;
    }
  }
  onPartRowClick(e);
}

function onPartRowClick(e) {
  const row = e.target.closest(".prow");
  if (!row) return;
  const p = getPartLocal(row.dataset.id);
  if (p) openEditor(p);
}

/* -------------------------------------------------------------------------- */
/* part editor                                                                 */
/* -------------------------------------------------------------------------- */

let modal = null;

function closeModal() {
  if (!modal) return;
  const { scrim, host, keys, opener } = modal;
  modal = null;
  document.removeEventListener("keydown", keys, true);
  scrim.remove(); host.remove();
  document.body.style.overflow = "";
  if (opener && document.contains(opener)) opener.focus();
}

function openEditor(part) {
  closeModal();
  const opener = document.activeElement;
  const creating = !part;
  const p = part || {
    partId: "", sku: "", name: "", category: "", subcategory: "", description: "",
    location: "", qtyTotal: 0, qtyOut: 0, qtyAvailable: 0, unit: "ea", notes: "",
    imageUrl: "", localImage: "", active: true,
  };

  const cats = [...new Set(store.parts.map((x) => x.category).filter(Boolean))].sort();
  const src = imageFor(p);

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const host = document.createElement("div");
  host.className = "modal";
  host.innerHTML = `
    <div class="modal__card" role="dialog" aria-modal="true" aria-labelledby="edTitle">
      <div class="modal__head">
        <h2 id="edTitle">${creating ? "New part" : "Edit part"}</h2>
        <button class="btn btn--sm btn--ghost btn--icon" type="button" data-close>
          <span class="u-sr">Close</span>${icon("i-x")}
        </button>
      </div>
      <div class="modal__body">
        <form class="editor" id="edForm" novalidate>
          <div class="drop" id="drop">
            <div class="drop__preview" id="preview">${src
              ? `<img src="${esc(src)}" alt="" onerror="this.remove()">`
              : icon("i-img")}</div>
            <div>
              <div class="drop__copy">
                <b>Photo</b>
                Drag one in or <button type="button" class="btn btn--sm" id="pickFile">choose a file</button>.
                Resized to ${IMAGE_MAX_PX}px and re-encoded before it is sent, so a phone photo is fine.
              </div>
              <p class="hint" id="imgInfo" style="margin-top:6px"></p>
              <input type="file" id="file" accept="image/*">
            </div>
          </div>

          <div class="field">
            <label for="ed-name">Name</label>
            <input class="input" id="ed-name" value="${esc(p.name)}" maxlength="200" data-autofocus>
            <p class="err" id="er-name"></p>
          </div>

          <div class="editor__grid">
            <div class="field">
              <label for="ed-sku">Part number</label>
              <input class="input mono" id="ed-sku" value="${esc(p.sku)}" maxlength="60"
                     ${creating ? "" : "readonly"}>
              <p class="hint">${creating ? "goBILDA number, or your own label." : "Part numbers are not editable."}</p>
              <p class="err" id="er-sku"></p>
            </div>
            <div class="field">
              <label for="ed-loc">Location</label>
              <input class="input" id="ed-loc" value="${esc(p.location)}" maxlength="120"
                     placeholder="Shelf B3, Bin 12">
            </div>
          </div>

          <div class="editor__grid">
            <div class="field">
              <label for="ed-cat">Category</label>
              <input class="input" id="ed-cat" value="${esc(p.category)}" list="catList" maxlength="80">
              <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
            </div>
            <div class="field">
              <label for="ed-sub">Subcategory</label>
              <input class="input" id="ed-sub" value="${esc(p.subcategory)}" maxlength="80">
            </div>
          </div>

          <div class="editor__grid--3 editor__grid">
            <div class="field">
              <label for="ed-qty">Quantity owned</label>
              <input class="input mono" id="ed-qty" type="number" min="0" max="99999" step="1"
                     value="${p.qtyTotal}">
              <p class="err" id="er-qty"></p>
            </div>
            <div class="field">
              <label for="ed-unit">Unit</label>
              <select class="input select" id="ed-unit">
                ${["ea", "pack", "set"].map((u) =>
                  `<option value="${u}" ${p.unit === u ? "selected" : ""}>${u}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <span class="label">Checked out</span>
              <div class="input mono" style="display:flex;align-items:center;background:var(--surface-2);color:var(--text-3)"
                   aria-readonly="true">${p.qtyOut}</div>
              <p class="hint">Moves only through approvals.</p>
            </div>
          </div>

          <div class="field">
            <label for="ed-desc">Description</label>
            <textarea class="textarea" id="ed-desc" maxlength="500"
                      placeholder="What it is, and anything a student should know before taking it.">${esc(p.description)}</textarea>
          </div>

          <div class="field">
            <label for="ed-notes">Admin notes <span class="muted">(students never see this)</span></label>
            <textarea class="textarea" id="ed-notes" maxlength="500" style="min-height:60px">${esc(p.notes)}</textarea>
          </div>
        </form>
      </div>
      <div class="modal__foot">
        ${creating ? "" : `<button class="btn btn--sm btn--danger" type="button" id="delBtn">Retire part</button>`}
        <span class="spacer"></span>
        <button class="btn btn--sm" type="button" data-close>Cancel</button>
        <button class="btn btn--sm btn--primary" type="submit" form="edForm" id="saveBtn">
          ${creating ? "Create part" : "Save changes"}
        </button>
      </div>
    </div>`;

  document.body.append(scrim, host);
  document.body.style.overflow = "hidden";

  const keys = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeModal(); return; }
    if (e.key !== "Tab") return;
    const f = $$('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)', host)
      .filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", keys, true);
  scrim.addEventListener("click", closeModal);
  $$("[data-close]", host).forEach((b) => b.addEventListener("click", closeModal));
  modal = { scrim, host, keys, opener };
  $("[data-autofocus]", host).focus();

  /* ---- photo ---- */
  let staged = null;    // { base64, mimeType, filename }
  const drop = $("#drop", host);
  const fileInput = $("#file", host);
  const preview = $("#preview", host);
  const info = $("#imgInfo", host);

  $("#pickFile", host).addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => fileInput.files[0] && takeFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove("is-over");
  }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) takeFile(f);
  });

  async function takeFile(file) {
    if (!/^image\//.test(file.type)) { toast("That is not an image file.", "err"); return; }
    info.textContent = "Resizing...";
    try {
      const r = await downscale(file, IMAGE_MAX_PX, IMAGE_QUALITY);
      staged = { base64: r.base64, mimeType: "image/jpeg", filename: renameJpeg(file.name) };
      preview.innerHTML = `<img src="${r.dataUrl}" alt="">`;
      info.textContent =
        `${r.w}x${r.h}, ${(r.bytes / 1024).toFixed(0)} KB after resize (was ${(file.size / 1024 / 1024).toFixed(1)} MB). Sent when you save.`;
    } catch (e) {
      info.textContent = "";
      toast(`Could not read that image: ${e.message}`, "err");
    }
  }

  /* ---- delete ---- */
  $("#delBtn", host)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Really retire it?";
      setTimeout(() => {
        if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = "Retire part"; }
      }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await api.deletePart(p.partId);
      removePartLocal(p.partId);
      closeModal();
      runPartSearch();
      toast(`${p.name} is hidden from the student side.`);
    } catch (ex) {
      btn.disabled = false; btn.dataset.armed = ""; btn.textContent = "Retire part";
      if (ex.code !== "UNAUTHORIZED") toast(`Could not retire that: ${ex.message}`, "err");
    }
  });

  /* ---- save ---- */
  $("#edForm", host).addEventListener("submit", async (e) => {
    e.preventDefault();
    const save = $("#saveBtn", host);
    const val = (id) => $(`#${id}`, host).value.trim();
    const name = val("ed-name");
    const sku = val("ed-sku");
    const qtyTotal = Number($("#ed-qty", host).value);

    let bad = false;
    const setErr = (id, msg) => {
      const el = $(`#er-${id}`, host);
      if (el) el.textContent = msg || "";
      const f = $(`#ed-${id}`, host);
      if (msg) { f.setAttribute("aria-invalid", "true"); bad = true; } else f.removeAttribute("aria-invalid");
    };
    setErr("name", name ? "" : "A part needs a name.");
    setErr("sku", sku ? "" : "A part needs a number. Make one up if goBILDA has none.");
    setErr("qty", Number.isInteger(qtyTotal) && qtyTotal >= 0 && qtyTotal <= 99999
      ? "" : "Whole number, 0 or more.");
    if (!creating && qtyTotal < p.qtyOut) {
      setErr("qty", `${p.qtyOut} are checked out, so the total cannot go below that.`);
    }
    if (bad) { $$("[aria-invalid]", host)[0]?.focus(); return; }

    const payload = {
      sku, name,
      category: val("ed-cat"),
      subcategory: val("ed-sub"),
      description: val("ed-desc"),
      location: val("ed-loc"),
      qtyTotal,
      unit: $("#ed-unit", host).value,
      notes: val("ed-notes"),
      active: true,
    };
    // CONTRACT 7.5: partId is never sent on create
    if (!creating) payload.partId = p.partId;

    save.disabled = true;
    save.textContent = "Saving...";
    try {
      const data = await api.upsertPart(payload);
      let saved = upsertPartLocal(data.part || { ...payload, partId: p.partId });

      if (staged && saved?.partId) {
        save.textContent = "Uploading photo...";
        try {
          const up = await api.uploadImage(saved.partId, staged.filename, staged.mimeType, staged.base64);
          if (up?.imageUrl) {
            // uploadImage only drops the file in Drive and hands back a URL — it
            // does not touch the Parts row. Without this second write the photo
            // would live only in this tab: gone on refresh, never seen by users.
            const persisted = await api.upsertPart({
              partId: saved.partId, imageUrl: up.imageUrl, localImage: ""
            });
            saved = upsertPartLocal(persisted.part || { ...saved, imageUrl: up.imageUrl, localImage: "" });
          }
        } catch (ex) {
          toast(`Part saved, but the photo did not upload: ${ex.message}`, "err", 8000);
        }
      }

      closeModal();
      runPartSearch();
      renderQueue();
      toast(creating ? `Added ${saved.name}.` : `Saved ${saved.name}.`);
    } catch (ex) {
      save.disabled = false;
      save.textContent = creating ? "Create part" : "Save changes";
      if (ex.code !== "UNAUTHORIZED") toast(`Could not save: ${ex.message}`, "err", 8000);
    }
  });
}

const renameJpeg = (n) => `${(n || "photo").replace(/\.[^.]+$/, "").slice(0, 60)}.jpg`;

/**
 * Downscale to at most maxPx on the long edge and re-encode as JPEG.
 * A 12 MP phone photo is roughly 4 MB of base64; after this it is 100-200 KB,
 * which is the difference between uploadImage working and Apps Script timing out.
 */
export async function downscale(file, maxPx, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";           // JPEG has no alpha; flatten it deliberately
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { dataUrl, base64, w, h, bytes: Math.round(base64.length * 0.75) };
}

/* -------------------------------------------------------------------------- */
/* stats                                                                       */
/* -------------------------------------------------------------------------- */

async function loadStats() {
  const m = $("#statMetrics");
  const od = $("#overdue");
  m.innerHTML = `<div class="metric"><dt>Loading</dt><dd class="sk" style="height:26px;width:60px"></dd></div>`;
  if (previewMode) {
    const parts = [...store.parts.values()];
    m.innerHTML = `
      <div class="metric"><dt>Parts tracked</dt><dd>${parts.length}</dd></div>
      <div class="metric"><dt>Units owned</dt><dd>${parts.reduce((a, p) => a + (p.qtyTotal || 0), 0)}</dd></div>
      <div class="metric"><dt>Units out</dt><dd>0</dd></div>
      <div class="metric"><dt>Pending</dt><dd>0</dd></div>`;
    od.innerHTML = `<div class="empty"><div class="empty__title">Nothing is overdue</div>
      <p>Nothing can be checked out until the backend is connected.</p></div>`;
    return;
  }
  try {
    const s = await api.stats();
    m.innerHTML = `
      <div class="metric"><dt>Parts tracked</dt><dd>${s.totalParts ?? 0}</dd></div>
      <div class="metric"><dt>Units owned</dt><dd>${s.totalUnits ?? 0}</dd></div>
      <div class="metric"><dt>Units out</dt><dd>${s.unitsOut ?? 0}</dd></div>
      <div class="metric ${s.pendingCount ? "metric--alert" : ""}"><dt>Pending</dt><dd>${s.pendingCount ?? 0}</dd></div>`;
    const list = s.overdue || [];
    od.innerHTML = list.length
      ? list.map((r) => `
        <div class="overdue__row">
          <span class="grow"><b>${esc(r.partName)}</b> <span class="mono muted">x${r.quantity}</span></span>
          <span>${esc(r.name)} <span class="mono muted">Team ${esc(r.teamNumber)}</span></span>
          <span class="mono">due ${esc(dayLabel(r.returnDate))}</span>
        </div>`).join("")
      : `<div class="empty"><div class="empty__title">Nothing is overdue</div>
           <p>Every approved checkout is still inside its return date.</p></div>`;
  } catch (e) {
    if (e.code === "UNAUTHORIZED") return;
    m.innerHTML = "";
    od.innerHTML = `<div class="empty"><div class="empty__title">Could not load stats</div>
      <p>${esc(e.message)}</p></div>`;
  }
}

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

(function boot() {
  applyTheme(currentTheme());
  document.title = `Admin | ${SITE_TITLE}`;
  wireGate();
  if (api.getToken() && api.hasApi()) {
    // a token from earlier in this tab: try it, fall back to the gate
    mountShell().catch(() => showGate());
  } else {
    if (!api.hasApi()) {
      $("#pwErr").textContent = "API_URL is empty in assets/js/config.js. Deploy the backend first.";
      $("#loginBtn").disabled = true;
    }
    window.__adminReady = true;
  }
})();
