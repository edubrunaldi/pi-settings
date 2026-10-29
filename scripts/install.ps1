<#
.SYNOPSIS
  Installs this repo's Pi resources into the Pi agent directory.

.DESCRIPTION
  Copies (or links) extensions, skills, prompt templates and themes from this repo
  into ~/.pi/agent, keeping a timestamped backup of any file that is replaced.

  Use this when you want the git repo to be the source of truth on a machine.
  On a machine without the repo checked out, install the repo as a Pi package
  instead:
      pi-bolt install git:github.com/edubrunaldi/pi-settings
  Do not do both on the same machine: Pi would load the extension twice.

.EXAMPLE
  .\scripts\install.ps1
  .\scripts\install.ps1 -DryRun
  .\scripts\install.ps1 -Link          # symlink instead of copy (needs Developer Mode)
  .\scripts\install.ps1 -AgentDir D:\pi\agent
#>
[CmdletBinding()]
param(
    [string]$AgentDir = (Join-Path $HOME ".pi\agent"),
    [switch]$Link,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$installed = @()
$skipped = @()
$warnings = @()
$fatal = $false

function Write-Step($message) { Write-Host "== $message" -ForegroundColor Cyan }
function Write-Dry($message) { Write-Host "   [dry-run] $message" -ForegroundColor DarkYellow }

# Refuse to install when the same repo is also configured as a Pi package,
# because both copies would register the same commands and tools.
$settingsFile = Join-Path $AgentDir "settings.json"
if (Test-Path $settingsFile) {
    $settingsRaw = Get-Content $settingsFile -Raw
    if ($settingsRaw -match "pi-settings") {
        $script:warnings += "settings.json already references 'pi-settings' as a package. Using both the package and this script loads the extension twice. Remove the package entry (pi-bolt remove) or run the script on a different agent dir."
        $fatal = $true
    }
}

function Backup-File($path) {
    if (Test-Path $path) {
        $backup = "$path.bak-$stamp"
        if (-not $DryRun) { Copy-Item $path $backup -Force }
        Write-Host "   backup: $(Split-Path -Leaf $backup)" -ForegroundColor DarkGray
    }
}

function Install-File([string]$source, [string]$target) {
    $rel = $target.Substring($AgentDir.Length).TrimStart('\', '/')
    if (Test-Path $target) {
        $same = (Get-FileHash $source).Hash -eq (Get-FileHash $target).Hash
        if ($same) {
            $script:skipped += $rel
            Write-Host "   unchanged: $rel" -ForegroundColor DarkGray
            return
        }
    }
    if ($DryRun) { Write-Dry "copy $rel" } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Backup-File $target
        if ($Link) {
            if (Test-Path $target) { Remove-Item $target -Force }
            try {
                New-Item -ItemType SymbolicLink -Path $target -Target $source -Force | Out-Null
            } catch {
                throw "Symlink failed for $rel ($($_.Exception.Message)). Enable Windows Developer Mode or run without -Link."
            }
        } else {
            Copy-Item $source $target -Force
        }
    }
    $script:installed += $rel
}

function Install-Directory([string]$sourceDir, [string]$targetDir, [string]$filter = "*") {
    $rel = $targetDir.Substring($AgentDir.Length).TrimStart('\', '/')
    if ($DryRun) { Write-Dry "link dir $rel" } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetDir) | Out-Null
        if (Test-Path $targetDir) {
            $backup = "$targetDir.bak-$stamp"
            Move-Item $targetDir $backup -Force
            Write-Host "   backup: $(Split-Path -Leaf $backup)" -ForegroundColor DarkGray
        }
        if ($Link) {
            try {
                New-Item -ItemType SymbolicLink -Path $targetDir -Target $sourceDir -Force | Out-Null
            } catch {
                Copy-Item $sourceDir $targetDir -Recurse -Force
            }
        } else {
            Copy-Item $sourceDir $targetDir -Recurse -Force
        }
    }
    $script:installed += "$rel/"
}

Write-Step "repo:  $root"
Write-Step "agent: $AgentDir"
if ($Link) { Write-Host "   mode: symlink" -ForegroundColor DarkGray }
else { Write-Host "   mode: copy" -ForegroundColor DarkGray }

if (-not (Test-Path $AgentDir)) {
    if ($DryRun) { Write-Dry "create $AgentDir" } else { New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null }
}

# extensions: single files, or directories with an index.ts entry point
Write-Step "extensions"
$extDir = Join-Path $root "extensions"
if (Test-Path $extDir) {
    Get-ChildItem $extDir -File | Where-Object { $_.Extension -in ".ts", ".js", ".mjs", ".cjs" } | ForEach-Object {
        Install-File $_.FullName (Join-Path (Join-Path $AgentDir "extensions") $_.Name)
    }
    Get-ChildItem $extDir -Directory | Where-Object {
        (Test-Path (Join-Path $_.FullName "index.ts")) -or (Test-Path (Join-Path $_.FullName "index.js"))
    } | ForEach-Object {
        Install-Directory $_.FullName (Join-Path (Join-Path $AgentDir "extensions") $_.Name)
    }
}

# skills: one directory per skill, each containing SKILL.md
Write-Step "skills"
$skillDir = Join-Path $root "skills"
if (Test-Path $skillDir) {
    Get-ChildItem $skillDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") } | ForEach-Object {
        Install-Directory $_.FullName (Join-Path (Join-Path $AgentDir "skills") $_.Name)
    }
}

# prompt templates: direct *.md children of prompts/
Write-Step "prompts"
$promptDir = Join-Path $root "prompts"
if (Test-Path $promptDir) {
    Get-ChildItem $promptDir -File -Filter *.md | ForEach-Object {
        Install-File $_.FullName (Join-Path (Join-Path $AgentDir "prompts") $_.Name)
    }
}

# themes
Write-Step "themes"
$themeDir = Join-Path $root "themes"
if (Test-Path $themeDir) {
    Get-ChildItem $themeDir -File -Filter *.json | ForEach-Object {
        Install-File $_.FullName (Join-Path (Join-Path $AgentDir "themes") $_.Name)
    }
}

Write-Step "summary"
Write-Host ("   installed: {0}, unchanged: {1}" -f $installed.Count, $skipped.Count)
foreach ($item in $installed) { Write-Host "   + $item" -ForegroundColor Green }
foreach ($item in $warnings) { Write-Host "   ! $item" -ForegroundColor Yellow }

if (-not $DryRun) {
    Write-Host ""
    Write-Host "Restart Pi or run /reload in an open session." -ForegroundColor Cyan
}
if ($fatal) { exit 1 }
