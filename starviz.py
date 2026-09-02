#!/usr/bin/env python3
"""StarViz — visualiseur de l'évolution des étoiles des dépôts GitHub.

Récupère les données via GitHub CLI (`gh`, déjà authentifié), les met en cache,
puis sert une petite application web locale (127.0.0.1) qui affiche les courbes.
Aucune dépendance en dehors de la bibliothèque standard.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

APP = "starviz"
DEFAULT_PORT = 7842
IDLE_TIMEOUT = 180.0  # secondes sans requête du navigateur avant extinction

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / APP
INSTANCE_FILE = CACHE_DIR / "instance.json"

REPO_FIELDS = (
    "nameWithOwner,name,description,stargazerCount,isFork,isPrivate,"
    "isArchived,createdAt,pushedAt,primaryLanguage,url"
)

STARGAZER_QUERY = """query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $endCursor, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login location } }
    }
  }
}"""

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    # Les polices et la topographie sont servies depuis web/ : sans leur type,
    # le navigateur reçoit du flux binaire indifférencié.
    ".woff2": "font/woff2",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
}

# Chemins où `gh` peut vivre quand l'app est lancée depuis la barre des tâches
# (une session graphique n'hérite pas toujours du PATH d'un shell interactif).
EXTRA_PATHS = [
    "/home/linuxbrew/.linuxbrew/bin",
    str(Path.home() / ".linuxbrew/bin"),
    str(Path.home() / ".local/bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    "/snap/bin",
]


# Le cache est jetable par définition ; l'historique des classements et les
# captures, eux, se conservent et se synchronisent. D'où XDG_DATA_HOME.
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / APP
TRENDING_FILE = DATA_DIR / "trending.jsonl"
# L'historique des étoiles est reconstruit depuis l'API, mais il ne l'est plus
# si un dépôt disparaît : c'est une donnée à conserver, pas un cache.
CACHE_FILE = DATA_DIR / "data.json"
TRENDING_UA = "starviz (personal rank recorder; https://github.com/EtienneLescot/starviz)"
# GitHub n'expose ni API ni notification pour ses classements « Trending », et
# les archives publiques ne couvrent que la fenêtre journalière. On relève donc
# soi-même les six pages (2 classements × 3 fenêtres). robots.txt ne les
# interdit pas ; l'attribut href n'est pas le premier du lien, d'où les regex.
TRENDING_PAGES = {
    "developer": ("https://github.com/trending/developers",
                  r'<h1 class="h3 lh-condensed"\s*>\s*<a[^>]*?href="/([A-Za-z0-9._-]+)"'),
    "repository": ("https://github.com/trending",
                   r'<h2 class="h3 lh-condensed"\s*>\s*<a[^>]*?href="/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)"'),
}
TRENDING_WINDOWS = ("daily", "weekly", "monthly")
CAPTURES_DIR = DATA_DIR / "captures"
# Chromium et Firefox sont des snaps sur Ubuntu : leur confinement leur
# interdit d'écrire dans un dossier caché comme ~/.cache. On passe donc par un
# dossier temporaire visible, puis on déplace le fichier.
SHOT_TMP = Path.home() / "starviz-shot-tmp"
SHOT_BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
                 "chrome", "msedge")
# Sous Windows un navigateur ne s'installe pas dans le PATH : sans ces chemins
# par défaut, la recherche échoue et les captures disparaissent en silence.
SHOT_BROWSERS_WIN = (
    r"Google\Chrome\Application\chrome.exe",
    r"Microsoft\Edge\Application\msedge.exe",
    r"Chromium\Application\chrome.exe",
)


class GhError(RuntimeError):
    """Erreur remontée par la CLI GitHub, présentable telle quelle à l'écran."""


def find_gh() -> str:
    explicit = os.environ.get("STARVIZ_GH")
    if explicit and Path(explicit).exists():
        return explicit
    path = os.pathsep.join([os.environ.get("PATH", ""), *EXTRA_PATHS])
    found = shutil.which("gh", path=path)
    if not found:
        raise GhError(
            "GitHub CLI (« gh ») est introuvable. Installez-la puis lancez « gh auth login »."
        )
    return found


def run_gh(args: list[str], timeout: int = 300) -> str:
    gh = find_gh()
    try:
        proc = subprocess.run(
            [gh, *args], capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise GhError(f"Délai dépassé sur : gh {' '.join(args[:2])}")
    if proc.returncode != 0:
        lines = [l for l in (proc.stderr or proc.stdout).strip().splitlines() if l.strip()]
        detail = lines[-1] if lines else f"code de sortie {proc.returncode}"
        if "auth" in detail.lower() or "credentials" in detail.lower():
            detail += "  →  lancez « gh auth login »"
        raise GhError(detail)
    return proc.stdout


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, payload, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")
    os.chmod(tmp, mode)
    tmp.replace(path)


class Fetcher:
    """Récupère et met en cache l'historique des étoiles, en tâche de fond."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = "idle"  # idle | running | error
        self.message = ""
        self.done = 0
        self.total = 0
        self.error: str | None = None
        self.data = read_json(CACHE_FILE)
        self._thread: threading.Thread | None = None

    def status(self) -> dict:
        with self.lock:
            return {
                "state": self.state,
                "message": self.message,
                "done": self.done,
                "total": self.total,
                "error": self.error,
                "generated_at": (self.data or {}).get("generated_at"),
                "has_data": self.data is not None,
            }

    def _progress(self, message: str, done: int = 0, total: int = 0) -> None:
        with self.lock:
            self.message = message
            self.done = done
            self.total = total

    def start(self, force: bool = False) -> bool:
        with self.lock:
            if self.state == "running":
                return False
            self.state = "running"
            self.error = None
            self.message = "Connexion à GitHub…"
            self.done = self.total = 0
        self._thread = threading.Thread(target=self._run, args=(force,), daemon=True)
        self._thread.start()
        return True

    def _run(self, force: bool) -> None:
        try:
            data = self._collect(force)
            write_json(CACHE_FILE, data)
            with self.lock:
                self.data = data
                self.state = "idle"
                self.message = "À jour"
        except GhError as exc:
            with self.lock:
                self.state = "error"
                self.error = str(exc)
                self.message = "Échec de la récupération"
        except Exception as exc:  # filet de sécurité : l'UI doit toujours savoir
            with self.lock:
                self.state = "error"
                self.error = f"{type(exc).__name__}: {exc}"
                self.message = "Échec de la récupération"

    def _collect(self, force: bool) -> dict:
        self._progress("Identification du compte…")
        login = run_gh(["api", "user", "--jq", ".login"]).strip()

        erreurs: list[str] = []
        self._progress("Liste des organisations…")
        try:
            orgs = [o.strip() for o in
                    run_gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]).splitlines()
                    if o.strip()]
        except GhError as exc:
            # Un échec réseau ferait disparaître d'un coup tous les dépôts
            # d'organisation : on repart de la dernière liste connue.
            orgs = list((self.data or {}).get("orgs") or [])
            erreurs.append(f"organisations : {exc}")

        repos_raw: list[dict] = []
        seen: set[str] = set()
        for owner in [login, *orgs]:
            self._progress(f"Liste des dépôts de {owner}…")
            # Sans argument, « gh repo list » couvre le compte authentifié
            # (dépôts privés inclus) ; avec argument, une organisation.
            args = ["repo", "list", "--limit", "1000", "--json", REPO_FIELDS]
            if owner != login:
                args.insert(2, owner)
            for repo in json.loads(run_gh(args) or "[]"):
                if repo["nameWithOwner"] in seen:
                    continue
                seen.add(repo["nameWithOwner"])
                repos_raw.append(repo)

        previous = {r["full_name"]: r for r in (self.data or {}).get("repos", [])}
        locations: dict[str, str] = dict((self.data or {}).get("locations") or {})
        repos: list[dict] = []
        starred = [r for r in repos_raw if r.get("stargazerCount", 0) > 0]
        total = len(starred)

        for repo in sorted(repos_raw, key=lambda r: -r.get("stargazerCount", 0)):
            full = repo["nameWithOwner"]
            stars = repo.get("stargazerCount", 0)
            lang = (repo.get("primaryLanguage") or {}).get("name")
            entry = {
                "full_name": full,
                "name": repo.get("name") or full.split("/")[-1],
                "owner": full.split("/")[0],
                "is_org": full.split("/")[0].lower() != login.lower(),
                "description": repo.get("description") or "",
                "stars": stars,
                "fork": bool(repo.get("isFork")),
                "private": bool(repo.get("isPrivate")),
                "archived": bool(repo.get("isArchived")),
                "created_at": repo.get("createdAt"),
                "pushed_at": repo.get("pushedAt"),
                "language": lang,
                "url": repo.get("url") or f"https://github.com/{full}",
                "events": [],
            }
            if stars == 0:
                repos.append(entry)
                continue

            cached = previous.get(full)
            reuse = (
                not force
                and cached is not None
                and cached.get("stars") == stars
                and cached.get("events")
            )
            done = len([r for r in repos if r["stars"] > 0])
            if reuse:
                entry["events"] = cached["events"]
                self._progress(f"{full} inchangé", done + 1, total)
            else:
                self._progress(f"Étoiles de {full}…", done, total)
                try:
                    entry["events"], found = self._stargazers(full)
                    locations.update(found)
                except GhError as exc:
                    # Un dépôt inaccessible ne doit ni faire échouer la collecte,
                    # ni disparaître de l'affichage : sans évènements, l'interface
                    # l'ignore purement et simplement. On conserve donc l'existant.
                    entry["events"] = (cached or {}).get("events", [])
                    entry["error"] = str(exc)
                    erreurs.append(f"{full} : {exc}")
            repos.append(entry)

        self._progress("Finalisation…", total, total)
        known = {user for r in repos for _, user in r["events"]}
        return {
            "generated_at": now_iso(),
            "login": login,
            "orgs": orgs,
            "repos": repos,
            "locations": {u: p for u, p in locations.items() if u in known},
            "errors": erreurs,
        }

    @staticmethod
    def _stargazers(full_name: str) -> tuple[list[list[str]], dict[str, str]]:
        """Renvoie (évènements triés, localisations des profils).

        GraphQL sert les deux d'un coup : l'équivalent REST demanderait une
        requête supplémentaire par utilisateur pour connaître sa localisation.
        """
        owner, _, name = full_name.partition("/")
        out = run_gh(
            [
                "api", "graphql", "--paginate",
                "-f", f"owner={owner}",
                "-f", f"name={name}",
                "-f", f"query={STARGAZER_QUERY}",
                "--jq",
                '.data.repository.stargazers.edges[] | '
                '"\\(.starredAt)\\t\\(.node.login)\\t\\(.node.location // \"\")"',
            ]
        )
        events, locations = [], {}
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t", 2)
            stamp, user = parts[0], parts[1] if len(parts) > 1 else ""
            place = parts[2].strip() if len(parts) > 2 else ""
            events.append([stamp, user])
            if place:
                locations[user] = place[:80]
        events.sort(key=lambda e: e[0])
        return events, locations


def find_browser() -> str | None:
    """Navigateur sans interface capable de photographier une page."""
    trouve = next((shutil.which(b) for b in SHOT_BROWSERS if shutil.which(b)), None)
    if trouve or os.name != "nt":
        return trouve
    bases = (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
             os.environ.get("LOCALAPPDATA"))
    for base in filter(None, bases):
        for suffixe in SHOT_BROWSERS_WIN:
            chemin = Path(base) / suffixe
            if chemin.exists():
                return str(chemin)
    return None


def capture_page(url: str, nom: str, rang: int = 0) -> str | None:
    """Photographie une page de classement : une image vaut mieux qu'un rang.

    La fenêtre est haute comme il faut pour atteindre la ligne visée. À
    hauteur fixe, une capture s'arrêtait avant elle dès le 18e rang : une
    preuve où l'on ne figure pas ne prouve rien, et rien ne le signalait.
    """
    navigateur = find_browser()
    if not navigateur:
        return None
    SHOT_TMP.mkdir(parents=True, exist_ok=True)
    CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    brut = SHOT_TMP / nom
    # En-tête de la page, puis une ligne large : les lignes « dépôt » sont plus
    # hautes que les lignes « développeur », la marge couvre les deux.
    hauteur = min(1000 + max(rang, 1) * 240, 12000)
    try:
        subprocess.run(
            [navigateur, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             f"--window-size=1280,{hauteur}", f"--screenshot={brut}", url],
            capture_output=True, timeout=120)
        if not brut.exists():
            return None
        cible = CAPTURES_DIR / nom
        brut.replace(cible)
        return str(cible)
    except (subprocess.TimeoutExpired, OSError):
        return None
    finally:
        try:
            SHOT_TMP.rmdir()
        except OSError:
            pass


def derniers_rangs() -> dict[tuple, int]:
    """Rang connu pour chaque case du classement (scope, fenêtre, langage).

    Une case consultée où l'on n'apparaît plus s'efface : sans cela la sortie
    d'un classement se redécouvre à chaque passage, et le dépôt de données
    reçoit un commit toutes les 3 heures pour un évènement déjà vieux.
    """
    vus: dict[tuple, int] = {}
    try:
        for ligne in TRENDING_FILE.read_text("utf-8").splitlines():
            if not ligne.strip():
                continue
            releve = json.loads(ligne)
            # Les relevés antérieurs à ce champ ne disent pas ce qu'ils ont
            # consulté : d'eux, on ne peut retenir que ce qu'ils ont trouvé.
            for scope, window, lang in releve.get("seen", []):
                vus.pop((scope, window, lang), None)
            for t in releve.get("found", []):
                vus[(t["scope"], t["window"], t.get("lang"))] = t["rank"]
    except (OSError, ValueError):
        pass
    return vus


def trending_ranks(login: str, repos: list[str], langs: list[str],
                   shots: bool = True) -> dict:
    """Relève la position de l'utilisateur et de ses dépôts dans les classements.

    Chaque classement existe sans filtre et par langage ; le rang y est très
    différent, et seule la version filtrée révèle parfois une bonne place.
    """
    import re
    horodatage = now_iso()
    # « seen » recense les cases réellement consultées : une page en échec
    # n'est pas une absence du classement.
    releve = {"ts": horodatage, "found": [], "checked": 0, "errors": [], "seen": []}
    connus = derniers_rangs()
    for scope, (base, pattern) in TRENDING_PAGES.items():
        cibles = [login.lower()] if scope == "developer" else [r.lower() for r in repos]
        for lang in [None, *langs]:
            racine = base if lang is None else f"{base}/{lang}"
            for window in TRENDING_WINDOWS:
                url = racine if window == "daily" else f"{racine}?since={window}"
                try:
                    req = urllib.request.Request(
                        url, headers={"User-Agent": TRENDING_UA, "Accept": "text/html"})
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        html = resp.read().decode("utf-8", "ignore")
                except (urllib.error.URLError, OSError, TimeoutError) as exc:
                    releve["errors"].append(f"{scope}/{lang or 'all'}/{window}: {exc}"[:120])
                    continue
                releve["checked"] += 1
                releve["seen"].append([scope, window, lang])
                noms = [n.lower() for n in re.findall(pattern, html)]
                for i, nom in enumerate(noms, 1):
                    if nom not in cibles:
                        continue
                    trouve = {"scope": scope, "window": window, "lang": lang,
                              "entity": nom, "rank": i, "total": len(noms)}
                    # Une capture par changement de rang : à chaque passage, on
                    # accumulerait des dizaines d'images identiques par jour.
                    nouveau = connus.get((scope, window, lang)) != i
                    if shots and nouveau:
                        fichier = (f"{horodatage.replace(':', '').replace('-', '')}"
                                   f"_{scope}_{window}_{lang or 'all'}_rang{i}.png")
                        trouve["shot"] = capture_page(url, fichier, i)
                    releve["found"].append(trouve)
                time.sleep(1)  # courtoisie envers github.com
    return releve


def sync_data(motif: str = "", flush_apres_h: int = 20) -> str:
    """Pousse les données si le dossier est un dépôt git.

    Un relevé a lieu toutes les 3 heures et modifie toujours quelque chose
    (une ligne de journal, quelques étoiles de plus). Committer à chaque fois
    noierait l'historique sous des dizaines de commits sans contenu. On ne
    committe donc que sur un évènement — changement de rang, nouvelle capture —
    ou, à défaut, une fois par jour pour ne rien laisser trop longtemps
    hors du dépôt distant.
    """
    if not (DATA_DIR / ".git").exists():
        return ""

    def git(*args):
        return subprocess.run(["git", "-C", str(DATA_DIR), *args],
                              capture_output=True, text=True, timeout=180)

    if not git("status", "--porcelain").stdout.strip():
        return "rien à synchroniser"

    if not motif:
        dernier = git("log", "-1", "--format=%ct").stdout.strip()
        try:
            age_h = (time.time() - int(dernier)) / 3600
        except ValueError:
            age_h = 1e9
        if age_h < flush_apres_h:
            return f"en attente (dernier commit il y a {age_h:.0f} h, rien de notable)"
        motif = "Relevé quotidien"

    git("add", "-A")
    git("commit", "-m", f"{motif}\n\n{now_iso()}")
    pousse = git("push")
    if pousse.returncode != 0:
        detail = (pousse.stderr.strip().splitlines() or ["?"])[-1][:60]
        return f"commit local, push impossible ({detail})"
    return f"poussé — {motif}"


def record_trending(shots: bool = True) -> int:
    """Relève les classements, les journalise, et affiche les meilleurs connus."""
    login = run_gh(["api", "user", "--jq", ".login"]).strip()
    cache = read_json(CACHE_FILE) or {}
    etoiles = [r for r in cache.get("repos", []) if r.get("stars", 0) > 0]
    repos = [r["full_name"] for r in etoiles]

    # Langages à surveiller : ceux des dépôts les mieux étoilés, les classements
    # filtrés étant bien plus accessibles que le classement général.
    compte: dict[str, int] = {}
    for r in sorted(etoiles, key=lambda r: -r["stars"]):
        if r.get("language"):
            compte[r["language"].lower()] = compte.get(r["language"].lower(), 0) + r["stars"]
    langs = [l for l, _ in sorted(compte.items(), key=lambda kv: -kv[1])[:2]]

    connus = derniers_rangs()
    releve = trending_ranks(login, repos, langs, shots=shots)

    TRENDING_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TRENDING_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(releve, ensure_ascii=False) + "\n")

    historique = []
    try:
        for ligne in TRENDING_FILE.read_text("utf-8").splitlines():
            if ligne.strip():
                historique.append(json.loads(ligne))
    except (OSError, ValueError):
        pass

    print(f"Relevé du {releve['ts']} — {releve['checked']} classements consultés"
          + (f", langages : {', '.join(langs)}" if langs else ""))
    if not releve["found"]:
        print("  absent de tous les classements")
    for t in sorted(releve["found"], key=lambda t: t["rank"]):
        # Meilleur rang déjà observé dans la même case du classement.
        anciens = [f["rank"] for h in historique for f in h.get("found", [])
                   if (f["scope"], f["window"], f.get("lang")) == (t["scope"], t["window"], t.get("lang"))]
        record = f" · meilleur : #{min(anciens)}" if anciens else ""
        image = "  📷" if t.get("shot") else ""
        print(f"  {t['scope']:<10} {t['window']:<8} {t.get('lang') or 'tous langages':<12}"
              f" #{t['rank']}/{t['total']}  {t['entity']}{record}{image}")
    print(f"\n{len(historique)} relevé(s) dans {TRENDING_FILE}")
    if shots and CAPTURES_DIR.exists():
        print(f"{len(list(CAPTURES_DIR.glob('*.png')))} capture(s) dans {CAPTURES_DIR}")
    # Un évènement digne d'un commit : un rang qui bouge, ou une capture.
    avant = {(k[0], k[1], k[2]): v for k, v in connus.items()}
    apres = {(t["scope"], t["window"], t.get("lang")): t["rank"] for t in releve["found"]}
    changements = []
    for cle in sorted(set(avant) | set(apres), key=str):
        ancien, nouveau = avant.get(cle), apres.get(cle)
        if ancien == nouveau:
            continue
        libelle = f"{cle[1]}/{cle[2] or 'tous'}"
        if nouveau is None:
            changements.append(f"{libelle} sorti")
        elif ancien is None:
            changements.append(f"{libelle} #{nouveau}")
        else:
            changements.append(f"{libelle} #{ancien}→#{nouveau}")
    motif = "Classements : " + ", ".join(changements[:4]) if changements else ""

    etat = sync_data(motif)
    if etat:
        print(f"Dépôt de données : {etat}")
    return 0


class Handler(BaseHTTPRequestHandler):
    server_version = "StarViz"
    protocol_version = "HTTP/1.1"

    # -- infrastructure ----------------------------------------------------
    def log_message(self, fmt, *args):  # silence : pas de bruit dans les logs
        pass

    def _touch(self) -> None:
        self.server.last_seen = time.monotonic()

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload, code: int = 200) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authorized(self, query: dict) -> bool:
        given = (query.get("t") or [""])[0]
        return hmac.compare_digest(given, self.server.token)

    def _safe_host(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "::1", "")

    # -- routage -----------------------------------------------------------
    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        if not self._safe_host():
            self._json({"error": "hôte non autorisé"}, 403)
            return
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        self._touch()

        if route.startswith("/api/"):
            if not self._authorized(query):
                self._json({"error": "jeton invalide"}, 403)
                return
            self._api(route, query)
            return

        if route in ("/", "/index.html"):
            self._index()
            return

        self._static(route)

    def _api(self, route: str, query: dict) -> None:
        fetcher: Fetcher = self.server.fetcher
        if route == "/api/hello":
            self._json({"app": APP, "pid": os.getpid()})
        elif route == "/api/status":
            self._json(fetcher.status())
        elif route == "/api/data":
            with fetcher.lock:
                data = fetcher.data
            if data is None:
                self._json({"error": "aucune donnée en cache"}, 404)
            else:
                self._json(data)
        elif route == "/api/refresh":
            force = (query.get("force") or ["0"])[0] in ("1", "true")
            started = fetcher.start(force=force)
            self._json({"started": started, **fetcher.status()})
        elif route == "/api/quit":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._json({"error": "route inconnue"}, 404)

    def _index(self) -> None:
        try:
            html = (WEB_DIR / "index.html").read_text("utf-8")
        except OSError:
            self._send(500, b"index.html introuvable", "text/plain; charset=utf-8")
            return
        html = html.replace("__STARVIZ_TOKEN__", self.server.token)
        self._send(200, html.encode("utf-8"), MIME[".html"])

    def _static(self, route: str) -> None:
        rel = route.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
            self._send(404, b"introuvable", "text/plain; charset=utf-8")
            return
        ctype = MIME.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, token: str, fetcher: Fetcher):
        super().__init__(addr, Handler)
        self.token = token
        self.fetcher = fetcher
        self.last_seen = time.monotonic()


def existing_instance() -> str | None:
    """Retourne l'URL d'une instance déjà lancée, si elle répond encore."""
    info = read_json(INSTANCE_FILE)
    if not isinstance(info, dict):
        return None
    port, token = info.get("port"), info.get("token")
    if not port or not token:
        return None
    url = f"http://127.0.0.1:{port}/"
    try:
        with urllib.request.urlopen(f"{url}api/hello?t={token}", timeout=1.5) as resp:
            if json.loads(resp.read()).get("app") == APP:
                return url
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return None


def watchdog(server: Server) -> None:
    while True:
        time.sleep(15)
        if time.monotonic() - server.last_seen > IDLE_TIMEOUT:
            server.shutdown()
            return


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="starviz", description="Visualiseur de l'évolution des étoiles GitHub."
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="port d'écoute local")
    parser.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur")
    parser.add_argument("--refresh", action="store_true", help="forcer une récupération complète au démarrage")
    parser.add_argument("--fetch-only", action="store_true", help="mettre à jour le cache puis quitter")
    parser.add_argument("--trending", action="store_true",
                        help="relever les classements Trending et les journaliser, puis quitter")
    parser.add_argument("--no-shots", action="store_true",
                        help="avec --trending : ne pas photographier les classements")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    fetcher = Fetcher()

    if args.fetch_only:
        fetcher.start(force=args.refresh)
        while fetcher.status()["state"] == "running":
            time.sleep(0.4)
        status = fetcher.status()
        if status["error"]:
            print(f"Échec : {status['error']}", file=sys.stderr)
            if not args.trending:
                return 1
        else:
            repos = [r for r in fetcher.data["repos"] if r["stars"] > 0]
            print(f"{sum(r['stars'] for r in repos)} étoiles sur {len(repos)} dépôts → {CACHE_FILE}")
        # Sans --trending, l'historique des étoiles mérite quand même d'être
        # poussé — au rythme d'un commit par jour.
        if not args.trending:
            etat = sync_data()
            if etat:
                print(f"Dépôt de données : {etat}")
            return 0

    if args.trending:
        try:
            return record_trending(shots=not args.no_shots)
        except GhError as exc:
            print(f"Échec : {exc}", file=sys.stderr)
            return 1


    running = existing_instance()
    if running:
        if not args.no_browser:
            webbrowser.open(running)
        print(f"StarViz tourne déjà : {running}")
        return 0

    token = secrets.token_urlsafe(24)
    try:
        server = Server(("127.0.0.1", args.port), token, fetcher)
    except OSError:
        server = Server(("127.0.0.1", 0), token, fetcher)
    port = server.server_address[1]
    write_json(INSTANCE_FILE, {"port": port, "token": token, "pid": os.getpid()}, mode=0o600)

    # Première mise à jour : immédiate si le cache est vide ou vieux d'une heure.
    stale = True
    if fetcher.data and fetcher.data.get("generated_at"):
        try:
            born = datetime.fromisoformat(fetcher.data["generated_at"].replace("Z", "+00:00"))
            stale = (datetime.now(timezone.utc) - born).total_seconds() > 3600
        except ValueError:
            stale = True
    if stale or args.refresh:
        fetcher.start(force=args.refresh)

    url = f"http://127.0.0.1:{port}/"
    print(f"StarViz → {url}")
    threading.Thread(target=watchdog, args=(server,), daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            INSTANCE_FILE.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
