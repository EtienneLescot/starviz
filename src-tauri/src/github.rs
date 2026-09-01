//! Collecte des dépôts et de leurs stargazers.
//!
//! Trois différences assumées avec `starviz.py`, dont les deux premières
//! étaient ses vrais défauts :
//!
//! 1. Les dépôts sont interrogés en parallèle. La collecte était séquentielle
//!    et passait l'essentiel de son temps à attendre le réseau — mesuré à
//!    ~41 s pour le seul dépôt le plus étoilé.
//! 2. Les erreurs transitoires sont réessayées. Un unique HTTP 504 au milieu
//!    d'une pagination de 22 pages faisait disparaître le dépôt le plus
//!    étoilé du tableau de bord, sans autre trace qu'un bandeau.
//! 3. L'API est appelée directement, sans passer par `gh`.

use crate::api::Client;
use crate::model::{Data, Event, GhRepo, Repo};
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Les champs d'un dépôt, identiques à ceux que demandait `gh repo list` :
/// le format de `data.json` doit rester lisible par `starviz.py`.
const CHAMPS_REPO: &str = "nameWithOwner name description stargazerCount isFork \
isPrivate isArchived createdAt pushedAt primaryLanguage { name } url";

const REQ_VIEWER: &str = "query { viewer { login } }";

const REQ_ORGS: &str = "query($endCursor: String) {
  viewer {
    organizations(first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { login }
    }
  }
}";

const REQ_STARGAZERS: &str = "query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $endCursor, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login location } }
    }
  }
}";

pub type Progress = Arc<dyn Fn(String, usize, usize) + Send + Sync>;

#[derive(Deserialize)]
struct Org {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArcStargazer {
    starred_at: String,
    node: Option<ProfilStargazer>,
}

#[derive(Deserialize)]
struct ProfilStargazer {
    login: String,
    location: Option<String>,
}

/// Évènements triés + localisations des profils.
///
/// GraphQL sert les deux d'un coup : l'équivalent REST demanderait une requête
/// supplémentaire par utilisateur pour connaître sa localisation.
async fn stargazers(
    client: &Client,
    full_name: &str,
) -> Result<(Vec<Event>, BTreeMap<String, String>), String> {
    let (owner, name) = full_name
        .split_once('/')
        .ok_or_else(|| "nom de dépôt invalide".to_string())?;
    let arcs: Vec<ArcStargazer> = client
        .graphql_paginee(
            REQ_STARGAZERS,
            json!({ "owner": owner, "name": name }),
            &["repository", "stargazers"],
            "edges",
        )
        .await?;

    let mut events: Vec<Event> = Vec::with_capacity(arcs.len());
    let mut locations = BTreeMap::new();
    for arc in arcs {
        // Un compte supprimé entre-temps laisse une étoile sans profil : elle
        // compte quand même dans la courbe.
        let Some(profil) = arc.node else { continue };
        if let Some(lieu) = profil.location.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            // Le champ est du texte libre : on borne pour ne pas faire enfler
            // le fichier avec des biographies déguisées en localisation.
            locations.insert(profil.login.clone(), lieu.chars().take(80).collect());
        }
        events.push((arc.starred_at, profil.login));
    }
    events.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((events, locations))
}

async fn depots_du_compte(client: &Client) -> Result<Vec<GhRepo>, String> {
    // `ownerAffiliations: [OWNER]` reproduit `gh repo list` sans argument :
    // les dépôts possédés, privés compris, sans ceux où l'on est simple
    // collaborateur.
    let requete = format!(
        "query($endCursor: String) {{
  viewer {{
    repositories(first: 100, after: $endCursor, ownerAffiliations: [OWNER],
                 orderBy: {{field: STARGAZERS, direction: DESC}}) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{ {CHAMPS_REPO} }}
    }}
  }}
}}"
    );
    client
        .graphql_paginee(&requete, json!({}), &["viewer", "repositories"], "nodes")
        .await
}

async fn depots_de_lorg(client: &Client, org: &str) -> Result<Vec<GhRepo>, String> {
    let requete = format!(
        "query($org: String!, $endCursor: String) {{
  organization(login: $org) {{
    repositories(first: 100, after: $endCursor,
                 orderBy: {{field: STARGAZERS, direction: DESC}}) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{ {CHAMPS_REPO} }}
    }}
  }}
}}"
    );
    client
        .graphql_paginee(
            &requete,
            json!({ "org": org }),
            &["organization", "repositories"],
            "nodes",
        )
        .await
}

pub async fn collect(
    jeton: String,
    force: bool,
    precedent: Option<Data>,
    prog: Progress,
    reglages: crate::settings::Settings,
) -> Result<Data, String> {
    let client = Arc::new(Client::new(jeton, reglages.tentatives)?);
    // Concurrence réglable : au-delà d'une douzaine de requêtes simultanées on
    // heurte les limites secondaires de GitHub, dont les blocages temporaires
    // coûtent bien plus que les secondes gagnées. Le bornage est dans
    // `settings::Settings::borner`.
    let concurrence = reglages.concurrence.max(1);

    prog("Identification du compte…".into(), 0, 0);
    let login = client
        .graphql(REQ_VIEWER, json!({}))
        .await?
        .pointer("/data/viewer/login")
        .and_then(|v| v.as_str())
        .ok_or("GitHub n'a pas renvoyé de compte")?
        .to_string();

    let mut erreurs: Vec<String> = Vec::new();

    prog("Liste des organisations…".into(), 0, 0);
    let orgs: Vec<String> = match client
        .graphql_paginee::<Org>(REQ_ORGS, json!({}), &["viewer", "organizations"], "nodes")
        .await
    {
        Ok(v) => v.into_iter().map(|o| o.login).collect(),
        Err(e) => {
            // Un échec réseau ferait disparaître d'un coup tous les dépôts
            // d'organisation : on repart de la dernière liste connue.
            erreurs.push(format!("organisations : {e}"));
            precedent.as_ref().map(|d| d.orgs.clone()).unwrap_or_default()
        }
    };

    let mut bruts: Vec<GhRepo> = Vec::new();
    let mut vus: HashSet<String> = HashSet::new();

    prog(format!("Liste des dépôts de {login}…"), 0, 0);
    match depots_du_compte(&client).await {
        Ok(liste) => {
            for r in liste {
                if vus.insert(r.name_with_owner.clone()) {
                    bruts.push(r);
                }
            }
        }
        Err(e) => erreurs.push(format!("dépôts de {login} : {e}")),
    }
    for org in &orgs {
        prog(format!("Liste des dépôts de {org}…"), 0, 0);
        match depots_de_lorg(&client, org).await {
            Ok(liste) => {
                for r in liste {
                    if vus.insert(r.name_with_owner.clone()) {
                        bruts.push(r);
                    }
                }
            }
            Err(e) => erreurs.push(format!("dépôts de {org} : {e}")),
        }
    }

    let ancien: BTreeMap<String, Repo> = precedent
        .as_ref()
        .map(|d| {
            d.repos
                .iter()
                .map(|r| (r.full_name.clone(), r.clone()))
                .collect()
        })
        .unwrap_or_default();

    bruts.sort_by_key(|r| -r.stargazer_count.unwrap_or(0));

    let mut fiches: Vec<Repo> = Vec::new();
    for r in &bruts {
        let full = r.name_with_owner.clone();
        let owner = full.split('/').next().unwrap_or("").to_string();
        fiches.push(Repo {
            name: r
                .name
                .clone()
                .unwrap_or_else(|| full.rsplit('/').next().unwrap_or(&full).to_string()),
            is_org: !owner.eq_ignore_ascii_case(&login),
            owner,
            description: r.description.clone().unwrap_or_default(),
            stars: r.stargazer_count.unwrap_or(0),
            fork: r.is_fork.unwrap_or(false),
            private: r.is_private.unwrap_or(false),
            archived: r.is_archived.unwrap_or(false),
            created_at: r.created_at.clone(),
            pushed_at: r.pushed_at.clone(),
            language: r.primary_language.as_ref().map(|l| l.name.clone()),
            url: r
                .url
                .clone()
                .unwrap_or_else(|| format!("https://github.com/{full}")),
            events: Vec::new(),
            error: None,
            full_name: full,
        });
    }

    // Seuls les dépôts étoilés valent une pagination GraphQL.
    let a_traiter: Vec<usize> = fiches
        .iter()
        .enumerate()
        .filter(|(_, f)| f.stars > 0)
        .map(|(i, _)| i)
        .collect();
    let total = a_traiter.len();
    let faits = Arc::new(AtomicUsize::new(0));

    let taches = stream::iter(a_traiter.into_iter().map(|i| {
        let full = fiches[i].full_name.clone();
        let stars = fiches[i].stars;
        let cache = ancien.get(&full).cloned();
        let prog = prog.clone();
        let faits = faits.clone();
        let client = client.clone();
        async move {
            // On ne repagine que ce qui a bougé : le nombre d'étoiles fait
            // office d'empreinte. Une fiche sans évènements n'est jamais
            // réutilisée — c'est ce qui rattrape une collecte échouée.
            let reutilisable = !force
                && cache
                    .as_ref()
                    .is_some_and(|c| c.stars == stars && !c.events.is_empty());
            if reutilisable {
                let events = cache.map(|c| c.events).unwrap_or_default();
                let n = faits.fetch_add(1, Ordering::Relaxed) + 1;
                prog(format!("{full} inchangé"), n, total);
                return (i, Ok((events, BTreeMap::new())));
            }
            prog(
                format!("Étoiles de {full}…"),
                faits.load(Ordering::Relaxed),
                total,
            );
            let res = stargazers(&client, &full).await;
            let n = faits.fetch_add(1, Ordering::Relaxed) + 1;
            prog(format!("Étoiles de {full}…"), n, total);
            (i, res)
        }
    }))
    .buffer_unordered(concurrence)
    .collect::<Vec<_>>()
    .await;

    let mut locations: BTreeMap<String, String> = precedent
        .as_ref()
        .map(|d| d.locations.clone())
        .unwrap_or_default();

    for (i, res) in taches {
        match res {
            Ok((events, lieux)) => {
                fiches[i].events = events;
                locations.extend(lieux);
            }
            Err(e) => {
                // Un dépôt inaccessible ne doit ni faire échouer la collecte,
                // ni disparaître de l'affichage : on conserve l'existant.
                let full = fiches[i].full_name.clone();
                fiches[i].events = ancien
                    .get(&full)
                    .map(|c| c.events.clone())
                    .unwrap_or_default();
                fiches[i].error = Some(e.clone());
                erreurs.push(format!("{full} : {e}"));
            }
        }
    }

    prog("Finalisation…".into(), total, total);
    let connus: HashSet<String> = fiches
        .iter()
        .flat_map(|r| r.events.iter().map(|(_, u)| u.clone()))
        .collect();
    locations.retain(|u, _| connus.contains(u));

    Ok(Data {
        generated_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        login,
        orgs,
        repos: fiches,
        locations,
        errors: erreurs,
    })
}
