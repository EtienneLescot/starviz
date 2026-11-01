#!/usr/bin/env node
/* Vérifie que l'infobulle désigne bien la barre survolée.

       node tools/test_infobulle.js

   Les barres sont placées selon le temps, et seuls les paquets entiers
   tiennent dans le domaine : dès que « maintenant » n'est pas minuit, une
   grille de parts égales dérive jusqu'à une barre entière au bord droit.
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
// L'amorce touche au DOM dès le chargement : on s'arrête avant.
const corps = source.slice(0, source.indexOf('(async function main()'));

const bouchons = {
  document: {
    documentElement: { dataset: {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  localStorage: { getItem: () => null, setItem() {} },
  ResizeObserver: class { observe() {} },
};
const app = new Function(
  ...Object.keys(bouchons),
  corps + '\nreturn { state, buildBuckets, bucketAt };',
)(...Object.values(bouchons));

const DAY = 86400000;
app.state.align = 'date';
app.state.bucket = 'day';

const x1 = new Date(2026, 9, 28, 0, 18).getTime(); // 18 minutes après minuit
const x0 = x1 - 30 * DAY;
const { buckets } = app.buildBuckets(x0, x1);

const M = 56, pw = 800;
const xToPx = (x) => M + ((x - x0) / (x1 - x0)) * pw;
const pxToX = (px) => x0 + ((px - M) / pw) * (x1 - x0);
const bw = pw / buckets.length;

buckets.forEach((bk, i) => {
  const milieu = xToPx(bk.a) + bw / 2; // le centre de la barre telle qu'elle est dessinée
  const jour = new Date(bk.a).toLocaleDateString('fr-FR');
  assert.strictEqual(app.bucketAt(buckets, pxToX(milieu)), i,
    `la barre du ${jour} en désigne une autre`);
});

console.log(`ok — ${buckets.length} barres, chacune se désigne elle-même`);
