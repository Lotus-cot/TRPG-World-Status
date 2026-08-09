param(
    [string]$EventGeneratorPath = "",
    [string]$DataPath = "",
    [switch]$SkipNapCat,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$worldStatusRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = Split-Path -Parent $worldStatusRoot
if (-not $EventGeneratorPath) {
    $EventGeneratorPath = Join-Path $workspaceRoot "eventgenerator"
}
if (-not $DataPath) {
    $DataPath = Join-Path $workspaceRoot "runtime-data"
}

if (-not (Test-Path -LiteralPath (Join-Path $EventGeneratorPath "run_server.py"))) {
    throw "event_generator was not found at $EventGeneratorPath"
}

$python = (Get-Command python -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null

foreach ($name in @(
    "DEEPSEEK_API_KEY",
    "WORLD_STATUS_DATA_DIR",
    "WORLD_STATUS_RUNTIME_API",
    "WORLDS_QQ_ONEBOT_TOKEN",
    "WORLDS_QQ_WS_URL"
)) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if ($value) {
        Set-Item -Path "Env:$name" -Value $value
    }
}

$env:WORLD_STATUS_DATA_DIR = $DataPath
$env:WORLD_STATUS_RUNTIME_API = "http://127.0.0.1:8080"

function Test-LocalPort([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-HiddenPython(
    [string]$Name,
    [string]$WorkingDirectory,
    [string[]]$Arguments
) {
    Start-Process -FilePath $python `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $DataPath "$Name.out.log") `
        -RedirectStandardError (Join-Path $DataPath "$Name.err.log") | Out-Null
}

if (-not $SkipNapCat) {
    $napCatStarter = Join-Path $workspaceRoot "NapCatQQ\Start-NapCatQQ.ps1"
    if (Test-Path -LiteralPath $napCatStarter) {
        & $napCatStarter
    }
}

if (-not (Test-LocalPort 8080)) {
    Start-HiddenPython "event-runtime" $EventGeneratorPath @(
        "-u", "run_server.py", "--host", "127.0.0.1", "--port", "8080", "--seed", "2026"
    )
}

if (-not (Test-LocalPort 8000)) {
    Start-HiddenPython "world-status-web" $worldStatusRoot @(
        "-u", "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"
    )
}

$adapterRunning = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match "src\.qq_adapter_cli"
}
if (-not $adapterRunning -and $env:WORLDS_QQ_ONEBOT_TOKEN) {
    Start-HiddenPython "qq-adapter" $EventGeneratorPath @("-u", "-m", "src.qq_adapter_cli")
}
elseif (-not $env:WORLDS_QQ_ONEBOT_TOKEN) {
    Write-Warning "WORLDS_QQ_ONEBOT_TOKEN is not configured; the QQ adapter was not started."
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ((Test-LocalPort 8000) -and (Test-LocalPort 8080)) {
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:8000/"
}

Write-Host "World Status web: http://127.0.0.1:8000/"
Write-Host "Authoritative runtime: http://127.0.0.1:8080/"
Write-Host "Runtime data and logs: $DataPath"
