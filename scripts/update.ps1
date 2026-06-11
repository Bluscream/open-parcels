# ==============================================================================
# Open Parcels Update & Deploy Script
# ==============================================================================
# Automates: Git Push -> Docker Build -> Docker Push
# ==============================================================================

param (
    [string]$CommitMessage = "update",
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$Bump = "patch",
    [switch]$IgnoreWarnings,
    [switch]$IgnoreErrors,
    [switch]$SkipDocker
)

if ($IgnoreErrors) {
    $ErrorActionPreference = "Continue"
} else {
    $ErrorActionPreference = "Stop"
}

# Ensure we are in the project root
if (-not (Test-Path "package.json")) {
    Write-Host "Error: package.json not found. Please run this script from the project root." -ForegroundColor Red
    exit 1
}

# Helper to run npm scripts with validation
function Invoke-ProjectStep {
    param (
        [string]$Name,
        [string]$Command
    )
    Write-Host "$Name ($Command)..." -ForegroundColor Cyan
    
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    npm run $Command 2>&1 | Out-Host
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($exitCode -ne 0) {
        if ($IgnoreErrors) {
            Write-Host "$Name failed (Exit Code: $exitCode) but IgnoreErrors is set. Continuing..." -ForegroundColor Yellow
        } else {
            Write-Host "$Name failed (Exit Code: $exitCode)" -ForegroundColor Red
            exit $exitCode
        }
    } else {
        Write-Host "$Name passed" -ForegroundColor Green
    }
}

# 1. Quality Assurance (Build)
Write-Host "Running QA checks..." -ForegroundColor Cyan
Invoke-ProjectStep -Name "Compiler" -Command "build"

# 2. Version Bumping
Write-Host "Reading version from package.json..." -ForegroundColor Cyan
$packageJson = Get-Content package.json -Raw | ConvertFrom-Json
$version = $packageJson.version

if ($Bump -ne "none") {
    Write-Host "Bumping $Bump version..." -ForegroundColor Cyan
    $versionParts = $version.Split('.')
    switch ($Bump) {
        "major" { $versionParts[0] = [int]$versionParts[0] + 1; $versionParts[1] = 0; $versionParts[2] = 0 }
        "minor" { $versionParts[1] = [int]$versionParts[1] + 1; $versionParts[2] = 0 }
        "patch" { $versionParts[2] = [int]$versionParts[2] + 1 }
    }
    $version = $versionParts -join '.'
    $packageJson.version = $version
    $packageJson | ConvertTo-Json -Depth 10 | Set-Content package.json
    Write-Host "Bumped to $version" -ForegroundColor Green
} else {
    Write-Host "Version: $version (no bump)" -ForegroundColor Green
}

# 3. Git Operations
Write-Host "Committing changes to Git..." -ForegroundColor Cyan
git add .
git commit -m $CommitMessage
# Check remote name (could be remote or origin)
$remote = "remote"
$remotes = git remote
if ($remotes -contains "origin") {
    $remote = "origin"
}
git push $remote master
Write-Host "Git push complete." -ForegroundColor Green

if (-not $SkipDocker) {
    # 4. Docker Build
    Write-Host "Building Docker images..." -ForegroundColor Cyan
    $tags = @(
        "ghcr.io/bluscream/open-parcels:latest",
        "ghcr.io/bluscream/open-parcels:$version",
        "bluscream1/open-parcels:latest",
        "bluscream1/open-parcels:$version"
    )

    # Check for buildx
    $hasBuildx = $false
    try {
        $check = docker buildx version 2>&1
        if ($check -match "version") { $hasBuildx = $true }
    } catch {
        $hasBuildx = $false
    }

    if ($hasBuildx) {
        Write-Host "Using Docker Buildx for multi-arch support (linux/amd64, linux/arm64)..." -ForegroundColor Magenta
        $tagFlags = ""
        foreach ($tag in $tags) { $tagFlags += "-t $tag " }
        
        # Try to use existing builder or create one
        docker buildx create --use --name parcels-builder 2>$null
        
        docker buildx build --platform linux/amd64,linux/arm64 $tagFlags --file docker/Dockerfile --push .
        Write-Host "Docker buildx build and push complete." -ForegroundColor Green
    } else {
        Write-Host "Docker Buildx not found. Falling back to legacy build (single architecture)..." -ForegroundColor Yellow
        $buildCmd = "docker build -f docker/Dockerfile "
        foreach ($tag in $tags) { $buildCmd += "-t $tag " }
        $buildCmd += "."
        Invoke-Expression $buildCmd
        
        # 5. Docker Push (Legacy)
        Write-Host "Pushing images to registries..." -ForegroundColor Cyan
        foreach ($tag in $tags) {
            Write-Host "Pushing $tag..." -ForegroundColor Gray
            docker push $tag
        }
        Write-Host "Docker push complete." -ForegroundColor Green
    }
} else {
    Write-Host "Skipping Docker build and push." -ForegroundColor Yellow
}

Write-Host "All tasks completed successfully!" -ForegroundColor Green
