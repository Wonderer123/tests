/**
 * calc.js: pure calculations, no DOM access.
 * Used by app.js in the browser; also loadable in Node for testing.
 *
 * Vocabulary (matches Guidely):
 *   attempted = correct + wrong
 *   skipped   = seen but not answered
 *   unseen    = never opened (ran out of time)
 *   accuracy  = correct ÷ attempted
 *   score rate (topics) = correct ÷ questions in the topic
 */
(function (root) {
  'use strict';

  // ---------- small helpers ----------

  /** Convert a cell/input value to a finite number, or null if blank/invalid. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  function sum(arr, fn) {
    return arr.reduce((acc, x) => acc + (fn ? fn(x) : x), 0);
  }

  function round(n, dp) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const f = Math.pow(10, dp === undefined ? 2 : dp);
    return Math.round(n * f) / f;
  }

  function ratio(a, b) {
    return b > 0 ? a / b : null;
  }

  /** 2649 → "44m 9s"; 0 → "0s"; null → "–" */
  function fmtTime(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return s + 's';
    return s === 0 ? m + 'm' : m + 'm ' + s + 's';
  }

  /** Format a score like Guidely: 53.25, 40, 26.5 */
  function fmtScore(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    return String(round(n, 2));
  }

  function fmtPct(r, dp) {
    if (r === null || r === undefined || !Number.isFinite(r)) return '–';
    return round(r * 100, dp === undefined ? 0 : dp) + '%';
  }

  /** "2026-11-13" → "13 Nov" (no timezone shifting: parse the parts directly). */
  function fmtDate(iso, withYear) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = Number(m[3]) + ' ' + months[Number(m[2]) - 1];
    return withYear ? d + ' ' + m[1] : d;
  }

  /** Shorter mock name for small screens: strips the long exam prefix Guidely uses. */
  function shortMockName(name) {
    return String(name || '')
      .replace(/^IBPS RRB Officer Scale-I Prelims\s*/i, '')
      .replace(/^IBPS RRB Office Assistant Prelims\s*/i, '')
      .replace(/^IBPS RRB PO Pre(lims)?\s*/i, '')
      .replace(/Quantitative Aptitude/i, 'Quant')
      .replace(/Reasoning Ability/i, 'Reasoning')
      .trim() || String(name || '');
  }

  function newExamId() {
    return 'ex_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---------- normalising input before saving ----------

  /** Find the section definition (questions/marks/negative) for an exam type. */
  function sectionDef(config, examType, sectionName) {
    const type = (config.EXAM_TYPES || []).find((t) => t.name === examType);
    const def = type && type.sections.find((s) => s.name === sectionName);
    return def || null;
  }

  /** Every section the forms can offer for a new exam type (config sections + EXTRA_SECTIONS). */
  function allSections(config) {
    const out = [];
    const seen = {};
    const add = (s) => {
      if (seen[s.name]) return;
      seen[s.name] = true;
      out.push({ name: s.name, questions: s.questions || 40, marks: s.marks || 1, negative: s.negative !== undefined ? s.negative : 0.25 });
    };
    (config.EXAM_TYPES || []).forEach((t) => t.sections.forEach(add));
    (config.EXTRA_SECTIONS || []).forEach(add);
    return out;
  }

  /**
   * Work out the sections of an exam type by name:
   *   'config'  – listed in config.js EXAM_TYPES
   *   'history' – typed before; reuse the sections of its latest saved mock
   *   'custom'  – brand new; the form asks which sections it has
   */
  function resolveExamType(config, name, exams) {
    const t = (config.EXAM_TYPES || []).find((x) => x.name === name);
    if (t) return { source: 'config', sections: t.sections.map((s) => Object.assign({}, s)) };
    const prev = (exams || []).filter((e) => e.exam_type === name && e.sections && e.sections.length).slice(-1)[0];
    if (prev) {
      return {
        source: 'history',
        sections: prev.sections.map((s) => ({ name: s.section, questions: num(s.questions) || 40, marks: 1, negative: 0.25 })),
      };
    }
    return { source: 'custom', sections: [] };
  }

  /**
   * Fill in derived fields (attempted, skipped, score, max_score) so the
   * Sheet rows are complete and human-readable. Input comes from the form or
   * an imported JSON file. Returns a new object; does not mutate the input.
   */
  function normalizeExam(input, config) {
    const exam = Object.assign({}, input);
    exam.sections = (input.sections || []).map((s0) => {
      const s = Object.assign({}, s0);
      const def = sectionDef(config, exam.exam_type, s.section) || {};
      const questions = num(s.questions) !== null ? num(s.questions) : def.questions || 0;
      const marks = def.marks !== undefined ? def.marks : (num(s.max_score) || questions) / (questions || 1);
      const negative = def.negative !== undefined ? def.negative : 0.25;
      const correct = num(s.correct) || 0;
      const wrong = num(s.wrong) || 0;
      const unseen = num(s.unseen) || 0;
      s.questions = questions;
      s.correct = correct;
      s.wrong = wrong;
      s.unseen = unseen;
      s.attempted = correct + wrong;
      s.skipped = Math.max(0, questions - s.attempted - unseen);
      s.score = round(correct * marks - wrong * negative, 2);
      s.max_score = round(questions * marks, 2);
      ['time_sec', 'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec']
        .forEach((k) => { s[k] = num(s[k]); });
      return s;
    });
    exam.topics = (input.topics || [])
      .map((t) => ({
        section: t.section,
        topic: String(t.topic || '').trim(),
        total_qs: num(t.total_qs) || 0,
        correct: num(t.correct) || 0,
        wrong: num(t.wrong) || 0,
      }))
      .filter((t) => t.topic && t.total_qs > 0);
    exam.score = round(sum(exam.sections, (s) => s.score), 2);
    exam.max_score = round(sum(exam.sections, (s) => s.max_score), 2);
    ['cutoff', 'percentile', 'rank', 'total_takers', 'average_score', 'utilized_sec']
      .forEach((k) => { exam[k] = num(exam[k]); });
    exam.incomplete = exam.incomplete === true || exam.incomplete === 'TRUE' || exam.incomplete === 'true';
    exam.notes = String(exam.notes || '');
    return exam;
  }

  /**
   * Check an exam before saving. Returns a list of human-readable problems
   * (empty list = OK). Warnings about topic totals are returned separately so
   * the form can still save when topic detail is partial.
   */
  function validateExam(exam) {
    const errors = [];
    const warnings = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exam.date || '')) errors.push('Date is missing.');
    if (!String(exam.mock_name || '').trim()) errors.push('Mock name is missing.');
    if (!exam.sections.length) errors.push('Add at least one section.');
    exam.sections.forEach((s) => {
      if (s.correct + s.wrong + s.unseen > s.questions) {
        errors.push(s.section + ': correct + wrong + unseen is more than ' + s.questions + ' questions.');
      }
      if (s.good_min !== null && s.good_max !== null && s.good_min > s.good_max) {
        errors.push(s.section + ': good attempts "from" is larger than "to".');
      }
      const ts = exam.topics.filter((t) => t.section === s.section);
      if (!ts.length) return;
      ts.forEach((t) => {
        if (t.correct + t.wrong > t.total_qs) {
          errors.push(t.topic + ': correct + wrong is more than its ' + t.total_qs + ' questions.');
        }
      });
      const q = sum(ts, (t) => t.total_qs);
      const c = sum(ts, (t) => t.correct);
      const w = sum(ts, (t) => t.wrong);
      if (q !== s.questions || c !== s.correct || w !== s.wrong) {
        warnings.push(
          s.section + ' topics add up to ' + q + ' Qs / ' + c + ' correct / ' + w + ' wrong; ' +
          'the section says ' + s.questions + ' / ' + s.correct + ' / ' + s.wrong + '.'
        );
      }
    });
    return { errors, warnings };
  }

  // ---------- building the model from API rows ----------

  /**
   * The API returns three flat lists (one per Sheet tab). Join them into
   * exam objects with nested sections/topics, sorted oldest → newest.
   * Also accepts an already-nested {exams:[{..., sections, topics}]} shape.
   */
  function buildModel(raw) {
    const exams = (raw && raw.exams) || [];
    const nested = exams.length && Array.isArray(exams[0].sections);
    const secBy = {};
    const topBy = {};
    if (!nested) {
      (raw.sections || []).forEach((s) => { (secBy[s.exam_id] = secBy[s.exam_id] || []).push(s); });
      (raw.topics || []).forEach((t) => { (topBy[t.exam_id] = topBy[t.exam_id] || []).push(t); });
    }
    const list = exams.map((e0) => {
      const e = Object.assign({}, e0);
      e.sections = (nested ? e0.sections : secBy[e.exam_id] || []).map((s) => Object.assign({}, s));
      e.topics = (nested ? e0.topics : topBy[e.exam_id] || []).map((t) => Object.assign({}, t));
      return enrichExam(e);
    });
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.created_at) < String(b.created_at) ? -1 : 1));
    list.forEach((e, i) => { e.seq = i + 1; });
    numberWithinDay(list);
    return list;
  }

  /**
   * She often takes several mocks on one day, so mocks are identified by date
   * plus their order that day: dayIndex (1, 2, 3…) and dayCount (mocks that day).
   * Works on any chronologically sorted list (e.g. a filtered one).
   */
  function numberWithinDay(list) {
    const counts = {};
    list.forEach((e) => { counts[e.date] = (counts[e.date] || 0) + 1; });
    const seen = {};
    list.forEach((e) => {
      seen[e.date] = (seen[e.date] || 0) + 1;
      e.dayIndex = seen[e.date];
      e.dayCount = counts[e.date];
    });
    return list;
  }

  /**
   * Chart axis labels, short enough for a phone. The first mock of a day shows
   * the day of the month; further mocks that day show a dot. The month is
   * printed underneath only where it changes:
   *     30   10   ·    ·   12   13   ·   ·
   *     Oct  Nov
   * The tooltip carries the full name and "mock 2 of 3".
   */
  function axisLabels(list) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let prevDate = null;
    let prevMonth = null;
    return list.map((e) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.date || ''));
      if (!m) return [String(e.date || ''), ''];
      const sameDay = e.date === prevDate;
      prevDate = e.date;
      if (sameDay) return ['·', ''];
      const month = m[1] + m[2];
      const showMonth = month !== prevMonth;
      prevMonth = month;
      return [String(Number(m[3])), showMonth ? months[Number(m[2]) - 1] : ''];
    });
  }

  /** "13 Nov · mock 2 of 5" (or just "13 Nov" when it was the only mock that day). */
  function dayLabel(e) {
    return fmtDate(e.date) + (e.dayCount > 1 ? ' · mock ' + e.dayIndex + ' of ' + e.dayCount : '');
  }

  /** Add derived numbers used throughout the dashboard. */
  function enrichExam(e) {
    ['score', 'max_score', 'cutoff', 'percentile', 'rank', 'total_takers', 'average_score', 'utilized_sec']
      .forEach((k) => { e[k] = num(e[k]); });
    e.incomplete = e.incomplete === true || e.incomplete === 'TRUE' || e.incomplete === 'true';
    e.date = String(e.date || '').slice(0, 10);
    e.sections.forEach((s) => {
      ['questions', 'correct', 'wrong', 'unseen', 'attempted', 'skipped', 'score', 'max_score', 'time_sec',
        'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec']
        .forEach((k) => { s[k] = num(s[k]); });
      s.correct = s.correct || 0;
      s.wrong = s.wrong || 0;
      s.unseen = s.unseen || 0;
      s.attempted = s.attempted !== null ? s.attempted : s.correct + s.wrong;
      s.skipped = s.skipped !== null ? s.skipped : Math.max(0, (s.questions || 0) - s.attempted - s.unseen);
      s.accuracy = ratio(s.correct, s.attempted);
      s.belowGood = s.good_min !== null && s.attempted < s.good_min;
      s.belowCutoff = s.cutoff !== null && s.score !== null && s.score < s.cutoff;
    });
    e.topics.forEach((t) => {
      ['total_qs', 'correct', 'wrong'].forEach((k) => { t[k] = num(t[k]) || 0; });
    });
    const S = e.sections;
    if (e.score === null) e.score = round(sum(S, (s) => s.score || 0), 2);
    if (e.max_score === null) e.max_score = round(sum(S, (s) => s.max_score || 0), 2);
    e.correct = sum(S, (s) => s.correct);
    e.wrong = sum(S, (s) => s.wrong);
    e.attempted = sum(S, (s) => s.attempted);
    e.skipped = sum(S, (s) => s.skipped);
    e.unseen = sum(S, (s) => s.unseen);
    e.questions = sum(S, (s) => s.questions || 0);
    e.accuracy = ratio(e.correct, e.attempted);
    e.time_sec = S.some((s) => s.time_sec !== null) ? sum(S, (s) => s.time_sec || 0) : null;

    // Time split: Guidely's "utilized" = time on correct answers,
    // "wasted" = time on wrong + skipped questions.
    const hasSplit = S.length && S.every((s) => s.time_correct_sec !== null);
    e.time_correct_sec = hasSplit ? sum(S, (s) => s.time_correct_sec || 0) : null;
    e.time_wrong_sec = hasSplit ? sum(S, (s) => s.time_wrong_sec || 0) : null;
    e.time_skipped_sec = hasSplit ? sum(S, (s) => s.time_skipped_sec || 0) : null;
    if (e.utilized_sec === null && hasSplit) e.utilized_sec = e.time_correct_sec;
    e.wasted_sec = e.time_sec !== null && e.utilized_sec !== null ? Math.max(0, e.time_sec - e.utilized_sec) : null;

    e.margin = e.cutoff !== null ? round(e.score - e.cutoff, 2) : null;
    e.vsAverage = e.average_score !== null ? round(e.score - e.average_score, 2) : null;
    return e;
  }

  // ---------- filtering ----------

  /**
   * f = { type: '' | examType, from: 'YYYY-MM-DD' | '', to: same, lastN: 0 | n,
   *       includeIncomplete: bool }
   */
  function filterExams(exams, f) {
    f = f || {};
    let out = exams.filter((e) =>
      (!f.type || e.exam_type === f.type) &&
      (!f.from || e.date >= f.from) &&
      (!f.to || e.date <= f.to) &&
      (f.includeIncomplete || !e.incomplete)
    );
    if (f.lastN > 0) out = out.slice(-f.lastN);
    return out;
  }

  /**
   * Is this a full mock or a sectional test, and which exam does it belong to?
   *   { sectional: false, family: 'IBPS RRB PO Prelims' }   full mock
   *   { sectional: true,  family: 'IBPS RRB PO Prelims' }   type has partOf in config.js
   *   { sectional: true,  family: null }                    unknown one-section type
   */
  function examKind(e, config) {
    const def = ((config && config.EXAM_TYPES) || []).find((t) => t.name === e.exam_type);
    if (def && def.partOf) return { sectional: true, family: def.partOf };
    if (!def && e.sections && e.sections.length === 1) return { sectional: true, family: null };
    return { sectional: false, family: e.exam_type };
  }

  /**
   * What the dashboard shows for the given filters.
   *   full     – full mocks of the chosen exam type: score trend, percentile, headline numbers
   *   combined – those plus sectional tests of the same exam (oldest → newest):
   *              section and topic analysis, where a 40-mark Quant sectional is
   *              exactly comparable with the Quant section of a full mock
   * "Last N" picks the last N full mocks; sectionals from that same period are kept,
   * so every view covers the same stretch of time.
   * f = { type, from, to, lastN, includeIncomplete, includeSectionals (default true) }
   */
  function dashboardData(exams, f, config) {
    f = f || {};
    const inDates = exams.filter((e) => (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to));
    const base = inDates.filter((e) => f.includeIncomplete || !e.incomplete);
    const kinds = new Map(exams.map((e) => [e, examKind(e, config)]));
    const isFull = (e) => !kinds.get(e).sectional && (!f.type || e.exam_type === f.type);
    const isSec = (e) => f.includeSectionals !== false && kinds.get(e).sectional &&
      (!f.type || kinds.get(e).family === f.type);
    let full = base.filter(isFull);
    let sectionals = base.filter(isSec);
    if (f.lastN > 0) {
      if (full.length > f.lastN) {
        full = full.slice(-f.lastN);
        const start = full[0];
        const startIdx = exams.indexOf(start);
        sectionals = sectionals.filter((e) => exams.indexOf(e) > startIdx);
      } else if (!full.length) {
        sectionals = sectionals.slice(-f.lastN);
      }
    }
    const keep = new Set(full.concat(sectionals));
    const combined = exams.filter((e) => keep.has(e));
    const hiddenIncomplete = inDates.filter((e) => e.incomplete && !f.includeIncomplete && (isFull(e) || isSec(e))).length;
    return { full, sectionals, combined, hiddenIncomplete };
  }

  /** Every attempt at one section across the given exams: [{ exam, sec, sectional }] oldest → newest. */
  function sectionEntries(exams, name, config) {
    const out = [];
    exams.forEach((e) => {
      const s = e.sections.find((x) => x.section === name);
      if (s) out.push({ exam: e, sec: s, sectional: examKind(e, config).sectional });
    });
    return out;
  }

  /** Averages for one section, from sectionEntries(). */
  function sectionSummary(entries) {
    const n = entries.length;
    if (!n) return { count: 0 };
    const S = entries.map((x) => x.sec);
    const attempted = sum(S, (s) => s.attempted);
    const withCut = S.filter((s) => s.cutoff !== null && s.score !== null);
    const withGood = S.filter((s) => s.good_min !== null);
    const withSplit = S.filter((s) => s.time_correct_sec !== null);
    const last = S[n - 1];
    return {
      count: n,
      avgScore: round(sum(S, (s) => s.score || 0) / n, 2),
      maxScore: last.max_score,
      accuracy: ratio(sum(S, (s) => s.correct), attempted),
      avgAttempted: round(attempted / n, 1),
      avgUnseen: round(sum(S, (s) => s.unseen) / n, 1),
      cleared: withCut.filter((s) => s.score >= s.cutoff).length,
      cutChecked: withCut.length,
      belowGood: withGood.filter((s) => s.attempted < s.good_min).length,
      goodChecked: withGood.length,
      avgWastedSec: withSplit.length
        ? round(sum(withSplit, (s) => (s.time_wrong_sec || 0) + (s.time_skipped_sec || 0)) / withSplit.length, 0)
        : null,
      sectionalCount: entries.filter((x) => x.sectional).length,
    };
  }

  // ---------- dashboard aggregates ----------

  function kpis(exams) {
    const n = exams.length;
    if (!n) return { count: 0 };
    const latest = exams[n - 1];
    const prev = n > 1 ? exams[n - 2] : null;
    const last5 = exams.slice(-5);
    const best = exams.reduce((b, e) => (e.score > b.score ? e : b), exams[0]);
    const pct5 = last5.filter((e) => e.percentile !== null);
    const attempted = sum(exams, (e) => e.attempted);
    return {
      count: n,
      latest,
      change: prev ? round(latest.score - prev.score, 2) : null,
      avgLast5: round(sum(last5, (e) => e.score) / last5.length, 2),
      avgLast5Count: last5.length,
      best,
      avgPercentile5: pct5.length ? round(sum(pct5, (e) => e.percentile) / pct5.length, 1) : null,
      accuracy: ratio(sum(exams, (e) => e.correct), attempted),
      clearedCount: exams.filter((e) => e.margin !== null && e.margin >= 0).length,
    };
  }

  /** Mean of the finite values fn(x) returns, or null when there are none. */
  function meanOf(arr, fn) {
    const v = arr.map(fn).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
    return v.length ? sum(v) / v.length : null;
  }

  /**
   * Mocks are judged by trend, not one-to-one: "recent form" is the average of
   * the last k mocks, compared with the average of every mock in view.
   * The verdict uses percentile when available (fair across easy and hard
   * papers), otherwise marks:
   *   'up'   recent percentile ≥ 5 points (or marks ≥ 2) above the whole-period average
   *   'down' the same amount below
   *   'flat' in between
   *   null   not enough mocks beyond the recent window to compare
   */
  function recentForm(exams, k) {
    k = k || 5;
    const n = exams.length;
    if (!n) return { count: 0 };
    const recent = exams.slice(-k);
    const comparable = n > recent.length;
    const recentAvg = meanOf(recent, (e) => e.score);
    const allAvg = meanOf(exams, (e) => e.score);
    const recentPct = meanOf(recent, (e) => e.percentile);
    const allPct = meanOf(exams, (e) => e.percentile);
    const delta = comparable && recentAvg !== null && allAvg !== null ? recentAvg - allAvg : null;
    const pctDelta = comparable && recentPct !== null && allPct !== null ? recentPct - allPct : null;
    let verdict = null;
    if (pctDelta !== null) verdict = pctDelta >= 5 ? 'up' : pctDelta <= -5 ? 'down' : 'flat';
    else if (delta !== null) verdict = delta >= 2 ? 'up' : delta <= -2 ? 'down' : 'flat';
    return {
      count: n,
      recentCount: recent.length,
      recentAvg: round(recentAvg, 2),
      allAvg: round(allAvg, 2),
      delta: round(delta, 2),
      recentPct: round(recentPct, 1),
      allPct: round(allPct, 1),
      pctDelta: round(pctDelta, 1),
      verdict,
      recentGap: round(meanOf(recent, (e) => e.margin), 2),
      recentCleared: recent.filter((e) => e.margin !== null && e.margin >= 0).length,
      recentMax: recent[recent.length - 1].max_score,
    };
  }

  /** Average of the current value and up to k−1 before it (gaps skipped): the trend line on charts. */
  function rollingAvg(values, k) {
    k = k || 5;
    return values.map((_, i) => {
      if (values[i] === null || values[i] === undefined) return null;
      const m = meanOf(values.slice(Math.max(0, i - k + 1), i + 1), (x) => x);
      return m === null ? null : round(m, 2);
    });
  }

  /** Section names in the order they first appear across the given exams. */
  function sectionNames(exams) {
    const seen = [];
    exams.forEach((e) => e.sections.forEach((s) => { if (seen.indexOf(s.section) < 0) seen.push(s.section); }));
    return seen;
  }

  /**
   * How often attempts fall short of Guidely's "good attempts" range.
   * This is the headline insight when accuracy is already high.
   */
  function attemptGap(exams) {
    const rows = [];
    exams.forEach((e) => e.sections.forEach((s) => { if (s.good_min !== null) rows.push(s); }));
    const below = rows.filter((s) => s.attempted < s.good_min);
    return {
      checked: rows.length,
      below: below.length,
      avgShort: below.length ? round(sum(below, (s) => s.good_min - s.attempted) / below.length, 1) : 0,
    };
  }

  /**
   * Per-topic statistics across the given exams.
   * Trend compares the score rate of the later half of appearances with the
   * earlier half (needs at least 2 appearances).
   */
  function topicStats(exams, config) {
    const map = {};
    exams.forEach((e) => {
      e.topics.forEach((t) => {
        const key = t.section + '||' + t.topic;
        const m = map[key] || (map[key] = { section: t.section, topic: t.topic, hits: [] });
        m.hits.push({ seq: e.seq, total: t.total_qs, correct: t.correct, wrong: t.wrong });
      });
    });
    // "Per mock" means per mock that had this topic's section, so a Quant
    // sectional test doesn't dilute the numbers for Reasoning topics.
    const perSection = {};
    exams.forEach((e) => e.sections.forEach((s) => { perSection[s.section] = (perSection[s.section] || 0) + 1; }));
    const weakBelow = config.WEAK_BELOW;
    const strongAbove = config.STRONG_ABOVE;
    const minMocks = config.MIN_MOCKS_FOR_PATTERN;
    return Object.keys(map).map((k) => {
      const m = map[k];
      const nExams = perSection[m.section] || m.hits.length || 1;
      const total = sum(m.hits, (h) => h.total);
      const correct = sum(m.hits, (h) => h.correct);
      const wrong = sum(m.hits, (h) => h.wrong);
      const attempted = correct + wrong;
      const mocks = m.hits.length;
      const rate = ratio(correct, total);
      let trend = null;
      if (mocks >= 2) {
        const half = Math.floor(mocks / 2);
        const early = m.hits.slice(0, half);
        const late = m.hits.slice(mocks - half);
        const r1 = ratio(sum(early, (h) => h.correct), sum(early, (h) => h.total));
        const r2 = ratio(sum(late, (h) => h.correct), sum(late, (h) => h.total));
        if (r1 !== null && r2 !== null) trend = r2 - r1;
      }
      let status = '';
      if (mocks >= minMocks && rate !== null) {
        if (rate < weakBelow) status = 'weak';
        else if (rate > strongAbove) status = 'strong';
      }
      return {
        section: m.section,
        topic: m.topic,
        mocks,
        total,
        correct,
        wrong,
        attempted,
        rate,                                   // correct ÷ questions
        attemptRate: ratio(attempted, total),   // how much of the topic she attempts
        accuracy: ratio(correct, attempted),    // correct ÷ attempted
        perMock: total / mocks,                 // average questions per mock it appears in
        // Questions not scored, averaged over ALL mocks shown (that had this
        // section), so a topic that appeared once doesn't outrank one that
        // leaks marks every time.
        lostPerMock: (total - correct) / nExams,
        examsInView: nExams,
        trend,
        status,
      };
    });
  }

  /** Topics losing the most marks per mock: the most useful "what to study" list. */
  function markLeaks(stats, limit) {
    return stats
      .filter((t) => t.lostPerMock > 0)
      .sort((a, b) => b.lostPerMock - a.lostPerMock)
      .slice(0, limit || 5);
  }

  // ---------- export ----------

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Three CSV tables (exams, sections, topics) in one text file. */
  function toCSV(exams) {
    const examCols = ['exam_id', 'date', 'exam_type', 'mock_name', 'score', 'max_score', 'cutoff', 'percentile',
      'rank', 'total_takers', 'average_score', 'utilized_sec', 'incomplete', 'notes'];
    const secCols = ['exam_id', 'section', 'score', 'max_score', 'questions', 'correct', 'wrong', 'attempted',
      'skipped', 'unseen', 'time_sec', 'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec',
      'time_skipped_sec'];
    const topCols = ['exam_id', 'section', 'topic', 'total_qs', 'correct', 'wrong'];
    const lines = ['# Exams', examCols.join(',')];
    exams.forEach((e) => lines.push(examCols.map((c) => csvCell(e[c])).join(',')));
    lines.push('', '# Sections', secCols.join(','));
    exams.forEach((e) => e.sections.forEach((s) =>
      lines.push(secCols.map((c) => csvCell(c === 'exam_id' ? e.exam_id : s[c])).join(','))));
    lines.push('', '# Topics', topCols.join(','));
    exams.forEach((e) => e.topics.forEach((t) =>
      lines.push(topCols.map((c) => csvCell(c === 'exam_id' ? e.exam_id : t[c])).join(','))));
    return lines.join('\r\n');
  }

  /** Strip derived fields so a JSON backup is the same shape the API accepts. */
  function toBackup(exams) {
    const keepExam = ['exam_id', 'date', 'exam_type', 'mock_name', 'score', 'max_score', 'cutoff', 'percentile',
      'rank', 'total_takers', 'average_score', 'utilized_sec', 'incomplete', 'notes', 'created_at'];
    const keepSec = ['section', 'questions', 'max_score', 'correct', 'wrong', 'unseen', 'attempted', 'skipped',
      'score', 'time_sec', 'cutoff', 'good_min', 'good_max', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec'];
    const pick = (o, keys) => keys.reduce((r, k) => { r[k] = o[k] === undefined ? null : o[k]; return r; }, {});
    return {
      app: 'mock-tracker',
      version: 1,
      exported_at: new Date().toISOString(),
      exams: exams.map((e) => Object.assign(pick(e, keepExam), {
        sections: e.sections.map((s) => pick(s, keepSec)),
        topics: e.topics.map((t) => pick(t, ['section', 'topic', 'total_qs', 'correct', 'wrong'])),
      })),
    };
  }

  const Calc = {
    num, round, ratio, sum, fmtTime, fmtScore, fmtPct, fmtDate, shortMockName, newExamId,
    sectionDef, allSections, resolveExamType, normalizeExam, validateExam, buildModel, enrichExam, filterExams, kpis,
    numberWithinDay, axisLabels, dayLabel,
    examKind, dashboardData, sectionEntries, sectionSummary, recentForm, rollingAvg,
    sectionNames, attemptGap, topicStats, markLeaks, toCSV, toBackup,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
