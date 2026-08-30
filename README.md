# StarViz

Visualiseur de l'évolution des étoiles de vos dépôts GitHub — le vôtre et ceux
de vos organisations. Les données viennent de votre `gh` déjà authentifié ;
l'affichage se fait soit dans une application desktop, soit dans une petite
application web servie en local.

![lancement](web/icon.svg)

## Installation

```bash
./install.sh
```

Le script crée `~/.local/share/applications/starviz.desktop` et épingle
l'icône au dock GNOME. Un clic dessus démarre le serveur local et ouvre le
navigateur ; un second clic réutilise l'instance déjà lancée.

Prérequis : `python3`, et `gh` authentifié (`gh auth login`). Aucune dépendance
Python ou JavaScript à installer. Si vous déplacez ce dossier, relancez
`./install.sh` : le raccourci pointe vers un chemin absolu.

## Application desktop

Une seconde façon de lancer StarViz, à côté du serveur local : une application
native bâtie avec Tauri. Elle affiche exactement la même interface — `web/` est
partagé, pas dupliqué — mais la collecte passe par un backend Rust plutôt que
par le serveur Python.

```bash
npm install
npm run dev      # lance l'application (longue compilation au premier passage)
npm run build    # produit l'installeur dans src-tauri/target/release/bundle/
```

Ce qu'elle apporte :

- **Zone de notification** : fermer la fenêtre la replie au lieu de quitter ;
  le menu du tray permet d'actualiser ou de quitter pour de bon.
- **Collecte parallèle** : six dépôts interrogés de front au lieu d'une file
  d'attente. La collecte est presque entièrement de l'attente réseau — le
  dépôt le plus étoilé mobilisait à lui seul une quarantaine de secondes.
- **Reprise sur erreur transitoire** : les HTTP 5xx sont réessayés trois fois.
  Auparavant un seul 504 au milieu d'une pagination suffisait à faire
  disparaître le dépôt concerné de l'affichage, du graphe et de la géographie.
- Plus de serveur HTTP, de jeton, ni d'extinction par inactivité : le front
  parle au backend par IPC.

Les deux chemins coexistent et lisent le même
`~/.local/share/starviz/data.json` : `starviz.py` reste nécessaire pour
`--trending` et pour le relevé planifié `--fetch-only`.

### Connexion à GitHub

L'application n'appelle plus `gh` : elle interroge l'API directement, avec un
jeton obtenu par *device flow* — le flux OAuth qui ne demande ni serveur de
redirection ni secret client. Au premier lancement, StarViz affiche un code
court à saisir sur github.com, puis range le jeton dans le gestionnaire
d'identifiants du système (Credential Manager, Trousseau, Secret Service).

À défaut de jeton propre, StarViz emprunte celui de `gh` s'il est installé et
authentifié. La dépendance passe donc d'obligatoire à commode : elle rend le
premier lancement transparent pour qui a déjà `gh`, sans l'imposer aux autres.

Le `client_id` de l'application OAuth est inscrit dans les sources. Ce n'est
pas un secret : il figure en clair dans toute application de bureau utilisant
ce flux, et ne donne accès à rien sans validation explicite sur github.com.
Une compilation depuis les sources se connecte donc sans configuration.

Pour pointer une autre application le temps d'un essai :

```bash
STARVIZ_CLIENT_ID=Ov23li... npm run dev
```

Les portées demandées sont `repo` et `read:org` : la première pour voir les
dépôts privés dans la liste, la seconde pour énumérer les organisations.
L'application OAuth a **Enable Device Flow** activé et l'expiration des jetons
désactivée — StarViz ne gère pas encore le `refresh_token`.

Quand le jeton vient de `gh`, un bouton **Connecter GitHub** apparaît dans la
barre du haut : c'est le chemin pour passer à un jeton propre. **Déconnexion**
n'apparaît que pour un jeton OAuth, `gh` n'étant pas déconnectable depuis
l'application.

Compilation : Rust stable, plus WebView2 sous Windows (fourni avec Windows 11).
Le code ne contient rien de spécifique à une plateforme, mais **seule la cible
Windows a été construite et testée à ce jour**.

## Ce que montre l'application

- **Courbes cumulées** par dépôt, plus une courbe **Total** en pointillés.
- **Cadence** : histogramme empilé des étoiles gagnées, au pas choisi
  (automatique, jour, semaine ou mois).
- **Par âge** : toutes les courbes ramenées à leur première étoile, pour comparer
  des dépôts lancés à des dates différentes.
- Échelle **linéaire ou logarithmique** (utile quand un dépôt écrase les autres).
- **Indicateurs** : total, 7 jours, 30 jours, meilleure journée, dernière étoile.
- **Géographie des stargazers** : répartition par continent et top pays, déduite
  du champ « location » des profils (texte libre, environ 40 % des profils le
  renseignent ; ~91 % de ces valeurs sont rattachées à un pays).
- **Derniers stargazers** avec avatars, dépôt et localisation.

### Une seule sélection

Il n'y a qu'une sélection de dépôts, et elle pilote tout : indicateurs, graphe,
géographie et derniers stargazers. Chaque panneau rappelle son périmètre dans
son titre, et la sélection est mémorisée d'une session à l'autre.

Elle se fait dans un seul panneau, « Dépôts » : un clic sur une ligne n'affiche
que ce dépôt (un second clic rétablit tout), un clic sur sa pastille de couleur
l'ajoute ou le retire, et la barre du bas offre les raccourcis « Tous »,
« Aucun » et un par compte ou organisation.

La légende sous le graphe est une simple clé de couleurs — elle liste ce qui est
tracé et ne se clique pas. La barre d'outils du graphe ne contient que des
options d'affichage.

Raccourcis : `r` actualise, `Maj+r` ignore le cache, `Échap` réaffiche tous les
dépôts.

## Utilisation en ligne de commande

```bash
./starviz                 # démarre et ouvre le navigateur
./starviz --refresh       # force une collecte complète au démarrage
./starviz --fetch-only    # met à jour le cache puis quitte (utile en tâche planifiée)
./starviz --no-browser --port 8000
```

## Fonctionnement

- `starviz.py` interroge `gh` ; l'application desktop interroge l'API
  directement. Dans les deux cas, les dépôts viennent de `repo list` (le vôtre
  et ceux de vos organisations) et les stargazers de l'API GraphQL — celle-ci
  renvoie la date de mise en favori **et** la localisation du profil en une
  seule pagination, là où l'API REST demanderait une requête par utilisateur.
- Le résultat est conservé dans `~/.local/share/starviz/data.json`. Une
  actualisation ne recharge que les dépôts dont le nombre d'étoiles a changé
  (quelques secondes) ; `Maj`+clic sur « Actualiser » force tout. Cet
  historique n'est pas un cache : reconstruit depuis l'API, il devient
  irrécupérable si un dépôt disparaît.
- Le serveur n'écoute que sur `127.0.0.1`, protège son API par un jeton
  aléatoire régénéré à chaque démarrage, et s'arrête tout seul trois minutes
  après la fermeture de l'onglet.
- Les tables géographiques (`web/geo-data.js`) sont versionnées ; les
  regénérer est optionnel et demande le paquet `iso-codes` (Debian/Ubuntu) :
  `python3 tools/gen_geo.py`.

## Relevé des classements « Trending »

GitHub ne notifie pas les passages dans ses classements Trending, n'expose
aucune API pour les lire, et les archives publiques ne couvrent que la fenêtre
journalière — un passage hebdomadaire ou mensuel ne laisse donc aucune trace.

```bash
./starviz --trending
```

relève votre position dans les classements (développeurs et dépôts ×
journalier, hebdomadaire, mensuel × sans filtre et par langage), l'ajoute à
`~/.local/share/starviz/trending.jsonl` en rappelant le meilleur rang déjà
observé, et **photographie la page à chaque changement de rang** dans
`~/.local/share/starviz/captures/`.

Ces données ne vivent pas dans le cache — qui est jetable — mais dans
`XDG_DATA_HOME`. Si ce dossier est un dépôt git avec un remote, elles y sont
committées et poussées automatiquement.

Un relevé a lieu toutes les 3 heures et modifie toujours quelque chose : une
ligne de journal, quelques étoiles de plus. Committer à chaque passage
noierait l'historique sous des dizaines de commits vides. Le commit n'a donc
lieu que sur un **évènement** — rang qui bouge, dépôt qui entre ou sort d'un
classement, nouvelle capture — le message le résumant (`Classements :
weekly/typescript #5→#3, monthly/tous sorti`). À défaut d'évènement, un
**commit quotidien** garantit que rien ne reste plus de 20 h hors du dépôt
distant.

```bash
cd ~/.local/share/starviz && git init -b main
gh repo create starviz-data --private --source=. --remote=origin --push
```

Les langages surveillés sont déduits de vos dépôts les mieux étoilés. C'est
loin d'être un détail : un classement filtré est bien plus accessible que le
classement général — on peut être 13ᵉ toutes langues confondues et 5ᵉ en
TypeScript le même jour.

Les captures passent par un navigateur sans interface (`chromium` ou
équivalent). Sur Ubuntu, les navigateurs étant des snaps, ils ne peuvent pas
écrire dans un dossier caché : l'image est donc écrite dans
`~/starviz-shot-tmp` puis déplacée. `--no-shots` désactive cette étape.

Un relevé toutes les 3 heures suffit à ne pas rater un pic : le classement est
recalculé en continu, et une position peut passer de la 15ᵉ à la 1ʳᵉ place en
une demi-journée.

Un minuteur systemd est préférable à cron ici : `Persistent=true` rattrape le
relevé manqué quand la machine était éteinte à l'heure prévue, ce que cron ne
fait pas.

```ini
# ~/.config/systemd/user/starviz-trending.timer
[Timer]
OnCalendar=*-*-* 00/3:00:00
Persistent=true
RandomizedDelaySec=300
```

Le service exécute `starviz --fetch-only --trending` : il met à jour
l'historique des étoiles **et** relève les classements en une passe.

```bash
systemctl --user enable --now starviz-trending.timer
loginctl enable-linger "$USER"   # relevés même sans session ouverte
```

## Licence

MIT — voir [LICENSE](LICENSE).

## Désinstallation

```bash
rm ~/.local/share/applications/starviz.desktop
rm -rf ~/.cache/starviz
```

Puis retirez l'icône du dock (clic droit → « Retirer des favoris »).
