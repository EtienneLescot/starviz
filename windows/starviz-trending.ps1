# Relevé des classements Trending — cible de la tâche planifiée Windows.
#
# Une tâche muette ne se remarque pas quand elle meurt : c'est exactement ce
# qui est arrivé à la machine précédente. Tout passe donc par un journal,
# dont on ne garde que la fin.

$ErrorActionPreference = 'Stop'
$racine = Split-Path -Parent $PSScriptRoot
$journalDir = Join-Path $env:LOCALAPPDATA 'starviz'
if (-not (Test-Path $journalDir)) { New-Item -ItemType Directory -Path $journalDir | Out-Null }
$journal = Join-Path $journalDir 'trending.log'
$horodatage = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')

$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) {
    "--- $horodatage  python.exe introuvable" | Add-Content -Path $journal -Encoding utf8
    exit 1
}

# Sans cela, la sortie accentuée du script se heurte à la page de codes
# héritée dès qu'elle est redirigée vers un fichier, et le relevé meurt là.
$env:PYTHONUTF8 = '1'

$sortieFic = Join-Path $env:TEMP 'starviz-trending.out'
$erreurFic = Join-Path $env:TEMP 'starviz-trending.err'
$proc = Start-Process -FilePath $python.Source -WorkingDirectory $racine -NoNewWindow -Wait -PassThru `
    -ArgumentList @((Join-Path $racine 'starviz.py'), '--fetch-only', '--trending') `
    -RedirectStandardOutput $sortieFic -RedirectStandardError $erreurFic

$lignes = @("--- $horodatage  (code $($proc.ExitCode))")
foreach ($f in @($sortieFic, $erreurFic)) {
    if (Test-Path $f) {
        $lignes += (Get-Content -Path $f -Encoding utf8)
        Remove-Item -Path $f -Force
    }
}
$lignes | Add-Content -Path $journal -Encoding utf8

# Le journal grossit d'une vingtaine de lignes par relevé : on le borne.
$tout = Get-Content -Path $journal -Encoding utf8
if ($tout.Count -gt 4000) {
    $tout | Select-Object -Last 2000 | Set-Content -Path $journal -Encoding utf8
}

exit $proc.ExitCode
