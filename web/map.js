'use strict';
/* StarViz — carte choroplèthe des stargazers.
 *
 * d3, topojson-client et la topologie Natural Earth sont versionnés dans
 * `vendor/` plutôt que chargés depuis un CDN. C'est la règle du dépôt — les
 * tables de `geo-data.js` le sont déjà pour la même raison : une application de
 * bureau ne doit pas dépendre du réseau pour dessiner ce qu'elle a déjà, et la
 * CSP reste stricte.
 *
 * `geo.js` résout les localisations en codes alpha-2, la topologie identifie
 * ses pays par code numérique ISO : `vendor/iso-numeric.js` fait le pont. */

const StarvizMap = (() => {
  const TOPO_URL = '/vendor/countries-110m.json';

  let features = null;      // géométries, chargées une seule fois
  let chargement = null;    // promesse de chargement en cours
  let dernier = null;       // { parPays, total } pour redessiner au changement de thème
  let zoom = null, gRoot = null, projection = null, chemin = null;
  let epingle = null;

  const sphere = { type: 'Sphere' };
  const $ = (sel) => document.querySelector(sel);
  const nf = new Intl.NumberFormat('fr-FR');

  function jeton(nom, secours) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
    return v || secours;
  }

  function charger() {
    if (features) return Promise.resolve(features);
    if (chargement) return chargement;
    chargement = fetch(TOPO_URL)
      .then((r) => r.json())
      .then((topo) => {
        features = topojson.feature(topo, topo.objects.countries).features;
        return features;
      });
    return chargement;
  }

  /** Redessine la carte. `parPays` : Map(alpha2 -> nombre de stargazers). */
  function render(parPays, total) {
    dernier = { parPays, total };
    const hote = $('#map-wrap');
    if (!hote) return;

    charger().then(() => dessiner(parPays, total)).catch(() => {
      // Sans géométrie, mieux vaut le dire que d'afficher un cadre vide.
      $('#map-caption').textContent = 'Géométrie indisponible';
    });
  }

  function dessiner(parPays, total) {
    const svg = d3.select('#map');
    const hote = document.getElementById('map-wrap');
    svg.selectAll('*').remove();
    gRoot = svg.append('g');

    // alpha-2 -> nombre, converti en identifiants numériques de la topologie.
    const parId = new Map();
    let max = 0;
    parPays.forEach((n, code) => {
      const id = window.ISO_NUMERIC[code];
      if (id === undefined) return;
      parId.set(id, n);
      if (n > max) max = n;
    });

    const RAMP0 = jeton('--ramp0', '#EDEAF6');
    const RAMP1 = jeton('--ramp1', '#2A1C6B');
    const NODATA = jeton('--nodata', '#FBFAFE');
    // Racine carrée : sans elle, un pays dominant écrase toute l'échelle et la
    // carte devient monochrome.
    const echelle = d3.scaleSequential(d3.interpolateLab(RAMP0, RAMP1))
      .domain([0, Math.sqrt(Math.max(1, max))]);
    const couleur = (n) => (n ? echelle(Math.sqrt(n)) : NODATA);

    d3.select('#map-ramp').style('background',
      'linear-gradient(90deg,' + d3.range(0, 1.001, 0.1)
        .map((t) => couleur(max * t * t)).join(',') + ')');
    $('#map-max').textContent = nf.format(max);
    $('#map-caption').textContent =
      `${nf.format(parId.size)} pays · ${nf.format(total)} profils localisés`;

    projection = d3.geoNaturalEarth1();
    chemin = d3.geoPath(projection);

    zoom = d3.zoom().scaleExtent([1, 9])
      .on('start', () => svg.classed('dragging', true))
      .on('end', () => svg.classed('dragging', false))
      .on('zoom', (ev) => gRoot.attr('transform', ev.transform));
    svg.call(zoom);

    gRoot.append('path').datum(sphere).attr('class', 'sphere');

    const tip = d3.select('#map-tip');
    gRoot.selectAll('.country').data(features).enter().append('path')
      .attr('class', (d) => 'country' + (parId.has(+d.id) ? ' hit' : ''))
      .attr('fill', (d) => couleur(parId.get(+d.id) || 0))
      .on('mousemove', function (ev, d) {
        const n = parId.get(+d.id);
        d3.select(this).classed('hover', true);
        if (!n) { tip.style('opacity', 0); return; }
        const code = codeDe(+d.id);
        const info = code && GEO.info(code);
        const r = hote.getBoundingClientRect();
        const x = ev.clientX - r.left, y = ev.clientY - r.top;
        const bascule = x > r.width - 210;
        tip.select('.n').text(info ? info.name : code || '—');
        tip.select('.v').text(`${nf.format(n)} · ${(100 * n / total).toFixed(1).replace('.', ',')} %`);
        tip.style('opacity', 1)
          .style('left', (bascule ? x - 12 - 170 : x) + 'px')
          .style('top', y + 'px')
          .style('transform', bascule ? 'translate(0,-50%)' : 'translate(12px,-50%)');
      })
      .on('mouseleave', function () {
        d3.select(this).classed('hover', false);
        tip.style('opacity', 0);
      })
      .on('click', (ev, d) => { epingle = parId.has(+d.id) ? +d.id : null; });

    const redimensionner = () => {
      const w = hote.clientWidth, h = hote.clientHeight;
      if (!w || !h) return;
      projection.fitExtent([[10, 12], [w - 10, h - 12]], sphere);
      gRoot.selectAll('path').attr('d', chemin);
    };
    redimensionner();
    if (!hote._observe) {
      hote._observe = new ResizeObserver(redimensionner);
      hote._observe.observe(hote);
    }

    d3.select('#map-in').on('click', () => d3.select('#map').transition().duration(220).call(zoom.scaleBy, 1.6));
    d3.select('#map-out').on('click', () => d3.select('#map').transition().duration(220).call(zoom.scaleBy, 1 / 1.6));
    d3.select('#map-reset').on('click', () => d3.select('#map').transition().duration(280).call(zoom.transform, d3.zoomIdentity));
  }

  // Index inverse numérique -> alpha-2, construit à la demande.
  let inverse = null;
  function codeDe(id) {
    if (!inverse) {
      inverse = new Map();
      for (const [a2, n] of Object.entries(window.ISO_NUMERIC)) inverse.set(n, a2);
    }
    return inverse.get(id);
  }

  /** Le thème a changé : les couleurs viennent des jetons CSS, il faut redessiner. */
  function retheme() {
    if (dernier && features) dessiner(dernier.parPays, dernier.total);
  }

  return { render, retheme };
})();
