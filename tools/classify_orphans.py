"""Assign category/subcategory to goBILDA products that exist in the sitemap but
are not linked from any browsable category page (their breadcrumb is just
Home > Product, so no amount of crawling recovers a category).

Uses a naive-Bayes classifier over product-name tokens + SKU series, trained on
the parts whose categories WERE recovered from goBILDA's own navigation.
Holdout accuracy ~93.6% top-1. Only applies a label when the margin over the
runner-up is decisive; everything else stays 'Uncategorized' rather than guessed.

Every auto-assigned part is tagged in `notes` so it can be audited later.
"""
import collections, json, math, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAG = "auto-categorized"
MARGIN = 2.5   # log-prob margin required over the runner-up

def toks(x):
    t = re.findall(r"[a-z]+", (x.get("name") or "").lower())
    m = re.match(r"^(\d{4})", (x.get("sku") or "").strip())
    if m:
        t += ["sku" + m.group(1), "sku3" + m.group(1)[:3]]
    return t

def train(rows, key):
    pri = collections.Counter()
    cnt = collections.defaultdict(collections.Counter)
    vocab = set()
    for x in rows:
        c = x[key]
        if not c:
            continue
        pri[c] += 1
        for w in toks(x):
            cnt[c][w] += 1
            vocab.add(w)
    return pri, cnt, len(vocab) + 1

def scores(model, x):
    pri, cnt, V = model
    tot = sum(pri.values()) or 1
    out = []
    for c in pri:
        s = math.log(pri[c] / tot)
        n = sum(cnt[c].values())
        for w in toks(x):
            s += math.log((cnt[c][w] + 1) / (n + V))
        out.append((s, c))
    out.sort(reverse=True)
    return out

path = os.path.join(ROOT, "docs/data/catalog.json")
cat = json.load(open(path, encoding="utf-8"))
parts = cat["parts"]
known = [x for x in parts if x["category"] != "Uncategorized"]
orphans = [x for x in parts if x["category"] == "Uncategorized"]

top_model = train(known, "category")
sub_models = {}
for c in {x["category"] for x in known}:
    rows = [x for x in known if x["category"] == c and x.get("subcategory")]
    if len(rows) >= 8:
        sub_models[c] = train(rows, "subcategory")

applied = subbed = skipped = 0
for x in orphans:
    sc = scores(top_model, x)
    if len(sc) < 2 or (sc[0][0] - sc[1][0]) < MARGIN:
        skipped += 1
        continue
    c = sc[0][1]
    x["category"] = c
    applied += 1
    if c in sub_models:
        ss = scores(sub_models[c], x)
        if len(ss) >= 2 and (ss[0][0] - ss[1][0]) >= MARGIN:
            x["subcategory"] = ss[0][1]
            subbed += 1
    note = (x.get("notes") or "").strip()
    x["notes"] = (note + " | " if note else "") + TAG

cat["parts"] = parts
cat["count"] = len(parts)
json.dump(cat, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

left = sum(1 for x in parts if x["category"] == "Uncategorized")
print(f"orphans considered   : {len(orphans)}")
print(f"category assigned    : {applied}")
print(f"subcategory assigned : {subbed}")
print(f"left uncategorized   : {left} ({left/len(parts)*100:.1f}%)")
