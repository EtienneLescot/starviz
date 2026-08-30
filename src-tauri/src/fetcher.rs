//! État de la collecte, tel que le front le lit à chaque tour de `poll()`.
//!
//! Une seule collecte à la fois : deux paginations concurrentes sur les mêmes
//! dépôts doubleraient les appels réseau pour écrire le même fichier.

use crate::github::{self, Progress};
use crate::model::{Data, Status};
use crate::store;
use std::sync::{Arc, Mutex};

struct Inner {
    state: &'static str, // idle | running | error
    message: String,
    done: usize,
    total: usize,
    error: Option<String>,
    data: Option<Data>,
}

pub struct Fetcher {
    inner: Mutex<Inner>,
}

impl Fetcher {
    pub fn new() -> Self {
        let data = store::read();
        Self {
            inner: Mutex::new(Inner {
                state: "idle",
                message: if data.is_some() { "À jour".into() } else { String::new() },
                done: 0,
                total: 0,
                error: None,
                data,
            }),
        }
    }

    pub fn status(&self) -> Status {
        let g = self.inner.lock().unwrap();
        Status {
            state: g.state,
            message: g.message.clone(),
            done: g.done,
            total: g.total,
            error: g.error.clone(),
            generated_at: g.data.as_ref().map(|d| d.generated_at.clone()),
            has_data: g.data.is_some(),
        }
    }

    pub fn data(&self) -> Option<Data> {
        self.inner.lock().unwrap().data.clone()
    }

    /// Vrai si l'historique est absent ou date de plus d'une heure.
    pub fn est_perime(&self) -> bool {
        let g = self.inner.lock().unwrap();
        let Some(d) = g.data.as_ref() else {
            return true;
        };
        match chrono::DateTime::parse_from_rfc3339(&d.generated_at) {
            Ok(t) => (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() > 3600,
            Err(_) => true,
        }
    }

    /// Démarre une collecte. Renvoie `false` si une est déjà en cours.
    pub fn start(self: &Arc<Self>, force: bool) -> bool {
        {
            let mut g = self.inner.lock().unwrap();
            if g.state == "running" {
                return false;
            }
            g.state = "running";
            g.error = None;
            g.message = "Connexion à GitHub…".into();
            g.done = 0;
            g.total = 0;
        }

        let moi = self.clone();
        let precedent = self.data();
        let prog: Progress = {
            let moi = self.clone();
            Arc::new(move |message, done, total| {
                let mut g = moi.inner.lock().unwrap();
                g.message = message;
                g.done = done;
                g.total = total;
            })
        };

        tauri::async_runtime::spawn(async move {
            match github::collect(force, precedent, prog).await {
                Ok(data) => {
                    if let Err(e) = store::write(&data) {
                        // L'historique n'a pas pu être écrit : l'affichage est
                        // juste, mais le prochain démarrage repartira de
                        // l'ancien fichier. Ça se dit.
                        eprintln!("écriture de data.json : {e}");
                    }
                    let mut g = moi.inner.lock().unwrap();
                    g.data = Some(data);
                    g.state = "idle";
                    g.message = "À jour".into();
                }
                Err(e) => {
                    let mut g = moi.inner.lock().unwrap();
                    g.state = "error";
                    g.error = Some(e);
                    g.message = "Échec de la récupération".into();
                }
            }
        });
        true
    }
}
