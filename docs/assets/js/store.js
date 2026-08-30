/* ============================================================================
   LabInventory - store.js
   Catalog cache, category tree, and the search index.

   This file exists because the catalog is ~2,400 parts. Everything here is
   built once at boot and then reused; nothing in here touches the DOM and
   nothing in here calls the network.

   Search strategy: a sorted token list + postings (an inverted index).
   A query is tokenized, the first token is expanded by prefix over the sorted
   token array (binary search for the lower bound, walk while the prefix
   holds), and the resulting candidate set is verified against the remaining
   tokens on the precomputed lowercase haystack. Candidates are deduped with a
   generation-stamped Int32Array so no allocation or clearing happens per
   keystroke. A substring fallback runs only when the index returns nothing,
   so typing the middle of a word still finds things.
   ========================================================================== */

/* -------------------------------------------------------------------------- */
/* normalisation                                                               */
/* -------------------------------------------------------------------------- */

const int = (v, d = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const str = (v) => (v === undefined || v === null ? "" : String(v));

/** Coerce anything catalog-shaped into a full Part. Tolerates seed rows that
 *  omit derived fields, and never trusts qtyAvailable from the wire. */
export function normalizePart(raw) {
  const qtyTotal = Math.max(0, int(raw.qtyTotal, 0));
  const qtyOut = Math.max(0, int(raw.qtyOut, 0));
  const sku = str(raw.sku).trim();
  return {
    partId: str(raw.partId).trim() || (sku ? `gb-${sku}` : ""),
    sku,
    name: str(raw.name).trim(),
    category: str(raw.category).trim(),
    subcategory: str(raw.subcategory).trim(),
    imageUrl: str(raw.imageUrl).trim(),
    localImage: str(raw.localImage).trim(),
    productUrl: str(raw.productUrl).trim(),
    description: str(raw.description).trim(),
    location: str(raw.location).trim(),
    qtyTotal,
    qtyOut,
    qtyAvailable: Math.max(0, qtyTotal - qtyOut),
    unit: str(raw.unit).trim() || "ea",
    active: raw.active === undefined ? true : raw.active !== false && raw.active !== "FALSE",
    notes: str(raw.notes).trim(),
    updatedAt: str(raw.updatedAt),
  };
}

export function slugify(s) {
  return str(s).toLowerCase().trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

const TOKEN_SPLIT = /[^a-z0-9]+/;
function tokenize(s) {
  const out = [];
  for (const t of s.toLowerCase().split(TOKEN_SPLIT)) if (t) out.push(t);
  return out;
}

/* -------------------------------------------------------------------------- */
/* the store                                                                   */
/* -------------------------------------------------------------------------- */

export const store = {
  parts: [],
  byId: new Map(),
  categories: [],   // raw Cat rows
  tree: [],         // [{ node, children:[{node, children:[]}] }] with counts
  version: "",
  source: "seed",   // "api" | "seed"
  ready: false,

  /* index internals */
  _hay: [],
  _tokens: [],
  _postings: [],
  _stamp: new Int32Array(0),
  _gen: 0,
  _catMembers: new Map(), // slug -> Int32Array of part indices
};

/* -------------------------------------------------------------------------- */
/* loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} payload  { parts:[], categories?:[], version? }
 * @param {"api"|"seed"} source
 */
export function loadCatalog(payload, source = "seed") {
  const rawParts = Array.isArray(payload?.parts) ? payload.parts : [];
  const parts = [];
  const byId = new Map();

  for (const raw of rawParts) {
    const p = normalizePart(raw);
    if (!p.partId || !p.name) continue;    // a part with no identity is not a part
    if (!p.active) continue;               // CONTRACT 2: Active=FALSE is hidden
    if (byId.has(p.partId)) continue;      // last writer would otherwise win silently
    byId.set(p.partId, p);
    parts.push(p);
  }

  store.parts = parts;
  store.byId = byId;
  store.version = str(payload?.version || payload?.generatedAt);
  store.source = source;

  buildIndex();
  store.ready = true;
  return parts.length;
}

export function loadCategories(payload) {
  const rows = Array.isArray(payload?.categories) ? payload.categories : [];
  store.categories = rows.map((c) => ({
    catId: str(c.catId) || slugify(c.name),
    name: str(c.name).trim(),
    parent: str(c.parent),
    slug: str(c.slug) || slugify(c.name),
    sortOrder: int(c.sortOrder, 0),
  })).filter((c) => c.name);
  buildTree();
}

/* -------------------------------------------------------------------------- */
/* index                                                                       */
/* -------------------------------------------------------------------------- */

function buildIndex() {
  const parts = store.parts;
  const n = parts.length;
  const hay = new Array(n);
  const map = new Map(); // token -> number[]

  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const blob = `${p.name} ${p.sku} ${p.category} ${p.subcategory}`.toLowerCase();
    hay[i] = blob;
    // dedupe tokens per document so postings stay short
    let seen = null;
    for (const t of blob.split(TOKEN_SPLIT)) {
      if (!t) continue;
      if (seen === null) seen = new Set();
      if (seen.has(t)) continue;
      seen.add(t);
      const list = map.get(t);
      if (list) list.push(i); else map.set(t, [i]);
    }
  }

  const tokens = Array.from(map.keys()).sort();
  const postings = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) postings[i] = Int32Array.from(map.get(tokens[i]));

  store._hay = hay;
  store._tokens = tokens;
  store._postings = postings;
  store._stamp = new Int32Array(n);
  store._gen = 0;

  buildCategoryMembers();
}

/** First index i where tokens[i] >= prefix. */
function lowerBound(tokens, prefix) {
  let lo = 0, hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Union of postings for every indexed token starting with `prefix`.
 * Writes into `out` and returns how many were written. Deduped by generation
 * stamp so we never allocate or clear a Set per keystroke.
 */
function prefixUnion(prefix, out) {
  const { _tokens: tokens, _postings: postings, _stamp: stamp } = store;
  const gen = ++store._gen;
  let count = 0;
  for (let i = lowerBound(tokens, prefix); i < tokens.length; i++) {
    if (!tokens[i].startsWith(prefix)) break;
    const list = postings[i];
    for (let j = 0; j < list.length; j++) {
      const doc = list[j];
      if (stamp[doc] === gen) continue;
      stamp[doc] = gen;
      out[count++] = doc;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* category tree                                                               */
/* -------------------------------------------------------------------------- */

/** Build the browse tree. Prefers categories.json (which mirrors goBILDA's own
 *  navigation); falls back to deriving it from the parts themselves so the app
 *  is never navigationless. Nodes with no parts are dropped: a tree of empty
 *  branches is worse than no tree. */
function buildTree() {
  const rows = store.categories;
  const nameCount = new Map();   // lowercased name -> part count (direct)
  for (const p of store.parts) {
    for (const nm of [p.category, p.subcategory]) {
      if (!nm) continue;
      const k = nm.toLowerCase();
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
  }

  let tree;
  if (rows.length) {
    const byCatId = new Map(rows.map((c) => [c.catId, c]));
    const kids = new Map();
    const roots = [];
    for (const c of rows) {
      if (c.parent && byCatId.has(c.parent)) {
        const arr = kids.get(c.parent);
        if (arr) arr.push(c); else kids.set(c.parent, [c]);
      } else {
        roots.push(c);
      }
    }
    const bySort = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    tree = roots.sort(bySort).map((r) => ({
      node: r,
      children: (kids.get(r.catId) || []).sort(bySort).map((c) => ({ node: c, children: [] })),
    }));
  } else {
    // derived fallback: top-level Category, second level Subcategory
    const groups = new Map();
    for (const p of store.parts) {
      if (!p.category) continue;
      let g = groups.get(p.category);
      if (!g) { g = new Set(); groups.set(p.category, g); }
      if (p.subcategory) g.add(p.subcategory);
    }
    tree = Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, subs], i) => ({
        node: { catId: slugify(name), name, parent: "", slug: slugify(name), sortOrder: i },
        children: Array.from(subs).sort().map((s, j) => ({
          node: { catId: slugify(s), name: s, parent: slugify(name), slug: slugify(s), sortOrder: j },
          children: [],
        })),
      }));
  }

  // attach counts, prune empties
  for (const branch of tree) {
    branch.children = branch.children.filter((c) => {
      c.count = nameCount.get(c.node.name.toLowerCase()) || 0;
      return c.count > 0;
    });
    const direct = nameCount.get(branch.node.name.toLowerCase()) || 0;
    branch.count = Math.max(direct, branch.children.reduce((s, c) => s + c.count, 0));
  }
  store.tree = tree.filter((b) => b.count > 0);
  buildCategoryMembers();
}

/** slug -> Int32Array of part indices, precomputed so category clicks are O(1). */
function buildCategoryMembers() {
  const members = new Map();
  if (!store.tree.length || !store.parts.length) { store._catMembers = members; return; }

  const bucket = new Map(); // slug -> number[]
  const push = (slug, i) => {
    const a = bucket.get(slug);
    if (a) a.push(i); else bucket.set(slug, [i]);
  };

  // name (lowercased) -> every slug that should claim a part with that name
  const claim = new Map();
  const addClaim = (name, slug) => {
    if (!name) return;
    const k = name.toLowerCase();
    const a = claim.get(k);
    if (a) { if (!a.includes(slug)) a.push(slug); } else claim.set(k, [slug]);
  };
  for (const branch of store.tree) {
    addClaim(branch.node.name, branch.node.slug);
    for (const child of branch.children) {
      addClaim(child.node.name, child.node.slug);
      addClaim(child.node.name, branch.node.slug); // a child's parts roll up
    }
  }

  for (let i = 0; i < store.parts.length; i++) {
    const p = store.parts[i];
    const done = new Set();
    for (const nm of [p.category, p.subcategory]) {
      for (const slug of claim.get((nm || "").toLowerCase()) || []) {
        if (done.has(slug)) continue;
        done.add(slug);
        push(slug, i);
      }
    }
  }
  for (const [slug, arr] of bucket) members.set(slug, Int32Array.from(arr));
  store._catMembers = members;
}

export function categoryBySlug(slug) {
  for (const b of store.tree) {
    if (b.node.slug === slug) return b.node;
    for (const c of b.children) if (c.node.slug === slug) return c.node;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* query                                                                       */
/* -------------------------------------------------------------------------- */

const NO_RESULTS = [];

/**
 * @param {{ query?:string, category?:string, availableOnly?:boolean, limit?:number }} opts
 * @returns {number[]} part indices, best match first
 */
export function search(opts = {}) {
  const query = str(opts.query).trim().toLowerCase();
  const category = str(opts.category);
  const availableOnly = !!opts.availableOnly;
  const parts = store.parts;
  const n = parts.length;
  if (!n) return NO_RESULTS;

  const inCat = category ? store._catMembers.get(category) : null;
  if (category && !inCat) return NO_RESULTS;

  /* ---- no query: category order, cheap path ---- */
  if (!query) {
    const base = inCat || null;
    const out = [];
    if (base) {
      for (let i = 0; i < base.length; i++) {
        const idx = base[i];
        if (availableOnly && parts[idx].qtyAvailable <= 0) continue;
        out.push(idx);
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (availableOnly && parts[i].qtyAvailable <= 0) continue;
        out.push(i);
      }
    }
    return out;
  }

  /* ---- indexed path ---- */
  const qTokens = tokenize(query);
  let candidates, count;

  if (qTokens.length) {
    candidates = store._scratchOut && store._scratchOut.length >= n
      ? store._scratchOut
      : (store._scratchOut = new Int32Array(n));
    count = prefixUnion(qTokens[0], candidates);
  } else {
    candidates = null; count = 0;
  }

  const hay = store._hay;
  const rest = qTokens.slice(1);
  const scored = [];

  const consider = (idx) => {
    const p = parts[idx];
    if (availableOnly && p.qtyAvailable <= 0) return;
    const h = hay[idx];
    for (let r = 0; r < rest.length; r++) if (h.indexOf(rest[r]) === -1) return;
    scored.push(idx);
  };

  if (count > 0) {
    if (inCat) {
      // membership test without allocating: mark the category then walk candidates
      const set = catSet(category, inCat);
      for (let i = 0; i < count; i++) if (set.has(candidates[i])) consider(candidates[i]);
    } else {
      for (let i = 0; i < count; i++) consider(candidates[i]);
    }
  }

  /* ---- substring fallback: mid-word typing, e.g. "otor" ---- */
  if (!scored.length) {
    const pool = inCat || null;
    const len = pool ? pool.length : n;
    for (let i = 0; i < len; i++) {
      const idx = pool ? pool[i] : i;
      if (hay[idx].indexOf(query) === -1) continue;
      if (availableOnly && parts[idx].qtyAvailable <= 0) continue;
      scored.push(idx);
    }
  }

  /* ---- rank ---- */
  const rank = new Map();
  for (const idx of scored) rank.set(idx, scoreOf(parts[idx], query, qTokens));
  scored.sort((a, b) => {
    const d = rank.get(b) - rank.get(a);
    if (d) return d;
    return parts[a].name.length - parts[b].name.length || (parts[a].name < parts[b].name ? -1 : 1);
  });

  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

const _catSetCache = new Map();
function catSet(slug, arr) {
  let s = _catSetCache.get(slug);
  if (!s || s.size !== arr.length) {
    s = new Set(arr);
    _catSetCache.set(slug, s);
  }
  return s;
}

function scoreOf(p, query, qTokens) {
  const name = p.name.toLowerCase();
  const sku = p.sku.toLowerCase();
  let s = 0;
  if (name === query || sku === query) s += 500;
  if (name.startsWith(query)) s += 220;
  else if (name.indexOf(query) !== -1) s += 120;
  if (sku.startsWith(query)) s += 200;
  else if (sku.indexOf(query) !== -1) s += 90;
  // every query token appearing at a word boundary in the name is a strong signal
  for (const t of qTokens) {
    if (name.startsWith(t) || name.indexOf(` ${t}`) !== -1) s += 25;
  }
  if (p.qtyAvailable > 0) s += 8;   // in-stock breaks ties toward what they can have today
  return s;
}

/* -------------------------------------------------------------------------- */
/* mutation (admin optimistic updates, approve-affects-availability)           */
/* -------------------------------------------------------------------------- */

/** Merge a server Part into the cache in place. Returns the stored object. */
export function upsertPartLocal(raw) {
  const p = normalizePart(raw);
  if (!p.partId) return null;
  const existing = store.byId.get(p.partId);
  if (existing) {
    Object.assign(existing, p);
    return existing;
  }
  store.byId.set(p.partId, p);
  store.parts.push(p);
  buildIndex();
  buildTree();
  return p;
}

export function removePartLocal(partId) {
  const p = store.byId.get(partId);
  if (!p) return false;
  store.byId.delete(partId);
  const i = store.parts.indexOf(p);
  if (i !== -1) store.parts.splice(i, 1);
  buildIndex();
  buildTree();
  return true;
}

/** Apply an approved checkout/return locally so availability moves immediately. */
export function applyDecisionLocal(request, decision) {
  if (decision !== "approve" || !request) return null;
  const p = store.byId.get(request.partId);
  if (!p) return null;
  const q = Math.max(0, int(request.quantity, 0));
  if (request.type === "checkout") p.qtyOut = Math.min(p.qtyTotal, p.qtyOut + q);
  else if (request.type === "return") p.qtyOut = Math.max(0, p.qtyOut - q);
  p.qtyAvailable = Math.max(0, p.qtyTotal - p.qtyOut);
  return p;
}

export const getPartLocal = (partId) => store.byId.get(partId) || null;

/** Best available image source for a part, repo mirror first, CDN as fallback. */
export function imageFor(p) {
  return p.localImage || p.imageUrl || "";
}
