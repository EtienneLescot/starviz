#!/usr/bin/env python3
"""Complète trending.jsonl avec les classements archivés par la Wayback Machine.

Trendshift ne connaît que la fenêtre journalière et n'indexe que les comptes
personnels : les passages hebdomadaires et mensuels, et ceux des organisations,
n'ont aucune autre trace publique que les copies de github.com/trending prises
par archive.org. Elles sont irrégulières — quelques-unes par semaine et par
page — mais c'est la seule source pour ce que le relevé n'a pas vu.

    python3 tools/import_wayback.py [--depuis 2026-07-01] [--dry-run]

Les lignes importées portent `"source": "wayback"` et sont réinsérées dans
l'ordre chronologique ; relancer l'import les remplace au lieu de les empiler.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from starviz import (CACHE_FILE, TRENDING_FILE, TRENDING_PAGES,  # noqa: E402
                     TRENDING_UA, TRENDING_WINDOWS, read_json)

CDX = "http://web.archive.org/cdx/search/cdx"
# « id_ » réclame la copie brute : sans lui archive.org réécrit les liens et
# injecte sa barre d'outils, ce que les motifs de starviz ne reconnaissent plus.
SNAPSHOT = "https://web.archive.org/web/{ts}id_/{url}"


def lire(url: str, essais: int = 3, delai: int = 60) -> str:
    for n in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": TRENDING_UA})
            with urllib.request.urlopen(req, timeout=delai) as resp:
                brut = resp.read()
            # « id_ » rend l'octet d'origine, compression comprise : sans la
            # défaire, la page archivée n'est qu'un flux binaire où aucun
            # classement ne se lit.
            if brut[:2] == bytes.fromhex("1f8b"):  # en-tête gzip
                brut = gzip.decompress(brut)
            return brut.decode("utf-8", "ignore")
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            if n == essais - 1:
                print(f"  {url[:90]} : {exc}", file=sys.stderr)
            time.sleep(2 * (n + 1))
    return ""


def instantanes(url: str, depuis: str, jusqua: str) -> list[tuple[str, str]]:
    """(horodatage, url) des copies archivées d'une page et de ses fenêtres."""
    params = urllib.parse.urlencode({
        "url": url, "matchType": "prefix", "from": depuis, "to": jusqua,
        "output": "json", "fl": "timestamp,original,statuscode",
        "collapse": "digest", "filter": "statuscode:200", "limit": "5000"})
    # L'index trie par clé d'URL : la page nue vient avant ses langages, mais
    # le sous-arbre entier est long à produire et la requête expire à 60 s.
    texte = lire(f"{CDX}?{params}", delai=300)
    if not texte.strip():
        return []
    try:
        lignes = json.loads(texte)[1:]
    except ValueError:
        return []
    # Le préfixe ramène aussi les langages voisins (« python-console » pour
    # « python ») : seules comptent la page elle-même et ses fenêtres.
    gardees = []
    for ts, brut, _ in lignes:
        chemin, _, requete = brut.partition("?")
        # Le CDX rend l'URL complète, schéma compris ; la comparaison porte sur
        # le chemin seul, sinon aucune copie ne correspond jamais.
        chemin = re.sub(r"^https?://(www\.)?", "", chemin)
        if chemin.rstrip("/").lower() != url.rstrip("/").lower():
            continue
        fenetre = urllib.parse.parse_qs(requete).get("since", ["daily"])[0]
        if fenetre in TRENDING_WINDOWS:
            gardees.append((ts, brut, fenetre))
    return gardees


def main() -> int:
    parser = argparse.ArgumentParser(prog="import_wayback", description=__doc__)
    parser.add_argument("--depuis", default="2026-07-01", help="date de début (AAAA-MM-JJ)")
    parser.add_argument("--jusqua", default=time.strftime("%Y-%m-%d"), help="date de fin")
    parser.add_argument("--dry-run", action="store_true", help="montrer sans écrire")
    args = parser.parse_args()

    cache = read_json(CACHE_FILE) or {}
    login = cache.get("login") or ""
    devs = [d.lower() for d in [login, *(cache.get("orgs") or [])] if d]
    etoiles = [r for r in cache.get("repos", []) if r.get("stars", 0) > 0]
    repos = [r["full_name"].lower() for r in etoiles]
    compte: dict[str, int] = {}
    for r in etoiles:
        if r.get("language"):
            compte[r["language"].lower()] = compte.get(r["language"].lower(), 0) + r["stars"]
    langs = [l for l, _ in sorted(compte.items(), key=lambda kv: -kv[1])[:2]]
    print(f"comptes : {', '.join(devs)}\ndépôts  : {len(repos)}\nlangages: {', '.join(langs)}\n")

    depuis, jusqua = args.depuis.replace("-", ""), args.jusqua.replace("-", "")
    par_ts: dict[str, list[dict]] = {}
    for scope, (base, motif) in TRENDING_PAGES.items():
        cibles = devs if scope == "developer" else repos
        for lang in [None, *langs]:
            page = base if lang is None else f"{base}/{lang}"
            copies = instantanes(page.replace("https://", ""), depuis, jusqua)
            print(f"{page.replace('https://github.com', ''):<38} {len(copies):>3} copie(s)")
            for ts, url, fenetre in copies:
                html = lire(SNAPSHOT.format(ts=ts, url=url))
                if not html:
                    continue
                noms = [n.lower() for n in re.findall(motif, html)]
                for i, nom in enumerate(noms, 1):
                    if nom not in cibles:
                        continue
                    horodatage = (f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}T"
                                  f"{ts[8:10]}:{ts[10:12]}:{ts[12:14]}Z")
                    par_ts.setdefault(horodatage, []).append(
                        {"scope": scope, "window": fenetre, "lang": lang,
                         "entity": nom, "rank": i, "total": len(noms),
                         "archive": f"https://web.archive.org/web/{ts}/{url}"})
                    print(f"    {horodatage}  {scope} {fenetre}/{lang or 'tous'}"
                          f"  #{i}/{len(noms)}  {nom}")
                time.sleep(1)  # courtoisie envers archive.org

    importees = [{"ts": ts, "found": par_ts[ts], "checked": 0, "errors": [],
                  "source": "wayback"} for ts in sorted(par_ts)]
    total = sum(len(l["found"]) for l in importees)
    print(f"\n{total} passage(s) sur {len(importees)} copie(s)")
    if args.dry_run or not importees:
        return 0

    gardees = []
    for ligne in TRENDING_FILE.read_text("utf-8").splitlines():
        if not ligne.strip():
            continue
        try:
            releve = json.loads(ligne)
        except ValueError:
            gardees.append((None, ligne))
            continue
        if releve.get("source") == "wayback":
            continue
        gardees.append((releve.get("ts", ""), ligne))

    fusion = gardees + [(l["ts"], json.dumps(l, ensure_ascii=False)) for l in importees]
    fusion.sort(key=lambda t: t[0] or "")
    TRENDING_FILE.write_text("\n".join(t for _, t in fusion) + "\n", encoding="utf-8")
    print(f"{len(fusion)} ligne(s) dans {TRENDING_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
