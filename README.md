# StarViz

Visualiseur de l'évolution des étoiles de vos dépôts GitHub — le vôtre et ceux
de vos organisations. Les données viennent de votre `gh` déjà authentifié ;
l'affichage est une petite application web servie en local.

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

- `starviz.py` interroge `gh` : `gh repo list` pour vos dépôts et ceux de vos
  organisations, puis l'API GraphQL pour les stargazers — celle-ci renvoie la
  date de mise en favori **et** la localisation du profil en une seule
  pagination, là où l'API REST demanderait une requête par utilisateur.
- Le résultat est mis en cache dans `~/.cache/starviz/data.json`. Une
  actualisation ne recharge que les dépôts dont le nombre d'étoiles a changé
  (quelques secondes) ; `Maj`+clic sur « Actualiser » force tout.
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
`XDG_DATA_HOME`. Si ce dossier est un dépôt git avec un remote, chaque relevé
est committé et poussé automatiquement :

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

```bash
crontab -e   # 0 */3 * * * /chemin/vers/starviz --trending >> $HOME/.cache/starviz/trending.log 2>&1
```

## Licence

MIT — voir [LICENSE](LICENSE).

## Désinstallation

```bash
rm ~/.local/share/applications/starviz.desktop
rm -rf ~/.cache/starviz
```

Puis retirez l'icône du dock (clic droit → « Retirer des favoris »).
