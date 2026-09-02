# Planifie le relevé des classements Trending sous Windows.
#
# Équivalent du minuteur systemd de Linux : -StartWhenAvailable rattrape le
# relevé manqué quand la machine était éteinte à l'heure prévue, ce que le
# Planificateur ne fait pas de lui-même.
#
#   powershell -ExecutionPolicy Bypass -File windows\install-trending-task.ps1
#
# Aucun droit administrateur : la tâche est enregistrée dans le contexte de
# l'utilisateur courant et ne tourne que session ouverte.

param(
    [string]$NomTache = 'StarViz Trending',
    [int]$IntervalleHeures = 3
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'starviz-trending.ps1'
if (-not (Test-Path $script)) { throw "Introuvable : $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

# Un déclencheur unique répété : le Planificateur n'offre pas de cadence
# infra-journalière autrement.
$declencheur = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalleHeures) `
    -RepetitionDuration (New-TimeSpan -Days 3650) `
    -RandomDelay (New-TimeSpan -Minutes 5)

$reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $NomTache -Action $action -Trigger $declencheur `
    -Settings $reglages -Force `
    -Description "Releve les classements GitHub Trending toutes les $IntervalleHeures h et pousse les donnees dans starviz-data." | Out-Null

Write-Output "Tache planifiee : $NomTache (toutes les $IntervalleHeures h)"
Write-Output "Journal : $env:LOCALAPPDATA\starviz\trending.log"
Write-Output "Essai immediat : Start-ScheduledTask -TaskName '$NomTache'"
