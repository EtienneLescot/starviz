//! Types du fichier `data.json`.
//!
//! Le format est celui écrit par `starviz.py` : le portage doit rester
//! interopérable avec lui, qui sert encore `--trending` et `--fetch-only`.
//! Toute divergence ici casserait silencieusement le relevé planifié.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Un évènement d'étoile : `[date ISO 8601, login]`.
pub type Event = (String, String);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub is_org: bool,
    pub description: String,
    pub stars: i64,
    pub fork: bool,
    pub private: bool,
    pub archived: bool,
    pub created_at: Option<String>,
    pub pushed_at: Option<String>,
    pub language: Option<String>,
    pub url: String,
    pub events: Vec<Event>,
    /// Présent uniquement si la collecte de ce dépôt a échoué.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Data {
    pub generated_at: String,
    pub login: String,
    pub orgs: Vec<String>,
    pub repos: Vec<Repo>,
    /// login -> localisation déclarée sur le profil.
    #[serde(default)]
    pub locations: BTreeMap<String, String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// État de l'authentification, replié dans le même sondage que la collecte
/// pour ne pas ajouter une seconde boucle côté front.
#[derive(Serialize, Clone, Debug)]
pub struct AuthStatus {
    pub connecte: bool,
    /// « oauth » (device flow), « gh » (jeton emprunté au CLI), « aucune ».
    pub source: &'static str,
    /// Faux quand aucune application OAuth n'est configurée à la compilation :
    /// le bouton de connexion n'a alors rien à appeler.
    pub device_flow_possible: bool,
    pub en_attente: bool,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub erreur: Option<String>,
    /// Secondes avant expiration du jeton, quand il en a une. Absent pour un
    /// jeton permanent, qui est ce que GitHub délivre sans `offline_access`.
    pub expire_dans: Option<i64>,
}

/// Ce que le front lit à chaque tour de `poll()`.
#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub state: &'static str, // idle | running | error
    pub message: String,
    pub done: usize,
    pub total: usize,
    pub error: Option<String>,
    pub generated_at: Option<String>,
    pub has_data: bool,
    pub auth: AuthStatus,
}

/// Un dépôt tel que GraphQL le renvoie. Les noms de champs sont ceux de
/// l'API ; ils coïncidaient déjà avec ceux de `gh repo list --json`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    pub name_with_owner: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub stargazer_count: Option<i64>,
    pub is_fork: Option<bool>,
    pub is_private: Option<bool>,
    pub is_archived: Option<bool>,
    pub created_at: Option<String>,
    pub pushed_at: Option<String>,
    pub primary_language: Option<GhLanguage>,
    pub url: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct GhLanguage {
    pub name: String,
}
