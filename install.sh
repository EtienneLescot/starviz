#!/usr/bin/env bash
# Installe le raccourci StarViz dans le menu / la barre des tâches (GNOME & co).
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ENTRY="$APPS/starviz.desktop"

mkdir -p "$APPS"
chmod +x "$HERE/starviz" "$HERE/starviz.py"

cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=StarViz
GenericName=Étoiles GitHub
Comment=Visualiser l'évolution des étoiles de vos dépôts GitHub
Exec=$HERE/starviz
Icon=$HERE/web/icon.svg
Terminal=false
Categories=Development;
Keywords=github;stars;étoiles;stats;graphique;
StartupNotify=false
Actions=Refresh;

[Desktop Action Refresh]
Name=Actualiser puis ouvrir
Exec=$HERE/starviz --refresh
DESKTOP

chmod +x "$ENTRY"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
echo "Raccourci installé : $ENTRY"

# Épinglage dans le dock GNOME (barre des tâches), sans doublon.
if command -v gsettings >/dev/null && gsettings writable org.gnome.shell favorite-apps >/dev/null 2>&1; then
  current="$(gsettings get org.gnome.shell favorite-apps)"
  if [[ "$current" != *"'starviz.desktop'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
      gsettings set org.gnome.shell favorite-apps "['starviz.desktop']"
    else
      gsettings set org.gnome.shell favorite-apps "${current%]}, 'starviz.desktop']"
    fi
    echo "Épinglé dans le dock GNOME."
  else
    echo "Déjà épinglé dans le dock GNOME."
  fi
fi
