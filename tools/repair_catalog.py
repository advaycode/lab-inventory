"""Repair pass over the goBILDA crawl output. Reuses crawl_gobilda's own
traversal so the cache keys and URL normalization match exactly.

Fixes:
  1. rd-* / *-on-servocity redirect stubs that leaked in as fake parts.
  2. product<->category join matching zero rows (URL trailing-slash mismatch).
  3. categories.json rebuilt from the live nav, pruned to categories that
     actually hold products.

Network: only the homepage (for the nav tree). Everything else is cache.
"""
import csv, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import crawl_gobilda as cg

def norm(u):
    return cg.norm_url((u or "").split("?")[0])

JUNK = re.compile(r"/rd-|-on-servocity$")

def load(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return json.load(f)

catalog = load("docs/data/catalog.json")
parts = catalog["parts"]

before = len(parts)
parts = [p for p in parts if not JUNK.search(norm(p.get("productUrl")))]
dropped = before - len(parts)

# ---- rebuild the nav tree (has .href per node) ------------------------------
nodes, _collisions = cg.build_category_tree()
by_id = {n["catId"]: n for n in nodes}

def root_of(cid):
    seen = set()
    while by_id.get(cid, {}).get("parent") and cid not in seen:
        seen.add(cid); cid = by_id[cid]["parent"]
    return cid

def depth_of(cid):
    d, seen = 0, set()
    while by_id.get(cid, {}).get("parent") and cid not in seen:
        seen.add(cid); cid = by_id[cid]["parent"]; d += 1
    return d

# ---- product -> set(catId), using the crawler's own cache-backed walk -------
prod2cats = {}
for n in nodes:
    href = n.get("href")
    if not href:
        continue
    urls = cg.collect_products_recursive(href) if by_id.get(n["catId"], {}).get("parent") \
           else cg.collect_direct_products(href)
    for u in urls:
        prod2cats.setdefault(norm(u), set()).add(n["catId"])

assigned = uncat = 0
for p in parts:
    cids = prod2cats.get(norm(p.get("productUrl")), set())
    if not cids:
        p["category"], p["subcategory"] = "Uncategorized", ""
        uncat += 1
        continue
    deepest = max(cids, key=depth_of)
    root = root_of(deepest)
    p["category"] = by_id[root]["name"]
    p["subcategory"] = by_id[deepest]["name"] if deepest != root else ""
    assigned += 1

# ---- prune empty categories -------------------------------------------------
live = set()
for p in parts:
    live.add(p["category"])
    if p.get("subcategory"):
        live.add(p["subcategory"])
kept = [{k: n[k] for k in ("catId", "name", "parent", "slug", "sortOrder")}
        for n in nodes if n["name"] in live or not n["parent"]]
keep_ids = {c["catId"] for c in kept}
for c in kept:
    if c["parent"] and c["parent"] not in keep_ids:
        c["parent"] = ""

catalog["parts"] = parts
catalog["count"] = len(parts)
with open(os.path.join(ROOT, "docs/data/catalog.json"), "w", encoding="utf-8") as f:
    json.dump(catalog, f, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(ROOT, "docs/data/categories.json"), "w", encoding="utf-8") as f:
    json.dump({"generatedAt": catalog.get("generatedAt"), "categories": kept},
              f, ensure_ascii=False, indent=1)

COLS = ["PartID","SKU","Name","Category","Subcategory","ImageURL","LocalImage","ProductURL",
        "Description","Location","QtyTotal","QtyOut","Unit","Active","Notes","UpdatedAt"]
KEYS = ["partId","sku","name","category","subcategory","imageUrl","localImage","productUrl",
        "description","location","qtyTotal","qtyOut","unit","active","notes","updatedAt"]
with open(os.path.join(ROOT, "build/parts_import.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f); w.writerow(COLS)
    for p in parts:
        w.writerow([p.get(k, "") for k in KEYS])

print(f"redirect stubs dropped : {dropped}")
print(f"parts now              : {len(parts)}")
print(f"categorized            : {assigned}")
print(f"uncategorized          : {uncat} ({uncat/len(parts)*100:.1f}%)")
print(f"categories kept        : {len(kept)} of {len(nodes)}")
