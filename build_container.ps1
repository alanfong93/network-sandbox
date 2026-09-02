$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed or not on PATH.'
}

docker info 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker is not running. Start Docker Desktop and run this script again.'
}

docker compose up --build -d
if ($LASTEXITCODE -ne 0) {
    throw 'docker compose up failed.'
}

Write-Host 'UI: http://localhost:5173'
