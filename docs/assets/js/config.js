/* ============================================================================
   LabInventory - config.js
   The ONLY file Advay edits after deploying the backend.

   Paste the Apps Script Web App /exec URL between the quotes below and commit.
   Leave it empty and the site still works: it renders the seeded catalog from
   docs/data/catalog.json in read-only mode behind a visible banner.

   CONTRACT 7.1: nothing secret ever goes in this file. The /exec URL is public
   by design. No password, no token, no key.
   ========================================================================== */

export const API_URL = "";

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
