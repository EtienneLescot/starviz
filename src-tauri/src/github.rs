//! Collecte via le CLI `gh` déjà authentifié.
//!
//! Deux différences assumées avec `starviz.py`, qui étaient ses deux vrais
//! défauts :
//!
//! 1. Les dépôts sont interrogés en parallèle. La collecte était séquentielle
//!    et passait l'essentiel de son temps à attendre le réseau — mesuré à
//!    ~41 s pour le seul dépôt le plus étoilé.
//! 2. Les erreurs transitoires sont réessayées. Un unique HTTP 504 au milieu
//!    d'une pagination de 22 pages faisait disparaître le dépôt le plus
//!    étoilé du tableau de bord, sans autre trace qu'un bandeau.

use crate::model::{Data, Event, GhRepo, Repo};
use futures::stream::{self, StreamExt};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Requêtes simultanées vers GitHub. Au-delà, on flirte avec les limites
/// secondaires — qui se traduisent par des blocages temporaires, bien plus
/// pénibles qu'une collecte deux secondes plus lente.
const CONCURRENCE: usize = 6;
const TENTATIVES: usize = 3;

const CHAMPS_REPO: &str = "nameWithOwner,name,description,stargazerCount,isFork,isPrivate,\
isArchived,createdAt,pushedAt,primaryLanguage,url";

const REQUETE_STARGAZERS: &str = r#"query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $endCursor, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login location } }
    }
  }
}"#;

const JQ_STARGAZERS: &str =
    r#".data.repository.stargazers.edges[] | "\(.starredAt)\t\(.node.login)\t\(.node.location // "")""#;

pub type Progress = Arc<dyn Fn(String, usize, usize) + Send + Sync>;

/// Une erreur qui a des chances de disparaître d'elle-même : on réessaie.
fn transitoire(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "http 500", "http 502", "http 503", "http 504", "timeout", "timed out", "connection",
        "temporarily", "eof",
    ]
    .iter()
    .any(|m| e.contains(m))
}

async fn run_gh(args: &[String]) -> Result<String, String> {
    let mut derniere = String::new();
    for essai in 0..TENTATIVES {
        if essai > 0 {
            // Palier court : ces 504 se dissipent en quelques secondes.
            tokio::time::sleep(std::time::Duration::from_secs(2 * essai as u64)).await;
        }
        let mut cmd = tokio::process::Command::new("gh");
        cmd.args(args);
        #[cfg(windows)]
        {
            // Sans ça, chaque appel fait clignoter une console : avec une
            // pagination de plusieurs dizaines de pages, c'est inutilisable.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            }
            Ok(out) => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                derniere = if err.is_empty() {
                    format!("gh a échoué (code {:?})", out.status.code())
                } else {
                    err
                };
                if !transitoire(&derniere) {
                    return Err(derniere);
                }
            }
            Err(e) => {
                return Err(format!("gh introuvable ou non exécutable : {e}"));
            }
        }
    }
    Err(derniere)
}

/// Évènements triés + localisations des profils.
///
/// GraphQL sert les deux d'un coup : l'équivalent REST demanderait une requête
/// supplémentaire par utilisateur pour connaître sa localisation.
async fn stargazers(full_name: &str) -> Result<(Vec<Event>, BTreeMap<String, String>), String> {
    let (owner, name) = full_name
        .split_once('/')
        .ok_or_else(|| "nom de dépôt invalide".to_string())?;
    let args: Vec<String> = vec![
        "api".into(),
        "graphql".into(),
        "--paginate".into(),
        "-f".into(),
        format!("owner={owner}"),
        "-f".into(),
        format!("name={name}"),
        "-f".into(),
        format!("query={REQUETE_STARGAZERS}"),
        "--jq".into(),
        JQ_STARGAZERS.into(),
    ];
    let sortie = run_gh(&args).await?;

    let mut events: Vec<Event> = Vec::new();
    let mut locations = BTreeMap::new();
    for ligne in sortie.lines() {
        if ligne.trim().is_empty() {
            continue;
        }
        let mut champs = ligne.splitn(3, '\t');
        let stamp = champs.next().unwrap_or("").to_string();
        let user = champs.next().unwrap_or("").to_string();
        let lieu = champs.next().unwrap_or("").trim().to_string();
        if !lieu.is_empty() {
            // Le champ est du texte libre : on borne pour ne pas faire enfler
            // le fichier avec des biographies déguisées en localisation.
            locations.insert(user.clone(), lieu.chars().take(80).collect());
        }
        events.push((stamp, user));
    }
    events.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((events, locations))
}

pub async fn collect(force: bool, precedent: Option<Data>, prog: Progress) -> Result<Data, String> {
    prog("Identification du compte…".into(), 0, 0);
    let login = run_gh(&[
        "api".into(),
        "user".into(),
        "--jq".into(),
        ".login".into(),
    ])
    .await?
    .trim()
    .to_string();

    let mut erreurs: Vec<String> = Vec::new();

    prog("Liste des organisations…".into(), 0, 0);
    let orgs: Vec<String> = match run_gh(&[
        "api".into(),
        "user/orgs".into(),
        "--paginate".into(),
        "--jq".into(),
        ".[].login".into(),
    ])
    .await
    {
        Ok(s) => s
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(e) => {
            // Un échec réseau ferait disparaître d'un coup tous les dépôts
            // d'organisation : on repart de la dernière liste connue.
            erreurs.push(format!("organisations : {e}"));
            precedent.as_ref().map(|d| d.orgs.clone()).unwrap_or_default()
        }
    };

    let mut bruts: Vec<GhRepo> = Vec::new();
    let mut vus: HashSet<String> = HashSet::new();
    for owner in std::iter::once(&login).chain(orgs.iter()) {
        prog(format!("Liste des dépôts de {owner}…"), 0, 0);
        // Sans argument, « gh repo list » couvre le compte authentifié
        // (dépôts privés inclus) ; avec argument, une organisation.
        let mut args: Vec<String> = vec!["repo".into(), "list".into()];
        if owner != &login {
            args.push(owner.clone());
        }
        args.extend([
            "--limit".into(),
            "1000".into(),
            "--json".into(),
            CHAMPS_REPO.into(),
        ]);
        match run_gh(&args).await {
            Ok(s) => {
                let brut = if s.trim().is_empty() { "[]" } else { s.trim() };
                let liste: Vec<GhRepo> = serde_json::from_str(brut)
                    .map_err(|e| format!("réponse de gh repo list illisible : {e}"))?;
                for r in liste {
                    if vus.insert(r.name_with_owner.clone()) {
                        bruts.push(r);
                    }
                }
            }
            Err(e) => erreurs.push(format!("dépôts de {owner} : {e}")),
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
            let res = stargazers(&full).await;
            let n = faits.fetch_add(1, Ordering::Relaxed) + 1;
            prog(format!("Étoiles de {full}…"), n, total);
            (i, res)
        }
    }))
    .buffer_unordered(CONCURRENCE)
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
