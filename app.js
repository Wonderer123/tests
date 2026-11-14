/**
 * app.js: UI, network calls and chart rendering.
 * Calculations live in calc.js (window.Calc); settings in config.js (window.APP_CONFIG).
 *
 * Sections of this file:
 *   1. Helpers & local storage
 *   2. State
 *   3. API (Apps Script) with timeout + retry
 *   4. Loading data
 *   5. Tabs / navigation
 *   6. Dashboard (KPIs, insight, charts, topic table)
 *   7. Add / edit form
 *   8. History list, backup & settings
 *   9. Start-up
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const C = window.Calc;

  // =========================================================================
  // 1. Helpers & local storage
  // =========================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Escape text before putting it into innerHTML. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /** localStorage can throw (private mode, blocked storage): never let it break the app. */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
    getJSON(k) { try { return JSON.parse(this.get(k) || 'null'); } catch (e) { return null; } },
    setJSON(k, v) { this.set(k, JSON.stringify(v)); },
  };
  const KEYS = {
    cache: 'mt_cache_v1',     // last data from the server, for instant start-up / offline
    pin: 'mt_pin',            // remembered PIN
    readPin: 'mt_read_pin',   // '1' if the server requires the PIN to read
    filters: 'mt_filters_v1',
    draft: 'mt_draft_v1',     // unsaved "Add mock" form
    pane: 'mt_dash_pane',     // last dashboard sub-tab
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function shortSection(name) {
    return (CFG.SECTION_SHORT && CFG.SECTION_SHORT[name]) || name;
  }

  function signed(n) {
    if (n === null || n === undefined) return '–';
    const r = C.round(n, 2);
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r);
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
  }

  /** Banner at the top of the page; `actions` = [{label, onClick}]. */
  function showBanner(html, kind, actions) {
    const el = $('#banner');
    el.className = 'banner' + (kind === 'info' ? ' info' : '');
    el.innerHTML = '<div>' + html + '</div>';
    if (actions && actions.length) {
      const box = document.createElement('div');
      box.style.display = 'flex';
      box.style.gap = '6px';
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = a.label;
        b.addEventListener('click', a.onClick);
        box.appendChild(b);
      });
      el.appendChild(box);
    }
    el.hidden = false;
  }
  function hideBanner() { $('#banner').hidden = true; }

  function setSync(text) { $('#syncStatus').textContent = text; }

  function confirmDialog(text, okLabel) {
    const dlg = $('#confirmDialog');
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel || 'Delete';
    if (typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(text));
    return new Promise((resolve) => {
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      });
      dlg.showModal();
    });
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // =========================================================================
  // 2. State
  // =========================================================================
  // Default to the main exam. Its sectional tests are counted in Sections & Topics, not in the score trend.
  const defaultFilters = { type: CFG.DEFAULT_EXAM_TYPE, from: '', to: '', lastN: 0, includeIncomplete: false, includeSectionals: true };

  /** Saved filters from older versions: a sectional type becomes its exam; unknown "last N" becomes All. */
  function normalizeFilters(saved) {
    const f = Object.assign({}, defaultFilters, saved || {});
    const def = CFG.EXAM_TYPES.find((t) => t.name === f.type);
    if (def && def.partOf) f.type = def.partOf;
    f.lastN = Number(f.lastN) || 0;
    if ([0, 5, 10].indexOf(f.lastN) < 0) f.lastN = 0;
    return f;
  }
  const state = {
    demo: !CFG.SCRIPT_URL,
    exams: [],          // full model (oldest → newest), from Calc.buildModel
    filtered: [],       // full mocks currently shown on the dashboard
    dash: null,         // Calc.dashboardData() for the current filters
    loaded: false,
    view: 'dashboard',
    pane: store.get(KEYS.pane) || 'overview',
    filters: normalizeFilters(store.getJSON(KEYS.filters)),
    trendView: 'score',     // overview chart: 'score' | 'pct'
    secName: null,          // section shown in the Sections pane
    secEntries: [],
    secMetric: 'score',     // 'score' | 'attempts' | 'time'
    topicSection: '',
    topicOrder: 'weak',     // 'weak' | 'strong' | 'freq'
    openTopics: new Set(),
    topicsAll: false,       // show every topic instead of the first 10
    openHistory: new Set(),
    editingId: null,
    formExamId: null,   // id for the exam being added (stable across retries)
    warnAck: false,     // user has seen topic-total warnings and can "save anyway"
    charts: {},
  };

  // =========================================================================
  // 3. API (Apps Script)
  // =========================================================================
  class ApiError extends Error {
    constructor(message, code) { super(message); this.code = code || ''; }
  }

  /** fetch + timeout + JSON parse. Throws ApiError with a readable message. */
  async function fetchJSON(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
    let res;
    try {
      res = await fetch(url, Object.assign({ signal: ctrl.signal, cache: 'no-store', redirect: 'follow' }, options));
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'The server took too long to answer.' : 'No connection to the server.', 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ApiError('Server error (' + res.status + ').', 'NETWORK');
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new ApiError('Unexpected reply from the server. Check SCRIPT_URL and the deployment access ("Anyone").', 'NETWORK');
    }
    if (!data || data.ok === false) throw new ApiError((data && data.error) || 'Request failed.', data && data.code);
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Read all data. Retries network failures twice (after 1s and 3s). */
  async function apiGet() {
    if (state.demo) return fetchJSON('seed/seed-data.json', {}, 15000);
    let url = CFG.SCRIPT_URL;
    if (store.get(KEYS.readPin) === '1') url += '?pin=' + encodeURIComponent(store.get(KEYS.pin) || '');
    const waits = [1000, 3000];
    for (let i = 0; ; i++) {
      try {
        return await fetchJSON(url, { method: 'GET' }, 25000);
      } catch (e) {
        if (e.code !== 'NETWORK' || i >= waits.length) throw e;
        setSync('Retrying…');
        await sleep(waits[i]);
      }
    }
  }

  /**
   * Write request. Sent as text/plain so the browser does not send a CORS
   * preflight (Apps Script can't answer one). Not retried automatically: the
   * user presses Save again, and the same exam_id makes that safe.
   */
  async function apiPost(body) {
    if (state.demo) throw new ApiError('Demo mode: saving is off. Put your Apps Script URL in config.js first.', 'DEMO');
    return fetchJSON(CFG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }, 30000);
  }

  // =========================================================================
  // 4. Loading data
  // =========================================================================
  function setData(raw) {
    state.exams = C.buildModel(raw);
    state.loaded = true;
  }

  async function refresh() {
    setSync('Updating…');
    try {
      const raw = await apiGet();
      setData(raw);
      if (!state.demo) store.setJSON(KEYS.cache, { at: Date.now(), raw: { exams: raw.exams, sections: raw.sections, topics: raw.topics } });
      hideBanner();
      if (state.demo) {
        showBanner('<b>Demo mode.</b> Showing sample data. Add your Apps Script URL to <code>config.js</code> to use your Google Sheet.', 'info');
      }
      const t = new Date();
      setSync(state.demo ? 'Demo' : 'Updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      if (e.code === 'PIN') return askReadPin(e.message);
      const cached = state.loaded;
      setSync(cached ? 'Offline copy' : 'Not loaded');
      if (state.demo && e.code === 'NETWORK') {
        showBanner('<b>Demo mode.</b> Add your Apps Script URL to <code>config.js</code> to connect your Google Sheet.', 'info');
        state.loaded = true;
      } else {
        showBanner(esc(e.message) + (cached ? ' Showing the last saved copy.' : ''), 'error',
          [{ label: 'Retry', onClick: refresh }]);
      }
    }
    renderAll();
  }

  /** The server requires a PIN even to read: ask for it in the banner. */
  function askReadPin(message) {
    store.set(KEYS.readPin, '1');
    setSync('Locked');
    showBanner(
      esc(message === 'Wrong PIN.' && store.get(KEYS.pin) ? 'Saved PIN was not accepted.' : 'Enter the PIN to view the dashboard.') +
      ' <input id="readPinInput" type="password" inputmode="numeric" style="width:110px;min-height:36px;margin-left:6px">',
      'info',
      [{
        label: 'Unlock',
        onClick: () => {
          const v = ($('#readPinInput') || {}).value || '';
          if (!v) return;
          store.set(KEYS.pin, v);
          $('#pinInput').value = v;
          refresh();
        },
      }]
    );
    renderAll();
  }

  function loadCache() {
    const c = store.getJSON(KEYS.cache);
    if (c && c.raw && Array.isArray(c.raw.exams)) {
      try { setData(c.raw); } catch (e) { store.del(KEYS.cache); }
    }
  }

  // =========================================================================
  // 5. Tabs / navigation
  // =========================================================================
  function showView(view) {
    state.view = view;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
    ['dashboard', 'add', 'history'].forEach((v) => { $('#view-' + v).hidden = v !== view; });
    if (view === 'dashboard') renderDashboard(); // charts need a visible canvas to size correctly
    if (history.replaceState) history.replaceState(null, '', view === 'dashboard' ? location.pathname : '#' + view);
    window.scrollTo(0, 0);
  }

  function renderAll() {
    renderFilterOptions();
    if (state.view === 'dashboard') renderDashboard();
    renderHistory();
    renderMockNameList();
    renderExamTypeList();
  }

  // =========================================================================
  // 6. Dashboard: three short panes (Overview · Sections · Topics) instead of
  //    one long page, so each fits a phone screen or two.
  // =========================================================================
  const PANES = ['overview', 'sections', 'topics'];
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /** Exams that can be picked as "the exam": full-mock types (sectional types belong to one of these). */
  function fullExamTypes() {
    const names = [];
    const add = (n) => { if (n && names.indexOf(n) < 0) names.push(n); };
    CFG.EXAM_TYPES.filter((t) => !t.partOf).forEach((t) => add(t.name));
    state.exams.filter((e) => !C.examKind(e, CFG).sectional).forEach((e) => add(e.exam_type));
    return names;
  }

  function filtersAreDefault() {
    const f = state.filters;
    return f.type === CFG.DEFAULT_EXAM_TYPE && !f.from && !f.to && !f.includeIncomplete && f.includeSectionals !== false;
  }

  function renderFilterOptions() {
    const f = state.filters;
    const types = fullExamTypes();
    if (f.type && types.indexOf(f.type) < 0) types.push(f.type);
    $('#fType').innerHTML = '<option value="">All exams</option>' +
      types.map((t) => '<option' + (t === f.type ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
    $('#fFrom').value = f.from || '';
    $('#fTo').value = f.to || '';
    $('#fIncomplete').checked = !!f.includeIncomplete;
    $('#fSectionals').checked = f.includeSectionals !== false;
    $$('#rangePick button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.n) === (f.lastN || 0))));
    $('#filterDot').hidden = filtersAreDefault();
  }

  function saveFilters() {
    store.setJSON(KEYS.filters, state.filters);
    renderFilterOptions();
    renderDashboard();
  }

  function readFilters() {
    state.filters = Object.assign({}, state.filters, {
      type: $('#fType').value,
      from: $('#fFrom').value,
      to: $('#fTo').value,
      includeIncomplete: $('#fIncomplete').checked,
      includeSectionals: $('#fSectionals').checked,
    });
    saveFilters();
  }

  function renderDashboard() {
    if (!state.loaded) {
      $('#dashEmpty').hidden = true;
      $('#dashBody').hidden = true;
      return;
    }
    const all = state.exams;
    $('#dashEmpty').hidden = all.length > 0;
    $('#dashBody').hidden = all.length === 0;
    if (!all.length) return;

    const d = C.dashboardData(all, state.filters, CFG);
    state.dash = d;
    state.filtered = d.full;

    const f = state.filters;
    const parts = [f.type || 'All exams'];
    if (f.lastN) parts.push('last ' + f.lastN);
    if (f.from || f.to) parts.push((f.from ? C.fmtDate(f.from) : '…') + '–' + (f.to ? C.fmtDate(f.to) : '…'));
    parts.push(plural(d.full.length, 'mock') + (d.sectionals.length ? ' + ' + plural(d.sectionals.length, 'sectional') : ''));
    $('#filterSummary').textContent = parts.join(' · ');

    $$('#dashTabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === state.pane)));
    PANES.forEach((p) => { $('#pane-' + p).hidden = p !== state.pane; });

    renderOverview(d);
    renderSectionsPane(d);
    renderTopics(d.combined);
    renderPaneCharts();
  }

  function showPane(pane) {
    if (PANES.indexOf(pane) < 0) pane = 'overview';
    state.pane = pane;
    store.set(KEYS.pane, pane);
    $$('#dashTabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
    PANES.forEach((p) => { $('#pane-' + p).hidden = p !== pane; });
    // Keep the sub-tabs in view: jump back up to them if the page was scrolled past.
    const nav = $('#dashTabs');
    const top = nav.getBoundingClientRect().top + window.scrollY - 4;
    if (window.scrollY > top) window.scrollTo(0, top);
    renderPaneCharts();
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /** "Recent" = the last RECENT mocks; charts draw the same-length rolling average as the trend line. */
  const RECENT = 5;

  /** Section names in the order the exam lists them (as on Guidely), then any others. */
  function orderedSections(list) {
    const def = CFG.EXAM_TYPES.find((t) => t.name === (state.filters.type || CFG.DEFAULT_EXAM_TYPE));
    const order = def ? def.sections.map((x) => x.name) : [];
    const rank = (n) => (order.indexOf(n) < 0 ? 99 : order.indexOf(n));
    return C.sectionNames(list).sort((a, b) => rank(a) - rank(b));
  }

  function tile(label, valueHtml, subHtml, cls) {
    return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + valueHtml + '</div>' +
      (subHtml ? '<div class="stat-sub">' + subHtml + '</div>' : '') + '</div>';
  }

  function marginBadge(margin) {
    if (margin === null || margin === undefined) return '';
    return margin >= 0
      ? '<span class="badge good">' + signed(margin) + ' vs cut-off</span>'
      : '<span class="badge bad">' + signed(margin) + ' vs cut-off</span>';
  }

  /** Cut-off status as icon + words, never colour alone. */
  function cutoffBadge(e) {
    if (e.margin === null) return '';
    const m = C.round(Math.abs(e.margin), 2);
    return e.margin >= 0
      ? '<span class="badge good"><span aria-hidden="true">✓</span> Cleared cut-off' + (m ? ' by ' + m : '') + '</span>'
      : '<span class="badge bad"><span aria-hidden="true">✕</span> ' + m + ' below cut-off</span>';
  }

  // ---------- Overview ----------
  function renderOverview(d) {
    const list = d.full;
    const notes = [];
    if (d.sectionals.length) {
      notes.push(plural(d.sectionals.length, 'sectional test') + ' (out of 40) ' + (d.sectionals.length === 1 ? 'is' : 'are') +
        ' left out of this chart but counted in <button type="button" class="link" data-pane-go="sections">Sections</button> and ' +
        '<button type="button" class="link" data-pane-go="topics">Topics</button>.');
    }
    if (d.hiddenIncomplete) {
      notes.push(plural(d.hiddenIncomplete, 'incomplete attempt') + ' hidden (see Filters).');
    }
    $('#overviewNote').innerHTML = notes.join(' ');

    if (!list.length) {
      $('#hero').innerHTML = '<p class="muted">No full mocks match these filters.</p>';
      $('#stats').innerHTML = '';
      $('#nextStep').hidden = true;
      return;
    }
    const k = C.kpis(list);
    const F = C.recentForm(list, RECENT);
    const L = k.latest;
    const recentLabel = F.recentCount === F.count ? plural(F.count, 'mock') : 'last ' + F.recentCount + ' mocks';

    let verdict = '';
    if (F.verdict) {
      const basis = F.pctDelta !== null
        ? signed(F.pctDelta) + ' percentile vs all ' + F.count
        : signed(F.delta) + ' marks vs all ' + F.count;
      verdict = F.verdict === 'up'
        ? '<span class="badge good"><span aria-hidden="true">▲</span> Improving · ' + basis + '</span>'
        : F.verdict === 'down'
          ? '<span class="badge bad"><span aria-hidden="true">▼</span> Slipping · ' + basis + '</span>'
          : '<span class="badge neutral"><span aria-hidden="true">≈</span> Steady · ' + basis + '</span>';
    }
    let gap = '';
    if (F.recentGap !== null) {
      const g = C.round(Math.abs(F.recentGap), 1);
      gap = F.recentGap >= 0
        ? '<span class="badge good"><span aria-hidden="true">✓</span> ' + g + ' above cut-off on average</span>'
        : '<span class="badge bad"><span aria-hidden="true">✕</span> ' + g + ' below cut-off on average</span>';
    }
    const meta = [];
    if (F.recentPct !== null) meta.push('<b>' + F.recentPct + '</b> avg percentile' + (F.allPct !== null && F.recentCount < F.count ? ' (all: ' + F.allPct + ')' : ''));
    meta.push('cleared <b>' + F.recentCleared + ' of ' + F.recentCount + '</b>');

    $('#hero').innerHTML =
      '<div class="hero-eyebrow">Recent form · ' + esc(recentLabel) + '</div>' +
      '<div class="hero-main"><span class="hero-num">' + C.round(F.recentAvg, 1) + '</span>' +
        '<span class="hero-of">/ ' + C.fmtScore(F.recentMax) + ' average</span></div>' +
      '<div class="hero-badges">' + verdict + gap + '</div>' +
      '<div class="hero-meta">' + meta.map((m) => '<span class="nw">' + m + '</span>').join('<span class="sep">·</span>') + '</div>' +
      '<div class="hero-latest"><span class="muted">Latest</span> ' +
        '<span class="hl-name">' + esc(C.shortMockName(L.mock_name)) + '</span>' +
        '<span class="hl-score">' + C.fmtScore(L.score) + '<small>/' + C.fmtScore(L.max_score) + '</small></span>' +
        '<span class="hl-meta">' + esc(C.dayLabel(L)) +
          (L.margin !== null ? ' · <span class="' + (L.margin >= 0 ? 'up' : 'down') + '">' + signed(L.margin) + '</span> vs cut-off' : '') +
          (L.percentile !== null ? ' · ' + C.round(L.percentile, 1) + ' %ile' : '') + '</span>' +
      '</div>';

    $('#stats').innerHTML = [
      tile('Overall avg', String(C.round(F.allAvg, 1)), 'all ' + plural(F.count, 'mock')),
      tile('Best', C.fmtScore(k.best.score), esc(C.fmtDate(k.best.date))),
      tile('Cleared', k.clearedCount + '<span class="of"> / ' + k.count + '</span>', 'cut-offs'),
    ].join('');

    renderNextStep(d);
  }

  /** "What to work on": one plain sentence plus the three topics losing the most marks. */
  function renderNextStep(d) {
    const el = $('#nextStep');
    const full = d.full;
    const comb = d.combined;
    const k = C.kpis(comb);
    const gap = C.attemptGap(comb);
    const lines = [];
    if (gap.checked && gap.below / gap.checked >= 0.5) {
      lines.push('Accuracy is <b>' + C.fmtPct(k.accuracy) + '</b>, but attempts fell short of Guidely\'s good range in <b>' +
        gap.below + ' of ' + gap.checked + '</b> sections, by about ' + gap.avgShort + ' questions. Attempting more is the quickest way up.');
    } else if (k.accuracy !== null && k.accuracy < 0.85) {
      const negLost = C.sum(comb, (e) => C.sum(e.sections, (s) => (s.wrong || 0) * 0.25)) / comb.length;
      lines.push('Accuracy is <b>' + C.fmtPct(k.accuracy) + '</b>: wrong answers cost about <b>' + C.round(negLost, 1) +
        ' marks</b> per mock. Fewer guesses would help.');
    } else if (gap.checked) {
      lines.push('Attempts were in the good range in ' + (gap.checked - gap.below) + ' of ' + gap.checked +
        ' sections, with <b>' + C.fmtPct(k.accuracy) + '</b> accuracy. Keep it up.');
    }
    const avgUnseen = full.length ? C.sum(full, (e) => e.unseen) / full.length : 0;
    if (avgUnseen >= 5) {
      lines.push('About <b>' + C.round(avgUnseen, 1) + ' questions</b> per mock are never opened: time runs out.');
    }
    const leaks = C.markLeaks(C.topicStats(comb, CFG), 3);
    el.hidden = !lines.length && !leaks.length;
    el.innerHTML = '<h2>What to work on</h2>' +
      lines.map((l) => '<p>' + l + '</p>').join('') +
      (leaks.length
        ? '<ol class="mini-leaks">' + leaks.map((t) =>
          '<li><span class="ml-name">' + esc(t.topic) + '<small>' + esc(shortSection(t.section)) + '</small></span>' +
          '<span class="ml-val">−' + C.round(t.lostPerMock, 1) + '<small> marks/mock</small></span></li>').join('') + '</ol>' +
          '<button type="button" class="link more" data-pane-go="topics">All topics →</button>'
        : '');
  }

  // ---------- charts: shared pieces ----------
  function chartsAvailable() { return typeof window.Chart !== 'undefined'; }

  function makeChart(id, config) {
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new window.Chart(document.getElementById(id), config);
  }

  function setChartDefaults() {
    window.Chart.defaults.color = cssVar('--muted');
    window.Chart.defaults.borderColor = cssVar('--grid');
    window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  }

  /** rows[i] is the exam (or {exam}) behind x position i; used for tooltip titles. */
  function baseOptions(rows) {
    const examAt = (i) => { const r = rows[i]; return r && (r.exam || r); };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 20, right: 8, left: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--tip-bg'),
          titleColor: cssVar('--tip-ink'),
          bodyColor: cssVar('--tip-ink'),
          footerColor: cssVar('--tip-muted'),
          titleFont: { weight: '600' },
          footerFont: { weight: '400' },
          padding: 10,
          cornerRadius: 8,
          boxPadding: 4,
          boxWidth: 10,
          boxHeight: 3,
          caretSize: 5,
          callbacks: {
            title: (items) => {
              const e = examAt(items[0].dataIndex);
              return e ? C.shortMockName(e.mock_name) : '';
            },
            footer: (items) => {
              const e = examAt(items[0].dataIndex);
              return e ? C.dayLabel(e) : '';
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: cssVar('--axis') },
          ticks: { maxRotation: 0, autoSkip: rows.length > 24, autoSkipPadding: 6, font: { size: 11 }, padding: 4 },
        },
        y: {
          beginAtZero: true,
          grid: { color: cssVar('--grid') },
          border: { display: false },
          ticks: { maxTicksLimit: 5, font: { size: 11 }, padding: 6 },
        },
      },
    };
  }

  /** 2px line, 8px markers with a 2px ring in the card colour so they stay legible where lines cross. */
  function lineDs(label, data, color, extra) {
    return Object.assign({
      type: 'line', label, data,
      borderColor: color, backgroundColor: color,
      borderWidth: 2, borderCapStyle: 'round', borderJoinStyle: 'round',
      pointRadius: 4, pointHoverRadius: 6, pointBorderWidth: 2,
      pointBackgroundColor: color, pointBorderColor: cssVar('--card'),
      cubicInterpolationMode: 'monotone', spanGaps: true,
    }, extra || {});
  }

  /**
   * Trend pair: every mock as a dot on a faint line (the ups and downs between
   * easy and hard papers), plus a bold rolling average of the last RECENT
   * mocks (the actual direction). Only the trend's end value is labelled.
   */
  function trendDs(label, values, color, pointExtra) {
    return [
      lineDs(label, values, cssVar('--c1-faint'), Object.assign({
        order: 1, borderWidth: 1.5, pointRadius: 3.5, pointHoverRadius: 5,
        pointBackgroundColor: color, cubicInterpolationMode: 'default', tension: 0,
      }, pointExtra || {})),
      lineDs(RECENT + '-mock average', C.rollingAvg(values, RECENT), color, {
        order: 0, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4,
        endLabel: (v) => 'avg ' + C.round(v, 1),
      }),
    ];
  }

  /** Threshold line (cut-off): dashed, no markers. */
  function cutDs(label, data) {
    return lineDs(label, data, cssVar('--c-cut'), {
      borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, cubicInterpolationMode: 'default', tension: 0,
    });
  }

  /** Writes the latest value just above the last point of datasets marked endLabel (one selective label, not one per point). */
  const endLabelPlugin = {
    id: 'endLabel',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      chart.data.datasets.forEach((ds, i) => {
        if (!ds.endLabel || !chart.isDatasetVisible(i)) return;
        let idx = -1;
        for (let j = ds.data.length - 1; j >= 0; j--) {
          if (ds.data[j] !== null && ds.data[j] !== undefined) { idx = j; break; }
        }
        const pt = chart.getDatasetMeta(i).data[idx];
        if (!pt) return;
        const text = ds.endLabel(ds.data[idx]);
        ctx.save();
        ctx.font = '650 12px ' + window.Chart.defaults.font.family;
        ctx.fillStyle = cssVar('--text');
        ctx.textBaseline = 'bottom';
        const w = ctx.measureText(text).width;
        ctx.textAlign = pt.x + w / 2 > chart.chartArea.right + 6 ? 'right' : 'center';
        const x = ctx.textAlign === 'right' ? pt.x + 6 : pt.x;
        // halo in the card colour keeps the label readable where it crosses a line or dot
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = cssVar('--card');
        ctx.strokeText(text, x, pt.y - 9);
        ctx.fillText(text, x, pt.y - 9);
        ctx.restore();
      });
    },
  };

  /** HTML legend: a key that mirrors the mark (line, dashed line, bar, band, hollow diamond). */
  function legendHtml(items) {
    return items.map((it) =>
      '<span class="lg"><i class="key key-' + it.kind + '" style="--k:' + it.color + '"></i>' + esc(it.label) + '</span>'
    ).join('');
  }

  /** The same numbers as the chart, as a small table (readable without hovering). */
  function tableHtml(head, rows) {
    return '<table class="mini"><thead><tr>' + head.map((h, i) => '<th' + (i > 1 ? ' class="num"' : '') + '>' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c, i) => '<td' + (i > 1 ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  function renderPaneCharts() {
    if (state.view !== 'dashboard' || !state.dash) return;
    if (!chartsAvailable()) {
      $$('.chart-box').forEach((b) => { b.innerHTML = '<p class="muted small">Charts could not load (offline?). Reload to try again.</p>'; });
      return;
    }
    setChartDefaults();
    if (state.pane === 'overview') renderTrendChart(state.dash.full);
    if (state.pane === 'sections') renderSectionChart();
  }

  // ---------- Overview chart: score or percentile over time ----------
  function renderTrendChart(list) {
    $$('#trendPick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.trend === state.trendView)));
    const labels = C.axisLabels(list);
    const opts = baseOptions(list);
    const accent = cssVar('--c1');
    const avgKey = { kind: 'line-bold', color: accent, label: RECENT + '-mock average' };
    let datasets;
    opts.plugins.tooltip.filter = (item) => item.parsed.y !== null;
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const e = list[items[0].dataIndex];
      return [C.dayLabel(e)].concat(e.average_score !== null ? ['Avg of all takers ' + C.fmtScore(e.average_score)] : []);
    };
    if (state.trendView === 'pct') {
      $('#trendTitle').textContent = 'Percentile';
      $('#trendLegend').innerHTML = legendHtml([{ kind: 'dotline', color: accent, label: 'Each mock' }, avgKey]);
      opts.scales.y.max = 100;
      opts.plugins.tooltip.callbacks.label = (ctx) => ' ' + ctx.dataset.label + ' ' + C.round(ctx.parsed.y, 1);
      datasets = trendDs('Percentile', list.map((e) => e.percentile), accent);
    } else {
      $('#trendTitle').textContent = 'Score';
      $('#trendLegend').innerHTML = legendHtml([
        { kind: 'dotline', color: accent, label: 'Each mock' },
        avgKey,
        { kind: 'dash', color: cssVar('--c-cut'), label: 'Cut-off' },
      ]);
      opts.scales.y.suggestedMax = Math.max.apply(null, list.map((e) => e.max_score || 0).concat([10]));
      opts.plugins.tooltip.callbacks.label = (ctx) => ' ' + ctx.dataset.label + ' ' + C.fmtScore(ctx.parsed.y);
      datasets = trendDs('Score', list.map((e) => e.score), accent).concat([cutDs('Cut-off', list.map((e) => e.cutoff))]);
    }
    makeChart('chartTrend', { type: 'line', data: { labels, datasets }, options: opts, plugins: [endLabelPlugin] });

    $('#trendTable').innerHTML = tableHtml(['Date', 'Mock', 'Score', 'Cut', 'Avg', '%ile'], list.slice().reverse().map((e) => [
      esc(C.fmtDate(e.date)), esc(C.shortMockName(e.mock_name)), C.fmtScore(e.score),
      e.cutoff === null ? '–' : C.fmtScore(e.cutoff), e.average_score === null ? '–' : C.fmtScore(e.average_score),
      e.percentile === null ? '–' : C.round(e.percentile, 1),
    ]));
  }

  // ---------- Sections pane ----------
  function renderSegButtons(container, values, current, labelOf, onPick) {
    container.innerHTML = values.map((v) =>
      '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (v === current) + '">' + esc(labelOf(v)) + '</button>'
    ).join('');
    container.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (b) onPick(b.dataset.v);
    };
  }

  function renderSectionsPane(d) {
    const names = orderedSections(d.combined);
    if (names.indexOf(state.secName) < 0) state.secName = names[0] || null;
    renderSegButtons($('#secPick'), names, state.secName, shortSection, (v) => {
      state.secName = v;
      renderSectionsPane(state.dash);
      renderPaneCharts();
    });
    const entries = state.secName ? C.sectionEntries(d.combined, state.secName, CFG) : [];
    state.secEntries = entries;
    const s = C.sectionSummary(entries);
    if (!s.count) {
      $('#secStats').innerHTML = '<p class="muted">No section data for these filters.</p>';
      return;
    }
    const sub = s.sectionalCount ? plural(s.count - s.sectionalCount, 'mock') + ' + ' + plural(s.sectionalCount, 'sectional') : plural(s.count, 'mock');
    $('#secStats').innerHTML = [
      tile('Avg score', C.round(s.avgScore, 1) + '<span class="of"> / ' + C.fmtScore(s.maxScore) + '</span>',
        s.cutChecked ? 'cleared cut-off ' + s.cleared + ' of ' + s.cutChecked : esc(sub)),
      tile('Accuracy', C.fmtPct(s.accuracy), 'correct ÷ attempted'),
      tile('Attempted', String(s.avgAttempted),
        s.goodChecked ? 'short of good range ' + s.belowGood + ' of ' + s.goodChecked : 'per ' + (s.sectionalCount ? 'attempt' : 'mock')),
      s.avgWastedSec !== null
        ? tile('Time wasted', C.fmtTime(s.avgWastedSec), 'on wrong + skipped · ' + s.avgUnseen + ' never opened')
        : tile('Never opened', String(s.avgUnseen), 'questions per attempt'),
    ].join('');
  }

  function renderSectionChart() {
    const E = state.secEntries || [];
    $$('#secMetricPick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === state.secMetric)));
    const canvasBox = $('#chartSection').parentElement;
    canvasBox.hidden = !E.length;
    if (!E.length) { $('#secLegend').innerHTML = ''; $('#secTable').innerHTML = ''; return; }

    const exams = E.map((x) => x.exam);
    const labels = C.axisLabels(exams);
    const opts = baseOptions(E);
    const accent = cssVar('--c1');
    const surface = cssVar('--card');
    const anySectional = E.some((x) => x.sectional);
    const sectionalKey = anySectional ? [{ kind: 'diamond', color: accent, label: 'Sectional test' }] : [];
    const metric = state.secMetric;
    const maxQ = Math.max.apply(null, E.map((x) => x.sec.questions || 0).concat([10]));
    let type = 'line';
    let datasets;
    let note = '';
    const tipAfter = (ctx) => (E[ctx[0].dataIndex].sectional ? 'Sectional test' : '');
    opts.plugins.tooltip.callbacks.afterTitle = tipAfter;

    if (metric === 'attempts') {
      type = 'bar';
      $('#secChartTitle').textContent = 'Attempts';
      note = 'Green = Guidely\'s "good attempts" range for that mock. Does the bar reach it?';
      $('#secLegend').innerHTML = legendHtml([
        { kind: 'bar', color: accent, label: 'Attempted' },
        { kind: 'band', color: cssVar('--c-band-key'), label: 'Good range' },
      ].concat(anySectional ? [{ kind: 'bar-hollow', color: accent, label: 'Sectional test' }] : []));
      opts.scales.y.suggestedMax = maxQ;
      opts.plugins.tooltip.filter = (item) => item.raw !== null && item.raw !== undefined;
      opts.plugins.tooltip.callbacks.label = (ctx) => {
        const s = E[ctx.dataIndex].sec;
        if (ctx.datasetIndex === 0) return ' Good range ' + s.good_min + '–' + s.good_max;
        return ' Attempted ' + s.attempted + ' · accuracy ' + C.fmtPct(s.accuracy);
      };
      // The good range is a floating bar [from, to] drawn behind a narrower attempts bar at the same x.
      datasets = [
        {
          type: 'bar', label: 'Good range', order: 2, grouped: false,
          data: E.map((x) => (x.sec.good_min !== null && x.sec.good_max !== null ? [x.sec.good_min, x.sec.good_max] : null)),
          backgroundColor: cssVar('--c-band-key'), borderRadius: 3, borderSkipped: false,
          maxBarThickness: 24, categoryPercentage: 0.8, barPercentage: 1,
        },
        {
          type: 'bar', label: 'Attempted', order: 1, grouped: false,
          data: E.map((x) => x.sec.attempted),
          backgroundColor: E.map((x) => (x.sectional ? cssVar('--c1-wash') : accent)),
          borderColor: accent, borderWidth: E.map((x) => (x.sectional ? 1.5 : 0)),
          borderRadius: 4, borderSkipped: 'start', maxBarThickness: 12, categoryPercentage: 0.8, barPercentage: 0.5,
        },
      ];
    } else if (metric === 'time') {
      type = 'bar';
      $('#secChartTitle').textContent = 'Time';
      note = 'Minutes spent on correct answers, wrong answers and skipped questions.';
      const noSplit = E.some((x) => x.sec.time_correct_sec === null && x.sec.time_sec !== null);
      $('#secLegend').innerHTML = legendHtml([
        { kind: 'bar', color: cssVar('--c-correct'), label: 'Correct' },
        { kind: 'bar', color: cssVar('--c-wrong'), label: 'Wrong' },
        { kind: 'bar', color: cssVar('--c-skip'), label: 'Skipped' },
      ].concat(noSplit ? [{ kind: 'bar', color: cssVar('--c-nosplit'), label: 'No split' }] : []));
      const toMin = (v) => (v === null || v === undefined ? null : C.round(v / 60, 2));
      const seg = (label, color, pick) => ({
        type: 'bar', label, data: E.map((x) => toMin(pick(x.sec))), backgroundColor: color,
        borderColor: surface, borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: 'start',
        borderRadius: 3, maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9,
      });
      datasets = [
        seg('Correct', cssVar('--c-correct'), (s) => s.time_correct_sec),
        seg('Wrong', cssVar('--c-wrong'), (s) => s.time_wrong_sec),
        seg('Skipped', cssVar('--c-skip'), (s) => s.time_skipped_sec),
      ];
      if (noSplit) datasets.push(seg('Time (no split)', cssVar('--c-nosplit'), (s) => (s.time_correct_sec === null ? s.time_sec : null)));
      opts.scales.x.stacked = true;
      opts.scales.y.stacked = true;
      opts.plugins.tooltip.filter = (item) => item.parsed.y !== null && item.parsed.y !== undefined;
      opts.plugins.tooltip.callbacks.label = (ctx) => ' ' + ctx.dataset.label + ' ' + C.fmtTime(ctx.parsed.y * 60);
    } else {
      $('#secChartTitle').textContent = 'Score';
      $('#secLegend').innerHTML = legendHtml([
        { kind: 'dotline', color: accent, label: 'Each attempt' },
        { kind: 'line-bold', color: accent, label: RECENT + '-attempt average' },
        { kind: 'dash', color: cssVar('--c-cut'), label: 'Cut-off' },
      ].concat(sectionalKey));
      opts.scales.y.suggestedMax = Math.max.apply(null, E.map((x) => x.sec.max_score || 0).concat([10]));
      opts.plugins.tooltip.filter = (item) => item.parsed.y !== null;
      opts.plugins.tooltip.callbacks.label = (ctx) => ' ' + ctx.dataset.label + ' ' + C.fmtScore(ctx.parsed.y);
      datasets = trendDs('Score', E.map((x) => x.sec.score), accent, {
        pointStyle: E.map((x) => (x.sectional ? 'rectRot' : 'circle')),
        pointRadius: E.map((x) => (x.sectional ? 5.5 : 3.5)),
        pointBackgroundColor: E.map((x) => (x.sectional ? surface : accent)),
        pointBorderColor: E.map((x) => (x.sectional ? accent : surface)),
      });
      datasets[1].label = RECENT + '-attempt average';
      datasets.push(cutDs('Cut-off', E.map((x) => x.sec.cutoff)));
    }
    $('#secChartNote').textContent = note;
    $('#secChartNote').hidden = !note;
    makeChart('chartSection', { type, data: { labels, datasets }, options: opts, plugins: [endLabelPlugin] });

    $('#secTable').innerHTML = tableHtml(['Date', 'Mock', 'Score', 'Att.', 'Acc.', 'Unseen', 'Time'], E.slice().reverse().map((x) => [
      esc(C.fmtDate(x.exam.date)), esc(C.shortMockName(x.exam.mock_name)) + (x.sectional ? ' <span class="tag">sectional</span>' : ''),
      C.fmtScore(x.sec.score) + '/' + C.fmtScore(x.sec.max_score), String(x.sec.attempted), C.fmtPct(x.sec.accuracy),
      String(x.sec.unseen), C.fmtTime(x.sec.time_sec),
    ]));
  }

  // ---------- Topics pane ----------
  function levelClass(rate) {
    if (rate === null) return 'lvl-none';
    if (rate < CFG.WEAK_BELOW) return 'lvl-bad';
    if (rate > CFG.STRONG_ABOVE) return 'lvl-good';
    return 'lvl-mid';
  }

  function trendText(t) {
    if (t === null) return 'Not enough mocks yet to see a trend.';
    const pts = Math.round(t * 100);
    if (pts >= 10) return 'Improving: +' + pts + ' points vs earlier mocks.';
    if (pts <= -10) return 'Slipping: −' + Math.abs(pts) + ' points vs earlier mocks.';
    return 'Steady vs earlier mocks.';
  }

  function trendGlyph(t) {
    if (t === null) return '';
    const pts = Math.round(t * 100);
    if (pts >= 10) return '<span class="tr up" title="Improving">▲</span>';
    if (pts <= -10) return '<span class="tr down" title="Slipping">▼</span>';
    return '';
  }

  const TOPICS_SHOWN = 10;

  function renderTopics(list) {
    const stats = C.topicStats(list, CFG);
    const secNames = orderedSections(list);
    if (state.topicSection && secNames.indexOf(state.topicSection) < 0) state.topicSection = '';
    renderSegButtons($('#topicSectionPick'), [''].concat(secNames), state.topicSection,
      (v) => (v ? shortSection(v) : 'All'),
      (v) => { state.topicSection = v; renderTopics(state.dash.combined); });
    $$('#topicSortPick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.topicOrder)));

    const rows = stats.filter((t) => !state.topicSection || t.section === state.topicSection);
    const showSec = !state.topicSection && secNames.length > 1;

    // Losing the most marks
    const leaks = C.markLeaks(rows, 5);
    const maxLost = leaks.length ? leaks[0].lostPerMock : 1;
    $('#leaks').innerHTML = leaks.length ? leaks.map((t) =>
      '<li>' +
        '<span class="leak-name">' + esc(t.topic) + '</span>' +
        '<span class="leak-val">−' + C.round(t.lostPerMock, 1) + '</span>' +
        '<span class="leak-bar"><span style="width:' + Math.max(4, Math.round((t.lostPerMock / maxLost) * 100)) + '%"></span></span>' +
        '<span class="leak-detail">' + (showSec ? esc(shortSection(t.section)) + ' · ' : '') + '~' + C.round(t.perMock, 1) +
          ' Qs per mock · tried ' + C.fmtPct(t.attemptRate) + ' · accuracy ' + C.fmtPct(t.accuracy) + '</span>' +
      '</li>'
    ).join('') : '<li class="muted">Add topic-wise data to see this.</li>';

    // All topics
    const order = state.topicOrder;
    rows.sort((a, b) => {
      if (order === 'freq') return b.perMock - a.perMock || a.topic.localeCompare(b.topic);
      const ra = a.rate === null ? -1 : a.rate;
      const rb = b.rate === null ? -1 : b.rate;
      const d = order === 'strong' ? rb - ra : ra - rb;
      return d || b.total - a.total;
    });
    $('#topicList').innerHTML = rows.length ? rows.map((t, i) => {
      const key = t.section + '||' + t.topic;
      const open = state.openTopics.has(key);
      const pattern = t.status === 'weak'
        ? '<span class="tag tag-bad">consistently weak</span> below ' + Math.round(CFG.WEAK_BELOW * 100) + '% across ' + t.mocks + ' mocks'
        : t.status === 'strong'
          ? '<span class="tag tag-good">consistently strong</span> above ' + Math.round(CFG.STRONG_ABOVE * 100) + '% across ' + t.mocks + ' mocks'
          : '';
      return '<li' + (i >= TOPICS_SHOWN && !state.topicsAll ? ' hidden' : '') + '>' +
        '<button type="button" class="trow" aria-expanded="' + open + '" data-topic-key="' + esc(key) + '">' +
          '<span class="tmain"><span class="tname">' + esc(t.topic) + '</span>' +
            '<span class="tsub">' + (showSec ? esc(shortSection(t.section)) + ' · ' : '') + plural(t.mocks, 'mock') + '</span></span>' +
          '<span class="tmeter" aria-hidden="true"><i class="' + levelClass(t.rate) + '" style="width:' + Math.round((t.rate || 0) * 100) + '%"></i></span>' +
          '<span class="tval">' + C.fmtPct(t.rate) + trendGlyph(t.trend) + '</span>' +
        '</button>' +
        '<div class="tdetail"' + (open ? '' : ' hidden') + '>' +
          '<span><b>' + t.correct + '</b> correct of <b>' + t.total + '</b> questions</span>' +
          '<span>Tried <b>' + C.fmtPct(t.attemptRate) + '</b> · accuracy <b>' + C.fmtPct(t.accuracy) + '</b></span>' +
          '<span>~' + C.round(t.perMock, 1) + ' questions per mock</span>' +
          '<span>' + trendText(t.trend) + '</span>' +
          (pattern ? '<span>' + pattern + '</span>' : '') +
        '</div>' +
      '</li>';
    }).join('') : '<li class="muted">No topic data for these mocks yet.</li>';
    const more = $('#topicsMore');
    more.hidden = rows.length <= TOPICS_SHOWN;
    more.textContent = state.topicsAll ? 'Show fewer' : 'Show all ' + rows.length + ' topics';
  }

  // =========================================================================
  // 7. Add / edit form
  // =========================================================================
  const form = () => $('#examForm');

  /**
   * Sections for the exam type typed in the form. Known types (config or used
   * before) bring their own sections; a brand-new type shows tick boxes and
   * uses whichever sections are ticked (or, when editing, the saved ones).
   */
  function examTypeDef(name, values) {
    const r = C.resolveExamType(CFG, name, state.exams);
    const box = $('#customSections');
    if (r.source !== 'custom') {
      box.hidden = true;
      return r;
    }
    const all = C.allSections(CFG);
    const checks = $('#customSectionChecks');
    // First time this new name is shown: tick the sections from the values being edited, if any.
    if (box.dataset.forType !== name) {
      box.dataset.forType = name;
      const pre = ((values && values.sections) || []).map((s) => s.section);
      checks.innerHTML = all.map((s) =>
        '<label class="check"><input type="checkbox" value="' + esc(s.name) + '"' + (pre.indexOf(s.name) >= 0 ? ' checked' : '') + '> ' +
        esc(shortSection(s.name)) + '</label>').join('');
    }
    box.hidden = !name;
    const ticked = $$('input:checked', checks).map((i) => i.value);
    r.sections = all.filter((s) => ticked.indexOf(s.name) >= 0);
    return r;
  }

  function renderExamTypeList() {
    const names = Array.from(new Set(CFG.EXAM_TYPES.map((t) => t.name).concat(state.exams.map((e) => e.exam_type)))).filter(Boolean);
    $('#examTypes').innerHTML = names.map((n) => '<option value="' + esc(n) + '">').join('');
  }

  /** Topic list for a section: config order first, then any topic used in past entries. */
  function topicsFor(section, extra) {
    const list = (CFG.TOPICS[section] || []).slice();
    state.exams.forEach((e) => e.topics.forEach((t) => {
      if (t.section === section && list.indexOf(t.topic) < 0) list.push(t.topic);
    }));
    (extra || []).forEach((t) => { if (list.indexOf(t) < 0) list.push(t); });
    return list;
  }

  function numInput(k, label, opts) {
    opts = opts || {};
    return '<label>' + esc(label) + '<input type="number" data-k="' + k + '" inputmode="' + (opts.decimal ? 'decimal' : 'numeric') +
      '" step="' + (opts.decimal ? 'any' : '1') + '" min="0"' + (opts.max ? ' max="' + opts.max + '"' : '') + '></label>';
  }

  function timeInput(k, label) {
    return '<label>' + esc(label) + '<div class="timepair">' +
      '<input type="number" data-t="' + k + '" data-p="m" inputmode="numeric" min="0" step="1" placeholder="min" aria-label="' + esc(label) + ' minutes">' +
      '<input type="number" data-t="' + k + '" data-p="s" inputmode="numeric" min="0" max="59" step="1" placeholder="sec" aria-label="' + esc(label) + ' seconds">' +
      '</div></label>';
  }

  function topicRowHtml(topic) {
    return '<div class="tname" data-topic="' + esc(topic) + '">' + esc(topic) + '</div>' +
      ['total_qs', 'correct', 'wrong'].map((k) =>
        '<input type="number" data-topic-k="' + k + '" data-topic-name="' + esc(topic) + '" inputmode="numeric" min="0" step="1" aria-label="' + esc(topic + ' ' + k) + '">'
      ).join('');
  }

  /** Build one card per section of the chosen exam type, then fill values. */
  function buildSectionBlocks(examTypeName, values) {
    const type = examTypeDef(examTypeName, values);
    const box = $('#sectionBlocks');
    if (!type.sections.length) {
      box.innerHTML = '<div class="card muted">' + (examTypeName ? 'Tick the sections this exam type has (above).' : 'Choose or type the exam type first.') + '</div>';
      updateLive();
      return;
    }
    box.innerHTML = type.sections.map((s) => {
      const extraTopics = ((values && values.topics) || []).filter((t) => t.section === s.name).map((t) => t.topic);
      return '<fieldset class="card sec-card" data-section="' + esc(s.name) + '" data-questions="' + s.questions + '">' +
        '<legend>' + esc(s.name) +
          '<label class="qs-inline">Qs <input type="number" data-k="questions" inputmode="numeric" min="1" step="1" value="' + s.questions + '"' +
          ' aria-label="Number of questions in ' + esc(s.name) + '"></label></legend>' +
        '<div class="grid3x">' +
          numInput('correct', 'Correct') +
          numInput('wrong', 'Wrong') +
          numInput('unseen', 'Unseen') +
        '</div>' +
        '<div class="grid3x">' +
          numInput('cutoff', 'Cut-off', { decimal: true }) +
          numInput('good_min', 'Good from') +
          numInput('good_max', 'Good to') +
        '</div>' +
        timeInput('time_sec', 'Time spent') +
        '<div class="live" data-live></div>' +
        '<details class="sub"><summary>Time split <span class="muted">(optional)</span></summary>' +
          timeInput('time_correct_sec', 'On correct answers') +
          timeInput('time_wrong_sec', 'On wrong answers') +
          timeInput('time_skipped_sec', 'On skipped questions') +
        '</details>' +
        '<details class="sub" data-topics><summary>Topic-wise <span class="muted">(optional, from "Strength &amp; Weakness")</span></summary>' +
          '<div class="topic-check" data-topic-check></div>' +
          '<div class="topic-grid" data-topic-grid>' +
            '<div class="th">Topic</div><div class="th">Qs</div><div class="th">✓</div><div class="th">✗</div>' +
            topicsFor(s.name, extraTopics).map(topicRowHtml).join('') +
          '</div>' +
          '<div class="add-topic"><input type="text" maxlength="80" placeholder="Other topic name" data-new-topic>' +
          '<button type="button" class="btn btn-sm" data-add-topic>Add</button></div>' +
        '</details>' +
      '</fieldset>';
    }).join('');
    if (values) fillSections(values);
    updateLive();
  }

  function setTime(card, k, sec) {
    const m = $('[data-t="' + k + '"][data-p="m"]', card);
    const s = $('[data-t="' + k + '"][data-p="s"]', card);
    if (!m || !s) return;
    if (sec === null || sec === undefined || sec === '') { m.value = ''; s.value = ''; return; }
    m.value = Math.floor(sec / 60);
    s.value = Math.round(sec % 60);
  }

  function getTime(card, k) {
    const m = $('[data-t="' + k + '"][data-p="m"]', card).value;
    const s = $('[data-t="' + k + '"][data-p="s"]', card).value;
    if (m === '' && s === '') return null;
    return (Number(m) || 0) * 60 + (Number(s) || 0);
  }

  function fillSections(values) {
    $$('.sec-card').forEach((card) => {
      const name = card.dataset.section;
      const s = (values.sections || []).find((x) => x.section === name);
      if (s) {
        ['questions', 'correct', 'wrong', 'unseen', 'cutoff', 'good_min', 'good_max'].forEach((k) => {
          if (k === 'questions' && !s.questions) return;
          const inp = $('[data-k="' + k + '"]', card);
          inp.value = s[k] === null || s[k] === undefined ? '' : s[k];
        });
        ['time_sec', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec'].forEach((k) => setTime(card, k, s[k]));
        if (s.time_correct_sec !== null && s.time_correct_sec !== undefined && s.time_correct_sec !== '') {
          $('details.sub', card).open = true;
        }
      }
      const ts = (values.topics || []).filter((t) => t.section === name);
      ts.forEach((t) => {
        ['total_qs', 'correct', 'wrong'].forEach((k) => {
          const inp = $$('[data-topic-k="' + k + '"]', card).find((i) => i.dataset.topicName === t.topic);
          if (inp) inp.value = t[k] === null || t[k] === undefined ? '' : t[k];
        });
      });
      if (ts.length) $('[data-topics]', card).open = true;
    });
  }

  /** Read the whole form into an exam-shaped object (raw values, not yet normalised). */
  function readForm() {
    const f = form();
    const v = (name) => f.elements[name].value.trim();
    const exam = {
      exam_id: state.editingId || state.formExamId,
      date: v('date'),
      exam_type: v('exam_type'),
      mock_name: v('mock_name'),
      cutoff: v('cutoff'),
      percentile: v('percentile'),
      average_score: v('average_score'),
      rank: v('rank'),
      total_takers: v('total_takers'),
      notes: v('notes'),
      incomplete: f.elements.incomplete.checked,
      sections: [],
      topics: [],
    };
    $$('.sec-card').forEach((card) => {
      const qs = Number($('[data-k="questions"]', card).value);
      const s = { section: card.dataset.section, questions: qs > 0 ? qs : Number(card.dataset.questions) };
      ['correct', 'wrong', 'unseen', 'cutoff', 'good_min', 'good_max'].forEach((k) => { s[k] = $('[data-k="' + k + '"]', card).value; });
      ['time_sec', 'time_correct_sec', 'time_wrong_sec', 'time_skipped_sec'].forEach((k) => { s[k] = getTime(card, k); });
      exam.sections.push(s);
      $$('.tname', card).forEach((nameEl) => {
        const topic = nameEl.dataset.topic;
        const get = (k) => $$('[data-topic-k="' + k + '"]', card).find((i) => i.dataset.topicName === topic).value;
        const t = { section: s.section, topic, total_qs: get('total_qs'), correct: get('correct'), wrong: get('wrong') };
        if (t.total_qs !== '' || t.correct !== '' || t.wrong !== '') exam.topics.push(t);
      });
    });
    return exam;
  }

  /** Live feedback: per-section numbers, topic totals check, overall total. */
  function updateLive() {
    if (!$('#sectionBlocks').children.length) return;
    const exam = C.normalizeExam(readForm(), CFG);
    $$('.sec-card').forEach((card, i) => {
      const s = exam.sections[i];
      const acc = C.ratio(s.correct, s.attempted);
      const over = s.correct + s.wrong + s.unseen > s.questions;
      const good = s.good_min !== null ? (s.attempted < s.good_min ? ' <span class="badge bad">below good range</span>' : ' <span class="badge good">in good range</span>') : '';
      $('[data-live]', card).innerHTML = over
        ? '<span class="down">Correct + wrong + unseen is more than ' + s.questions + '.</span>'
        : '<span>Attempted <b>' + s.attempted + '</b>' + good + '</span>' +
          '<span>Skipped <b>' + s.skipped + '</b></span>' +
          '<span>Score <b>' + C.fmtScore(s.score) + '</b>/' + C.fmtScore(s.max_score) + '</span>' +
          '<span>Accuracy <b>' + C.fmtPct(acc) + '</b></span>';
      const ts = exam.topics.filter((t) => t.section === s.section);
      const chk = $('[data-topic-check]', card);
      const q = C.sum(ts, (t) => t.total_qs);
      const c = C.sum(ts, (t) => t.correct);
      const w = C.sum(ts, (t) => t.wrong);
      const ok = ts.length && q === s.questions && c === s.correct && w === s.wrong;
      chk.className = 'topic-check' + (ok ? ' ok' : '');
      chk.textContent = ts.length
        ? 'Topics so far: ' + q + '/' + s.questions + ' Qs · ' + c + '/' + s.correct + ' correct · ' + w + '/' + s.wrong + ' wrong' + (ok ? ' ✓' : '')
        : 'Copy each topic\'s total questions, correct (green) and wrong (red) boxes. Leave topics that weren\'t in the mock empty.';
      $$('.tname', card).forEach((el) => {
        el.classList.toggle('row-on', ts.some((t) => t.topic === el.dataset.topic));
      });
    });
    const cutoff = C.num(form().elements.cutoff.value);
    const totalTime = C.sum(exam.sections, (s) => s.time_sec || 0);
    const att = C.sum(exam.sections, (s) => s.attempted);
    const cor = C.sum(exam.sections, (s) => s.correct);
    const margin = cutoff !== null ? exam.score - cutoff : null;
    $('#liveTotals').innerHTML =
      '<span>Total <span class="big">' + C.fmtScore(exam.score) + '</span> / ' + C.fmtScore(exam.max_score) + '</span>' +
      (margin !== null ? marginBadge(C.round(margin, 2)) : '') +
      '<span class="muted">Attempted ' + att + ' · Accuracy ' + C.fmtPct(C.ratio(cor, att)) +
      (totalTime ? ' · Time ' + C.fmtTime(totalTime) : '') + '</span>';
  }

  function resetForm(values) {
    const f = form();
    f.reset();
    state.editingId = null;
    state.formExamId = C.newExamId();
    state.warnAck = false;
    $('#formTitle').textContent = 'Add a mock';
    $('#cancelEdit').hidden = true;
    $('#saveBtn').textContent = 'Save mock';
    $('#formErrors').hidden = true;
    f.elements.date.value = todayISO();
    f.elements.exam_type.value = CFG.DEFAULT_EXAM_TYPE;
    $('#customSections').dataset.forType = ''; // rebuild the section tick boxes for a fresh form
    f.elements.pin.value = store.get(KEYS.pin) || '';
    if (values) fillMeta(values);
    buildSectionBlocks(f.elements.exam_type.value, values);
  }

  function fillMeta(values) {
    const f = form();
    ['date', 'mock_name', 'cutoff', 'percentile', 'average_score', 'rank', 'total_takers', 'notes'].forEach((k) => {
      if (values[k] !== undefined) f.elements[k].value = values[k] === null ? '' : values[k];
    });
    if (values.exam_type) f.elements.exam_type.value = values.exam_type;
    f.elements.incomplete.checked = values.incomplete === true;
  }

  function startEdit(examId) {
    const e = state.exams.find((x) => x.exam_id === examId);
    if (!e) return;
    resetForm(e);
    state.editingId = e.exam_id;
    $('#formTitle').textContent = 'Edit mock';
    $('#cancelEdit').hidden = false;
    $('#saveBtn').textContent = 'Save changes';
    showView('add');
  }

  // Draft autosave, so a half-typed mock survives switching apps on the phone.
  let draftTimer = null;
  function saveDraftSoon() {
    if (state.editingId) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const d = readForm();
      d.exam_id = state.formExamId;
      store.setJSON(KEYS.draft, d);
    }, 400);
  }

  function showFormMessages(errors, warnings) {
    const box = $('#formErrors');
    if (!errors.length && !warnings.length) { box.hidden = true; return; }
    let html = '';
    if (errors.length) html += '<b>Please fix:</b><ul>' + errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>';
    if (warnings.length) {
      html += '<b>Check the topic numbers:</b><ul>' + warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' +
        (errors.length ? '' : '<p>Press <b>Save anyway</b> if the topic detail is only partly filled in.</p>');
    }
    box.innerHTML = html;
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const f = form();
    const exam = C.normalizeExam(readForm(), CFG);
    const { errors, warnings } = C.validateExam(exam);
    const pin = f.elements.pin.value.trim();
    if (!pin && !state.demo) errors.push('Enter the PIN.');
    if (errors.length) { showFormMessages(errors, warnings); return; }
    if (warnings.length && !state.warnAck) {
      state.warnAck = true;
      $('#saveBtn').textContent = 'Save anyway';
      showFormMessages([], warnings);
      return;
    }
    showFormMessages([], []);

    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    const isEdit = !!state.editingId;
    try {
      try {
        await apiPost({ action: isEdit ? 'update' : 'add', pin, exam });
      } catch (e) {
        // A previous attempt may have saved before the connection dropped.
        if (!(e.code === 'EXISTS' && !isEdit)) throw e;
      }
      store.set(KEYS.pin, pin);
      store.del(KEYS.draft);
      toast(isEdit ? 'Changes saved ✓' : 'Mock saved ✓');
      resetForm();
      showView('dashboard');
      refresh();
    } catch (e) {
      if (e.code === 'PIN') {
        f.elements.pin.classList.add('invalid');
        f.elements.pin.focus();
      }
      showFormMessages([e.message], []);
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = state.warnAck ? 'Save anyway' : state.editingId ? 'Save changes' : 'Save mock';
    }
  }

  function initForm() {
    const f = form();
    renderExamTypeList();

    f.addEventListener('submit', onSubmit);
    // Ticking/unticking sections of a new exam type rebuilds the section cards (keeping typed values).
    $('#customSectionChecks').addEventListener('change', () => {
      buildSectionBlocks(f.elements.exam_type.value.trim(), readForm());
    });
    // Enter in the exam-type box confirms the type instead of submitting the form.
    f.elements.exam_type.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
    });
    f.addEventListener('input', (ev) => {
      if (ev.target.name === 'pin') ev.target.classList.remove('invalid');
      state.warnAck = false;
      if ($('#saveBtn').textContent === 'Save anyway') $('#saveBtn').textContent = state.editingId ? 'Save changes' : 'Save mock';
      updateLive();
      saveDraftSoon();
    });
    f.elements.exam_type.addEventListener('change', () => {
      const values = readForm();
      buildSectionBlocks(f.elements.exam_type.value.trim(), values);
    });
    const addTopic = (card) => {
      const inp = $('[data-new-topic]', card);
      const name = inp.value.trim();
      if (!name) return;
      if ($$('.tname', card).some((el) => el.dataset.topic.toLowerCase() === name.toLowerCase())) {
        toast('That topic is already in the list.');
        return;
      }
      $('[data-topic-grid]', card).insertAdjacentHTML('beforeend', topicRowHtml(name));
      inp.value = '';
      const first = $$('[data-topic-name]', card).filter((i) => i.dataset.topicName === name)[0];
      if (first) first.focus();
    };
    $('#sectionBlocks').addEventListener('click', (ev) => {
      if (ev.target.matches('[data-add-topic]')) addTopic(ev.target.closest('.sec-card'));
    });
    // Enter / "Go" in the new-topic box adds the topic instead of submitting the whole form.
    $('#sectionBlocks').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.matches('[data-new-topic]')) {
        ev.preventDefault();
        addTopic(ev.target.closest('.sec-card'));
      }
    });
    $('#cancelEdit').addEventListener('click', () => {
      resetForm();
      showView('history');
    });

    const draft = store.getJSON(KEYS.draft);
    resetForm(draft || undefined);
    if (draft && draft.exam_id) state.formExamId = draft.exam_id;
  }

  function renderMockNameList() {
    const names = Array.from(new Set(state.exams.map((e) => e.mock_name))).slice(-30);
    $('#mockNames').innerHTML = names.map((n) => '<option value="' + esc(n) + '">').join('');
  }

  // =========================================================================
  // 8. History list, backup & settings
  // =========================================================================
  /**
   * History: newest day first, grouped under a date heading. Each mock is one
   * compact row (name, score, percentile, cut-off); tapping it opens the
   * section breakdown, notes and the Edit / Delete buttons.
   */
  function renderHistory() {
    const list = state.exams.slice().reverse();
    $('#historyEmpty').hidden = list.length > 0 || !state.loaded;
    $('#historyCount').textContent = list.length ? list.length + ' saved' : '';
    let lastDate = null;
    $('#historyList').innerHTML = list.map((e) => {
      let head = '';
      if (e.date !== lastDate) {
        lastDate = e.date;
        head = '<li class="h-day"><span>' + esc(C.fmtDate(e.date, true)) + '</span>' +
          (e.dayCount > 1 ? '<span class="muted">' + e.dayCount + ' mocks</span>' : '') + '</li>';
      }
      const kind = C.examKind(e, CFG);
      const tags = [];
      if (kind.sectional) tags.push('<span class="tag">sectional</span>');
      if (e.incomplete) tags.push('<span class="tag">incomplete</span>');
      const sub = [];
      if (e.percentile !== null) sub.push('<span>' + C.round(e.percentile, 1) + ' %ile</span>');
      if (e.margin !== null) {
        sub.push('<span><span class="' + (e.margin >= 0 ? 'up' : 'down') + '">' + (e.margin >= 0 ? '✓ ' : '') + signed(e.margin) + '</span> vs cut-off</span>');
      }
      const open = state.openHistory.has(e.exam_id);
      const secs = e.sections.map((s) =>
        '<li><b>' + esc(shortSection(s.section)) + '</b>' +
        '<span>' + C.fmtScore(s.score) + '/' + C.fmtScore(s.max_score) + (s.cutoff !== null ? ' <span class="muted">(cut ' + C.fmtScore(s.cutoff) + ')</span>' : '') + '</span>' +
        '<span class="muted">' + s.attempted + ' attempted' + (s.good_min !== null ? ' (good ' + s.good_min + '–' + s.good_max + ')' : '') +
          ' · ' + C.fmtPct(s.accuracy) + ' accuracy' + (s.unseen ? ' · ' + s.unseen + ' unseen' : '') +
          (s.time_sec !== null ? ' · ' + C.fmtTime(s.time_sec) : '') + '</span></li>'
      ).join('');
      const facts = [
        e.dayCount > 1 ? 'Mock ' + e.dayIndex + ' of ' + e.dayCount + ' that day' : '',
        e.rank !== null ? 'Rank ' + e.rank.toLocaleString('en-IN') + (e.total_takers ? ' of ' + e.total_takers.toLocaleString('en-IN') : '') : '',
        e.average_score !== null ? 'Avg of all takers ' + C.fmtScore(e.average_score) : '',
        e.exam_type,
      ].filter(Boolean).map((x) => '<span>' + esc(x) + '</span>').join('');
      return head + '<li class="h-item">' +
        '<button type="button" class="h-row" aria-expanded="' + open + '" data-toggle="' + esc(e.exam_id) + '">' +
          '<span class="h-main"><span class="h-name">' + esc(C.shortMockName(e.mock_name)) + '</span>' +
            '<span class="h-sub">' + tags.join('') + sub.join('<span class="sep">·</span>') + '</span></span>' +
          '<span class="h-score">' + C.fmtScore(e.score) + '<small>/' + C.fmtScore(e.max_score) + '</small></span>' +
          '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '<div class="h-detail"' + (open ? '' : ' hidden') + '>' +
          '<ul class="h-secs">' + secs + '</ul>' +
          '<div class="h-facts">' + facts + '</div>' +
          (e.notes ? '<p class="h-notes">' + esc(e.notes) + '</p>' : '') +
          '<div class="h-actions">' +
            '<button type="button" class="btn btn-sm" data-edit="' + esc(e.exam_id) + '">Edit</button>' +
            '<button type="button" class="btn btn-sm btn-ghost danger" data-del="' + esc(e.exam_id) + '">Delete</button>' +
          '</div>' +
        '</div></li>';
    }).join('');
    $('#connInfo').textContent = state.demo
      ? 'Demo mode: not connected to a Google Sheet.'
      : 'Connected to Google Sheet via Apps Script.';
  }

  /** Open / close one expandable row (history mock or topic) without re-rendering the list. */
  function toggleRow(btn, set, key) {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.nextElementSibling.hidden = !open;
    if (open) set.add(key); else set.delete(key);
  }

  async function onHistoryClick(ev) {
    const row = ev.target.closest('[data-toggle]');
    if (row) { toggleRow(row, state.openHistory, row.dataset.toggle); return; }
    const editBtn = ev.target.closest('[data-edit]');
    if (editBtn) { startEdit(editBtn.dataset.edit); return; }
    const delBtn = ev.target.closest('[data-del]');
    if (!delBtn) return;
    const e = state.exams.find((x) => x.exam_id === delBtn.dataset.del);
    if (!e) return;
    const ok = await confirmDialog('Delete "' + C.shortMockName(e.mock_name) + '" (' + C.fmtDate(e.date) + ')? This cannot be undone.');
    if (!ok) return;
    let pin = store.get(KEYS.pin) || $('#pinInput').value.trim();
    if (!pin && !state.demo) {
      pin = window.prompt('Enter the PIN to delete:') || '';
      if (!pin) return;
    }
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try {
      await apiPost({ action: 'delete', pin, exam_id: e.exam_id });
      store.set(KEYS.pin, pin);
      state.exams = state.exams.filter((x) => x.exam_id !== e.exam_id);
      renderAll();
      toast('Deleted');
      refresh();
    } catch (err) {
      if (err.code === 'PIN') store.del(KEYS.pin);
      toast(err.message, true);
      delBtn.disabled = false;
      delBtn.textContent = 'Delete';
    }
  }

  async function onImport(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      toast('That file is not valid JSON.', true);
      return;
    }
    const list = Array.isArray(data) ? data : data && data.exams;
    if (!Array.isArray(list) || !list.length || !Array.isArray(list[0].sections)) {
      toast('No mocks found in that file.', true);
      return;
    }
    const exams = list.map((e) => C.normalizeExam(e, CFG));
    let pin = store.get(KEYS.pin) || $('#pinInput').value.trim();
    if (!pin) pin = window.prompt('Enter the PIN to import:') || '';
    if (!pin) return;
    const ok = await confirmDialog('Import ' + exams.length + ' mock' + (exams.length > 1 ? 's' : '') + '? Mocks already saved are skipped.', 'Import');
    if (!ok) return;
    setSync('Importing…');
    try {
      const res = await apiPost({ action: 'import', pin, exams });
      store.set(KEYS.pin, pin);
      toast('Imported ' + res.added + (res.skipped ? ', skipped ' + res.skipped + ' already saved' : '') + ' ✓');
      refresh();
    } catch (e) {
      if (e.code === 'PIN') store.del(KEYS.pin);
      toast(e.message, true);
      setSync('');
    }
  }

  function initHistory() {
    $('#historyList').addEventListener('click', onHistoryClick);
    $('#exportJson').addEventListener('click', () => {
      download('mock-tracker-backup-' + todayISO() + '.json', JSON.stringify(C.toBackup(state.exams), null, 1), 'application/json');
    });
    $('#exportCsv').addEventListener('click', () => {
      download('mock-tracker-' + todayISO() + '.csv', C.toCSV(state.exams), 'text/csv');
    });
    $('#importFile').addEventListener('change', onImport);
    $('#forgetPin').addEventListener('click', () => {
      store.del(KEYS.pin);
      $('#pinInput').value = '';
      toast('PIN forgotten on this device');
    });
  }

  // =========================================================================
  // 9. Start-up
  // =========================================================================
  function init() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
    document.addEventListener('click', (ev) => {
      const go = ev.target.closest('[data-goto]');
      if (go) showView(go.dataset.goto);
    });

    document.addEventListener('click', (ev) => {
      const go = ev.target.closest('[data-pane-go]');
      if (go) showPane(go.dataset.paneGo);
    });
    $('#dashTabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pane]');
      if (b) showPane(b.dataset.pane);
    });
    ['#fType', '#fFrom', '#fTo', '#fIncomplete', '#fSectionals'].forEach((id) => $(id).addEventListener('change', readFilters));
    $('#rangePick').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      state.filters = Object.assign({}, state.filters, { lastN: Number(b.dataset.n) || 0 });
      saveFilters();
    });
    $('#filterToggle').addEventListener('click', () => {
      const panel = $('#filterPanel');
      panel.hidden = !panel.hidden;
      $('#filterToggle').setAttribute('aria-expanded', String(!panel.hidden));
    });
    $('#fReset').addEventListener('click', () => {
      state.filters = Object.assign({}, defaultFilters);
      saveFilters();
    });
    $('#trendPick').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      state.trendView = b.dataset.trend;
      renderPaneCharts();
    });
    $('#secMetricPick').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      state.secMetric = b.dataset.metric;
      renderPaneCharts();
    });
    $('#topicSortPick').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      state.topicOrder = b.dataset.sort;
      renderTopics(state.dash.combined);
    });
    $('#topicsMore').addEventListener('click', () => {
      state.topicsAll = !state.topicsAll;
      renderTopics(state.dash.combined);
    });
    $('#topicList').addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-topic-key]');
      if (row) toggleRow(row, state.openTopics, row.dataset.topicKey);
    });

    // Re-colour charts when the phone switches between light and dark mode.
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onTheme = () => { if (state.view === 'dashboard') renderDashboard(); };
      if (mq.addEventListener) mq.addEventListener('change', onTheme);
    }

    loadCache(); // before initForm, so topics used in past mocks appear in the form
    initForm();
    initHistory();

    const start = (location.hash || '').replace('#', '');
    showView(['add', 'history'].indexOf(start) >= 0 ? start : 'dashboard');
    renderAll();
    refresh();
  }

  init();
})();
