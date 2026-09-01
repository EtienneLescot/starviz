//! Lecture du journal des classements Trending.
//!
//! Rien n'est relevé ici : la collecte reste dans `starviz.py --trending`, sous
//! minuteur systemd, parce qu'elle demande un navigateur sans interface pour
//! les captures et qu'elle doit tourner même quand l'application est fermée.
//! Ce module ne fait que lire ce que ce relevé a écrit.
//!
//! Format d'une ligne de `trending.jsonl`, tel que `starviz.py` l'écrit :
//! `{"ts", "checked", "errors", "found":[{"scope","window","lang","entity",
//! "rank","total","shot"?}]}`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub fn fichier() -> PathBuf {
    crate::store::data_dir().join("trending.jsonl")
}

fn captures_dir() -> PathBuf {
    crate::store::data_dir().join("captures")
}

#[derive(Deserialize, Clone, Debug)]
struct Trouve {
    scope: String,
    window: String,
    lang: Option<String>,
    #[allow(dead_code)]
    entity: String,
    rank: i64,
    total: Option<i64>,
    shot: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct Releve {
    ts: String,
    #[serde(default)]
    found: Vec<Trouve>,
    /// Nombre de classements interroges. Sans lui, l'absence d'une case ne se
    /// distingue pas d'un classement jamais consulte.
    #[serde(default)]
    checked: usize,
}

/// Une case du classement, telle que l'écran l'affiche.
#[derive(Serialize, Clone, Debug)]
pub struct Ligne {
    pub scope: String,
    pub window: String,
    pub lang: Option<String>,
    /// Dernier rang connu, quelle qu'en soit la source. Une case quittee garde
    /// le sien : c'est `sortie` qui dit qu'il n'est plus d'actualite.
    pub rank: i64,
    /// Vrai quand la case n'est plus occupee au dernier releve.
    pub sortie: bool,
    pub total: Option<i64>,
    pub meilleur: i64,
    /// Écart avec le relevé précédent. Négatif = progression vers la première
    /// place. `None` quand la case vient d'apparaître.
    pub delta: Option<i64>,
    pub ts: String,
    pub shot: Option<String>,
    /// Capture qui atteste le meilleur rang, quand il y en a une.
    pub preuve: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Capture {
    pub fichier: String,
    pub taille: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Evenement {
    pub ts: String,
    pub texte: String,
    /// « entree », « sortie », « progression », « recul ».
    pub genre: &'static str,
}

#[derive(Serialize, Clone, Debug)]
pub struct Trending {
    pub disponible: bool,
    pub chemin: String,
    pub dernier_releve: Option<String>,
    pub nb_releves: usize,
    /// Classements consultes au dernier releve, et cases occupees.
    pub consultes: usize,
    pub occupes: usize,
    pub lignes: Vec<Ligne>,
    pub captures: Vec<Capture>,
    pub evenements: Vec<Evenement>,
}

/// Identifie une case du classement : portée × fenêtre × langage.
type Case = (String, String, Option<String>);

fn case(t: &Trouve) -> Case {
    (t.scope.clone(), t.window.clone(), t.lang.clone())
}

fn nom_case(c: &Case) -> String {
    let portee = if c.0 == "developer" { "développeurs" } else { "dépôts" };
    let fenetre = match c.1.as_str() {
        "daily" => "journalier",
        "weekly" => "hebdomadaire",
        "monthly" => "mensuel",
        autre => autre,
    };
    match &c.2 {
        Some(l) => format!("{portee} {fenetre}/{l}"),
        None => format!("{portee} {fenetre}"),
    }
}

/// Extrait d'un nom de capture la case et le rang qu'elle atteste.
///
/// Le releve les nomme `<horodatage>_<portee>_<fenetre>_<langage>_rang<N>.png`,
/// avec un suffixe `_wayback` pour celles reconstituees a posteriori.
fn depuis_capture(nom: &str) -> Option<(Case, i64)> {
    let base = nom.strip_suffix(".png").or_else(|| nom.strip_suffix(".PNG"))?;
    let base = base.strip_suffix("_wayback").unwrap_or(base);
    let (avant, rang) = base.rsplit_once("_rang")?;
    let rank: i64 = rang.parse().ok()?;
    let mut champs = avant.splitn(4, '_');
    let _horodatage = champs.next()?;
    let scope = champs.next()?.to_string();
    let window = champs.next()?.to_string();
    let langage = champs.next()?;
    let lang = (langage != "all").then(|| langage.to_string());
    Some(((scope, window, lang), rank))
}

pub fn lire() -> Trending {
    let chemin = fichier();
    let vide = Trending {
        disponible: false,
        chemin: chemin.display().to_string(),
        dernier_releve: None,
        nb_releves: 0,
        consultes: 0,
        occupes: 0,
        lignes: Vec::new(),
        captures: Vec::new(),
        evenements: Vec::new(),
    };

    let Ok(brut) = fs::read_to_string(&chemin) else {
        return vide;
    };
    let releves: Vec<Releve> = brut
        .lines()
        .filter(|l| !l.trim().is_empty())
        // Une ligne corrompue ne doit pas emporter tout le journal : le relevé
        // écrit en append, une écriture interrompue n'abîme que sa ligne.
        .filter_map(|l| serde_json::from_str::<Releve>(l).ok())
        .collect();
    if releves.is_empty() {
        return vide;
    }

    let dernier = releves.last().unwrap();

    // Meilleur rang jamais observé, case par case.
    let mut meilleurs: HashMap<Case, i64> = HashMap::new();
    for r in &releves {
        for t in &r.found {
            meilleurs
                .entry(case(t))
                .and_modify(|m| *m = (*m).min(t.rank))
                .or_insert(t.rank);
        }
    }

    let mut captures: Vec<Capture> = fs::read_dir(captures_dir())
        .map(|it| {
            it.filter_map(Result::ok)
                .filter(|e| {
                    e.path()
                        .extension()
                        .is_some_and(|x| x.eq_ignore_ascii_case("png"))
                })
                .map(|e| Capture {
                    fichier: e.file_name().to_string_lossy().into_owned(),
                    taille: e.metadata().map(|m| m.len()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    // Les noms commencent par l'horodatage : l'ordre décroissant met les plus
    // récentes en tête.
    captures.sort_by(|a, b| b.fichier.cmp(&a.fichier));

    // Une capture atteste un rang que le journal n'enregistre pas forcément :
    // les toutes premières ont été reconstituées depuis Wayback, avant que le
    // relevé n'existe. C'est une preuve, elle a sa place dans le tableau.
    let mut preuves: HashMap<Case, (i64, String)> = HashMap::new();
    for c in &captures {
        let Some((cas, rang)) = depuis_capture(&c.fichier) else { continue };
        preuves
            .entry(cas)
            .and_modify(|(m, f)| {
                if rang < *m {
                    *m = rang;
                    *f = c.fichier.clone();
                }
            })
            .or_insert((rang, c.fichier.clone()));
    }

    // Dernier rang vu dans le journal, avec son total, meme si la case a ete
    // quittee depuis : une sortie ne doit pas effacer le rang atteint.
    let mut dernier_connu: HashMap<Case, (i64, Option<i64>)> = HashMap::new();
    for r in &releves {
        for t in &r.found {
            dernier_connu.insert(case(t), (t.rank, t.total));
        }
    }

    // Taille d'un classement, par portee. Les pages Trending en listent un
    // nombre constant ; une capture n'enregistre que le rang, pas le total, et
    // c'est la seule facon honnete de le retrouver.
    let mut taille_par_portee: HashMap<String, i64> = HashMap::new();
    for r in &releves {
        for t in &r.found {
            if let Some(n) = t.total {
                taille_par_portee.entry(t.scope.clone()).or_insert(n);
            }
        }
    }

    let precedent: HashMap<Case, i64> = if releves.len() >= 2 {
        releves[releves.len() - 2]
            .found
            .iter()
            .map(|t| (case(t), t.rank))
            .collect()
    } else {
        HashMap::new()
    };

    // On liste toutes les cases jamais occupees, pas seulement celles du
    // dernier releve : sortir d'un classement est une information, et le
    // meilleur rang merite de survivre a la sortie.
    let actuels: HashMap<Case, &Trouve> = dernier.found.iter().map(|t| (case(t), t)).collect();
    let cas: std::collections::BTreeSet<Case> =
        meilleurs.keys().chain(preuves.keys()).cloned().collect();
    let mut lignes: Vec<Ligne> = cas
        .into_iter()
        .map(|c| {
            let courant = actuels.get(&c);
            let du_journal = meilleurs.get(&c).copied();
            let de_capture = preuves.get(&c);
            // Le meilleur rang est le plus haut des deux sources.
            let meilleur = match (du_journal, de_capture) {
                (Some(j), Some((p, _))) => j.min(*p),
                (Some(j), None) => j,
                (None, Some((p, _))) => *p,
                (None, None) => return None,
            };
            // Le rang affiche est le dernier connu, du releve courant s'il y
            // figure, sinon du journal, sinon de la capture qui l'atteste.
            let (rank, total) = match courant {
                Some(t) => (t.rank, t.total),
                None => match dernier_connu.get(&c) {
                    Some((r, t)) => (*r, *t),
                    None => (
                        de_capture.map(|(r, _)| *r)?,
                        taille_par_portee.get(&c.0).copied(),
                    ),
                },
            };
            Some(Ligne {
                scope: c.0.clone(),
                window: c.1.clone(),
                lang: c.2.clone(),
                rank,
                sortie: courant.is_none(),
                total,
                meilleur,
                delta: courant
                    .zip(precedent.get(&c))
                    .map(|(t, avant)| t.rank - avant),
                ts: dernier.ts.clone(),
                shot: courant.and_then(|t| t.shot.clone()),
                preuve: de_capture
                    .filter(|(p, _)| Some(*p) == Some(meilleur))
                    .map(|(_, f)| f.clone()),
            })
        })
        .flatten()
        .collect();
    // Les cases occupees d'abord, par rang ; les sorties ensuite.
    // Du meilleur rang jamais atteint au moins bon : c'est le palmares, pas
    // l'etat courant. A egalite, le rang du jour departage.
    lignes.sort_by_key(|l| (l.meilleur, l.rank));

    // Journal : on remonte les relevés deux à deux, du plus récent au plus
    // ancien, et on ne retient que ce qui a bougé — un relevé toutes les
    // trois heures produirait sinon des centaines de lignes identiques.
    let mut evenements = Vec::new();
    for paire in releves.windows(2).rev() {
        let (avant, apres) = (&paire[0], &paire[1]);
        let rangs_avant: HashMap<Case, i64> =
            avant.found.iter().map(|t| (case(t), t.rank)).collect();
        let rangs_apres: HashMap<Case, i64> =
            apres.found.iter().map(|t| (case(t), t.rank)).collect();

        for (c, rang) in &rangs_apres {
            match rangs_avant.get(c) {
                None => evenements.push(Evenement {
                    ts: apres.ts.clone(),
                    texte: format!("{} — entrée au #{rang}", nom_case(c)),
                    genre: "entree",
                }),
                Some(ancien) if ancien != rang => evenements.push(Evenement {
                    ts: apres.ts.clone(),
                    texte: format!("{} — #{ancien} → #{rang}", nom_case(c)),
                    genre: if rang < ancien { "progression" } else { "recul" },
                }),
                _ => {}
            }
        }
        for c in rangs_avant.keys() {
            if !rangs_apres.contains_key(c) {
                evenements.push(Evenement {
                    ts: apres.ts.clone(),
                    texte: format!("{} — sorti du classement", nom_case(c)),
                    genre: "sortie",
                });
            }
        }
        if evenements.len() >= 60 {
            break;
        }
    }

    captures.truncate(24);
    Trending {
        disponible: true,
        chemin: chemin.display().to_string(),
        dernier_releve: Some(dernier.ts.clone()),
        nb_releves: releves.len(),
        consultes: dernier.checked,
        occupes: dernier.found.len(),
        lignes,
        captures,
        evenements,
    }
}

/// Rend une capture sous forme de `data:` URI.
///
/// Les captures vivent dans `XDG_DATA_HOME`, hors des ressources embarquees :
/// le protocole `asset:` demanderait une portee declaree par chemin, or
/// celui-ci depend du dossier personnel. Un `data:` URI passe par la CSP
/// existante, qui autorise deja `data:` pour les images.
pub fn capture(fichier: &str) -> Result<String, String> {
    use base64::Engine;
    // Le nom vient de l'interface : on refuse tout ce qui pourrait sortir du
    // dossier des captures.
    if fichier.is_empty()
        || fichier.contains('/')
        || fichier.contains('\\')
        || fichier.contains("..")
        || !fichier.to_ascii_lowercase().ends_with(".png")
    {
        return Err(format!("nom de capture invalide : {fichier}"));
    }
    let chemin = captures_dir().join(fichier);
    let octets = fs::read(&chemin).map_err(|e| format!("lecture de {} : {e}", chemin.display()))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(octets)
    ))
}
