// Pas de console derrière la fenêtre en release : l'app est lancée depuis une
// icône, pas depuis un terminal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;
mod fetcher;
mod github;
mod model;
mod settings;
mod store;
mod trending;

use auth::Etat;
use fetcher::Fetcher;
use model::{Data, Status};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

#[tauri::command]
fn hello() -> serde_json::Value {
    serde_json::json!({ "app": "starviz", "pid": std::process::id() })
}

#[tauri::command]
fn status(fetcher: State<Arc<Fetcher>>, etat: State<Arc<Etat>>) -> Status {
    fetcher.status(etat.statut())
}

/// `None` quand aucun historique n'existe encore : le front l'interprète
/// comme l'ancien 404 et affiche son état vide.
#[tauri::command]
fn data(fetcher: State<Arc<Fetcher>>) -> Option<Data> {
    fetcher.data()
}

#[tauri::command]
fn refresh(
    force: Option<bool>,
    fetcher: State<Arc<Fetcher>>,
    etat: State<Arc<Etat>>,
) -> serde_json::Value {
    let started = fetcher.start(force.unwrap_or(false));
    let s = fetcher.status(etat.statut());
    serde_json::json!({ "started": started, "status": s })
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/* ------------------------------------------------------------ reglages */

#[tauri::command]
fn reglages() -> settings::Settings {
    settings::read()
}

/// Les valeurs recues sont bornees avant d'etre ecrites, et la version bornee
/// est renvoyee : l'interface affiche ce qui a reellement ete retenu, pas ce
/// qu'elle a demande.
#[tauri::command]
fn set_reglages(valeurs: settings::Settings) -> Result<settings::Settings, String> {
    let bornees = valeurs.borner();
    settings::write(&bornees)?;
    Ok(bornees)
}

#[tauri::command]
fn infos() -> settings::Infos {
    settings::infos()
}

#[tauri::command]
fn ouvrir_dossier_donnees() -> Result<(), String> {
    settings::ouvrir_dossier(&store::data_dir())
}

/* ------------------------------------------------------------ trending */

/// Lit le journal ecrit par `starviz.py --trending`. L'application ne releve
/// rien elle-meme : le relevé demande un navigateur sans interface et doit
/// tourner meme quand la fenetre est fermee.
#[tauri::command]
fn trending() -> trending::Trending {
    trending::lire()
}

/// Une capture, rendue a la demande : les charger toutes d'un coup ferait
/// entrer plusieurs mega-octets d'images dans la page pour rien.
#[tauri::command]
fn capture(fichier: String) -> Result<String, String> {
    trending::capture(&fichier)
}

/// Ouvre une session : GitHub renvoie un code court, que l'interface affiche
/// pendant que l'on attend la validation sur github.com.
#[tauri::command]
async fn auth_start(app: AppHandle) -> Result<serde_json::Value, String> {
    let etat = app.state::<Arc<Etat>>().inner().clone();
    match demarrer_connexion(&app).await {
        Ok(v) => Ok(v),
        Err(e) => {
            // L'échec doit être consigné dans l'état, pas seulement renvoyé :
            // le sondage réécrit le bandeau chaque seconde, et effacerait un
            // message que le front aurait posé de son côté.
            etat.terminer(Some(e.clone()));
            Err(e)
        }
    }
}

async fn demarrer_connexion(app: &AppHandle) -> Result<serde_json::Value, String> {
    let client_id = auth::client_id().ok_or(
        "aucune application OAuth n'est configurée dans cette compilation — \
         StarViz utilise le jeton de `gh`",
    )?;
    let etat = app.state::<Arc<Etat>>().inner().clone();
    let attente = auth::demarrer(&client_id).await?;
    etat.poser_attente(attente.clone());

    let reponse = serde_json::json!({
        "user_code": attente.user_code,
        "verification_uri": attente.verification_uri,
    });

    // L'attente dure jusqu'à quinze minutes : elle vit dans sa propre tâche,
    // et l'interface suit son avancement par le sondage habituel.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let resultat = auth::attendre(&client_id, &attente).await;
        match resultat {
            Ok(jeton) => {
                if let Err(e) = auth::ecrire_jeton(&jeton) {
                    etat.terminer(Some(e));
                    return;
                }
                etat.reevaluer().await;
                etat.terminer(None);
                // Le compte vient de changer : l'historique du précédent ne
                // vaut plus rien, on repart d'une collecte complète.
                handle.state::<Arc<Fetcher>>().inner().clone().start(true);
            }
            Err(e) => etat.terminer(Some(e)),
        }
    });
    Ok(reponse)
}

#[tauri::command]
async fn auth_logout(app: AppHandle) -> Result<(), String> {
    auth::effacer_jeton()?;
    let etat = app.state::<Arc<Etat>>().inner().clone();
    etat.reevaluer().await;
    etat.terminer(None);
    Ok(())
}

fn montrer(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // Doit rester le premier greffon enregistré. La fenêtre se repliant
        // dans la zone de notification, on relance facilement une application
        // qu'on croyait fermée : deux collecteurs écriraient alors le même
        // historique, celui-là même que le README qualifie d'irrécupérable.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            montrer(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(Fetcher::new()))
        .manage(Arc::new(Etat::new()))
        .invoke_handler(tauri::generate_handler![
            hello,
            status,
            data,
            refresh,
            quit,
            auth_start,
            auth_logout,
            reglages,
            set_reglages,
            infos,
            ouvrir_dossier_donnees,
            trending,
            capture
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Fermer la fenêtre replie dans la zone de notification plutôt que
            // de quitter : c'est ce qui permet au relevé de continuer à vivre
            // en fond. On quitte par le menu du tray ou le bouton de l'UI.
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            let afficher = MenuItem::with_id(app, "show", "Afficher StarViz", true, None::<&str>)?;
            let actualiser = MenuItem::with_id(app, "refresh", "Actualiser", true, None::<&str>)?;
            let separateur = PredefinedMenuItem::separator(app)?;
            let quitter = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&afficher, &actualiser, &separateur, &quitter])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("StarViz")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => montrer(app),
                    "refresh" => {
                        let f = app.state::<Arc<Fetcher>>();
                        f.start(false);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        montrer(tray.app_handle());
                    }
                });
            if let Some(icone) = app.default_window_icon() {
                tray = tray.icon(icone.clone());
            }
            tray.build(app)?;

            // Déterminer d'où vient le jeton demande d'interroger `gh`, donc
            // de lancer un processus : hors du chemin d'affichage de la
            // fenêtre, qui n'a pas à l'attendre.
            let etat = handle.state::<Arc<Etat>>().inner().clone();
            let fetcher = handle.state::<Arc<Fetcher>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                etat.reevaluer().await;
                // Première collecte : immédiate si l'historique est absent ou
                // vieux d'une heure, comme le faisait le serveur Python.
                if etat.statut().connecte && fetcher.est_perime() {
                    fetcher.start(false);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage de StarViz");
}
