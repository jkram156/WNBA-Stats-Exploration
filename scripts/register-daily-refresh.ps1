[CmdletBinding()]
param(
    [string]$TaskName = "WNBA Stats Daily Refresh",
    [ValidatePattern("^([01]\d|2[0-3]):[0-5]\d$")]
    [string]$DailyAt = "06:00",
    [Nullable[int]]$Season = $null,
    [string]$RawRoot = "C:\Users\jkram\github\wehoop-wnba-raw"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    throw "Task Scheduler registration requires an elevated PowerShell window. Reopen PowerShell with 'Run as administrator' and run this script again."
}

if ($null -ne $Season -and ($Season -lt 1997 -or $Season -gt 2100)) {
    throw "Season must be a valid WNBA season year."
}

$refreshScript = Join-Path $PSScriptRoot "refresh-daily.ps1"
if (-not (Test-Path -LiteralPath $refreshScript -PathType Leaf)) {
    throw "Refresh script not found: $refreshScript"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$databasePath = Join-Path $projectRoot "wnba_raw.sqlite"
$powerShellCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($null -eq $powerShellCommand) {
    $powerShellCommand = Get-Command powershell.exe -ErrorAction Stop
}
$powerShell = $powerShellCommand.Source
$argumentParts = @(
    "-NoProfile"
    "-NonInteractive"
    "-ExecutionPolicy Bypass"
    "-File `"$refreshScript`""
    "-RawRoot `"$RawRoot`""
    "-ProjectRoot `"$projectRoot`""
    "-DatabasePath `"$databasePath`""
)
if ($null -ne $Season) {
    $argumentParts += "-Season $Season"
}
$argument = $argumentParts -join " "

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $argument -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Refresh current-season WNBA raw exports, ESPN schedule, and local SQLite data." `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Registered '$TaskName' to run daily at $DailyAt while the current user is logged in."
Write-Host "State: $($task.State); next run: $($taskInfo.NextRunTime)"
Write-Host "Logs: $(Join-Path $projectRoot 'logs\daily-refresh-*.log')"
