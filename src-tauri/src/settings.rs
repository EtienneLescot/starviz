//! Réglages persistés, et informations d'état pour l'écran Réglages.
//!
//! Ils vivent dans `XDG_CONFIG_HOME` et non dans `XDG_DATA_HOME` : l'historique
//! des étoiles est irremplaçable, une préférence se rétablit d'un clic. Les
//! mélanger inviterait à sauvegarder l'un en croyant sauvegarder l'autre.
//!
//! Seuls figurent ici les réglages qui changent le comportement du collecteur.
//! Le thème, l'écran courant et l'état du rail restent côté interface, dans son
//! `localStorage` : les dupliquer ferait deux sources de vérité pour rien.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Bornes de la concurrence. Au-delà d'une douzaine de requêtes simultanées on
/// heurte les limites secondaires de GitHub, dont les blocages temporaires
/// coûtent bien plus que les secondes gagnées.
const CONCURRENCE_MIN: usize = 1;
const CONCURRENCE_MAX: usize = 12;
const TENTATIVES_MIN: usize = 1;
const TENTATIVES_MAX: usize = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Dépôts interrogés simultanément.
    pub concurrence: usize,
    /// Tentatives avant d'abandonner un dépôt sur erreur transitoire.
    pub tentatives: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            concurrence: 6,
            tentatives: 3,
        }
    }
}

impl Settings {
    /// Ramène les valeurs dans leurs bornes. Un fichier édité à la main ne doit
    /// pas pouvoir lancer cent requêtes simultanées.
    pub fn borner(mut self) -> Self {
        self.concurrence = self.concurrence.clamp(CONCURRENCE_MIN, CONCURRENCE_MAX);
        self.tentatives = self.tentatives.clamp(TENTATIVES_MIN, TENTATIVES_MAX);
        self
    }
}

pub fn config_dir() -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v).join("starviz"),
        _ => dirs::home_dir()
            .unwrap_or_default()
            .join(".config")
            .join("starviz"),
    }
}

pub fn config_file() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn read() -> Settings {
    fs::read_to_string(config_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
        .borner()
}

pub fn write(reglages: &Settings) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} : {e}", dir.display()))?;
    let corps = serde_json::to_vec_pretty(reglages).map_err(|e| format!("sérialisation : {e}"))?;
    fs::write(config_file(), corps).map_err(|e| format!("écriture : {e}"))
}

/// Ce que l'écran Réglages affiche sans pouvoir le modifier : des faits sur
/// l'installation, pas des préférences.
#[derive(Serialize, Clone, Debug)]
pub struct Infos {
    pub version: String,
    pub plateforme: &'static str,
    pub chemin_donnees: String,
    pub taille_donnees: u64,
    pub chemin_config: String,
    pub chemin_captures: String,
    pub nb_captures: usize,
    pub trending_present: bool,
    /// Le relevé Trending et son minuteur sont pilotés par `starviz.py` sous
    /// systemd : depuis l'application, ils s'observent mais ne se règlent pas.
    pub trending_pilote_par: &'static str,
}

pub fn infos() -> Infos {
    let donnees = crate::store::data_file();
    let captures = crate::store::data_dir().join("captures");
    let nb_captures = fs::read_dir(&captures)
        .map(|it| {
            it.filter_map(Result::ok)
                .filter(|e| {
                    e.path()
                        .extension()
                        .is_some_and(|x| x.eq_ignore_ascii_case("png"))
                })
                .count()
        })
        .unwrap_or(0);

    Infos {
        version: env!("CARGO_PKG_VERSION").to_string(),
        plateforme: std::env::consts::OS,
        taille_donnees: fs::metadata(&donnees).map(|m| m.len()).unwrap_or(0),
        chemin_donnees: donnees.display().to_string(),
        chemin_config: config_file().display().to_string(),
        trending_present: crate::trending::fichier().exists(),
        chemin_captures: captures.display().to_string(),
        nb_captures,
        trending_pilote_par: "starviz.py --trending (minuteur systemd)",
    }
}

/// Ouvre un dossier dans le gestionnaire de fichiers du système.
///
/// On appelle directement la commande de la plateforme plutôt que le greffon
/// `opener` : sa portée se déclare par chemin, et celui-ci dépend du dossier
/// personnel, donc de la machine.
pub fn ouvrir_dossier(chemin: &std::path::Path) -> Result<(), String> {
    let (programme, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        ("explorer", vec![])
    } else if cfg!(target_os = "macos") {
        ("open", vec![])
    } else {
        ("xdg-open", vec![])
    };
    let mut cmd = std::process::Command::new(programme);
    cmd.args(args).arg(chemin);
    // `explorer` renvoie un code non nul même quand il a bien ouvert la
    // fenêtre : on se contente d'avoir pu lancer le processus.
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("ouverture de {} : {e}", chemin.display()))
}
