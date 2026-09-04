#!/usr/bin/env python3
"""Complète trending.jsonl avec l'historique journalier de Trendshift.

GitHub n'expose pas ses classements passés : le relevé ne connaît que ce qu'il
a vu depuis sa première exécution. Trendshift, lui, photographie chaque jour la
liste Trending et publie l'historique dans la page de chaque compte et de
chaque dépôt. C'est la seule façon de récupérer les passages antérieurs au
relevé — ou manqués pendant une extinction.

Le complément s'arrête là où commence l'intérêt du relevé : Trendshift ne
couvre que la fenêtre journalière. Les classements hebdomadaire et mensuel,
eux, ne laissent aucune trace publique.

Les lignes importées portent `"source": "trendshift"` et sont réinsérées dans
l'ordre chronologique. Elles ne déclarent pas de champ `seen` : une absence
chez Trendshift n'atteste de rien, le site n'enregistrant que les passages.

    python3 tools/import_trendshift.py [--dry-run]

Relancer l'import est sans effet de bord : les lignes déjà importées sont
remplacées, pas empilées.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP = "starviz"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / APP
TRENDING_FILE = DATA_DIR / "trending.jsonl"
CACHE_FILE = DATA_DIR / "data.json"

BASE = "https://trendshift.io"
UA = ("starviz (personal rank recorder; "
      "https://github.com/EtienneLescot/starviz)")
# La charge utile est sérialisée dans le flux de rendu de la page, échappée.
# Aucune API publique ne la sert : on la lit là où elle se trouve.
ENTREE = re.compile(
    r'\{"trending_language":(null|"[^"]*"),"trend_date":"([^"]+)","rank":(\d+)\}')


def lire(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "ignore")


def chercher(nom: str) -> dict:
    """Interroge la recherche de Trendshift ; le nom court suffit."""
    url = f"{BASE}/api/search?q={urllib.parse.quote(nom)}"
    try:
        return json.loads(lire(url))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"  recherche « {nom} » : {exc}", file=sys.stderr)
        return {}


def historique(chemin: str) -> list[tuple[str, str | None, int]]:
    """Passages journaliers d'une page Trendshift : (jour, langage, rang)."""
    try:
        html = lire(f"{BASE}{chemin}").replace('\\"', '"')
    except (urllib.error.URLError, OSError) as exc:
        print(f"  {chemin} : {exc}", file=sys.stderr)
        return []
    vus = set()
    for m in ENTREE.finditer(html):
        lang = None if m.group(1) == "null" else m.group(1).strip('"').lower()
        vus.add((m.group(2)[:10], lang, int(m.group(3))))
    return sorted(vus, key=lambda e: (e[0], e[1] or "", e[2]))


def cible_developpeur(login: str) -> str | None:
    for d in chercher(login).get("developers", []):
        if (d.get("username") or d.get("login") or "").lower() == login.lower():
            return f"/developers/{d.get('developer_id') or d.get('id')}"
    return None


def cible_depot(full_name: str) -> str | None:
    court = full_name.split("/", 1)[1]
    for r in chercher(court).get("repositories", []):
        if (r.get("full_name") or "").lower() == full_name.lower():
            return f"/repositories/{r['repository_id']}"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(prog="import_trendshift", description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="montrer ce qui serait importé, sans écrire")
    args = parser.parse_args()

    cache = json.loads(CACHE_FILE.read_text("utf-8"))
    login = cache.get("login") or ""
    depots = [r["full_name"] for r in cache.get("repos", []) if r.get("stars", 0) > 0]
    if not login:
        # Le cache ne porte pas toujours le login : il se déduit des dépôts.
        proprietaires = {d.split("/", 1)[0] for d in depots}
        login = sorted(proprietaires, key=lambda o: -sum(
            d.startswith(o + "/") for d in depots))[0]

    # Une entité = une page Trendshift. Le compte d'abord, les dépôts ensuite.
    entites: list[tuple[str, str, str]] = []
    chemin = cible_developpeur(login)
    if chemin:
        entites.append(("developer", login.lower(), chemin))
    else:
        print(f"compte « {login} » absent de Trendshift", file=sys.stderr)
    for full_name in depots:
        chemin = cible_depot(full_name)
        if chemin:
            entites.append(("repository", full_name.lower(), chemin))
        time.sleep(1)  # courtoisie envers trendshift.io

    # Un relevé par journée : c'est la granularité de la source.
    par_jour: dict[str, list[dict]] = {}
    for scope, entity, chemin in entites:
        passages = historique(chemin)
        print(f"{entity:<40} {chemin:<24} {len(passages):>3} passage(s)")
        for jour, lang, rang in passages:
            par_jour.setdefault(jour, []).append(
                {"scope": scope, "window": "daily", "lang": lang,
                 "entity": entity, "rank": rang, "total": None})
        time.sleep(1)

    importees = [
        {"ts": f"{jour}T00:00:00Z", "found": par_jour[jour], "checked": 0,
         "errors": [], "source": "trendshift"}
        for jour in sorted(par_jour)
    ]
    total = sum(len(l["found"]) for l in importees)
    print(f"\n{total} passage(s) sur {len(importees)} journée(s)")
    if args.dry_run:
        for ligne in importees:
            print(json.dumps(ligne, ensure_ascii=False))
        return 0

    # Les relevés propres sont conservés tels quels ; seuls les imports
    # précédents cèdent la place, pour que relancer n'empile rien.
    gardees = []
    for ligne in TRENDING_FILE.read_text("utf-8").splitlines():
        if not ligne.strip():
            continue
        try:
            releve = json.loads(ligne)
        except ValueError:
            gardees.append((None, ligne))
            continue
        if releve.get("source") == "trendshift":
            continue
        gardees.append((releve.get("ts", ""), ligne))

    fusion = gardees + [(l["ts"], json.dumps(l, ensure_ascii=False)) for l in importees]
    # Tri stable : l'ordre d'origine des relevés propres est préservé, et les
    # lignes importées se rangent à leur date. Un journal rejoué à l'envers
    # ferait passer un rang de juillet pour la position du jour.
    fusion.sort(key=lambda t: t[0] or "")
    TRENDING_FILE.write_text(
        "\n".join(texte for _, texte in fusion) + "\n", encoding="utf-8")
    print(f"{len(fusion)} ligne(s) dans {TRENDING_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
