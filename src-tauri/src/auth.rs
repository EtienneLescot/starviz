//! Authentification GitHub par *device flow*, et conservation du jeton.
//!
//! Le device flow est le seul des flux OAuth qui ne demande ni serveur de
//! redirection ni secret client : l'application affiche un code court, la
//! personne le saisit sur github.com, et l'application récupère un jeton en
//! interrogeant GitHub. C'est ce qui permet de distribuer StarViz sans exiger
//! que `gh` soit installé et authentifié au préalable.
//!
//! Le `client_id` d'une application OAuth n'est pas un secret — il figure en
//! clair dans toutes les applications de bureau utilisant ce flux.

use serde::Deserialize;
use std::time::Duration;

const SERVICE: &str = "fr.etiennelescot.starviz";
const COMPTE: &str = "github-oauth";

/// Portées demandées. `repo` est nécessaire pour voir les dépôts privés dans
/// la liste ; sans lui, seuls les publics remonteraient. `read:org` sert à
/// énumérer les organisations.
pub const PORTEES: &str = "repo read:org";

/// Application OAuth « starviz ».
///
/// Un `client_id` n'est pas un secret : il figure en clair dans toute
/// application de bureau utilisant ce flux, et ne donne accès à rien sans la
/// validation explicite de la personne sur github.com. Il a donc sa place
/// dans le dépôt : sans lui, une compilation depuis les sources n'aurait
/// aucun moyen de se connecter.
const CLIENT_ID: &str = "Ov23li0kSWjV2b17Eypa";

/// Surchargeable par `STARVIZ_CLIENT_ID`, pour pointer une autre application
/// OAuth le temps d'un essai.
pub fn client_id() -> Option<String> {
    let brut = std::env::var("STARVIZ_CLIENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| CLIENT_ID.to_string());
    let brut = brut.trim().to_string();
    if brut.is_empty() {
        None
    } else {
        Some(brut)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Attente {
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip)]
    pub device_code: String,
    #[serde(skip)]
    pub interval: u64,
    #[serde(skip)]
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct ReponseCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct ReponseJeton {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

/// Encode un corps `application/x-www-form-urlencoded`.
///
/// reqwest 0.13 n'expose plus `.form()` par défaut ; l'écrire ici évite de
/// dépendre du nommage de ses features.
fn formulaire(champs: &[(&str, &str)]) -> String {
    champs
        .iter()
        .map(|(cle, valeur)| format!("{}={}", urlencoding::encode(cle), urlencoding::encode(valeur)))
        .collect::<Vec<_>>()
        .join("&")
}

fn client_http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("starviz")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client HTTP : {e}"))
}

/// Première étape : demander un code à faire saisir par la personne.
pub async fn demarrer(client_id: &str) -> Result<Attente, String> {
    let http = client_http()?;
    let resp = http
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(formulaire(&[("client_id", client_id), ("scope", PORTEES)]))
        .send()
        .await
        .map_err(|e| format!("demande de code : {e}"))?;

    let statut = resp.status();
    let corps = resp.text().await.unwrap_or_default();
    if !statut.is_success() {
        return Err(format!("GitHub a refusé la demande de code (HTTP {statut}) : {corps}"));
    }
    let c: ReponseCode = serde_json::from_str(&corps)
        .map_err(|e| format!("réponse de GitHub illisible ({e}) : {corps}"))?;
    Ok(Attente {
        user_code: c.user_code,
        verification_uri: c.verification_uri,
        device_code: c.device_code,
        interval: c.interval.max(1),
        expires_in: c.expires_in,
    })
}

/// Seconde étape : interroger GitHub jusqu'à ce que la personne ait validé.
///
/// Le rythme est imposé par GitHub : interroger plus vite que `interval` vaut
/// un `slow_down`, qui rallonge le délai au lieu de l'écourter.
pub async fn attendre(client_id: &str, attente: &Attente) -> Result<String, String> {
    let http = client_http()?;
    let mut interval = attente.interval;
    let limite = std::time::Instant::now() + Duration::from_secs(attente.expires_in);

    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if std::time::Instant::now() > limite {
            return Err("le code a expiré — relancez la connexion".into());
        }

        let resp = http
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(formulaire(&[
                ("client_id", client_id),
                ("device_code", &attente.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ]))
            .send()
            .await
            .map_err(|e| format!("interrogation de GitHub : {e}"))?;

        let corps = resp.text().await.unwrap_or_default();
        let r: ReponseJeton = serde_json::from_str(&corps)
            .map_err(|e| format!("réponse de GitHub illisible ({e}) : {corps}"))?;

        if let Some(jeton) = r.access_token {
            return Ok(jeton);
        }
        match r.error.as_deref() {
            // La personne n'a pas encore validé : c'est le cas nominal.
            Some("authorization_pending") => {}
            Some("slow_down") => interval = r.interval.unwrap_or(interval + 5),
            Some("expired_token") => return Err("le code a expiré — relancez la connexion".into()),
            Some("access_denied") => return Err("connexion refusée depuis GitHub".into()),
            Some(autre) => {
                return Err(r
                    .error_description
                    .unwrap_or_else(|| format!("erreur GitHub : {autre}")))
            }
            None => return Err(format!("réponse inattendue de GitHub : {corps}")),
        }
    }
}

/* ------------------------------------------------------- conservation */

fn entree() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, COMPTE).map_err(|e| format!("trousseau indisponible : {e}"))
}

pub fn lire_jeton() -> Option<String> {
    entree().ok()?.get_password().ok().filter(|j| !j.is_empty())
}

pub fn ecrire_jeton(jeton: &str) -> Result<(), String> {
    entree()?
        .set_password(jeton)
        .map_err(|e| format!("écriture dans le trousseau : {e}"))
}

pub fn effacer_jeton() -> Result<(), String> {
    match entree()?.delete_credential() {
        Ok(()) => Ok(()),
        // Rien à effacer n'est pas une erreur : le résultat voulu est atteint.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("effacement dans le trousseau : {e}")),
    }
}

/// Jeton de `gh`, quand il est installé et authentifié.
///
/// C'est le pont avec l'existant : tant qu'aucune application OAuth n'est
/// configurée, StarViz continue de fonctionner comme avant pour qui a déjà
/// `gh`. La dépendance passe d'obligatoire à commode.
pub async fn jeton_gh() -> Option<String> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["auth", "token"]);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let jeton = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!jeton.is_empty()).then_some(jeton)
}

/// D'où vient le jeton employé, pour le dire à l'interface.
pub async fn jeton_actif() -> Option<(String, &'static str)> {
    if let Some(j) = lire_jeton() {
        return Some((j, "oauth"));
    }
    jeton_gh().await.map(|j| (j, "gh"))
}

/* --------------------------------------------------------------- état */

use crate::model::AuthStatus;
use std::sync::Mutex;

/// Ce que l'interface doit savoir de la connexion, et le code en cours de
/// saisie quand il y en a un.
pub struct Etat {
    inner: Mutex<Inner>,
}

struct Inner {
    source: &'static str,
    attente: Option<Attente>,
    erreur: Option<String>,
}

impl Etat {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                // Ni « oauth » ni « aucune » tant que `reevaluer` n'a pas
                // tourné : afficher le voile de connexion pendant les quelques
                // dizaines de millisecondes que prend l'interrogation de `gh`
                // le ferait clignoter à chaque démarrage.
                source: "inconnue",
                attente: None,
                erreur: None,
            }),
        }
    }

    /// Redétermine d'où vient le jeton. Interroger `gh` coûte un processus :
    /// on ne le fait qu'au démarrage et après une connexion ou déconnexion,
    /// jamais à chaque tour du sondage.
    pub async fn reevaluer(&self) {
        let source = match jeton_actif().await {
            Some((_, s)) => s,
            None => "aucune",
        };
        self.inner.lock().unwrap().source = source;
    }

    pub fn statut(&self) -> AuthStatus {
        let g = self.inner.lock().unwrap();
        AuthStatus {
            connecte: g.source != "aucune",
            source: g.source,
            device_flow_possible: client_id().is_some(),
            en_attente: g.attente.is_some(),
            user_code: g.attente.as_ref().map(|a| a.user_code.clone()),
            verification_uri: g.attente.as_ref().map(|a| a.verification_uri.clone()),
            erreur: g.erreur.clone(),
        }
    }

    pub fn poser_attente(&self, attente: Attente) {
        let mut g = self.inner.lock().unwrap();
        g.attente = Some(attente);
        g.erreur = None;
    }

    pub fn terminer(&self, erreur: Option<String>) {
        let mut g = self.inner.lock().unwrap();
        g.attente = None;
        g.erreur = erreur;
    }
}

#[cfg(test)]
mod tests {
    /// Le trousseau est la seule dépendance externe du module qu'on puisse
    /// éprouver sans compte GitHub. Le test écrit sous un nom qui lui est
    /// propre pour ne pas toucher au jeton réel.
    #[test]
    fn aller_retour_dans_le_trousseau() {
        const COMPTE_TEST: &str = "github-oauth-test";
        let entree = keyring::Entry::new(super::SERVICE, COMPTE_TEST)
            .expect("le trousseau doit être accessible");

        entree.set_password("jeton-factice").expect("écriture");
        assert_eq!(entree.get_password().expect("lecture"), "jeton-factice");

        entree.delete_credential().expect("effacement");
        assert!(
            matches!(entree.get_password(), Err(keyring::Error::NoEntry)),
            "l'entrée doit avoir disparu"
        );
    }
}
