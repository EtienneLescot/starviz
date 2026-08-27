'use strict';
/* StarViz — interface : courbes cumulées, cadence, classement, stargazers. */

const TOKEN = window.STARVIZ_TOKEN || '';
const DAY = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
let reloading = false;
async function api(path, opts) {
  const resp = await fetch(path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN), opts);
  // Le serveur régénère son jeton à chaque démarrage : une page laissée
  // ouverte pendant un redémarrage doit se recharger plutôt que d'échouer
  // silencieusement sur toutes ses requêtes.
  if (resp.status === 403 && !reloading) {
    reloading = true;
    showError('Session expirée (StarViz a redémarré) — rechargement…');
    setTimeout(() => location.reload(), 900);
  }
  return resp;
}

const PALETTES = {
  dark: ['#f5b301', '#38bdf8', '#34d399', '#f472b6', '#a78bfa', '#fb923c',
         '#22d3ee', '#a3e635', '#f87171', '#818cf8', '#2dd4bf', '#e879f9'],
  light: ['#d99400', '#0284c7', '#059669', '#db2777', '#7c3aed', '#ea580c',
          '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#0d9488', '#c026d3'],
};

const nf = new Intl.NumberFormat('fr-FR');
const fmtDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
const fmtLong = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

const state = {
  data: null,
  series: [],
  hidden: new Set(),
  range: 'all',     // 30 | 90 | 365 | all
  mode: 'cumul',    // cumul | rate
  bucket: 'auto',   // auto | day | week | month (pas des bâtons)
  align: 'date',    // date | age
  scale: 'linear',  // linear | log
  showTotal: true,
  sort: 'stars',
  sortDir: -1,
  fetching: false,
};

let chartCtx = null;
let firstDrawDone = false;  // le tout premier tracé est le seul à être animé
let resizeTimer = null;
let lastChartBox = '';

/** Redessine le graphe si son conteneur a changé de taille.
 *  Appelée par le ResizeObserver, par « resize », et par le sondage : les
 *  deux premiers ne sont pas livrés à un onglet en arrière-plan, alors que
 *  les minuteurs continuent de tourner. */
function syncChartSize(immediate) {
  const host = $('#chart');
  if (!host || host.clientWidth < 2) return;
  const box = host.clientWidth + 'x' + host.clientHeight;
  if (box === lastChartBox) return;
  lastChartBox = box;
  clearTimeout(resizeTimer);
  if (immediate) renderChart(!firstDrawDone);
  else resizeTimer = setTimeout(() => renderChart(!firstDrawDone), 60);
}

/* ------------------------------------------------------------------ outils */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function startOfWeek(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lundi
  return d.getTime();
}

function relTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `il y a ${days} j`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `il y a ${months} mois`;
  return `il y a ${Math.round(months / 12)} ans`;
}

/** Nombre d'évènements dont l'horodatage est <= t (recherche dichotomique). */
function countUpTo(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const countBetween = (times, a, b) => countUpTo(times, b) - countUpTo(times, a);

function niceTicks(max, target) {
  if (!(max > 0)) return [0, 1];
  const raw = max / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  if (step < 1) step = 1;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(Math.round(v));
  if (ticks.length < 2) ticks.push(step);
  return ticks;
}

function logTicks(hi) {
  const all = [];
  for (let p = 0; Math.pow(10, p) <= hi * 1.0001; p++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, p);
      if (v <= hi * 1.0001) all.push(v);
    }
  }
  if (!all.length || all[all.length - 1] < hi) all.push(hi);
  return all.length > 9 ? all.filter((v) => /^10*$/.test(String(v)) || v === hi) : all;
}

function timeTicks(t0, t1, target) {
  const spanDays = (t1 - t0) / DAY;
  const out = [];
  if (spanDays <= 3) {
    const step = 6 * 3600000;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      out.push({ t, label: new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) });
    }
    return out;
  }
  if (spanDays <= 45) {
    const step = Math.max(1, Math.ceil(spanDays / target));
    for (let d = startOfDay(t0); d <= t1; d = startOfDay(d + step * DAY + 3600000)) {
      if (d >= t0) out.push({ t: d, label: fmtDay.format(new Date(d)) });
    }
    return out;
  }
  if (spanDays <= 420) {
    const step = Math.max(1, Math.round(spanDays / 30.44 / target));
    const first = new Date(t0);
    let d = new Date(first.getFullYear(), first.getMonth(), 1);
    while (d.getTime() <= t1) {
      if (d.getTime() >= t0) out.push({ t: d.getTime(), label: fmtMonth.format(d) });
      d = new Date(d.getFullYear(), d.getMonth() + step, 1);
    }
    return out;
  }
  const step = Math.max(1, Math.round(spanDays / 365.25 / target));
  for (let y = new Date(t0).getFullYear(); ; y += step) {
    const d = new Date(y, 0, 1).getTime();
    if (d > t1) break;
    if (d >= t0) out.push({ t: d, label: String(y) });
  }
  return out;
}

/* -------------------------------------------------------------- données */

const palette = () =>
  PALETTES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];

/** Restaure la sélection mémorisée, en ignorant les dépôts disparus. */
function restoreSelection() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('starviz.hidden') || '[]'); } catch { saved = []; }
  const known = new Set(state.series.map((s) => s.key));
  state.hidden = new Set(saved.filter((k) => known.has(k)));
  if (state.hidden.size === known.size) state.hidden.clear();  // jamais tout masqué au démarrage
}

function buildSeries() {
  const repos = (state.data?.repos || []).filter((r) => r.events && r.events.length);
  repos.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
  const pal = palette();
  state.series = repos.map((r, i) => ({
    key: r.full_name,
    name: r.name,
    repo: r,
    color: pal[i % pal.length],
    times: r.events.map((e) => Date.parse(e[0])).sort((a, b) => a - b),
  }));
}

/** LA sélection : les dépôts cochés dans la légende / le tableau.
 *  Tous les panneaux (indicateurs, graphe, géographie, stargazers) en
 *  découlent — il n'existe pas d'autre filtre. */
const visibleSeries = () => state.series.filter((s) => !state.hidden.has(s.key));

/** Résumé de la sélection, affiché en tête de chaque panneau. */
function scopeLabel(long) {
  const count = visibleSeries().length;
  const total = state.series.length;
  if (!count) return 'aucun dépôt';
  if (count === total) return long ? `les ${total} dépôts` : 'tous les dépôts';
  if (count === 1) {
    const only = visibleSeries()[0];
    return long ? `1 dépôt : ${only.name}` : only.name;
  }
  return long ? `${count} dépôts sur ${total}` : `${count} dépôts`;
}

/** Applique une sélection d'un bloc (raccourcis « Tous » / un compte). */
function selectSeries(keys) {
  const keep = new Set(keys);
  state.hidden = new Set(state.series.filter((s) => !keep.has(s.key)).map((s) => s.key));
  saveSelection();
  renderAll(false);
}

const saveSelection = () =>
  localStorage.setItem('starviz.hidden', JSON.stringify([...state.hidden]));

/* ---------------------------------------------------------------- rendu */

function renderAll(animate) {
  renderPresets();
  renderHeader();
  renderKpis();
  renderChart(animate);
  renderLegend();
  renderTable();
  renderRecent();
  renderGeo();
}

function renderHeader() {
  const d = state.data;
  $('#login').textContent = d?.login ? '@' + d.login : '';
  if (d?.generated_at) {
    const t = Date.parse(d.generated_at);
    $('#updated').textContent = 'Mis à jour ' + relTime(t);
    $('#updated').title = fmtStamp.format(new Date(t));
  }
  const orgs = (d?.orgs || []).length;
  $('#foot').textContent = d
    ? `${state.series.length} dépôt(s) étoilé(s) sur ${d.repos.length} · compte @${d.login}` +
      (orgs ? ` + ${orgs} organisation(s)` : '') + ' · via gh · StarViz'
    : '';
}

function renderKpis() {
  const now = Date.now();
  const scope = visibleSeries();
  const all = scope.flatMap((s) => s.times);
  const totalStars = scope.reduce((a, s) => a + s.repo.stars, 0);
  const inLast = (days) => all.reduce((a, t) => a + (t >= now - days * DAY ? 1 : 0), 0);

  const byDay = new Map();
  all.forEach((t) => { const k = startOfDay(t); byDay.set(k, (byDay.get(k) || 0) + 1); });
  let bestDay = null;
  byDay.forEach((v, k) => { if (!bestDay || v > bestDay.v) bestDay = { k, v }; });

  const last = all.length ? Math.max(...all) : null;
  const d7 = inLast(7), d30 = inLast(30);

  const tiles = [
    { label: 'Étoiles', value: nf.format(totalStars), sub: scopeLabel(true) },
    { label: '7 derniers jours', value: (d7 ? '+' : '') + nf.format(d7), pos: d7 > 0,
      sub: `${(d7 / 7).toFixed(1)} par jour` },
    { label: '30 derniers jours', value: (d30 ? '+' : '') + nf.format(d30), pos: d30 > 0,
      sub: `${(d30 / 30).toFixed(1)} par jour` },
    { label: 'Meilleure journée', value: bestDay ? '+' + nf.format(bestDay.v) : '—',
      sub: bestDay ? fmtLong.format(new Date(bestDay.k)) : '' },
    { label: 'Dernière étoile', value: last ? relTime(last).replace('il y a ', '') : '—',
      sub: last ? fmtStamp.format(new Date(last)) : '' },
  ];
  $('#kpis').innerHTML = tiles.map((t) => `
    <div class="kpi">
      <div class="label">${esc(t.label)}</div>
      <div class="value${t.pos ? ' pos' : ''}">${esc(t.value)}</div>
      <div class="sub">${esc(t.sub)}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------- le graphe */

function chartDomain(vis) {
  const now = Date.now();
  if (state.align === 'age') {
    let maxAge = 1;
    vis.forEach((s) => { maxAge = Math.max(maxAge, (now - s.times[0]) / DAY); });
    if (state.range !== 'all') maxAge = Math.min(maxAge, +state.range);
    return [0, maxAge];
  }
  let min = Infinity;
  vis.forEach((s) => { min = Math.min(min, s.times[0]); });
  if (!isFinite(min)) min = now - 30 * DAY;
  const start = state.range === 'all' ? min : Math.max(min, now - (+state.range) * DAY);
  return [start === now ? now - DAY : start, now];
}

/** Valeur cumulée d'une série au point x du domaine courant. */
const valueAt = (s, x) =>
  state.align === 'age' ? countUpTo(s.times, s.times[0] + x * DAY) : countUpTo(s.times, x);

function buildBuckets(x0, x1) {
  const buckets = [];
  const spanDays = state.align === 'age' ? x1 - x0 : (x1 - x0) / DAY;
  const unit = state.bucket !== 'auto' ? state.bucket
    : spanDays <= 60 ? 'day' : spanDays <= 400 ? 'week' : 'month';

  if (state.align === 'age') {
    const size = unit === 'day' ? 1 : unit === 'week' ? 7 : 30;
    for (let a = 0; a < x1; a += size) buckets.push({ a, b: Math.min(a + size, x1) });
    return { buckets, unit };
  }
  if (unit === 'day') {
    for (let t = startOfDay(x0); t < x1; t = startOfDay(t + DAY + 3600000)) {
      buckets.push({ a: t, b: startOfDay(t + DAY + 3600000) });
    }
    return { buckets, unit };
  }
  if (unit === 'week') {
    for (let t = startOfWeek(x0); t < x1; t = startOfWeek(t + 7 * DAY + 3600000)) {
      buckets.push({ a: t, b: startOfWeek(t + 7 * DAY + 3600000) });
    }
    return { buckets, unit };
  }
  let d = new Date(x0); d = new Date(d.getFullYear(), d.getMonth(), 1);
  while (d.getTime() < x1) {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    buckets.push({ a: d.getTime(), b: next.getTime() });
    d = next;
  }
  return { buckets, unit };
}

const bucketCount = (s, bk) =>
  state.align === 'age'
    ? countBetween(s.times, s.times[0] + bk.a * DAY, s.times[0] + bk.b * DAY)
    : countBetween(s.times, bk.a, bk.b);

function renderChart(animate) {
  const host = $('#chart');
  const w = host.clientWidth, h = host.clientHeight;
  // Premier passage : la grille CSS n'a pas encore sa largeur définitive.
  // On laisse le ResizeObserver rappeler renderChart plutôt que de tracer
  // une première courbe étriquée qui serait aussitôt redessinée.
  if (w < 80) return;
  const vis = visibleSeries();
  chartCtx = null;
  hideTooltip();

  if (!state.data || !state.series.length) {
    host.innerHTML = `<svg><text class="empty" x="50%" y="50%" text-anchor="middle">${
      state.fetching ? 'Récupération des données…' : 'Aucune étoile à afficher pour le moment.'
    }</text></svg>`;
    return;
  }
  if (!vis.length) {
    host.innerHTML = `<svg><text class="empty" x="50%" y="50%" text-anchor="middle">Aucun dépôt sélectionné.</text></svg>`;
    return;
  }

  const M = { top: 16, right: 18, bottom: 30, left: 56 };
  const pw = Math.max(60, w - M.left - M.right);
  const ph = Math.max(60, h - M.top - M.bottom);
  const [x0, x1] = chartDomain(vis);
  const xToPx = (x) => M.left + ((x - x0) / (x1 - x0)) * pw;
  const pxToX = (px) => x0 + ((px - M.left) / pw) * (x1 - x0);
  const targetX = Math.max(2, Math.min(8, Math.round(pw / 110)));

  const parts = [`<svg width="${w}" height="${h}">`];
  parts.push(`<defs><linearGradient id="fadeTotal" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/>
    <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`);

  let yMax, yToPx, yTicks;
  const ctx = { M, pw, ph, x0, x1, xToPx, pxToX, mode: state.mode, series: [] };

  if (state.mode === 'cumul') {
    const cols = Math.max(2, Math.min(1400, Math.round(pw)));
    const step = (x1 - x0) / (cols - 1);
    const samples = vis.map((s) => {
      const arr = new Float64Array(cols);
      for (let i = 0; i < cols; i++) arr[i] = valueAt(s, x0 + i * step);
      return arr;
    });
    const totals = new Float64Array(cols);
    samples.forEach((arr) => { for (let i = 0; i < cols; i++) totals[i] += arr[i]; });
    const rawMax = Math.max(1, totals[cols - 1], ...samples.map((a) => a[cols - 1]));

    if (state.scale === 'log') {
      yMax = Math.max(rawMax, 10);
      yTicks = logTicks(yMax);
      const decades = Math.log10(yMax);
      yToPx = (v) => M.top + ph * (1 - Math.log10(Math.max(v, 1)) / decades);
    } else {
      yTicks = niceTicks(rawMax, 5);
      yMax = yTicks[yTicks.length - 1] || 1;
      yToPx = (v) => M.top + ph * (1 - v / yMax);
    }

    parts.push(gridAndAxes(M, pw, ph, x0, x1, xToPx, yToPx, yTicks, targetX));

    const pathOf = (arr) => {
      let d = '';
      for (let i = 0; i < cols; i++) {
        const px = (M.left + (i / (cols - 1)) * pw).toFixed(1);
        const py = yToPx(arr[i]).toFixed(1);
        d += (i ? 'L' : 'M') + px + ' ' + py;
      }
      return d;
    };

    if (vis.length > 1 && state.showTotal) {
      const d = pathOf(totals);
      parts.push(`<path d="${d} L${(M.left + pw).toFixed(1)} ${(M.top + ph).toFixed(1)} L${M.left} ${(M.top + ph).toFixed(1)} Z"
        fill="url(#fadeTotal)"/>`);
      // Jamais animée : superposée aux séries, elle doit rester lisible tout
      // de suite, et ses pointillés survivent au tracé progressif.
      parts.push(`<path class="serie total" d="${d}" stroke="var(--text)" stroke-opacity=".5"
        stroke-dasharray="6 5"/>`);
      ctx.series.push({ key: '__total__', name: 'Total', color: 'var(--text)', samples: totals });
    }
    vis.forEach((s, i) => {
      parts.push(`<path class="serie${animate ? ' animate' : ''}" pathLength="1" d="${pathOf(samples[i])}"
        stroke="${s.color}" style="animation-delay:${(i * 45)}ms"/>`);
      ctx.series.push({ key: s.key, name: s.name, color: s.color, samples: samples[i] });
    });
    ctx.cols = cols; ctx.step = step; ctx.yToPx = yToPx;
  } else {
    const { buckets, unit } = buildBuckets(x0, x1);
    const counts = vis.map((s) => buckets.map((bk) => bucketCount(s, bk)));
    const totals = buckets.map((_, i) => counts.reduce((a, c) => a + c[i], 0));
    yTicks = niceTicks(Math.max(1, ...totals), 5);
    yMax = yTicks[yTicks.length - 1] || 1;
    yToPx = (v) => M.top + ph * (1 - v / yMax);

    parts.push(gridAndAxes(M, pw, ph, x0, x1, xToPx, yToPx, yTicks, targetX));

    const bw = pw / buckets.length;
    const gap = bw > 4 ? Math.min(3, bw * 0.25) : bw * 0.12;
    buckets.forEach((bk, i) => {
      let acc = 0;
      const bx = xToPx(bk.a) + gap / 2;
      const width = Math.max(1, bw - gap);
      vis.forEach((s, si) => {
        const v = counts[si][i];
        if (!v) return;
        const y1 = yToPx(acc), y2 = yToPx(acc + v);
        acc += v;
        parts.push(`<rect class="bar" data-i="${i}" x="${bx.toFixed(1)}" y="${y2.toFixed(1)}"
          width="${width.toFixed(1)}" height="${Math.max(1, y1 - y2).toFixed(1)}" rx="2" fill="${s.color}"/>`);
      });
    });
    ctx.buckets = buckets; ctx.counts = counts; ctx.totals = totals; ctx.unit = unit;
    ctx.series = vis.map((s) => ({ key: s.key, name: s.name, color: s.color }));
    ctx.yToPx = yToPx;
  }

  parts.push(`<g class="hover"></g>`);
  parts.push(`<rect class="hit" x="${M.left}" y="${M.top}" width="${pw}" height="${ph}"/>`);
  parts.push('</svg>');
  host.innerHTML = parts.join('');
  chartCtx = ctx;

  firstDrawDone = true;
  const svg = host.querySelector('svg');
  svg.addEventListener('mousemove', onHover);
  svg.addEventListener('mouseleave', () => { hideTooltip(); clearHover(); });
}

function gridAndAxes(M, pw, ph, x0, x1, xToPx, yToPx, yTicks, targetX) {
  const out = ['<g class="grid">'];
  yTicks.forEach((v) => {
    const y = yToPx(v).toFixed(1);
    out.push(`<line x1="${M.left}" y1="${y}" x2="${M.left + pw}" y2="${y}"/>`);
  });
  out.push('</g><g class="axis">');
  yTicks.forEach((v) => {
    out.push(`<text x="${M.left - 10}" y="${(yToPx(v) + 4).toFixed(1)}" text-anchor="end">${nf.format(v)}</text>`);
  });
  const xt = state.align === 'age'
    ? niceTicks(x1, targetX).map((d) => ({ t: d, label: d < 90 ? `${d} j` : `${Math.round(d / 30.44)} mois` }))
    : timeTicks(x0, x1, targetX);
  xt.forEach((tick) => {
    const px = xToPx(tick.t);
    if (px < M.left - 2 || px > M.left + pw + 2) return;
    // Aux extrémités, on ancre l'étiquette vers l'intérieur : centrée, elle
    // dépasserait du cadre et serait rognée par la carte.
    const anchor = px > M.left + pw - 26 ? 'end' : px < M.left + 26 ? 'start' : 'middle';
    out.push(`<text x="${px.toFixed(1)}" y="${(M.top + ph + 18).toFixed(1)}" text-anchor="${anchor}">${esc(tick.label)}</text>`);
  });
  out.push('</g>');
  return out.join('');
}

/* -------------------------------------------------------------- survol */

function onHover(evt) {
  if (!chartCtx) return;
  const svg = evt.currentTarget;
  const rect = svg.getBoundingClientRect();
  const px = evt.clientX - rect.left;
  const { M, pw, ph } = chartCtx;
  if (px < M.left || px > M.left + pw) { hideTooltip(); clearHover(); return; }
  const layer = svg.querySelector('.hover');

  if (chartCtx.mode === 'cumul') {
    const i = Math.max(0, Math.min(chartCtx.cols - 1, Math.round(((px - M.left) / pw) * (chartCtx.cols - 1))));
    const x = chartCtx.x0 + i * chartCtx.step;
    const gx = chartCtx.xToPx(x);
    const rows = chartCtx.series
      .map((s) => ({ ...s, v: s.samples[i] }))
      .filter((s) => s.v > 0 || s.key === '__total__')
      .sort((a, b) => (a.key === '__total__' ? 1 : b.key === '__total__' ? -1 : b.v - a.v));
    layer.innerHTML =
      `<line class="crosshair" x1="${gx}" y1="${M.top}" x2="${gx}" y2="${M.top + ph}"/>` +
      rows.filter((s) => s.key !== '__total__')
        .map((s) => `<circle class="dot" cx="${gx}" cy="${chartCtx.yToPx(s.v).toFixed(1)}" r="3.5" fill="${s.color}"/>`)
        .join('');
    const head = state.align === 'age'
      ? `${Math.round(x)} jour(s) après la première étoile`
      : fmtLong.format(new Date(x));
    showTooltip(evt, head, rows);
  } else {
    const { buckets } = chartCtx;
    const bw = pw / buckets.length;
    const i = Math.max(0, Math.min(buckets.length - 1, Math.floor((px - M.left) / bw)));
    const bk = buckets[i];
    const gx = chartCtx.xToPx(bk.a);
    layer.innerHTML = `<rect x="${gx.toFixed(1)}" y="${M.top}" width="${bw.toFixed(1)}" height="${ph}"
      fill="currentColor" opacity=".07"/>`;
    const rows = chartCtx.series
      .map((s, si) => ({ ...s, v: chartCtx.counts[si][i] }))
      .filter((s) => s.v > 0)
      .sort((a, b) => b.v - a.v);
    // Sur une période vide, l'infobulle se contente de le dire.
    if (rows.length > 1) {
      rows.push({ key: '__total__', name: 'Total', color: 'var(--text)', v: chartCtx.totals[i] });
    }
    const head = state.align === 'age'
      ? `Jours ${Math.round(bk.a)} – ${Math.round(bk.b)}`
      : chartCtx.unit === 'month'
        ? fmtMonth.format(new Date(bk.a))
        : chartCtx.unit === 'week'
          ? `${fmtDay.format(new Date(bk.a))} → ${fmtDay.format(new Date(bk.b - DAY))}`
          : fmtLong.format(new Date(bk.a));
    showTooltip(evt, head, rows);
  }
}

function showTooltip(evt, head, rows) {
  const tip = $('#tooltip');
  const body = rows.slice(0, 13).map((r) => `
    <div class="row${r.key === '__total__' ? ' sum' : ''}">
      <i class="swatch" style="background:${r.color}"></i>
      <span class="name">${esc(r.name)}</span>
      <span class="val">${nf.format(Math.round(r.v))}</span>
    </div>`).join('');
  tip.innerHTML = `<div class="t-date">${esc(head)}</div>${
    body || '<div class="row" style="color:var(--muted)">Aucune étoile</div>'}`;
  tip.classList.remove('hidden');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = evt.clientX + 16 + w > window.innerWidth ? evt.clientX - w - 26 : evt.clientX;
  const top = Math.max(h / 2 + 8, Math.min(window.innerHeight - h / 2 - 8, evt.clientY));
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

const hideTooltip = () => $('#tooltip').classList.add('hidden');
function clearHover() {
  const layer = document.querySelector('#chart .hover');
  if (layer) layer.innerHTML = '';
}

/* ------------------------------------------------------------- légende */

function renderPresets() {
  const owners = [...new Set(state.series.map((s) => s.repo.owner))];
  const selected = new Set(visibleSeries().map((s) => s.key));
  const matches = (keys) => keys.length === selected.size && keys.every((k) => selected.has(k));

  const shortcuts = [
    { value: 'all', label: 'Tous', keys: state.series.map((s) => s.key) },
    ...(owners.length > 1 ? owners.map((o) => ({
      value: o, label: o,
      keys: state.series.filter((s) => s.repo.owner === o).map((s) => s.key),
    })) : []),
    { value: 'none', label: 'Aucun', keys: [] },
  ];
  $('#select-actions').innerHTML = shortcuts.map((sc) =>
    `<button class="mini" data-select="${esc(sc.value)}" aria-pressed="${matches(sc.keys)}">${
      esc(sc.label)}</button>`).join('');
}

function renderLegend() {
  const vis = visibleSeries();
  const keys = vis.map((s) => `<span class="key"><i class="swatch" style="background:${s.color}"></i>${
    esc(s.name)}</span>`);
  if (state.mode === 'cumul' && state.showTotal && vis.length > 1) {
    keys.unshift('<span class="key"><i class="swatch dashed"></i>Total</span>');
  }
  $('#legend').innerHTML = keys.join('') || '<span class="key">Aucun dépôt sélectionné.</span>';
}

function toggleSeries(key, isolate) {
  if (isolate) {
    const alone = visibleSeries().length === 1 && !state.hidden.has(key);
    state.hidden = alone ? new Set()
      : new Set(state.series.filter((s) => s.key !== key).map((s) => s.key));
  } else if (state.hidden.has(key)) {
    state.hidden.delete(key);
  } else {
    state.hidden.add(key);
  }
  saveSelection();
  renderAll(false);
}

/** Tout afficher / tout masquer, dans le périmètre du compte sélectionné. */
function setAllVisible(visible) {
  selectSeries(visible ? state.series.map((s) => s.key) : []);
}

/* ------------------------------------------------------- tableau dépôts */

function sparkline(times, w = 62, h = 20) {
  const now = Date.now(), from = now - 90 * DAY;
  const n = 24;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(countUpTo(times, from + ((now - from) * i) / (n - 1)));
  const lo = pts[0], hi = pts[n - 1];
  const span = Math.max(1, hi - lo);
  const d = pts.map((v, i) =>
    `${i ? 'L' : 'M'}${((i / (n - 1)) * (w - 2) + 1).toFixed(1)} ${(h - 2 - ((v - lo) / span) * (h - 5)).toFixed(1)}`).join('');
  return { d, flat: hi === lo };
}

function renderTable() {
  const now = Date.now();
  $('#repos-sub').textContent = state.hidden.size ? scopeLabel(false) + ' sélectionné(s)' : '';
  const rows = state.series.map((s) => ({
    s,
    stars: s.repo.stars,
    d7: countBetween(s.times, now - 7 * DAY, now),
    d30: countBetween(s.times, now - 30 * DAY, now),
  }));
  const dir = state.sortDir;
  rows.sort((a, b) => state.sort === 'name'
    ? -dir * a.s.name.localeCompare(b.s.name)
    : dir * (a[state.sort] - b[state.sort]) || b.stars - a.stars);

  $('#repos tbody').innerHTML = rows.map(({ s, stars, d7, d30 }) => {
    const sp = sparkline(s.times);
    const on = !state.hidden.has(s.key);
    return `<tr data-key="${esc(s.key)}" class="${on ? '' : 'off'}"
      title="${esc(s.repo.full_name)} — clic : n'afficher que ce dépôt">
      <td><div class="repo-name"><button class="repo-check${on ? ' on' : ''}" style="--c:${s.color}"
          aria-pressed="${on}" title="Ajouter ou retirer ce dépôt de la sélection"></button>
        <span>${esc(s.name)}</span>
        ${s.repo.is_org ? `<i class="tag">${esc(s.repo.owner)}</i>` : ''}
        ${s.repo.private ? '<i class="tag">privé</i>' : ''}${s.repo.fork ? '<i class="tag">fork</i>' : ''}</div></td>
      <td>${nf.format(stars)}</td>
      <td class="delta${d7 ? ' pos' : ''}">${d7 ? '+' + d7 : '·'}</td>
      <td class="delta${d30 ? ' pos' : ''}">${d30 ? '+' + d30 : '·'}</td>
      <td><svg class="spark" viewBox="0 0 62 20"><path d="${sp.d}" fill="none"
        stroke="${sp.flat ? 'var(--muted)' : s.color}" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" opacity="${sp.flat ? '.45' : '1'}"/></svg></td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#repos th[data-sort]').forEach((th) => {
    th.classList.toggle('active', th.dataset.sort === state.sort);
  });
}

/* --------------------------------------------------- stargazers récents */

function renderRecent() {
  $('#recent-sub').textContent = scopeLabel(false);
  const locations = state.data?.locations || {};
  const events = [];
  visibleSeries().forEach((s) => {
    s.repo.events.forEach((e) => events.push({ t: Date.parse(e[0]), login: e[1], repo: s.repo }));
  });
  events.sort((a, b) => b.t - a.t);
  $('#recent').innerHTML = events.slice(0, 40).map((e) => `
    <li>
      <img src="https://github.com/${encodeURIComponent(e.login)}.png?size=60" alt="" loading="lazy" referrerpolicy="no-referrer">
      <div class="col">
        <div class="who"><a href="https://github.com/${encodeURIComponent(e.login)}" target="_blank" rel="noreferrer">${esc(e.login)}</a></div>
        <div class="meta"><a href="${esc(e.repo.url)}" target="_blank" rel="noreferrer">${
          esc(e.repo.is_org ? e.repo.full_name : e.repo.name)}</a>${
          locations[e.login] ? ' · ' + esc(locations[e.login]) : ''}</div>
      </div>
      <time title="${fmtStamp.format(new Date(e.t))}">${relTime(e.t)}</time>
    </li>`).join('') || '<li class="empty-state">Aucun dépôt sélectionné.</li>';
}

/* ---------------------------------------------------------- géographie */

const CONTINENT_COLORS = { EU: '#38bdf8', AS: '#f5b301', NA: '#34d399', SA: '#f472b6',
                           AF: '#fb923c', OC: '#a78bfa', AN: '#94a3b8', XX: '#64748b' };

function renderGeo() {
  const card = $('#geo-card');
  const locations = state.data?.locations || {};
  const users = new Set();
  visibleSeries().forEach((s) => s.repo.events.forEach((e) => users.add(e[1])));

  const byCountry = new Map(), byContinent = new Map();
  let located = 0;
  users.forEach((login) => {
    const code = GEO.resolve(locations[login]);
    const info = code && GEO.info(code);
    if (!info) return;
    located++;
    byCountry.set(code, (byCountry.get(code) || 0) + 1);
    byContinent.set(info.continent, (byContinent.get(info.continent) || 0) + 1);
  });

  card.classList.toggle('hidden', users.size === 0);
  $('#geo-body').classList.toggle('hidden', !located);
  $('#geo-empty').classList.toggle('hidden', !!located);
  if (!located) {
    $('#geo-sub').textContent =
      `aucune localisation sur ${nf.format(users.size)} profil${users.size > 1 ? 's' : ''}`;
    $('#geo-countries').innerHTML = $('#geo-continents').innerHTML = $('#geo-stack').innerHTML = '';
    return;
  }
  const pct = (n) => (100 * n / located).toFixed(n / located >= 0.1 ? 0 : 1) + ' %';
  $('#geo-sub').textContent = `${scopeLabel(false)} · ${nf.format(located)} localisés sur ${
    nf.format(users.size)} (${Math.round(100 * located / users.size)} %)`;

  const continents = [...byContinent].sort((a, b) => b[1] - a[1]);
  $('#geo-stack').innerHTML = continents.map(([code, n]) =>
    `<i style="width:${(100 * n / located).toFixed(2)}%;background:${CONTINENT_COLORS[code] || CONTINENT_COLORS.XX}"
        title="${esc(GEO.continents[code])} : ${nf.format(n)}"></i>`).join('');
  $('#geo-continents').innerHTML = continents.map(([code, n]) => `
    <li><i class="swatch" style="background:${CONTINENT_COLORS[code] || CONTINENT_COLORS.XX}"></i>
      <span class="cont">${esc(GEO.continents[code] || 'Autre')}</span>
      <span class="n">${nf.format(n)}</span><span class="pct">${pct(n)}</span></li>`).join('');

  const top = [...byCountry].sort((a, b) => b[1] - a[1]).slice(0, 16);
  const max = top[0][1];
  $('#geo-countries').innerHTML = top.map(([code, n]) => {
    const info = GEO.info(code);
    return `<li title="${esc(info.name)} — ${nf.format(n)} stargazers (${pct(n)})">
      <span class="flag">${info.flag}</span>
      <span class="cname">${esc(info.name)}</span>
      <span class="track"><i style="width:${(100 * n / max).toFixed(1)}%;background:${
        CONTINENT_COLORS[info.continent] || CONTINENT_COLORS.XX}"></i></span>
      <span class="n">${nf.format(n)}</span></li>`;
  }).join('');
}

/* -------------------------------------------------------------- réseau */

async function loadData() {
  try {
    const resp = await api('/api/data');
    if (!resp.ok) return false;
    state.data = await resp.json();
    buildSeries();
    restoreSelection();
    renderAll(true);
    return true;
  } catch (err) {
    showError('Impossible de contacter StarViz : ' + err.message);
    return false;
  }
}

async function refresh(force) {
  hideError();
  await api('/api/refresh' + (force ? '?force=1' : ''), { method: 'POST' });
  state.fetching = true;
  updateProgressUI({ state: 'running', message: 'Démarrage…', done: 0, total: 0 });
}

let lastState = null;
async function poll() {
  syncChartSize(true);
  let status;
  try {
    const resp = await api('/api/status');
    if (!resp.ok) return;
    status = await resp.json();
  } catch { return; }
  state.fetching = status.state === 'running';
  updateProgressUI(status);
  if (status.error) showError(status.error); else if (lastState === 'running') hideError();
  if (lastState === 'running' && status.state !== 'running') await loadData();
  if (lastState === null && !status.has_data && status.state !== 'running') {
    $('#chart').innerHTML = '<svg><text class="empty" x="50%" y="50%" text-anchor="middle">Aucune donnée — cliquez sur « Actualiser ».</text></svg>';
  }
  lastState = status.state;
}

function updateProgressUI(status) {
  const bar = $('#progress');
  const btn = $('#refresh');
  if (status.state === 'running') {
    bar.classList.remove('hidden');
    btn.disabled = true;
    const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
    $('#track').classList.toggle('indeterminate', !status.total);
    $('#track-bar').style.width = status.total ? pct + '%' : '';
    $('#progress-msg').textContent = status.total
      ? `${status.message}  (${status.done}/${status.total})`
      : status.message;
  } else {
    bar.classList.add('hidden');
    btn.disabled = false;
    renderHeader();
  }
}

function showError(msg) {
  const el = $('#error');
  el.innerHTML = `<b>Erreur GitHub</b>${esc(msg)}`;
  el.classList.remove('hidden');
}
const hideError = () => $('#error').classList.add('hidden');

/* ------------------------------------------------------------ contrôles */

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('starviz.theme', theme);
  if (state.data) { buildSeries(); renderAll(false); }
}

/** Le pas ne concerne que la cadence, l'échelle logarithmique que le cumul. */
function syncModeUI() {
  $('#seg-bucket').classList.toggle('hidden', state.mode !== 'rate');
  $('#seg-scale').classList.toggle('hidden', state.mode !== 'cumul');
  $('#seg-total').classList.toggle('hidden', state.mode !== 'cumul');
  $('#seg-total button').setAttribute('aria-pressed', String(state.showTotal));
}

function syncSeg(seg, key) {
  seg.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === String(state[key]))));
}

function bindSeg(id, key, onChange) {
  const seg = $(id);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state[key] = btn.dataset.value;
    localStorage.setItem('starviz.' + key, btn.dataset.value);
    syncSeg(seg, key);
    onChange();
  });
  syncSeg(seg, key);
}

function restore() {
  const saved = localStorage.getItem('starviz.theme');
  document.documentElement.dataset.theme =
    saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  ['range', 'mode', 'bucket', 'align', 'scale'].forEach((k) => {
    const v = localStorage.getItem('starviz.' + k);
    if (v) state[k] = v;
  });
  state.showTotal = localStorage.getItem('starviz.showTotal') !== 'false';
}

function bindUI() {
  $('#select-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const value = btn.dataset.select;
    selectSeries(value === 'none' ? [] : state.series
      .filter((s) => value === 'all' || s.repo.owner === value)
      .map((s) => s.key));
  });
  bindSeg('#seg-range', 'range', () => { renderChart(false); renderLegend(); });
  bindSeg('#seg-mode', 'mode', () => { syncModeUI(); renderChart(false); renderLegend(); });
  bindSeg('#seg-bucket', 'bucket', () => renderChart(false));
  $('#seg-total').addEventListener('click', () => {
    state.showTotal = !state.showTotal;
    localStorage.setItem('starviz.showTotal', String(state.showTotal));
    syncModeUI();
    renderChart(false);
    renderLegend();
  });
  bindSeg('#seg-align', 'align', () => { renderChart(false); renderLegend(); });
  bindSeg('#seg-scale', 'scale', () => { renderChart(false); renderLegend(); });

  $('#refresh').addEventListener('click', (e) => refresh(e.shiftKey));
  $('#theme').addEventListener('click', () =>
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('#quit').addEventListener('click', async () => {
    await api('/api/quit', { method: 'POST' }).catch(() => {});
    document.body.innerHTML = '<p class="empty-state">StarViz est arrêté. Vous pouvez fermer cet onglet.</p>';
    stopPolling();
  });

  // Deux gestes, un seul sélecteur : la pastille ajoute ou retire un dépôt,
  // le reste de la ligne n'affiche que celui-ci (et rétablit tout au second clic).
  $('#repos tbody').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr');
    if (tr) toggleSeries(tr.dataset.key, !e.target.closest('.repo-check'));
  });
  document.querySelectorAll('#repos th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sortDir = state.sort === key ? -state.sortDir : -1;
      state.sort = key;
      renderTable();
    });
  });

  new ResizeObserver(() => syncChartSize()).observe($('#chart'));
  addEventListener('resize', () => syncChartSize());
  addEventListener('keydown', (e) => {
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) refresh(e.shiftKey);
    if (e.key === 'Escape' && state.hidden.size) setAllVisible(true);
  });
}

let pollTimer = null;
const stopPolling = () => clearInterval(pollTimer);

(async function main() {
  restore();
  bindUI();
  syncModeUI();
  await loadData();
  await poll();
  pollTimer = setInterval(poll, 2500); // sert aussi de battement de cœur au serveur
})();
