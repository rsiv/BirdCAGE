/**
 * BirdCAGE Phase 1 dashboard — client-side data fetch + render
 *
 * Globals expected on window (injected by index.html):
 *   API_BASE    — e.g. "https://birdsapi.coupland.me"
 *   SCRIPT_NAME — Flask SCRIPT_NAME prefix (may be "")
 */

(function () {
  'use strict';

  // ── Chart palette ──────────────────────────────────────────────────
  const PALETTE = [
    '#1D9E75','#4a90d9','#e6a817','#e05c5c','#9b59b6',
    '#2ecc71','#3498db','#f39c12','#e74c3c','#8e44ad',
  ];

  // ── State ──────────────────────────────────────────────────────────
  let lookbackDays = parseInt(localStorage.getItem('bc_lookback') || '1', 10);
  let hourlyChart = null;
  let barChart = null;
  let refreshTimer = null;

  // ── Wikipedia helpers ──────────────────────────────────────────────
  // "European Robin" → "European_robin"
  // "Eurasian Blue Tit" → "Eurasian_blue_tit"
  function wikiSlug(name) {
    const lower = name.toLowerCase().replace(/ /g, '_');
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function wikiUrl(name) {
    return `https://en.wikipedia.org/wiki/${wikiSlug(name)}`;
  }

  // Thumbnail cache: slug → Promise<url|null>
  const _thumbCache = new Map();

  function fetchWikiThumb(name) {
    const slug = wikiSlug(name);
    if (_thumbCache.has(slug)) return _thumbCache.get(slug);
    const p = fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => data?.thumbnail?.source ?? null)
      .catch(() => null);
    _thumbCache.set(slug, p);
    return p;
  }

  // Build a species name element: tiny thumb + linked name
  function speciesEl(name, thumbSize = 20) {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';

    // Thumbnail — inserted once promise resolves
    const img = document.createElement('img');
    img.style.cssText = `width:${thumbSize}px;height:${thumbSize}px;object-fit:cover;border-radius:3px;display:none;`;
    img.alt = '';
    fetchWikiThumb(name).then(src => {
      if (src) { img.src = src; img.style.display = ''; }
    });
    wrap.appendChild(img);

    // Linked name
    const a = document.createElement('a');
    a.href = wikiUrl(name);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = name;
    a.addEventListener('click', e => e.stopPropagation());
    wrap.appendChild(a);

    return wrap;
  }

  // ── General helpers ────────────────────────────────────────────────
  function today() {
    return new Date().toISOString().split('T')[0];
  }

  function dateNDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n + 1);
    return d.toISOString().split('T')[0];
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function loading(el) {
    el.innerHTML = '<div class="bc-loading">Loading…</div>';
  }

  function heatColor(ratio) {
    const r = Math.round(255 - ratio * (255 - 29));
    const g = Math.round(255 - ratio * (255 - 158));
    const b = Math.round(255 - ratio * (255 - 117));
    return `rgb(${r},${g},${b})`;
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  // ── Look-back selector ─────────────────────────────────────────────
  function initLookback() {
    document.querySelectorAll('input[name="lookback"]').forEach(radio => {
      if (parseInt(radio.value, 10) === lookbackDays) radio.checked = true;
      radio.addEventListener('change', () => {
        lookbackDays = parseInt(radio.value, 10);
        localStorage.setItem('bc_lookback', lookbackDays);
        loadDashboard();
      });
    });
  }

  // ── Main orchestrator ──────────────────────────────────────────────
  async function loadDashboard() {
    const start = dateNDaysAgo(lookbackDays);
    const end = today();

    const [reportData, recentData, highConfData] = await Promise.all([
      fetchJSON(`${API_BASE}/api/detections/date_range_report/${start}/${end}`),
      fetchJSON(`${API_BASE}/api/detections/recent/50`),
      fetchJSON(`${API_BASE}/api/detections/date_range/${start}/${end}/highest_confidence`),
    ]);

    // Hourly data: single day or aggregate across multiple days
    let hourlyData = [];
    if (lookbackDays === 1) {
      hourlyData = await fetchJSON(`${API_BASE}/api/detections/count_by_hour/${end}`);
    } else {
      const days = [];
      for (let i = 0; i < lookbackDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split('T')[0]);
      }
      const allDays = await Promise.all(
        days.map(d => fetchJSON(`${API_BASE}/api/detections/count_by_hour/${d}`))
      );
      hourlyData = allDays.flat();
    }

    renderStats(reportData, recentData, lookbackDays);
    renderHourlyChart(hourlyData, lookbackDays);
    renderBarChart(reportData);
    renderHeatmap(hourlyData);
    renderRecentDetections(recentData);
    renderSparklines(reportData, lookbackDays);
    renderRarest(reportData, highConfData);
  }

  // ── Stats row ──────────────────────────────────────────────────────
  function renderStats(report, recent, days) {
    const total = report.reduce((s, r) => s + r.daily_count, 0);

    const allSpecies = [...new Set(report.map(r => r.common_name))];
    const todayStr = today();
    const newToday = days > 1
      ? allSpecies.filter(s =>
          report.some(r => r.date === todayStr && r.common_name === s) &&
          !report.some(r => r.date !== todayStr && r.common_name === s)
        ).length
      : 0;

    const hourCounts = {};
    recent.forEach(det => {
      const h = new Date(det[1]).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    });
    const peakHour = Object.entries(hourCounts).sort((a,b) => b[1]-a[1])[0];
    const peakHourStr = peakHour ? `${String(peakHour[0]).padStart(2,'0')}:00` : '—';

    const speciesTotals = {};
    report.forEach(r => { speciesTotals[r.common_name] = (speciesTotals[r.common_name]||0) + r.daily_count; });
    const topEntry = Object.entries(speciesTotals).sort((a,b) => b[1]-a[1])[0];
    const topSpecies = topEntry ? `${topEntry[0]} (${topEntry[1]})` : '—';

    setText('stat-total', total.toLocaleString());
    const specEl = document.getElementById('stat-species');
    if (specEl) {
      specEl.textContent = allSpecies.length;
      const badge = specEl.parentElement.querySelector('.stat-badge');
      if (badge && days > 1 && newToday > 0) {
        badge.textContent = `+${newToday} today`;
        badge.style.display = '';
      } else if (badge) {
        badge.style.display = 'none';
      }
    }
    setText('stat-peak-hour', peakHourStr);
    setText('stat-top-species', topSpecies);
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ── Hourly activity chart ──────────────────────────────────────────
  function renderHourlyChart(hourlyData, days) {
    const counts = Array(24).fill(0);
    hourlyData.forEach(row => {
      const h = parseInt(row.hour, 10);
      if (h >= 0 && h < 24) counts[h] += row.count;
    });

    const labels = counts.map((_, i) => `${String(i).padStart(2,'0')}:00`);
    const values = days > 1
      ? counts.map(c => +(c / days).toFixed(1))
      : counts;

    const ctx = document.getElementById('hourly-chart');
    if (!ctx) return;

    if (hourlyChart) hourlyChart.destroy();
    hourlyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: days > 1 ? 'Avg detections/hour' : 'Detections',
          data: values,
          borderColor: '#1D9E75',
          backgroundColor: 'rgba(29,158,117,.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
        },
      },
    });
  }

  // ── Top species bar chart ──────────────────────────────────────────
  function renderBarChart(report) {
    const speciesTotals = {};
    report.forEach(r => { speciesTotals[r.common_name] = (speciesTotals[r.common_name]||0) + r.daily_count; });

    const sorted = Object.entries(speciesTotals).sort((a,b) => b[1]-a[1]).slice(0, 20);
    const labels = sorted.map(([name]) => name);
    const values = sorted.map(([, count]) => count);

    const ctx = document.getElementById('bar-chart');
    if (!ctx) return;

    if (barChart) barChart.destroy();
    barChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length] + 'cc'),
          borderColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: ctx => ` ${ctx.parsed.x.toLocaleString()} detections` },
          },
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
          y: { ticks: { font: { size: 11 } } },
        },
        onClick: (evt, elements) => {
          if (elements.length) window.open(wikiUrl(labels[elements[0].index]), '_blank', 'noopener');
        },
      },
    });
  }

  // ── Heatmap ────────────────────────────────────────────────────────
  function renderHeatmap(hourlyData) {
    const container = document.getElementById('heatmap-container');
    if (!container) return;

    const matrix = {};
    hourlyData.forEach(row => {
      const h = parseInt(row.hour, 10);
      if (!matrix[row.common_name]) matrix[row.common_name] = Array(24).fill(0);
      matrix[row.common_name][h] += row.count;
    });

    const speciesList = Object.entries(matrix)
      .map(([name, hrs]) => ({ name, total: hrs.reduce((s,v) => s+v,0), hrs }))
      .sort((a,b) => b.total - a.total)
      .slice(0, 25);

    if (!speciesList.length) {
      container.innerHTML = '<div class="bc-loading" style="min-height:60px">No data</div>';
      return;
    }

    const table = document.createElement('table');
    table.id = 'heatmap-table';
    table.className = 'table table-borderless mb-0';

    const thead = table.createTHead();
    const hRow = thead.insertRow();
    hRow.insertCell().textContent = '';
    for (let h = 0; h < 24; h++) {
      const th = document.createElement('th');
      th.textContent = String(h).padStart(2,'0');
      hRow.appendChild(th);
    }

    const tbody = table.createTBody();
    speciesList.forEach(({ name, hrs }) => {
      const max = Math.max(...hrs, 1);
      const tr = tbody.insertRow();

      const tdName = tr.insertCell();
      tdName.className = 'species-label';
      tdName.title = name;
      tdName.appendChild(speciesEl(name, 16));

      hrs.forEach((count, h) => {
        const td = tr.insertCell();
        td.className = 'heat-cell';
        td.style.backgroundColor = count > 0 ? heatColor(count / max) : '#f5f5f5';
        td.title = `${name} — ${String(h).padStart(2,'0')}:00 — ${count} detection${count !== 1 ? 's' : ''}`;
        if (count > 0) td.textContent = count;
      });
    });

    container.innerHTML = '';
    container.appendChild(table);
  }

  // ── Recent detections table ────────────────────────────────────────
  function renderRecentDetections(recent) {
    const tbody = document.querySelector('#recent-detections-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    recent.slice(0, 50).forEach(det => {
      const [id, ts, , streamName, , commonName, confidence, filename] = det;
      const conf = parseFloat(confidence);
      const confClass = conf >= 0.8 ? 'conf-high' : conf >= 0.6 ? 'conf-mid' : 'conf-low';

      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        window.location.href = `${SCRIPT_NAME}/detections/detection/${id}`;
      });

      const tdTime = document.createElement('td');
      tdTime.textContent = fmtDate(ts) + ' ' + fmtTime(ts);
      tr.appendChild(tdTime);

      const tdStream = document.createElement('td');
      tdStream.className = 'd-none d-md-table-cell';
      tdStream.textContent = streamName || '';
      tr.appendChild(tdStream);

      const tdSpecies = document.createElement('td');
      tdSpecies.appendChild(speciesEl(commonName, 20));
      tr.appendChild(tdSpecies);

      const tdConf = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `conf-badge ${confClass}`;
      badge.textContent = (conf * 100).toFixed(0) + '%';
      tdConf.appendChild(badge);
      tr.appendChild(tdConf);

      const tdAudio = document.createElement('td');
      tdAudio.className = 'd-none d-md-table-cell';
      if (filename) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-secondary py-0 px-1';
        btn.title = 'Play audio';
        btn.innerHTML = '▶';
        let audioEl = null;
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.src = `${API_BASE}/api/audio-files/${filename}`;
            audioEl.controls = true;
            audioEl.style.height = '24px';
            audioEl.style.verticalAlign = 'middle';
            tdAudio.replaceChildren(audioEl);
            audioEl.play();
          } else {
            audioEl.paused ? audioEl.play() : audioEl.pause();
          }
        });
        tdAudio.appendChild(btn);
      }
      tr.appendChild(tdAudio);

      const tdSpec = document.createElement('td');
      if (filename) {
        const img = document.createElement('img');
        img.className = 'spec-thumb';
        img.src = `${API_BASE}/api/spectrogram/thumb/${filename}.png`;
        img.alt = commonName;
        img.addEventListener('click', e => {
          e.stopPropagation();
          window.open(`${API_BASE}/api/spectrogram/thumb/${filename}.png`, '_blank');
        });
        tdSpec.appendChild(img);
      }
      tr.appendChild(tdSpec);

      tbody.appendChild(tr);
    });
  }

  // ── 7-day sparklines ───────────────────────────────────────────────
  function renderSparklines(report, currentLookback) {
    const container = document.getElementById('sparklines-container');
    if (!container) return;
    loading(container);

    async function getSparkData() {
      if (currentLookback >= 7) return report;
      return fetchJSON(`${API_BASE}/api/detections/date_range_report/${dateNDaysAgo(7)}/${today()}`);
    }

    getSparkData().then(sparkReport => {
      const sd = {};
      sparkReport.forEach(r => {
        if (!sd[r.common_name]) sd[r.common_name] = {};
        sd[r.common_name][r.date] = (sd[r.common_name][r.date]||0) + r.daily_count;
      });

      const specTotals = {};
      Object.entries(sd).forEach(([name, days]) => {
        specTotals[name] = Object.values(days).reduce((s,v) => s+v, 0);
      });

      const top5 = Object.entries(specTotals).sort((a,b) => b[1]-a[1]).slice(0, 5);

      const dates = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }

      container.innerHTML = '';
      top5.forEach(([name, total], idx) => {
        const dailyCounts = dates.map(d => (sd[name]||{})[d] || 0);
        const maxVal = Math.max(...dailyCounts, 1);

        const row = document.createElement('div');
        row.className = 'sparkline-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'spark-label';
        labelEl.appendChild(speciesEl(name, 18));

        const svg = buildSparkSVG(dailyCounts, maxVal, PALETTE[idx % PALETTE.length]);

        const countEl = document.createElement('span');
        countEl.className = 'spark-count';
        countEl.textContent = total.toLocaleString();

        row.appendChild(labelEl);
        row.appendChild(svg);
        row.appendChild(countEl);
        container.appendChild(row);
      });

      if (!top5.length) {
        container.innerHTML = '<div class="text-muted" style="font-size:.85rem">No data</div>';
      }
    });
  }

  function buildSparkSVG(values, maxVal, color) {
    const W = 120, H = 28, PAD = 2;
    const n = values.length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const points = values.map((v, i) => {
      const x = PAD + i * ((W - PAD*2) / (n - 1));
      const y = H - PAD - (v / maxVal) * (H - PAD*2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const firstX = PAD;
    const lastX = PAD + (n-1) * ((W - PAD*2) / (n-1));
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', `${firstX},${H} ${points} ${lastX},${H}`);
    area.setAttribute('fill', color + '33');
    svg.appendChild(area);

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points);
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', color);
    polyline.setAttribute('stroke-width', '1.5');
    polyline.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(polyline);

    return svg;
  }

  // ── Rarest appearances ─────────────────────────────────────────────
  // Shows species with the fewest detections in the window, but only
  // those where the best detection had confidence > 0.8 (genuinely seen).
  function renderRarest(report, highConfData) {
    const container = document.getElementById('rarest-container');
    if (!container) return;

    // Build max-confidence map from highest_confidence tuples
    // Tuple: [id, timestamp, stream_id, streamname, scientific_name, common_name, confidence, filename]
    const maxConf = {};
    highConfData.forEach(det => {
      const name = det[5];   // common_name
      const conf = parseFloat(det[6]);
      if (!maxConf[name] || conf > maxConf[name]) maxConf[name] = conf;
    });

    // Total counts from report
    const speciesTotals = {};
    report.forEach(r => {
      speciesTotals[r.common_name] = (speciesTotals[r.common_name]||0) + r.daily_count;
    });

    // Filter to confident species, sort by count ascending
    const rare = Object.entries(speciesTotals)
      .filter(([name]) => (maxConf[name] || 0) >= 0.8)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 10);

    container.innerHTML = '';

    if (!rare.length) {
      container.innerHTML = '<div class="text-muted" style="font-size:.85rem">No confident detections in this window</div>';
      return;
    }

    rare.forEach(([name, count], idx) => {
      const conf = maxConf[name];
      const row = document.createElement('div');
      row.className = 'sparkline-row';
      row.style.cssText = 'align-items:center;';

      // Species name with thumbnail
      const labelEl = document.createElement('span');
      labelEl.className = 'spark-label';
      labelEl.style.flex = '0 0 180px';
      labelEl.appendChild(speciesEl(name, 24));

      // Detection count pill
      const countEl = document.createElement('span');
      countEl.style.cssText = 'font-size:.78rem;color:#666;flex:1;';
      countEl.textContent = `${count} detection${count !== 1 ? 's' : ''}`;

      // Confidence badge
      const confEl = document.createElement('span');
      confEl.className = `conf-badge ${conf >= 0.9 ? 'conf-high' : 'conf-mid'}`;
      confEl.title = 'Best confidence score';
      confEl.textContent = (conf * 100).toFixed(0) + '%';

      row.appendChild(labelEl);
      row.appendChild(countEl);
      row.appendChild(confEl);
      container.appendChild(row);
    });
  }

  // ── Auto-refresh ───────────────────────────────────────────────────
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadDashboard, 30_000);
  }

  // ── Boot ───────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initLookback();
    loadDashboard();
    startAutoRefresh();
  });

})();
