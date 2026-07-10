[CmdletBinding()]
param(
    [int]$Season = (Get-Date).Year,
    [string]$RawRoot = "C:\Users\jkram\github\wehoop-wnba-raw",
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DatabasePath = (Join-Path (Split-Path -Parent $PSScriptRoot) "wnba_raw.sqlite")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        Write-Host "Running: $Executable $($Arguments -join ' ')"
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $Executable"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $RawRoot -PathType Container)) {
    throw "Raw-data checkout not found: $RawRoot"
}

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "Project checkout not found: $ProjectRoot"
}

$uv = (Get-Command uv.exe -ErrorAction Stop).Source
$tsx = Join-Path $ProjectRoot "node_modules\.bin\tsx.CMD"
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw "tsx is not installed at $tsx. Run 'pnpm install' in $ProjectRoot first."
}
$outstandingGameScraper = Join-Path $ProjectRoot "scripts\scrape-outstanding-games.py"
if (-not (Test-Path -LiteralPath $outstandingGameScraper -PathType Leaf)) {
    throw "Outstanding-game scraper not found: $outstandingGameScraper"
}

$logs = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$logPath = Join-Path $logs ("daily-refresh-{0}.log" -f (Get-Date -Format "yyyy-MM-dd-HHmmss"))
$transcriptStarted = $false
$mutex = [Threading.Mutex]::new($false, "WNBAStatsExplorationDailyRefresh")
$hasMutex = $false

try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) {
        throw "Another WNBA daily refresh is already running."
    }

    Start-Transcript -Path $logPath | Out-Null
    $transcriptStarted = $true
    $startedAt = (Get-Date).ToUniversalTime().ToString("o")

    Write-Host "WNBA daily refresh started at $startedAt for season $Season"
    Invoke-CheckedCommand -Executable $uv -WorkingDirectory $RawRoot -Arguments @(
        "run", "--native-tls", "python", "python/scrape_wnba_schedules.py", "-s", "$Season", "-e", "$Season"
    )
    Invoke-CheckedCommand -Executable $uv -WorkingDirectory $RawRoot -Arguments @(
        "run", "--native-tls", "python", $outstandingGameScraper, "--raw-root", $RawRoot, "--season", "$Season"
    )
    Invoke-CheckedCommand -Executable $tsx -WorkingDirectory $ProjectRoot -Arguments @(
        "src/sync-espn-schedule.ts", "--season", "$Season", "--db", $DatabasePath, "--insecure-tls"
    )
    Invoke-CheckedCommand -Executable $tsx -WorkingDirectory $ProjectRoot -Arguments @(
        "src/sync-wnba-raw.ts", "--source", $RawRoot, "--db", $DatabasePath, "--incremental", "--since", $startedAt
    )

    Write-Host "WNBA daily refresh completed successfully at $((Get-Date).ToUniversalTime().ToString('o'))"
}
catch {
    Write-Error "WNBA daily refresh failed: $($_.Exception.Message). Log: $logPath"
    exit 1
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
    if ($hasMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
