/* global Chart, ADMIN_TOKEN, ADMIN_RECENT */

(function () {
  const el = {
    refresh: document.getElementById('refresh'),
    window: document.getElementById('window'),
    method: document.getElementById('method'),
    status: document.getElementById('status'),
    path: document.getElementById('path'),
    bots: document.getElementById('bots'),
    reload: document.getElementById('reload'),
    statusline: document.getElementById('statusline'),
    events: document.getElementById('events'),
    chartReq: document.getElementById('chartReq'),
    chartErr: document.getElementById('chartErr')
  };

  const state = {
    timer: null,
    lastOkAt: 0,
    lastFetchMs: 0,
    lastError: null,
    reqChart: null,
    errChart: null,
    lastSnapshot: null
  };

  function nowMs() { return Date.now(); }

  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      return d.toISOString().replace('T', ' ').replace('Z', '');
    } catch (_) {
      return String(ts);
    }
  }

  function safeStr(x) {
    if (x === null || x === undefined) return '';
    return String(x);
  }

  function escapeHtml(s) {
    return safeStr(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseIntOr(x, fallback) {
    const n = Number.parseInt(x, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function getFilters() {
    return {
      windowMin: parseIntOr(el.window.value, 15),
      method: el.method.value.trim(),
      status: el.status.value.trim(),
      pathContains: el.path.value.trim(),
      botsOnly: el.bots.value === '1'
    };
  }

  function withinWindow(ev, windowMin) {
    const t = Number(ev?.at || ev?.ts || ev?.t || 0);
    if (!Number.isFinite(t) || !t) return false;
    const cutoff = nowMs() - windowMin * 60 * 1000;
    return t >= cutoff;
  }

  function matchFilters(ev, filters) {
    if (!withinWindow(ev, filters.windowMin)) return false;

    if (filters.method) {
      if (safeStr(ev.method).toUpperCase() !== filters.method.toUpperCase()) return false;
    }

    if (filters.status) {
      if (safeStr(ev.status) !== filters.status) return false;
    }

    if (filters.pathContains) {
      const p = safeStr(ev.path);
      if (!p.includes(filters.pathContains)) return false;
    }

    if (filters.botsOnly) {
      const reasons = ev.botReasons || ev.bot_reasons || ev.bot || [];
      const arr = Array.isArray(reasons) ? reasons : (reasons ? [reasons] : []);
      if (arr.length === 0) return false;
    }

    return true;
  }

  function getRecentEvents(snapshot) {
    // Try a few likely shapes without breaking if the server changes
    if (!snapshot) return [];
    if (Array.isArray(snapshot.recentEvents)) return snapshot.recentEvents;
    if (Array.isArray(snapshot.recent)) return snapshot.recent;
    if (snapshot.events && Array.isArray(snapshot.events.recent)) return snapshot.events.recent;
    if (Array.isArray(snapshot.lastEvents)) return snapshot.lastEvents;
    return [];
  }

  function buildSeries(events, filters) {
    // Aggregate into minute buckets for last window
    const bucketMs = 60 * 1000;
    const cutoff = nowMs() - filters.windowMin * 60 * 1000;

    const buckets = new Map();
    function bucketKey(ts) {
      return Math.floor(ts / bucketMs) * bucketMs;
    }

    for (const ev of events) {
      if (!matchFilters(ev, filters)) continue;
      const ts = Number(ev?.at || ev?.ts || ev?.t || 0);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const key = bucketKey(ts);
      const cur = buckets.get(key) || { total: 0, errors: 0 };
      cur.total += 1;
      const st = Number(ev.status);
      if (Number.isFinite(st) && st >= 400) cur.errors += 1;
      buckets.set(key, cur);
    }

    // Fill empty minutes so charts look consistent
    const keys = [];
    for (let t = Math.floor(cutoff / bucketMs) * bucketMs; t <= nowMs(); t += bucketMs) keys.push(t);

    const labels = keys.map((t) => {
      const d = new Date(t);
      return d.toISOString().slice(11, 16);
    });

    const totals = keys.map((t) => (buckets.get(t)?.total || 0));
    const errors = keys.map((t) => (buckets.get(t)?.errors || 0));

    return { labels, totals, errors };
  }

  function ensureCharts() {
    if (!state.reqChart) {
      state.reqChart = new Chart(el.chartReq, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'requests/min',
            data: [],
            tension: 0.2,
            pointRadius: 0,
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          animation: false,
          plugins: { legend: { display: true } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
      });
    }

    if (!state.errChart) {
      state.errChart = new Chart(el.chartErr, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'errors/min (>=400)',
            data: [],
            tension: 0.2,
            pointRadius: 0,
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          animation: false,
          plugins: { legend: { display: true } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
      });
    }
  }

  function renderCharts(events) {
    const filters = getFilters();
    const series = buildSeries(events, filters);
    ensureCharts();

    state.reqChart.data.labels = series.labels;
    state.reqChart.data.datasets[0].data = series.totals;
    state.reqChart.update();

    state.errChart.data.labels = series.labels;
    state.errChart.data.datasets[0].data = series.errors;
    state.errChart.update();
  }

  function renderEventsTable(events) {
    const filters = getFilters();

    const filtered = events
      .filter((ev) => matchFilters(ev, filters))
      .sort((a, b) => Number(b?.at || b?.ts || b?.t || 0) - Number(a?.at || a?.ts || a?.t || 0))
      .slice(0, 200);

    el.events.innerHTML = filtered.map((ev) => {
      const ts = Number(ev?.at || ev?.ts || ev?.t || 0);
      const botReasons = ev.botReasons || ev.bot_reasons || ev.bot || [];
      const reasonsArr = Array.isArray(botReasons) ? botReasons : (botReasons ? [botReasons] : []);

      return (
        '<tr>' +
          '<td>' + escapeHtml(fmtTime(ts)) + '</td>' +
          '<td>' + escapeHtml(safeStr(ev.method)) + '</td>' +
          '<td>' + escapeHtml(safeStr(ev.path)) + '</td>' +
          '<td>' + escapeHtml(safeStr(ev.status)) + '</td>' +
          '<td>' + escapeHtml(safeStr(ev.ms ?? ev.durationMs ?? ev.duration_ms ?? '')) + '</td>' +
          '<td title="' + escapeHtml(safeStr(ev.ua || ev.userAgent || '')) + '">' + escapeHtml(safeStr(ev.uaShort || (safeStr(ev.ua || ev.userAgent || '').slice(0, 40)))) + '</td>' +
          '<td>' + escapeHtml(reasonsArr.join(', ')) + '</td>' +
          '<td>' + escapeHtml(safeStr(ev.ip || '')) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function setStatusline(text, isError) {
    el.statusline.textContent = text;
    el.statusline.className = isError ? 'error' : 'muted';
  }

  async function fetchSnapshot() {
    const recent = Number.isFinite(Number(ADMIN_RECENT)) ? Number(ADMIN_RECENT) : 200;
    const url = new URL('/admin/stats', window.location.origin);
    if (ADMIN_TOKEN) url.searchParams.set('token', ADMIN_TOKEN);
    url.searchParams.set('recent', String(Math.min(Math.max(recent, 1), 200)));

    const start = performance.now();
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });

    state.lastFetchMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (body ? (': ' + body.slice(0, 200)) : ''));
    }

    return res.json();
  }

  async function reload() {
    setStatusline('Loading…', false);
    state.lastError = null;

    try {
      const snapshot = await fetchSnapshot();
      state.lastSnapshot = snapshot;
      state.lastOkAt = nowMs();

      const events = getRecentEvents(snapshot);
      renderCharts(events);
      renderEventsTable(events);

      setStatusline('OK · ' + state.lastFetchMs + 'ms · ' + fmtTime(state.lastOkAt), false);
    } catch (e) {
      state.lastError = e;
      setStatusline('Error: ' + (e?.message || String(e)), true);
    }
  }

  function clearTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function setupAutoRefresh() {
    clearTimer();
    const ms = parseIntOr(el.refresh.value, 0);
    if (ms > 0) {
      state.timer = setInterval(reload, ms);
    }
  }

  function hookEvents() {
    el.reload.addEventListener('click', (e) => {
      e.preventDefault();
      reload();
    });

    for (const x of [el.window, el.method, el.status, el.path, el.bots]) {
      x.addEventListener('change', () => {
        if (state.lastSnapshot) {
          const events = getRecentEvents(state.lastSnapshot);
          renderCharts(events);
          renderEventsTable(events);
        }
      });
    }

    el.path.addEventListener('input', () => {
      if (state.lastSnapshot) {
        const events = getRecentEvents(state.lastSnapshot);
        renderCharts(events);
        renderEventsTable(events);
      }
    });

    el.refresh.addEventListener('change', setupAutoRefresh);
  }

  hookEvents();
  setupAutoRefresh();
  reload();
})();
