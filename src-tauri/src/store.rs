//! Emplacement et lecture/écriture de `data.json`.
//!
//! On garde volontairement le chemin XDG utilisé par `starviz.py`
//! (`$XDG_DATA_HOME` ou `~/.local/share/starviz`), y compris sous Windows :
//! l'historique des étoiles n'est pas un cache — reconstruit depuis l'API, il
//! devient irrécupérable si un dépôt disparaît. Changer de dossier ici
//! reviendrait à l'abandonner, et à désynchroniser le relevé planifié.

use crate::model::Data;
use std::fs;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v).join("starviz"),
        _ => dirs::home_dir()
            .unwrap_or_default()
            .join(".local/share/starviz"),
    }
}

pub fn data_file() -> PathBuf {
    data_dir().join("data.json")
}

pub fn read() -> Option<Data> {
    let raw = fs::read_to_string(data_file()).ok()?;
    match serde_json::from_str(&raw) {
        Ok(d) => Some(d),
        Err(e) => {
            eprintln!("data.json illisible ({e}) — on repart d'une collecte vide");
            None
        }
    }
}

/// Écriture atomique : un plantage en cours d'écriture ne doit pas laisser un
/// historique tronqué à la place de l'ancien, qui était valide.
pub fn write(data: &Data) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("création de {}: {e}", dir.display()))?;
    let tmp = dir.join("data.json.tmp");
    let body = serde_json::to_vec(data).map_err(|e| format!("sérialisation: {e}"))?;
    fs::write(&tmp, &body).map_err(|e| format!("écriture: {e}"))?;
    fs::rename(&tmp, data_file()).map_err(|e| format!("remplacement: {e}"))?;
    Ok(())
}
