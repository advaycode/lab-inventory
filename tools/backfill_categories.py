"""Backfill category/subcategory for parts the nav walk could not reach, using
each product page's own BreadcrumbList JSON-LD. Fetches ONLY the uncategorized
products, caches them, and is safe to re-run.
"""
import concurrent.futures as cf, json, os, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import crawl_gobilda as cg
from bs4 import BeautifulSoup

CACHE = os.path.join(ROOT, "build", "cache", "crumbs")
os.makedirs(CACHE, exist_ok=True)
lock = threading.Lock()
done = [0]

def crumbs(url):
    key = cg.cache_key(cg.norm_url(url)) + ".json"
    path = os.path.join(CACHE, key)
    if os.path.exists(path):
        try:
            return json.load(open(path, encoding="utf-8"))
        except Exception:
            pass
    out = []
    time.sleep(0.6)
    r = cg.fetch(url)
    if r is not None and r.status_code == 200:
        soup = BeautifulSoup(r.text, "html.parser")
        for s in soup.find_all("script", type="application/ld+json"):
            if not s.string:
                continue
            try:
                d = json.loads(s.string)
            except Exception:
                continue
            for block in (d if isinstance(d, list) else [d]):
                if isinstance(block, dict) and block.get("@type") == "BreadcrumbList":
                    for it in block.get("itemListElement", []):
                        nm = (it.get("name") or "").strip()
                        if nm:
                            out.append(nm)
    if out:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f)
    with lock:
        done[0] += 1
        if done[0] % 50 == 0:
            print(f"  {done[0]} fetched", file=sys.stderr)
    return out

cat = json.load(open(os.path.join(ROOT, "docs/data/catalog.json"), encoding="utf-8"))
parts = cat["parts"]
cats = json.load(open(os.path.join(ROOT, "docs/data/categories.json"), encoding="utf-8"))["categories"]
by_name = {c["name"].strip().lower(): c for c in cats}
tops = {c["name"].strip().lower() for c in cats if not c["parent"]}

todo = [p for p in parts if p["category"] == "Uncategorized"]
print(f"backfilling {len(todo)} parts", file=sys.stderr)

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    res = list(ex.map(lambda p: (p, crumbs(p["productUrl"])), todo))

fixed = 0
new_subs = {}
for p, cr in res:
    # crumbs look like: Home, TOP, Sub, ..., Product Name -> drop Home + product
    trail = [c for c in cr if c.strip().lower() not in ("home",)]
    if len(trail) >= 2:
        trail = trail[:-1]          # last entry is the product itself
    trail = [t for t in trail if t.strip()]
    if not trail:
        continue
    top = next((t for t in trail if t.strip().lower() in tops), None)
    if not top:
        continue
    rest = [t for t in trail if t.strip().lower() != top.strip().lower()]
    p["category"] = by_name[top.strip().lower()]["name"]
    p["subcategory"] = rest[-1] if rest else ""
    if p["subcategory"] and p["subcategory"].strip().lower() not in by_name:
        new_subs[p["subcategory"]] = by_name[top.strip().lower()]["catId"]
    fixed += 1

# register any subcategory the nav did not expose
order = max((c["sortOrder"] for c in cats), default=0)
for name, parent in new_subs.items():
    order += 1
    slug = cg.slug_of(name.lower().replace(" ", "-")) or name.lower().replace(" ", "-")
    cats.append({"catId": f"{slug}-{order}", "name": name, "parent": parent,
                 "slug": slug, "sortOrder": order})

cat["parts"] = parts; cat["count"] = len(parts)
json.dump(cat, open(os.path.join(ROOT, "docs/data/catalog.json"), "w", encoding="utf-8"),
          ensure_ascii=False, separators=(",", ":"))
json.dump({"generatedAt": cat.get("generatedAt"), "categories": cats},
          open(os.path.join(ROOT, "docs/data/categories.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

still = sum(1 for p in parts if p["category"] == "Uncategorized")
print(f"backfilled       : {fixed}")
print(f"new subcategories: {len(new_subs)}")
print(f"uncategorized now: {still} ({still/len(parts)*100:.1f}%)")
