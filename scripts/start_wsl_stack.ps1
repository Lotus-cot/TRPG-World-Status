param(
    [string]$Distro = "Ubuntu",
    [int]$ProxyPort = 8000,
    [int]$BackendPort = 8001,
    [switch]$SkipModelPreload
)

$ErrorActionPreference = "Stop"

function Convert-ToWslPath {
    param([Parameter(Mandatory = $true)][string]$WindowsPath)

    $resolved = (Resolve-Path -LiteralPath $WindowsPath).Path
    if ($resolved -notmatch "^([A-Za-z]):\\(.*)$") {
        throw "Only drive-letter Windows paths are supported: $resolved"
    }

    $drive = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2].Replace("\", "/")
    return "/mnt/$drive/$rest"
}

function Assert-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) {
        throw "Port $Port is already in use by process $($listener[0].OwningProcess)."
    }
}

$projectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$projectWsl = Convert-ToWslPath $projectDir
$wslStartScript = "$projectWsl/scripts/start_wsl_backend.sh"
$proxyScript = Join-Path $PSScriptRoot "local_wsl_proxy.py"
$python = (Get-Command python -ErrorAction Stop).Source

Assert-PortAvailable $ProxyPort
Assert-PortAvailable $BackendPort

$backendArgs = @("-d", $Distro, "--", "bash", $wslStartScript, "$BackendPort")
if ($SkipModelPreload) {
    $backendArgs += "--skip-preload"
}

Write-Host "Windows project: $projectDir"
Write-Host "WSL project:     $projectWsl"
Write-Host "Starting WSL backend on port $BackendPort..."

Start-Process `
    -FilePath "wsl.exe" `
    -ArgumentList $backendArgs `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $projectDir "wsl-backend.out.log") `
    -RedirectStandardError (Join-Path $projectDir "wsl-backend.err.log")

Start-Sleep -Seconds 3

$target = "http://127.0.0.1:$BackendPort"
$backendReady = $false

for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
        Invoke-RestMethod -Uri "$target/api/health" -TimeoutSec 2 | Out-Null
        $backendReady = $true
        break
    }
    catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $backendReady) {
    $wslAddresses = (& wsl.exe -d $Distro -- hostname -I) -join " "
    $wslIp = ($wslAddresses.Trim() -split "\s+")[0]
    if ($wslIp) {
        $target = "http://${wslIp}:$BackendPort"
        try {
            Invoke-RestMethod -Uri "$target/api/health" -TimeoutSec 5 | Out-Null
            $backendReady = $true
        }
        catch {
            $backendReady = $false
        }
    }
}

if (-not $backendReady) {
    throw "WSL backend did not become reachable. Check wsl-backend.err.log."
}

Write-Host "Starting Windows proxy: http://127.0.0.1:$ProxyPort -> $target"

Start-Process `
    -FilePath $python `
    -ArgumentList @($proxyScript, $target, "$ProxyPort") `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $projectDir "proxy.out.log") `
    -RedirectStandardError (Join-Path $projectDir "proxy.err.log")

Start-Sleep -Seconds 2
$healthUrl = "http://127.0.0.1:$ProxyPort/api/health"
$health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 15

Write-Host "World Status is ready: http://127.0.0.1:$ProxyPort/"
Write-Host "Health: $($health.status)"
