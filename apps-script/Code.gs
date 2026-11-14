/**
 * Mock Exam Progress Tracker: Google Apps Script backend.
 *
 * Paste this whole file into the Apps Script editor of the Google Sheet
 * (Extensions → Apps Script), replacing the default Code.gs contents.
 *
 * Script Properties (Project Settings → Script Properties):
 *   PIN                 required. Every write must send this PIN.
 *   READ_PIN_REQUIRED   optional. Set to "true" to also require the PIN to read data.
 *
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * After changing this code: Deploy → Manage deployments → Edit (pencil) →
 * Version: New version → Deploy. The URL stays the same.
 *
 * API
 *   GET  ?pin=1234 (pin only if READ_PIN_REQUIRED)  → {ok, exams, sections, topics}
 *   POST body (sent as text/plain so browsers skip the CORS preflight):
 *     {action:"add"|"update", pin, exam:{..., sections:[...], topics:[...]}}
 *     {action:"delete", pin, exam_id}
 *     {action:"import", pin, exams:[{..., sections, topics}, ...]}  (skips exam_ids that already exist)
 *     {action:"checkPin", pin}
 *   → {ok:true, ...} or {ok:false, error:"message"}
 */

// Column order of each tab. Adding a column at the END is safe; the script
// matches columns by header name when reading.
var SCHEMA = {
  Exams: ['exam_id', 'date', 'exam_type', 'mock_name', 'score', 'max_score', 'cutoff', 'percentile', 'rank',
    'total_takers', 'average_score', 'utilized_sec', 'incomplete', 'notes', 'created_at', 'updated_at'],
  Sections: ['exam_id', 'section', 'score', 'max_score', 'questions', 'correct', 'wrong', 'attempted', 'skipped',
    'unseen', 'time_sec', 'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec',
    'time_skipped_sec'],
  Topics: ['exam_id', 'section', 'topic', 'total_qs', 'correct', 'wrong'],
};

// Columns stored as plain text so Sheets doesn't turn them into dates/numbers.
var TEXT_COLUMNS = ['exam_id', 'date', 'exam_type', 'mock_name', 'section', 'topic', 'notes', 'created_at',
  'updated_at'];

var NUMBER_FIELDS = {
  Exams: ['score', 'max_score', 'cutoff', 'percentile', 'rank', 'total_takers', 'average_score', 'utilized_sec'],
  Sections: ['score', 'max_score', 'questions', 'correct', 'wrong', 'attempted', 'skipped', 'unseen', 'time_sec',
    'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec'],
  Topics: ['total_qs', 'correct', 'wrong'],
};

// Wrong-PIN protection: after this many failures within the window, writes are
// refused for the rest of the window (stops someone guessing a short PIN).
var MAX_PIN_FAILURES = 10;
var PIN_FAILURE_WINDOW_SEC = 600;

// ---------------------------------------------------------------------------
// One-time setup: run this from the editor once (select "setup" → Run).
// It creates the three tabs with headers. Safe to run again.
// ---------------------------------------------------------------------------
function setup() {
  Object.keys(SCHEMA).forEach(function (name) { getSheet_(name); });
  var pin = PropertiesService.getScriptProperties().getProperty('PIN');
  Logger.log('Tabs ready: ' + Object.keys(SCHEMA).join(', '));
  Logger.log(pin ? 'PIN is set.' : 'WARNING: no PIN set yet. Add a "PIN" Script Property before deploying.');
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------
function doGet(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('READ_PIN_REQUIRED')).toLowerCase() === 'true') {
      var pin = e && e.parameter ? e.parameter.pin : '';
      var check = checkPin_(pin);
      if (check) return json_({ ok: false, error: check, code: 'PIN' });
    }
    return json_({
      ok: true,
      exams: readRows_('Exams'),
      sections: readRows_('Sections'),
      topics: readRows_('Topics'),
    });
  } catch (err) {
    return json_({ ok: false, error: 'Server error: ' + err.message });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Request body is not valid JSON.' });
  }

  var pinProblem = checkPin_(body.pin);
  if (pinProblem) return json_({ ok: false, error: pinProblem, code: 'PIN' });

  var action = String(body.action || '');
  if (action === 'checkPin') return json_({ ok: true });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'Busy saving another change. Try again.' });
  try {
    if (action === 'add' || action === 'update') {
      var exam = validateExam_(body.exam);
      var exists = findExamRow_(exam.exam_id) > 0;
      // EXISTS lets the app treat a repeated "add" (after a dropped connection) as success.
      if (action === 'add' && exists) return json_({ ok: false, error: 'This exam was already saved.', code: 'EXISTS' });
      if (action === 'update' && !exists) return json_({ ok: false, error: 'Exam not found. It may have been deleted.' });
      var now = new Date().toISOString();
      if (exists) {
        exam.created_at = getExamField_(exam.exam_id, 'created_at') || now;
        deleteExam_(exam.exam_id);
      } else {
        exam.created_at = exam.created_at || now;
      }
      exam.updated_at = now;
      writeExam_(exam);
      return json_({ ok: true, exam_id: exam.exam_id });
    }

    if (action === 'delete') {
      var id = String(body.exam_id || '');
      if (!id) return json_({ ok: false, error: 'Missing exam_id.' });
      if (findExamRow_(id) < 0) return json_({ ok: false, error: 'Exam not found.' });
      deleteExam_(id);
      return json_({ ok: true });
    }

    if (action === 'import') {
      var list = body.exams;
      if (!Array.isArray(list) || !list.length) return json_({ ok: false, error: 'No exams to import.' });
      if (list.length > 500) return json_({ ok: false, error: 'Too many exams in one import (max 500).' });
      var existing = {};
      readColumn_('Exams', 'exam_id').forEach(function (v) { existing[v] = true; });
      var valid = list.map(validateExam_); // validate everything before writing anything
      var added = 0;
      var skipped = 0;
      var stamp = new Date().toISOString();
      valid.forEach(function (ex) {
        if (existing[ex.exam_id]) { skipped++; return; }
        ex.created_at = ex.created_at || stamp;
        ex.updated_at = stamp;
        writeExam_(ex);
        existing[ex.exam_id] = true;
        added++;
      });
      return json_({ ok: true, added: added, skipped: skipped });
    }

    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------
/** Returns an error message, or '' if the PIN is correct. */
function checkPin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!expected) return 'PIN is not set up on the server (Script Properties → PIN).';
  var cache = CacheService.getScriptCache();
  var failures = Number(cache.get('pin_failures') || 0);
  if (failures >= MAX_PIN_FAILURES) return 'Too many wrong PINs. Wait 10 minutes and try again.';
  if (String(pin || '') === String(expected)) return '';
  cache.put('pin_failures', String(failures + 1), PIN_FAILURE_WINDOW_SEC);
  return 'Wrong PIN.';
}

// ---------------------------------------------------------------------------
// Validation: never trust the browser; rebuild clean rows from the payload.
// ---------------------------------------------------------------------------
function validateExam_(ex) {
  if (!ex || typeof ex !== 'object') throw new Error('Missing exam data.');
  var out = {};
  out.exam_id = cleanText_(ex.exam_id, 64);
  if (!/^ex_[A-Za-z0-9_]+$/.test(out.exam_id)) throw new Error('Invalid exam_id.');
  out.date = cleanText_(ex.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('Invalid date (expected YYYY-MM-DD).');
  out.exam_type = cleanText_(ex.exam_type, 100);
  out.mock_name = cleanText_(ex.mock_name, 200);
  if (!out.mock_name) throw new Error('Mock name is required.');
  NUMBER_FIELDS.Exams.forEach(function (k) { out[k] = cleanNumber_(ex[k], k); });
  out.incomplete = ex.incomplete === true;
  out.notes = cleanText_(ex.notes, 1000);
  out.created_at = cleanText_(ex.created_at, 40);

  var sections = Array.isArray(ex.sections) ? ex.sections : [];
  if (!sections.length || sections.length > 6) throw new Error('An exam needs 1 to 6 sections.');
  out.sections = sections.map(function (s) {
    var r = { section: cleanText_(s.section, 80) };
    if (!r.section) throw new Error('Section name is missing.');
    NUMBER_FIELDS.Sections.forEach(function (k) { r[k] = cleanNumber_(s[k], r.section + ' ' + k); });
    if ((r.correct || 0) + (r.wrong || 0) + (r.unseen || 0) > (r.questions || 0)) {
      throw new Error(r.section + ': correct + wrong + unseen exceeds the number of questions.');
    }
    return r;
  });

  var topics = Array.isArray(ex.topics) ? ex.topics : [];
  if (topics.length > 300) throw new Error('Too many topic rows.');
  out.topics = topics.map(function (t) {
    var r = { section: cleanText_(t.section, 80), topic: cleanText_(t.topic, 80) };
    if (!r.topic) throw new Error('Topic name is missing.');
    NUMBER_FIELDS.Topics.forEach(function (k) { r[k] = cleanNumber_(t[k], r.topic + ' ' + k); });
    if ((r.correct || 0) + (r.wrong || 0) > (r.total_qs || 0)) {
      throw new Error(r.topic + ': correct + wrong exceeds its questions.');
    }
    return r;
  });
  return out;
}

function cleanText_(v, maxLen) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maxLen);
}

/** Blank → null; otherwise must be a finite number between -1e7 and 1e7. */
function cleanNumber_(v, label) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!isFinite(n) || Math.abs(n) > 1e7) throw new Error('Invalid number for ' + label + '.');
  return n;
}

/** Stop text that starts with = + - @ from being treated as a formula. */
function safeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v === null || v === undefined ? '' : v;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------
function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Header name → column index (0-based), read from the sheet's first row. */
function headerIndex_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  headers.forEach(function (h, i) { if (h !== '') idx[String(h)] = i; });
  return idx;
}

function readRows_(name) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var idx = headerIndex_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var tz = Session.getScriptTimeZone();
  return values
    .filter(function (row) { return row[idx.exam_id] !== ''; })
    .map(function (row) {
      var obj = {};
      SCHEMA[name].forEach(function (col) {
        if (!(col in idx)) { obj[col] = null; return; }
        var v = row[idx[col]];
        if (v instanceof Date) v = col === 'date' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v.toISOString();
        obj[col] = v === '' ? null : v;
      });
      return obj;
    });
}

function readColumn_(name, col) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var c = headerIndex_(sheet)[col];
  return sheet.getRange(2, c + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]); });
}

/** Row number (1-based) of an exam in the Exams tab, or -1. */
function findExamRow_(id) {
  var ids = readColumn_('Exams', 'exam_id');
  var i = ids.indexOf(id);
  return i < 0 ? -1 : i + 2;
}

function getExamField_(id, col) {
  var row = findExamRow_(id);
  if (row < 0) return null;
  var sheet = getSheet_('Exams');
  var v = sheet.getRange(row, headerIndex_(sheet)[col] + 1).getValue();
  return v instanceof Date ? v.toISOString() : v;
}

/** Append objects as rows, in the sheet's own column order. */
function appendRows_(name, objects) {
  if (!objects.length) return;
  var sheet = getSheet_(name);
  var idx = headerIndex_(sheet);
  var width = sheet.getLastColumn();
  var rows = objects.map(function (o) {
    var row = new Array(width).fill('');
    Object.keys(idx).forEach(function (col) {
      if (col in o) row[idx[col]] = safeCell_(o[col]);
    });
    return row;
  });
  var start = sheet.getLastRow() + 1;
  var range = sheet.getRange(start, 1, rows.length, width);
  // Text columns first, so "2026-11-13" stays a string and isn't turned into a date.
  TEXT_COLUMNS.forEach(function (col) {
    if (col in idx) sheet.getRange(start, idx[col] + 1, rows.length, 1).setNumberFormat('@');
  });
  range.setValues(rows);
}

function writeExam_(ex) {
  var examRow = {};
  SCHEMA.Exams.forEach(function (k) { examRow[k] = ex[k]; });
  appendRows_('Exams', [examRow]);
  appendRows_('Sections', ex.sections.map(function (s) { return Object.assign({ exam_id: ex.exam_id }, s); }));
  appendRows_('Topics', ex.topics.map(function (t) { return Object.assign({ exam_id: ex.exam_id }, t); }));
}

/** Delete every row belonging to an exam, in all three tabs. */
function deleteExam_(id) {
  Object.keys(SCHEMA).forEach(function (name) {
    var ids = readColumn_(name, 'exam_id');
    var sheet = getSheet_(name);
    // Walk bottom-up and delete contiguous blocks (an exam's rows are usually together).
    var i = ids.length - 1;
    while (i >= 0) {
      if (ids[i] !== id) { i--; continue; }
      var end = i;
      while (i >= 0 && ids[i] === id) i--;
      sheet.deleteRows(i + 2 + 1, end - i);
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
