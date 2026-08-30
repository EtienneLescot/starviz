// Pas de console derrière la fenêtre en release : l'app est lancée depuis une
// icône, pas depuis un terminal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fetcher;
mod github;
mod model;
mod store;

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
fn status(fetcher: State<Arc<Fetcher>>) -> Status {
    fetcher.status()
}

/// `None` quand aucun historique n'existe encore : le front l'interprète
/// comme l'ancien 404 et affiche son état vide.
#[tauri::command]
fn data(fetcher: State<Arc<Fetcher>>) -> Option<Data> {
    fetcher.data()
}

#[tauri::command]
fn refresh(force: Option<bool>, fetcher: State<Arc<Fetcher>>) -> serde_json::Value {
    let started = fetcher.start(force.unwrap_or(false));
    let s = fetcher.status();
    serde_json::json!({
        "started": started,
        "state": s.state,
        "message": s.message,
        "done": s.done,
        "total": s.total,
        "error": s.error,
        "generated_at": s.generated_at,
        "has_data": s.has_data,
    })
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
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
        .invoke_handler(tauri::generate_handler![hello, status, data, refresh, quit])
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

            // Première collecte : immédiate si l'historique est absent ou
            // vieux d'une heure, comme le faisait le serveur Python.
            let fetcher = handle.state::<Arc<Fetcher>>().inner().clone();
            if fetcher.est_perime() {
                fetcher.start(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage de StarViz");
}
