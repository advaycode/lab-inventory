# Lab Inventory

Parts inventory and checkout system for the robotics lab. Students request parts
from a phone; every checkout and return is timestamped and waits for admin
approval. Seeded with 2,027 goBILDA parts and their photos.

- **User site** — `docs/index.html` → https://advaycode.github.io/lab-inventory/
- **Admin site** — `docs/admin.html` → https://advaycode.github.io/lab-inventory/admin.html
- **Data** — one Google Sheet you own
- **Cost** — free. No server, no hosting bill, no third-party service.

## How the pieces fit

```
  Student's phone                    Your Google Sheet
  docs/index.html  ──┐            ┌── Parts  (2,027 rows)
                     ├─ HTTPS ─►  ├── Requests (the approval queue)
  Your laptop        │   Apps     ├── Categories
  docs/admin.html  ──┘   Script   ├── Log
                                  └── Config
```

GitHub Pages serves the two HTML pages. They talk to a Google Apps Script Web
App, which is the only code with permission to touch the Sheet. Nothing else can
write to your data.

## Setup, in order

1. **Create the Sheet and deploy the backend** — follow `backend/SETUP.md`
   step by step. It ends with you holding a `/exec` URL.
2. **Paste that URL** into `docs/assets/js/config.js` as `API_URL`.
3. **Load the goBILDA catalogue** into the Sheet:
   ```
   set LABINV_PASSWORD=your-admin-password
   python tools/seed_sheet.py --api-url "https://script.google.com/.../exec"
   ```
   Resumable — if it dies partway, run it again and it picks up where it stopped.
   (Manual fallback: import `build/parts_import.csv` into the `Parts` tab.)
4. **Commit and push.** GitHub Pages serves from `main` → `/docs`.

Until step 2 is done the site still works: it renders the catalogue from
`docs/data/catalog.json` in read-only mode behind a banner. That is the expected
first-run state, not a bug.

## Daily use

**Students** pick a part, enter name, team number, quantity, checkout date,
return date, and a one-line reason. They get a request ID and a "pending
approval" confirmation.

**You** open `admin.html`, sign in, and approve or deny from the queue. Stock
only moves on approval, and availability is re-checked at that moment — so if
two people request the last bearing, both sit as pending and you decide. Nothing
is ever oversold.

## Filling in your real inventory

The catalogue ships with `QtyTotal = 0` and blank locations for every part —
goBILDA tells us what exists, not what is on your shelves. In the admin part
editor, set the quantity you actually own and where it lives ("Shelf B3, Bin 12").
Anything left at 0 simply shows as unavailable.

Re-running the seeder later is safe: it refreshes names, photos and categories
but never overwrites quantities, locations, units, or notes you have entered.

## Provenance of the catalogue

| | |
|---|---|
| Parts | 2,027 |
| With photos | 2,027 (13.5 MB, mirrored to this repo) |
| Categorised from goBILDA's own navigation | 1,466 |
| Categorised by classifier | 532 — tagged `auto-categorized` in Notes |
| Left uncategorised | 29 |

goBILDA lists 2,384 URLs in its sitemap. Roughly 300 are redirect stubs
(`/rd-*`, `*-on-servocity`) rather than products, and a further handful are
category landing pages; those were excluded. About 568 real products exist in
the sitemap but are not linked from any browsable category — their breadcrumb is
just `Home > Product` — so no crawl can recover a category for them. Those were
labelled by a naive-Bayes classifier over part names and SKU series, trained on
the parts whose categories *were* recovered from goBILDA's navigation
(93.6% top-1 accuracy on a held-out split, applied only when confident).
**Every classifier-assigned part is flagged `auto-categorized` in its Notes**, so
you can filter and correct them in the admin UI.

## Regenerating the catalogue

```
python tools/crawl_gobilda.py        # crawl (resumable, cached under build/)
python tools/repair_catalog.py       # rebuild category tree from cached listings
python tools/classify_orphans.py     # label products no category links to
```

Be considerate with the crawler — goBILDA started refusing connections at around
5,000 requests. The cache under `build/cache/` means a re-run costs almost nothing.

## Layout

| Path | What |
|---|---|
| `CONTRACT.md` | The frozen API and data spec everything was built against |
| `docs/` | The website (GitHub Pages root) |
| `backend/Code.gs` | The entire backend |
| `backend/SETUP.md` | Click-by-click deployment |
| `tools/` | Crawler, catalogue repair, classifier, Sheet seeder |
| `build/` | Caches and scratch — gitignored |

## Security notes

- The admin password is stored as a salted SHA-256 hash in Apps Script
  Properties. It is never in this repo, never in the Sheet, never in a browser.
- Sessions use a 12-hour HMAC token held in `sessionStorage`, cleared on logout.
- `config.js` contains only the public `/exec` URL — no secrets.
- Strings written to the Sheet are sanitised against formula injection.
- If you ever think the password leaked, run `setAdminPassword` again; existing
  tokens die with the next key rotation.
