fn main() {
    // L'icône Windows est compilée dans une ressource par le script de build.
    // Sans cette ligne, Cargo ne rejoue pas le script quand seul le fichier
    // d'icône change : l'exécutable garde alors l'ancienne icône, visible dès
    // qu'on l'épingle à la barre des tâches.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
