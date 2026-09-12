#!/usr/bin/env python3
"""Vérifie ce qui a déjà failli faire perdre des relevés.

    python3 tools/test_rangs.py
"""
import json
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import starviz  # noqa: E402


def relevé(**kw):
    return json.dumps(kw, ensure_ascii=False)


def rangs_par_entite() -> None:
    """Deux entités d'une même case du classement ne s'écrasent pas."""
    with tempfile.TemporaryDirectory() as tmp:
        journal = Path(tmp) / "trending.jsonl"
        starviz.TRENDING_FILE = journal

        journal.write_text(relevé(
            ts="2026-09-01T00:00:00Z",
            seen=[["repository", "daily", "typescript"]],
            found=[{"scope": "repository", "window": "daily", "lang": "typescript",
                    "entity": "getopenscreen/openscreen", "rank": 12},
                   {"scope": "repository", "window": "daily", "lang": "typescript",
                    "entity": "etiennelescot/n8n-as-code", "rank": 20}]) + "\n",
            encoding="utf-8")
        vus = starviz.derniers_rangs()
        assert vus == {
            ("repository", "daily", "typescript", "getopenscreen/openscreen"): 12,
            ("repository", "daily", "typescript", "etiennelescot/n8n-as-code"): 20,
        }, vus

        # Case reconsultée où un seul reste : l'autre sort du classement.
        with journal.open("a", encoding="utf-8") as fh:
            fh.write(relevé(
                ts="2026-09-02T00:00:00Z",
                seen=[["repository", "daily", "typescript"]],
                found=[{"scope": "repository", "window": "daily", "lang": "typescript",
                        "entity": "getopenscreen/openscreen", "rank": 9}]) + "\n")
        vus = starviz.derniers_rangs()
        assert vus == {
            ("repository", "daily", "typescript", "getopenscreen/openscreen"): 9,
        }, vus


def garde_collecte() -> None:
    """Une collecte vide n'efface ni les organisations ni les dépôts connus."""
    connu = {"login": "moi", "orgs": ["uneorg"],
             "repos": [{"full_name": "uneorg/phare", "stars": 42, "events": []}]}
    vide = ""  # « gh » sort avec 0 et ne rend rien : ni erreur, ni contenu
    reponses = {
        ("api", "user", "--jq", ".login"): "moi",
        ("api", "user/orgs", "--paginate", "--jq", ".[].login"): vide,
    }
    starviz.run_gh = lambda args, timeout=300: reponses.get(tuple(args), "[]")
    starviz.Fetcher._stargazers = staticmethod(lambda full: ([], {}))

    f = starviz.Fetcher.__new__(starviz.Fetcher)
    f.lock, f.message, f.done, f.total = threading.Lock(), "", 0, 0
    f.data = connu

    try:
        f._collect(force=False)
    except starviz.GhError as exc:
        assert "cache conservé" in str(exc), exc
    else:
        raise AssertionError("une collecte sans dépôt étoilé a été acceptée")

    # Un dépôt étoilé rendu : la collecte passe, et l'organisation reste suivie.
    reponses[("repo", "list", "--limit", "1000", "--json", starviz.REPO_FIELDS)] = json.dumps(
        [{"nameWithOwner": "moi/petit", "stargazerCount": 3, "primaryLanguage": None}])
    donnees = f._collect(force=False)
    assert donnees["orgs"] == ["uneorg"], donnees["orgs"]
    assert any("liste vide" in e for e in donnees["errors"]), donnees["errors"]


def main() -> int:
    rangs_par_entite()
    garde_collecte()
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
