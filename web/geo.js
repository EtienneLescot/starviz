/* Rattachement d'une localisation GitHub (texte libre) à un pays / continent.
   Les tables viennent de geo-data.js, généré par tools/gen_geo.py. */
(function (global) {
  'use strict';
  const D = global.GEO_DATA;
  const cache = new Map();

  const STATE_CODES = new Set(D.stateCodes);
  const BR_STATES = new Set(D.brStates || []);
  const STRONG = new Set(D.strongCC);
  const PROVINCES = { ab: 'CA', bc: 'CA', mb: 'CA', nb: 'CA', ns: 'CA', nt: 'CA', nu: 'CA',
                      on: 'CA', pe: 'CA', qc: 'CA', sk: 'CA', yt: 'CA' };
  // Clés idéographiques, testées par inclusion faute de séparateurs de mots.
  const CJK_KEYS = Object.keys(D.aliases)
    .filter((k) => /[\u2e80-\u9fff\uac00-\ud7af]/.test(k))
    .sort((a, b) => b.length - a.length);
  const ISO_LOWER = {};
  Object.keys(D.countries).forEach((c) => { ISO_LOWER[c.toLowerCase()] = c; });

  const norm = (s) => s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase().split(/\s+/).filter(Boolean).join(' ');

  /** Un drapeau emoji encode directement le code ISO du pays. */
  function flagCode(raw) {
    const letters = [...raw]
      .filter((c) => { const p = c.codePointAt(0); return p >= 0x1f1e6 && p <= 0x1f1ff; })
      .map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65));
    const code = letters.slice(0, 2).join('');
    return code.length === 2 && D.countries[code] ? code : null;
  }

  function lookup(raw) {
    const flag = flagCode(raw);
    if (flag) return flag;

    const whole = norm(raw);
    if (!whole) return null;
    const parts = raw.split(/[,;/|·•\n]|\s+[-–]\s+/).map(norm).filter(Boolean);
    const tokens = parts.length ? parts : [whole];

    // 1. Nom de pays explicite : la chaîne entière, puis chaque segment en
    //    partant de la fin (« Ville, Région, Pays »).
    if (D.aliases[whole]) return D.aliases[whole];
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (D.aliases[tokens[i]]) return D.aliases[tokens[i]];
    }

    // Ville candidate : sert aussi à départager les codes à deux lettres.
    let city = null;
    for (let i = tokens.length - 1; i >= 0 && !city; i--) city = D.cities[tokens[i]] || null;

    // 2. État américain écrit en toutes lettres.
    for (const tok of tokens) if (D.states[tok]) return 'US';

    // 3. Codes à deux lettres, en partant de la fin : « Austin, TX » (État
    //    américain) vs « Berlin, DE » (pays), « Recife, PE » (État brésilien).
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      if (tok.length !== 2) continue;
      if (STATE_CODES.has(tok) && (city === 'US' || !STRONG.has(tok))) return 'US';
      if (PROVINCES[tok] && (city === 'CA' || !STRONG.has(tok))) return 'CA';
      if (BR_STATES.has(tok) && (city === 'BR' || !ISO_LOWER[tok])) return 'BR';
      if (ISO_LOWER[tok]) return ISO_LOWER[tok];
    }
    if (city) return city;

    // 4. Dernier recours : chercher un nom connu dans les mots de la chaîne.
    const words = whole.split(' ');
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n).join(' ');
        const hit = D.aliases[gram] || D.cities[gram] || (D.states[gram] ? 'US' : null);
        if (hit) return hit;
      }
    }
    // 5. Écritures sans espaces (chinois, japonais…) : recherche par inclusion.
    if (/[\u2e80-\u9fff\uac00-\ud7af]/.test(whole)) {
      for (const key of CJK_KEYS) if (whole.includes(key)) return D.aliases[key];
    }
    return null;
  }

  function resolve(raw) {
    if (!raw) return null;
    if (cache.has(raw)) return cache.get(raw);
    let code = null;
    try { code = lookup(raw); } catch { code = null; }
    cache.set(raw, code);
    return code;
  }

  const flagOf = (code) => String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

  function info(code) {
    const entry = D.countries[code];
    if (!entry) return null;
    return {
      code,
      name: entry[0],
      flag: flagOf(code),
      continent: entry[1],
      continentName: D.continents[entry[1]] || D.continents.XX,
    };
  }

  global.GEO = { resolve, info, flagOf, continents: D.continents };
})(typeof window !== 'undefined' ? window : globalThis);
