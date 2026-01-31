# upload-to-github.ps1 - PowerShell GitHub Upload Script
# Run with: powershell -ExecutionPolicy Bypass -File upload-to-github.ps1

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  WhatsApp Bot - GitHub Upload Tool" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if .gitignore exists
if (-not (Test-Path .gitignore)) {
    Write-Host "[ERROR] .gitignore file not found!" -ForegroundColor Red
    Write-Host "Please create .gitignore file first" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Check if .env.example exists
if (-not (Test-Path .env.example)) {
    Write-Host "[WARNING] .env.example not found" -ForegroundColor Yellow
    Write-Host "Consider creating it for documentation" -ForegroundColor Yellow
    Write-Host ""
}

# Check if .env is being tracked
$envIgnored = git check-ignore .env 2>$null
if (-not $envIgnored) {
    Write-Host "[CRITICAL ERROR] .env file is NOT ignored!" -ForegroundColor Red
    Write-Host "This means your credentials could be exposed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please add this line to .gitignore:" -ForegroundColor Yellow
    Write-Host ".env" -ForegroundColor White
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[OK] .env is properly ignored" -ForegroundColor Green
Write-Host ""

# Check Git installation
$gitVersion = git --version 2>$null
if (-not $gitVersion) {
    Write-Host "[ERROR] Git is not installed" -ForegroundColor Red
    Write-Host "Download from: https://git-scm.com/download/win" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[OK] Git is installed: $gitVersion" -ForegroundColor Green
Write-Host ""

# Check if Git is initialized
if (-not (Test-Path .git)) {
    Write-Host "Initializing Git repository..." -ForegroundColor Cyan
    git init
    Write-Host ""
}

# Show status
Write-Host "Current changes:" -ForegroundColor Cyan
Write-Host ""
git status -s
Write-Host ""

# Prompt for commit message
$commitMsg = Read-Host "Enter commit message (or press Enter for default)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) {
    $commitMsg = "Update: Automated commit on $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

Write-Host ""
Write-Host "Adding files to Git..." -ForegroundColor Cyan
git add .

Write-Host ""
Write-Host "Creating commit..." -ForegroundColor Cyan
git commit -m $commitMsg

Write-Host ""
Write-Host "Checking remote..." -ForegroundColor Cyan
$hasRemote = git remote -v | Select-String "origin"
if (-not $hasRemote) {
    Write-Host ""
    Write-Host "[SETUP] No remote repository configured" -ForegroundColor Yellow
    Write-Host ""
    $repoUrl = Read-Host "Enter GitHub repository URL"
    git remote add origin $repoUrl
    Write-Host "Remote added: $repoUrl" -ForegroundColor Green
    Write-Host ""
}

Write-Host ""
Write-Host "Pushing to GitHub..." -ForegroundColor Cyan

# Try normal push first
$pushResult = git push -u origin main 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[WARNING] Normal push failed. Trying alternative..." -ForegroundColor Yellow
    git branch -M main
    git push -u origin main --force
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Upload Complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    
    $repoUrl = git remote get-url origin
    Write-Host "Check your repository at:" -ForegroundColor Cyan
    Write-Host $repoUrl -ForegroundColor White
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  Upload Failed!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "1. Check your GitHub username and password" -ForegroundColor White
    Write-Host "2. Make sure the repository exists on GitHub" -ForegroundColor White
    Write-Host "3. Verify you have write access to the repository" -ForegroundColor White
    Write-Host ""
}

Read-Host "Press Enter to exit"