param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = "D:\WorldStatusNLP\venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Character-model Python was not found at $python"
}

# All model artifacts are already stored on D:. Keep startup independent of
# Hugging Face availability; DeepSeek API requests remain online.
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

Push-Location $projectRoot
try {
    & $python -m uvicorn app:app --host 127.0.0.1 --port $Port
}
finally {
    Pop-Location
}
