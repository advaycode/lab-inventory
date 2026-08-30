# LabInventory — FROZEN CONTRACT v1

Robotics lab inventory + checkout system. Built by: crawler agent, backend agent, UI agent.

**This file is frozen. Build to it exactly. If something here is wrong or impossible, report it in your final message — do not silently deviate.**

Owner: Advay (advay.awesomer@gmail.com). Repo: `advaycode/lab-inventory`.
Local root: `C:/Users/advay/Obsidian/LabInventory/`
Live URL (target): `https://advaycode.github.io/lab-inventory/`

## 0. Architecture (fixed)

- **Frontend**: 100% static, no build step, vanilla ES modules. Served from `docs/` via GitHub Pages.
- **Backend**: Google Apps Script Web App bound to ONE Google Spreadsheet. This is the only server.
- **Data**: the Google Sheet. The repo also ships `docs/data/catalog.json` as a seed/offline fallback.
- **Images**: mirrored to `docs/assets/parts/<sku>.webp` (repo) + goBILDA CDN URL kept as fallback.
- No frameworks, no npm, no bundler, no backend server, no paid services. Everything free.

## 1. Directory layout (fixed)

```
LabInventory/
  CONTRACT.md              <- this file
  README.md                <- setup guide (integration agent)
  docs/                    <- GitHub Pages root
    index.html             <- USER side
    admin.html             <- ADMIN side
    assets/css/theme.css   <- shared design tokens + base
    assets/css/app.css     <- user side styles
    assets/css/admin.css   <- admin side styles
    assets/js/config.js    <- { API_URL } single source of truth, Advay edits after deploy
    assets/js/api.js       <- ALL network calls live here. Nothing else calls fetch().
    assets/js/store.js     <- catalog cache + search index
    assets/js/app.js       <- user side logic
    assets/js/admin.js     <- admin side logic
    assets/parts/<sku>.webp
    data/catalog.json      <- seed catalog (crawler output)
    data/categories.json   <- seed category tree (crawler output)
  backend/Code.gs          <- Apps Script
  backend/appsscript.json  <- Apps Script manifest
  backend/SETUP.md         <- exact click-by-click deploy steps
  tools/crawl_gobilda.py   <- crawler
  tools/seed_sheet.py      <- pushes catalog.json into the Sheet via the API
  build/                   <- scratch, gitignored
```

## 2. Data model — Google Sheet tabs (fixed names, fixed column order, row 1 = header)

### Tab `Parts`

| col | name | notes |
|--|--|--|
| A | PartID | stable string. `gb-<sku>` for goBILDA, `lab-<6hex>` for custom |
| B | SKU | goBILDA part number e.g. `3204-0001-0001`, or admin-entered |
| C | Name | product name |
| D | Category | top-level category name |
| E | Subcategory | 2nd level, may be "" |
| F | ImageURL | absolute CDN url (fallback) |
| G | LocalImage | repo-relative e.g. `assets/parts/3204-0001-0001.webp`, may be "" |
| H | ProductURL | goBILDA product page, may be "" |
| I | Description | admin-editable long text |
| J | Location | admin-editable e.g. "Shelf B3, Bin 12" |
| K | QtyTotal | integer, how many the lab owns |
| L | QtyOut | integer, currently checked out (system-maintained, never hand-edit) |
| M | Unit | "ea", "pack", "set" — default "ea" |
| N | Active | TRUE/FALSE. FALSE = hidden from user side |
| O | Notes | admin free text |
| P | UpdatedAt | ISO8601 UTC |

`QtyAvailable` is DERIVED = `QtyTotal - QtyOut`. Never stored. Never negative.

### Tab `Requests`

| col | name | notes |
|--|--|--|
| A | RequestID | `req-<epochms>-<4hex>` |
| B | CreatedAt | ISO8601 UTC — the timestamp of submission |
| C | Type | `checkout` or `return` |
| D | Name | user's full name |
| E | TeamNumber | string (e.g. `4997`) |
| F | PartID | FK to Parts.A |
| G | SKU | denormalized snapshot |
| H | PartName | denormalized snapshot |
| I | Quantity | positive integer |
| J | UserNote | user's mini description / reason |
| K | CheckoutDate | `YYYY-MM-DD` (date they take it) |
| L | ReturnDate | `YYYY-MM-DD` (date they promise it back) |
| M | Status | `pending`, `approved`, `denied`, `returned`, `cancelled` |
| N | AdminNote | reason for denial etc. |
| O | DecidedAt | ISO8601 UTC or "" |
| P | DecidedBy | "admin" or "" |
| Q | LinkedRequestID | for `return` rows: the RequestID of the checkout being returned; else "" |

### Tab `Categories`

`A CatID | B Name | C Parent (CatID or "") | D Slug | E SortOrder | F Active`

### Tab `Log`

`A At (ISO8601) | B Actor | C Action | D Target | E Detail (JSON string)`

### Tab `Config`

Key/value, `A Key | B Value`. Seeded keys: `siteTitle`, `catalogVersion`, `requireApproval` (TRUE).

**Secrets (admin password hash, HMAC key) live in Script Properties, NEVER in the Sheet, NEVER in the repo.**

## 3. Inventory math (fixed — the ONLY place quantities change)

- Submitting a request changes nothing. `pending` reserves nothing.
- Admin **approves a `checkout`** then `QtyOut += Quantity`. Rejected server-side with `INSUFFICIENT_STOCK` if `Quantity > QtyTotal - QtyOut`.
- Admin **approves a `return`** then `QtyOut -= Quantity` (clamped at 0), and the linked checkout row's Status becomes `returned`.
- Deny changes nothing. Status becomes `denied`.
- All mutations take a `LockService.getScriptLock()` for up to 20s. Non-negotiable — concurrent approvals must not corrupt counts.

## 4. HTTP API (fixed)

Base: the Apps Script `/exec` URL, stored in `docs/assets/js/config.js` as `export const API_URL = "..."`.

**Transport rules (critical, do not deviate):**

- Reads use `GET ${API_URL}?action=<name>&<params>` — Apps Script's redirect to `script.googleusercontent.com` carries `Access-Control-Allow-Origin: *`, so plain `fetch()` works.
- Writes use `POST ${API_URL}` with `headers: {'Content-Type': 'text/plain;charset=utf-8'}` and a JSON string body. **Must be `text/plain` — `application/json` triggers a CORS preflight that Apps Script cannot answer.** Never send custom headers, for the same reason. The auth token goes in the JSON body, not a header.
- `redirect: 'follow'` (the default). No credentials, no cookies.

**Every response is JSON, HTTP 200, shaped:**

```json
{ "ok": true,  "data": {} }
{ "ok": false, "error": "CODE", "message": "human readable" }
```

Error codes: `BAD_ACTION` `BAD_INPUT` `UNAUTHORIZED` `NOT_FOUND` `INSUFFICIENT_STOCK` `LOCKED` `SERVER`.

### Public actions (no auth)

| action | method | params / body | data |
|--|--|--|--|
| `ping` | GET | — | `{version, time}` |
| `catalog` | GET | `since?` (catalogVersion) | `{version, categories:[Cat], parts:[Part]}`; if `since` matches current version, `{version, unchanged:true}` |
| `part` | GET | `id` | `{part: Part}` |
| `submit` | POST | `{action:"submit", type, name, teamNumber, partId, quantity, userNote, checkoutDate, returnDate, linkedRequestId}` | `{requestId, status:"pending"}` |
| `myRequests` | POST | `{action:"myRequests", name, teamNumber}` | `{requests:[Request]}` — matched case-insensitively on trimmed name + team |

### Admin actions (auth required)

Body must include `token`. Obtain via `login`.

| action | body | data |
|--|--|--|
| `login` | `{action:"login", password}` | `{token, expiresAt}` — token = base64url HMAC-SHA256 payload, 12h TTL |
| `pending` | `{action:"pending", token}` | `{requests:[Request]}` status=pending, newest first |
| `requests` | `{action:"requests", token, status, limit, offset}` | `{requests:[Request], total}` |
| `decide` | `{action:"decide", token, requestId, decision:"approve"|"deny", adminNote}` | `{request: Request, part: Part}` |
| `upsertPart` | `{action:"upsertPart", token, part:{}}` | `{part: Part}` — omit `partId` to create |
| `deletePart` | `{action:"deletePart", token, partId}` | `{deleted:true}` — soft delete: sets Active=FALSE |
| `adjustQty` | `{action:"adjustQty", token, partId, qtyTotal}` | `{part: Part}` |
| `uploadImage` | `{action:"uploadImage", token, partId, filename, mimeType, dataBase64}` | `{imageUrl}` — saves to Drive folder `LabInventory Images`, sets link-sharing, returns `https://drive.google.com/thumbnail?id=<id>&sz=w640` |
| `bulkImport` | `{action:"bulkImport", token, parts:[Part], mode:"upsert"}` | `{inserted, updated}` — chunked, max 400 parts per call |
| `stats` | `{action:"stats", token}` | `{totalParts, totalUnits, unitsOut, pendingCount, overdue:[Request]}` |

### JSON shapes

```ts
Part = { partId, sku, name, category, subcategory, imageUrl, localImage,
         productUrl, description, location, qtyTotal, qtyOut, qtyAvailable,
         unit, active, notes, updatedAt }

Cat  = { catId, name, parent, slug, sortOrder }

Request = { requestId, createdAt, type, name, teamNumber, partId, sku, partName,
            quantity, userNote, checkoutDate, returnDate, status, adminNote,
            decidedAt, decidedBy, linkedRequestId }
```

## 5. Crawler output contract

`docs/data/catalog.json`:

```json
{ "generatedAt":"ISO", "source":"gobilda.com", "count":0,
  "parts":[ {"partId":"","sku":"","name":"","category":"","subcategory":"",
             "imageUrl":"","localImage":"","productUrl":"","description":"",
             "location":"", "qtyTotal":0, "qtyOut":0, "unit":"ea",
             "active":true, "notes":""} ] }
```

`docs/data/categories.json`: `{ "generatedAt":"ISO", "categories":[Cat] }`

- `partId` = `gb-<sku>`. Every part MUST have a non-empty unique sku; if goBILDA omits one, derive it from the URL slug and prefix `slug-`.
- `qtyTotal` seeds to **0** — Advay fills real counts in the admin UI. `location` seeds to `""`.
- `description` = goBILDA's short description, plain text, HTML stripped, max 500 chars. Advay overwrites later.
- The category tree must mirror goBILDA's own navigation hierarchy (top-level nav then subcategory).

## 6. Design contract (UI agent owns everything else)

- **Palette: grey + red only.** Greys carry the interface; red is the single accent (primary actions, alerts, active state). No blue, green, purple, or teal anywhere, except semantic success/error microstates derived from the grey/red family. Both light and dark must work; dark is the default.
- **Bottom-left credit, on every page**: fixed position, exact text `created by Advay`, lowercase, VERY small but genuinely readable — `font-size: 9px`, `letter-spacing: .06em`, muted grey, `opacity: .75`. It must never overlap interactive controls, must sit above page content in z-order, and must remain real text in the DOM.
- User side is deliberately minimal: **name, team number, part (searchable dropdown), quantity, checkout date, return date, mini description, submit.** Plus catalog browse/search showing live availability. Nothing else. It must be usable by a tired teenager on a phone in a loud lab.
- Admin side: pending-approval queue (approve/deny in one click, optional note), part editor (add/edit part with description, location, quantity, photo upload), search, stats. Must never be reachable without the password.
- Every quantity shown to a user is `qtyAvailable`, labelled clearly, with `qtyTotal` as secondary text.
- Accessible: real `<label>`s, visible focus rings, 44px touch targets, `prefers-reduced-motion` respected, WCAG AA contrast.

## 7. Non-negotiables

1. No secret, password, token, or API key is ever committed to the repo. `config.js` holds only the public `/exec` URL.
2. The frontend must degrade gracefully: if `API_URL` is unset or the backend is unreachable, the catalog still renders from `docs/data/catalog.json` in read-only mode, with a visible banner.
3. All timestamps are written server-side in UTC ISO8601. Dates the user picks (`checkoutDate` / `returnDate`) stay `YYYY-MM-DD` strings.
4. Input validation happens on BOTH sides; the server is authoritative. Quantity is an integer 1..999. Name 1..80 chars. TeamNumber 1..12 chars.
5. Never trust client-sent `qtyOut`, `status`, `decidedAt`, or `partId`-on-create.
6. `api.js` is the only file that calls `fetch`.
