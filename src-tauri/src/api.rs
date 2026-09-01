//! Accès direct à l'API GitHub, en remplacement des appels à `gh`.
//!
//! Passer par le CLI coûtait un processus par requête et, surtout, imposait
//! `gh` installé et authentifié — ce qui interdisait de distribuer StarViz à
//! qui que ce soit d'autre. Tout passe désormais par HTTPS, avec le jeton
//! obtenu par device flow ou emprunté à `gh`.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::time::Duration;

pub struct Client {
    http: reqwest::Client,
    jeton: String,
    /// Tentatives avant d'abandonner sur erreur transitoire. Réglable depuis
    /// l'écran Réglages plutôt que figé à la compilation.
    tentatives: usize,
}

/// Une erreur qui a des chances de disparaître d'elle-même.
fn transitoire(statut: u16) -> bool {
    matches!(statut, 500 | 502 | 503 | 504 | 429)
}

impl Client {
    pub fn new(jeton: String, tentatives: usize) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            // GitHub refuse les requêtes sans User-Agent.
            .user_agent("starviz")
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("client HTTP : {e}"))?;
        Ok(Self { http, jeton, tentatives })
    }

    async fn envoyer(&self, faire: impl Fn() -> reqwest::RequestBuilder) -> Result<String, String> {
        let mut derniere = String::new();
        for essai in 0..self.tentatives.max(1) {
            if essai > 0 {
                tokio::time::sleep(Duration::from_secs(2 * essai as u64)).await;
            }
            let resp = match faire().send().await {
                Ok(r) => r,
                Err(e) => {
                    derniere = format!("réseau : {e}");
                    continue;
                }
            };
            let statut = resp.status();
            // GitHub indique lui-même quand reprendre après une limite
            // secondaire ; le respecter évite de la transformer en blocage.
            let attente = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            let corps = resp.text().await.unwrap_or_default();

            if statut.is_success() {
                return Ok(corps);
            }
            if statut.as_u16() == 401 {
                return Err("jeton refusé par GitHub — reconnectez-vous".into());
            }
            derniere = format!("HTTP {} : {}", statut.as_u16(), corps.chars().take(200).collect::<String>());
            if !transitoire(statut.as_u16()) {
                return Err(derniere);
            }
            if let Some(s) = attente {
                tokio::time::sleep(Duration::from_secs(s.min(60))).await;
            }
        }
        Err(derniere)
    }

    /// Une requête GraphQL, sans pagination.
    pub async fn graphql(&self, requete: &str, variables: Value) -> Result<Value, String> {
        // reqwest 0.13 n'expose plus `.json()` par defaut : on serialise le
        // corps nous-memes, ce qui affranchit du nommage de ses features.
        let corps = serde_json::to_vec(&json!({ "query": requete, "variables": variables }))
            .map_err(|e| format!("serialisation de la requete : {e}"))?;
        let texte = self
            .envoyer(|| {
                self.http
                    .post("https://api.github.com/graphql")
                    .bearer_auth(&self.jeton)
                    .header("content-type", "application/json")
                    .body(corps.clone())
            })
            .await?;
        let v: Value = serde_json::from_str(&texte)
            .map_err(|e| format!("réponse GraphQL illisible ({e})"))?;
        // GraphQL répond 200 même en cas d'erreur applicative : sans ce test,
        // un dépôt inaccessible passerait pour un dépôt sans étoiles.
        if let Some(erreurs) = v.get("errors").and_then(|e| e.as_array()) {
            if !erreurs.is_empty() {
                let msg = erreurs
                    .iter()
                    .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                    .collect::<Vec<_>>()
                    .join(" · ");
                return Err(if msg.is_empty() { "erreur GraphQL".into() } else { msg });
            }
        }
        Ok(v)
    }

    /// Parcourt une connexion GraphQL paginée et renvoie tous ses nœuds.
    ///
    /// `chemin` désigne la connexion dans la réponse, p. ex.
    /// `["viewer", "repositories"]`.
    pub async fn graphql_paginee<T: DeserializeOwned>(
        &self,
        requete: &str,
        mut variables: Value,
        chemin: &[&str],
        champ: &str,
    ) -> Result<Vec<T>, String> {
        let mut tout = Vec::new();
        let mut curseur: Option<String> = None;
        loop {
            variables["endCursor"] = curseur.clone().map(Value::from).unwrap_or(Value::Null);
            let v = self.graphql(requete, variables.clone()).await?;
            let mut noeud = v.get("data").ok_or("réponse GraphQL sans données")?;
            for c in chemin {
                noeud = noeud
                    .get(c)
                    .ok_or_else(|| format!("réponse GraphQL sans champ « {c} »"))?;
            }
            let items = noeud
                .get(champ)
                .ok_or_else(|| format!("réponse GraphQL sans champ « {champ} »"))?;
            let lot: Vec<T> = serde_json::from_value(items.clone())
                .map_err(|e| format!("nœuds GraphQL illisibles ({e})"))?;
            tout.extend(lot);

            let page = noeud.get("pageInfo");
            let encore = page
                .and_then(|p| p.get("hasNextPage"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if !encore {
                return Ok(tout);
            }
            curseur = page
                .and_then(|p| p.get("endCursor"))
                .and_then(|c| c.as_str())
                .map(str::to_string);
            if curseur.is_none() {
                return Ok(tout);
            }
        }
    }
}
