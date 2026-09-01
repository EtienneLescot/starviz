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

/// Marge avant expiration : en deçà, on renouvelle sans attendre le refus.
/// Une collecte complète dure une minute ; dix minutes couvrent largement
/// celle qui vient tout juste de démarrer.
const MARGE: i64 = 600;

fn maintenant() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Portées demandées. `repo` est nécessaire pour voir les dépôts privés dans
/// la liste ; sans lui, seuls les publics remonteraient. `read:org` sert à
/// énumérer les organisations.
///
/// `offline_access` demande à GitHub un jeton court accompagné d'un jeton de
/// renouvellement, au lieu d'un jeton permanent. C'est un meilleur marché
/// qu'il n'y paraît : le permanent ne survit pas non plus à une révocation,
/// et lui seul obligeait à ressaisir un code à chaque fois qu'il tombait.
/// Une application OAuth qui ne connaît pas cette portée l'ignore — la
/// réponse est alors celle d'avant, et le code s'en accommode.
pub const PORTEES: &str = "repo read:org offline_access";

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

/// Ce que le trousseau garde.
///
/// GitHub délivre soit un jeton permanent, soit — avec `offline_access` — un
/// jeton de huit heures et de quoi le renouveler pendant six mois. Les deux
/// cas se rangent ici : les champs facultatifs sont simplement absents dans
/// le premier.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct Jeton {
    pub access: String,
    /// Absent quand le jeton ne périme pas : il n'y a alors rien à renouveler.
    #[serde(default)]
    pub refresh: Option<String>,
    /// Expiration, en secondes depuis l'epoch. `expires_in` est relatif à
    /// l'instant de la réponse — inutilisable tel quel une fois rangé.
    #[serde(default)]
    pub expire_le: Option<i64>,
    #[serde(default)]
    pub refresh_expire_le: Option<i64>,
}

impl Jeton {
    /// Vrai quand l'expiration est passée ou proche : c'est le moment de
    /// renouveler, pas celui d'échouer.
    fn perime(&self) -> bool {
        self.expire_le.is_some_and(|t| maintenant() + MARGE >= t)
    }

    /// Vrai quand GitHub le refuserait pour de bon.
    fn expire(&self) -> bool {
        self.expire_le.is_some_and(|t| maintenant() >= t)
    }

    /// Ce que GitHub a délivré, en une ligne de journal. Le contenu du jeton
    /// n'y figure pas : seule sa nature renseigne, et elle suffit à savoir si
    /// le renouvellement automatique a de quoi travailler.
    pub fn resume(&self) -> String {
        match (self.expire_le, self.refresh.is_some()) {
            (None, _) => "permanent".into(),
            (Some(t), r) => format!(
                "expire dans {} h, renouvelable : {}",
                (t - maintenant()) / 3600,
                if r { "oui" } else { "non" }
            ),
        }
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
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

impl ReponseJeton {
    /// Les durées deviennent des dates ici, au plus près de la réponse : plus
    /// loin, le temps passé à la lire fausserait déjà le calcul.
    fn en_jeton(self) -> Option<Jeton> {
        let base = maintenant();
        Some(Jeton {
            access: self.access_token?,
            refresh: self.refresh_token,
            expire_le: self.expires_in.map(|s| base + s),
            refresh_expire_le: self.refresh_token_expires_in.map(|s| base + s),
        })
    }
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
pub async fn attendre(client_id: &str, attente: &Attente) -> Result<Jeton, String> {
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

        if r.access_token.is_some() {
            return r
                .en_jeton()
                .ok_or_else(|| format!("réponse inattendue de GitHub : {corps}"));
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

/* ------------------------------------------------------ renouvellement */

/// Pourquoi un renouvellement a échoué.
///
/// La distinction fait tout : jeter le jeton parce que le réseau a hoqueté
/// redemanderait un code à chaque coupure — précisément ce qu'on cherche à
/// éviter.
#[derive(Debug)]
pub enum Echec {
    /// GitHub a répondu, et a refusé. Révocation depuis github.com, ou jeton
    /// de renouvellement déjà consommé : seule une nouvelle connexion en sort.
    Refuse(String),
    /// Rien n'a été refusé : coupure, panne, réponse illisible. Le jeton
    /// courant reste valable, et réessayer plus tard a un sens.
    Passager(String),
}

impl std::fmt::Display for Echec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Echec::Refuse(m) | Echec::Passager(m) => f.write_str(m),
        }
    }
}

/// Échange un jeton de renouvellement contre un couple neuf.
///
/// GitHub n'exige pas de `client_secret` quand le jeton d'origine vient du
/// device flow. C'est ce qui rend l'opération possible depuis une application
/// de bureau, où aucun secret ne tiendrait : le binaire est lisible.
///
/// Le jeton de renouvellement est à usage unique — la réponse en porte un
/// nouveau, qui doit remplacer l'ancien sous peine de ne plus rien pouvoir
/// renouveler.
pub async fn rafraichir(client_id: &str, refresh: &str) -> Result<Jeton, Echec> {
    let http = client_http().map_err(Echec::Passager)?;
    let resp = http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(formulaire(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
        ]))
        .send()
        .await
        .map_err(|e| Echec::Passager(format!("renouvellement du jeton : {e}")))?;

    let corps = resp.text().await.unwrap_or_default();
    // Une réponse illisible n'est pas un refus : GitHub sert des pages
    // d'erreur en HTML quand il tousse, et ce n'est pas au jeton de payer.
    let r: ReponseJeton = serde_json::from_str(&corps)
        .map_err(|e| Echec::Passager(format!("réponse de GitHub illisible ({e}) : {corps}")))?;

    if let Some(err) = r.error.as_deref() {
        // Seuls ces refus-là condamnent le jeton. Les autres sont trop
        // ambigus pour qu'on efface sur leur foi : GitHub répond par exemple
        // `incorrect_client_credentials` à un jeton de renouvellement qu'il ne
        // retrouve pas, faute de pouvoir vérifier qu'il vient du device flow.
        // Effacer là-dessus, c'est déconnecter pour une panne passagère.
        const CONDAMNE: [&str; 3] = ["bad_refresh_token", "invalid_grant", "access_denied"];
        let mort = CONDAMNE.contains(&err);
        let quoi = err.to_string();
        let message = r
            .error_description
            .unwrap_or_else(|| format!("erreur GitHub : {quoi}"));
        return Err(if mort {
            Echec::Refuse(message)
        } else {
            Echec::Passager(format!("{message} ({quoi})"))
        });
    }
    r.en_jeton()
        .ok_or_else(|| Echec::Passager(format!("réponse inattendue de GitHub : {corps}")))
}

/// Éprouve le renouvellement à la connexion, et rend le jeton à conserver.
///
/// Un jeton de huit heures dont le renouvellement ne marcherait pas serait un
/// recul par rapport au jeton permanent d'avant. Le vérifier tout de suite le
/// dit pendant que la personne est encore devant l'écran, plutôt qu'au petit
/// matin sur un tableau vide. L'échange consomme le premier jeton de
/// renouvellement : c'est le neuf qu'on garde.
pub async fn eprouver(client_id: &str, jeton: Jeton) -> (Jeton, Option<String>) {
    let Some(refresh) = jeton.refresh.clone() else {
        return (jeton, None);
    };
    match rafraichir(client_id, &refresh).await {
        Ok(neuf) => (neuf, None),
        // Le refus laisse l'ancien intact : GitHub ne consomme pas ce qu'il
        // rejette. On repart donc avec le jeton d'origine.
        Err(e) => (
            jeton,
            Some(format!("renouvellement automatique indisponible : {e}")),
        ),
    }
}

/// Sérialise les renouvellements. Le jeton de renouvellement étant à usage
/// unique, deux échanges concurrents en perdraient un : le second présenterait
/// un jeton que GitHub vient de consommer, et se ferait éconduire.
fn verrou() -> &'static tokio::sync::Mutex<()> {
    static V: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    V.get_or_init(Default::default)
}

/// Jeton OAuth prêt à l'emploi, renouvelé s'il touche à sa fin.
///
/// Tout passe par ici : aucun appelant n'a à savoir qu'un jeton expire.
async fn jeton_oauth() -> Option<String> {
    let jeton = lire_jeton()?;
    if !jeton.perime() {
        return Some(jeton.access);
    }

    let _garde = verrou().lock().await;
    // Relecture sous verrou : un autre appel a pu renouveler pendant l'attente,
    // et le jeton lu plus haut serait déjà celui d'avant.
    let jeton = lire_jeton()?;
    if !jeton.perime() {
        return Some(jeton.access);
    }

    let (Some(refresh), Some(id)) = (jeton.refresh.clone(), client_id()) else {
        // Un jeton qui expire sans moyen d'être renouvelé n'a plus d'avenir.
        // Le garder ne ferait que retarder le moment où on le dit.
        let _ = effacer_jeton();
        return None;
    };

    match rafraichir(&id, &refresh).await {
        Ok(neuf) => {
            let access = neuf.access.clone();
            // L'écriture peut échouer — trousseau verrouillé, session
            // distante. Le jeton sert quand même pour cette collecte ; c'est
            // au prochain démarrage que la reconnexion s'imposera.
            if let Err(e) = ecrire_jeton(&neuf) {
                eprintln!("jeton renouvelé mais non conservé : {e}");
            }
            Some(access)
        }
        Err(Echec::Passager(e)) => {
            // On renouvelle dix minutes en avance : le jeton courant a encore
            // de quoi finir la collecte. Le prochain passage réessaiera.
            eprintln!("renouvellement remis à plus tard : {e}");
            (!jeton.expire()).then_some(jeton.access)
        }
        Err(Echec::Refuse(e)) => {
            eprintln!("renouvellement refusé par GitHub : {e}");
            let _ = effacer_jeton();
            None
        }
    }
}

/* ------------------------------------------------------- conservation */

fn entree() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, COMPTE).map_err(|e| format!("trousseau indisponible : {e}"))
}

/// Le trousseau ne range qu'une chaîne : le couple y tient en JSON.
///
/// Les installations d'avant le renouvellement y ont écrit le seul jeton
/// d'accès. Il se relit tel quel — forcer une reconnexion pour cause de
/// changement de format serait la déconnexion de trop.
pub fn lire_jeton() -> Option<Jeton> {
    let brut = entree().ok()?.get_password().ok().filter(|j| !j.is_empty())?;
    Some(serde_json::from_str(&brut).unwrap_or(Jeton {
        access: brut,
        refresh: None,
        expire_le: None,
        refresh_expire_le: None,
    }))
}

pub fn ecrire_jeton(jeton: &Jeton) -> Result<(), String> {
    let brut = serde_json::to_string(jeton).map_err(|e| format!("sérialisation : {e}"))?;
    entree()?
        .set_password(&brut)
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
    if let Some(j) = jeton_oauth().await {
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
    /// Expiration du jeton OAuth, recopiée du trousseau. Le sondage la lit
    /// chaque seconde : la relire du trousseau à ce rythme serait un appel
    /// système par battement, pour une valeur qui bouge toutes les huit heures.
    expire_le: Option<i64>,
    /// Avant cet instant, l'entretien ne fait rien.
    prochain_entretien: std::time::Instant,
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
                expire_le: None,
                prochain_entretien: std::time::Instant::now(),
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
        // Relu après coup : `jeton_actif` a pu le renouveler au passage, et
        // c'est la nouvelle échéance qui intéresse l'interface.
        let expire_le = (source == "oauth")
            .then(lire_jeton)
            .flatten()
            .and_then(|j| j.expire_le);
        let mut g = self.inner.lock().unwrap();
        g.source = source;
        g.expire_le = expire_le;
    }

    /// Entretien du jeton, appelé par le sondage d'état.
    ///
    /// Sans lui, une application laissée ouverte plus de huit heures ne
    /// découvrirait l'expiration qu'à la collecte suivante — c'est-à-dire au
    /// moment le plus mal choisi. Le rythme est volontairement lent : le
    /// sondage passe chaque seconde, un jeton ne tourne pas à cette cadence.
    pub async fn entretenir(&self) {
        {
            let mut g = self.inner.lock().unwrap();
            // Hors OAuth il n'y a rien à renouveler, et redemander sa source à
            // `gh` chaque minute lancerait un processus pour rien.
            if g.source != "oauth" || std::time::Instant::now() < g.prochain_entretien {
                return;
            }
            g.prochain_entretien = std::time::Instant::now() + Duration::from_secs(60);
        }
        self.reevaluer().await;
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
            expire_dans: g.expire_le.map(|t| t - maintenant()),
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
    use super::{maintenant, Jeton, ReponseJeton, MARGE};

    fn jeton(expire_dans: Option<i64>) -> Jeton {
        Jeton {
            access: "gho_x".into(),
            refresh: Some("ghr_x".into()),
            expire_le: expire_dans.map(|d| maintenant() + d),
            refresh_expire_le: None,
        }
    }

    /// Un jeton permanent ne périme jamais : sans cette exception, la première
    /// collecte le jetterait pour une expiration qui n'existe pas.
    #[test]
    fn le_permanent_ne_perime_pas() {
        let j = jeton(None);
        assert!(!j.perime() && !j.expire());
    }

    /// La marge sépare deux moments distincts : celui où il faut renouveler,
    /// et celui où le jeton ne vaut plus rien. Les confondre reviendrait à
    /// abandonner une collecte encore possible.
    #[test]
    fn la_marge_precede_l_expiration() {
        let bientot = jeton(Some(MARGE / 2));
        assert!(bientot.perime(), "il faut renouveler");
        assert!(!bientot.expire(), "mais il sert encore");

        assert!(!jeton(Some(MARGE * 2)).perime());
        assert!(jeton(Some(-1)).expire());
    }

    /// Les durées relatives de GitHub deviennent des dates absolues : rangées
    /// telles quelles, huit heures resteraient huit heures pour toujours.
    #[test]
    fn les_durees_deviennent_des_dates() {
        let r: ReponseJeton = serde_json::from_str(
            r#"{"access_token":"gho_a","refresh_token":"ghr_b",
                "expires_in":28800,"refresh_token_expires_in":15897600}"#,
        )
        .expect("réponse lisible");
        let j = r.en_jeton().expect("un jeton");
        let dans = j.expire_le.unwrap() - maintenant();
        assert!((28795..=28800).contains(&dans), "huit heures, à la seconde près : {dans}");
        assert_eq!(j.refresh.as_deref(), Some("ghr_b"));
    }

    /// Sans `offline_access`, GitHub renvoie un jeton seul. Le lire ne doit
    /// pas échouer, ni inventer une expiration.
    #[test]
    fn la_reponse_sans_expiration_reste_lisible() {
        let r: ReponseJeton =
            serde_json::from_str(r#"{"access_token":"gho_a","token_type":"bearer"}"#).unwrap();
        let j = r.en_jeton().unwrap();
        assert!(j.refresh.is_none() && j.expire_le.is_none());
    }

    /// Le trousseau des versions précédentes contient le jeton nu. Le relire
    /// évite d'imposer une reconnexion pour un simple changement de format.
    #[test]
    fn l_ancien_format_se_relit() {
        let nu = "gho_ancien";
        let j: Jeton = serde_json::from_str(nu).unwrap_or(Jeton {
            access: nu.into(),
            refresh: None,
            expire_le: None,
            refresh_expire_le: None,
        });
        assert_eq!(j.access, nu);
        assert!(!j.perime(), "un jeton sans échéance reste bon");
    }

    /// Aller-retour par le format réellement écrit dans le trousseau.
    #[test]
    fn le_couple_survit_a_la_serialisation() {
        let avant = jeton(Some(28800));
        let apres: Jeton = serde_json::from_str(&serde_json::to_string(&avant).unwrap()).unwrap();
        assert_eq!(apres.access, avant.access);
        assert_eq!(apres.refresh, avant.refresh);
        assert_eq!(apres.expire_le, avant.expire_le);
    }

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
