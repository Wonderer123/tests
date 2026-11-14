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
  const defaultFilters = { type: '', from: '', to: '', lastN: 0, includeIncomplete: false };
  const state = {
    demo: !CFG.SCRIPT_URL,
    exams: [],          // full model (oldest → newest), from Calc.buildModel
    filtered: [],       // exams currently shown on the dashboard
    loaded: false,
    view: 'dashboard',
    filters: Object.assign({}, defaultFilters, store.getJSON(KEYS.filters) || {}),
    attemptSection: null,
    timeView: 'split',
    topicSection: '',
    topicSort: { key: 'rate', dir: 1 },
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
  }

  // =========================================================================
  // 6. Dashboard
  // =========================================================================
  function renderFilterOptions() {
    const types = Array.from(new Set(CFG.EXAM_TYPES.map((t) => t.name).concat(state.exams.map((e) => e.exam_type)))).filter(Boolean);
    const sel = $('#fType');
    const cur = state.filters.type;
    sel.innerHTML = '<option value="">All exam types</option>' +
      types.map((t) => '<option' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
    $('#fLastN').value = String(state.filters.lastN || 0);
    $('#fFrom').value = state.filters.from || '';
    $('#fTo').value = state.filters.to || '';
    $('#fIncomplete').checked = !!state.filters.includeIncomplete;
  }

  function readFilters() {
    state.filters = {
      type: $('#fType').value,
      lastN: Number($('#fLastN').value) || 0,
      from: $('#fFrom').value,
      to: $('#fTo').value,
      includeIncomplete: $('#fIncomplete').checked,
    };
    store.setJSON(KEYS.filters, state.filters);
    renderDashboard();
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

    const list = C.filterExams(all, state.filters);
    state.filtered = list;
    const hiddenIncomplete = state.filters.includeIncomplete ? 0
      : C.filterExams(all, Object.assign({}, state.filters, { includeIncomplete: true })).length - C.filterExams(all, state.filters).length;

    const f = state.filters;
    const parts = [f.type || 'All types'];
    if (f.lastN) parts.push('last ' + f.lastN);
    if (f.from || f.to) parts.push((f.from ? C.fmtDate(f.from) : '…') + '–' + (f.to ? C.fmtDate(f.to) : '…'));
    parts.push(list.length + ' mock' + (list.length === 1 ? '' : 's'));
    $('#filterSummary').textContent = parts.join(' · ');

    renderKpis(list);
    renderInsight(list, hiddenIncomplete);
    renderCharts(list);
    renderTopics(list);
  }

  function kpiTile(label, valueHtml, subHtml) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + valueHtml +
      '</div>' + (subHtml ? '<div class="kpi-sub">' + subHtml + '</div>' : '') + '</div>';
  }

  function marginBadge(margin) {
    if (margin === null || margin === undefined) return '';
    return margin >= 0
      ? '<span class="badge good">' + signed(margin) + ' vs cut-off</span>'
      : '<span class="badge bad">' + signed(margin) + ' vs cut-off</span>';
  }

  function renderKpis(list) {
    const el = $('#kpis');
    if (!list.length) {
      el.innerHTML = '<div class="card" style="grid-column:1/-1">No mocks match these filters.</div>';
      return;
    }
    const k = C.kpis(list);
    const L = k.latest;
    const ch = k.change;
    el.innerHTML = [
      kpiTile('Mocks taken', String(k.count),
        k.clearedCount + ' cleared the cut-off'),
      kpiTile('Latest score',
        C.fmtScore(L.score) + '<span class="of"> / ' + C.fmtScore(L.max_score) + '</span>',
        marginBadge(L.margin)),
      kpiTile('Change vs previous',
        ch === null ? '–' : '<span class="' + (ch > 0 ? 'up' : ch < 0 ? 'down' : '') + '">' + signed(ch) + '</span>',
        ch === null ? 'needs 2 mocks' : 'marks'),
      kpiTile('Average (last ' + k.avgLast5Count + ')', C.fmtScore(k.avgLast5),
        k.avgPercentile5 !== null ? 'avg percentile ' + k.avgPercentile5 : ''),
      kpiTile('Best score',
        C.fmtScore(k.best.score) + '<span class="of"> / ' + C.fmtScore(k.best.max_score) + '</span>',
        esc(C.shortMockName(k.best.mock_name))),
      kpiTile('Accuracy', C.fmtPct(k.accuracy),
        'correct ÷ attempted'),
    ].join('');
  }

  /** Plain-language summary: the single most useful paragraph on the page. */
  function renderInsight(list, hiddenIncomplete) {
    const el = $('#insight');
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    const lines = [];
    const k = C.kpis(list);
    const gap = C.attemptGap(list);
    const n = list.length;
    const avgUnseen = C.sum(list, (e) => e.unseen) / n;
    const negLost = C.sum(list, (e) => C.sum(e.sections, (s) => (s.wrong || 0) * 0.25)) / n;

    if (gap.checked && gap.below / gap.checked >= 0.5) {
      lines.push('Accuracy is <b>' + C.fmtPct(k.accuracy) + '</b>, but attempts were <b>below Guidely\'s "good attempts" range in ' +
        gap.below + ' of ' + gap.checked + ' sections</b> (about ' + gap.avgShort + ' questions short each time). ' +
        'Attempting more questions is the fastest way to raise the score.');
    } else if (k.accuracy !== null && k.accuracy < 0.85) {
      lines.push('Accuracy is <b>' + C.fmtPct(k.accuracy) + '</b>. Wrong answers cost about <b>' + C.round(negLost, 2) +
        ' marks per mock</b> in negative marking. Fewer guesses would help.');
    } else if (gap.checked) {
      lines.push('Attempts are within the good range in ' + (gap.checked - gap.below) + ' of ' + gap.checked +
        ' sections, with <b>' + C.fmtPct(k.accuracy) + '</b> accuracy. Keep it up.');
    }
    if (avgUnseen >= 5) {
      lines.push('On average <b>' + C.round(avgUnseen, 1) + ' questions per mock are never opened</b> because time runs out.');
    }
    const leaks = C.markLeaks(C.topicStats(list, CFG), 3);
    let focus = '';
    if (leaks.length) {
      focus = '<p><b>Focus next on:</b></p><ul>' + leaks.map((t) =>
        '<li><b>' + esc(t.topic) + '</b>: ' + C.round(t.perMock, 1) + ' Qs per mock, only ' +
        C.round(t.correct / t.mocks, 1) + ' scored on average</li>').join('') + '</ul>';
    }
    const note = hiddenIncomplete
      ? '<p class="muted small">' + hiddenIncomplete + ' incomplete attempt' + (hiddenIncomplete > 1 ? 's are' : ' is') +
        ' left out (see Filters).</p>'
      : '';
    el.innerHTML = '<h2>What the numbers say</h2>' + lines.map((l) => '<p>' + l + '</p>').join('') + focus + note;
  }

  // ---------- charts ----------
  function chartsAvailable() { return typeof window.Chart !== 'undefined'; }

  function makeChart(id, config) {
    if (state.charts[id]) state.charts[id].destroy();
    const canvas = document.getElementById(id);
    state.charts[id] = new window.Chart(canvas, config);
  }

  function tooltipTitle(items) {
    const e = state.filtered[items[0].dataIndex];
    return e ? C.shortMockName(e.mock_name) + ' · ' + C.fmtDate(e.date) : '';
  }

  function baseOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, font: { size: 11 } } },
        tooltip: { callbacks: { title: tooltipTitle } },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: cssVar('--line') },
          title: yTitle ? { display: true, text: yTitle, font: { size: 11 } } : undefined,
        },
      },
    };
  }

  function lineDs(label, data, color, extra) {
    return Object.assign({
      type: 'line', label, data, borderColor: color, backgroundColor: color,
      borderWidth: 2.5, pointRadius: 3.5, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
    }, extra || {});
  }

  function renderCharts(list) {
    const boxes = $$('.chart-box');
    if (!chartsAvailable()) {
      boxes.forEach((b) => { b.innerHTML = '<p class="muted small">Charts could not load (offline?). Reload to try again.</p>'; });
      return;
    }
    window.Chart.defaults.color = cssVar('--muted');
    window.Chart.defaults.borderColor = cssVar('--line');
    window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    const labels = list.map((e) => '#' + e.seq);
    const colors = [cssVar('--c1'), cssVar('--c2'), cssVar('--c3'), cssVar('--c4')];
    const secNames = C.sectionNames(list);

    // Score trend: score, cut-off, Guidely average
    const maxScore = Math.max.apply(null, list.map((e) => e.max_score || 0).concat([10]));
    const scoreOpts = baseOptions('Marks');
    scoreOpts.scales.y.suggestedMax = maxScore;
    makeChart('chartScore', {
      type: 'line',
      data: {
        labels,
        datasets: [
          lineDs('Score', list.map((e) => e.score), colors[0]),
          lineDs('Cut-off', list.map((e) => e.cutoff), cssVar('--c-cut'), { borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0 }),
          lineDs('Guidely average', list.map((e) => e.average_score), cssVar('--c-avg'), { borderDash: [2, 3], borderWidth: 2, pointRadius: 2 }),
        ],
      },
      options: scoreOpts,
    });

    // Percentile
    const pctOpts = baseOptions('Percentile');
    pctOpts.scales.y.max = 100;
    pctOpts.plugins.legend.display = false;
    makeChart('chartPct', {
      type: 'line',
      data: { labels, datasets: [lineDs('Percentile', list.map((e) => e.percentile), colors[2], { fill: false })] },
      options: pctOpts,
    });

    // Section scores + sectional cut-offs
    const secDs = [];
    secNames.forEach((name, i) => {
      const col = colors[i % colors.length];
      const pick = (e, k) => { const s = e.sections.find((x) => x.section === name); return s ? s[k] : null; };
      secDs.push(lineDs(shortSection(name), list.map((e) => pick(e, 'score')), col));
      secDs.push(lineDs(shortSection(name) + ' cut-off', list.map((e) => pick(e, 'cutoff')), col,
        { borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0 }));
    });
    makeChart('chartSections', {
      type: 'line',
      data: { labels, datasets: secDs },
      options: baseOptions('Marks'),
    });

    renderAttemptChart(list, secNames, labels, colors);
    renderTimeChart(list, secNames, labels, colors);
  }

  function renderSegButtons(container, names, current, onPick) {
    container.innerHTML = names.map((n) =>
      '<button type="button" data-v="' + esc(n) + '" aria-pressed="' + (n === current) + '">' + esc(n ? shortSection(n) : 'All') + '</button>'
    ).join('');
    container.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (b) onPick(b.dataset.v);
    };
  }

  function renderAttemptChart(list, secNames, labels, colors) {
    if (!secNames.length) return;
    if (secNames.indexOf(state.attemptSection) < 0) state.attemptSection = secNames[0];
    const name = state.attemptSection;
    renderSegButtons($('#attemptSectionPick'), secNames, name, (v) => { state.attemptSection = v; renderDashboard(); });

    const sec = list.map((e) => e.sections.find((s) => s.section === name) || null);
    const band = cssVar('--c-band');
    const opts = baseOptions('Questions');
    opts.scales.y1 = {
      position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false },
      ticks: { callback: (v) => v + '%' },
    };
    // Dataset 0 is the invisible lower edge of the band: hide it from legend and tooltip.
    opts.plugins.legend.labels.filter = (item) => item.datasetIndex !== 0;
    opts.plugins.tooltip.filter = (item) => item.datasetIndex !== 0 && item.parsed.y !== null;
    opts.plugins.tooltip.callbacks.label = (ctx) => {
      const s = sec[ctx.dataIndex];
      if (ctx.datasetIndex === 1) return 'Good attempts: ' + s.good_min + '–' + s.good_max;
      if (ctx.dataset.yAxisID === 'y1') return 'Accuracy: ' + C.round(ctx.parsed.y, 0) + '%';
      return ctx.dataset.label + ': ' + ctx.parsed.y;
    };
    makeChart('chartAttempts', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Good attempts (from)', data: sec.map((s) => s && s.good_min), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 3 },
          { type: 'line', label: 'Good attempts range', data: sec.map((s) => s && s.good_max), borderColor: 'transparent', backgroundColor: band, pointRadius: 0, fill: '-1', order: 3 },
          { type: 'bar', label: 'Attempted', data: sec.map((s) => s && s.attempted), backgroundColor: colors[0], borderRadius: 4, maxBarThickness: 28, order: 2 },
          lineDs('Accuracy', sec.map((s) => (s && s.accuracy !== null ? s.accuracy * 100 : null)), colors[1], { yAxisID: 'y1', order: 1 }),
        ],
      },
      options: opts,
    });
  }

  function renderTimeChart(list, secNames, labels, colors) {
    const pick = $('#timePick');
    $$('button', pick).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.time === state.timeView)));
    pick.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (b) { state.timeView = b.dataset.time; renderDashboard(); }
    };
    const toMin = (s) => (s === null || s === undefined ? null : C.round(s / 60, 2));
    let datasets;
    if (state.timeView === 'split') {
      const noSplit = list.some((e) => e.time_correct_sec === null);
      datasets = [
        { label: 'On correct answers', data: list.map((e) => toMin(e.time_correct_sec !== null ? e.time_correct_sec : e.utilized_sec)), backgroundColor: cssVar('--c-correct') },
        { label: 'On wrong answers', data: list.map((e) => toMin(e.time_wrong_sec)), backgroundColor: cssVar('--c-wrong') },
        { label: 'On skipped questions', data: list.map((e) => toMin(e.time_skipped_sec)), backgroundColor: cssVar('--c-skip') },
      ];
      if (noSplit) {
        datasets.push({ label: 'Wasted (no split entered)', data: list.map((e) => (e.time_correct_sec === null ? toMin(e.wasted_sec) : null)), backgroundColor: cssVar('--c4') });
      }
    } else {
      datasets = secNames.map((name, i) => ({
        label: shortSection(name),
        data: list.map((e) => { const s = e.sections.find((x) => x.section === name); return s ? toMin(s.time_sec) : null; }),
        backgroundColor: colors[i % colors.length],
      }));
    }
    datasets.forEach((d) => { d.borderRadius = 3; d.maxBarThickness = 28; });
    const opts = baseOptions('Minutes');
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    opts.plugins.tooltip.filter = (item) => item.parsed.y !== null && item.parsed.y !== undefined;
    opts.plugins.tooltip.callbacks.label = (ctx) => ctx.dataset.label + ': ' + C.fmtTime(ctx.parsed.y * 60);
    makeChart('chartTime', { type: 'bar', data: { labels, datasets }, options: opts });
  }

  // ---------- topics ----------
  function heatStyle(rate) {
    if (rate === null) return '';
    const hue = Math.round(Math.max(0, Math.min(1, rate)) * 120); // 0 = red, 120 = green
    return 'background:hsla(' + hue + ',75%,45%,.22)';
  }

  function trendCell(t) {
    if (t === null) return '<span class="muted">–</span>';
    const pts = Math.round(t * 100);
    if (pts >= 10) return '<span class="trend-up">▲' + pts + '</span>';
    if (pts <= -10) return '<span class="trend-down">▼' + Math.abs(pts) + '</span>';
    return '<span class="muted">≈</span>';
  }

  function renderTopics(list) {
    const stats = C.topicStats(list, CFG);
    const secNames = C.sectionNames(list);
    if (state.topicSection && secNames.indexOf(state.topicSection) < 0) state.topicSection = '';
    renderSegButtons($('#topicSectionPick'), [''].concat(secNames), state.topicSection, (v) => {
      state.topicSection = v;
      renderTopics(state.filtered);
    });

    const rows = stats.filter((t) => !state.topicSection || t.section === state.topicSection);
    const { key, dir } = state.topicSort;
    rows.sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb) || b.total - a.total;
    });
    $$('#topicTable th').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.sort === key ? (dir > 0 ? 'ascending' : 'descending') : 'none');
    });
    const tbody = $('#topicTable tbody');
    tbody.innerHTML = rows.length ? rows.map((t) =>
      '<tr>' +
        '<td>' + esc(t.topic) + '<span class="topic-sec">' + esc(shortSection(t.section)) + ' · ' + t.mocks + ' mock' + (t.mocks > 1 ? 's' : '') + '</span></td>' +
        '<td class="num heat" style="' + heatStyle(t.rate) + '">' + C.fmtPct(t.rate) + '</td>' +
        '<td class="num">' + C.fmtPct(t.attemptRate) + '</td>' +
        '<td class="num">' + C.fmtPct(t.accuracy) + '</td>' +
        '<td class="num">' + trendCell(t.trend) + '</td>' +
        '<td class="num wide-only">' + t.mocks + '</td>' +
        '<td class="num wide-only">' + C.round(t.perMock, 1) + '</td>' +
      '</tr>'
    ).join('') : '<tr><td colspan="7" class="muted">No topic data for these mocks yet.</td></tr>';

    // Consistently weak / strong
    const pct = (x) => Math.round(x * 100) + '%';
    $('#weakRule').textContent = 'Score below ' + pct(CFG.WEAK_BELOW) + ' across ' + CFG.MIN_MOCKS_FOR_PATTERN + '+ mocks';
    $('#strongRule').textContent = 'Score above ' + pct(CFG.STRONG_ABOVE) + ' across ' + CFG.MIN_MOCKS_FOR_PATTERN + '+ mocks';
    const chip = (t) => '<li>' + esc(t.topic) + ' <b>' + C.fmtPct(t.rate) + '</b></li>';
    const weak = stats.filter((t) => t.status === 'weak').sort((a, b) => a.rate - b.rate);
    const strong = stats.filter((t) => t.status === 'strong').sort((a, b) => b.rate - a.rate);
    $('#weakList').innerHTML = weak.length ? weak.map(chip).join('') : '<li class="none">None yet</li>';
    $('#strongList').innerHTML = strong.length ? strong.map(chip).join('') : '<li class="none">None yet</li>';

    // Marks lost per topic
    const leaks = C.markLeaks(stats, 6);
    const maxLost = leaks.length ? leaks[0].lostPerMock : 1;
    $('#leaks').innerHTML = leaks.length ? leaks.map((t) =>
      '<li>' +
        '<span class="leak-name">' + esc(t.topic) + '</span>' +
        '<span class="leak-val">−' + C.round(t.lostPerMock, 1) + '</span>' +
        '<span class="leak-bar"><span style="width:' + Math.round((t.lostPerMock / maxLost) * 100) + '%"></span></span>' +
        '<span class="leak-detail">' + esc(shortSection(t.section)) + ' · in ' + t.mocks + '/' + t.examsInView + ' mocks · ~' +
          C.round(t.perMock, 1) + ' Qs each time · tried ' + C.fmtPct(t.attemptRate) + ' · accuracy ' + C.fmtPct(t.accuracy) + '</span>' +
      '</li>'
    ).join('') : '<li class="muted">Add topic-wise data to see this.</li>';
  }

  // =========================================================================
  // 7. Add / edit form
  // =========================================================================
  const form = () => $('#examForm');

  function examTypeDef(name) {
    return CFG.EXAM_TYPES.find((t) => t.name === name) || CFG.EXAM_TYPES[0];
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
    const type = examTypeDef(examTypeName);
    const box = $('#sectionBlocks');
    box.innerHTML = type.sections.map((s) => {
      const extraTopics = ((values && values.topics) || []).filter((t) => t.section === s.name).map((t) => t.topic);
      return '<fieldset class="card sec-card" data-section="' + esc(s.name) + '" data-questions="' + s.questions + '">' +
        '<legend>' + esc(s.name) + ' <span class="muted small">(' + s.questions + ' Qs)</span></legend>' +
        '<div class="grid3x">' +
          numInput('correct', 'Correct', { max: s.questions }) +
          numInput('wrong', 'Wrong', { max: s.questions }) +
          numInput('unseen', 'Unseen', { max: s.questions }) +
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
        ['correct', 'wrong', 'unseen', 'cutoff', 'good_min', 'good_max'].forEach((k) => {
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
      const s = { section: card.dataset.section, questions: Number(card.dataset.questions) };
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
    f.elements.pin.value = store.get(KEYS.pin) || '';
    if (values) fillMeta(values);
    buildSectionBlocks(f.elements.exam_type.value, values);
  }

  function fillMeta(values) {
    const f = form();
    ['date', 'mock_name', 'cutoff', 'percentile', 'average_score', 'rank', 'total_takers', 'notes'].forEach((k) => {
      if (values[k] !== undefined) f.elements[k].value = values[k] === null ? '' : values[k];
    });
    if (values.exam_type && CFG.EXAM_TYPES.some((t) => t.name === values.exam_type)) f.elements.exam_type.value = values.exam_type;
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
    f.elements.exam_type.innerHTML = CFG.EXAM_TYPES.map((t) => '<option>' + esc(t.name) + '</option>').join('');

    f.addEventListener('submit', onSubmit);
    f.addEventListener('input', (ev) => {
      if (ev.target.name === 'pin') ev.target.classList.remove('invalid');
      state.warnAck = false;
      if ($('#saveBtn').textContent === 'Save anyway') $('#saveBtn').textContent = state.editingId ? 'Save changes' : 'Save mock';
      updateLive();
      saveDraftSoon();
    });
    f.elements.exam_type.addEventListener('change', () => {
      const values = readForm();
      buildSectionBlocks(f.elements.exam_type.value, values);
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
  function renderHistory() {
    const list = state.exams.slice().reverse();
    $('#historyEmpty').hidden = list.length > 0 || !state.loaded;
    $('#historyCount').textContent = list.length ? list.length + ' saved' : '';
    $('#historyList').innerHTML = list.map((e) => {
      const meta = [
        C.fmtDate(e.date, true),
        e.percentile !== null ? e.percentile + ' %ile' : '',
        'accuracy ' + C.fmtPct(e.accuracy),
        e.exam_type,
      ].filter(Boolean).map((m) => '<span>' + esc(m) + '</span>').join('');
      return '<li>' +
        '<div class="h-top"><div class="h-name">#' + e.seq + ' ' + esc(C.shortMockName(e.mock_name)) + '</div>' +
        '<div class="h-score">' + C.fmtScore(e.score) + '<span class="muted small"> / ' + C.fmtScore(e.max_score) + '</span></div></div>' +
        '<div class="h-meta">' + meta + marginBadge(e.margin) +
        (e.incomplete ? '<span class="badge neutral">incomplete</span>' : '') + '</div>' +
        (e.notes ? '<div class="small muted" style="margin:-4px 0 8px">' + esc(e.notes) + '</div>' : '') +
        '<div class="h-actions">' +
          '<button type="button" class="btn btn-sm" data-edit="' + esc(e.exam_id) + '">Edit</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-del="' + esc(e.exam_id) + '">Delete</button>' +
        '</div></li>';
    }).join('');
    $('#connInfo').textContent = state.demo
      ? 'Demo mode: not connected to a Google Sheet.'
      : 'Connected to Google Sheet via Apps Script.';
  }

  async function onHistoryClick(ev) {
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

    ['#fType', '#fLastN', '#fFrom', '#fTo', '#fIncomplete'].forEach((id) => $(id).addEventListener('change', readFilters));
    $('#fReset').addEventListener('click', () => {
      state.filters = Object.assign({}, defaultFilters);
      store.setJSON(KEYS.filters, state.filters);
      renderFilterOptions();
      renderDashboard();
    });
    $$('#topicTable th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.topicSort = state.topicSort.key === key
        ? { key, dir: -state.topicSort.dir }
        : { key, dir: key === 'topic' ? 1 : key === 'rate' || key === 'accuracy' || key === 'attemptRate' || key === 'trend' ? 1 : -1 };
      renderTopics(state.filtered);
    }));

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
