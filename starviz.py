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
CACHE_FILE = CACHE_DIR / "data.json"
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

        self._progress("Liste des organisations…")
        try:
            orgs = [o.strip() for o in
                    run_gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]).splitlines()
                    if o.strip()]
        except GhError:
            orgs = []  # jeton sans « read:org » : on se limite au compte perso

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
                    # Un dépôt inaccessible ne doit pas faire échouer la collecte.
                    entry["error"] = str(exc)
            repos.append(entry)

        self._progress("Finalisation…", total, total)
        known = {user for r in repos for _, user in r["events"]}
        return {
            "generated_at": now_iso(),
            "login": login,
            "orgs": orgs,
            "repos": repos,
            "locations": {u: p for u, p in locations.items() if u in known},
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
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fetcher = Fetcher()

    if args.fetch_only:
        fetcher.start(force=args.refresh)
        while fetcher.status()["state"] == "running":
            time.sleep(0.4)
        status = fetcher.status()
        if status["error"]:
            print(f"Échec : {status['error']}", file=sys.stderr)
            return 1
        repos = [r for r in fetcher.data["repos"] if r["stars"] > 0]
        print(f"{sum(r['stars'] for r in repos)} étoiles sur {len(repos)} dépôts → {CACHE_FILE}")
        return 0

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
