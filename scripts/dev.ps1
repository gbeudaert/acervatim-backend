#!/usr/bin/env pwsh
# Wrapper docker compose pour le dev local Acervatim.
# Usage : ./scripts/dev.ps1 <command> [args...]
# Les commandes "passe-plat" exécutent dans le conteneur "app" pour utiliser
# le bon réseau (hostname db) et les bons binaires (Linux, OpenSSL Prisma).

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($null -eq $Rest) { $Rest = @() }

function Show-Help {
    @"
Acervatim dev wrapper

Setup / lifecycle :
  build              Rebuild l'image app (après modif Dockerfile.dev ou package.json)
  up                 Démarre tous les services en foreground (logs)
  up-bg              Démarre en background (-d)
  down               Stoppe (garde le volume db)
  reset              Stoppe + supprime le volume db (RESET total de la base)

Inspection :
  ps                 Liste les services
  logs               Tail des logs de app
  shell              Shell sh dans le conteneur app
  db-shell           CLI MariaDB (user acervatim, demande le password)
  db-grant           Applique db/init/01-grants.sql sur la base existante (sans reset)

Git :
  setup-hooks        Configure core.hooksPath sur .husky (a faire une fois apres clone)

Prisma :
  migrate <nom>      Crée + applique une nouvelle migration
  migrate-deploy     Applique les migrations existantes (CI-style)
  generate           Régénère le client Prisma
  studio             Lance Prisma Studio dans le conteneur (port 5555)

Scripts :
  grant-premium <args...>  CLI premium grants (add/revoke/list)
                           ex: ./scripts/dev.ps1 grant-premium add <userId> --reason comp

Passe-plats (exécutés dans app) :
  npm <args...>      ex: ./scripts/dev.ps1 npm install zod
  npx <args...>      ex: ./scripts/dev.ps1 npx prisma db pull
  exec <cmd...>      Exécute une commande arbitraire

help                 Affiche cette aide
"@
}

# Pas de param() ni [CmdletBinding] : sinon PowerShell intercepte les common parameters
# (-Verbose alias -v, -Debug, etc.) avant qu'on puisse les transmettre. On utilise $args
# (variable automatique disponible dans toute fonction sans param déclaré) et on splat.
function Invoke-Compose {
    & docker compose @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Command) {
    'help'           { Show-Help }
    'build'          { Invoke-Compose build @Rest }
    'up'             { Invoke-Compose up @Rest }
    'up-bg'          { Invoke-Compose up -d @Rest }
    'down'           { Invoke-Compose down @Rest }
    'reset'          { Invoke-Compose down -v @Rest }
    'ps'             { Invoke-Compose ps @Rest }
    'logs'           { Invoke-Compose logs -f app @Rest }
    'shell'          { Invoke-Compose exec app sh }
    'db-shell'       { Invoke-Compose exec db mariadb -u acervatim -p acervatim }
    'setup-hooks' {
        & git rev-parse --is-inside-work-tree 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Error 'Not inside a git repository. Run `git init` first.'
            exit 1
        }
        & git config core.hooksPath .husky
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'core.hooksPath set to .husky. Pre-commit hook is active.' -ForegroundColor Green
    }
    'db-grant' {
        $envLines = Get-Content '.env' -ErrorAction Stop
        $rootLine = $envLines | Where-Object { $_ -match '^MARIADB_ROOT_PASSWORD=' } | Select-Object -First 1
        if (-not $rootLine) { Write-Error 'MARIADB_ROOT_PASSWORD not found in .env'; exit 1 }
        $rootPw = ($rootLine -replace '^MARIADB_ROOT_PASSWORD=', '').Trim('"')
        Get-Content 'db/init/01-grants.sql' -Raw | & docker compose exec -T db mariadb -u root "-p$rootPw"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'Grants applied.' -ForegroundColor Green
    }
    'migrate' {
        if ($Rest.Count -eq 0) {
            Write-Error 'Usage: ./scripts/dev.ps1 migrate <nom-migration>'
            exit 1
        }
        Invoke-Compose exec app npx prisma migrate dev --name $Rest[0]
    }
    'migrate-deploy' { Invoke-Compose exec app npx prisma migrate deploy }
    'generate'       { Invoke-Compose exec app npx prisma generate }
    'studio' {
        Write-Warning 'Studio écoute sur 5555 dans le conteneur. Ajouter "5555:5555" aux ports de app dans docker-compose.yml pour y accéder depuis Windows.'
        Invoke-Compose exec app npx prisma studio
    }
    'grant-premium'  { Invoke-Compose exec app npx ts-node --transpile-only scripts/grant-premium.ts @Rest }
    'npm'            { Invoke-Compose exec app npm @Rest }
    'npx'            { Invoke-Compose exec app npx @Rest }
    'exec'           { Invoke-Compose exec app @Rest }
    default {
        Write-Error "Commande inconnue : $Command"
        Show-Help
        exit 1
    }
}
