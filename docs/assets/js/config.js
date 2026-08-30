/* ============================================================================
   LabInventory - config.js
   The ONLY file Advay edits after deploying the backend.

   Paste the Apps Script Web App /exec URL between the quotes below and commit.
   Leave it empty and the site still works: it renders the seeded catalog from
   docs/data/catalog.json in read-only mode behind a visible banner.

   CONTRACT 7.1: nothing secret ever goes in this file. The /exec URL is public
   by design. No password, no token, no key.
   ========================================================================== */

export const API_URL = "https://script.google.com/macros/s/AKfycbzrQRE34sU7GJ497-nheHgb8_zQVW8q9CJQ2lq1Yf-a0SWN2TKbRlxy7nFFUQcxDhfDEA/exec";

/* Cosmetic + local data paths. Rarely need changing. */
export const SITE_TITLE = "Lab Inventory";

export const CATALOG_URL = "data/catalog.json";
export const CATEGORIES_URL = "data/categories.json";

/* Grid paging. 60 keeps first paint cheap and the observer does the rest. */
export const PAGE_SIZE = 60;

/* Search input debounce in ms. */
export const SEARCH_DEBOUNCE = 120;

/* Combobox result cap. Past this we tell the user to keep typing instead of
   rendering a list nobody can scan. */
export const COMBO_LIMIT = 50;

/* Client-side image downscale before uploadImage. Never post a raw phone photo. */
export const IMAGE_MAX_PX = 1280;
export const IMAGE_QUALITY = 0.85;

/* Network timeout in ms. Apps Script cold starts are slow but not this slow. */
export const REQUEST_TIMEOUT = 20000;

/* The four teams in the lab. The request form and the activity board both read
   this, so adding a team is a one-line change here. `number` is what gets
   stored in the Sheet; `name` is only ever shown. */
export const TEAMS = [
  { number: "26588", name: "Midnight" },
  { number: "4997",  name: "Masquerade" },
  { number: "1386",  name: "Maelstrom" },
  { number: "1369",  name: "Mythos" },
];

export const teamLabel = (n) => {
  const t = TEAMS.find((x) => x.number === String(n || "").trim());
  return t ? `${t.name} ${t.number}` : (n ? String(n) : "Unknown team");
};
