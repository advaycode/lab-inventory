"""
crawl_gobilda.py - mirrors the goBILDA catalog into LabInventory's seed data.

Outputs:
  docs/data/catalog.json
  docs/data/categories.json
  build/parts_import.csv
  docs/assets/parts/<sku>.webp

Resumable: caches product records (build/cache/products/) and category
listing pages (build/cache/cats/) keyed by md5 of URL. Re-running skips
anything already cached / already downloaded.

Run:  PYTHONIOENCODING=utf-8 python tools/crawl_gobilda.py
"""

import sys
import os
import re
import csv
import json
import time
import random
import hashlib
import argparse
import threading
from io import BytesIO
from pathlib import Path
from collections import deque
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup
from PIL import Image

# ---------------------------------------------------------------- paths ---
ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
CACHE_PROD = BUILD / "cache" / "products"
CACHE_CAT = BUILD / "cache" / "cats"
DOCS_DATA = ROOT / "docs" / "data"
ASSETS = ROOT / "docs" / "assets" / "parts"
PRODUCTS_TXT = BUILD / "gb_products.txt"
CATS_TXT = BUILD / "gb_cats.txt"
REPORT_MD = BUILD / "crawl_report.md"
CSV_OUT = BUILD / "parts_import.csv"

for p in (CACHE_PROD, CACHE_CAT, DOCS_DATA, ASSETS):
    p.mkdir(parents=True, exist_ok=True)

BASE = "https://www.gobilda.com"

# -------------------------------------------------------------- http/UA ---
UA_PRIMARY = "LabInventoryBot/1.0 (+advay.awesomer@gmail.com; robotics lab inventory seeding)"
UA_FALLBACK = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_state = {"ua": UA_PRIMARY, "fallback_used": False}
_ua_lock = threading.Lock()
SESSION = requests.Session()

MAX_WORKERS = 5
TIMEOUT = 30
MAX_RETRIES = 3

_log_lock = threading.Lock()
_counters = {"requests": 0, "failures": 0}


def log(msg):
    with _log_lock:
        print(msg, file=sys.stderr, flush=True)


def _headers():
    return {"User-Agent": _state["ua"], "Accept-Language": "en-US,en;q=0.9"}


def fetch(url, timeout=TIMEOUT, max_retries=MAX_RETRIES):
    last_resp = None
    for attempt in range(max_retries + 1):
        time.sleep(random.uniform(0.2, 0.4))
        try:
            resp = SESSION.get(url, headers=_headers(), timeout=timeout)
        except requests.RequestException as e:
            with _log_lock:
                _counters["requests"] += 1
            if attempt == max_retries:
                log(f"FETCH FAIL {url}: {e}")
                _counters["failures"] += 1
                return None
            time.sleep(min(2 ** attempt, 10))
            continue
        with _log_lock:
            _counters["requests"] += 1
        last_resp = resp
        if resp.status_code == 403 and not _state["fallback_used"]:
            with _ua_lock:
                if not _state["fallback_used"]:
                    _state["ua"] = UA_FALLBACK
                    _state["fallback_used"] = True
                    log(f"403 on {url} -> switching to fallback desktop Chrome UA")
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == max_retries:
                return resp
            ra = resp.headers.get("Retry-After")
            wait = float(ra) if ra and ra.strip().isdigit() else (2 ** attempt + random.uniform(0, 1))
            time.sleep(wait)
            continue
        return resp
    return last_resp


def cache_key(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


# ------------------------------------------------------------ nav / cats --
def norm_url(u):
    if u.startswith("/"):
        u = BASE + u
    return u.rstrip("/")


def slug_of(u):
    path = urlparse(u).path.strip("/")
    return path.split("/")[-1] if path else ""


def build_category_tree():
    """Parse gobilda.com homepage nav to get the real top-level -> sub hierarchy."""
    resp = fetch(BASE + "/")
    if resp is None or resp.status_code != 200:
        raise RuntimeError(f"Could not fetch homepage for nav: status={resp.status_code if resp else None}")
    soup = BeautifulSoup(resp.text, "html.parser")

    nav_pages = soup.find("nav", class_="navPages")
    top_hrefs = set()
    top_order = []
    if nav_pages:
        ul = nav_pages.find("ul")
        for li in ul.find_all("li", recursive=False):
            a = li.find("a")
            if not a or not a.get("href"):
                continue
            href = norm_url(a["href"])
            top_hrefs.add(href)
            top_order.append(href)

    my_menu = soup.find("nav", id="my-menu")
    if not my_menu:
        raise RuntimeError("Could not find #my-menu mega-menu on homepage")
    top_ul = my_menu.find("ul", recursive=False)

    nodes = []  # flat list of dicts: catId, name, parent, slug, sortOrder, href
    seen_slugs = {}
    sort_counter = 0
    collisions = []

    for li in top_ul.find_all("li", recursive=False):
        a = li.find("a", recursive=False)
        if not a or not a.get("href"):
            continue
        href = norm_url(a["href"])
        if href not in top_hrefs:
            continue  # skip non-catalog nav items (e.g. FTC info hub)
        name = (a.get("title") or a.get_text(strip=True)).strip()
        slug = slug_of(href)
        cat_id = slug
        if cat_id in seen_slugs:
            collisions.append((cat_id, href))
            cat_id = f"{slug}-{sort_counter}"
        seen_slugs[cat_id] = href
        top_node = {"catId": cat_id, "name": name, "parent": "", "slug": slug,
                    "sortOrder": sort_counter, "href": href}
        nodes.append(top_node)
        sort_counter += 1

        sub_ul = li.find("ul", recursive=False)
        if not sub_ul:
            continue
        for sli in sub_ul.find_all("li", recursive=False):
            sa = sli.find("a", recursive=False)
            if not sa or not sa.get("href"):
                continue
            shref = norm_url(sa["href"])
            sname = (sa.get("title") or sa.get_text(strip=True)).strip()
            sslug = slug_of(shref)
            scat_id = sslug
            if scat_id in seen_slugs:
                collisions.append((scat_id, shref))
                scat_id = f"{sslug}-{sort_counter}"
            seen_slugs[scat_id] = shref
            nodes.append({"catId": scat_id, "name": sname, "parent": cat_id,
                           "slug": sslug, "sortOrder": sort_counter, "href": shref})
            sort_counter += 1

    return nodes, collisions


# ----------------------------------------------------- category listings --
def fetch_category_page(url, page):
    norm = norm_url(url)
    key = cache_key(f"{norm}|p{page}")
    path = CACHE_CAT / f"{key}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    full = f"{norm}?limit=100&page={page}"
    resp = fetch(full)
    result = {"ok": False, "status": resp.status_code if resp is not None else None, "cards": []}
    if resp is not None and resp.status_code == 200:
        soup = BeautifulSoup(resp.text, "html.parser")
        cards = []
        for a in soup.select("a.card"):
            href = a.get("href")
            if not href:
                continue
            ctype = a.get("data-card-type") or "unknown"
            title = a.get("title") or a.get_text(strip=True)
            cards.append({"type": ctype, "href": norm_url(href), "title": (title or "").strip()})
        result = {"ok": True, "status": 200, "cards": cards}
    try:
        path.write_text(json.dumps(result), encoding="utf-8")
    except Exception:
        pass
    return result


def collect_products_recursive(start_url, max_pages=40):
    """BFS through this nav node's page(s); recurse into any nested
    'category' cards (goBILDA nests deeper than the 2-level nav shows).
    Returns the set of product URLs found anywhere in the subtree."""
    visited = set()
    queue = deque([norm_url(start_url)])
    products = set()
    while queue:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)
        page = 1
        while page <= max_pages:
            data = fetch_category_page(url, page)
            if not data.get("ok") or not data.get("cards"):
                break
            got_any = False
            for c in data["cards"]:
                if c["type"] == "product":
                    products.add(c["href"])
                    got_any = True
                elif c["type"] == "category":
                    if c["href"] not in visited:
                        queue.append(c["href"])
                    got_any = True
            if not got_any:
                break
            page += 1
    return products


def collect_direct_products(url, max_pages=40):
    """Only immediate product cards on this exact page (no recursion) --
    used for top-level nodes to catch products with no subcategory."""
    products = set()
    page = 1
    while page <= max_pages:
        data = fetch_category_page(url, page)
        if not data.get("ok") or not data.get("cards"):
            break
        got_any = False
        for c in data["cards"]:
            if c["type"] == "product":
                products.add(c["href"])
                got_any = True
            elif c["type"] == "category":
                got_any = True
        if not got_any:
            break
        page += 1
    return products


# --------------------------------------------------------- product pages --
def extract_product(html):
    """Returns (sku, name, desc, image, category, subcategory).
    category/subcategory come from the page's own BreadcrumbList JSON-LD
    (Home > Top > Sub > ... > ProductName) when present -- most product
    pages carry a full breadcrumb even when they lack Product-type JSON-LD."""
    soup = BeautifulSoup(html, "html.parser")
    sku = name = desc = image = None
    category = subcategory = ""
    for s in soup.find_all("script", type="application/ld+json"):
        raw = s.string
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        items = data if isinstance(data, list) else [data]
        for d in items:
            if not isinstance(d, dict):
                continue
            if d.get("@type") == "Product":
                sku = d.get("sku") or sku
                name = d.get("name") or name
                desc = d.get("description") or desc
                img = d.get("image")
                if isinstance(img, list):
                    img = img[0] if img else None
                if isinstance(img, dict):
                    img = img.get("url")
                image = img or image
            elif d.get("@type") == "BreadcrumbList":
                crumbs = []
                for item in d.get("itemListElement", []):
                    it = item.get("item") or {}
                    nm = it.get("name")
                    if nm:
                        crumbs.append(nm)
                # crumbs[0] is "Home", crumbs[-1] is the product name itself
                body = crumbs[1:-1] if len(crumbs) > 2 else []
                if body:
                    category = body[0]
                    subcategory = body[-1] if len(body) > 1 else ""

    if not name:
        og = soup.find("meta", property="og:title")
        if og and og.get("content"):
            name = og["content"]
        else:
            h1 = soup.find("h1")
            if h1:
                name = h1.get_text(strip=True)
    if not image:
        og = soup.find("meta", property="og:image")
        if og and og.get("content"):
            image = og["content"]
    if not desc:
        og = soup.find("meta", property="og:description") or soup.find("meta", attrs={"name": "description"})
        if og and og.get("content"):
            desc = og["content"]
    if not sku:
        # variant-selector pages (no Product JSON-LD) still render each
        # option's SKU in the productView markup; the first one is the
        # page's default-selected variant.
        el = soup.select_one("[data-product-sku]")
        if el and el.get("data-product-sku"):
            sku = el["data-product-sku"].strip()

    return sku, name, desc, image, category, subcategory


# goBILDA serves old / renamed / variant-specific product URLs as tiny
# client-side-redirect stub pages: HTTP 200, no JSON-LD, just a meta-refresh
# and a `window.location.href = "..."` to the real canonical URL (sometimes
# with a `?sku=XXXX` query param selecting a variant, sometimes to an
# external site like servocity.com for items goBILDA no longer stocks).
# `requests` never follows these since there's no real 3xx. Detect + follow.
_REDIRECT_PATTERNS = [
    re.compile(r'window\.location\.href\s*=\s*"([^"]+)"'),
    re.compile(r'<meta[^>]+http-equiv=["\']refresh["\'][^>]*content=["\'][^"\']*url=([^"\'>]+)["\']', re.I),
]


# `/rd-*` slugs and `*-on-servocity` slugs are goBILDA's own leftover
# cross-reference / "recently discontinued" / "see also" stub URLs -- not
# distinct products. Skip them outright rather than trying to extract a
# product from whatever they redirect to.
_NON_PRODUCT_RE = re.compile(r"/(rd-[^/]+|[^/]*-on-servocity)/?$", re.I)


def is_non_product_stub(url):
    return bool(_NON_PRODUCT_RE.search(urlparse(url).path))


def find_redirect_target(html, base_url):
    for pat in _REDIRECT_PATTERNS:
        m = pat.search(html)
        if m:
            return urljoin(base_url, m.group(1))
    return None


def _sku_from_hub_fragment(html, fragment):
    """Some redirect targets are landing/hub pages that bundle several
    related product families under `<h2 id="...">` anchors, e.g.
    /8mm-pitch-chain/#steel-chain. The enclosing container lists that
    family's member skus in data-children="sku_XXXX|sku_YYYY..."; the
    first one is the base/representative item. Once we have that sku,
    the page separately embeds a flat catalog-style JSON array with
    {"sku":"XXXX","name":"...","url":"...","image":{"data":"..."}}
    objects we can pull name/url/image from directly."""
    if not fragment:
        return None, None, None, None
    m = re.search(r'data-children="sku_([^"|]+)', html)
    if not m:
        return None, None, None, None
    sku = m.group(1)
    name = url = image = None
    m2 = re.search(r'"sku":"' + re.escape(sku) + r'","name":"([^"]*)","url":"([^"]*)"', html)
    if m2:
        name = m2.group(1).replace("\\/", "/")
        url = m2.group(2).replace("\\/", "/")
        m3 = re.search(r'"image":\{"data":"([^"]*)"', html[m2.end():m2.end() + 500])
        if m3:
            image = m3.group(1).replace("\\/", "/").replace("{:size}", "320x320")
    return sku, name, url, image


def _extract_with_redirect(url, html, depth=0):
    """Extract product fields from html fetched at url; if it's a stub
    redirect page, follow it (one hop, internal gobilda.com only) and
    extract from the target instead."""
    sku, name, desc, image, cat, subcat = extract_product(html)
    if name:
        return sku, name, desc, image, cat, subcat, None
    if depth >= 1:
        return sku, name, desc, image, cat, subcat, None
    target = find_redirect_target(html, url)
    if not target:
        return sku, name, desc, image, cat, subcat, None
    if urlparse(target).netloc not in ("", "www.gobilda.com", "gobilda.com"):
        return sku, name, desc, image, cat, subcat, target  # external -- can't follow, report it

    parsed = urlparse(target)
    resp2 = fetch(target)
    if resp2 is None or resp2.status_code != 200:
        return sku, name, desc, image, cat, subcat, target
    sku2, name2, desc2, image2, cat2, subcat2 = extract_product(resp2.text)
    if not sku2:
        qs_sku = None
        for part in parsed.query.split("&"):
            if part.startswith("sku="):
                qs_sku = part[len("sku="):]
        sku2 = qs_sku or sku2
    if not name2 and parsed.fragment:
        # landing/hub page (e.g. .../8mm-pitch-chain/#steel-chain) -- pull
        # the family's representative sku+name+image straight out of the
        # page's embedded catalog JSON.
        hsku, hname, _hurl, himage = _sku_from_hub_fragment(resp2.text, parsed.fragment)
        sku2 = sku2 or hsku
        name2 = name2 or hname
        image2 = image2 or himage
    return sku2, name2, desc2, image2, cat2, subcat2, target


def fetch_product_record(url):
    key = cache_key(norm_url(url))
    path = CACHE_PROD / f"{key}.json"
    if path.exists():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            # a record cached as "ok" but with no name is not usefully cached
            # (older run, or a redirect stub we didn't yet know to follow) --
            # treat as a cache miss so a fixed extractor gets another try.
            # "bcCategory" key presence marks a record produced by the
            # breadcrumb-aware extractor; older cache entries lack it and
            # must be redone once to backfill category/subcategory.
            if cached.get("ok") and cached.get("name") and "bcCategory" in cached:
                return cached
        except Exception:
            pass
    resp = fetch(url)
    record = {"url": url, "ok": False}
    if resp is not None and resp.status_code == 200:
        sku, name, desc, image, cat, subcat, redirect_target = _extract_with_redirect(url, resp.text)
        record = {"url": url, "ok": bool(name), "sku": sku, "name": name, "desc": desc, "image": image,
                   "bcCategory": cat, "bcSubcategory": subcat}
        if redirect_target:
            record["redirectTarget"] = redirect_target
    else:
        record["status"] = resp.status_code if resp is not None else None
    try:
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return record


def clean_desc(raw):
    if not raw:
        return ""
    text = BeautifulSoup(raw, "html.parser").get_text(" ", strip=True)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:500]


def sanitize_sku(sku):
    return re.sub(r"[^A-Za-z0-9._-]", "-", sku)


# --------------------------------------------------------------- images --
def process_image(sku, image_url):
    if not image_url:
        return "", False
    base = sanitize_sku(sku)
    webp_path = ASSETS / f"{base}.webp"
    rel_webp = f"assets/parts/{base}.webp"
    if webp_path.exists() and webp_path.stat().st_size > 1024:
        return rel_webp, True

    thumb_url = re.sub(r"/stencil/\d+x\d+/", "/stencil/320x320/", image_url)
    resp = fetch(thumb_url)
    if resp is None or resp.status_code != 200 or not resp.content:
        return "", False

    try:
        img = Image.open(BytesIO(resp.content))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGBA").convert("RGB") if img.mode == "P" else img
        img = img.convert("RGB")
        img.save(webp_path, "WEBP", quality=82)
        # very simple product photos (a plain rod/shaft on white, say) can
        # legitimately compress under 1KB at quality 82 -- bump quality
        # rather than accept a suspiciously tiny file.
        if webp_path.exists() and webp_path.stat().st_size <= 1024:
            img.save(webp_path, "WEBP", quality=95)
        if webp_path.exists() and webp_path.stat().st_size > 0:
            return rel_webp, True
        if webp_path.exists():
            webp_path.unlink()
    except Exception as e:
        log(f"WEBP convert failed for {sku}: {e}")

    jpg_path = ASSETS / f"{base}.jpg"
    try:
        jpg_path.write_bytes(resp.content)
        if jpg_path.exists() and jpg_path.stat().st_size > 1024:
            return f"assets/parts/{base}.jpg", True
        if jpg_path.exists():
            jpg_path.unlink()
    except Exception as e:
        log(f"raw image save failed for {sku}: {e}")
    return "", False


# ------------------------------------------------------------------ main --
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0,
                        help="Only process the first N products (for smoke testing). "
                             "Never modifies gb_products.txt on disk.")
    args = parser.parse_args()

    t0 = time.time()
    report = {"collisions": [], "cat_slug_collisions": [], "product_failures": [],
              "image_failures": [], "notes": []}

    all_urls = [l.strip() for l in PRODUCTS_TXT.read_text(encoding="utf-8").splitlines() if l.strip()]
    skipped_stub_urls = [u for u in all_urls if is_non_product_stub(u)]
    product_urls = [u for u in all_urls if not is_non_product_stub(u)]
    if args.limit and args.limit > 0:
        product_urls = product_urls[:args.limit]
        log(f"--limit {args.limit}: testing against a subset")
    log(f"Loaded {len(all_urls)} sitemap URLs: {len(product_urls)} real products, "
        f"{len(skipped_stub_urls)} skipped (rd-* / *-on-servocity cross-reference stubs)")

    # ---- 1. category tree from live nav ----
    log("Fetching homepage nav for category tree...")
    nav_nodes, cat_collisions = build_category_tree()
    report["cat_slug_collisions"] = cat_collisions
    top_nodes = [n for n in nav_nodes if n["parent"] == ""]
    sub_nodes = [n for n in nav_nodes if n["parent"] != ""]
    log(f"Nav tree: {len(top_nodes)} top-level, {len(sub_nodes)} subcategories")

    by_catid = {n["catId"]: n for n in nav_nodes}

    # ---- 2. product -> category mapping via recursive category crawl ----
    log("Crawling category listing pages (recursive, cached)...")
    sub_products = {}   # catId -> set(product urls)
    top_products = {}   # catId -> set(product urls, direct-only)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {}
        for n in sub_nodes:
            futs[ex.submit(collect_products_recursive, n["href"])] = ("sub", n["catId"])
        for n in top_nodes:
            futs[ex.submit(collect_direct_products, n["href"])] = ("top", n["catId"])
        done = 0
        for fut in as_completed(futs):
            kind, cat_id = futs[fut]
            try:
                result = fut.result()
            except Exception as e:
                log(f"category crawl failed for {cat_id}: {e}")
                result = set()
            if kind == "sub":
                sub_products[cat_id] = result
            else:
                top_products[cat_id] = result
            done += 1
            if done % 10 == 0:
                log(f"  category crawl progress: {done}/{len(futs)}")

    product_cat = {}  # normalized product url -> (category_name, subcategory_name)
    for cat_id, urls in sub_products.items():
        node = by_catid[cat_id]
        parent = by_catid.get(node["parent"])
        cat_name = parent["name"] if parent else node["name"]
        for u in urls:
            if u not in product_cat:
                product_cat[u] = (cat_name, node["name"])
    for cat_id, urls in top_products.items():
        node = by_catid[cat_id]
        for u in urls:
            if u not in product_cat:
                product_cat[u] = (node["name"], "")

    mapped_count = sum(1 for u in product_urls if norm_url(u) in product_cat)
    log(f"Category mapping resolved for {mapped_count}/{len(product_urls)} products "
        f"({len(product_urls) - mapped_count} will fall back to Uncategorized)")

    # ---- 3. product detail crawl ----
    log("Fetching product detail pages (cached, resumable)...")
    records = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(fetch_product_record, u): u for u in product_urls}
        done = 0
        for fut in as_completed(futs):
            u = futs[fut]
            try:
                records[u] = fut.result()
            except Exception as e:
                log(f"product fetch crashed for {u}: {e}")
                records[u] = {"url": u, "ok": False}
            done += 1
            if done % 200 == 0:
                log(f"  product crawl progress: {done}/{len(product_urls)}")

    # ---- 4. assemble + dedupe by sku ----
    by_sku = {}
    for u in product_urls:
        rec = records.get(u, {"ok": False})
        if not rec.get("ok"):
            rt = rec.get("redirectTarget")
            if rt:
                report["product_failures"].append(f"{u} (unresolvable redirect -> {rt})")
            else:
                report["product_failures"].append(f"{u} (fetch failed, status={rec.get('status')})")
            continue
        name = (rec.get("name") or "").strip()
        if not name:
            report["product_failures"].append(f"{u} (no name extracted)")
            continue
        sku = (rec.get("sku") or "").strip()
        has_real_sku = bool(sku)
        if not sku:
            slug = slug_of(u)
            sku = f"slug-{slug}"
        desc = clean_desc(rec.get("desc") or "")
        image_url = rec.get("image") or ""
        cat_name, subcat_name = product_cat.get(norm_url(u), ("", ""))
        if not cat_name:
            # fall back to this page's own BreadcrumbList (Home > Top > ... > Product)
            cat_name = (rec.get("bcCategory") or "").strip()
            subcat_name = (rec.get("bcSubcategory") or "").strip()
        if not cat_name:
            cat_name, subcat_name = "Uncategorized", ""

        candidate = {
            "sku": sku, "name": name, "category": cat_name, "subcategory": subcat_name,
            "imageUrl": image_url, "productUrl": u, "description": desc,
            "hasRealSku": has_real_sku,
        }
        if sku in by_sku:
            existing = by_sku[sku]
            # prefer: a real (non-slug-fallback) sku, then a resolved category,
            # then the longer description, as tie-breaks for the same sku
            # appearing at more than one URL (legacy alias slugs etc).
            existing_score = (existing["hasRealSku"], existing["category"] != "Uncategorized", len(existing["description"]))
            candidate_score = (candidate["hasRealSku"], candidate["category"] != "Uncategorized", len(candidate["description"]))
            if candidate_score > existing_score:
                report["collisions"].append(f"sku={sku}: kept {u} over {existing['productUrl']}")
                by_sku[sku] = candidate
            else:
                report["collisions"].append(f"sku={sku}: kept {existing['productUrl']} over {u}")
        else:
            by_sku[sku] = candidate

    log(f"{len(by_sku)} unique SKUs after dedupe ({len(report['collisions'])} collisions)")
    uncategorized_n = sum(1 for c in by_sku.values() if c["category"] == "Uncategorized")
    log(f"Uncategorized: {uncategorized_n}/{len(by_sku)} ({100*uncategorized_n/max(1,len(by_sku)):.1f}%)")

    # ---- 5. images ----
    log("Downloading + converting thumbnails (cached, resumable)...")
    skus_sorted = sorted(by_sku.keys())
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(process_image, sku, by_sku[sku]["imageUrl"]): sku for sku in skus_sorted}
        done = 0
        for fut in as_completed(futs):
            sku = futs[fut]
            try:
                local_path, ok = fut.result()
            except Exception as e:
                log(f"image processing crashed for {sku}: {e}")
                local_path, ok = "", False
            by_sku[sku]["localImage"] = local_path
            if not ok:
                report["image_failures"].append(sku)
            done += 1
            if done % 200 == 0:
                log(f"  image progress: {done}/{len(skus_sorted)}")

    # ---- 6. write outputs ----
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    parts = []
    for sku in skus_sorted:
        c = by_sku[sku]
        parts.append({
            "partId": f"gb-{sku}",
            "sku": sku,
            "name": c["name"],
            "category": c["category"],
            "subcategory": c["subcategory"],
            "imageUrl": c["imageUrl"],
            "localImage": c.get("localImage", ""),
            "productUrl": c["productUrl"],
            "description": c["description"],
            "location": "",
            "qtyTotal": 0,
            "qtyOut": 0,
            "unit": "ea",
            "active": True,
            "notes": "",
        })

    catalog = {"generatedAt": now_iso, "source": "gobilda.com", "count": len(parts), "parts": parts}
    (DOCS_DATA / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")

    categories = {
        "generatedAt": now_iso,
        "categories": [
            {"catId": n["catId"], "name": n["name"], "parent": n["parent"],
             "slug": n["slug"], "sortOrder": n["sortOrder"]}
            for n in nav_nodes
        ],
    }
    (DOCS_DATA / "categories.json").write_text(json.dumps(categories, ensure_ascii=False, indent=1), encoding="utf-8")

    # parts_import.csv -- matches Parts sheet columns A-P exactly
    with open(CSV_OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["PartID", "SKU", "Name", "Category", "Subcategory", "ImageURL", "LocalImage",
                    "ProductURL", "Description", "Location", "QtyTotal", "QtyOut", "Unit",
                    "Active", "Notes", "UpdatedAt"])
        for p in parts:
            w.writerow([
                p["partId"], p["sku"], p["name"], p["category"], p["subcategory"],
                p["imageUrl"], p["localImage"], p["productUrl"], p["description"],
                p["location"], p["qtyTotal"], p["qtyOut"], p["unit"],
                "TRUE" if p["active"] else "FALSE", p["notes"], now_iso,
            ])

    # ---- 7. report ----
    elapsed = time.time() - t0
    img_bytes = sum(f.stat().st_size for f in ASSETS.glob("*") if f.is_file())
    img_count = sum(1 for f in ASSETS.glob("*") if f.is_file())
    cat_counts = {}
    for p in parts:
        cat_counts[p["category"]] = cat_counts.get(p["category"], 0) + 1

    lines = []
    lines.append("# goBILDA crawl report\n")
    lines.append(f"Generated: {now_iso}  \nElapsed: {elapsed:.1f}s  \nHTTP requests made: {_counters['requests']}  \nHTTP failures: {_counters['failures']}  \nFallback UA used: {_state['fallback_used']}\n")
    lines.append(f"## Totals\n- sitemap URLs total: {len(all_urls)}\n- skipped non-product stubs (rd-* / *-on-servocity): {len(skipped_stub_urls)}\n- real product URLs processed: {len(product_urls)}\n- parts written to catalog.json: {len(parts)}\n- product fetch failures: {len(report['product_failures'])}\n- sku collisions (deduped): {len(report['collisions'])}\n- images on disk: {img_count}\n- image bytes on disk: {img_bytes} ({img_bytes/1024/1024:.1f} MB)\n- image failures (empty localImage): {len(report['image_failures'])}\n- uncategorized parts: {uncategorized_n} ({100*uncategorized_n/max(1,len(parts)):.1f}%)\n")
    lines.append(f"## Category tree\n- top-level: {len(top_nodes)}\n- subcategories: {len(sub_nodes)}\n- catId slug collisions: {len(report['cat_slug_collisions'])}\n")
    lines.append("### Parts per top-level category\n")
    for k, v in sorted(cat_counts.items(), key=lambda kv: -kv[1]):
        lines.append(f"- {k}: {v}\n")
    if report["product_failures"]:
        lines.append("\n## Product fetch failures\n")
        for x in report["product_failures"][:200]:
            lines.append(f"- {x}\n")
    if report["collisions"]:
        lines.append("\n## SKU collisions\n")
        for x in report["collisions"][:200]:
            lines.append(f"- {x}\n")
    if report["image_failures"]:
        lines.append("\n## Image download/convert failures\n")
        for x in report["image_failures"][:200]:
            lines.append(f"- {x}\n")
    if report["cat_slug_collisions"]:
        lines.append("\n## Category slug collisions\n")
        for x in report["cat_slug_collisions"]:
            lines.append(f"- {x}\n")
    REPORT_MD.write_text("".join(lines), encoding="utf-8")

    log(f"DONE in {elapsed:.1f}s. parts={len(parts)} images={img_count} ({img_bytes/1024/1024:.1f} MB)")
    log(f"Report written to {REPORT_MD}")


if __name__ == "__main__":
    main()
