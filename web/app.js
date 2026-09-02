'use strict';
/* StarViz — interface : courbes cumulées, cadence, classement, stargazers. */

const TOKEN = document.querySelector('meta[name="starviz-token"]')?.content || '';
const DAY = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
let reloading = false;

// Deux hôtes possibles pour la même interface : l'application Tauri, où le
// backend Rust répond par IPC, et le serveur HTTP de `starviz.py`, qui sert
// encore `--fetch-only` et `--trending`. Les deux chemins coexistent pour que
// porter l'un ne casse pas l'autre.
const TAURI = window.__TAURI__ || null;
const COMMANDES = {
  '/api/hello': 'hello',
  '/api/status': 'status',
  '/api/data': 'data',
  '/api/refresh': 'refresh',
  '/api/quit': 'quit',
};

// Une réponse minimale façon `fetch`, pour que les appelants n'aient pas à
// savoir lequel des deux backends leur a répondu.
const reponse = (ok, status, value) => ({ ok, status, json: async () => value });

async function apiTauri(path) {
  const [route, qs] = path.split('?');
  const cmd = COMMANDES[route];
  if (!cmd) return reponse(false, 404, { error: 'route inconnue' });
  const args = cmd === 'refresh'
    ? { force: new URLSearchParams(qs || '').get('force') === '1' }
    : {};
  try {
    const value = await TAURI.core.invoke(cmd, args);
    // `data` ne renvoie rien tant qu'aucun historique n'existe : c'est
    // l'équivalent du 404 que servait le serveur Python.
    if (cmd === 'data' && (value === null || value === undefined)) {
      return reponse(false, 404, { error: 'aucune donnée en cache' });
    }
    return reponse(true, 200, value ?? { ok: true });
  } catch (err) {
    return reponse(false, 500, { error: String(err) });
  }
}

async function api(path, opts) {
  if (TAURI) return apiTauri(path);
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

// Dans une application, un lien externe doit partir vers le navigateur du
// système. Laissé à lui-même, il remplacerait l'interface par github.com dans
// une fenêtre sans barre d'adresse ni bouton retour — sans retour possible.
//
// On appelle la commande du greffon directement plutôt que son API JS :
// sans bundler, `window.__TAURI__.opener` n'existe pas, et le gestionnaire
// se contenterait alors de neutraliser le lien sans rien ouvrir.
if (TAURI) {
  document.addEventListener('click', (e) => {
    const lien = e.target.closest?.('a[href^="https://"]');
    if (!lien) return;
    e.preventDefault();
    TAURI.core.invoke('plugin:opener|open_url', { url: lien.href })
      .catch((err) => showError('Impossible d\'ouvrir ' + lien.href + ' : ' + err));
  });
}

// Les quinze teintes de series du design system. Elles sont declinees par
// theme dans style.css : le JS n'a pas a connaitre leurs valeurs, seulement
// leur nombre — au-dela de quinze, l'oeil ne distingue plus.
const SERIES = Array.from({ length: 15 }, (_, i) => `var(--s${i + 1})`);

const nf = new Intl.NumberFormat('fr-FR');
const fmtDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
const fmtLong = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Secondes restantes -> « dans 7 h » / « dans 12 min ». Une échéance ne se lit
 *  pas en secondes ; c'est l'ordre de grandeur qui renseigne. */
function dureeRestante(s) {
  if (s <= 0) return 'à renouveler';
  if (s < 3600) return `dans ${Math.round(s / 60)} min`;
  if (s < 172800) return `dans ${Math.round(s / 3600)} h`;
  return `dans ${Math.round(s / 86400)} j`;
}

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
  view: 'overview',   // overview | geo | trending | settings
  railOpen: true,
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

const palette = () => SERIES;

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
  renderHeader();
  renderScope();
  renderKpis();
  renderChart(animate);
  renderLegend();
  renderRecent();
  renderGeo();
  renderPaletteBulk();
  if (paletteOuverte()) renderPaletteRows();
}

function renderHeader() {
  const d = state.data;
  $('#login').textContent = d?.login ? '@' + d.login : '';
  if (d?.generated_at) {
    const t = Date.parse(d.generated_at);
    $('#updated').textContent = 'Mis à jour ' + relTime(t);
    $('#updated').title = fmtStamp.format(new Date(t));
  }
}

/** Pastille de portée : le seul sélecteur de dépôts, au centre de la barre
 *  parce qu'il pilote les quatre écrans. */
function renderScope() {
  const vis = visibleSeries();
  $('#scope-title').textContent = scopeLabel(false);
  $('#scope-stars').textContent = vis.length
    ? nf.format(vis.reduce((n, s) => n + s.repo.stars, 0)) + ' ★' : '';
  // Cinq pastilles au plus : au-delà, elles ne se distinguent plus.
  $('#scope-dots').innerHTML = vis.slice(0, 5)
    .map((s) => `<i style="background:${s.color}"></i>`).join('');

  const d = state.data;
  const orgs = (d?.orgs || []).length;
  $('#scope-sentence').textContent = d
    ? `${scopeLabel(true)} · ${state.series.length} dépôt(s) étoilé(s) sur ${d.repos.length}` +
      ` · @${d.login}${orgs ? ` + ${orgs} organisation(s)` : ''}`
    : '';
  $('#geo-sentence').textContent = $('#scope-sentence').textContent;
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
    <stop offset="0" stop-color="var(--acc)" stop-opacity=".18"/>
    <stop offset="1" stop-color="var(--acc)" stop-opacity="0"/></linearGradient></defs>`);

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
      // Les reperes restent ceux d'avant — pas de palier ajoute, pas de
      // hauteur perdue. Mais le domaine, lui, couvre la donnee : sinon la
      // valeur la plus haute sort du cadre et rien ne peut la surmonter.
      yTicks = niceTicks(rawMax, 5);
      yMax = Math.max(yTicks[yTicks.length - 1] || 1, rawMax);
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
      parts.push(`<path class="serie total" d="${d}" stroke="var(--faint)" stroke-opacity=".5"
        stroke-dasharray="6 5"/>`);
      ctx.series.push({ key: '__total__', name: 'Total', color: 'var(--faint)', samples: totals });
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
    // Meme regle qu'en cumul : reperes inchanges, domaine qui contient la
    // plus haute barre, pour qu'aucune ne deborde du cadre.
    const pic = Math.max(1, ...totals);
    yTicks = niceTicks(pic, 5);
    yMax = Math.max(yTicks[yTicks.length - 1] || 1, pic);
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
    // De 0 au bas du plot : le repere marque une position, pas une valeur.
    // Le caler sur `M.top` l'aurait plafonne au repere le plus haut de
    // l'echelle, alors qu'une barre peut le depasser.
    layer.innerHTML =
      `<line class="crosshair" x1="${gx}" y1="0" x2="${gx}" y2="${M.top + ph}"/>` +
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
    // La bande seule : elle designe la periode survolee, sur toute la hauteur
    // du graphe. Une ligne en plus, au milieu de la bande, ferait doublon.
    layer.innerHTML =
      `<rect x="${gx.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${M.top + ph}" opacity=".13"/>`;
    const rows = chartCtx.series
      .map((s, si) => ({ ...s, v: chartCtx.counts[si][i] }))
      .filter((s) => s.v > 0)
      .sort((a, b) => b.v - a.v);
    // Sur une période vide, l'infobulle se contente de le dire.
    if (rows.length > 1) {
      rows.push({ key: '__total__', name: 'Total', color: 'var(--faint)', v: chartCtx.totals[i] });
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
    <div class="row">
      <i style="background:${r.color}"></i>
      <span class="n">${esc(r.name)}</span>
      <span class="v">${nf.format(Math.round(r.v))}</span>
    </div>`).join('');
  tip.innerHTML = `<div class="when">${esc(head)}</div>${
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

function renderPaletteBulk() {
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
  $('#palette-bulk').innerHTML = shortcuts.map((sc) =>
    `<button data-select="${esc(sc.value)}" aria-pressed="${matches(sc.keys)}">${
      esc(sc.label)}</button>`).join('');
}

function renderLegend() {
  const vis = visibleSeries();
  const keys = vis.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`);
  if (state.mode === 'cumul' && state.showTotal && vis.length > 1) {
    keys.unshift('<span><i class="dash"></i>Total</span>');
  }
  $('#legend').innerHTML = keys.join('') || '<span>Aucun dépôt sélectionné.</span>';
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

function renderRecent() {
  $('#recent-sub').textContent = scopeLabel(false);
  const locations = state.data?.locations || {};
  const events = [];
  visibleSeries().forEach((s) => {
    s.repo.events.forEach((e) => events.push({ t: Date.parse(e[0]), login: e[1], repo: s.repo }));
  });
  events.sort((a, b) => b.t - a.t);
  $('#recent').innerHTML = events.slice(0, 40).map((e) => `
    <div class="who">
      <img src="https://github.com/${encodeURIComponent(e.login)}.png?size=60" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="grow trunc">
        <span class="n"><a href="https://github.com/${encodeURIComponent(e.login)}" target="_blank" rel="noreferrer">${esc(e.login)}</a></span>
        <span class="m" style="display:block"><a href="${esc(e.repo.url)}" target="_blank" rel="noreferrer">${
          esc(e.repo.is_org ? e.repo.full_name : e.repo.name)}</a>${
          locations[e.login] ? ' · ' + esc(locations[e.login]) : ''}</span>
      </span>
      <span class="when" title="${fmtStamp.format(new Date(e.t))}">${relTime(e.t)}</span>
    </div>`).join('') || '<div class="empty"><p>Aucun dépôt sélectionné.</p></div>';
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

  const maxCont = continents[0][1];
  const barresContinents = continents.map(([code, n]) => `
    <div class="b"><span class="code"></span>
      <span class="n">${esc(GEO.continents[code] || 'Autre')}</span>
      <span class="t"><i style="width:${(100 * n / maxCont).toFixed(1)}%;background:${
        CONTINENT_COLORS[code] || CONTINENT_COLORS.XX}"></i></span>
      <span class="v">${nf.format(n)}</span></div>`).join('');
  $('#geo-continents').innerHTML = barresContinents;
  $('#geo-continents-full').innerHTML = barresContinents;

  const top = [...byCountry].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const max = top[0][1];
  $('#geo-countries').innerHTML = top.map(([code, n]) => {
    const info = GEO.info(code);
    return `<div class="b" title="${esc(info.name)} — ${nf.format(n)} stargazers (${pct(n)})">
      <span class="code">${info.flag}</span>
      <span class="n">${esc(info.name)}</span>
      <span class="t"><i style="width:${(100 * n / max).toFixed(1)}%;background:${
        CONTINENT_COLORS[info.continent] || CONTINENT_COLORS.XX}"></i></span>
      <span class="v">${nf.format(n)}</span></div>`;
  }).join('');

  // La carte n'est dessinee que lorsque son ecran est visible : d3 mesure le
  // conteneur, et un conteneur masque n'a pas de dimensions.
  derniereGeo = { parPays: byCountry, total: located };
  if (state.view === 'geo') StarvizMap.render(byCountry, located);
}

/** Dernier resultat geographique, pour dessiner la carte a l'arrivee sur son
 *  ecran sans avoir a tout recalculer. */
let derniereGeo = null;

/* ------------------------------------------------------------ connexion */

// Le voile s'impose quand aucun jeton n'est disponible, mais il s'ouvre aussi
// à la demande : on peut vouloir remplacer le jeton emprunté à gh par un
// jeton propre, et c'est le seul chemin pour le faire.
let connexionDemandee = false;
// Dernier état reçu : ouvrir ou fermer le voile redessine à partir de lui,
// plutôt que de manipuler les classes à la main. Sans ça, le panneau
// s'affichait avec le texte de l'autre cas jusqu'au sondage suivant.
let dernierAuth = null;

function renderAuth(auth) {
  // Le serveur Python ignore l'authentification : son statut n'a pas de champ
  // « auth », et il n'y a alors pas de voile à afficher.
  if (!auth) return;
  dernierAuth = auth;
  if (auth.source === 'oauth') connexionDemandee = false;

  const ouvert = !auth.connecte || connexionDemandee;
  $('#auth').classList.toggle('hidden', !ouvert);
  $('#connect').classList.toggle('hidden',
    !(auth.connecte && auth.source === 'gh' && auth.device_flow_possible));
  $('#logout').classList.toggle('hidden', auth.source !== 'oauth');
  $('#auth-fermer').classList.toggle('hidden', !auth.connecte);
  if (!ouvert) return;

  $('#auth-intro').textContent = auth.source === 'gh'
    ? "StarViz emprunte pour l'instant le jeton de « gh ». Se connecter lui en "
      + 'donne un propre, rangé dans le trousseau du système.'
    : "StarViz a besoin d'accéder à vos dépôts pour en lire les étoiles.";

  if (!auth.device_flow_possible) {
    $('#auth-intro').textContent =
      "Cette compilation n'embarque pas d'application OAuth : StarViz emprunte "
      + "le jeton de « gh ». Lancez « gh auth login », puis actualisez.";
    $('#auth-start').classList.add('hidden');
    return;
  }

  const enAttente = auth.en_attente && !!auth.user_code;
  $('#auth-code').classList.toggle('hidden', !enAttente);
  $('#auth-start').classList.toggle('hidden', enAttente);
  $('#auth-open').classList.toggle('hidden', !enAttente);
  if (enAttente) {
    $('#auth-user-code').textContent = auth.user_code;
    $('#auth-open').href = auth.verification_uri || 'https://github.com/login/device';
  }
  const err = $('#auth-erreur');
  err.textContent = auth.erreur || '';
  err.classList.toggle('hidden', !auth.erreur);
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
    // Une collecte partielle laissait des dépôts s'évanouir sans un mot.
    const soucis = state.data.errors || [];
    if (soucis.length) {
      showError(`Collecte partielle — ${soucis.length} élément(s) conservés depuis le relevé précédent : ${
        esc(soucis.slice(0, 3).join(' · '))}`);
    }
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
  renderAuth(status.auth);
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

const SOLEIL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.6" y1="5.6" x2="7.3" y2="7.3"/><line x1="16.7" y1="16.7" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="16.7" y2="7.3"/><line x1="7.3" y1="16.7" x2="5.6" y2="18.4"/></svg>';
const LUNE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('starviz.theme', theme);
  const sombre = theme === 'dark';
  $('#theme-icon').innerHTML = sombre ? SOLEIL : LUNE;
  $('#theme-label').textContent = sombre ? 'Clair' : 'Sombre';
  $('#theme').title = sombre ? 'Passer au thème clair' : 'Passer au thème sombre';
  syncSeg($('#seg-theme'), 'theme');
  if (state.data) { buildSeries(); renderAll(false); }
  // Les couleurs de la carte viennent des jetons CSS : elle doit être redessinée.
  if (window.StarvizMap) StarvizMap.retheme();
}

/** Le pas ne concerne que la cadence, l'échelle logarithmique que le cumul. */
function syncModeUI() {
  $('#seg-bucket').classList.toggle('hidden', state.mode !== 'rate');
  $('#seg-scale').classList.toggle('hidden', state.mode !== 'cumul');
  // « Courbe total » est un bouton bascule, pas un segment : il porte son
  // propre etat plutot que d'en contenir un.
  const total = $('#seg-total');
  total.classList.toggle('hidden', state.mode !== 'cumul');
  total.classList.toggle('accent', state.showTotal);
  total.setAttribute('aria-pressed', String(state.showTotal));
}

function syncSeg(seg, key) {
  if (!seg) return;
  const courant = key === 'theme'
    ? (localStorage.getItem('starviz.theme') || 'auto')
    : String(state[key]);
  seg.querySelectorAll('button').forEach((b) => {
    const actif = b.dataset.value === courant;
    b.setAttribute('aria-pressed', String(actif));
    b.classList.toggle('on', actif);
  });
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
  // Le thème clair est le défaut du design ; « auto » suit le système.
  document.documentElement.dataset.theme = saved && saved !== 'auto'
    ? saved
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  ['range', 'mode', 'bucket', 'align', 'scale', 'view'].forEach((k) => {
    const v = localStorage.getItem('starviz.' + k);
    if (v) state[k] = v;
  });
  state.showTotal = localStorage.getItem('starviz.showTotal') !== 'false';
  state.railOpen = localStorage.getItem('starviz.rail') !== 'closed';
  if (TAURI) document.body.classList.add('tauri');
}

function bindUI() {
  $('#palette-bulk').addEventListener('click', (e) => {
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

  $('#auth-start').addEventListener('click', async (e) => {
    if (!TAURI) return;
    // Les erreurs sont consignées côté Rust et remontent par le sondage :
    // les écrire ici aussi les ferait clignoter une seconde puis disparaître.
    e.target.disabled = true;
    try {
      await TAURI.core.invoke('auth_start');
    } catch { /* affichée par renderAuth */ }
    e.target.disabled = false;
  });
  $('#logout').addEventListener('click', () => {
    if (TAURI) TAURI.core.invoke('auth_logout').catch(() => {});
  });
  $('#connect').addEventListener('click', () => {
    connexionDemandee = true;
    renderAuth(dernierAuth);
  });
  $('#auth-fermer').addEventListener('click', () => {
    connexionDemandee = false;
    renderAuth(dernierAuth);
  });

  $('#refresh').addEventListener('click', (e) => refresh(e.shiftKey));
  $('#theme').addEventListener('click', () =>
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  bindCoquille();

  new ResizeObserver(() => syncChartSize()).observe($('#chart'));
  addEventListener('resize', () => syncChartSize());
}


/* ------------------------------------------------------------ coquille */

const ECRANS = ['overview', 'geo', 'trending', 'settings'];

/** Change d'écran. Chaque écran se peuple à l'arrivée plutôt qu'en continu :
 *  Trending et Réglages interrogent le backend, il n'y a pas de raison de le
 *  faire pendant qu'on regarde le graphe. */
function showView(v) {
  if (!ECRANS.includes(v)) v = 'overview';
  state.view = v;
  localStorage.setItem('starviz.view', v);
  ECRANS.forEach((e) => {
    $('#screen-' + e).classList.toggle('hidden', e !== v);
    $('#nav-' + e).classList.toggle('on', e === v);
  });
  if (v === 'overview') syncChartSize(true);
  if (v === 'geo' && derniereGeo) StarvizMap.render(derniereGeo.parPays, derniereGeo.total);
  if (v === 'trending') renderTrending();
  if (v === 'settings') renderSettings();
}

function setRail(ouvert) {
  state.railOpen = ouvert;
  localStorage.setItem('starviz.rail', ouvert ? 'open' : 'closed');
  $('#rail').classList.toggle('collapsed', !ouvert);
  // Le graphe occupe la place laissée par le rail : il doit être remesuré.
  setTimeout(() => syncChartSize(true), 160);
}

/* -------------------------------------------------------------- palette */

let paletteCurseur = 0;
const paletteOuverte = () => !$('#palette-veil').classList.contains('hidden');

function lignesPalette() {
  const q = $('#palette-query').value.trim().toLowerCase();
  return state.series.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || s.repo.full_name.toLowerCase().includes(q));
}

function renderPaletteRows() {
  const lignes = lignesPalette();
  if (paletteCurseur >= lignes.length) paletteCurseur = Math.max(0, lignes.length - 1);
  $('#palette-rows').innerHTML = lignes.length ? lignes.map((s, i) => `
    <div class="prow${state.hidden.has(s.key) ? '' : ' sel'}${i === paletteCurseur ? ' cursor' : ''}" data-key="${esc(s.key)}">
      <span class="check"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="var(--on-acc)" stroke-width="2.2" stroke-linecap="round"><path d="M2.5 6.3 4.8 8.6 9.5 3.6"/></svg></span>
      <span class="n">${esc(s.name)}</span>
      <span class="owner trunc">${esc(s.repo.owner)}</span>
      <span class="stars">${nf.format(s.repo.stars)}</span>
      <span class="solo" data-solo="1">isoler</span>
    </div>`).join('')
    : `<div style="padding:38px 20px;text-align:center;color:var(--faint);font-size:13px">Aucun dépôt ne correspond à « ${esc($('#palette-query').value)} ».</div>`;

  const vis = visibleSeries().length;
  $('#palette-count').textContent = `${vis} / ${state.series.length} sélectionné${vis > 1 ? 's' : ''}`;
}

function openPalette() {
  $('#palette-veil').classList.remove('hidden');
  $('#palette-query').value = '';
  paletteCurseur = 0;
  renderPaletteBulk();
  renderPaletteRows();
  $('#palette-query').focus();
}

const closePalette = () => $('#palette-veil').classList.add('hidden');

/* ------------------------------------------------------------ trending */

function renderTrending() {
  const hote = $('#trending-body');
  if (!TAURI) {
    $('#trending-sentence').textContent = '';
    hote.innerHTML = `<div class="card"><div class="empty">
      <div class="title">Disponible dans l'application</div>
      <p>Le journal des classements est lu par le backend Rust. Cet écran reste vide dans le navigateur.</p>
    </div></div>`;
    return;
  }
  TAURI.core.invoke('trending').then((t) => {
    if (!t.disponible) {
      $('#trending-sentence').textContent = 'Aucun relevé sur cette machine';
      $('#nav-trending-badge').classList.add('hidden');
      hote.innerHTML = `<div class="card"><div class="empty">
        <div class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 16 9 10 13 14 21 6"/><polyline points="21 11 21 6 16 6"/></svg></div>
        <div class="title">Aucun relevé Trending</div>
        <p>Le relevé est assuré par <span class="mono">starviz.py --trending</span>, sous minuteur systemd : il demande un navigateur sans interface et doit tourner même quand l'application est fermée.</p>
        <p class="mono" style="font-size:12px">${esc(t.chemin)}</p>
      </div></div>`;
      return;
    }

    // Le badge annonce une place tenue : une case quittee n'en est plus une.
    const rangs = t.lignes.filter((l) => !l.sortie)
      .map((l) => l.rank).filter((r) => r !== null && r !== undefined);
    const meilleur = rangs.length ? Math.min(...rangs) : null;
    $('#nav-trending-badge').classList.toggle('hidden', meilleur === null);
    if (meilleur !== null) $('#nav-trending-badge').textContent = '#' + meilleur;
    // Dire combien de classements ont ete consultes evite la question « et le
    // journalier ? » : il a bien ete regarde, la place n'y etait simplement pas.
    $('#trending-sentence').innerHTML = `${t.nb_releves} relevé(s) · dernier ${
      esc(t.dernier_releve || '—')} · ${t.consultes} classement(s) consulté(s) au dernier relevé, ${
      t.occupes} occupé(s)`;

    const fenetres = { daily: 'journalier', weekly: 'hebdomadaire', monthly: 'mensuel' };
    const lignes = t.lignes.map((l) => {
      // Le meilleur rang d'abord : c'est le palmarès qu'on vient lire. Le rang
      // du jour le suit, et vaut « sorti » quand la place n'est plus tenue --
      // y laisser l'ancien rang le faisait passer pour la place du moment.
      return `<tr>
        <td><span style="display:flex;align-items:center;gap:9px">
          <span class="kind">${l.scope === 'developer' ? 'dév' : 'dépôt'}</span>
          <span>${esc(fenetres[l.window] || l.window)}</span></span></td>
        <td style="color:var(--muted)">${esc(l.lang || 'toutes langues')}</td>
        <td class="num"><span class="rank${l.meilleur <= 3 ? ' top' : ''}">#${l.meilleur}</span>${
          l.preuve ? ` <span class="preuve" data-voir="${esc(l.preuve)}">voir</span>` : ''}</td>
        <td class="num">${l.sortie
          ? '<span class="sorti">sorti</span>'
          : `<span class="rank">#${l.rank}</span>${
              l.total ? `<span style="color:var(--faint)"> / ${l.total}</span>` : ''}`}</td>
      </tr>`;
    }).join('');

    hote.innerHTML = `
      <section class="card">
        <div style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>Classement</th><th>Langage</th><th class="num">Meilleur</th><th class="num">Actuel</th></tr></thead>
          <tbody>${lignes || '<tr><td colspan="4" style="color:var(--faint)">Absent de tous les classements au dernier relevé.</td></tr>'}</tbody>
        </table></div>
      </section>

      <section class="card" style="margin-top:20px">
        <header><h2>Captures de rang</h2><span class="grow"></span>
          <span class="note mono">${esc(t.captures.length ? t.captures.length + ' fichier(s)' : 'aucune')}</span></header>
        ${t.captures.length ? `<div class="shots">${t.captures.map((c) => `
          <div class="shot">
            <img class="ph" data-capture="${esc(c.fichier)}" alt="${esc(titreCapture(c.fichier))}" loading="lazy">
            <div class="meta"><div class="t">${esc(titreCapture(c.fichier))}</div>
              <div class="f">${(c.taille / 1024).toFixed(0)} Kio · ${esc(c.fichier)}</div></div>
          </div>`).join('')}</div>`
        : `<div class="empty"><p>Aucune capture. Le relevé en produit une à chaque changement de rang, sauf avec <span class="mono">--no-shots</span>.</p></div>`}
      </section>

      <section class="card" style="margin-top:20px">
        <header><h2>Journal des évènements</h2></header>
        ${t.evenements.length ? `<div class="journal">${t.evenements.map((e) => `
          <div class="ev">
            <span class="d">${esc(e.ts.replace('T', ' ').replace('Z', ''))}</span>
            <i style="background:${e.genre === 'progression' ? 'var(--pos)' : e.genre === 'recul' ? 'var(--neg)' : 'var(--faint)'}"></i>
            <span class="t">${esc(e.texte)}</span>
          </div>`).join('')}</div>`
        : `<div class="empty"><p>Rien n'a bougé entre les relevés enregistrés.</p></div>`}
      </section>`;
    // Les images sont chargees apres coup, une par une : les inclure dans le
    // HTML aurait fait entrer plusieurs mega-octets de base64 d'un seul bloc.
    hote.querySelectorAll('img[data-capture]').forEach((img) => {
      TAURI.core.invoke('capture', { fichier: img.dataset.capture })
        .then((uri) => { img.src = uri; })
        .catch(() => { img.classList.add('absente'); });
      img.addEventListener('click', () => {
        if (img.src) ouvrirVisio(img.src, titreCapture(img.dataset.capture));
      });
    });
    // Depuis le tableau, la preuve se charge au clic : inutile de la garder en
    // memoire pour une image qu'on ne regardera peut-etre jamais.
    hote.querySelectorAll('[data-voir]').forEach((el) => {
      el.addEventListener('click', () => {
        TAURI.core.invoke('capture', { fichier: el.dataset.voir })
          .then((uri) => ouvrirVisio(uri, titreCapture(el.dataset.voir)))
          .catch((e) => showError(String(e)));
      });
    });
  }).catch((e) => { hote.innerHTML = `<div class="error"><b>Trending</b>${esc(String(e))}</div>`; });
}

/** Affiche une capture à sa taille native, à parcourir de haut en bas. */
function ouvrirVisio(src, legende) {
  $('#visio-img').src = src;
  $('#visio-cap').textContent = legende;
  $('#visio').classList.remove('hidden');
  // Une capture fait plusieurs milliers de pixels de haut : réduite à la
  // fenêtre, elle ne se lisait plus. On l'ouvre en haut, on la fait défiler.
  $('#visio .defile').scrollTop = 0;
}

const fermerVisio = () => {
  $('#visio').classList.add('hidden');
  // On libere le data URI : une capture pese quelques centaines de kilooctets.
  $('#visio-img').removeAttribute('src');
};

const visioOuverte = () => !$('#visio').classList.contains('hidden');

/** Nom de fichier d'une capture -> intitule lisible.
 *  Le releve les nomme `<horodatage>_<portee>_<fenetre>_<langage>_rang<N>.png`. */
function titreCapture(fichier) {
  const m = fichier.match(/^(\d{8})T\d{6}Z?_(\w+?)_(\w+?)_(.+?)_rang(\d+)/);
  if (!m) return fichier.replace(/\.png$/, '');
  const [, jour, portee, fenetre, langue, rang] = m;
  const fen = { daily: 'journalier', weekly: 'hebdomadaire', monthly: 'mensuel' }[fenetre] || fenetre;
  const date = fmtDay.format(new Date(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8)));
  return `${portee === 'developer' ? 'dév' : 'dépôt'} ${fen}${
    langue === 'all' ? '' : '/' + langue} · #${rang} · ${date}`;
}

/* ------------------------------------------------------------ réglages */

const RACCOURCIS = [
  ['Ctrl K', 'Sélection des dépôts'],
  ['1 – 4', "Changer d'écran"],
  ['Ctrl B', 'Replier le rail'],
  ['r', 'Actualiser'],
  ['Maj R', 'Actualiser sans le cache'],
  ['Échap', 'Tout réafficher'],
];

function renderSettings() {
  const hote = $('#settings-body');
  if (!TAURI) {
    hote.innerHTML = `<div class="card"><div class="empty">
      <div class="title">Disponible dans l'application</div>
      <p>Ces réglages pilotent le collecteur Rust ; ils n'ont pas d'effet dans le navigateur.</p>
    </div></div>`;
    return;
  }
  Promise.all([TAURI.core.invoke('reglages'), TAURI.core.invoke('infos')]).then(([r, i]) => {
    const mo = (o) => (o / 1048576).toFixed(1).replace('.', ',') + ' Mo';
    // Le sondage tourne depuis le démarrage : son dernier passage fait foi,
    // plutôt qu'un appel de plus pour une information déjà en main.
    const a = dernierAuth || { source: 'inconnue', connecte: false };
    const themeCourant = localStorage.getItem('starviz.theme') || 'auto';
    hote.innerHTML = `
      <section class="card">
        <header><h2>Données</h2></header>
        <div class="rows">
          <div class="row">
            <span class="grow trunc"><span class="t">Historique</span>
              <span class="s mono">${esc(i.chemin_donnees)} · ${mo(i.taille_donnees)}</span></span>
            <button class="btn small" id="set-open">Ouvrir le dossier</button>
          </div>
          <div class="row">
            <span class="grow"><span class="t">Collecte parallèle</span>
              <span class="s">Dépôts interrogés simultanément — au-delà, GitHub applique ses limites secondaires</span></span>
            <span class="seg" id="seg-conc">${[2, 4, 6, 8].map((n) =>
              `<button data-n="${n}" class="${n === r.concurrence ? 'on' : ''}">${n}</button>`).join('')}</span>
          </div>
          <div class="row">
            <span class="grow"><span class="t">Réessai sur HTTP 5xx</span>
              <span class="s">Trois tentatives avant d'abandonner un dépôt. Un seul 504 suffisait à le faire disparaître du graphe.</span></span>
            <button class="switch ${r.tentatives > 1 ? 'on' : ''}" id="set-retry"><i></i></button>
          </div>
        </div>
      </section>

      <section class="card">
        <header><h2>Trending</h2><span class="grow"></span>
          <span class="note">piloté par ${esc(i.trending_pilote_par)}</span></header>
        <div class="rows">
          <div class="row">
            <span class="grow trunc"><span class="t">Journal des relevés</span>
              <span class="s mono">${esc(i.chemin_donnees.replace(/data\.json$/, 'trending.jsonl'))}</span></span>
            <span class="state ${i.trending_present ? 'ok' : 'off'}"><i></i>${i.trending_present ? 'présent' : 'absent'}</span>
          </div>
          <div class="row">
            <span class="grow trunc"><span class="t">Captures de rang</span>
              <span class="s mono">${esc(i.chemin_captures)}</span></span>
            <span class="state ${i.nb_captures ? 'ok' : 'off'}"><i></i>${i.nb_captures || 'aucune'}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <header><h2>Compte GitHub</h2></header>
        <div class="rows">
          <div class="row">
            <span class="grow"><span class="t">Connexion</span>
              <span class="s">${a.source === 'oauth'
                ? 'Jeton propre à StarViz, rangé dans le trousseau du système'
                : (a.source === 'gh'
                  ? "Jeton emprunté au CLI « gh » — StarViz n'a pas encore le sien"
                  : 'Aucun compte connecté')}</span></span>
            <span class="state ${a.connecte ? 'ok' : 'off'}"><i></i>${
              a.source === 'oauth' ? 'OAuth' : (a.source === 'gh' ? 'gh' : 'hors ligne')}</span>
          </div>
          ${a.source === 'oauth' ? `<div class="row">
            <span class="grow"><span class="t">Renouvellement</span>
              <span class="s">${a.expire_dans === null || a.expire_dans === undefined
                ? "GitHub n'a pas fixé d'échéance à ce jeton : il vaut jusqu'à révocation"
                : 'Le jeton se renouvelle seul, sans nouvelle saisie de code'}</span></span>
            <span class="state ${a.expire_dans !== null && a.expire_dans !== undefined && a.expire_dans <= 0 ? 'off' : 'ok'}"><i></i>${
              a.expire_dans === null || a.expire_dans === undefined
                ? 'permanent' : 'expire ' + dureeRestante(a.expire_dans)}</span>
          </div>` : ''}
        </div>
      </section>

      <section class="card">
        <header><h2>Apparence</h2></header>
        <div class="row">
          <span class="grow"><span class="t">Thème</span>
            <span class="s">Les deux thèmes sont spécifiés dans le design system</span></span>
          <span class="seg" id="seg-theme">
            <button data-value="light" class="${themeCourant === 'light' ? 'on' : ''}">Clair</button>
            <button data-value="dark" class="${themeCourant === 'dark' ? 'on' : ''}">Sombre</button>
            <button data-value="auto" class="${themeCourant === 'auto' ? 'on' : ''}">Système</button>
          </span>
        </div>
      </section>

      <section class="card">
        <header><h2>Raccourcis</h2></header>
        <div class="keys">${RACCOURCIS.map(([k, l]) =>
          `<div><kbd>${esc(k)}</kbd><span style="color:var(--muted)">${esc(l)}</span></div>`).join('')}</div>
      </section>

      <p style="color:var(--faint);font-size:12px;margin:0">
        StarViz ${esc(i.version)} · ${esc(i.plateforme)} · réglages dans
        <span class="mono">${esc(i.chemin_config)}</span></p>`;

    const ecrire = (patch) => TAURI.core.invoke('set_reglages', { valeurs: { ...r, ...patch } })
      .then(() => renderSettings())
      .catch((e) => showError(String(e)));

    $('#set-open').addEventListener('click', () =>
      TAURI.core.invoke('ouvrir_dossier_donnees').catch((e) => showError(String(e))));
    $('#seg-conc').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) ecrire({ concurrence: +b.dataset.n });
    });
    $('#set-retry').addEventListener('click', () =>
      ecrire({ tentatives: r.tentatives > 1 ? 1 : 3 }));
    $('#seg-theme').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = b.dataset.value;
      if (v === 'auto') {
        setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        localStorage.setItem('starviz.theme', 'auto');
      } else {
        setTheme(v);
      }
      renderSettings();
    });
  }).catch((e) => { hote.innerHTML = `<div class="error"><b>Réglages</b>${esc(String(e))}</div>`; });
}

/* --------------------------------------------------- liaisons coquille */

function bindCoquille() {
  document.querySelectorAll('.navbtn').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));
  $('#collapse').addEventListener('click', () => setRail(!state.railOpen));

  // Boutons système : la fenêtre n'a pas de cadre, c'est la page qui les porte.
  if (TAURI) {
    const fenetre = TAURI.window.getCurrentWindow();
    $('#win-min').addEventListener('click', () => fenetre.minimize());
    $('#win-max').addEventListener('click', () => fenetre.toggleMaximize());
    // Fermer replie dans la zone de notification : le backend intercepte
    // l'évènement, et l'application continue de vivre dans le tray.
    $('#win-close').addEventListener('click', () => fenetre.close());

    // La fenetre n'a pas de cadre : c'est la barre de titre qui la deplace.
    // L'attribut `data-tauri-drag-region` ne couvre que l'element qui le porte,
    // pas ses enfants ; on saisit donc explicitement, en epargnant les
    // controles pour qu'un clic reste un clic.
    const inerte = (e) => !e.target.closest('button, a, input, .scope');
    const barre = document.querySelector('.topbar');
    barre.addEventListener('mousedown', (e) => {
      if (e.button === 0 && inerte(e)) fenetre.startDragging();
    });
    barre.addEventListener('dblclick', (e) => {
      if (inerte(e)) fenetre.toggleMaximize();
    });
  }

  $('#scope').addEventListener('click', openPalette);
  $('#empty-pick').addEventListener('click', openPalette);
  $('#empty-all').addEventListener('click', () => setAllVisible(true));
  $('#palette-veil').addEventListener('click', (e) => {
    if (e.target.id === 'palette-veil') closePalette();
  });
  $('#palette-query').addEventListener('input', () => { paletteCurseur = 0; renderPaletteRows(); });
  $('#palette-rows').addEventListener('click', (e) => {
    const ligne = e.target.closest('.prow');
    if (!ligne) return;
    // Deux gestes pour isoler : le bouton « isoler », et Alt+clic — le
    // pendant du Alt+Entree du clavier.
    toggleSeries(ligne.dataset.key, !!e.target.closest('[data-solo]') || e.altKey);
    renderPaletteRows();
  });

  // Le clic ferme, sauf sur l'image elle-même : on vient la lire.
  $('#visio').addEventListener('click', (e) => {
    if (e.target.id !== 'visio-img') fermerVisio();
  });

  addEventListener('keydown', (e) => {
    if (visioOuverte()) {
      if (e.key === 'Escape') { fermerVisio(); e.preventDefault(); }
      return;
    }
    if (paletteOuverte()) {
      const lignes = lignesPalette();
      if (e.key === 'Escape') { closePalette(); return; }
      if (e.key === 'ArrowDown') { paletteCurseur = Math.min(lignes.length - 1, paletteCurseur + 1); renderPaletteRows(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { paletteCurseur = Math.max(0, paletteCurseur - 1); renderPaletteRows(); e.preventDefault(); return; }
      if (e.key === 'Enter' && lignes[paletteCurseur]) {
        toggleSeries(lignes[paletteCurseur].key, e.altKey);
        renderPaletteRows(); e.preventDefault(); return;
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { openPalette(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { setRail(!state.railOpen); e.preventDefault(); return; }
    if (e.target.tagName === 'INPUT') return;
    if (e.key >= '1' && e.key <= '4' && !e.ctrlKey && !e.metaKey) showView(ECRANS[+e.key - 1]);
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) refresh(e.shiftKey);
    if (e.key === 'Escape' && state.hidden.size) setAllVisible(true);
  });
}

let pollTimer = null;
const stopPolling = () => clearInterval(pollTimer);

(async function main() {
  restore();
  bindUI();
  setTheme(document.documentElement.dataset.theme);
  setRail(state.railOpen);
  showView(state.view);
  syncModeUI();
  await loadData();
  await poll();
  pollTimer = setInterval(poll, 2500); // sert aussi de battement de cœur au serveur
})();
