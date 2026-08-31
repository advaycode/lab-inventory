/* ============================================================================
   LabInventory - api.js
   CONTRACT 6.11: this is the ONLY file in the project that calls fetch().

   Transport rules are fixed by CONTRACT 4 and are easy to break by accident:
     - reads  : GET  `${API_URL}?action=...`  (the googleusercontent redirect
                carries Access-Control-Allow-Origin: *)
     - writes : POST `${API_URL}` with Content-Type text/plain;charset=utf-8
                and a JSON *string* body. application/json would trigger a
                CORS preflight that Apps Script cannot answer. No custom
                headers, ever, for the same reason. The token rides in the
                body, not in a header.
   ========================================================================== */

import { API_URL, CATALOG_URL, CATEGORIES_URL, REQUEST_TIMEOUT } from "./config.js";

/* --------------------------------------------------------------------------
   Errors
   -------------------------------------------------------------------------- */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? 0;
  }
}

/** True when the network layer is even worth attempting. */
export function hasApi() {
  return typeof API_URL === "string" && /^https?:\/\//i.test(API_URL.trim());
}

/* --------------------------------------------------------------------------
   Admin token. sessionStorage ONLY (CONTRACT: never localStorage), cleared on
   logout and automatically on any UNAUTHORIZED response. The password itself
   is never stored anywhere, not even for a moment.
   -------------------------------------------------------------------------- */

const TOKEN_KEY = "labinv.token";
const EXPIRY_KEY = "labinv.token.exp";

export function setToken(token, expiresAt) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (expiresAt) sessionStorage.setItem(EXPIRY_KEY, String(expiresAt));
  } catch { /* private mode: stay logged in for this page view only */ }
}

export function getToken() {
  try {
    const exp = sessionStorage.getItem(EXPIRY_KEY);
    if (exp && Date.parse(exp) && Date.parse(exp) < Date.now()) {
      clearToken();
      return null;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch { return null; }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
  } catch { /* nothing to clear */ }
}

/** Fired when the server rejects our token. admin.js listens and bounces to login. */
function announceUnauthorized() {
  clearToken();
  window.dispatchEvent(new CustomEvent("labinv:unauthorized"));
}

/* --------------------------------------------------------------------------
   Transport
   -------------------------------------------------------------------------- */

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "AbortError")), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function unwrap(payload, status) {
  if (!payload || typeof payload !== "object") {
    throw new ApiError("SERVER", "The server sent something that was not JSON.", status);
  }
  if (payload.ok === true) return payload.data ?? {};
  const code = payload.error || "SERVER";
  if (code === "UNAUTHORIZED") announceUnauthorized();
  throw new ApiError(code, payload.message || code, status);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      "SERVER",
      res.ok
        ? "The backend replied with a page instead of JSON. Re-deploy the Apps Script with access set to Anyone."
        : `Backend returned HTTP ${res.status}.`,
      res.status
    );
  }
}

/** GET read. */
async function apiGet(action, params = {}) {
  if (!hasApi()) throw new ApiError("SERVER", "API_URL is not set in config.js.", 0);
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const t = withTimeout(REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(url.toString(), { method: "GET", redirect: "follow", signal: t.signal });
  } catch (e) {
    throw new ApiError("SERVER", e?.name === "AbortError"
      ? "The backend did not answer in time."
      : "Could not reach the backend.", 0);
  } finally { t.done(); }
  return unwrap(await readJson(res), res.status);
}

/** POST write. text/plain is load-bearing, do not "fix" it to application/json. */
async function apiPost(body) {
  if (!hasApi()) throw new ApiError("SERVER", "API_URL is not set in config.js.", 0);
  const t = withTimeout(REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
  } catch (e) {
    throw new ApiError("SERVER", e?.name === "AbortError"
      ? "The backend did not answer in time."
      : "Could not reach the backend.", 0);
  } finally { t.done(); }
  return unwrap(await readJson(res), res.status);
}

/** Authenticated POST: injects the stored token, fails fast when absent. */
function apiAuth(body) {
  const token = getToken();
  if (!token) {
    announceUnauthorized();
    return Promise.reject(new ApiError("UNAUTHORIZED", "Signed out. Enter the password again.", 401));
  }
  return apiPost({ ...body, token });
}

/* --------------------------------------------------------------------------
   Seed data (CONTRACT 7.2). Shipped in the repo so the catalog renders even
   with no backend at all. Also the source of truth before Advay deploys.
   -------------------------------------------------------------------------- */

async function loadLocalJson(path, what) {
  let res;
  try {
    res = await fetch(path, { cache: "no-cache" });
  } catch {
    throw new ApiError("NOT_FOUND", `Could not load ${what}.`, 0);
  }
  if (!res.ok) throw new ApiError("NOT_FOUND", `${what} is not in the repo yet (${path}).`, res.status);
  try {
    return await res.json();
  } catch {
    throw new ApiError("SERVER", `${what} is not valid JSON.`, res.status);
  }
}

export function loadSeedCatalog() { return loadLocalJson(CATALOG_URL, "the seed catalog"); }
export function loadSeedCategories() { return loadLocalJson(CATEGORIES_URL, "the category tree"); }

/* --------------------------------------------------------------------------
   Public actions
   -------------------------------------------------------------------------- */

export const ping = () => apiGet("ping");
export const getCatalog = (since) => apiGet("catalog", { since });
export const getPart = (id) => apiGet("part", { id });

export const board = (limit = 200) => apiGet("board", { limit });
export const submitRequest = (payload) => apiPost({ action: "submit", ...payload });
export const myRequests = (name, teamNumber) =>
  apiPost({ action: "myRequests", name, teamNumber });

/* --------------------------------------------------------------------------
   Admin actions
   -------------------------------------------------------------------------- */

export async function login(password) {
  const data = await apiPost({ action: "login", password });
  if (!data?.token) throw new ApiError("UNAUTHORIZED", "No token came back from login.", 401);
  setToken(data.token, data.expiresAt);
  return data;
}

export function logout() { clearToken(); }

export const pendingRequests = () => apiAuth({ action: "pending" });
export const listRequests = (status, limit = 100, offset = 0) =>
  apiAuth({ action: "requests", status, limit, offset });
export const decide = (requestId, decision, adminNote = "", force = false) =>
  apiAuth({ action: "decide", requestId, decision, adminNote, force });
export const upsertPart = (part) => apiAuth({ action: "upsertPart", part });
export const deletePart = (partId) => apiAuth({ action: "deletePart", partId });
export const adjustQty = (partId, qtyTotal) => apiAuth({ action: "adjustQty", partId, qtyTotal });
export const uploadImage = (partId, filename, mimeType, dataBase64) =>
  apiAuth({ action: "uploadImage", partId, filename, mimeType, dataBase64 });
export const bulkLocation = (partIds, location) =>
  apiAuth({ action: "bulkLocation", partIds, location });
export const bulkImport = (parts, mode = "upsert") =>
  apiAuth({ action: "bulkImport", parts, mode });
export const stats = () => apiAuth({ action: "stats" });
