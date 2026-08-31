/**
 * LabInventory backend — Google Apps Script Web App
 * Built to CONTRACT.md sections 2, 3, 4, 7. Do not deviate from action names,
 * parameter names, response keys, or error codes without updating the contract.
 *
 * One-time editor setup: run setup(), then setAdminPassword("..."), then
 * deploy as a Web App. See backend/SETUP.md for click-by-click instructions.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var SCRIPT_VERSION = '1.3.0-override';  // bump on every deploy so ?action=ping proves which code is live

var PARTS_HEADERS = ['PartID', 'SKU', 'Name', 'Category', 'Subcategory', 'ImageURL',
  'LocalImage', 'ProductURL', 'Description', 'Location', 'QtyTotal', 'QtyOut',
  'Unit', 'Active', 'Notes', 'UpdatedAt'];

var REQUESTS_HEADERS = ['RequestID', 'CreatedAt', 'Type', 'Name', 'TeamNumber', 'PartID',
  'SKU', 'PartName', 'Quantity', 'UserNote', 'CheckoutDate', 'ReturnDate', 'Status',
  'AdminNote', 'DecidedAt', 'DecidedBy', 'LinkedRequestID'];

var CATEGORIES_HEADERS = ['CatID', 'Name', 'Parent', 'Slug', 'SortOrder', 'Active'];

var LOG_HEADERS = ['At', 'Actor', 'Action', 'Target', 'Detail'];

var CONFIG_HEADERS = ['Key', 'Value'];

var CACHE_CHUNK_SIZE = 90000;   // stay well under the ~100KB per-key cache cap
var CACHE_TTL_SECONDS = 21600;  // 6h
var FORMAT_ROWS = 20000;        // rows to pre-format so future growth never hits the date-autoconvert bug
var LOG_TRIM_AT = 6000;
var LOG_TRIM_KEEP = 5000;

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    var result;
    if (action === 'ping') {
      result = ok({ version: SCRIPT_VERSION, time: nowIso() });
    } else if (action === 'catalog') {
      result = catalogAction(e.parameter.since);
    } else if (action === 'part') {
      result = partAction(e.parameter.id);
    } else if (action === 'board') {
      result = boardAction(e.parameter.limit);
    } else {
      result = fail('BAD_ACTION', 'Unknown action: ' + action);
    }
    return respond(result);
  } catch (ex) {
    logError('doGet', ex);
    return respond(fail('SERVER', 'Something went wrong.'));
  }
}

function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseEx) {
      return respond(fail('BAD_INPUT', 'Malformed JSON body.'));
    }
    var action = body.action || '';
    var result;
    switch (action) {
      case 'login':       result = loginAction(body); break;
      case 'submit':       result = submitAction(body); break;
      case 'myRequests':   result = myRequestsAction(body); break;
      case 'pending':      result = authGuard(body, pendingAction); break;
      case 'requests':     result = authGuard(body, requestsAction); break;
      case 'decide':       result = authGuard(body, decideAction); break;
      case 'upsertPart':   result = authGuard(body, upsertPartAction); break;
      case 'deletePart':   result = authGuard(body, deletePartAction); break;
      case 'adjustQty':    result = authGuard(body, adjustQtyAction); break;
      case 'uploadImage':  result = authGuard(body, uploadImageAction); break;
      case 'bulkImport':   result = authGuard(body, bulkImportAction); break;
      case 'bulkLocation': result = authGuard(body, bulkLocationAction); break;
      case 'stats':        result = authGuard(body, statsAction); break;
      default:             result = fail('BAD_ACTION', 'Unknown action: ' + action);
    }
    return respond(result);
  } catch (ex) {
    logError('doPost', ex);
    return respond(fail('SERVER', 'Something went wrong.'));
  }
}

// The ONE place a response is built.
function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok(data) { return { ok: true, data: data }; }
function fail(code, message) { return { ok: false, error: code, message: message }; }

function authGuard(body, fn) {
  var payload = verifyToken(body && body.token);
  if (!payload) return fail('UNAUTHORIZED', 'Invalid or expired session.');
  return fn(body);
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

function catalogAction(since) {
  var current = getConfigVal('catalogVersion', '0');
  if (since && String(since) === String(current)) {
    return ok({ version: current, unchanged: true });
  }

  var cacheKey = 'catalog_' + current;
  var cached = cacheGetChunked(cacheKey);
  if (cached) {
    try {
      return ok(JSON.parse(cached));
    } catch (e) { /* fall through and rebuild */ }
  }

  var partRows = readSheetAsObjects(sh('Parts'), PARTS_HEADERS);
  var parts = partRows.map(partToApi); // all parts, including inactive — the client filters for display

  var catRows = readSheetAsObjects(sh('Categories'), CATEGORIES_HEADERS);
  var categories = catRows
    .filter(function (c) { return c.Active !== false && c.Active !== 'FALSE'; })
    .map(categoryToApi);

  var dataObj = { version: current, categories: categories, parts: parts };
  var str = JSON.stringify(dataObj);
  cacheSetChunked(cacheKey, str, CACHE_TTL_SECONDS);
  return ok(dataObj);
}

/**
 * Public activity board: who has what, and where each request stands.
 *
 * PUBLIC AND UNAUTHENTICATED by design -- the whole team is meant to see it.
 * It therefore returns only what a teammate needs to read the board and
 * deliberately withholds the free-text fields, which are where people write
 * things they did not expect strangers to read: UserNote and AdminNote are
 * never included. Newest first, capped, and cached for a minute so a room
 * full of phones refreshing does not hammer the sheet.
 */
function boardAction(limitRaw) {
  var limit = coerceInt(limitRaw, 1, 500, 200);
  var cache = CacheService.getScriptCache();
  var key = 'board_' + limit;
  var hit = cache.get(key);
  if (hit) {
    try { return ok(JSON.parse(hit)); } catch (e) { /* rebuild below */ }
  }

  var rows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    var r = rows[i];
    if (!r.RequestID) continue;
    out.push({
      requestId: String(r.RequestID),
      createdAt: asIsoStr(r.CreatedAt),
      type: String(r.Type || ''),
      name: String(r.Name || ''),
      teamNumber: String(r.TeamNumber || ''),
      partId: String(r.PartID || ''),
      sku: String(r.SKU || ''),
      partName: String(r.PartName || ''),
      quantity: coerceInt(r.Quantity, 0, 999999, 0),
      checkoutDate: asDateStr(r.CheckoutDate),
      returnDate: asDateStr(r.ReturnDate),
      status: String(r.Status || ''),
      decidedAt: r.DecidedAt ? asIsoStr(r.DecidedAt) : '',
      linkedRequestId: String(r.LinkedRequestID || '')
    });
  }

  var data = { requests: out, total: rows.length };
  try { cache.put(key, JSON.stringify(data), 60); } catch (e) { /* oversized: skip cache */ }
  return ok(data);
}

function partAction(id) {
  if (!id) return fail('BAD_INPUT', 'Missing id.');
  var rows = readSheetAsObjects(sh('Parts'), PARTS_HEADERS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].PartID === id) return ok({ part: partToApi(rows[i]) });
  }
  return fail('NOT_FOUND', 'Part not found.');
}

function submitAction(body) {
  var type = body.type;
  if (type !== 'checkout' && type !== 'return') return fail('BAD_INPUT', 'type must be checkout or return.');

  var name = sanitizeStr(body.name, 80);
  if (!name) return fail('BAD_INPUT', 'name must be 1-80 chars.');

  var teamNumber = sanitizeStr(body.teamNumber, 12);
  if (!teamNumber) return fail('BAD_INPUT', 'teamNumber must be 1-12 chars.');

  var partId = String(body.partId || '').trim();
  if (!partId) return fail('BAD_INPUT', 'partId is required.');

  var partRows = readSheetAsObjects(sh('Parts'), PARTS_HEADERS);
  var part = null;
  for (var i = 0; i < partRows.length; i++) {
    if (partRows[i].PartID === partId) { part = partRows[i]; break; }
  }
  if (!part) return fail('NOT_FOUND', 'Part not found.');

  var quantity = strictInt(body.quantity, 1, 999);
  if (isNaN(quantity)) return fail('BAD_INPUT', 'quantity must be an integer 1-999.');

  var userNote = sanitizeStr(body.userNote, 500);

  var checkoutDate = String(body.checkoutDate || '');
  var returnDate = String(body.returnDate || '');
  if (!isValidDateStr(checkoutDate) || !isValidDateStr(returnDate)) {
    return fail('BAD_INPUT', 'checkoutDate and returnDate must be YYYY-MM-DD.');
  }
  if (returnDate < checkoutDate) return fail('BAD_INPUT', 'returnDate must be on or after checkoutDate.');

  var linkedRequestId = '';
  if (type === 'return') {
    linkedRequestId = String(body.linkedRequestId || '').trim();
    if (!linkedRequestId) return fail('BAD_INPUT', 'linkedRequestId is required for returns.');
    var reqRows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
    var found = false;
    for (var j = 0; j < reqRows.length; j++) {
      if (reqRows[j].RequestID === linkedRequestId && reqRows[j].Type === 'checkout') { found = true; break; }
    }
    if (!found) return fail('NOT_FOUND', 'Linked checkout request not found.');
  }

  return withLock(function () {
    var reqSheet = sh('Requests');
    var lastRow = reqSheet.getLastRow();
    var requestId = genRequestId();
    var now = nowIso();
    var row = [requestId, now, type, name, teamNumber, partId, part.SKU, part.Name,
      quantity, userNote, checkoutDate, returnDate, 'pending', '', '', '', linkedRequestId];
    reqSheet.getRange(lastRow + 1, 1, 1, REQUESTS_HEADERS.length).setValues([row]);
    appendLog(name + '/' + teamNumber, 'submit', requestId, JSON.stringify({ type: type, partId: partId, quantity: quantity }));
    return ok({ requestId: requestId, status: 'pending' });
  });
}

function myRequestsAction(body) {
  var name = sanitizeStr(body.name, 80).trim().toLowerCase();
  var team = sanitizeStr(body.teamNumber, 12).trim().toLowerCase();
  if (!name || !team) return fail('BAD_INPUT', 'name and teamNumber are required.');

  var rows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
  var matched = rows.filter(function (r) {
    return String(r.Name || '').trim().toLowerCase() === name &&
      String(r.TeamNumber || '').trim().toLowerCase() === team;
  });
  matched.sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  return ok({ requests: matched.map(requestToApi) });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function loginAction(body) {
  if (!loginRateLimitOk()) {
    appendLog('anon', 'login_fail', 'ratelimited', '{}');
    return fail('UNAUTHORIZED', 'Invalid credentials.');
  }

  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('ADMIN_PASS_HASH');
  var salt = props.getProperty('ADMIN_SALT');
  var hmacKey = props.getProperty('HMAC_KEY');
  if (!hash || !salt || !hmacKey) {
    return fail('SERVER', 'Admin not configured. Run setup() and setAdminPassword() in the Apps Script editor.');
  }

  var password = body.password;
  if (typeof password !== 'string' || !password) {
    registerLoginFailure();
    appendLog('anon', 'login_fail', 'badinput', '{}');
    return fail('UNAUTHORIZED', 'Invalid credentials.');
  }

  var computed = sha256Hex(password + salt);
  if (!timingSafeEqual(computed, hash)) {
    registerLoginFailure();
    appendLog('anon', 'login_fail', 'badpassword', '{}');
    return fail('UNAUTHORIZED', 'Invalid credentials.');
  }

  clearLoginFailures();
  var exp = Date.now() + (12 * 60 * 60 * 1000);
  var token = mintToken(exp);
  appendLog('admin', 'login', 'success', '{}');
  return ok({ token: token, expiresAt: new Date(exp).toISOString() });
}

function mintToken(exp) {
  var hmacKey = PropertiesService.getScriptProperties().getProperty('HMAC_KEY');
  var payload = JSON.stringify({ exp: exp, iat: Date.now() });
  var p64 = b64urlEncodeStr(payload);
  var sig = Utilities.computeHmacSha256Signature(payload, hmacKey);
  var s64 = b64urlEncodeBytes(sig);
  return p64 + '.' + s64;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;

  var payloadJson;
  try {
    payloadJson = b64urlDecodeStr(parts[0]);
  } catch (e) { return null; }

  var hmacKey = PropertiesService.getScriptProperties().getProperty('HMAC_KEY');
  if (!hmacKey) return null;

  var expectedSig = b64urlEncodeBytes(Utilities.computeHmacSha256Signature(payloadJson, hmacKey));
  if (!timingSafeEqual(expectedSig, parts[1])) return null;

  var payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (e) { return null; }

  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

function loginRateLimitOk() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(loginRateLimitKey()) || 0);
  return n < 5;
}
function registerLoginFailure() {
  var cache = CacheService.getScriptCache();
  var key = loginRateLimitKey();
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 900); // 15 min
}
function clearLoginFailures() {
  CacheService.getScriptCache().remove(loginRateLimitKey());
}
function loginRateLimitKey() {
  // "keyed by a hash of the attempt" — Apps Script web apps expose no caller IP,
  // so this is a single shared counter (fine for a single-admin lab tool).
  return 'lf_' + sha256Hex('labinventory_login_attempts_v1');
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

function pendingAction() {
  var rows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS).filter(function (r) { return r.Status === 'pending'; });
  rows.sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  return ok({ requests: rows.map(requestToApi) });
}

function requestsAction(body) {
  var status = body.status ? String(body.status) : '';
  var limit = coerceInt(body.limit, 1, 1000, 100);
  var offset = coerceInt(body.offset, 0, 1000000, 0);

  var rows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
  if (status) rows = rows.filter(function (r) { return r.Status === status; });
  rows.sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });

  var total = rows.length;
  var page = rows.slice(offset, offset + limit);
  return ok({ requests: page.map(requestToApi), total: total });
}

function decideAction(body) {
  var requestId = String(body.requestId || '').trim();
  var decision = body.decision;
  if (!requestId) return fail('BAD_INPUT', 'requestId is required.');
  if (decision !== 'approve' && decision !== 'deny') return fail('BAD_INPUT', 'decision must be approve or deny.');
  var adminNote = sanitizeStr(body.adminNote, 500);
  // The shelf count is often behind reality -- a part gets restocked, or the
  // lab simply has not entered its counts yet -- and the physical object is
  // right there. So the stock rule is advisory on an explicit override, never
  // a wall. The override is deliberate (the client has to ask for it) and it
  // is recorded in the log with the size of the shortfall.
  var force = body.force === true || body.force === 'true';

  return withLock(function () {
    var reqSheet = sh('Requests');
    var reqLastRow = reqSheet.getLastRow();
    if (reqLastRow < 2) return fail('NOT_FOUND', 'Request not found.');
    var reqValues = reqSheet.getRange(2, 1, reqLastRow - 1, REQUESTS_HEADERS.length).getValues();

    var idx = -1;
    for (var i = 0; i < reqValues.length; i++) { if (reqValues[i][0] === requestId) { idx = i; break; } }
    if (idx === -1) return fail('NOT_FOUND', 'Request not found.');

    var reqRow = reqValues[idx];
    var reqObj = rowToObj(REQUESTS_HEADERS, reqRow);
    if (reqObj.Status !== 'pending') return fail('BAD_INPUT', 'Request is not pending.');

    var partsSheet = sh('Parts');
    var partsLastRow = partsSheet.getLastRow();
    var partValues = partsLastRow >= 2 ? partsSheet.getRange(2, 1, partsLastRow - 1, PARTS_HEADERS.length).getValues() : [];
    var partIdx = -1;
    for (var j = 0; j < partValues.length; j++) { if (partValues[j][0] === reqObj.PartID) { partIdx = j; break; } }

    var now = nowIso();
    var apiPart = null;

    if (decision === 'deny') {
      reqRow[12] = 'denied';
      reqRow[13] = adminNote;
      reqRow[14] = now;
      reqRow[15] = 'admin';
      reqSheet.getRange(idx + 2, 1, 1, REQUESTS_HEADERS.length).setValues([reqRow]);
      if (partIdx > -1) apiPart = partToApi(rowToObj(PARTS_HEADERS, partValues[partIdx]));
      appendLog('admin', 'decide:deny', requestId, JSON.stringify({ adminNote: adminNote }));
      return ok({ request: requestToApi(rowToObj(REQUESTS_HEADERS, reqRow)), part: apiPart });
    }

    // decision === 'approve'
    if (reqObj.Type === 'checkout') {
      if (partIdx === -1) return fail('NOT_FOUND', 'Part not found.');
      var pRow = partValues[partIdx];
      var qtyTotal = Number(pRow[10]) || 0;
      var qtyOut = Number(pRow[11]) || 0;
      var qty = Number(reqObj.Quantity) || 0;
      var short = qty - (qtyTotal - qtyOut);
      if (short > 0 && !force) {
        return fail('INSUFFICIENT_STOCK',
          'Only ' + Math.max(0, qtyTotal - qtyOut) + ' of ' + qtyTotal + ' on the shelf, and this asks for ' + qty + '.');
      }
      if (short > 0) {
        appendLog('admin', 'decide:approve:override', requestId,
          JSON.stringify({ requested: qty, available: Math.max(0, qtyTotal - qtyOut), over: short }));
      }
      pRow[11] = qtyOut + qty;
      pRow[15] = now;
      partsSheet.getRange(partIdx + 2, 1, 1, PARTS_HEADERS.length).setValues([pRow]);
      bumpCatalogVersion();
      apiPart = partToApi(rowToObj(PARTS_HEADERS, pRow));
    } else {
      // return
      var linkedId = reqObj.LinkedRequestID;
      var linkedIdx = -1;
      for (var k = 0; k < reqValues.length; k++) { if (reqValues[k][0] === linkedId) { linkedIdx = k; break; } }
      if (linkedIdx === -1) return fail('NOT_FOUND', 'Linked checkout not found.');
      if (partIdx === -1) return fail('NOT_FOUND', 'Part not found.');

      var pRow2 = partValues[partIdx];
      var qtyOut2 = Number(pRow2[11]) || 0;
      var qty2 = Number(reqObj.Quantity) || 0;
      pRow2[11] = Math.max(0, qtyOut2 - qty2);
      pRow2[15] = now;
      partsSheet.getRange(partIdx + 2, 1, 1, PARTS_HEADERS.length).setValues([pRow2]);
      bumpCatalogVersion();
      apiPart = partToApi(rowToObj(PARTS_HEADERS, pRow2));

      var linkedRow = reqValues[linkedIdx];
      linkedRow[12] = 'returned';
      reqSheet.getRange(linkedIdx + 2, 1, 1, REQUESTS_HEADERS.length).setValues([linkedRow]);
    }

    reqRow[12] = 'approved';
    reqRow[13] = adminNote;
    reqRow[14] = now;
    reqRow[15] = 'admin';
    reqSheet.getRange(idx + 2, 1, 1, REQUESTS_HEADERS.length).setValues([reqRow]);
    appendLog('admin', 'decide:approve', requestId, JSON.stringify({ type: reqObj.Type }));
    return ok({ request: requestToApi(rowToObj(REQUESTS_HEADERS, reqRow)), part: apiPart });
  });
}

function upsertPartAction(body) {
  var input = body.part || {};

  return withLock(function () {
    var partsSheet = sh('Parts');
    var lastRow = partsSheet.getLastRow();
    var values = lastRow >= 2 ? partsSheet.getRange(2, 1, lastRow - 1, PARTS_HEADERS.length).getValues() : [];

    var partId = String(input.partId || '').trim();
    var idx = -1;
    if (partId) {
      for (var i = 0; i < values.length; i++) { if (values[i][0] === partId) { idx = i; break; } }
    }
    var now = nowIso();

    if (idx === -1) {
      var name = sanitizeStr(input.name, 200);
      if (!name) return fail('BAD_INPUT', 'name is required.');

      var existingIds = {};
      for (var e2 = 0; e2 < values.length; e2++) existingIds[values[e2][0]] = true;
      var newPartId = genPartIdLab(existingIds);

      var row = [
        newPartId,
        sanitizeStr(input.sku, 100),
        name,
        sanitizeStr(input.category, 100),
        sanitizeStr(input.subcategory, 100),
        sanitizeStr(input.imageUrl, 500),
        sanitizeStr(input.localImage, 500),
        sanitizeStr(input.productUrl, 500),
        sanitizeStr(input.description, 2000),
        sanitizeStr(input.location, 200),
        coerceInt(input.qtyTotal, 0, 999999, 0),
        0, // QtyOut — never trust client on create
        sanitizeStr(input.unit, 20) || 'ea',
        input.active !== false,
        sanitizeStr(input.notes, 2000),
        now
      ];
      partsSheet.getRange(lastRow + 1, 1, 1, PARTS_HEADERS.length).setValues([row]);
      bumpCatalogVersion();
      appendLog('admin', 'upsertPart:create', newPartId, JSON.stringify({ name: name }));
      return ok({ part: partToApi(rowToObj(PARTS_HEADERS, row)) });
    }

    var row2 = values[idx].slice();
    if (input.sku !== undefined) row2[1] = sanitizeStr(input.sku, 100);
    if (input.name !== undefined) row2[2] = sanitizeStr(input.name, 200);
    if (input.category !== undefined) row2[3] = sanitizeStr(input.category, 100);
    if (input.subcategory !== undefined) row2[4] = sanitizeStr(input.subcategory, 100);
    if (input.imageUrl !== undefined) row2[5] = sanitizeStr(input.imageUrl, 500);
    if (input.localImage !== undefined) row2[6] = sanitizeStr(input.localImage, 500);
    if (input.productUrl !== undefined) row2[7] = sanitizeStr(input.productUrl, 500);
    if (input.description !== undefined) row2[8] = sanitizeStr(input.description, 2000);
    if (input.location !== undefined) row2[9] = sanitizeStr(input.location, 200);
    if (input.qtyTotal !== undefined) row2[10] = coerceInt(input.qtyTotal, 0, 999999, row2[10]);
    // row2[11] QtyOut — never trust client on update either
    if (input.unit !== undefined) row2[12] = sanitizeStr(input.unit, 20) || 'ea';
    if (input.active !== undefined) row2[13] = (input.active === true || input.active === 'TRUE');
    if (input.notes !== undefined) row2[14] = sanitizeStr(input.notes, 2000);
    row2[15] = now;

    partsSheet.getRange(idx + 2, 1, 1, PARTS_HEADERS.length).setValues([row2]);
    bumpCatalogVersion();
    appendLog('admin', 'upsertPart:update', partId, '{}');
    return ok({ part: partToApi(rowToObj(PARTS_HEADERS, row2)) });
  });
}

function deletePartAction(body) {
  var partId = String(body.partId || '').trim();
  if (!partId) return fail('BAD_INPUT', 'partId is required.');

  return withLock(function () {
    var partsSheet = sh('Parts');
    var lastRow = partsSheet.getLastRow();
    var values = lastRow >= 2 ? partsSheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    var idx = -1;
    for (var i = 0; i < values.length; i++) { if (values[i][0] === partId) { idx = i; break; } }
    if (idx === -1) return fail('NOT_FOUND', 'Part not found.');

    partsSheet.getRange(idx + 2, 14).setValue(false);       // N Active
    partsSheet.getRange(idx + 2, 16).setValue(nowIso());    // P UpdatedAt
    bumpCatalogVersion();
    appendLog('admin', 'deletePart', partId, '{}');
    return ok({ deleted: true });
  });
}

function adjustQtyAction(body) {
  var partId = String(body.partId || '').trim();
  if (!partId) return fail('BAD_INPUT', 'partId is required.');
  var qtyTotal = coerceInt(body.qtyTotal, 0, 999999, NaN);
  if (isNaN(qtyTotal)) return fail('BAD_INPUT', 'qtyTotal must be a non-negative integer.');

  return withLock(function () {
    var partsSheet = sh('Parts');
    var lastRow = partsSheet.getLastRow();
    var values = lastRow >= 2 ? partsSheet.getRange(2, 1, lastRow - 1, PARTS_HEADERS.length).getValues() : [];
    var idx = -1;
    for (var i = 0; i < values.length; i++) { if (values[i][0] === partId) { idx = i; break; } }
    if (idx === -1) return fail('NOT_FOUND', 'Part not found.');

    var row = values[idx];
    row[10] = qtyTotal;
    row[15] = nowIso();
    partsSheet.getRange(idx + 2, 1, 1, PARTS_HEADERS.length).setValues([row]);
    bumpCatalogVersion();
    appendLog('admin', 'adjustQty', partId, JSON.stringify({ qtyTotal: qtyTotal }));
    return ok({ part: partToApi(rowToObj(PARTS_HEADERS, row)) });
  });
}

function uploadImageAction(body) {
  var partId = String(body.partId || '').trim();
  if (!partId) return fail('BAD_INPUT', 'partId is required.');

  var partRows = readSheetAsObjects(sh('Parts'), PARTS_HEADERS);
  var exists = partRows.some(function (p) { return p.PartID === partId; });
  if (!exists) return fail('NOT_FOUND', 'Part not found.');

  var allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var mimeType = body.mimeType;
  if (allowedMimes.indexOf(mimeType) === -1) return fail('BAD_INPUT', 'mimeType must be png, jpeg, webp, or gif.');

  var dataBase64 = body.dataBase64;
  if (!dataBase64 || typeof dataBase64 !== 'string') return fail('BAD_INPUT', 'dataBase64 is required.');

  var bytes;
  try {
    bytes = Utilities.base64Decode(dataBase64);
  } catch (e) {
    return fail('BAD_INPUT', 'dataBase64 is not valid base64.');
  }
  if (bytes.length > 5 * 1024 * 1024) return fail('BAD_INPUT', 'Image exceeds 5MB limit.');

  var filename = sanitizeStr(body.filename, 120).replace(/[\\/]/g, '_') || 'upload';

  try {
    var blob = Utilities.newBlob(bytes, mimeType, filename);
    var folder = getOrCreateImagesFolder();
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var imageUrl = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w640';
    appendLog('admin', 'uploadImage', partId, JSON.stringify({ fileId: file.getId() }));
    return ok({ imageUrl: imageUrl });
  } catch (ex) {
    logError('uploadImageAction', ex);
    return fail('SERVER', 'Image upload failed.');
  }
}

function getOrCreateImagesFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVE_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  var it = DriveApp.getFoldersByName('LabInventory Images');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('LabInventory Images');
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * Set one Location across many parts in a single pass.
 *
 * The admin UI groups a part family (one U-Beam in 21 lengths) behind one
 * location field. Doing that as 21 separate upsertPart calls costs ~2.7s each
 * because every one pays a round trip plus its own script lock. This reads the
 * sheet once, edits the Location column in memory, and writes once: about two
 * seconds for the whole family regardless of size.
 */
function bulkLocationAction(body) {
  var ids = body.partIds;
  if (!ids || !ids.length) return fail('BAD_INPUT', 'partIds is required.');
  if (ids.length > 500) return fail('BAD_INPUT', 'Too many parts in one call (max 500).');
  var location = sanitizeStr(body.location, 200);

  return withLock(function () {
    var sheet = sh('Parts');
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return fail('NOT_FOUND', 'There are no parts yet.');

    var range = sheet.getRange(2, 1, lastRow - 1, PARTS_HEADERS.length);
    var values = range.getValues();

    var want = {};
    for (var i = 0; i < ids.length; i++) want[String(ids[i])] = true;

    var LOCATION_COL = 9;   // J
    var UPDATED_COL = 15;   // P
    var now = nowIso();
    var updated = 0;
    for (var r = 0; r < values.length; r++) {
      if (want[String(values[r][0])]) {
        values[r][LOCATION_COL] = location;
        values[r][UPDATED_COL] = now;
        updated++;
      }
    }
    if (!updated) return fail('NOT_FOUND', 'None of those parts exist.');

    range.setValues(values);
    bumpCatalogVersion();
    appendLog('admin', 'bulkLocation', location || '(cleared)', JSON.stringify({ count: updated }));
    return ok({ updated: updated, location: location });
  });
}

function bulkImportAction(body) {
  var mode = body.mode || 'upsert';
  if (mode !== 'upsert') return fail('BAD_INPUT', 'mode must be upsert.');

  var incoming = body.parts;
  if (!Array.isArray(incoming)) return fail('BAD_INPUT', 'parts must be an array.');
  if (incoming.length === 0) return ok({ inserted: 0, updated: 0 });
  if (incoming.length > 400) return fail('BAD_INPUT', 'max 400 parts per call.');

  return withLock(function () {
    var partsSheet = sh('Parts');
    var lastRow = partsSheet.getLastRow();
    var values = lastRow >= 2 ? partsSheet.getRange(2, 1, lastRow - 1, PARTS_HEADERS.length).getValues() : [];
    var idMap = {};
    for (var i = 0; i < values.length; i++) idMap[values[i][0]] = i;

    var catSheet = sh('Categories');
    var catLastRow = catSheet.getLastRow();
    var catValues = catLastRow >= 2 ? catSheet.getRange(2, 1, catLastRow - 1, CATEGORIES_HEADERS.length).getValues() : [];
    var catIdSet = {};
    for (var ci = 0; ci < catValues.length; ci++) catIdSet[catValues[ci][0]] = true;
    var nextSort = catValues.length;

    var now = nowIso();
    var inserted = 0, updated = 0;

    for (var p = 0; p < incoming.length; p++) {
      var ip = incoming[p] || {};
      var pid = String(ip.partId || '').trim();
      var sku = sanitizeStr(ip.sku, 100);
      var name = sanitizeStr(ip.name, 200);
      if (!pid || !sku || !name) continue; // skip malformed rows rather than failing the whole batch

      var cat = sanitizeStr(ip.category, 100);
      var subcat = sanitizeStr(ip.subcategory, 100);

      if (idMap[pid] !== undefined) {
        // Update: refresh catalog metadata only. Admin-owned fields (QtyTotal, QtyOut,
        // Location, Unit, Active, Notes) are deliberately preserved so re-running the
        // crawler/seed never wipes counts or edits Advay has made in the admin UI.
        var row = values[idMap[pid]];
        row[1] = sku;
        row[2] = name;
        row[3] = cat;
        row[4] = subcat;
        row[5] = sanitizeStr(ip.imageUrl, 500);
        row[6] = sanitizeStr(ip.localImage, 500);
        row[7] = sanitizeStr(ip.productUrl, 500);
        row[8] = sanitizeStr(ip.description, 2000);
        row[15] = now;
        updated++;
      } else {
        var newRow = [
          pid, sku, name, cat, subcat,
          sanitizeStr(ip.imageUrl, 500), sanitizeStr(ip.localImage, 500), sanitizeStr(ip.productUrl, 500),
          sanitizeStr(ip.description, 2000), sanitizeStr(ip.location, 200),
          coerceInt(ip.qtyTotal, 0, 999999, 0), 0,
          sanitizeStr(ip.unit, 20) || 'ea',
          ip.active !== false,
          sanitizeStr(ip.notes, 2000), now
        ];
        values.push(newRow);
        idMap[pid] = values.length - 1;
        inserted++;
      }

      if (cat) {
        var catId = 'cat-' + slugify(cat);
        if (!catIdSet[catId]) {
          catValues.push([catId, cat, '', slugify(cat), nextSort++, true]);
          catIdSet[catId] = true;
        }
        if (subcat) {
          var subCatId = 'cat-' + slugify(cat) + '-' + slugify(subcat);
          if (!catIdSet[subCatId]) {
            catValues.push([subCatId, subcat, catId, slugify(subcat), nextSort++, true]);
            catIdSet[subCatId] = true;
          }
        }
      }
    }

    if (values.length > 0) partsSheet.getRange(2, 1, values.length, PARTS_HEADERS.length).setValues(values);
    if (catValues.length > 0) catSheet.getRange(2, 1, catValues.length, CATEGORIES_HEADERS.length).setValues(catValues);
    bumpCatalogVersion();
    appendLog('admin', 'bulkImport', '', JSON.stringify({ inserted: inserted, updated: updated, total: incoming.length }));
    return ok({ inserted: inserted, updated: updated });
  });
}

function statsAction() {
  var parts = readSheetAsObjects(sh('Parts'), PARTS_HEADERS);
  var totalParts = parts.length;
  var totalUnits = 0, unitsOut = 0;
  parts.forEach(function (p) {
    totalUnits += Number(p.QtyTotal) || 0;
    unitsOut += Number(p.QtyOut) || 0;
  });

  var requests = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
  var pendingCount = requests.filter(function (r) { return r.Status === 'pending'; }).length;

  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var overdue = requests.filter(function (r) {
    var rd = asDateStr(r.ReturnDate);
    return r.Type === 'checkout' && r.Status === 'approved' && rd && rd < today;
  });

  return ok({
    totalParts: totalParts,
    totalUnits: totalUnits,
    unitsOut: unitsOut,
    pendingCount: pendingCount,
    overdue: overdue.map(requestToApi)
  });
}

// ---------------------------------------------------------------------------
// Sheet <-> API shape mapping
// ---------------------------------------------------------------------------

function rowToObj(headers, row) {
  var o = {};
  for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i];
  return o;
}

function readSheetAsObjects(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) out.push(rowToObj(headers, values[i]));
  return out;
}

function partToApi(p) {
  var qtyTotal = Number(p.QtyTotal) || 0;
  var qtyOut = Number(p.QtyOut) || 0;
  var qtyAvailable = Math.max(0, qtyTotal - qtyOut);
  // How far past the recorded count the shelf has been issued. Kept separate
  // so qtyAvailable never goes negative on the student-facing side.
  var qtyOver = Math.max(0, qtyOut - qtyTotal);
  return {
    partId: p.PartID, sku: p.SKU, name: p.Name, category: p.Category, subcategory: p.Subcategory,
    imageUrl: p.ImageURL, localImage: p.LocalImage, productUrl: p.ProductURL, description: p.Description,
    location: p.Location, qtyTotal: qtyTotal, qtyOut: qtyOut, qtyAvailable: qtyAvailable,
    qtyOver: qtyOver,
    unit: p.Unit || 'ea', active: (p.Active === true || p.Active === 'TRUE'),
    notes: p.Notes, updatedAt: asIsoStr(p.UpdatedAt)
  };
}

function requestToApi(r) {
  return {
    requestId: r.RequestID, createdAt: asIsoStr(r.CreatedAt), type: r.Type, name: r.Name,
    teamNumber: r.TeamNumber, partId: r.PartID, sku: r.SKU, partName: r.PartName,
    quantity: Number(r.Quantity) || 0, userNote: r.UserNote,
    checkoutDate: asDateStr(r.CheckoutDate), returnDate: asDateStr(r.ReturnDate),
    status: r.Status, adminNote: r.AdminNote,
    decidedAt: r.DecidedAt ? asIsoStr(r.DecidedAt) : '', decidedBy: r.DecidedBy || '',
    linkedRequestId: r.LinkedRequestID || ''
  };
}

function categoryToApi(c) {
  return { catId: c.CatID, name: c.Name, parent: c.Parent || '', slug: c.Slug, sortOrder: Number(c.SortOrder) || 0 };
}

// Google Sheets can silently auto-convert a YYYY-MM-DD-looking string into a real
// Date value on write. Columns are pre-formatted as plain text in setup() to stop
// this, but these are a defensive backstop for cells edited by hand later.
function asDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'America/Chicago', 'yyyy-MM-dd');
  return String(v || '');
}
function asIsoStr(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v || '');
}

// ---------------------------------------------------------------------------
// Config tab
// ---------------------------------------------------------------------------

function getConfigMap() {
  var s = sh('Config');
  var lastRow = s.getLastRow();
  var vals = lastRow >= 2 ? s.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  var map = {};
  vals.forEach(function (r) { map[r[0]] = r[1]; });
  return map;
}
function getConfigVal(key, def) {
  var m = getConfigMap();
  return (m[key] !== undefined && m[key] !== '') ? m[key] : def;
}
function setConfigVal(key, val) {
  var s = sh('Config');
  var lastRow = s.getLastRow();
  var vals = lastRow >= 2 ? s.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] === key) { s.getRange(i + 2, 2).setValue(val); return; }
  }
  s.getRange(lastRow + 1, 1, 1, 2).setValues([[key, val]]);
}
function bumpCatalogVersion() {
  setConfigVal('catalogVersion', String(Date.now()));
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function withLock(fn) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(20000);
  if (!got) return fail('LOCKED', 'System is busy, please try again.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Log tab
// ---------------------------------------------------------------------------

function appendLog(actor, action, target, detail) {
  try {
    var s = sh('Log');
    var lastRow = s.getLastRow();
    s.getRange(lastRow + 1, 1, 1, LOG_HEADERS.length).setValues([[nowIso(), actor, action, target, detail]]);
    if (lastRow + 1 > LOG_TRIM_AT) trimLog(s);
  } catch (e) { /* logging must never break the caller */ }
}

function trimLog(s) {
  try {
    var lastRow = s.getLastRow();
    var dataRows = lastRow - 1;
    if (dataRows > LOG_TRIM_KEEP) {
      s.deleteRows(2, dataRows - LOG_TRIM_KEEP);
    }
  } catch (e) { /* best effort */ }
}

function logError(context, ex) {
  try {
    var msg = (ex && ex.message) ? ex.message : String(ex);
    var stack = (ex && ex.stack) ? ex.stack : '';
    appendLog('system', 'ERROR', context, JSON.stringify({ message: msg, stack: stack }));
  } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Cache (chunked — a single cache value is capped around 100KB)
// ---------------------------------------------------------------------------

function cacheSetChunked(prefix, str, ttlSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var n = Math.max(1, Math.ceil(str.length / CACHE_CHUNK_SIZE));
    var obj = {};
    for (var i = 0; i < n; i++) {
      obj[prefix + ':c' + i] = str.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
    }
    obj[prefix + ':n'] = String(n);
    cache.putAll(obj, ttlSeconds);
  } catch (e) { /* cache is best-effort */ }
}

function cacheGetChunked(prefix) {
  try {
    var cache = CacheService.getScriptCache();
    var n = cache.get(prefix + ':n');
    if (!n) return null;
    var count = parseInt(n, 10);
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(prefix + ':c' + i);
    var got = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < count; j++) {
      var v = got[prefix + ':c' + j];
      if (v === undefined || v === null) return null;
      parts.push(v);
    }
    return parts.join('');
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Validation / sanitization helpers
// ---------------------------------------------------------------------------

function sanitizeStr(v, maxLen) {
  var s = (v === undefined || v === null) ? '' : String(v);
  s = s.replace(/[\r\t]/g, ' ');
  s = s.trim();
  while (s.length && /^[=+\-@]/.test(s)) s = s.slice(1);
  s = s.trim();
  if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

// Lenient: parses then clamps into range. For internal defaults (pagination, admin totals) — never rejects.
function coerceInt(v, min, max, def) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return def;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

// Strict: parses then REJECTS (returns NaN) if out of range. For user-submitted values
// that must fail loudly rather than be silently coerced into something valid (e.g. Quantity).
function strictInt(v, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return NaN;
  if (n < min || n > max) return NaN;
  return n;
}

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function slugify(s) {
  return (String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')) || 'x';
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

function genRequestId() {
  var hex = Math.floor(Math.random() * 0xFFFF).toString(16);
  while (hex.length < 4) hex = '0' + hex;
  return 'req-' + Date.now() + '-' + hex;
}

function genPartIdLab(existingIds) {
  var id;
  var attempts = 0;
  do {
    var h = '';
    for (var i = 0; i < 6; i++) h += Math.floor(Math.random() * 16).toString(16);
    id = 'lab-' + h;
    attempts++;
  } while (existingIds && existingIds[id] && attempts < 20);
  return id;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function sha256Hex(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = (bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16);
    hex += (v.length === 1 ? '0' + v : v);
  }
  return hex;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var len = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < len; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

function b64urlEncodeStr(str) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(str).getBytes());
}
function b64urlEncodeBytes(bytes) {
  return Utilities.base64EncodeWebSafe(bytes);
}
function b64urlDecodeStr(s) {
  var bytes = Utilities.base64DecodeWebSafe(s);
  return Utilities.newBlob(bytes).getDataAsString();
}

// ---------------------------------------------------------------------------
// One-time / editor-run setup
// ---------------------------------------------------------------------------

/** Safe to run more than once. Run from the Apps Script editor. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureTab(ss, 'Parts', PARTS_HEADERS,
    [90, 140, 220, 120, 120, 220, 180, 220, 260, 140, 80, 80, 60, 70, 200, 170]);
  ensureTab(ss, 'Requests', REQUESTS_HEADERS,
    [140, 170, 80, 140, 90, 90, 120, 200, 70, 220, 100, 100, 90, 200, 170, 90, 140]);
  ensureTab(ss, 'Categories', CATEGORIES_HEADERS,
    [120, 160, 120, 120, 90, 70]);
  ensureTab(ss, 'Log', LOG_HEADERS,
    [170, 90, 140, 140, 300]);
  ensureTab(ss, 'Config', CONFIG_HEADERS,
    [160, 300]);

  // Prevent Sheets' auto date-conversion on string date/timestamp columns.
  sh('Requests').getRange(2, 2, FORMAT_ROWS, 1).setNumberFormat('@');   // CreatedAt
  sh('Requests').getRange(2, 11, FORMAT_ROWS, 2).setNumberFormat('@'); // CheckoutDate, ReturnDate
  sh('Requests').getRange(2, 15, FORMAT_ROWS, 1).setNumberFormat('@'); // DecidedAt
  sh('Parts').getRange(2, 16, FORMAT_ROWS, 1).setNumberFormat('@');    // UpdatedAt
  sh('Log').getRange(2, 1, FORMAT_ROWS, 1).setNumberFormat('@');       // At

  // Status dropdown on Requests
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['pending', 'approved', 'denied', 'returned', 'cancelled'], true)
    .setAllowInvalid(false)
    .build();
  sh('Requests').getRange(2, 13, FORMAT_ROWS, 1).setDataValidation(rule);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_SALT')) props.setProperty('ADMIN_SALT', Utilities.getUuid() + Utilities.getUuid());
  if (!props.getProperty('HMAC_KEY')) props.setProperty('HMAC_KEY', Utilities.getUuid() + Utilities.getUuid());

  var cfg = getConfigMap();
  if (cfg.siteTitle === undefined) setConfigVal('siteTitle', 'LabInventory');
  if (cfg.catalogVersion === undefined) setConfigVal('catalogVersion', String(Date.now()));
  if (cfg.requireApproval === undefined) setConfigVal('requireApproval', 'TRUE');

  Logger.log('=== LabInventory setup complete ===');
  Logger.log('Next steps:');
  Logger.log('1. Run setAdminPassword via a temporary wrapper function (see backend/SETUP.md).');
  Logger.log('2. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.');
  Logger.log('3. Copy the /exec URL into docs/assets/js/config.js as API_URL.');
  Logger.log('4. Run selfTest() from this editor to verify everything end to end.');
}

function ensureTab(ss, name, headers, widths) {
  var s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  s.getRange(1, 1, 1, headers.length).setValues([headers]);
  s.setFrozenRows(1);
  if (widths) {
    for (var i = 0; i < widths.length; i++) s.setColumnWidth(i + 1, widths[i]);
  }
  return s;
}

/**
 * Run from the editor to set/change the admin password. Never call this from
 * the web app itself. The Apps Script "Run" button cannot pass arguments, so
 * see backend/SETUP.md for the temporary-wrapper-function trick.
 */
function setAdminPassword(pw) {
  if (!pw || typeof pw !== 'string' || pw.length < 6) {
    Logger.log('ERROR: password must be a string of at least 6 characters.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('ADMIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('ADMIN_SALT', salt);
  }
  var hash = sha256Hex(pw + salt);
  props.setProperty('ADMIN_PASS_HASH', hash);
  Logger.log('Admin password set successfully. (The password itself is never logged or stored.)');
}

// ---------------------------------------------------------------------------
// Self test — run from the editor. Exercises the full checkout/return cycle
// and cleans up after itself.
// ---------------------------------------------------------------------------

function selfTest() {
  Logger.log('=== LabInventory selfTest starting ===');
  setup();

  var pass = true;
  var testPartId, checkoutReqId, returnReqId;

  function step(name, fn) {
    try {
      fn();
      Logger.log('PASS: ' + name);
    } catch (e) {
      pass = false;
      Logger.log('FAIL: ' + name + ' -- ' + (e && e.message ? e.message : e));
    }
  }

  step('create temp part', function () {
    var r = upsertPartAction({ part: { sku: 'SELFTEST-SKU', name: 'SelfTest Part', qtyTotal: 5 } });
    if (!r.ok) throw new Error(r.message || r.error);
    testPartId = r.data.part.partId;
    if (r.data.part.qtyTotal !== 5) throw new Error('qtyTotal mismatch');
    if (r.data.part.qtyOut !== 0) throw new Error('qtyOut should start at 0');
  });

  step('submit checkout', function () {
    var r = submitAction({
      type: 'checkout', name: 'Self Test', teamNumber: '0000', partId: testPartId,
      quantity: 2, userNote: 'selftest', checkoutDate: '2020-01-01', returnDate: '2020-01-02'
    });
    if (!r.ok) throw new Error(r.message || r.error);
    checkoutReqId = r.data.requestId;
    if (r.data.status !== 'pending') throw new Error('expected pending status');
  });

  step('approve checkout and verify qtyOut = 2', function () {
    var r = decideAction({ requestId: checkoutReqId, decision: 'approve', adminNote: '' });
    if (!r.ok) throw new Error(r.message || r.error);
    if (r.data.part.qtyOut !== 2) throw new Error('qtyOut expected 2, got ' + r.data.part.qtyOut);
    if (r.data.part.qtyAvailable !== 3) throw new Error('qtyAvailable expected 3, got ' + r.data.part.qtyAvailable);
  });

  var overReqId;
  step('over-limit checkout is rejected with INSUFFICIENT_STOCK at approval time', function () {
    var r = submitAction({
      type: 'checkout', name: 'Self Test', teamNumber: '0000', partId: testPartId,
      quantity: 10, userNote: '', checkoutDate: '2020-01-01', returnDate: '2020-01-02'
    });
    if (!r.ok) throw new Error(r.message || r.error);
    overReqId = r.data.requestId;
    var d = decideAction({ requestId: overReqId, decision: 'approve', adminNote: '' });
    if (d.ok || d.error !== 'INSUFFICIENT_STOCK') throw new Error('expected INSUFFICIENT_STOCK, got ' + JSON.stringify(d));
    var deny = decideAction({ requestId: overReqId, decision: 'deny', adminNote: 'selftest cleanup' });
    if (!deny.ok) throw new Error(deny.message || deny.error);
  });

  step('submit return', function () {
    var r = submitAction({
      type: 'return', name: 'Self Test', teamNumber: '0000', partId: testPartId,
      quantity: 2, userNote: '', checkoutDate: '2020-01-02', returnDate: '2020-01-02',
      linkedRequestId: checkoutReqId
    });
    if (!r.ok) throw new Error(r.message || r.error);
    returnReqId = r.data.requestId;
  });

  step('approve return: qtyOut back to 0, linked checkout flips to returned', function () {
    var r = decideAction({ requestId: returnReqId, decision: 'approve', adminNote: '' });
    if (!r.ok) throw new Error(r.message || r.error);
    if (r.data.part.qtyOut !== 0) throw new Error('qtyOut expected 0, got ' + r.data.part.qtyOut);
    var rows = readSheetAsObjects(sh('Requests'), REQUESTS_HEADERS);
    var linked = rows.filter(function (x) { return x.RequestID === checkoutReqId; })[0];
    if (!linked || linked.Status !== 'returned') throw new Error('linked checkout not flipped to returned');
  });

  step('cleanup temp rows', function () {
    cleanupSelfTestRows(testPartId);
  });

  Logger.log('=== LabInventory selfTest ' + (pass ? 'PASS' : 'FAIL') + ' ===');
}

function cleanupSelfTestRows(partId) {
  var partsSheet = sh('Parts');
  var lastRow = partsSheet.getLastRow();
  if (lastRow >= 2) {
    var values = partsSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i][0] === partId) partsSheet.deleteRow(i + 2);
    }
  }
  var reqSheet = sh('Requests');
  var rLastRow = reqSheet.getLastRow();
  if (rLastRow >= 2) {
    var rvalues = reqSheet.getRange(2, 1, rLastRow - 1, 6).getValues(); // need col F (PartID), idx 5
    for (var j = rvalues.length - 1; j >= 0; j--) {
      if (rvalues[j][5] === partId) reqSheet.deleteRow(j + 2);
    }
  }
  bumpCatalogVersion();
}

// ---------------------------------------------------------------------------
// Small util
// ---------------------------------------------------------------------------

function sh(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}
