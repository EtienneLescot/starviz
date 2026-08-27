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

Tout se fait au même endroit, sous le graphe : les pastilles de légende (clic
pour afficher / masquer, « seul » au survol — ou `Alt`+clic — pour n'en garder
qu'une) et, juste en dessous, les raccourcis « Tous », « Aucun » et un par
compte ou organisation. Les lignes du tableau des dépôts reflètent la même
sélection et se cliquent aussi. La barre d'outils du graphe, elle, ne contient
que des options d'affichage.

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
- Les tables géographiques (`web/geo-data.js`) sont générées depuis la base ISO
  3166 du système : `python3 tools/gen_geo.py`.

## Désinstallation

```bash
rm ~/.local/share/applications/starviz.desktop
rm -rf ~/.cache/starviz
```

Puis retirez l'icône du dock (clic droit → « Retirer des favoris »).
